/**
 * Indexing Pipeline Service
 *
 * Extracts text from every supported file type, chunks the content
 * intelligently, generates summaries, and integrates with the
 * construction classifier.
 *
 * Supported types:
 *   PDF, DOCX/DOC, XLSX/XLS, CSV, TXT/MD, MSG/EML, Images (metadata stubs)
 *
 * Chunking strategy:
 *   - PDF: page-aware chunks (one chunk per page, or split long pages)
 *   - DOCX: heading-based + paragraph chunks
 *   - XLSX/CSV: sheet/table row-based chunks (max N rows per chunk)
 *   - TXT: sliding-window character chunks with overlap
 *   - Images: metadata stub chunk (no OCR body text in v1)
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { getEnv } from "../config/env";
import { logger } from "../lib/logger";
import {
  constructionClassifierService,
  type ClassificationResult,
} from "./construction-classifier.service";
import { docParserService, type DocParserShadowMetadata } from "./doc-parser.service";

// ============================================================
// Types
// ============================================================

export interface IndexedFileInsights {
  summary: string;
  keyTopics: string[];
  chunkCount: number;
  textLength: number;
  classification: ClassificationResult;
  chunks: Array<{
    chunkIndex: number;
    chunkText: string;
    tokenCount: number;
    sourceType: "content" | "summary" | "metadata_stub";
    pageNumber?: number;
    sectionLabel?: string;
    metadata?: Record<string, unknown>;
    confidence?: number;
  }>;
  links: Array<{
    sourceChunkIndex: number;
    targetChunkIndex: number;
    relation: string;
    weight: number;
  }>;
}

interface ExtractTextInput {
  tempFilePath: string;
  fileName?: string;
  filePath?: string;
  mimeType?: string;
  projectId?: string;
  rollout?: {
    extractorV2Enabled?: boolean;
  };
}

interface RawChunk {
  chunkText: string;
  sourceType: "content" | "summary" | "metadata_stub";
  pageNumber?: number;
  sectionLabel?: string;
  metadata?: Record<string, unknown>;
  confidence?: number;
}

interface ParserProvenance {
  parserName: string;
  parserMode: "legacy" | "shadow" | "active";
  parserVersion?: string;
}

interface ParsedExtraction {
  text: string;
  blocks: RawChunk[];
  provenance: ParserProvenance;
}

interface BuildInsightsInput {
  text: string;
  rawChunks: RawChunk[];
  fileName: string;
  filePath?: string;
  shadowMetadata?: DocParserShadowMetadata;
}

interface ExtractionContext {
  mime: string;
  ext: string;
}

interface ExtractionAdapter {
  name: string;
  canHandle(input: ExtractTextInput, context: ExtractionContext): boolean;
  parse(input: ExtractTextInput, context: ExtractionContext): Promise<ParsedExtraction>;
}

// ============================================================
// Constants
// ============================================================

const CHAR_CHUNK_SIZE    = 1400;  // chars per sliding window chunk
const CHAR_CHUNK_OVERLAP = 200;
const MAX_ROWS_PER_CHUNK = 80;    // table rows per spreadsheet chunk
const MAX_TEXT_LENGTH    = 8_000_000; // large-document safety cap
const MAX_CHUNKS_PER_FILE = 400;
const MAX_CHUNKS_PER_PDF = 5000;
const MAX_SECTION_HEADERS = 5000;

const STOP_WORDS = new Set([
  "the","and","for","with","this","that","from","are","was","were",
  "have","has","into","your","you","our","their","not","but","all",
  "can","will","its","per","may","also","any","been","such","each",
]);

// ============================================================
// Text Normalization
// ============================================================

function normalizeText(input: string): string {
  return input
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, MAX_TEXT_LENGTH);
}

// ============================================================
// Chunking Strategies
// ============================================================

function slidingWindowChunks(text: string): string[] {
  if (!text) return [];
  if (text.length <= CHAR_CHUNK_SIZE) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(text.length, start + CHAR_CHUNK_SIZE);
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start = Math.max(0, end - CHAR_CHUNK_OVERLAP);
  }
  return chunks;
}

function headingChunks(text: string): string[] {
  // Split on markdown-style headings or double newlines before ALL-CAPS lines
  const sections = text.split(/(?=\n#{1,4}\s|\n[A-Z][A-Z\s]{5,}\n)/);
  const result: string[] = [];
  for (const section of sections) {
    if (!section.trim()) continue;
    if (section.length <= CHAR_CHUNK_SIZE) {
      result.push(section.trim());
    } else {
      result.push(...slidingWindowChunks(section));
    }
  }
  return result.length > 0 ? result : slidingWindowChunks(text);
}

function tableRowChunks(rows: string[][]): string[] {
  if (rows.length === 0) return [];
  const header = rows[0]?.join("\t") ?? "";
  const dataRows = rows.slice(1);
  const chunks: string[] = [];
  for (let i = 0; i < dataRows.length; i += MAX_ROWS_PER_CHUNK) {
    const batch = dataRows.slice(i, i + MAX_ROWS_PER_CHUNK);
    chunks.push([header, ...batch.map((r) => r.join("\t"))].join("\n"));
  }
  return chunks.length > 0 ? chunks : [header];
}

function resolveChunkCap(fileName?: string): number {
  const lowerName = (fileName ?? "").toLowerCase();
  return lowerName.endsWith(".pdf") ? MAX_CHUNKS_PER_PDF : MAX_CHUNKS_PER_FILE;
}

function capChunks(chunks: RawChunk[], fileName?: string): RawChunk[] {
  const maxChunks = resolveChunkCap(fileName);

  if (chunks.length <= maxChunks) {
    return chunks;
  }

  logger.warn("indexing-pipeline.chunk-cap.bypassed", {
    fileName: fileName ?? "unknown",
    originalChunkCount: chunks.length,
    maxChunks,
    reason: "preserve_full_file_index_coverage",
  });

  return chunks;
}

function buildPdfRawChunks(pageTexts: string[], text: string): RawChunk[] {
  if (pageTexts.length > 1) {
    const chunks: RawChunk[] = [];
    for (let pageIndex = 0; pageIndex < pageTexts.length; pageIndex++) {
      const page = pageTexts[pageIndex];
      if (page.length === 0) {
        // Skip empty pages - they don't contribute chunks
        continue;
      }
      // Split into sub-chunks if page exceeds char limit
      const subChunks = page.length > CHAR_CHUNK_SIZE ? slidingWindowChunks(page) : [page];
      for (const chunkText of subChunks) {
        chunks.push({
          chunkText,
          sourceType: "content" as const,
          pageNumber: pageIndex + 1,  // Actual PDF page (index 0 = page 1, etc.)
          confidence: 1,
        });
      }
    }
    return chunks;
  }

  return slidingWindowChunks(text).map((chunkText) => ({
    chunkText,
    sourceType: "content" as const,
    pageNumber: pageTexts.length === 1 ? 1 : undefined,
    confidence: pageTexts.length === 1 ? 0.6 : 0.3,
  }));
}

// ============================================================
// Extractors
// ============================================================

async function extractPdfText(tempFilePath: string): Promise<{ text: string; pageTexts: string[] }> {
  const buffer = await readFile(tempFilePath);
  
  try {
    const pdfParseModule = await import("pdf-parse");
    const pageTexts: string[] = [];

    // pdf-parse v2+: class-based API
    const PDFParseCtor = (pdfParseModule as { PDFParse?: new (options: { data: Uint8Array }) => {
      getText: () => Promise<{ pages?: Array<{ text?: string }>; text?: string }>;
      destroy?: () => Promise<void>;
    } }).PDFParse;

    if (PDFParseCtor) {
      const parser = new PDFParseCtor({ data: new Uint8Array(buffer) });
      try {
        const result = await parser.getText();
        const pages = Array.isArray(result.pages) ? result.pages : [];

        // Preserve all pages (including empty) so array indices match actual PDF page numbers
        for (const page of pages) {
          const pageText = (page.text ?? "").trim();
          pageTexts.push(pageText); // Don't filter out empty pages
        }

        // Filter empty pages only for joined text, not the page array
        const nonEmptyPageTexts = pageTexts.filter((text) => text.length > 0);
        if (nonEmptyPageTexts.length > 0) {
          return { text: nonEmptyPageTexts.join("\n\n"), pageTexts };
        }

        const mergedText = (result.text ?? "").trim();
        if (mergedText.length > 0) {
          return { text: mergedText, pageTexts: [mergedText] };
        }
      } finally {
        await parser.destroy?.();
      }
    }

    // pdf-parse v1: callable default export API
    const pdfParseLegacy = (pdfParseModule as { default?: unknown }).default;
    if (typeof pdfParseLegacy === "function") {
      const fallback = await (pdfParseLegacy as (dataBuffer: Buffer) => Promise<{ text?: string }>)(buffer);
      const text = (fallback.text ?? "").trim();
      if (text.length > 0) {
        return { text, pageTexts: [text] };
      }
    }

    return { text: "", pageTexts: [] };
  } catch (err) {
    logger.warn("indexing-pipeline.pdf-extract.failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    // Return empty result so caller falls back to plain text reading
    return { text: "", pageTexts: [] };
  }
}

async function extractDocxText(tempFilePath: string): Promise<string> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ path: tempFilePath });
  return result.value ?? "";
}

async function extractXlsxText(tempFilePath: string): Promise<{ sheets: Array<{ name: string; rows: string[][] }> }> {
  try {
    const XLSX = await import("xlsx");
    const workbook = XLSX.readFile(tempFilePath);
    const sheets = workbook.SheetNames.map((name) => {
      const ws = workbook.Sheets[name];
      const rows = (XLSX.utils.sheet_to_json(ws, { header: 1, raw: false }) as unknown[][]).map(
        (row) => (row as unknown[]).map((cell) => String(cell ?? ""))
      );
      return { name, rows };
    });
    return { sheets };
  } catch {
    return { sheets: [] };
  }
}

async function extractCsvText(tempFilePath: string): Promise<string[][]> {
  try {
    const Papa = await import("papaparse");
    const content = await readFile(tempFilePath, "utf8");
    const result = Papa.parse<string[]>(content, { header: false, skipEmptyLines: true });
    return result.data;
  } catch {
    // Fallback: naive split
    const content = await readFile(tempFilePath, "utf8");
    return content.split("\n").map((line) => line.split(","));
  }
}

// ============================================================
// Key Topic Extraction
// ============================================================

function extractKeyTopics(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !STOP_WORDS.has(t));

  const freq = new Map<string, number>();
  for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);

  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([token]) => token);
}

function extractSectionHeaders(text: string): string[] {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const seen = new Set<string>();
  const headers: string[] = [];

  for (const line of lines) {
    if (headers.length >= MAX_SECTION_HEADERS) break;

    const isMarkdownHeader = /^#{1,4}\s+.{3,}/.test(line);
    // Spec section numbers like "3.52." or "3.52 TITLE" or "3.52.1 Title"
    const isSpecSection = /^\d+(?:\.\d+){1,4}\.?\s+[A-Z][A-Za-z0-9&/(),'\- ]{2,80}/.test(line);
    const isNumberedHeader = /^\d+(?:\.\d+){0,3}\s+[A-Z].{2,}/.test(line);
    const isAllCapsHeader =
      line.length >= 6 &&
      line.length <= 120 &&
      /^[A-Z0-9][A-Z0-9\s\-_:()/.]+$/.test(line);

    if (isMarkdownHeader || isSpecSection || isNumberedHeader || isAllCapsHeader) {
      const normalized = line.replace(/^#{1,4}\s+/, "");
      if (!seen.has(normalized.toLowerCase())) {
        seen.add(normalized.toLowerCase());
        headers.push(normalized);
      }
    }
  }

  return headers;
}

function inferSectionLabel(chunkText: string, sectionHeaders: string[]): string | undefined {
  const candidateText = chunkText.slice(0, 600);
  const candidateLines = candidateText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (candidateLines.length === 0) return undefined;

  // 1. Direct match against known section headers (longest match wins)
  const direct = sectionHeaders
    .filter((header) =>
      candidateLines.some((line) => line.toLowerCase().includes(header.toLowerCase()))
    )
    .sort((a, b) => b.length - a.length)[0];
  if (direct) return direct;

  // 2. Regex: spec-style numbered sections (e.g. "3.52. EXPANSION JOINT ASSEMBLIES")
  //    Prefer the FIRST match in candidateText (outermost heading)
  const specMatch = candidateText.match(
    /\b\d+(?:\.\d+){1,4}\.?\s+[A-Z][A-Za-z0-9&/(),'\- ]{2,80}/
  );
  if (specMatch) return specMatch[0].trim();

  // 3. Fallback: first line if it looks like a heading
  const firstLine = candidateLines[0]!;
  if (/^\d+(?:\.\d+){0,3}\s+.{3,}/.test(firstLine)) {
    return firstLine;
  }

  return undefined;
}

function assignSectionLabels(
  chunks: RawChunk[],
  sectionHeaders: string[]
): Array<RawChunk & { sectionLabel?: string }> {
  let lastSeenSectionLabel: string | undefined;

  return chunks.map((chunk) => {
    const normalizedChunkText = normalizeText(chunk.chunkText);
    const inferredSectionLabel =
      chunk.sectionLabel ?? inferSectionLabel(normalizedChunkText, sectionHeaders);
    const sectionLabel = inferredSectionLabel ?? lastSeenSectionLabel;

    if (sectionLabel) {
      lastSeenSectionLabel = sectionLabel;
    }

    return {
      ...chunk,
      sectionLabel,
    };
  });
}

// ============================================================
// LLM Summary
// ============================================================

function buildSummaryPromptSample(text: string): string {
  const normalized = normalizeText(text);
  if (!normalized) {
    return "";
  }

  const maxSlice = 2200;
  if (normalized.length <= maxSlice * 2) {
    return normalized.slice(0, maxSlice * 2);
  }

  const start = normalized.slice(0, maxSlice);
  const middleStart = Math.max(0, Math.floor(normalized.length / 2) - Math.floor(maxSlice / 2));
  const middle = normalized.slice(middleStart, middleStart + maxSlice);
  const end = normalized.slice(Math.max(0, normalized.length - maxSlice));

  return [
    "--- START EXCERPT ---",
    start,
    "--- MIDDLE EXCERPT ---",
    middle,
    "--- END EXCERPT ---",
    end,
  ].join("\n\n");
}

function buildSummaryChunk(summary: string, keyTopics: string[], category?: string): string {
  const topicLine = keyTopics.length > 0 ? keyTopics.slice(0, 12).join(", ") : "none";
  const categoryLine = category && category.trim() ? category : "unknown";

  return [
    "DOCUMENT SUMMARY",
    `Category: ${categoryLine}`,
    `Key topics: ${topicLine}`,
    "",
    summary.trim(),
  ].join("\n");
}

async function generateLlmSummary(fileName: string, fullText: string): Promise<string> {
  const env = getEnv();
  const textSample = buildSummaryPromptSample(fullText);
  if (!env.openAiApiKey || !env.openAiChatEndpoint) {
    return `Preview: ${textSample.slice(0, 260)}`;
  }

  try {
    const response = await fetch(env.openAiChatEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.openAiApiKey}`,
      },
      body: JSON.stringify({
        model: env.openAiChatModel ?? "gpt-4.1-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a construction document analyst. Produce a concise but information-dense summary (5-8 bullet points, <=220 words). Include: document purpose, location/area references, key quantities and dimensions, dates/revisions, inspection/approval status, blockers/risks, and next actions if present. Do not invent data.",
          },
          {
            role: "user",
            content: `File: ${fileName}\n\nContent excerpt:\n${textSample.slice(0, 2000)}`,
          },
        ],
        temperature: 0.2,
        max_tokens: 250,
      }),
    });

    if (!response.ok) throw new Error(`OpenAI error: ${response.status}`);
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return payload.choices?.[0]?.message?.content?.trim() ?? `Preview: ${textSample.slice(0, 260)}`;
  } catch (err) {
    logger.warn("indexing-pipeline.summary.llm-failed", { error: err instanceof Error ? err.message : String(err) });
    return `Preview: ${textSample.slice(0, 260)}`;
  }
}

// ============================================================
// Main Routing
// ============================================================

const defaultExtractionAdapter: ExtractionAdapter = {
  name: "legacy-default",
  canHandle: () => true,
  async parse(input, context): Promise<ParsedExtraction> {
    const mime = context.mime;
    const ext = context.ext;

    // ---------------- PDF ----------------
    if (mime.includes("pdf") || ext === "pdf") {
      try {
        const { pageTexts, text } = await extractPdfText(input.tempFilePath);
        const blocks = buildPdfRawChunks(pageTexts, text);
        return {
          text: normalizeText(text),
          blocks,
          provenance: {
            parserName: "legacy-default",
            parserMode: "active",
          },
        };
      } catch {
        const text = await readFile(input.tempFilePath, "utf8");
        return {
          text: normalizeText(text),
          blocks: slidingWindowChunks(text).map((chunkText) => ({
            chunkText,
            sourceType: "content",
            confidence: 0.2,
          })),
          provenance: {
            parserName: "legacy-default",
            parserMode: "active",
          },
        };
      }
    }

    // ---------------- DOCX ----------------
    if (mime.includes("wordprocessingml") || ["docx", "doc"].includes(ext)) {
      try {
        const text = await extractDocxText(input.tempFilePath);
        const normalized = normalizeText(text);
        return {
          text: normalized,
          blocks: headingChunks(normalized).map((chunkText) => ({
            chunkText,
            sourceType: "content",
            confidence: 0.9,
          })),
          provenance: {
            parserName: "legacy-default",
            parserMode: "active",
          },
        };
      } catch {
        const text = await readFile(input.tempFilePath, "utf8");
        return {
          text: normalizeText(text),
          blocks: slidingWindowChunks(text).map((chunkText) => ({
            chunkText,
            sourceType: "content",
            confidence: 0.4,
          })),
          provenance: {
            parserName: "legacy-default",
            parserMode: "active",
          },
        };
      }
    }

    // ---------------- XLSX / XLS ----------------
    if (mime.includes("spreadsheetml") || ["xlsx", "xls"].includes(ext)) {
      const { sheets } = await extractXlsxText(input.tempFilePath);
      if (sheets.length === 0) {
        return {
          text: "",
          blocks: [],
          provenance: {
            parserName: "legacy-default",
            parserMode: "active",
          },
        };
      }

      const allText = sheets.map((s) => s.rows.map((r) => r.join("\t")).join("\n")).join("\n\n");
      const blocks = sheets.flatMap((sheet) =>
        tableRowChunks(sheet.rows).map((chunkText) => ({
          chunkText,
          sourceType: "content" as const,
          metadata: {
            sheetName: sheet.name,
          },
          confidence: 1,
        }))
      );
      return {
        text: normalizeText(allText),
        blocks,
        provenance: {
          parserName: "legacy-default",
          parserMode: "active",
        },
      };
    }

    // ---------------- CSV ----------------
    if (mime.includes("csv") || ext === "csv") {
      const rows = await extractCsvText(input.tempFilePath);
      const text = rows.map((r) => r.join(",")).join("\n");
      return {
        text: normalizeText(text),
        blocks: tableRowChunks(rows).map((chunkText) => ({
          chunkText,
          sourceType: "content",
          confidence: 1,
        })),
        provenance: {
          parserName: "legacy-default",
          parserMode: "active",
        },
      };
    }

    // ---------------- Images (metadata stubs for v1) ----------------
    if (mime.startsWith("image/") || ["jpg", "jpeg", "png", "gif", "tiff", "bmp", "heic", "webp"].includes(ext)) {
      const drawingTitle = input.fileName?.replace(path.extname(input.fileName), "") ?? "Drawing";
      const stubText = `Drawing reference: ${drawingTitle}`;
      return {
        text: "",
        blocks: [{
          chunkText: stubText,
          sourceType: "metadata_stub",
          metadata: { drawingTitle },
          confidence: 0.7,
        }],
        provenance: {
          parserName: "legacy-default",
          parserMode: "active",
        },
      };
    }

    // ---------------- Email (EML/MSG) — treat as plain text ----------------
    if (mime.includes("rfc822") || mime.includes("ms-outlook") || ["eml", "msg"].includes(ext)) {
      const text = await readFile(input.tempFilePath, "utf8").catch(() => "");
      const normalized = normalizeText(text);
      return {
        text: normalized,
        blocks: slidingWindowChunks(normalized).map((chunkText) => ({
          chunkText,
          sourceType: "content",
          confidence: 0.9,
        })),
        provenance: {
          parserName: "legacy-default",
          parserMode: "active",
        },
      };
    }

    // ---------------- Plain text / fallback ----------------
    const text = await readFile(input.tempFilePath, "utf8").catch(() => "");
    const normalized = normalizeText(text);
    return {
      text: normalized,
      blocks: slidingWindowChunks(normalized).map((chunkText) => ({
        chunkText,
        sourceType: "content",
        confidence: 0.8,
      })),
      provenance: {
        parserName: "legacy-default",
        parserMode: "active",
      },
    };
  },
};

const EXTRACTION_ADAPTERS: ExtractionAdapter[] = [defaultExtractionAdapter];

function resolveExtractionAdapter(input: ExtractTextInput, context: ExtractionContext): ExtractionAdapter {
  return EXTRACTION_ADAPTERS.find((adapter) => adapter.canHandle(input, context)) ?? defaultExtractionAdapter;
}

async function extractAndChunk(input: ExtractTextInput): Promise<{
  text: string;
  rawChunks: RawChunk[];
  shadowMetadata?: DocParserShadowMetadata;
}> {
  const context: ExtractionContext = {
    mime: input.mimeType?.toLowerCase() ?? "",
    ext: path.extname(input.tempFilePath).toLowerCase().replace(".", ""),
  };

  const adapter = resolveExtractionAdapter(input, context);
  const parsed = await adapter.parse(input, context);
  const env = getEnv();
  const extractorV2Enabled = input.rollout?.extractorV2Enabled ?? env.indexingExtractorPipelineV2Enabled;

  const shadowMetadata = extractorV2Enabled
    ? await docParserService.parseShadow({
        tempFilePath: input.tempFilePath,
        fileName: input.fileName,
        mimeType: input.mimeType,
        enabledOverride: extractorV2Enabled,
      })
    : undefined;

  return {
    text: parsed.text,
    rawChunks: parsed.blocks.map((block) => ({
      ...block,
      metadata: {
        ...(block.metadata ?? {}),
        extractionParser: {
          ...parsed.provenance,
        },
        ...(shadowMetadata
          ? {
              extractionParserV2Shadow: {
                ...shadowMetadata,
              },
            }
          : {}),
      },
    })),
    shadowMetadata,
  };
}

export const indexingPipelineInternals = {
  assignSectionLabels,
  buildPdfRawChunks,
  capChunks,
  resolveExtractionAdapter,
};

// ============================================================
// Public API
// ============================================================

export { ExtractTextInput };

export const indexingPipelineService = {
  async indexNormalizedText(input: {
    text: string;
    fileName: string;
    filePath?: string;
  }): Promise<IndexedFileInsights> {
    const normalizedText = normalizeText(input.text);
    const rawChunks = headingChunks(normalizedText).map((chunkText) => ({
      chunkText,
      sourceType: "content" as const,
      confidence: 1,
    }));

    return buildInsights({
      text: normalizedText,
      rawChunks,
      fileName: input.fileName,
      filePath: input.filePath,
    });
  },

  async indexTempFile(input: ExtractTextInput): Promise<IndexedFileInsights> {
    const { text, rawChunks, shadowMetadata } = await extractAndChunk(input);
    const fileName = input.fileName ?? path.basename(input.tempFilePath);
    const filePath = input.filePath ?? "";

    return buildInsights({
      text,
      rawChunks,
      fileName,
      filePath,
      shadowMetadata,
    });
  },
};

async function buildInsights(input: BuildInsightsInput): Promise<IndexedFileInsights> {
  const { text, rawChunks, fileName, filePath, shadowMetadata } = input;
  const boundedChunks = capChunks(rawChunks, fileName);
  const sectionHeaders = extractSectionHeaders(text);
  const labeledChunks = assignSectionLabels(boundedChunks, sectionHeaders);

  const normalizedChunks = labeledChunks
    .map((chunk, chunkIndex) => {
      const normalizedChunk = normalizeText(chunk.chunkText);
      return {
        chunkIndex,
        chunkText: normalizedChunk,
        tokenCount: normalizedChunk.split(/\s+/).filter(Boolean).length,
        sourceType: chunk.sourceType,
        pageNumber: chunk.pageNumber,
        sectionLabel: chunk.sectionLabel,
        metadata: chunk.metadata,
        confidence: chunk.confidence,
      };
    })
    .filter((c) => c.chunkText.length > 0);

  const keyTopics = Array.from(
    new Set([
      ...sectionHeaders.slice(0, 8),
      ...extractKeyTopics(text),
    ])
  ).slice(0, 16);

  // Run classification and summary in parallel
  const [classification, summary] = await Promise.all([
    constructionClassifierService.classify(fileName, filePath ?? "", text),
    generateLlmSummary(fileName, text),
  ]);

  // Build a section index chunk: maps every unique section heading → pages.
  // This lets the retrieval engine find the right section by heading keywords
  // even when those keywords appear incidentally across many other chunks.
  const sectionPageMap = new Map<string, Set<number>>();
  for (const chunk of normalizedChunks) {
    if (chunk.sectionLabel && chunk.pageNumber != null) {
      const pages = sectionPageMap.get(chunk.sectionLabel) ?? new Set<number>();
      pages.add(chunk.pageNumber);
      sectionPageMap.set(chunk.sectionLabel, pages);
    }
  }
  const sectionIndexLines: string[] = ["DOCUMENT SECTION INDEX (heading → page numbers):"];
  for (const [heading, pages] of sectionPageMap) {
    const sortedPages = Array.from(pages).sort((a, b) => a - b);
    const pageDisplay = sortedPages.length === 1
      ? `p.${sortedPages[0]}`
      : `pp.${sortedPages[0]}-${sortedPages[sortedPages.length - 1]}`;
    sectionIndexLines.push(`${heading} [${pageDisplay}]`);
  }
  const sectionIndexChunkText = normalizeText(sectionIndexLines.join("\n"));

  // Add a synthetic summary chunk so chat can quickly retrieve document-level intent.
  const summaryChunkText = normalizeText(
    buildSummaryChunk(summary, keyTopics, classification.category)
  );

  const chunks = [
    {
      chunkIndex: 0,
      chunkText: summaryChunkText,
      tokenCount: summaryChunkText.split(/\s+/).filter(Boolean).length,
      sourceType: "summary" as const,
      metadata: {
        keyTopics: keyTopics.slice(0, 12),
        category: classification.category,
        ...(shadowMetadata
          ? {
              extractionParserV2Shadow: {
                ...shadowMetadata,
              },
            }
          : {}),
      },
      confidence: 1,
    },
    ...(sectionIndexChunkText.length > 40
      ? [{
          chunkIndex: 1,
          chunkText: sectionIndexChunkText,
          tokenCount: sectionIndexChunkText.split(/\s+/).filter(Boolean).length,
          sourceType: "summary" as const,
          metadata: { type: "section_index" },
          confidence: 1,
        }]
      : []),
    ...normalizedChunks.map((chunk, idx) => ({
      ...chunk,
      chunkIndex: idx + (sectionIndexChunkText.length > 40 ? 2 : 1),
    })),
  ].filter((c) => c.chunkText.length > 0);

  // Sequential chunk links (prev→next)
  const links = chunks
    .filter((c) => c.chunkIndex < chunks.length - 1)
    .map((c) => ({
      sourceChunkIndex: c.chunkIndex,
      targetChunkIndex: c.chunkIndex + 1,
      relation: "next",
      weight: 100,
    }));

  return {
    summary,
    keyTopics,
    chunkCount: chunks.length,
    textLength: text.length,
    classification,
    chunks,
    links,
  };
}

