import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "../config/env";
import { docParserService } from "./doc-parser.service";
import { indexingPipelineInternals, indexingPipelineService } from "./indexing-pipeline.service";

describe("indexingPipelineInternals", () => {
  beforeEach(() => {
    delete process.env.INDEXING_EXTRACTOR_PIPELINE_V2_ENABLED;
    delete process.env.DOC_PARSER_ENDPOINT;
    delete process.env.DOC_PARSER_TIMEOUT_MS;
    delete process.env.OPENAI_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.OPENAI_CHAT_ENDPOINT;
    delete process.env.DEEPSEEK_CHAT_ENDPOINT;
    resetEnvCache();
    vi.restoreAllMocks();
  });

  it("assigns page 1 to single-page PDF raw chunks", () => {
    const text = "A".repeat(2200);

    const chunks = indexingPipelineInternals.buildPdfRawChunks([text], text);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.pageNumber === 1)).toBe(true);
  });

  it("does not fabricate page numbers when PDF page breakdown is unavailable", () => {
    const text = "Fallback PDF text content.";

    const chunks = indexingPipelineInternals.buildPdfRawChunks([], text);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((chunk) => chunk.pageNumber === undefined)).toBe(true);
  });

  it("carries the last seen section label across continuation chunks", () => {
    const labeled = indexingPipelineInternals.assignSectionLabels(
      [
        {
          chunkText: "3.52. EXPANSION JOINT ASSEMBLIES\n3.52.1. Submittals",
          sourceType: "content" as const,
          pageNumber: 251,
          confidence: 1,
        },
        {
          chunkText:
            "Warranty on Painted Finishes: manufacturer agrees to repair finish or replace roof expansion joints.",
          sourceType: "content" as const,
          pageNumber: 251,
          confidence: 1,
        },
        {
          chunkText: "3.53. THERMAL INSULATION",
          sourceType: "content" as const,
          pageNumber: 253,
          confidence: 1,
        },
      ],
      ["3.52. EXPANSION JOINT ASSEMBLIES", "3.53. THERMAL INSULATION"]
    );

    expect(labeled[0]?.sectionLabel).toBe("3.52. EXPANSION JOINT ASSEMBLIES");
    expect(labeled[1]?.sectionLabel).toBe("3.52. EXPANSION JOINT ASSEMBLIES");
    expect(labeled[2]?.sectionLabel).toBe("3.53. THERMAL INSULATION");
  });

  it("detects the last numbered section header inside a page-header-prefixed PDF chunk", () => {
    const labeled = indexingPipelineInternals.assignSectionLabels(
      [
        {
          chunkText:
            "PRDC 03 – Architecture Version 0 - 11/18/22 A37806 PRDC 03 - 110 Rev. 2 MTA C&D Contract Number. 3.48. EIFS STUCCO (NOT USED) 3.49. BUILT-UP ROOFING (NOT USED) 3.50. MODIFIED BITUMEN ROOFING (NOT USED) 3.51. SPRAY-ON ROOFING (NOT USED) 3.52. EXPANSION JOINT AS",
          sourceType: "content" as const,
          pageNumber: 251,
          confidence: 1,
        },
      ],
      []
    );

    expect(labeled[0]?.sectionLabel).toContain("3.52. EXPANSION JOINT AS");
  });

  it("preserves all chunks when file exceeds cap threshold", () => {
    const chunks = Array.from({ length: 401 }, (_, index) => ({
      chunkText: `chunk-${index + 1}`,
      sourceType: "content" as const,
      pageNumber: index + 1,
      metadata: { seed: true },
      confidence: 1,
    }));

    const capped = indexingPipelineInternals.capChunks(chunks, "large-file.txt");

    expect(capped.length).toBe(401);
    expect(capped[0]?.pageNumber).toBe(1);
    expect(capped[400]?.pageNumber).toBe(401);
    expect(capped[0]?.metadata).toMatchObject({ seed: true });
  });

  it("exposes adapter parse contract through default adapter", async () => {
    const context = { mime: "text/plain", ext: "txt" };
    const adapter = indexingPipelineInternals.resolveExtractionAdapter(
      { tempFilePath: "ignored.txt", mimeType: "text/plain" },
      context
    );

    expect(typeof adapter.parse).toBe("function");
    expect(adapter.name).toBe("legacy-default");
  });

  it("adds extraction parser provenance to chunk metadata", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "idx-pipeline-"));
    const tempFilePath = path.join(dir, "sample.txt");

    await writeFile(tempFilePath, "Expansion joint specification section text.", "utf8");

    try {
      const insights = await indexingPipelineService.indexTempFile({
        tempFilePath,
        fileName: "sample.txt",
        mimeType: "text/plain",
      });

      const contentChunk = insights.chunks.find((chunk) => chunk.sourceType === "content");
      expect(contentChunk?.metadata).toMatchObject({
        extractionParser: {
          parserName: "legacy-default",
          parserMode: "active",
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("attaches Docling shadow metadata when V2 shadow flag is enabled", async () => {
    process.env.INDEXING_EXTRACTOR_PIPELINE_V2_ENABLED = "true";
    process.env.DOC_PARSER_ENDPOINT = "http://docling-sidecar:8080/parse";
    process.env.DOC_PARSER_TIMEOUT_MS = "1500";
    resetEnvCache();

    vi.spyOn(docParserService, "parseShadow").mockResolvedValue({
      parserName: "docling",
      parserMode: "shadow",
      endpoint: "http://docling-sidecar:8080/parse",
      timeoutMs: 1500,
      succeeded: true,
      durationMs: 12,
      extractedBlockCount: 5,
      extractedPageCount: 2,
    });

    const dir = await mkdtemp(path.join(tmpdir(), "idx-pipeline-v2-"));
    const tempFilePath = path.join(dir, "sample-v2.txt");
    await writeFile(tempFilePath, "Doc parser shadow metadata candidate content.", "utf8");

    try {
      const insights = await indexingPipelineService.indexTempFile({
        tempFilePath,
        fileName: "sample-v2.txt",
        mimeType: "text/plain",
      });

      const contentChunk = insights.chunks.find((chunk) => chunk.sourceType === "content");
      expect(contentChunk?.metadata).toMatchObject({
        extractionParserV2Shadow: {
          parserName: "docling",
          parserMode: "shadow",
          succeeded: true,
          extractedBlockCount: 5,
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("continues indexing when Docling shadow parse fails", async () => {
    process.env.INDEXING_EXTRACTOR_PIPELINE_V2_ENABLED = "true";
    process.env.DOC_PARSER_ENDPOINT = "http://docling-sidecar:8080/parse";
    resetEnvCache();

    vi.spyOn(docParserService, "parseShadow").mockResolvedValue({
      parserName: "docling",
      parserMode: "shadow",
      endpoint: "http://docling-sidecar:8080/parse",
      timeoutMs: 12000,
      succeeded: false,
      durationMs: 30,
      error: "timeout",
    });

    const dir = await mkdtemp(path.join(tmpdir(), "idx-pipeline-v2-fail-"));
    const tempFilePath = path.join(dir, "sample-v2-fail.txt");
    await writeFile(tempFilePath, "Fallback to legacy extraction should still index.", "utf8");

    try {
      const insights = await indexingPipelineService.indexTempFile({
        tempFilePath,
        fileName: "sample-v2-fail.txt",
        mimeType: "text/plain",
      });

      expect(insights.chunkCount).toBeGreaterThan(0);
      const contentChunk = insights.chunks.find((chunk) => chunk.sourceType === "content");
      expect(contentChunk?.metadata).toMatchObject({
        extractionParser: {
          parserName: "legacy-default",
          parserMode: "active",
        },
        extractionParserV2Shadow: {
          parserName: "docling",
          succeeded: false,
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
