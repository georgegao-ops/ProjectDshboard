import type { UUID } from "@contractor/shared";
import { logger } from "../lib/logger";
import { INDEXING_QUEUE_POLICY } from "../lib/queue";
import { embeddingsService } from "./embeddings.service";
import { indexingPipelineService } from "./indexing-pipeline.service";
import { onedriveService } from "./onedrive.service";
import { projectService } from "./project.service";
import type { RequestUserContext } from "./service-types";
import { rm } from "node:fs/promises";

const INDEXING_BATCH_SIZE = 3;
const FILE_INDEXING_RETRY_LIMIT = 2;

function toBatches<T>(input: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < input.length; index += batchSize) {
    batches.push(input.slice(index, index + batchSize));
  }
  return batches;
}

export const indexingService = {
  getQueuePolicy() {
    return INDEXING_QUEUE_POLICY;
  },

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
    if (!requester) {
      logger.warn("indexing.project.skipped", {
        projectId,
        message: "Missing requester context for indexing job.",
      });
      return;
    }

    const filesResponse = await projectService.listProjectFiles(projectId, {
      page: 1,
      pageSize: 500,
    });

    const pendingFiles = filesResponse.files.filter((file) => file.indexStatus === "pending");
    const batches = toBatches(pendingFiles, INDEXING_BATCH_SIZE);

    for (const batch of batches) {
      await Promise.all(
        batch.map(async (file) => {
          await projectService.updateFileIndexingResult(projectId, file.onedriveItemId, {
            indexStatus: "processing",
          });

          let tempFilePath: string | undefined;

          try {
            const downloaded = await onedriveService.downloadFileToTemp(
              requester,
              file.onedriveItemId,
              file.fileName
            );
            tempFilePath = downloaded.tempFilePath;

            let attempt = 0;
            let insights: Awaited<ReturnType<typeof indexingPipelineService.indexTempFile>> | undefined;

            while (attempt < FILE_INDEXING_RETRY_LIMIT && !insights) {
              attempt += 1;
              try {
                insights = await indexingPipelineService.indexTempFile({
                  tempFilePath: downloaded.tempFilePath,
                  mimeType: file.mimeType,
                });
              } catch (attemptError) {
                if (attempt >= FILE_INDEXING_RETRY_LIMIT) {
                  throw attemptError;
                }
              }
            }

            if (!insights) {
              throw new Error("Indexing pipeline produced no insights.");
            }

            const embeddingResults = await embeddingsService.embedBatch(
              insights.chunks.map((chunk) => chunk.chunkText)
            );

            await projectService.replaceFileChunks(
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
              })),
              insights.links
            );

            await projectService.updateFileIndexingResult(projectId, file.onedriveItemId, {
              indexStatus: "indexed",
              summary: insights.summary,
              keyTopics: insights.keyTopics,
              chunkCount: insights.chunkCount,
              lastIndexed: new Date(),
            });
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Indexing failed.";
            await projectService.updateFileIndexingResult(projectId, file.onedriveItemId, {
              indexStatus: "failed",
              summary: `Indexing failed: ${errorMessage}`,
              keyTopics: [],
              chunkCount: 0,
              lastIndexed: new Date(),
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
    pending: number;
    processing: number;
    indexed: number;
    failed: number;
    completionPercent: number;
  }> {
    const filesResponse = await projectService.listProjectFiles(projectId, {
      page: 1,
      pageSize: 1000,
    });

    const total = filesResponse.total;
    const pending = filesResponse.files.filter((file) => file.indexStatus === "pending").length;
    const processing = filesResponse.files.filter((file) => file.indexStatus === "processing").length;
    const indexed = filesResponse.files.filter((file) => file.indexStatus === "indexed").length;
    const failed = filesResponse.files.filter((file) => file.indexStatus === "failed").length;

    const completionPercent = total === 0 ? 0 : Math.round(((indexed + failed) / total) * 100);

    return {
      total,
      pending,
      processing,
      indexed,
      failed,
      completionPercent,
    };
  },
};
