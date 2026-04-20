import type { IndexingJobPayload, IndexingWorkerRuntime } from "../lib/queue";
import { createIndexingWorker } from "../lib/queue";
import { logger } from "../lib/logger";
import { indexingService } from "./indexing.service";

async function processIndexingJob(payload: IndexingJobPayload): Promise<void> {
  logger.info("indexing.job.processing", {
    projectId: payload.projectId,
    idempotencyKey: payload.idempotencyKey,
    requestedAt: payload.requestedAt,
  });

  await indexingService.processProjectIndexing(payload.projectId, payload.requester);

  logger.info("indexing.job.completed", {
    projectId: payload.projectId,
    indexedByWorker: true,
  });
}

export function startIndexingWorker(): IndexingWorkerRuntime | null {
  const runtime = createIndexingWorker(async (job) => {
    await processIndexingJob(job.data);
  });

  if (!runtime) {
    logger.warn("indexing.worker.disabled", {
      message: "REDIS_URL is not configured. Indexing worker startup skipped.",
    });
    return null;
  }

  logger.info("indexing.worker.started", {
    queueName: runtime.queueName,
    deadLetterQueue: runtime.deadLetterQueue,
    concurrency: runtime.concurrency,
  });

  return runtime;
}
