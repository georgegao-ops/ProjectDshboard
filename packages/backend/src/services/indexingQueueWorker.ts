import { Worker, Queue } from 'bullmq';
import redis from 'redis';
import { db } from '../db/client';
import { fileRecords, indexingJobs } from '../db/schema';
import { eq } from 'drizzle-orm';
import { DocumentProcessingService } from './documentProcessingService';

export class IndexingQueueWorker {
  private static worker: Worker | null = null;
  private static queue: Queue | null = null;

  /**
   * Initialize the indexing queue and worker
   */
  static async initialize(redisUrl?: string) {
    const connectionOptions = redisUrl
      ? { url: redisUrl }
      : { host: 'localhost', port: 6379 };

    // Create queue
    this.queue = new Queue('indexing', { connection: connectionOptions });

    // Create worker
    this.worker = new Worker('indexing', this.processJob.bind(this), {
      connection: connectionOptions,
      concurrency: 3, // Process up to 3 documents in parallel
    });

    // Event handlers
    this.worker.on('completed', (job) => {
      console.log(`Job ${job.id} completed successfully`);
    });

    this.worker.on('failed', (job, error) => {
      console.error(`Job ${job?.id} failed:`, error);
    });

    this.worker.on('error', (error) => {
      console.error('Worker error:', error);
    });

    console.log('Indexing queue worker initialized');
    return this.queue;
  }

  /**
   * Process a single indexing job
   */
  private static async processJob(job: any) {
    const { fileId, indexingJobId, onedriveItemId } = job.data;

    console.log(`Processing indexing job for file: ${fileId}`);

    try {
      // Get file record
      const fileRecord = await db
        .select()
        .from(fileRecords)
        .where(eq(fileRecords.id, fileId))
        .limit(1);

      if (!fileRecord || fileRecord.length === 0) {
        throw new Error(`File record not found: ${fileId}`);
      }

      const file = fileRecord[0];

      // TODO: Download file from OneDrive to temporary storage
      // const tempPath = await downloadFromOneDrive(onedriveItemId);
      const tempPath = `/tmp/${file.fileName}`;

      // Process document
      await DocumentProcessingService.processDocument(
        fileId,
        tempPath,
        file.fileType || 'unknown',
        file.fileName,
        indexingJobId
      );

      // TODO: After classification, chunk text and generate embeddings
      // This will be the next step in the pipeline

      // Update indexing job status
      await db
        .update(indexingJobs)
        .set({
          status: 'completed',
          processedAt: new Date(),
        })
        .where(eq(indexingJobs.id, indexingJobId));

      // Clean up temp file
      // TODO: Delete tempPath

      return { success: true, fileId };
    } catch (error) {
      console.error(`Error processing file ${fileId}:`, error);

      // Update job with error
      await db
        .update(indexingJobs)
        .set({
          status: 'failed',
          errorMessage: error instanceof Error ? error.message : 'Unknown error',
          retriesCount: (job.attemptsMade || 0) + 1,
        })
        .where(eq(indexingJobs.id, indexingJobId));

      throw error; // Re-throw so BullMQ can handle retries
    }
  }

  /**
   * Get the indexing queue (for adding jobs)
   */
  static getQueue(): Queue {
    if (!this.queue) {
      throw new Error('Indexing queue not initialized');
    }
    return this.queue;
  }

  /**
   * Close the worker and queue
   */
  static async close() {
    if (this.worker) {
      await this.worker.close();
    }
    if (this.queue) {
      await this.queue.close();
    }
    console.log('Indexing queue worker closed');
  }

  /**
   * Get job status
   */
  static async getJobStatus(jobId: string) {
    const queue = this.getQueue();
    const job = await queue.getJob(jobId);
    return job;
  }

  /**
   * Get queue statistics
   */
  static async getQueueStats() {
    const queue = this.getQueue();
    return {
      waiting: await queue.getWaitingCount(),
      active: await queue.getActiveCount(),
      completed: await queue.getCompletedCount(),
      failed: await queue.getFailedCount(),
    };
  }
}
