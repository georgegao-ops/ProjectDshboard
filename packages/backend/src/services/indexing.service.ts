import type { FileRecord, UUID } from "@contractor/shared";
import { desc, eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { INDEXING_QUEUE_POLICY } from "../lib/queue";
import { EmbeddingProviderError, type EmbeddingErrorCode, embeddingsService } from "./embeddings.service";
import { featureService } from "./feature.service";
import { indexingPipelineService } from "./indexing-pipeline.service";
import { onedriveService } from "./onedrive.service";
import { projectService } from "./project.service";
import type { RequestUserContext } from "./service-types";
import { documentStorageService } from "./document-storage.service";
import { rm } from "node:fs/promises";
import { getDbIfInitialized, indexingErrors } from "../db";
import { constructionClassifierService, type ClassificationResult } from "./construction-classifier.service";

// Process high-priority files first; 5 concurrent per batch
const INDEXING_BATCH_SIZE = 5;
const FILE_INDEXING_RETRY_LIMIT = 3;
const STALE_PROCESSING_TIMEOUT_MS = 15 * 60 * 1000;
const FILE_DOWNLOAD_TIMEOUT_MS = 90_000;
const FILE_EXTRACT_TIMEOUT_MS = 120_000;
const FILE_STORAGE_TIMEOUT_MS = 45_000;
const FILE_EMBEDDING_TIMEOUT_MS = 180_000;
const FILE_PERSIST_TIMEOUT_MS = 45_000;
const FILE_STATUS_UPDATE_TIMEOUT_MS = 20_000;
const EMBEDDING_BATCH_SIZE = 50;
const ERROR_RECORD_TIMEOUT_MS = 1_500;
const EMBEDDING_FATAL_THRESHOLD = 3;
const EMBEDDING_CIRCUIT_COOLDOWN_MS = 60_000;

const PROJECT_FILES_PAGE_SIZE = 1000;

type IndexingStage =
  | "preflight"
  | "download"
  | "extract"
  | "embedding"
  | "persistence"
  | "status_update"
  | "pipeline";

interface ProjectPauseState {
  paused: boolean;
  reasonCode: string;
  message: string;
  since: Date;
  until?: Date;
}

interface EmbeddingCircuitState {
  consecutiveFatal: number;
  openUntil?: number;
}

interface GroupedFailureReason {
  stage: string;
  errorCode: string;
  count: number;
  lastMessage: string;
  lastSeenAt: Date;
}

interface IndexingAnomaly {
  type: string;
  count: number;
  message: string;
}

class IndexingFailure extends Error {
  constructor(
    public readonly stage: IndexingStage,
    public readonly code: string,
    public readonly fatal: boolean,
    message: string,
    public readonly causeValue?: unknown
  ) {
    super(message);
    this.name = "IndexingFailure";
  }
}

const pauseStateByProject = new Map<string, ProjectPauseState>();
const embeddingCircuitByProject = new Map<string, EmbeddingCircuitState>();

function redactSensitiveText(input: string): string {
  return input
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9]{10,}/g, "sk-[REDACTED]");
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return redactSensitiveText(error.message);
  }

  return redactSensitiveText(String(error));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => {
        reject(new Error(timeoutMessage));
      }, timeoutMs);
    }),
  ]);
}

function isTransientPersistenceError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("deadlock") ||
    message.includes("connection") ||
    message.includes("econn") ||
    message.includes("too many clients")
  );
}

function normalizeFailure(error: unknown, fallbackStage: IndexingStage): IndexingFailure {
  if (error instanceof IndexingFailure) {
    return error;
  }

  if (error instanceof EmbeddingProviderError) {
    const fatalCodes: EmbeddingErrorCode[] = [
      "embedding_auth",
      "embedding_bad_request",
      "embedding_invalid_response",
    ];

    return new IndexingFailure(
      "embedding",
      error.code,
      fatalCodes.includes(error.code),
      toErrorMessage(error),
      error
    );
  }

  return new IndexingFailure(fallbackStage, "indexing_unknown", false, toErrorMessage(error), error);
}

function groupedFailureReasonsFromRows(rows: Array<{
  stage: string;
  errorCode: string;
  errorMessage: string;
  createdAt: Date;
}>): GroupedFailureReason[] {
  const grouped = new Map<string, GroupedFailureReason>();

  for (const row of rows) {
    const key = `${row.stage}|${row.errorCode}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        stage: row.stage,
        errorCode: row.errorCode,
        count: 1,
        lastMessage: redactSensitiveText(row.errorMessage),
        lastSeenAt: row.createdAt,
      });
      continue;
    }

    existing.count += 1;
    if (row.createdAt > existing.lastSeenAt) {
      existing.lastSeenAt = row.createdAt;
      existing.lastMessage = redactSensitiveText(row.errorMessage);
    }
  }

  return [...grouped.values()].sort((a, b) => b.count - a.count).slice(0, 8);
}

function setProjectPaused(projectId: UUID, state: ProjectPauseState): void {
  pauseStateByProject.set(projectId, state);
}

function clearProjectPaused(projectId: UUID): void {
  pauseStateByProject.delete(projectId);
}

function getProjectPauseState(projectId: UUID): ProjectPauseState | undefined {
  const pause = pauseStateByProject.get(projectId);
  if (!pause) {
    return undefined;
  }

  if (pause.until && pause.until.getTime() <= Date.now()) {
    pauseStateByProject.delete(projectId);
    return undefined;
  }

  return pause;
}

function getOrCreateCircuit(projectId: UUID): EmbeddingCircuitState {
  const existing = embeddingCircuitByProject.get(projectId);
  if (existing) {
    return existing;
  }

  const state: EmbeddingCircuitState = { consecutiveFatal: 0 };
  embeddingCircuitByProject.set(projectId, state);
  return state;
}

function toBatches<T>(input: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < input.length; index += batchSize) {
    batches.push(input.slice(index, index + batchSize));
  }
  return batches;
}

async function listAllProjectFiles(projectId: UUID): Promise<{
  total: number;
  files: Awaited<ReturnType<typeof projectService.listProjectFiles>>["files"];
}> {
  let page = 1;
  let total = 0;
  const files: Awaited<ReturnType<typeof projectService.listProjectFiles>>["files"] = [];

  while (true) {
    const response = await projectService.listProjectFiles(projectId, {
      page,
      pageSize: PROJECT_FILES_PAGE_SIZE,
    });

    total = response.total;
    files.push(...response.files);

    if (files.length >= total || response.files.length === 0) {
      break;
    }

    page += 1;
  }

  return { total, files };
}

async function recordIndexingError(
  projectId: UUID,
  fileId: string | undefined,
  onedriveItemId: string | undefined,
  fileName: string | undefined,
  stage: string,
  error: unknown,
  attempt: number,
  errorCode?: string
): Promise<void> {
  const db = getDbIfInitialized();
  if (!db) return;
  const errorMessage = toErrorMessage(error);
  try {
    await db.insert(indexingErrors).values({
      projectId,
      fileId: fileId ?? undefined,
      onedriveItemId: onedriveItemId ?? null,
      fileName: fileName ?? null,
      stage,
      errorCode: errorCode ?? (error instanceof Error ? error.constructor.name : "UnknownError"),
      errorMessage: errorMessage.slice(0, 2000),
      attempt,
    });
  } catch (dbErr) {
    logger.warn("indexing.error-record.failed", { dbErr: String(dbErr) });
  }
}

function isSkippedByPolicy(tags: string[] | undefined): boolean {
  const tagSet = new Set(tags ?? []);
  return tagSet.has("unsupported_type");
}

function isMetadataOnlyMode(file: {
  processingMode?: "full" | "reduced" | "metadata_only";
  tags?: string[];
}): boolean {
  if (file.processingMode === "metadata_only") {
    return true;
  }

  return (file.tags ?? []).includes("metadata_only");
}

function isMetadataOnlyInsights(
  insights: Awaited<ReturnType<typeof indexingPipelineService.indexTempFile>>
): boolean {
  if (insights.chunks.length === 0) {
    return true;
  }

  return insights.chunks.every((chunk) => chunk.sourceType === "metadata_stub");
}

function normalizeForObjectStorage(
  insights: Awaited<ReturnType<typeof indexingPipelineService.indexTempFile>>
): string {
  return insights.chunks
    .filter((chunk) => chunk.sourceType !== "metadata_stub")
    .map((chunk) => chunk.chunkText.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function inferExtractedPercent(
  file: {
    processingMode?: "full" | "reduced" | "metadata_only";
    extractedContentPercent?: number;
  },
  metadataOnly: boolean
): number {
  if (metadataOnly) {
    return 0;
  }

  if (typeof file.extractedContentPercent === "number") {
    return file.extractedContentPercent;
  }

  if (file.processingMode === "reduced") {
    return 50;
  }

  return 100;
}

function shouldUseFilenameOnlyIndexing(file: {
  fileName: string;
  mimeType?: string;
}): boolean {
  const mime = (file.mimeType ?? "").toLowerCase();
  const lowerName = file.fileName.toLowerCase();

  return (
    mime.includes("spreadsheetml") ||
    mime.includes("ms-excel") ||
    lowerName.endsWith(".xlsx") ||
    lowerName.endsWith(".xls") ||
    lowerName.endsWith(".xlsm") ||
    lowerName.endsWith(".xlsb")
  );
}

function isStaleProcessingFile(file: {
  indexStatus: "pending" | "processing" | "indexed" | "failed";
  updatedAt?: Date;
}): boolean {
  if (file.indexStatus !== "processing") {
    return false;
  }

  if (!(file.updatedAt instanceof Date)) {
    return false;
  }

  return Date.now() - file.updatedAt.getTime() > STALE_PROCESSING_TIMEOUT_MS;
}

function buildMetadataChunkText(file: {
  fileName: string;
  filePath: string;
  mimeType?: string;
  fileSize?: number;
  tags?: string[];
}, reason: string): string {
  const details = [
    `FILE NAME: ${file.fileName}`,
    `FILE PATH: ${file.filePath}`,
    `MIME TYPE: ${file.mimeType ?? "unknown"}`,
    `FILE SIZE: ${typeof file.fileSize === "number" ? `${file.fileSize}` : "unknown"}`,
    `INDEXING MODE: metadata-only fallback`,
    `REASON: ${reason}`,
  ];

  if ((file.tags ?? []).length > 0) {
    details.push(`TAGS: ${(file.tags ?? []).join(", ")}`);
  }

  return details.join("\n");
}

async function buildMetadataOnlyInsights(
  file: {
    fileName: string;
    filePath: string;
    mimeType?: string;
    fileSize?: number;
    tags?: string[];
  },
  reason: string
): Promise<Awaited<ReturnType<typeof indexingPipelineService.indexTempFile>>> {
  const metadataText = buildMetadataChunkText(file, reason);

  let classification: ClassificationResult;
  try {
    classification = await constructionClassifierService.classify(
      file.fileName,
      file.filePath,
      metadataText
    );
  } catch {
    classification = {
      category: "unknown",
      confidence: 0,
      extractedFields: {},
      tags: [],
    };
  }

  const mergedTags = Array.from(new Set([...(file.tags ?? []), ...classification.tags, "metadata_only"]));

  return {
    summary: `Indexed by metadata fallback. ${reason}`,
    keyTopics: [file.fileName, file.mimeType ?? "unknown", "metadata-only"],
    chunkCount: 1,
    textLength: metadataText.length,
    classification: {
      ...classification,
      tags: mergedTags,
    },
    chunks: [
      {
        chunkIndex: 0,
        chunkText: metadataText,
        tokenCount: metadataText.split(/\s+/).filter(Boolean).length,
        sourceType: "metadata_stub",
        metadata: {
          filePath: file.filePath,
          mimeType: file.mimeType,
          reason,
        },
        confidence: 1,
      },
    ],
    links: [],
  };
}

async function embedChunksInBatches(chunks: Array<{ chunkText: string }>) {
  const results: Awaited<ReturnType<typeof embeddingsService.embedBatch>> = [];

  for (let index = 0; index < chunks.length; index += EMBEDDING_BATCH_SIZE) {
    const batch = chunks.slice(index, index + EMBEDDING_BATCH_SIZE);
    const batchResults = await embeddingsService.embedBatch(
      batch.map((chunk) => chunk.chunkText)
    );
    results.push(...batchResults);
  }

  return results;
}

export const indexingService = {
  logJobQueued(jobId: string, projectId: UUID, idempotencyKey: string): void {
    logger.info("indexing.job.queued", {
      jobId,
      projectId,
      idempotencyKey,
      retryAttempts: INDEXING_QUEUE_POLICY.attempts,
      backoffMs: INDEXING_QUEUE_POLICY.backoffMs,
      deadLetterQueue: INDEXING_QUEUE_POLICY.deadLetterQueue,
      concurrency: INDEXING_QUEUE_POLICY.concurrency,
    });
  },

  async processProjectIndexing(
    projectId: UUID,
    requester: RequestUserContext | undefined
  ): Promise<void> {
    const initialCircuit = getOrCreateCircuit(projectId);
    if (initialCircuit.openUntil && Date.now() < initialCircuit.openUntil) {
      const until = new Date(initialCircuit.openUntil);
      setProjectPaused(projectId, {
        paused: true,
        reasonCode: "embedding_outage",
        message: "Embedding provider circuit is open; indexing paused.",
        since: new Date(),
        until,
      });
      logger.warn("indexing.project.paused.circuit-open", {
        projectId,
        resumesAt: until.toISOString(),
      });
      return;
    }

    const preflight = await embeddingsService.preflight();
    if (!preflight.ok) {
      setProjectPaused(projectId, {
        paused: true,
        reasonCode: preflight.code ?? "embedding_unknown",
        message: preflight.message ?? "Embedding provider preflight failed.",
        since: new Date(),
      });

      logger.warn("indexing.project.paused.preflight", {
        projectId,
        reasonCode: preflight.code,
        message: preflight.message,
      });
      return;
    }

    clearProjectPaused(projectId);

    if (!requester) {
      logger.warn("indexing.project.requester-missing", {
        projectId,
        message: "Missing requester context. Falling back to metadata-only indexing for this run.",
      });
    }

    const filesResponse = await listAllProjectFiles(projectId);

    const staleProcessingFiles = filesResponse.files.filter((file) => isStaleProcessingFile(file));
    if (staleProcessingFiles.length > 0) {
      await Promise.all(
        staleProcessingFiles.map((file) =>
          projectService.updateFileIndexingResult(projectId, file.onedriveItemId, {
            indexStatus: "pending",
            summary: "Recovered from stale processing state. Retrying.",
          })
        )
      );

      logger.warn("indexing.project.recovered-stale-processing", {
        projectId,
        recoveredCount: staleProcessingFiles.length,
      });
    }

    // Sort pending files by priority score descending (high-value docs first)
    const pendingFiles = filesResponse.files
      .filter(
        (file) =>
          file.indexStatus === "pending" ||
          (file.indexStatus === "failed" && !isSkippedByPolicy(file.tags)) ||
          isStaleProcessingFile(file)
      )
      .sort((a, b) => (b.priorityScore ?? 50) - (a.priorityScore ?? 50));

    logger.info("indexing.project.started", {
      projectId,
      pendingCount: pendingFiles.length,
    });

    const batches = toBatches(pendingFiles, INDEXING_BATCH_SIZE);

    for (const batch of batches) {
      await Promise.all(
        batch.map(async (file) => {
          let tempFilePath: string | undefined;

          try {
            const circuitState = getOrCreateCircuit(projectId);
            if (circuitState.openUntil && Date.now() < circuitState.openUntil) {
              return;
            }

            await projectService.updateFileIndexingResult(projectId, file.onedriveItemId, {
              indexStatus: "processing",
            });

            let insights: Awaited<ReturnType<typeof indexingPipelineService.indexTempFile>> | undefined;
            let processingReason = file.processingReason;

            if (!requester) {
              processingReason = "Missing requester context for file download.";
              insights = await buildMetadataOnlyInsights(file, processingReason);
            } else if (shouldUseFilenameOnlyIndexing(file)) {
              processingReason = "Filename-only indexing for unreadable spreadsheet file type.";
              insights = await buildMetadataOnlyInsights(
                file,
                processingReason
              );
            } else if (isMetadataOnlyMode(file)) {
              processingReason = file.processingReason ?? "File is assigned to metadata-only mode.";
              insights = await buildMetadataOnlyInsights(file, processingReason);
            } else if (isSkippedByPolicy(file.tags)) {
              processingReason = "File skipped by policy.";
              insights = await buildMetadataOnlyInsights(file, processingReason);
            } else {
              try {
                const downloaded = await withTimeout(
                  onedriveService.downloadFileToTemp(
                    requester,
                    file.onedriveItemId,
                    file.fileName
                  ),
                  FILE_DOWNLOAD_TIMEOUT_MS,
                  `File download timed out after ${Math.round(FILE_DOWNLOAD_TIMEOUT_MS / 1000)}s.`
                );
                tempFilePath = downloaded.tempFilePath;

                let attempt = 0;
                let lastExtractionError: unknown;

                while (attempt < FILE_INDEXING_RETRY_LIMIT && !insights) {
                  attempt += 1;
                  try {
                    const extractorV2Enabled = featureService.isRolloutFlagEnabledForProject(
                      projectId,
                      "INDEXING_EXTRACTOR_PIPELINE_V2_ENABLED"
                    );

                    insights = await withTimeout(
                      indexingPipelineService.indexTempFile({
                        tempFilePath: downloaded.tempFilePath,
                        fileName: file.fileName,
                        filePath: file.filePath,
                        mimeType: file.mimeType,
                        projectId,
                        rollout: {
                          extractorV2Enabled,
                        },
                      }),
                      FILE_EXTRACT_TIMEOUT_MS,
                      `File extraction timed out after ${Math.round(FILE_EXTRACT_TIMEOUT_MS / 1000)}s.`
                    );
                  } catch (attemptError) {
                    lastExtractionError = attemptError;
                    await withTimeout(
                      recordIndexingError(
                        projectId,
                        file.id,
                        file.onedriveItemId,
                        file.fileName,
                        "extract",
                        attemptError,
                        attempt,
                        "extract_retry_failed"
                      ),
                      ERROR_RECORD_TIMEOUT_MS,
                      "indexing error record timed out"
                    ).catch((recordError) => {
                      logger.warn("indexing.error-record.timeout", {
                        projectId,
                        fileId: file.id,
                        stage: "extract",
                        error: toErrorMessage(recordError),
                      });
                    });
                  }
                }

                if (!insights) {
                  const fallbackReason =
                    lastExtractionError instanceof Error
                      ? `Extraction failed after retries: ${lastExtractionError.message}`
                      : "Extraction failed after retries.";
                  processingReason = fallbackReason;
                  insights = await buildMetadataOnlyInsights(file, fallbackReason);
                }
              } catch (downloadOrPipelineError) {
                await withTimeout(
                  recordIndexingError(
                    projectId,
                    file.id,
                    file.onedriveItemId,
                    file.fileName,
                    "download",
                    downloadOrPipelineError,
                    1,
                    "download_failed"
                  ),
                  ERROR_RECORD_TIMEOUT_MS,
                  "indexing error record timed out"
                ).catch((recordError) => {
                  logger.warn("indexing.error-record.timeout", {
                    projectId,
                    fileId: file.id,
                    stage: "download",
                    error: toErrorMessage(recordError),
                  });
                });
                const fallbackReason =
                  downloadOrPipelineError instanceof Error
                    ? `Download/extract path failed: ${downloadOrPipelineError.message}`
                    : "Download/extract path failed.";
                processingReason = fallbackReason;
                insights = await buildMetadataOnlyInsights(file, fallbackReason);
              }
            }

            let metadataOnlyResult = isMetadataOnlyInsights(insights);
            let resolvedProcessingMode: "full" | "reduced" | "metadata_only" = metadataOnlyResult
              ? "metadata_only"
              : file.processingMode === "reduced"
                ? "reduced"
                : "full";

            let normalizedTextObjectKey: string | undefined;
            let normalizedTextChecksum: string | undefined;
            let normalizedTextLength: number | undefined;
            let normalizedTextStoredAt: Date | undefined;
            let encryptionKeyVersion: number | undefined;

            if (!metadataOnlyResult && requester) {
              const normalizedText = normalizeForObjectStorage(insights);
              if (normalizedText.length > 0) {
                try {
                  const normalizedTextStorage = await withTimeout(
                    documentStorageService.saveNormalizedText({
                      orgId: requester.orgId,
                      projectId,
                      fileId: file.id,
                      versionHash: file.versionHash ?? file.onedriveEtag,
                      text: normalizedText,
                    }),
                    FILE_STORAGE_TIMEOUT_MS,
                    `Normalized text persistence timed out after ${Math.round(FILE_STORAGE_TIMEOUT_MS / 1000)}s.`
                  );
                  normalizedTextObjectKey = normalizedTextStorage.objectKey;
                  normalizedTextChecksum = normalizedTextStorage.checksum;
                  normalizedTextLength = normalizedTextStorage.normalizedTextLength;
                  normalizedTextStoredAt = normalizedTextStorage.storedAt;
                  encryptionKeyVersion = normalizedTextStorage.encryptionKeyVersion;
                } catch (storageError) {
                  processingReason = storageError instanceof Error
                    ? `Normalized text persistence failed: ${storageError.message}`
                    : "Normalized text persistence failed.";
                  insights = await buildMetadataOnlyInsights(file, processingReason);
                  metadataOnlyResult = true;
                  resolvedProcessingMode = "metadata_only";
                  normalizedTextObjectKey = undefined;
                  normalizedTextChecksum = undefined;
                  normalizedTextLength = undefined;
                  normalizedTextStoredAt = undefined;
                  encryptionKeyVersion = undefined;
                }
              }
            }

            let embeddingResults: Awaited<ReturnType<typeof embeddingsService.embedBatch>>;
            try {
              embeddingResults = await withTimeout(
                embedChunksInBatches(insights.chunks),
                FILE_EMBEDDING_TIMEOUT_MS,
                `Embedding generation timed out after ${Math.round(FILE_EMBEDDING_TIMEOUT_MS / 1000)}s.`
              );
              if (embeddingResults.length !== insights.chunks.length) {
                throw new IndexingFailure(
                  "embedding",
                  "embedding_count_mismatch",
                  true,
                  `Expected ${insights.chunks.length} embeddings but received ${embeddingResults.length}.`
                );
              }
            } catch (error) {
              const normalized = normalizeFailure(error, "embedding");
              throw new IndexingFailure("embedding", normalized.code, normalized.fatal, normalized.message, error);
            }

            let persistenceAttempt = 0;
            while (true) {
              try {
                await withTimeout(
                  projectService.replaceFileChunks(
                    projectId,
                    file.id,
                    file.onedriveItemId,
                    file.fileName,
                    insights.chunks.map((chunk, index) => ({
                      chunkIndex: chunk.chunkIndex,
                      chunkText: chunk.chunkText,
                      tokenCount: chunk.tokenCount,
                      embeddingModel: embeddingResults[index]?.model ?? "unknown",
                      embedding: embeddingResults[index]?.vector ?? [],
                      sourceType: chunk.sourceType,
                      pageNumber: chunk.pageNumber,
                      sectionLabel: chunk.sectionLabel,
                      metadata: chunk.metadata,
                      confidence: chunk.confidence,
                    })),
                    insights.links
                  ),
                  FILE_PERSIST_TIMEOUT_MS,
                  `Chunk persistence timed out after ${Math.round(FILE_PERSIST_TIMEOUT_MS / 1000)}s.`
                );
                break;
              } catch (error) {
                persistenceAttempt += 1;
                const transient = isTransientPersistenceError(error);

                await withTimeout(
                  recordIndexingError(
                    projectId,
                    file.id,
                    file.onedriveItemId,
                    file.fileName,
                    "persistence",
                    error,
                    persistenceAttempt,
                    transient ? "db_write_retry" : "db_write_failed"
                  ),
                  ERROR_RECORD_TIMEOUT_MS,
                  "indexing error record timed out"
                ).catch(() => undefined);

                if (!transient || persistenceAttempt >= 2) {
                  throw new IndexingFailure(
                    "persistence",
                    transient ? "db_write_timeout" : "db_write_failed",
                    false,
                    `Chunk persistence failed: ${toErrorMessage(error)}`,
                    error
                  );
                }
              }
            }

            const cls = insights.classification;
            try {
              await withTimeout(
                projectService.updateFileIndexingResult(projectId, file.onedriveItemId, {
                  indexStatus: "indexed",
                  summary: insights.summary,
                  keyTopics: insights.keyTopics,
                  chunkCount: insights.chunkCount,
                  lastIndexed: new Date(),
                  processingMode: resolvedProcessingMode,
                  processingReason,
                  reducedCoverage: resolvedProcessingMode !== "full",
                  extractedContentPercent: inferExtractedPercent(file, metadataOnlyResult),
                  normalizedTextObjectKey,
                  normalizedTextChecksum,
                  normalizedTextLength,
                  normalizedTextStoredAt,
                  encryptionKeyVersion,
                  // Construction intelligence fields
                  docCategory: cls.category as FileRecord["docCategory"],
                  tags: cls.tags,
                  extractedFields: cls.extractedFields as Record<string, unknown>,
                  specSection: cls.extractedFields.specSection,
                  sheetNumber: cls.extractedFields.sheetNumber,
                  revision: cls.extractedFields.revision,
                }),
                FILE_STATUS_UPDATE_TIMEOUT_MS,
                `Index status update timed out after ${Math.round(FILE_STATUS_UPDATE_TIMEOUT_MS / 1000)}s.`
              );
            } catch (error) {
              throw new IndexingFailure(
                "status_update",
                "status_update_failed",
                false,
                `Index status update failed: ${toErrorMessage(error)}`,
                error
              );
            }

            const healthyCircuit = getOrCreateCircuit(projectId);
            healthyCircuit.consecutiveFatal = 0;
            healthyCircuit.openUntil = undefined;
            clearProjectPaused(projectId);

            logger.info("indexing.file.indexed", {
              projectId,
              fileId: file.id,
              fileName: file.fileName,
              category: cls.category,
              confidence: cls.confidence,
              chunkCount: insights.chunkCount,
            });
          } catch (error) {
            const failure = normalizeFailure(error, "pipeline");

            await withTimeout(
              recordIndexingError(
                projectId,
                file.id,
                file.onedriveItemId,
                file.fileName,
                failure.stage,
                failure,
                FILE_INDEXING_RETRY_LIMIT,
                failure.code
              ),
              ERROR_RECORD_TIMEOUT_MS,
              "indexing error record timed out"
            ).catch((recordError) => {
              logger.warn("indexing.error-record.timeout", {
                projectId,
                fileId: file.id,
                stage: failure.stage,
                error: toErrorMessage(recordError),
              });
            });

            if (failure.stage === "embedding" && failure.fatal) {
              const circuitState = getOrCreateCircuit(projectId);
              circuitState.consecutiveFatal += 1;
              if (circuitState.consecutiveFatal >= EMBEDDING_FATAL_THRESHOLD) {
                const openUntil = Date.now() + EMBEDDING_CIRCUIT_COOLDOWN_MS;
                circuitState.openUntil = openUntil;
                setProjectPaused(projectId, {
                  paused: true,
                  reasonCode: "embedding_outage",
                  message: "Indexing paused due to repeated fatal embedding failures.",
                  since: new Date(),
                  until: new Date(openUntil),
                });
              }
            }

            const errorMessage = failure.message || "Indexing failed.";
            try {
              await projectService.updateFileIndexingResult(projectId, file.onedriveItemId, {
                indexStatus: "failed",
                summary: `Indexing failed [${failure.code}]: ${errorMessage}`,
                keyTopics: [],
                chunkCount: 0,
                lastIndexed: new Date(),
              });
            } catch (statusError) {
              logger.error("indexing.file.status-update.failed", statusError, {
                projectId,
                fileId: file.id,
                fileName: file.fileName,
              });
            }

            logger.error("indexing.file.failed", {
              projectId,
              fileId: file.id,
              fileName: file.fileName,
              stage: failure.stage,
              code: failure.code,
              error: errorMessage,
            });
          } finally {
            if (tempFilePath) {
              await rm(tempFilePath, { force: true });
            }
          }
        })
      );
    }
  },

  async getProjectIndexingProgress(projectId: UUID): Promise<{
    total: number;
    processableTotal: number;
    pending: number;
    processing: number;
    indexed: number;
    failed: number;
    skipped: number;
    unsupportedCount: number;
    oversizeCount: number;
    completionPercent: number;
    paused: boolean;
    pauseReasonCode?: string;
    pauseMessage?: string;
    pauseSince?: Date;
    pauseUntil?: Date;
    circuitOpen: boolean;
    categoryBreakdown: Record<string, number>;
    recentErrors: Array<{ fileName: string; stage: string; errorCode: string; errorMessage: string; createdAt: Date }>;
    groupedFailureReasons: GroupedFailureReason[];
    anomalies: IndexingAnomaly[];
  }> {
    const initialFilesResponse = await listAllProjectFiles(projectId);

    const staleProcessingFiles = initialFilesResponse.files.filter((file) => isStaleProcessingFile(file));
    if (staleProcessingFiles.length > 0) {
      await Promise.all(
        staleProcessingFiles.map((file) =>
          projectService.updateFileIndexingResult(projectId, file.onedriveItemId, {
            indexStatus: "pending",
            summary: "Recovered from stale processing state during progress check.",
          })
        )
      );

      logger.warn("indexing.project.recovered-stale-processing.progress", {
        projectId,
        recoveredCount: staleProcessingFiles.length,
      });
    }

    const filesResponse = staleProcessingFiles.length > 0
      ? await listAllProjectFiles(projectId)
      : initialFilesResponse;

    const total = filesResponse.total;
    const skippedFiles = filesResponse.files.filter(
      (f) =>
        f.indexStatus === "failed" &&
        (f.tags ?? []).includes("unsupported_type")
    );
    const processableTotal = Math.max(0, total - skippedFiles.length);
    const pending = filesResponse.files.filter((f) => f.indexStatus === "pending").length;
    const processing = filesResponse.files.filter((f) => f.indexStatus === "processing").length;
    const indexed = filesResponse.files.filter((f) => f.indexStatus === "indexed").length;
    const failed = filesResponse.files.filter(
      (f) =>
        f.indexStatus === "failed" &&
        !(f.tags ?? []).includes("unsupported_type")
    ).length;
    const skipped = skippedFiles.length;
    const unsupportedCount = filesResponse.files.filter((f) => (f.tags ?? []).includes("unsupported_type")).length;
    const oversizeCount = filesResponse.files.filter((f) => (f.tags ?? []).includes("oversize")).length;
    const completionPercent =
      processableTotal === 0
        ? 100
        : Math.round(((indexed + failed) / processableTotal) * 100);

    // Build category breakdown from indexed files
    const categoryBreakdown: Record<string, number> = {};
    for (const file of filesResponse.files.filter((f) => f.indexStatus === "indexed")) {
      const cat = file.docCategory ?? "unknown";
      categoryBreakdown[cat] = (categoryBreakdown[cat] ?? 0) + 1;
    }

    const anomalies: IndexingAnomaly[] = [];
    const indexedWithNoChunks = filesResponse.files.filter(
      (f) => f.indexStatus === "indexed" && (f.chunkCount ?? 0) <= 0
    ).length;
    if (indexedWithNoChunks > 0) {
      anomalies.push({
        type: "indexed_without_chunks",
        count: indexedWithNoChunks,
        message: "Indexed files were found with zero chunk count.",
      });
    }

    // Recent errors from error table
    const db = getDbIfInitialized();
    let recentErrors: Array<{ fileName: string; stage: string; errorCode: string; errorMessage: string; createdAt: Date }> = [];
    let groupedFailureReasons: GroupedFailureReason[] = [];
    if (db) {
      try {
        const rows = await db
          .select({
            fileName: indexingErrors.fileName,
            stage: indexingErrors.stage,
            errorCode: indexingErrors.errorCode,
            errorMessage: indexingErrors.errorMessage,
            createdAt: indexingErrors.createdAt,
          })
          .from(indexingErrors)
          .where(eq(indexingErrors.projectId, projectId))
          .orderBy(desc(indexingErrors.createdAt))
          .limit(50);
        recentErrors = rows.map((r) => ({
          fileName: r.fileName ?? "unknown",
          stage: r.stage,
          errorCode: r.errorCode,
          errorMessage: redactSensitiveText(r.errorMessage),
          createdAt: r.createdAt,
        }));
        groupedFailureReasons = groupedFailureReasonsFromRows(
          rows.map((row) => ({
            stage: row.stage,
            errorCode: row.errorCode,
            errorMessage: row.errorMessage,
            createdAt: row.createdAt,
          }))
        );
      } catch {
        // non-fatal — errors table may not exist yet
      }
    }

    const pause = getProjectPauseState(projectId);
    const circuit = getOrCreateCircuit(projectId);
    const circuitOpen = Boolean(circuit.openUntil && Date.now() < circuit.openUntil);

    return {
      total,
      processableTotal,
      pending,
      processing,
      indexed,
      failed,
      skipped,
      unsupportedCount,
      oversizeCount,
      completionPercent,
      paused: pause?.paused ?? false,
      pauseReasonCode: pause?.reasonCode,
      pauseMessage: pause?.message,
      pauseSince: pause?.since,
      pauseUntil: pause?.until,
      circuitOpen,
      categoryBreakdown,
      recentErrors,
      groupedFailureReasons,
      anomalies,
    };
  },
};

export const indexingServiceInternals = {
  redactSensitiveText,
  normalizeFailure,
  groupedFailureReasonsFromRows,
};
