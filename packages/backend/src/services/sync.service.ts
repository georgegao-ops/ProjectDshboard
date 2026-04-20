import { randomUUID } from "node:crypto";
import type { FileRecord, OneDriveSyncResponse, UUID } from "@contractor/shared";
import {
  buildIndexingIdempotencyKey,
  buildIndexingJobOptions,
  getIndexingQueueClient,
  type IndexingQueueClient,
} from "../lib/queue";
import { indexingService } from "./indexing.service";
import { onedriveService } from "./onedrive.service";
import { projectService } from "./project.service";
import type { RequestUserContext } from "./service-types";
import { toUuid } from "./service-types";

const MAX_SUPPORTED_FILE_SIZE_BYTES = 25 * 1024 * 1024;

const SUPPORTED_MIME_TYPES = new Set<string>([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

interface SyncProgressState {
  inProgress: boolean;
  downloadedFileCount: number;
  completionPercent: number;
  scannedFileCount?: number;
  supportedFileCount?: number;
  unsupportedFileCount?: number;
  message?: string;
  startedAt: Date;
  finishedAt?: Date;
}

const syncProgressByProject = new Map<string, SyncProgressState>();

function setSyncProgress(projectId: UUID, progress: SyncProgressState): void {
  syncProgressByProject.set(projectId, progress);
}

function updateDownloadedCount(projectId: UUID, downloadedFileCount: number): void {
  const current = syncProgressByProject.get(projectId);
  if (!current) {
    return;
  }

  // Keep filling until completion for a clear sense of activity.
  const completionPercent = Math.min(95, Math.max(current.completionPercent, downloadedFileCount * 8));
  syncProgressByProject.set(projectId, {
    ...current,
    downloadedFileCount,
    completionPercent,
  });
}

function isSupportedMimeType(mimeType?: string): boolean {
  return Boolean(mimeType && SUPPORTED_MIME_TYPES.has(mimeType));
}

function inferMimeTypeFromName(fileName: string): string | undefined {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pdf")) {
    return "application/pdf";
  }

  if (lower.endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }

  return undefined;
}

function buildFileRecord(
  projectId: UUID,
  file: {
    id: string;
    name: string;
    path: string;
    mimeType?: string;
    size?: number;
    eTag?: string;
    lastModified?: Date;
  }
): FileRecord {
  const mimeType = file.mimeType ?? inferMimeTypeFromName(file.name);
  const isSupportedType = isSupportedMimeType(mimeType);
  const isSupportedSize = typeof file.size !== "number" || file.size <= MAX_SUPPORTED_FILE_SIZE_BYTES;

  const tags: string[] = [];
  if (!isSupportedType) {
    tags.push("unsupported_type");
  }
  if (!isSupportedSize) {
    tags.push("oversize");
  }

  const unsupportedReason = !isSupportedType
    ? "Unsupported file type for MVP. Only PDF and DOCX are currently processed."
    : !isSupportedSize
      ? `File exceeds max supported size (${MAX_SUPPORTED_FILE_SIZE_BYTES} bytes).`
      : undefined;

  return {
    id: toUuid(randomUUID()),
    projectId,
    onedriveItemId: file.id,
    fileName: file.name,
    filePath: file.path,
    fileType: mimeType,
    fileSize: file.size,
    mimeType,
    summary: unsupportedReason,
    tags,
    onedriveEtag: file.eTag,
    lastSynced: new Date(),
    indexStatus: isSupportedType && isSupportedSize ? "pending" : "failed",
    chunkCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

export const syncService = {
  getProjectSyncProgress(projectId: UUID): {
    inProgress: boolean;
    downloadedFileCount: number;
    completionPercent: number;
    scannedFileCount?: number;
    supportedFileCount?: number;
    unsupportedFileCount?: number;
    message?: string;
    startedAt?: Date;
    finishedAt?: Date;
  } {
    const current = syncProgressByProject.get(projectId);
    if (!current) {
      return {
        inProgress: false,
        downloadedFileCount: 0,
        completionPercent: 0,
      };
    }

    return {
      inProgress: current.inProgress,
      downloadedFileCount: current.downloadedFileCount,
      completionPercent: current.completionPercent,
      scannedFileCount: current.scannedFileCount,
      supportedFileCount: current.supportedFileCount,
      unsupportedFileCount: current.unsupportedFileCount,
      message: current.message,
      startedAt: current.startedAt,
      finishedAt: current.finishedAt,
    };
  },

  async queueProjectSync(
    projectId: UUID,
    requester: RequestUserContext | undefined,
    queueClient: IndexingQueueClient = getIndexingQueueClient()
  ): Promise<OneDriveSyncResponse> {
    const idempotencyKey = buildIndexingIdempotencyKey(projectId);
    const result = await queueClient.enqueue(
      {
        projectId,
        idempotencyKey,
        requestedAt: new Date().toISOString(),
        requester,
      },
      buildIndexingJobOptions(projectId)
    );

    indexingService.logJobQueued(result.jobId, projectId, idempotencyKey);

    return {
      syncStarted: true,
      message:
        result.mode === "redis"
          ? "Sync queued"
          : "Sync recorded using in-memory fallback queue",
      jobId: result.jobId,
    };
  },

  async syncProjectMetadata(
    projectId: UUID,
    user: RequestUserContext | undefined,
    orgId?: string,
    queueClient: IndexingQueueClient = getIndexingQueueClient()
  ): Promise<OneDriveSyncResponse> {
    const startedAt = new Date();
    const project = await projectService.getProjectOrThrow(projectId, orgId);

    setSyncProgress(projectId, {
      inProgress: true,
      downloadedFileCount: 0,
      completionPercent: 3,
      message: "Sync started. Discovering files in selected folder.",
      startedAt,
    });

    if (!project.onedriveFolderId) {
      setSyncProgress(projectId, {
        inProgress: false,
        downloadedFileCount: 0,
        completionPercent: 0,
        message: "Project has no OneDrive folder configured",
        startedAt,
        finishedAt: new Date(),
      });
      return {
        syncStarted: false,
        message: "Project has no OneDrive folder configured",
      };
    }

    try {
      const files = await onedriveService.listFiles(
        user,
        project.onedriveFolderId,
        ({ downloadedFileCount }) => {
          updateDownloadedCount(projectId, downloadedFileCount);
        }
      );
      const records = files.map((file) => buildFileRecord(projectId, file));
      await projectService.setProjectFiles(projectId, records);

      const supportedFileCount = records.filter((file) => file.indexStatus === "pending").length;
      const unsupportedFileCount = records.length - supportedFileCount;
      const finishedAt = new Date();

      await projectService.recordSyncRun(projectId, {
        files: records,
        scannedFileCount: records.length,
        supportedFileCount,
        unsupportedFileCount,
        status: "success",
        startedAt,
        finishedAt,
      });

      const completedMessage =
        supportedFileCount === 0
          ? `Sync completed. 0 supported files queued for indexing, ${unsupportedFileCount} unsupported files marked.`
          : `Sync completed. ${supportedFileCount} supported files queued for background indexing, ${unsupportedFileCount} unsupported files marked.`;

      setSyncProgress(projectId, {
        inProgress: false,
        downloadedFileCount: records.length,
        completionPercent: 100,
        scannedFileCount: records.length,
        supportedFileCount,
        unsupportedFileCount,
        message: completedMessage,
        startedAt,
        finishedAt,
      });

      if (supportedFileCount === 0) {
        return {
          syncStarted: false,
          message: completedMessage,
          scannedFileCount: records.length,
          supportedFileCount,
          unsupportedFileCount,
          lastSyncedAt: finishedAt,
        };
      }

      const queueResult = await this.queueProjectSync(projectId, user, queueClient);

      return {
        ...queueResult,
        message: completedMessage,
        scannedFileCount: records.length,
        supportedFileCount,
        unsupportedFileCount,
        lastSyncedAt: finishedAt,
      };
    } catch (error) {
      const finishedAt = new Date();
      const failureMessage =
        error instanceof Error
          ? `Sync failed: ${error.message}`
          : "Sync failed due to an unexpected error.";

      setSyncProgress(projectId, {
        inProgress: false,
        downloadedFileCount: syncProgressByProject.get(projectId)?.downloadedFileCount ?? 0,
        completionPercent: 100,
        scannedFileCount: 0,
        supportedFileCount: 0,
        unsupportedFileCount: 0,
        message: failureMessage,
        startedAt,
        finishedAt,
      });

      await projectService.recordSyncRun(projectId, {
        files: [],
        scannedFileCount: 0,
        supportedFileCount: 0,
        unsupportedFileCount: 0,
        status: "failed",
        errorMessage: failureMessage,
        startedAt,
        finishedAt,
      });

      return {
        syncStarted: false,
        message: failureMessage,
        scannedFileCount: 0,
        supportedFileCount: 0,
        unsupportedFileCount: 0,
        lastSyncedAt: finishedAt,
      };
    }
  },
};
