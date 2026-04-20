import { readFile } from "node:fs/promises";

interface ExtractTextInput {
  tempFilePath: string;
  mimeType?: string;
}

export interface IndexedFileInsights {
  summary: string;
  keyTopics: string[];
  chunkCount: number;
  textLength: number;
  chunks: Array<{
    chunkIndex: number;
    chunkText: string;
    tokenCount: number;
  }>;
  links: Array<{
    sourceChunkIndex: number;
    targetChunkIndex: number;
    relation: string;
    weight: number;
  }>;
}

const DEFAULT_CHUNK_SIZE = 1200;
const DEFAULT_CHUNK_OVERLAP = 180;
const STOP_WORDS = new Set<string>([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "are",
  "was",
  "were",
  "have",
  "has",
  "into",
  "your",
  "you",
  "our",
  "their",
  "not",
  "but",
  "all",
  "can",
  "will",
  "its",
  "per",
  "may",
  "also",
  "any",
]);

function normalizeText(input: string): string {
  return input.replace(/\s+/g, " ").replace(/\u0000/g, "").trim();
}

function chunkText(text: string, chunkSize = DEFAULT_CHUNK_SIZE, overlap = DEFAULT_CHUNK_OVERLAP): string[] {
  if (!text) {
    return [];
  }

  if (text.length <= chunkSize) {
    return [text];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(text.length, start + chunkSize);
    chunks.push(text.slice(start, end));

    if (end >= text.length) {
      break;
    }

    start = Math.max(0, end - overlap);
  }

  return chunks;
}

function extractKeyTopics(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4 && !STOP_WORDS.has(token));

  const frequencies = new Map<string, number>();
  for (const token of tokens) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }

  return Array.from(frequencies.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([token]) => token);
}

async function extractPdfText(tempFilePath: string): Promise<string> {
  const buffer = await readFile(tempFilePath);
  const pdfParseModule = await import("pdf-parse");
  const pdfParse = (pdfParseModule.default ?? pdfParseModule) as (
    data: Buffer
  ) => Promise<{ text?: string }>;
  const result = await pdfParse(buffer);
  return result.text ?? "";
}

async function extractDocxText(tempFilePath: string): Promise<string> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ path: tempFilePath });
  return result.value ?? "";
}

async function extractText(input: ExtractTextInput): Promise<string> {
  const lowerMime = input.mimeType?.toLowerCase() ?? "";

  if (lowerMime.includes("pdf")) {
    try {
      return await extractPdfText(input.tempFilePath);
    } catch {
      const fallback = await readFile(input.tempFilePath, "utf8");
      return fallback;
    }
  }

  if (
    lowerMime.includes("officedocument.wordprocessingml.document") ||
    lowerMime.includes("docx")
  ) {
    try {
      return await extractDocxText(input.tempFilePath);
    } catch {
      const fallback = await readFile(input.tempFilePath, "utf8");
      return fallback;
    }
  }

  return await readFile(input.tempFilePath, "utf8");
}

export const indexingPipelineService = {
  async indexTempFile(input: ExtractTextInput): Promise<IndexedFileInsights> {
    const rawText = await extractText(input);
    const normalized = normalizeText(rawText);
    const chunks = chunkText(normalized);
    const normalizedChunks = chunks.map((chunk, chunkIndex) => ({
      chunkIndex,
      chunkText: chunk,
      tokenCount: chunk.split(/\s+/).filter(Boolean).length,
    }));

    const links = normalizedChunks
      .filter((chunk) => chunk.chunkIndex < normalizedChunks.length - 1)
      .map((chunk) => ({
        sourceChunkIndex: chunk.chunkIndex,
        targetChunkIndex: chunk.chunkIndex + 1,
        relation: "next",
        weight: 100,
      }));

    const summarySource = chunks[0] ?? normalized;

    return {
      summary:
        summarySource.length > 0
          ? `Indexed preview: ${summarySource.slice(0, 260)}`
          : "Indexed file with limited extractable text.",
      keyTopics: extractKeyTopics(normalized),
      chunkCount: chunks.length,
      textLength: normalized.length,
      chunks: normalizedChunks,
      links,
    };
  },
};
