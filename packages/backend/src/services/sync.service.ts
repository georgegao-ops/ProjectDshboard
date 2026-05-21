import { randomUUID } from "node:crypto";
import type { FileRecord, OneDriveSyncResponse, ProcessingMode, UUID } from "@contractor/shared";
import { getEnv } from "../config/env";
import {
  buildIndexingIdempotencyKey,
  buildIndexingJobOptions,
  getIndexingQueueClient,
  type IndexingQueueClient,
} from "../lib/queue";
import { indexingService } from "./indexing.service";
import { onedriveService } from "./onedrive.service";
import { priorityScoringService } from "./priority-scoring.service";
import { projectService } from "./project.service";
import type { RequestUserContext } from "./service-types";
import { toUuid } from "./service-types";

const MAX_FULL_INDEX_SIZE_BYTES = 200 * 1024 * 1024;
const MAX_REDUCED_INDEX_SIZE_BYTES = 500 * 1024 * 1024;

const SUPPORTED_MIME_TYPES = new Set<string>([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",  // DOCX
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",        // XLSX
  "application/vnd.ms-excel",
  "text/plain",
  "text/csv",
  "text/markdown",
  "message/rfc822",                // EML
  "application/vnd.ms-outlook",   // MSG
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp",
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

function updateDownloadedCount(
  projectId: UUID,
  downloadedFileCount: number,
  currentFilePath?: string
): void {
  const current = syncProgressByProject.get(projectId);
  if (!current) {
    return;
  }

  // During recursive traversal we do not know total files up front.
  // Use a gradual curve so UI does not jump to ~95% too early and look stuck.
  const traversalPercent = Math.min(
    90,
    8 + Math.floor(Math.sqrt(Math.max(0, downloadedFileCount)) * 4)
  );
  const completionPercent = Math.max(current.completionPercent, traversalPercent);
  syncProgressByProject.set(projectId, {
    ...current,
    downloadedFileCount,
    completionPercent,
    message: currentFilePath
      ? `Scanning OneDrive... latest file: ${currentFilePath}`
      : current.message,
  });
}

function isSupportedMimeType(mimeType?: string): boolean {
  return Boolean(mimeType && SUPPORTED_MIME_TYPES.has(mimeType));
}

function normalizeMimeType(mimeType?: string): string | undefined {
  if (!mimeType) return undefined;
  return mimeType.split(";")[0]?.trim().toLowerCase() || undefined;
}

function inferMimeTypeFromName(fileName: string): string | undefined {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pdf")) {
    return "application/pdf";
  }

  if (lower.endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }

  if (lower.endsWith(".doc")) {
    return "application/msword";
  }

  if (lower.endsWith(".xlsx")) {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }

  if (lower.endsWith(".xls")) {
    return "application/vnd.ms-excel";
  }

  if (lower.endsWith(".csv")) {
    return "text/csv";
  }

  if (lower.endsWith(".md")) {
    return "text/markdown";
  }

  if (lower.endsWith(".txt")) {
    return "text/plain";
  }

  if (lower.endsWith(".eml")) {
    return "message/rfc822";
  }

  if (lower.endsWith(".msg")) {
    return "application/vnd.ms-outlook";
  }

  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return "image/jpeg";
  }

  if (lower.endsWith(".png")) {
    return "image/png";
  }

  if (lower.endsWith(".tif") || lower.endsWith(".tiff")) {
    return "image/tiff";
  }

  if (lower.endsWith(".webp")) {
    return "image/webp";
  }

  return undefined;
}

function resolveMimeType(fileName: string, graphMimeType?: string): string | undefined {
  const normalizedGraphMime = normalizeMimeType(graphMimeType);

  if (normalizedGraphMime && SUPPORTED_MIME_TYPES.has(normalizedGraphMime)) {
    return normalizedGraphMime;
  }

  const inferred = inferMimeTypeFromName(fileName);
  if (inferred) {
    return inferred;
  }

  return normalizedGraphMime;
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
  const mimeType = resolveMimeType(file.name, file.mimeType);
  const isSupportedType = isSupportedMimeType(mimeType);
  const processingMode: ProcessingMode = !isSupportedType
    ? "metadata_only"
    : typeof file.size !== "number" || file.size <= MAX_FULL_INDEX_SIZE_BYTES
      ? "full"
      : file.size <= MAX_REDUCED_INDEX_SIZE_BYTES
        ? "reduced"
        : "metadata_only";

  const tags: string[] = [];
  if (!isSupportedType) tags.push("unsupported_type");
  if (processingMode === "reduced") tags.push("reduced_indexing");
  if (isSupportedType && processingMode === "metadata_only") tags.push("oversize");

  const processingReason = !isSupportedType
    ? "File type not supported for indexing."
    : processingMode === "reduced"
      ? `File exceeds full indexing threshold (${MAX_FULL_INDEX_SIZE_BYTES} bytes). Reduced mode enabled.`
      : processingMode === "metadata_only"
        ? `File exceeds reduced indexing threshold (${MAX_REDUCED_INDEX_SIZE_BYTES} bytes). Metadata-only mode enabled.`
      : undefined;

  const priorityScore = priorityScoringService.score({
    fileName: file.name,
    filePath: file.path,
    mimeType,
    fileSize: file.size,
    lastModifiedAt: file.lastModified,
  });

  return {
    id: toUuid(randomUUID()),
    projectId,
    onedriveItemId: file.id,
    fileName: file.name,
    filePath: file.path,
    fileType: mimeType,
    fileSize: file.size,
    mimeType,
    summary: processingReason,
    tags,
    priorityScore,
    processingMode,
    processingReason,
    reducedCoverage: processingMode !== "full",
    extractedContentPercent: processingMode === "full" ? 100 : processingMode === "reduced" ? 50 : 0,
    onedriveEtag: file.eTag,
    versionHash: file.eTag,
    lastSynced: new Date(),
    indexStatus: isSupportedType ? "pending" : "failed",
    chunkCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

export const syncService = {
  resetProjectSyncProgress(projectId: UUID, message?: string): void {
    // Use inProgress:true so the 1-second poll never emits a false "idle" state
    // between the reset call and the moment syncProjectMetadata sets inProgress:true.
    syncProgressByProject.set(projectId, {
      inProgress: true,
      downloadedFileCount: 0,
      completionPercent: 0,
      message: message ?? "Sync preparing.",
      startedAt: new Date(),
    });
  },

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
        ({ downloadedFileCount, currentFilePath }) => {
          updateDownloadedCount(projectId, downloadedFileCount, currentFilePath);
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

      // Local/dev fallback: if Redis is not configured, process indexing inline
      // so OneDrive sync can still produce indexed chunks for chat/testing.
      if (!getEnv().redisUrl) {
        await indexingService.processProjectIndexing(projectId, user);
        return {
          ...queueResult,
          message: `${completedMessage} Indexing processed inline (Redis not configured).`,
          scannedFileCount: records.length,
          supportedFileCount,
          unsupportedFileCount,
          lastSyncedAt: finishedAt,
        };
      }

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
