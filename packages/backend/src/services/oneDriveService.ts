import axios from 'axios';
import { Queue } from 'bullmq';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/client';
import {
  fileRecords,
  projects,
  syncJobs,
  indexingJobs,
} from '../db/schema';

export interface OneDriveToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface OneDriveConnectionStatus {
  connected: boolean;
  lastSyncedAt?: string;
  nextSyncAt?: string;
  syncStatus: 'idle' | 'syncing' | 'error';
  lastErrorMessage?: string;
}

export interface OneDriveFile {
  id: string;
  name: string;
  type: 'file' | 'folder';
  path: string;
  size?: number;
  modifiedAt: string;
  mimeType?: string;
  eTag?: string;
}

export interface DeltaChange {
  type: 'added' | 'modified' | 'deleted';
  file: OneDriveFile;
}

export class OneDriveService {
  private static GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0';

  /**
   * Initiate OAuth flow and store tokens
   */
  static async connectOneDrive(
    userId: string,
    authCode: string
  ): Promise<OneDriveToken> {
    try {
      const response = await axios.post(
        'https://login.microsoftonline.com/common/oauth2/v2.0/token',
        {
          client_id: process.env.MICROSOFT_CLIENT_ID,
          client_secret: process.env.MICROSOFT_CLIENT_SECRET,
          code: authCode,
          redirect_uri: process.env.REDIRECT_URI,
          grant_type: 'authorization_code',
          scope: 'Files.Read.All offline_access',
        }
      );

      const token: OneDriveToken = {
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token,
        expiresAt: Date.now() + response.data.expires_in * 1000,
      };

      // TODO: Store token in database with encryption
      return token;
    } catch (error) {
      throw new Error('Failed to connect OneDrive');
    }
  }

  /**
   * Get OneDrive connection status
   */
  static async getConnectionStatus(userId: string): Promise<OneDriveConnectionStatus> {
    try {
      // TODO: Fetch token from database
      // TODO: Validate token and refresh if needed
      return {
        connected: true,
        syncStatus: 'idle',
        lastSyncedAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        connected: false,
        syncStatus: 'error',
        lastErrorMessage: 'Failed to fetch connection status',
      };
    }
  }

  /**
   * Perform delta query on OneDrive folder
   * Returns only changed/deleted files since last sync
   */
  static async getDeltaChanges(
    accessToken: string,
    folderId: string
  ): Promise<DeltaChange[]> {
    try {
      // Use /delta API to get only changes
      const response = await axios.get(
        `${this.GRAPH_API_BASE}/me/drive/items/${folderId}/delta`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      const changes: DeltaChange[] = [];

      for (const item of response.data.value) {
        if (item.deleted) {
          // File was deleted
          changes.push({
            type: 'deleted',
            file: {
              id: item.id,
              name: item.name,
              type: 'file',
              path: '',
              eTag: item.eTag,
            },
          });
        } else if (item.file) {
          // File exists (added or modified)
          changes.push({
            type: 'added',
            file: {
              id: item.id,
              name: item.name,
              type: 'file',
              path: item.parentReference?.path || '/',
              size: item.size,
              modifiedAt: item.lastModifiedDateTime,
              mimeType: item.file.mimeType,
              eTag: item.eTag,
            },
          });
        }
      }

      return changes;
    } catch (error) {
      throw new Error('Failed to get delta changes from OneDrive');
    }
  }

  /**
   * Trigger manual sync for a project
   * Step 1: Call OneDrive delta API
   * Step 2: Create/update file records
   * Step 3: Queue indexing jobs
   */
  static async triggerSync(
    projectId: string,
    accessToken: string,
    indexQueue: Queue
  ): Promise<{ syncJobId: string; filesQueued: number }> {
    try {
      // Get project details
      const projectData = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
      if (!projectData || projectData.length === 0) {
        throw new Error(`Project not found: ${projectId}`);
      }

      const project = projectData[0];
      if (!project.onedriveFolderId) {
        throw new Error(`Project has no OneDrive folder configured`);
      }

      // Create sync job record
      const syncJob = await db
        .insert(syncJobs)
        .values({
          projectId,
          jobType: 'sync',
          status: 'processing',
          startedAt: new Date(),
        })
        .returning();

      const syncJobId = syncJob[0].id;

      // Get delta changes
      const changes = await this.getDeltaChanges(accessToken, project.onedriveFolderId);

      let filesQueued = 0;

      // Process each change
      for (const change of changes) {
        if (change.type === 'deleted') {
          // Soft-delete file record and remove vectors
          await db
            .update(fileRecords)
            .set({
              updatedAt: new Date(),
              indexStatus: 'failed', // Mark as failed since vectors should be removed
            })
            .where(eq(fileRecords.onedriveItemId, change.file.id));
          // TODO: Remove vectors from Pinecone
        } else if (change.type === 'added') {
          // Create or update file record
          const existingFile = await db
            .select()
            .from(fileRecords)
            .where(eq(fileRecords.onedriveItemId, change.file.id))
            .limit(1);

          let fileId: string;

          if (existingFile && existingFile.length > 0) {
            // Check if file was modified (etag changed)
            const existingEtag = existingFile[0].onedriveEtag;
            if (existingEtag === change.file.eTag) {
              // File not actually changed, skip
              continue;
            }

            // Update existing file record
            fileId = existingFile[0].id;
            await db
              .update(fileRecords)
              .set({
                onedriveEtag: change.file.eTag,
                lastSynced: new Date(),
                indexStatus: 'pending',
                fileSize: change.file.size ? BigInt(change.file.size) : null,
                updatedAt: new Date(),
              })
              .where(eq(fileRecords.id, fileId));
          } else {
            // Create new file record
            const newFile = await db
              .insert(fileRecords)
              .values({
                projectId,
                onedriveItemId: change.file.id,
                fileName: change.file.name,
                filePath: change.file.path,
                fileType: this.getFileType(change.file.name),
                mimeType: change.file.mimeType,
                fileSize: change.file.size ? BigInt(change.file.size) : null,
                onedriveEtag: change.file.eTag,
                lastSynced: new Date(),
                indexStatus: 'pending',
              })
              .returning();

            fileId = newFile[0].id;
          }

          // Create indexing job
          const indexJob = await db
            .insert(indexingJobs)
            .values({
              fileId,
              syncJobId,
              status: 'pending',
            })
            .returning();

          // Queue indexing job
          await indexQueue.add(
            'process-document',
            {
              fileId,
              indexingJobId: indexJob[0].id,
              onedriveItemId: change.file.id,
            },
            {
              attempts: 3,
              backoff: {
                type: 'exponential',
                delay: 2000,
              },
            }
          );

          filesQueued++;
        }
      }

      // Update sync job
      await db
        .update(syncJobs)
        .set({
          status: 'completed',
          filesTotal: changes.length,
          filesProcessed: filesQueued,
          completedAt: new Date(),
        })
        .where(eq(syncJobs.id, syncJobId));

      return { syncJobId, filesQueued };
    } catch (error) {
      console.error('Sync failed:', error);
      throw new Error(`Sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get sync job status
   */
  static async getSyncJobStatus(syncJobId: string) {
    const job = await db
      .select()
      .from(syncJobs)
      .where(eq(syncJobs.id, syncJobId))
      .limit(1);

    if (!job || job.length === 0) {
      throw new Error(`Sync job not found: ${syncJobId}`);
    }

    return job[0];
  }

  /**
   * Browse OneDrive folders and files
   */
  static async browseFolders(
    userId: string,
    accessToken: string,
    folderId: string = 'root'
  ): Promise<OneDriveFile[]> {
    try {
      const response = await axios.get(
        `${this.GRAPH_API_BASE}/me/drive/items/${folderId}/children`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      return response.data.value.map((item: any) => ({
        id: item.id,
        name: item.name,
        type: item.folder ? 'folder' : 'file',
        path: item.parentReference?.path || '/',
        size: item.size,
        modifiedAt: item.lastModifiedDateTime,
        mimeType: item.file?.mimeType,
        eTag: item.eTag,
      }));
    } catch (error) {
      throw new Error('Failed to browse folders');
    }
  }

  /**
   * Download file from OneDrive
   */
  static async downloadFile(
    accessToken: string,
    itemId: string,
    localPath: string
  ): Promise<void> {
    try {
      const response = await axios.get(
        `${this.GRAPH_API_BASE}/me/drive/items/${itemId}/content`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
          responseType: 'arraybuffer',
        }
      );

      // TODO: Write file to localPath
      console.log(`Downloaded file to ${localPath}`);
    } catch (error) {
      throw new Error('Failed to download file from OneDrive');
    }
  }

  /**
   * Refresh access token
   */
  static async refreshToken(userId: string): Promise<OneDriveToken> {
    try {
      // TODO: Get refresh token from database
      const refreshToken = 'mock-refresh-token';

      const response = await axios.post(
        'https://login.microsoftonline.com/common/oauth2/v2.0/token',
        {
          client_id: process.env.MICROSOFT_CLIENT_ID,
          client_secret: process.env.MICROSOFT_CLIENT_SECRET,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
          scope: 'Files.Read.All offline_access',
        }
      );

      const token: OneDriveToken = {
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token,
        expiresAt: Date.now() + response.data.expires_in * 1000,
      };

      // TODO: Update token in database
      return token;
    } catch (error) {
      throw new Error('Failed to refresh token');
    }
  }

  /**
   * Helper: Determine file type from filename
   */
  private static getFileType(fileName: string): string {
    const ext = fileName.split('.').pop()?.toLowerCase() || '';
    const typeMap: { [key: string]: string } = {
      pdf: 'pdf',
      doc: 'docx',
      docx: 'docx',
      jpg: 'image',
      jpeg: 'image',
      png: 'image',
      dwg: 'drawing',
      xlsx: 'xlsx',
      xls: 'xlsx',
      txt: 'txt',
    };
    return typeMap[ext] || 'unknown';
  }
}
