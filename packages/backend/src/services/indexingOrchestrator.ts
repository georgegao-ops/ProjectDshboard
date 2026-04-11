import { Queue } from 'bullmq';
import { OneDriveService } from './oneDriveService';
import { IndexingQueueWorker } from './indexingQueueWorker';
import { db } from '../db/client';
import { syncJobs, fileRecords, projects } from '../db/schema';
import { eq } from 'drizzle-orm';

export class IndexingOrchestrator {
  /**
   * Start a complete indexing sync for a project
   * Step 1: Trigger OneDrive delta sync
   * Step 2: Create/update file records
   * Step 3: Queue document processing jobs
   */
  static async startIndexingSync(
    projectId: string,
    accessToken: string
  ): Promise<{
    syncJobId: string;
    filesQueued: number;
    syncStatus: string;
  }> {
    try {
      const indexQueue = IndexingQueueWorker.getQueue();

      // Trigger OneDrive sync and queue jobs
      const { syncJobId, filesQueued } = await OneDriveService.triggerSync(
        projectId,
        accessToken,
        indexQueue
      );

      return {
        syncJobId,
        filesQueued,
        syncStatus: 'queued',
      };
    } catch (error) {
      console.error('Failed to start indexing sync:', error);
      throw error;
    }
  }

  /**
   * Get the status of a sync operation
   */
  static async getSyncStatus(syncJobId: string) {
    const syncJob = await OneDriveService.getSyncJobStatus(syncJobId);
    return {
      id: syncJob.id,
      projectId: syncJob.projectId,
      jobType: syncJob.jobType,
      status: syncJob.status,
      filesProcessed: syncJob.filesProcessed,
      filesTotal: syncJob.filesTotal,
      progress: syncJob.filesTotal
        ? Math.round((syncJob.filesProcessed || 0) / syncJob.filesTotal * 100)
        : 0,
      startedAt: syncJob.startedAt,
      completedAt: syncJob.completedAt,
      errorMessage: syncJob.errorMessage,
    };
  }

  /**
   * Get project indexing statistics
   */
  static async getProjectIndexingStats(projectId: string) {
    // Get total files
    const allFiles = await db
      .select({ status: fileRecords.indexStatus })
      .from(fileRecords)
      .where(eq(fileRecords.projectId, projectId));

    const stats = {
      totalFiles: allFiles.length,
      indexed: allFiles.filter((f) => f.status === 'indexed').length,
      pending: allFiles.filter((f) => f.status === 'pending').length,
      processing: allFiles.filter((f) => f.status === 'processing').length,
      failed: allFiles.filter((f) => f.status === 'failed').length,
      indexingPercentage: allFiles.length
        ? Math.round(
            (allFiles.filter((f) => f.status === 'indexed').length / allFiles.length) * 100
          )
        : 0,
    };

    // Get queue stats
    const queueStats = await IndexingQueueWorker.getQueueStats();

    return {
      files: stats,
      queue: queueStats,
    };
  }

  /**
   * Reindex a specific file
   */
  static async reindexFile(fileId: string) {
    try {
      // Get file record
      const file = await db
        .select()
        .from(fileRecords)
        .where(eq(fileRecords.id, fileId))
        .limit(1);

      if (!file || file.length === 0) {
        throw new Error(`File not found: ${fileId}`);
      }

      // Reset index status to pending
      await db
        .update(fileRecords)
        .set({
          indexStatus: 'pending',
          lastIndexed: null,
          chunkCount: 0,
          updatedAt: new Date(),
        })
        .where(eq(fileRecords.id, fileId));

      // Queue reindexing job
      const indexQueue = IndexingQueueWorker.getQueue();
      await indexQueue.add(
        'process-document',
        {
          fileId,
          onedriveItemId: file[0].onedriveItemId,
        },
        {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
        }
      );

      return { success: true, fileId };
    } catch (error) {
      console.error('Failed to reindex file:', error);
      throw error;
    }
  }

  /**
   * Reindex all files in a project
   */
  static async reindexProject(projectId: string) {
    try {
      // Get all files in project
      const files = await db
        .select()
        .from(fileRecords)
        .where(eq(fileRecords.projectId, projectId));

      if (files.length === 0) {
        return { success: true, filesQueued: 0 };
      }

      // Create batch reindex job
      const syncJob = await db
        .insert(syncJobs)
        .values({
          projectId,
          jobType: 'reindex',
          status: 'processing',
          filesTotal: files.length,
          startedAt: new Date(),
        })
        .returning();

      const syncJobId = syncJob[0].id;

      // Queue reindexing for each file
      const indexQueue = IndexingQueueWorker.getQueue();
      for (const file of files) {
        await indexQueue.add(
          'process-document',
          {
            fileId: file.id,
            onedriveItemId: file.onedriveItemId,
            syncJobId,
          },
          {
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 2000,
            },
          }
        );
      }

      // Reset index status for all files
      await db
        .update(fileRecords)
        .set({
          indexStatus: 'pending',
          lastIndexed: null,
          chunkCount: 0,
          updatedAt: new Date(),
        })
        .where(eq(fileRecords.projectId, projectId));

      return {
        success: true,
        syncJobId,
        filesQueued: files.length,
      };
    } catch (error) {
      console.error('Failed to reindex project:', error);
      throw error;
    }
  }

  /**
   * Get failed indexing jobs
   */
  static async getFailedIndexingJobs(projectId: string) {
    const failedFiles = await db
      .select()
      .from(fileRecords)
      .where(
        eq(fileRecords.projectId, projectId) && eq(fileRecords.indexStatus, 'failed')
      );

    return failedFiles.map((file) => ({
      fileId: file.id,
      fileName: file.fileName,
      errorDetails: file.summary, // Contains error message if processing failed
    }));
  }
}
