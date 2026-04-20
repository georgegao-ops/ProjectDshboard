import {
  Queue,
  Worker,
  type JobsOptions,
  type Processor,
  type QueueOptions,
  type WorkerOptions,
} from "bullmq";
import type { UUID } from "@contractor/shared";
import { getEnv } from "../config/env";
import { logger } from "./logger";

export const INDEXING_QUEUE_POLICY = {
  attempts: 3,
  backoffMs: 5000,
  deadLetterQueue: "indexing-dead-letter",
  concurrency: 2,
  idempotencyKeyPrefix: "indexing",
} as const;

export const INDEXING_QUEUE_NAME = "indexing";
export const INDEXING_DEAD_LETTER_JOB_NAME = "indexing.dead-letter";

export interface IndexingJobPayload {
  projectId: UUID;
  idempotencyKey: string;
  requestedAt: string;
  requester?: {
    id: string;
    email: string;
    name: string;
    orgId: string;
    orgName: string;
    role: "super" | "admin" | "pm" | "member";
  };
}

export interface EnqueueIndexingJobResult {
  jobId: string;
  mode: "redis" | "memory";
}

export interface IndexingQueueClient {
  enqueue(payload: IndexingJobPayload, options: JobsOptions): Promise<EnqueueIndexingJobResult>;
}

export interface IndexingWorkerRuntime {
  queueName: string;
  deadLetterQueue: string;
  concurrency: number;
  close(): Promise<void>;
}

function createQueueOptions(connectionUrl: string): QueueOptions {
  return {
    connection: {
      url: connectionUrl,
    },
  };
}

class BullMqIndexingQueueClient implements IndexingQueueClient {
  private queue: Queue<IndexingJobPayload>;

  constructor(connectionUrl: string) {
    this.queue = new Queue<IndexingJobPayload>(
      INDEXING_QUEUE_NAME,
      createQueueOptions(connectionUrl)
    );
  }

  async enqueue(
    payload: IndexingJobPayload,
    options: JobsOptions
  ): Promise<EnqueueIndexingJobResult> {
    const job = await this.queue.add("index-project", payload, options);

    return {
      jobId: String(job.id),
      mode: "redis",
    };
  }
}

class InMemoryIndexingQueueClient implements IndexingQueueClient {
  async enqueue(
    payload: IndexingJobPayload,
    options: JobsOptions
  ): Promise<EnqueueIndexingJobResult> {
    const jobId = String(options.jobId ?? `memory-${payload.projectId}-${Date.now()}`);

    logger.warn("indexing.queue.memory_fallback", {
      jobId,
      projectId: payload.projectId,
      idempotencyKey: payload.idempotencyKey,
    });

    return {
      jobId,
      mode: "memory",
    };
  }
}

export function buildIndexingIdempotencyKey(projectId: UUID): string {
  return `${INDEXING_QUEUE_POLICY.idempotencyKeyPrefix}:${projectId}`;
}

export function buildIndexingJobOptions(projectId: UUID): JobsOptions {
  return {
    jobId: buildIndexingIdempotencyKey(projectId),
    attempts: INDEXING_QUEUE_POLICY.attempts,
    backoff: {
      type: "fixed",
      delay: INDEXING_QUEUE_POLICY.backoffMs,
    },
    removeOnComplete: 1000,
    removeOnFail: false,
  };
}

export function createIndexingQueueClient(redisUrl?: string): IndexingQueueClient {
  if (!redisUrl) {
    return new InMemoryIndexingQueueClient();
  }

  return new BullMqIndexingQueueClient(redisUrl);
}

export function getIndexingQueueClient(): IndexingQueueClient {
  return createIndexingQueueClient(getEnv().redisUrl);
}

export function createIndexingWorker(
  processor: Processor<IndexingJobPayload>,
  redisUrl = getEnv().redisUrl
): IndexingWorkerRuntime | null {
  if (!redisUrl) {
    return null;
  }

  const workerOptions: WorkerOptions = {
    connection: {
      url: redisUrl,
    },
    concurrency: INDEXING_QUEUE_POLICY.concurrency,
  };

  const worker = new Worker<IndexingJobPayload>(
    INDEXING_QUEUE_NAME,
    processor,
    workerOptions
  );

  const deadLetterQueue = new Queue<Record<string, unknown>>(
    INDEXING_QUEUE_POLICY.deadLetterQueue,
    createQueueOptions(redisUrl)
  );

  worker.on("failed", async (job, error) => {
    if (!job) {
      return;
    }

    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) {
      return;
    }

    await deadLetterQueue.add(
      INDEXING_DEAD_LETTER_JOB_NAME,
      {
        originalJobId: job.id,
        payload: job.data,
        attemptsMade: job.attemptsMade,
        failedReason: error.message,
        failedAt: new Date().toISOString(),
      },
      {
        removeOnComplete: 1000,
      }
    );

    logger.error("indexing.job.dead_lettered", error, {
      jobId: String(job.id),
      projectId: job.data.projectId,
      attemptsMade: job.attemptsMade,
      deadLetterQueue: INDEXING_QUEUE_POLICY.deadLetterQueue,
    });
  });

  return {
    queueName: INDEXING_QUEUE_NAME,
    deadLetterQueue: INDEXING_QUEUE_POLICY.deadLetterQueue,
    concurrency: INDEXING_QUEUE_POLICY.concurrency,
    async close(): Promise<void> {
      await Promise.all([
        worker.close(),
        deadLetterQueue.close(),
      ]);
    },
  };
}
