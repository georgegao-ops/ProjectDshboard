import { readFile } from "node:fs/promises";
import { getEnv } from "../config/env";
import { logger } from "../lib/logger";

export interface DocParserShadowMetadata {
  parserName: "docling";
  parserMode: "shadow";
  endpoint: string;
  timeoutMs: number;
  succeeded: boolean;
  durationMs: number;
  extractedBlockCount?: number;
  extractedPageCount?: number;
  error?: string;
}

export interface DocParserShadowInput {
  tempFilePath: string;
  fileName?: string;
  mimeType?: string;
  enabledOverride?: boolean;
}

export const docParserService = {
  async parseShadow(input: DocParserShadowInput): Promise<DocParserShadowMetadata> {
    const env = getEnv();

    const enabled = input.enabledOverride ?? env.indexingExtractorPipelineV2Enabled;
    if (!enabled || !env.docParserEndpoint) {
      return {
        parserName: "docling",
        parserMode: "shadow",
        endpoint: env.docParserEndpoint ?? "",
        timeoutMs: env.docParserTimeoutMs,
        succeeded: false,
        durationMs: 0,
        error: "shadow_disabled_or_endpoint_missing",
      };
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.docParserTimeoutMs);

    try {
      const fileBuffer = await readFile(input.tempFilePath);
      const response = await fetch(env.docParserEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          fileName: input.fileName,
          mimeType: input.mimeType,
          contentBase64: fileBuffer.toString("base64"),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`doc_parser_http_${response.status}`);
      }

      const payload = (await response.json()) as {
        blocks?: unknown[];
        pages?: unknown[];
      };

      return {
        parserName: "docling",
        parserMode: "shadow",
        endpoint: env.docParserEndpoint,
        timeoutMs: env.docParserTimeoutMs,
        succeeded: true,
        durationMs: Date.now() - startedAt,
        extractedBlockCount: Array.isArray(payload.blocks) ? payload.blocks.length : undefined,
        extractedPageCount: Array.isArray(payload.pages) ? payload.pages.length : undefined,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("indexing-pipeline.doc-parser.shadow.failed", {
        fileName: input.fileName ?? "unknown",
        error: message,
      });
      return {
        parserName: "docling",
        parserMode: "shadow",
        endpoint: env.docParserEndpoint,
        timeoutMs: env.docParserTimeoutMs,
        succeeded: false,
        durationMs: Date.now() - startedAt,
        error: message,
      };
    } finally {
      clearTimeout(timeout);
    }
  },
};
