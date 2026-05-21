import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type {
  CreateProjectRequest,
  CreateProjectResponse,
  FileRecord,
  ProjectFilesResponse,
  ProjectDetailsResponse,
  ProjectListResponse,
  UUID,
} from "@contractor/shared";
import {
  chunkLinks,
  fileChunks,
  fileRecords,
  getDbIfInitialized,
  projects,
  syncRuns,
} from "../db";
import { AppError } from "../lib/errors";
import { toUuid } from "./service-types";

const projectsByOrg = new Map<string, CreateProjectResponse["project"][]>();
const filesByProject = new Map<string, FileRecord[]>();
const syncTimesByProject = new Map<string, Date>();
const IN_CLAUSE_BATCH_SIZE = 250;
let fileChunksVectorColumnIsNativeVector: boolean | undefined;

async function shouldWriteEmbeddingVector(): Promise<boolean> {
  if (typeof fileChunksVectorColumnIsNativeVector === "boolean") {
    return fileChunksVectorColumnIsNativeVector;
  }

  const db = getDbIfInitialized();
  if (!db) {
    fileChunksVectorColumnIsNativeVector = false;
    return false;
  }

  try {
    const rows = await db.execute<{ udt_name: string }>(sql`
      SELECT udt_name
      FROM information_schema.columns
      WHERE table_name = 'file_chunks' AND column_name = 'embedding_vector'
      LIMIT 1
    `);

    const row = Array.from(rows as unknown as Array<{ udt_name?: string }>)[0];
    fileChunksVectorColumnIsNativeVector = row?.udt_name === "vector";
  } catch {
    fileChunksVectorColumnIsNativeVector = false;
  }

  return fileChunksVectorColumnIsNativeVector;
}

function toBatches<T>(input: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < input.length; index += batchSize) {
    batches.push(input.slice(index, index + batchSize));
  }
  return batches;
}

const chunksByProject = new Map<string, Array<{
  id: UUID;
  projectId: UUID;
  fileId: UUID;
  onedriveItemId: string;
  fileName: string;
  chunkIndex: number;
  chunkText: string;
  sourceType: "content" | "summary" | "metadata_stub";
  pageNumber?: number;
  sectionLabel?: string;
  metadata?: Record<string, unknown>;
  confidence?: number;
  tokenCount: number;
  embeddingModel: string;
  embedding: number[];
  createdAt: Date;
}>>();
const chunkLinksByProject = new Map<string, Array<{
  id: UUID;
  projectId: UUID;
  fileId: UUID;
  sourceChunkId: UUID;
  targetChunkId: UUID;
  relation: string;
  weight: number;
  createdAt: Date;
}>>();

interface SyncPersistenceInput {
  files: FileRecord[];
  scannedFileCount: number;
  supportedFileCount: number;
  unsupportedFileCount: number;
  status: "success" | "failed";
  errorMessage?: string;
  startedAt: Date;
  finishedAt: Date;
}

function toProjectResponseProject(record: {
  id: string;
  orgId: string;
  name: string;
  onedriveFolderId: string | null;
  status: "active" | "archived";
  createdAt: Date;
}): CreateProjectResponse["project"] {
  return {
    id: toUuid(record.id),
    orgId: toUuid(record.orgId),
    name: record.name,
    onedriveFolderId: record.onedriveFolderId ?? undefined,
    status: record.status,
    createdAt: record.createdAt,
  };
}

function toFileRecord(record: {
  id: string;
  projectId: string;
  onedriveItemId: string | null;
  fileName: string;
  filePath: string;
  fileType: string | null;
  fileSize: number | null;
  mimeType: string | null;
  summary: string | null;
  keyTopics: string[] | null;
  tags: string[] | null;
  docCategory: string | null;
  specSection: string | null;
  sheetNumber: string | null;
  revision: string | null;
  processingMode: "full" | "reduced" | "metadata_only";
  processingReason: string | null;
  reducedCoverage: boolean;
  extractedContentPercent: number | null;
  normalizedTextObjectKey: string | null;
  normalizedTextChecksum: string | null;
  normalizedTextLength: number | null;
  normalizedTextStoredAt: Date | null;
  encryptionKeyVersion: number | null;
  onedriveEtag: string | null;
  versionHash: string | null;
  lastSynced: Date | null;
  indexStatus: "pending" | "processing" | "indexed" | "failed";
  lastIndexed: Date | null;
  chunkCount: number;
  createdAt: Date;
  updatedAt: Date;
  extractedFields?: unknown;
  priorityScore?: number | null;
}): FileRecord {
  return {
    id: toUuid(record.id),
    projectId: toUuid(record.projectId),
    onedriveItemId: record.onedriveItemId ?? "",
    fileName: record.fileName,
    filePath: record.filePath,
    fileType: record.fileType ?? undefined,
    fileSize: record.fileSize ?? undefined,
    mimeType: record.mimeType ?? undefined,
    summary: record.summary ?? undefined,
    keyTopics: record.keyTopics ?? undefined,
    tags: record.tags ?? undefined,
    docCategory: (record.docCategory ?? undefined) as import("@contractor/shared").DocumentCategory | undefined,
    specSection: record.specSection ?? undefined,
    sheetNumber: record.sheetNumber ?? undefined,
    revision: record.revision ?? undefined,
    processingMode: record.processingMode,
    processingReason: record.processingReason ?? undefined,
    reducedCoverage: record.reducedCoverage,
    extractedContentPercent: record.extractedContentPercent ?? undefined,
    normalizedTextObjectKey: record.normalizedTextObjectKey ?? undefined,
    normalizedTextChecksum: record.normalizedTextChecksum ?? undefined,
    normalizedTextLength: record.normalizedTextLength ?? undefined,
    normalizedTextStoredAt: record.normalizedTextStoredAt ?? undefined,
    encryptionKeyVersion: record.encryptionKeyVersion ?? undefined,
    onedriveEtag: record.onedriveEtag ?? undefined,
    versionHash: record.versionHash ?? undefined,
    lastSynced: record.lastSynced ?? undefined,
    indexStatus: record.indexStatus,
    lastIndexed: record.lastIndexed ?? undefined,
    chunkCount: record.chunkCount,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    extractedFields: record.extractedFields as Record<string, string | undefined> | undefined,
    priorityScore: record.priorityScore ?? undefined,
  };
}

function getProjectsForOrg(orgId: string): CreateProjectResponse["project"][] {
  const projects = projectsByOrg.get(orgId);

  if (projects) {
    return projects;
  }

  const nextProjects: CreateProjectResponse["project"][] = [];
  projectsByOrg.set(orgId, nextProjects);
  return nextProjects;
}

export const projectService = {
  async listProjects(orgId?: string): Promise<ProjectListResponse> {
    if (!orgId) {
      return { projects: [] };
    }

    const db = getDbIfInitialized();
    if (db) {
      const records = await db
        .select()
        .from(projects)
        .where(eq(projects.orgId, toUuid(orgId)))
        .orderBy(desc(projects.createdAt));

      return {
        projects: records.map(toProjectResponseProject),
      };
    }

    return { projects: [...getProjectsForOrg(orgId)] };
  },

  async createProject(
    request: CreateProjectRequest,
    orgId?: string
  ): Promise<CreateProjectResponse> {
    const resolvedOrgId = orgId ?? "org-123";
    const db = getDbIfInitialized();

    if (db) {
      const [record] = await db
        .insert(projects)
        .values({
          id: toUuid(randomUUID()),
          orgId: toUuid(resolvedOrgId),
          name: request.name,
          onedriveFolderId: request.onedriveFolderId,
          status: "active",
          createdAt: new Date(),
        })
        .returning();

      return { project: toProjectResponseProject(record) };
    }

    const project = {
      id: toUuid(randomUUID()),
      orgId: toUuid(resolvedOrgId),
      name: request.name,
      onedriveFolderId: request.onedriveFolderId,
      status: "active" as const,
      createdAt: new Date(),
    };

    getProjectsForOrg(resolvedOrgId).push(project);

    return { project };
  },

  async updateProjectFolderBinding(
    projectId: UUID,
    onedriveFolderId: string,
    options?: {
      clearIndexedData?: boolean;
    }
  ): Promise<CreateProjectResponse["project"]> {
    const db = getDbIfInitialized();
    const clearIndexedData = options?.clearIndexedData === true;

    if (db) {
      const [updated] = await db
        .update(projects)
        .set({
          onedriveFolderId,
        })
        .where(eq(projects.id, projectId))
        .returning();

      if (!updated) {
        throw new AppError(404, "project_not_found", "Project not found");
      }

      if (clearIndexedData) {
        await this.setProjectFiles(projectId, []);
        await db.delete(syncRuns).where(eq(syncRuns.projectId, projectId));
        syncTimesByProject.delete(projectId);
      }

      return toProjectResponseProject(updated);
    }

    const allProjects = Array.from(projectsByOrg.values());
    let updatedProject: CreateProjectResponse["project"] | undefined;

    for (const orgProjects of allProjects) {
      const project = orgProjects.find((entry) => entry.id === projectId);
      if (!project) {
        continue;
      }

      project.onedriveFolderId = onedriveFolderId;
      updatedProject = project;
      break;
    }

    if (!updatedProject) {
      throw new AppError(404, "project_not_found", "Project not found");
    }

    if (clearIndexedData) {
      filesByProject.set(projectId, []);
      chunksByProject.set(projectId, []);
      chunkLinksByProject.set(projectId, []);
      syncTimesByProject.delete(projectId);
    }

    return updatedProject;
  },

  async getProjectDetails(projectId: UUID): Promise<ProjectDetailsResponse> {
    const db = getDbIfInitialized();

    if (db) {
      const [record] = await db
        .select()
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);

      if (!record) {
        throw new AppError(404, "project_not_found", "Project not found");
      }

      const [latestRun] = await db
        .select()
        .from(syncRuns)
        .where(eq(syncRuns.projectId, projectId))
        .orderBy(desc(syncRuns.finishedAt))
        .limit(1);

      const records = await db
        .select()
        .from(fileRecords)
        .where(eq(fileRecords.projectId, projectId));

      return {
        project: toProjectResponseProject(record),
        onedrive: {
          connected: Boolean(record.onedriveFolderId),
          syncInProgress: false,
          lastSyncedAt: latestRun?.finishedAt,
        },
        fileCount: records.length,
        lastSyncedAt: latestRun?.finishedAt,
      };
    }

    const project = Array.from(projectsByOrg.values()).flat().find((entry) => entry.id === projectId);

    if (!project) {
      throw new AppError(404, "project_not_found", "Project not found");
    }

    const files = filesByProject.get(projectId) ?? [];
    const lastSyncedAt = syncTimesByProject.get(projectId);

    return {
      project,
      onedrive: {
        connected: false,
        syncInProgress: false,
        lastSyncedAt,
      },
      fileCount: files.length,
      lastSyncedAt,
    };
  },

  async getProjectOrThrow(projectId: UUID, orgId?: string): Promise<CreateProjectResponse["project"]> {
    const db = getDbIfInitialized();
    if (db) {
      const [record] = await db
        .select()
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);

      if (!record) {
        throw new AppError(404, "project_not_found", "Project not found");
      }

      if (orgId && record.orgId !== toUuid(orgId)) {
        throw new AppError(403, "forbidden", "Project does not belong to current organization");
      }

      return toProjectResponseProject(record);
    }

    const project = Array.from(projectsByOrg.values())
      .flat()
      .find((entry) => entry.id === projectId);

    if (!project) {
      throw new AppError(404, "project_not_found", "Project not found");
    }

    if (orgId && project.orgId !== toUuid(orgId)) {
      throw new AppError(403, "forbidden", "Project does not belong to current organization");
    }

    return project;
  },

  async setProjectFiles(projectId: UUID, files: FileRecord[]): Promise<void> {
    const db = getDbIfInitialized();
    if (db) {
      const existingRecords = await db
        .select()
        .from(fileRecords)
        .where(eq(fileRecords.projectId, projectId));
      const existingByItemId = new Map(
        existingRecords
          .filter((entry) => Boolean(entry.onedriveItemId))
          .map((entry) => [entry.onedriveItemId as string, entry])
      );

      for (const file of files) {
        const existing = existingByItemId.get(file.onedriveItemId);
        const isUnchanged =
          Boolean(existing?.onedriveEtag) &&
          Boolean(file.onedriveEtag) &&
          existing?.onedriveEtag === file.onedriveEtag;

        await db
          .insert(fileRecords)
          .values({
            id: file.id,
            projectId,
            onedriveItemId: file.onedriveItemId,
            fileName: file.fileName,
            filePath: file.filePath,
            fileType: file.fileType,
            fileSize: file.fileSize,
            mimeType: file.mimeType,
            summary: isUnchanged ? existing?.summary : file.summary,
            keyTopics: isUnchanged ? existing?.keyTopics : file.keyTopics,
            tags: isUnchanged ? existing?.tags : file.tags,
            docCategory: isUnchanged ? existing?.docCategory : file.docCategory,
            specSection: isUnchanged ? existing?.specSection : file.specSection,
            sheetNumber: isUnchanged ? existing?.sheetNumber : file.sheetNumber,
            revision: isUnchanged ? existing?.revision : file.revision,
            processingMode: isUnchanged
              ? existing?.processingMode ?? file.processingMode ?? "full"
              : file.processingMode ?? "full",
            processingReason: isUnchanged ? existing?.processingReason : file.processingReason,
            reducedCoverage: isUnchanged
              ? existing?.reducedCoverage ?? file.reducedCoverage ?? false
              : file.reducedCoverage ?? false,
            extractedContentPercent: isUnchanged
              ? existing?.extractedContentPercent ?? file.extractedContentPercent
              : file.extractedContentPercent,
            normalizedTextObjectKey: isUnchanged
              ? existing?.normalizedTextObjectKey ?? file.normalizedTextObjectKey
              : file.normalizedTextObjectKey,
            normalizedTextChecksum: isUnchanged
              ? existing?.normalizedTextChecksum ?? file.normalizedTextChecksum
              : file.normalizedTextChecksum,
            normalizedTextLength: isUnchanged
              ? existing?.normalizedTextLength ?? file.normalizedTextLength
              : file.normalizedTextLength,
            normalizedTextStoredAt: isUnchanged
              ? existing?.normalizedTextStoredAt ?? file.normalizedTextStoredAt
              : file.normalizedTextStoredAt,
            encryptionKeyVersion: isUnchanged
              ? existing?.encryptionKeyVersion ?? file.encryptionKeyVersion
              : file.encryptionKeyVersion,
            onedriveEtag: file.onedriveEtag,
            versionHash: file.versionHash,
            lastSynced: file.lastSynced,
            indexStatus: isUnchanged ? existing?.indexStatus ?? file.indexStatus : file.indexStatus,
            lastIndexed: isUnchanged ? existing?.lastIndexed : file.lastIndexed,
            chunkCount: isUnchanged ? existing?.chunkCount ?? file.chunkCount : file.chunkCount,
            createdAt: isUnchanged ? existing?.createdAt ?? file.createdAt : file.createdAt,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: fileRecords.onedriveItemId,
            set: {
              projectId,
              fileName: file.fileName,
              filePath: file.filePath,
              fileType: file.fileType,
              fileSize: file.fileSize,
              mimeType: file.mimeType,
              summary: isUnchanged ? existing?.summary : file.summary,
              keyTopics: isUnchanged ? existing?.keyTopics : file.keyTopics,
              tags: isUnchanged ? existing?.tags : file.tags,
              docCategory: isUnchanged ? existing?.docCategory : file.docCategory,
              specSection: isUnchanged ? existing?.specSection : file.specSection,
              sheetNumber: isUnchanged ? existing?.sheetNumber : file.sheetNumber,
              revision: isUnchanged ? existing?.revision : file.revision,
              processingMode: isUnchanged
                ? existing?.processingMode ?? file.processingMode ?? "full"
                : file.processingMode ?? "full",
              processingReason: isUnchanged ? existing?.processingReason : file.processingReason,
              reducedCoverage: isUnchanged
                ? existing?.reducedCoverage ?? file.reducedCoverage ?? false
                : file.reducedCoverage ?? false,
              extractedContentPercent: isUnchanged
                ? existing?.extractedContentPercent ?? file.extractedContentPercent
                : file.extractedContentPercent,
              normalizedTextObjectKey: isUnchanged
                ? existing?.normalizedTextObjectKey ?? file.normalizedTextObjectKey
                : file.normalizedTextObjectKey,
              normalizedTextChecksum: isUnchanged
                ? existing?.normalizedTextChecksum ?? file.normalizedTextChecksum
                : file.normalizedTextChecksum,
              normalizedTextLength: isUnchanged
                ? existing?.normalizedTextLength ?? file.normalizedTextLength
                : file.normalizedTextLength,
              normalizedTextStoredAt: isUnchanged
                ? existing?.normalizedTextStoredAt ?? file.normalizedTextStoredAt
                : file.normalizedTextStoredAt,
              encryptionKeyVersion: isUnchanged
                ? existing?.encryptionKeyVersion ?? file.encryptionKeyVersion
                : file.encryptionKeyVersion,
              onedriveEtag: file.onedriveEtag,
              versionHash: file.versionHash,
              lastSynced: file.lastSynced,
              indexStatus: isUnchanged ? existing?.indexStatus ?? file.indexStatus : file.indexStatus,
              lastIndexed: isUnchanged ? existing?.lastIndexed : file.lastIndexed,
              chunkCount: isUnchanged ? existing?.chunkCount ?? file.chunkCount : file.chunkCount,
              updatedAt: new Date(),
            },
          });
      }

      const syncedItemIds = files.map((entry) => entry.onedriveItemId).filter(Boolean);
      if (syncedItemIds.length > 0) {
        const staleRecords = existingRecords.filter(
          (entry) => Boolean(entry.onedriveItemId) && !syncedItemIds.includes(entry.onedriveItemId as string)
        );
        if (staleRecords.length > 0) {
          const staleFileIds = staleRecords.map((entry) => entry.id);
          const staleChunkIds: string[] = [];
          for (const fileIdBatch of toBatches(staleFileIds, IN_CLAUSE_BATCH_SIZE)) {
            const staleChunkRows = await db
              .select({ id: fileChunks.id })
              .from(fileChunks)
              .where(
                and(
                  eq(fileChunks.projectId, projectId),
                  inArray(fileChunks.fileId, fileIdBatch)
                )
              );
            staleChunkIds.push(...staleChunkRows.map((entry) => entry.id));
          }

          if (staleChunkIds.length > 0) {
            for (const chunkIdBatch of toBatches(staleChunkIds, IN_CLAUSE_BATCH_SIZE)) {
              await db
                .delete(chunkLinks)
                .where(
                  and(
                    eq(chunkLinks.projectId, projectId),
                    inArray(chunkLinks.sourceChunkId, chunkIdBatch)
                  )
                );

              await db
                .delete(chunkLinks)
                .where(
                  and(
                    eq(chunkLinks.projectId, projectId),
                    inArray(chunkLinks.targetChunkId, chunkIdBatch)
                  )
                );
            }
          }

          for (const fileIdBatch of toBatches(staleFileIds, IN_CLAUSE_BATCH_SIZE)) {
            await db
              .delete(fileChunks)
              .where(
                and(
                  eq(fileChunks.projectId, projectId),
                  inArray(fileChunks.fileId, fileIdBatch)
                )
              );
          }

          const staleItemIds = staleRecords.map((entry) => entry.onedriveItemId as string);
          for (const itemIdBatch of toBatches(staleItemIds, IN_CLAUSE_BATCH_SIZE)) {
            await db
              .delete(fileRecords)
              .where(
                and(
                  eq(fileRecords.projectId, projectId),
                  inArray(fileRecords.onedriveItemId, itemIdBatch)
                )
              );
          }
        }
      } else {
        const existingChunkRows = await db
          .select({ id: fileChunks.id })
          .from(fileChunks)
          .where(eq(fileChunks.projectId, projectId));
        const existingChunkIds = existingChunkRows.map((entry) => entry.id);

        if (existingChunkIds.length > 0) {
          for (const chunkIdBatch of toBatches(existingChunkIds, IN_CLAUSE_BATCH_SIZE)) {
            await db
              .delete(chunkLinks)
              .where(
                and(
                  eq(chunkLinks.projectId, projectId),
                  inArray(chunkLinks.sourceChunkId, chunkIdBatch)
                )
              );

            await db
              .delete(chunkLinks)
              .where(
                and(
                  eq(chunkLinks.projectId, projectId),
                  inArray(chunkLinks.targetChunkId, chunkIdBatch)
                )
              );
          }
        }

        await db.delete(fileChunks).where(eq(fileChunks.projectId, projectId));
        await db.delete(fileRecords).where(eq(fileRecords.projectId, projectId));
      }

      return;
    }

    filesByProject.set(projectId, files);
    syncTimesByProject.set(projectId, new Date());
  },

  async updateFileIndexingResult(
    projectId: UUID,
    onedriveItemId: string,
    update: {
      indexStatus: "pending" | "processing" | "indexed" | "failed";
      summary?: string;
      keyTopics?: string[];
      chunkCount?: number;
      lastIndexed?: Date;
      docCategory?: string;
      tags?: string[];
      extractedFields?: Record<string, unknown>;
      specSection?: string;
      sheetNumber?: string;
      revision?: string;
      processingMode?: "full" | "reduced" | "metadata_only";
      processingReason?: string;
      reducedCoverage?: boolean;
      extractedContentPercent?: number;
      normalizedTextObjectKey?: string;
      normalizedTextChecksum?: string;
      normalizedTextLength?: number;
      normalizedTextStoredAt?: Date;
      encryptionKeyVersion?: number;
    }
  ): Promise<void> {
    const db = getDbIfInitialized();
    if (db) {
      await db
        .update(fileRecords)
        .set({
          indexStatus: update.indexStatus,
          summary: update.summary,
          keyTopics: update.keyTopics,
          chunkCount: update.chunkCount,
          lastIndexed: update.lastIndexed,
          docCategory: update.docCategory,
          tags: update.tags,
          extractedFields: update.extractedFields,
          specSection: update.specSection,
          sheetNumber: update.sheetNumber,
          revision: update.revision,
          processingMode: update.processingMode,
          processingReason: update.processingReason,
          reducedCoverage: update.reducedCoverage,
          extractedContentPercent: update.extractedContentPercent,
          normalizedTextObjectKey: update.normalizedTextObjectKey,
          normalizedTextChecksum: update.normalizedTextChecksum,
          normalizedTextLength: update.normalizedTextLength,
          normalizedTextStoredAt: update.normalizedTextStoredAt,
          encryptionKeyVersion: update.encryptionKeyVersion,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(fileRecords.projectId, projectId),
            eq(fileRecords.onedriveItemId, onedriveItemId)
          )
        );
      return;
    }

    const files = filesByProject.get(projectId) ?? [];
    const file = files.find((entry) => entry.onedriveItemId === onedriveItemId);
    if (!file) {
      return;
    }

    file.indexStatus = update.indexStatus;
    file.summary = update.summary;
    file.keyTopics = update.keyTopics;
    file.docCategory = (update.docCategory as import("@contractor/shared").DocumentCategory | undefined) ?? file.docCategory;
    file.tags = update.tags;
    file.extractedFields = update.extractedFields as Record<string, string | undefined> | undefined;
    file.specSection = update.specSection;
    file.sheetNumber = update.sheetNumber;
    file.revision = update.revision;
    file.processingMode = update.processingMode ?? file.processingMode;
    file.processingReason = update.processingReason;
    file.reducedCoverage = update.reducedCoverage ?? file.reducedCoverage;
    file.extractedContentPercent = update.extractedContentPercent ?? file.extractedContentPercent;
    file.normalizedTextObjectKey = update.normalizedTextObjectKey ?? file.normalizedTextObjectKey;
    file.normalizedTextChecksum = update.normalizedTextChecksum ?? file.normalizedTextChecksum;
    file.normalizedTextLength = update.normalizedTextLength ?? file.normalizedTextLength;
    file.normalizedTextStoredAt = update.normalizedTextStoredAt ?? file.normalizedTextStoredAt;
    file.encryptionKeyVersion = update.encryptionKeyVersion ?? file.encryptionKeyVersion;
    file.chunkCount = update.chunkCount ?? file.chunkCount;
    file.lastIndexed = update.lastIndexed;
    file.updatedAt = new Date();
  },

  async replaceFileChunks(
    projectId: UUID,
    fileId: UUID,
    onedriveItemId: string,
    fileName: string,
    chunks: Array<{
      chunkIndex: number;
      chunkText: string;
      tokenCount: number;
      embeddingModel: string;
      embedding: number[];
      sourceType?: "content" | "summary" | "metadata_stub";
      pageNumber?: number;
      sectionLabel?: string;
      metadata?: Record<string, unknown>;
      confidence?: number;
    }>,
    links: Array<{
      sourceChunkIndex: number;
      targetChunkIndex: number;
      relation: string;
      weight: number;
    }>
  ): Promise<void> {
    const db = getDbIfInitialized();
    if (db) {
      const existing = await db
        .select()
        .from(fileChunks)
        .where(
          and(
            eq(fileChunks.projectId, projectId),
            eq(fileChunks.fileId, fileId)
          )
        );

      if (existing.length > 0) {
        await db
          .delete(chunkLinks)
          .where(
            and(
              eq(chunkLinks.projectId, projectId),
              inArray(
                chunkLinks.sourceChunkId,
                existing.map((entry) => entry.id)
              )
            )
          );

        await db
          .delete(fileChunks)
          .where(
            and(
              eq(fileChunks.projectId, projectId),
              eq(fileChunks.fileId, fileId)
            )
          );
      }

      const inserted: Array<{
        id: UUID;
        chunkIndex: number;
      }> = [];
      const writeVectorColumn = await shouldWriteEmbeddingVector();

      for (const chunk of chunks) {
        const [created] = await db
          .insert(fileChunks)
          .values({
            id: toUuid(randomUUID()),
            projectId,
            fileId,
            onedriveItemId,
            fileName,
            chunkIndex: chunk.chunkIndex,
            chunkText: chunk.chunkText,
            sourceType: chunk.sourceType ?? "content",
            pageNumber: chunk.pageNumber,
            sectionLabel: chunk.sectionLabel,
            metadata: chunk.metadata ?? {},
            tokenCount: chunk.tokenCount,
            embeddingModel: chunk.embeddingModel,
            embedding: chunk.embedding,
            embeddingVector: writeVectorColumn ? chunk.embedding : undefined,
            createdAt: new Date(),
          })
          .returning({
            id: fileChunks.id,
            chunkIndex: fileChunks.chunkIndex,
          });

        inserted.push({
          id: toUuid(created.id),
          chunkIndex: created.chunkIndex,
        });
      }

      const byIndex = new Map(inserted.map((entry) => [entry.chunkIndex, entry.id]));

      for (const link of links) {
        const sourceChunkId = byIndex.get(link.sourceChunkIndex);
        const targetChunkId = byIndex.get(link.targetChunkIndex);

        if (!sourceChunkId || !targetChunkId) {
          continue;
        }

        await db.insert(chunkLinks).values({
          id: toUuid(randomUUID()),
          projectId,
          fileId,
          sourceChunkId,
          targetChunkId,
          relation: link.relation,
          weight: link.weight,
          createdAt: new Date(),
        });
      }

      return;
    }

    const projectChunks = chunksByProject.get(projectId) ?? [];
    const keptChunks = projectChunks.filter((entry) => entry.fileId !== fileId);
    const nextChunks = chunks.map((chunk) => ({
      id: toUuid(randomUUID()),
      projectId,
      fileId,
      onedriveItemId,
      fileName,
      chunkIndex: chunk.chunkIndex,
      chunkText: chunk.chunkText,
      sourceType: chunk.sourceType ?? "content",
      pageNumber: chunk.pageNumber,
      sectionLabel: chunk.sectionLabel,
      metadata: chunk.metadata ?? {},
      confidence: chunk.confidence,
      tokenCount: chunk.tokenCount,
      embeddingModel: chunk.embeddingModel,
      embedding: chunk.embedding,
      createdAt: new Date(),
    }));
    chunksByProject.set(projectId, [...keptChunks, ...nextChunks]);

    const byChunkIndex = new Map(nextChunks.map((entry) => [entry.chunkIndex, entry.id]));
    const projectLinks = chunkLinksByProject.get(projectId) ?? [];
    const keptLinks = projectLinks.filter((entry) => entry.fileId !== fileId);
    const nextLinks = links
      .map((link) => {
        const sourceChunkId = byChunkIndex.get(link.sourceChunkIndex);
        const targetChunkId = byChunkIndex.get(link.targetChunkIndex);

        if (!sourceChunkId || !targetChunkId) {
          return undefined;
        }

        return {
          id: toUuid(randomUUID()),
          projectId,
          fileId,
          sourceChunkId,
          targetChunkId,
          relation: link.relation,
          weight: link.weight,
          createdAt: new Date(),
        };
      })
      .filter(Boolean) as Array<{
      id: UUID;
      projectId: UUID;
      fileId: UUID;
      sourceChunkId: UUID;
      targetChunkId: UUID;
      relation: string;
      weight: number;
      createdAt: Date;
    }>;
    chunkLinksByProject.set(projectId, [...keptLinks, ...nextLinks]);
  },

  async listProjectChunks(projectId: UUID): Promise<Array<{
    id: UUID;
    projectId: UUID;
    fileId: UUID;
    fileName: string;
    chunkIndex: number;
    chunkText: string;
    sourceType: "content" | "summary" | "metadata_stub";
    pageNumber?: number;
    sectionLabel?: string;
    metadata?: Record<string, unknown>;
    tokenCount: number;
    embeddingModel: string;
    embedding: number[];
    docCategory?: string;
    tags?: string[];
  }>> {
    const db = getDbIfInitialized();
    if (db) {
      const rows = await db
        .select()
        .from(fileChunks)
        .where(eq(fileChunks.projectId, projectId));

      return rows.map((row) => ({
        id: toUuid(row.id),
        projectId: toUuid(row.projectId),
        fileId: toUuid(row.fileId),
        fileName: row.fileName,
        chunkIndex: row.chunkIndex,
        chunkText: row.chunkText,
        sourceType: row.sourceType,
        pageNumber: row.pageNumber ?? undefined,
        sectionLabel: row.sectionLabel ?? undefined,
        metadata: (row.metadata as Record<string, unknown> | null) ?? undefined,
        tokenCount: row.tokenCount,
        embeddingModel: row.embeddingModel,
        embedding: Array.isArray(row.embedding) ? (row.embedding as number[]) : [],
      }));
    }

    const inMemory = chunksByProject.get(projectId) ?? [];
    return inMemory.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      fileId: row.fileId,
      fileName: row.fileName,
      chunkIndex: row.chunkIndex,
      chunkText: row.chunkText,
      sourceType: row.sourceType,
      pageNumber: row.pageNumber,
      sectionLabel: row.sectionLabel,
      metadata: row.metadata,
      tokenCount: row.tokenCount,
      embeddingModel: row.embeddingModel,
      embedding: row.embedding,
    }));
  },

  async recordSyncRun(projectId: UUID, input: SyncPersistenceInput): Promise<void> {
    const db = getDbIfInitialized();
    if (db) {
      await db.insert(syncRuns).values({
        projectId,
        status: input.status,
        scannedFileCount: input.scannedFileCount,
        supportedFileCount: input.supportedFileCount,
        unsupportedFileCount: input.unsupportedFileCount,
        errorMessage: input.errorMessage,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        createdAt: new Date(),
      });
      syncTimesByProject.set(projectId, input.finishedAt);
      return;
    }

    syncTimesByProject.set(projectId, input.finishedAt);
  },

  async listProjectFiles(
    projectId: UUID,
    query: {
      page?: number;
      pageSize?: number;
      search?: string;
      category?: string;
      tags?: string[];
    }
  ): Promise<ProjectFilesResponse> {
    const db = getDbIfInitialized();
    if (db) {
      const records = await db
        .select()
        .from(fileRecords)
        .where(eq(fileRecords.projectId, projectId));

      const allFiles = records.map(toFileRecord);
      const page = Number.isFinite(query.page) && (query.page ?? 1) > 0 ? Number(query.page) : 1;
      const pageSize =
        Number.isFinite(query.pageSize) && (query.pageSize ?? 50) > 0
          ? Math.min(Number(query.pageSize), 200)
          : 50;
      const normalizedSearch = query.search?.trim().toLowerCase();

      const filtered = allFiles.filter((file) => {
        if (normalizedSearch) {
          const haystack = `${file.fileName} ${file.filePath}`.toLowerCase();
          if (!haystack.includes(normalizedSearch)) {
            return false;
          }
        }

        if (query.category && file.docCategory !== query.category) {
          return false;
        }

        if (query.tags && query.tags.length > 0) {
          const tags = file.tags ?? [];
          const hasAnyTag = query.tags.some((tag) => tags.includes(tag));
          if (!hasAnyTag) {
            return false;
          }
        }

        return true;
      });

      const startIndex = (page - 1) * pageSize;
      const files = filtered.slice(startIndex, startIndex + pageSize);

      return {
        files,
        total: filtered.length,
        page,
        pageSize,
        hasMore: startIndex + files.length < filtered.length,
      };
    }

    const page = Number.isFinite(query.page) && (query.page ?? 1) > 0 ? Number(query.page) : 1;
    const pageSize =
      Number.isFinite(query.pageSize) && (query.pageSize ?? 50) > 0
        ? Math.min(Number(query.pageSize), 200)
        : 50;

    const normalizedSearch = query.search?.trim().toLowerCase();
    const records = filesByProject.get(projectId) ?? [];

    const filtered = records.filter((file) => {
      if (normalizedSearch) {
        const haystack = `${file.fileName} ${file.filePath}`.toLowerCase();
        if (!haystack.includes(normalizedSearch)) {
          return false;
        }
      }

      if (query.category && file.docCategory !== query.category) {
        return false;
      }

      if (query.tags && query.tags.length > 0) {
        const tags = file.tags ?? [];
        const hasAnyTag = query.tags.some((tag) => tags.includes(tag));
        if (!hasAnyTag) {
          return false;
        }
      }

      return true;
    });

    const startIndex = (page - 1) * pageSize;
    const files = filtered.slice(startIndex, startIndex + pageSize);

    return {
      files,
      total: filtered.length,
      page,
      pageSize,
      hasMore: startIndex + files.length < filtered.length,
    };
  },

  async getProjectFileById(projectId: UUID, fileId: UUID): Promise<FileRecord | null> {
    const db = getDbIfInitialized();
    if (db) {
      const [record] = await db
        .select()
        .from(fileRecords)
        .where(
          and(
            eq(fileRecords.projectId, projectId),
            eq(fileRecords.id, fileId)
          )
        )
        .limit(1);

      return record ? toFileRecord(record) : null;
    }

    const records = filesByProject.get(projectId) ?? [];
    return records.find((file) => file.id === fileId) ?? null;
  },

  resetForTests(): void {
    projectsByOrg.clear();
    filesByProject.clear();
    syncTimesByProject.clear();
    chunksByProject.clear();
    chunkLinksByProject.clear();
  },
};
