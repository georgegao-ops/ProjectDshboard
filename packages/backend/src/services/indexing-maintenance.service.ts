import type { UUID } from "@contractor/shared";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { getEnv } from "../config/env";
import { fileChunks, fileRecords, getDbIfInitialized, rechunkRuns } from "../db";
import { logger } from "../lib/logger";
import { documentStorageService } from "./document-storage.service";
import { embeddingsService } from "./embeddings.service";
import { indexingPipelineService } from "./indexing-pipeline.service";
import { projectService } from "./project.service";
import { toUuid } from "./service-types";

const EMBEDDING_BATCH_SIZE = 50;
const PROJECT_FILES_PAGE_SIZE = 1000;
const ERROR_MESSAGE_BUFFER_SIZE = 5000;
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 25550; // ~70 years

// Serializes rechunk operations per file to prevent concurrent overwrites
const concurrentRechunkLocks = new Map<string, Promise<void>>();

async function withRechunkLock<T>(
  projectId: UUID,
  fileId: UUID,
  fn: () => Promise<T>
): Promise<T> {
  const key = `${projectId}:${fileId}`;
  const existingLock = concurrentRechunkLocks.get(key);

  // Chain this operation after any existing lock
  const newLock = (existingLock ?? Promise.resolve()).then(fn).finally(() => {
    if (concurrentRechunkLocks.get(key) === newLock) {
      concurrentRechunkLocks.delete(key);
    }
  });

  concurrentRechunkLocks.set(key, newLock as Promise<void>);
  return newLock;
}

interface RechunkFileInput {
  projectId: UUID;
  fileId: UUID;
  orgId?: string;
  triggerReason: string;
}

async function listAllProjectFiles(projectId: UUID): Promise<{
  total: number;
  files: Awaited<ReturnType<typeof projectService.listProjectFiles>>["files"];
}> {
  let page = 1;
  let totalFiles = 0;
  const files: Awaited<ReturnType<typeof projectService.listProjectFiles>>["files"] = [];

  while (true) {
    const response = await projectService.listProjectFiles(projectId, {
      page,
      pageSize: PROJECT_FILES_PAGE_SIZE,
    });

    totalFiles = response.total;
    files.push(...response.files);

    const fetchedUpThrough = page * PROJECT_FILES_PAGE_SIZE;
    if (fetchedUpThrough >= totalFiles || response.files.length === 0) {
      break;
    }

    page += 1;
  }

  return { total: totalFiles, files };
}

function toBatches<T>(input: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < input.length; index += batchSize) {
    batches.push(input.slice(index, index + batchSize));
  }
  return batches;
}

async function resolveOrgId(projectId: UUID, orgId?: string): Promise<string> {
  if (orgId) {
    return orgId;
  }

  const project = await projectService.getProjectOrThrow(projectId);
  return project.orgId;
}

async function recordRunStart(input: RechunkFileInput): Promise<UUID | null> {
  const db = getDbIfInitialized();
  if (!db) {
    logger.warn("indexing-maintenance.recordRunStart.db-not-initialized", {
      projectId: input.projectId,
      fileId: input.fileId,
    });
    return null;
  }

  const [run] = await db
    .insert(rechunkRuns)
    .values({
      projectId: input.projectId,
      fileId: input.fileId,
      status: "in_progress",
      triggerReason: input.triggerReason,
      strategyVersion: "v1",
      startedAt: new Date(),
      createdAt: new Date(),
    })
    .returning({ id: rechunkRuns.id });

  return run?.id ? toUuid(run.id) : null;
}

async function recordRunSuccess(runId: UUID | null): Promise<void> {
  if (!runId) {
    return;
  }

  const db = getDbIfInitialized();
  if (!db) {
    return;
  }

  await db
    .update(rechunkRuns)
    .set({
      status: "completed",
      completedAt: new Date(),
      errorMessage: null,
    })
    .where(eq(rechunkRuns.id, runId));
}

async function recordRunFailure(runId: UUID | null, error: unknown): Promise<void> {
  if (!runId) {
    return;
  }

  const db = getDbIfInitialized();
  if (!db) {
    logger.warn("indexing-maintenance.recordRunFailure.db-not-initialized", {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const errorMessage = error instanceof Error ? error.message : String(error);
  const truncatedError = errorMessage.slice(0, ERROR_MESSAGE_BUFFER_SIZE);

  await db
    .update(rechunkRuns)
    .set({
      status: "failed",
      completedAt: new Date(),
      errorMessage: truncatedError,
    })
    .where(eq(rechunkRuns.id, runId));
}

async function clearNormalizedMetadataInDb(fileId: UUID): Promise<void> {
  const db = getDbIfInitialized();
  if (!db) {
    return;
  }

  await db
    .update(fileRecords)
    .set({
      normalizedTextObjectKey: null,
      normalizedTextChecksum: null,
      normalizedTextLength: null,
      normalizedTextStoredAt: null,
      encryptionKeyVersion: null,
      updatedAt: new Date(),
    })
    .where(eq(fileRecords.id, fileId));
}

export const indexingMaintenanceService = {
  async backfillPageProvenance(input: {
    projectId: UUID;
    orgId?: string;
    triggerReason?: string;
  }): Promise<{
    candidates: number;
    reindexed: number;
    skippedNoStoredText: number;
    failed: number;
  }> {
    const orgId = await resolveOrgId(input.projectId, input.orgId);
    const db = getDbIfInitialized();
    const triggerReason = input.triggerReason ?? "page_provenance_backfill";

    const { files } = await listAllProjectFiles(input.projectId);
    const failedFiles = files.filter((file) => file.indexStatus === "failed");

    let indexedPdfMissingPageIds = new Set<string>();
    if (db) {
      const rows = await db
        .select({ fileId: fileChunks.fileId })
        .from(fileChunks)
        .where(
          and(
            eq(fileChunks.projectId, input.projectId),
            eq(fileChunks.sourceType, "content"),
            isNull(fileChunks.pageNumber)
          )
        );

      const maybePdfFileIds = Array.from(new Set(rows.map((row) => row.fileId)));
      if (maybePdfFileIds.length > 0) {
        const pdfRows = await db
          .select({ id: fileRecords.id })
          .from(fileRecords)
          .where(
            and(
              eq(fileRecords.projectId, input.projectId),
              inArray(fileRecords.id, maybePdfFileIds),
              eq(fileRecords.indexStatus, "indexed")
            )
          );
        indexedPdfMissingPageIds = new Set(
          pdfRows
            .map((row) => row.id)
            .filter((id) => {
              const match = files.find((file) => file.id === id);
              return Boolean(match && /\.pdf$/i.test(match.fileName));
            })
        );
      }
    }

    const candidatesById = new Map<string, (typeof files)[number]>();
    for (const failedFile of failedFiles) {
      candidatesById.set(failedFile.id, failedFile);
    }
    for (const file of files) {
      if (indexedPdfMissingPageIds.has(file.id)) {
        candidatesById.set(file.id, file);
      }
    }

    let reindexed = 0;
    let skippedNoStoredText = 0;
    let failed = 0;

    for (const file of candidatesById.values()) {
      if (!file.normalizedTextObjectKey?.trim()) {
        skippedNoStoredText += 1;
        continue;
      }

      try {
        await this.rechunkFileFromStoredText({
          projectId: input.projectId,
          fileId: file.id,
          orgId,
          triggerReason,
        });
        reindexed += 1;
      } catch (error) {
        failed += 1;
        logger.warn("indexing-maintenance.page-provenance.backfill-file.failed", {
          projectId: input.projectId,
          fileId: file.id,
          fileName: file.fileName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info("indexing-maintenance.page-provenance.backfill.completed", {
      projectId: input.projectId,
      candidates: candidatesById.size,
      reindexed,
      skippedNoStoredText,
      failed,
    });

    return {
      candidates: candidatesById.size,
      reindexed,
      skippedNoStoredText,
      failed,
    };
  },

  async rechunkFileFromStoredText(input: RechunkFileInput): Promise<{
    runId?: UUID;
    chunkCount: number;
    summaryLength: number;
  }> {
    return withRechunkLock(input.projectId, input.fileId, async () => {
      const orgId = await resolveOrgId(input.projectId, input.orgId);
      const file = await projectService.getProjectFileById(input.projectId, input.fileId);

      if (!file) {
        throw new Error("File not found for rechunk operation.");
      }

      if (!file.normalizedTextObjectKey?.trim()) {
        throw new Error(
          "File has no normalized-text object key for replay. ObjectKey is required and must be non-empty."
        );
      }

      const runId = await recordRunStart(input);

      try {
        const stored = await documentStorageService.readNormalizedText({
          orgId,
          projectId: input.projectId,
          objectKey: file.normalizedTextObjectKey,
        });

        if (file.normalizedTextChecksum && stored.checksum !== file.normalizedTextChecksum) {
          logger.warn("indexing-maintenance.rechunk.checksum-mismatch", {
            projectId: input.projectId,
            fileId: input.fileId,
            expectedChecksum: file.normalizedTextChecksum,
            actualChecksum: stored.checksum,
            objectKey: file.normalizedTextObjectKey,
          });
        }

        const insights = await indexingPipelineService.indexNormalizedText({
          text: stored.text,
          fileName: file.fileName,
          filePath: file.filePath,
        });

        const embeddingInputs = insights.chunks.map((chunk) => chunk.chunkText);
        const embeddingResults = [] as Awaited<
          ReturnType<typeof embeddingsService.embedBatch>
        >;

        for (const batch of toBatches(embeddingInputs, EMBEDDING_BATCH_SIZE)) {
          const batchResult = await embeddingsService.embedBatch(batch);
          embeddingResults.push(...batchResult);
        }

        if (embeddingResults.length !== insights.chunks.length) {
          throw new Error(
            `Embedding batch failed: expected ${insights.chunks.length} embeddings, got ${embeddingResults.length}. ` +
              `This indicates a partial failure in embedding generation. Aborting rechunk to prevent corrupted index.`
          );
        }

        await projectService.replaceFileChunks(
          input.projectId,
          file.id,
          file.onedriveItemId || file.id,
          file.fileName,
          insights.chunks.map((chunk, index) => {
            const embedding = embeddingResults[index]!;
            return {
              chunkIndex: chunk.chunkIndex,
              chunkText: chunk.chunkText,
              tokenCount: chunk.tokenCount,
              embeddingModel: embedding.model ?? getEnv().openAiEmbeddingModel,
              embedding: embedding.vector,
              sourceType: chunk.sourceType,
              pageNumber: chunk.pageNumber,
              sectionLabel: chunk.sectionLabel,
              metadata: chunk.metadata,
              confidence: chunk.confidence,
            };
          }),
          insights.links
        );

        await projectService.updateFileIndexingResult(input.projectId, file.onedriveItemId, {
          indexStatus: "indexed",
          summary: insights.summary,
          keyTopics: insights.keyTopics,
          chunkCount: insights.chunkCount,
          docCategory: insights.classification.category,
          tags: insights.classification.tags,
          extractedFields: insights.classification
            .extractedFields as unknown as Record<string, unknown>,
          specSection: insights.classification.extractedFields.specSection,
          sheetNumber: insights.classification.extractedFields.sheetNumber,
          revision: insights.classification.extractedFields.revision,
          lastIndexed: new Date(),
        });

        await recordRunSuccess(runId);

        logger.info("indexing-maintenance.rechunk.completed", {
          projectId: input.projectId,
          fileId: input.fileId,
          runId,
          chunkCount: insights.chunkCount,
        });

        return {
          runId: runId ?? undefined,
          chunkCount: insights.chunkCount,
          summaryLength: insights.summary.length,
        };
      } catch (error) {
        await recordRunFailure(runId, error);
        throw error;
      }
    });
  },

  async runRetentionCleanup(input: {
    projectId: UUID;
    orgId?: string;
    retentionDays?: number;
  }): Promise<{
    scanned: number;
    deleted: number;
    failed: number;
  }> {
    const orgId = await resolveOrgId(input.projectId, input.orgId);
    let retentionDays = input.retentionDays ?? getEnv().documentRetentionDaysDefault;

    if (!Number.isInteger(retentionDays) || retentionDays < MIN_RETENTION_DAYS) {
      throw new Error(
        `Invalid retentionDays: ${retentionDays}. Must be an integer >= ${MIN_RETENTION_DAYS}.`
      );
    }
    if (retentionDays > MAX_RETENTION_DAYS) {
      logger.warn("indexing-maintenance.retention.days-capped", {
        projectId: input.projectId,
        requestedDays: retentionDays,
        cappedDays: MAX_RETENTION_DAYS,
      });
      retentionDays = MAX_RETENTION_DAYS;
    }

    const now = Date.now();
    const cutoffMs = now - retentionDays * 24 * 60 * 60 * 1000;

    const { files } = await listAllProjectFiles(input.projectId);
    const candidates = files.filter((file) => {
      if (!file.normalizedTextObjectKey || !file.normalizedTextStoredAt) {
        return false;
      }

      return file.normalizedTextStoredAt.getTime() < cutoffMs;
    });

    let deleted = 0;
    let failed = 0;

    for (const file of candidates) {
      try {
        await projectService.updateFileIndexingResult(input.projectId, file.onedriveItemId, {
          indexStatus: file.indexStatus,
          processingMode: "metadata_only",
          processingReason: "retention_expired",
          reducedCoverage: true,
          extractedContentPercent: 0,
          lastIndexed: file.lastIndexed,
        });

        await clearNormalizedMetadataInDb(file.id);
        await documentStorageService.deleteNormalizedText({
          orgId,
          projectId: input.projectId,
          objectKey: file.normalizedTextObjectKey as string,
        });

        deleted += 1;
      } catch (error) {
        failed += 1;
        logger.warn("indexing-maintenance.retention.file-failed", {
          projectId: input.projectId,
          fileId: file.id,
          objectKey: file.normalizedTextObjectKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info("indexing-maintenance.retention.completed", {
      projectId: input.projectId,
      retentionDays,
      scanned: files.length,
      candidates: candidates.length,
      deleted,
      failed,
    });

    return {
      scanned: files.length,
      deleted,
      failed,
    };
  },

  async runObjectReconciliation(input: {
    projectId: UUID;
    orgId?: string;
  }): Promise<{
    registeredKeys: number;
    storageKeys: number;
    orphanKeysDeleted: number;
    missingReferences: number;
  }> {
    const orgId = await resolveOrgId(input.projectId, input.orgId);
    const { files } = await listAllProjectFiles(input.projectId);

    const registeredEntries = files
      .filter((file) => Boolean(file.normalizedTextObjectKey))
      .map((file) => ({
        file,
        objectKey: file.normalizedTextObjectKey as string,
      }));

    const registeredKeys = new Set(registeredEntries.map((entry) => entry.objectKey));
    const storageKeys = new Set(
      await documentStorageService.listProjectObjectKeys({
        orgId,
        projectId: input.projectId,
      })
    );

    let orphanKeysDeleted = 0;
    for (const key of storageKeys) {
      if (registeredKeys.has(key)) {
        continue;
      }

      await documentStorageService.deleteNormalizedText({
        orgId,
        projectId: input.projectId,
        objectKey: key,
      });
      orphanKeysDeleted += 1;
    }

    let missingReferences = 0;
    for (const entry of registeredEntries) {
      if (storageKeys.has(entry.objectKey)) {
        continue;
      }

      missingReferences += 1;
      await projectService.updateFileIndexingResult(input.projectId, entry.file.onedriveItemId, {
        indexStatus: entry.file.indexStatus,
        processingMode: "metadata_only",
        processingReason: "normalized_text_missing",
        reducedCoverage: true,
        extractedContentPercent: 0,
        lastIndexed: entry.file.lastIndexed,
      });
      await clearNormalizedMetadataInDb(entry.file.id);
    }

    logger.info("indexing-maintenance.reconciliation.completed", {
      projectId: input.projectId,
      registeredKeys: registeredKeys.size,
      storageKeys: storageKeys.size,
      orphanKeysDeleted,
      missingReferences,
    });

    return {
      registeredKeys: registeredKeys.size,
      storageKeys: storageKeys.size,
      orphanKeysDeleted,
      missingReferences,
    };
  },

  async listRecentRechunkRuns(projectId: UUID, limit = 25): Promise<Array<{
    id: UUID;
    fileId: UUID;
    status: "pending" | "in_progress" | "completed" | "failed";
    triggerReason: string;
    strategyVersion: string;
    errorMessage?: string;
    startedAt?: Date;
    completedAt?: Date;
    createdAt: Date;
  }>> {
    const db = getDbIfInitialized();
    if (!db) {
      return [];
    }

    const rows = await db
      .select()
      .from(rechunkRuns)
      .where(eq(rechunkRuns.projectId, projectId))
      .orderBy(desc(rechunkRuns.createdAt))
      .limit(Math.max(1, Math.min(limit, 200)));

    return rows.map((row) => ({
      id: toUuid(row.id),
      fileId: toUuid(row.fileId),
      status: row.status,
      triggerReason: row.triggerReason,
      strategyVersion: row.strategyVersion,
      errorMessage: row.errorMessage ?? undefined,
      startedAt: row.startedAt ?? undefined,
      completedAt: row.completedAt ?? undefined,
      createdAt: row.createdAt,
    }));
  },
};
