import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
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
const chunksByProject = new Map<string, Array<{
  id: UUID;
  projectId: UUID;
  fileId: UUID;
  onedriveItemId: string;
  fileName: string;
  chunkIndex: number;
  chunkText: string;
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
  docCategory: "submittal" | "spec" | "drawing" | "rfi" | "photo" | "report" | null;
  specSection: string | null;
  sheetNumber: string | null;
  revision: string | null;
  onedriveEtag: string | null;
  lastSynced: Date | null;
  indexStatus: "pending" | "processing" | "indexed" | "failed";
  lastIndexed: Date | null;
  chunkCount: number;
  createdAt: Date;
  updatedAt: Date;
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
    docCategory: record.docCategory ?? undefined,
    specSection: record.specSection ?? undefined,
    sheetNumber: record.sheetNumber ?? undefined,
    revision: record.revision ?? undefined,
    onedriveEtag: record.onedriveEtag ?? undefined,
    lastSynced: record.lastSynced ?? undefined,
    indexStatus: record.indexStatus,
    lastIndexed: record.lastIndexed ?? undefined,
    chunkCount: record.chunkCount,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
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
            onedriveEtag: file.onedriveEtag,
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
              onedriveEtag: file.onedriveEtag,
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
          await db
            .delete(fileRecords)
            .where(
              and(
                eq(fileRecords.projectId, projectId),
                inArray(
                  fileRecords.onedriveItemId,
                  staleRecords.map((entry) => entry.onedriveItemId as string)
                )
              )
            );
        }
      } else {
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
            tokenCount: chunk.tokenCount,
            embeddingModel: chunk.embeddingModel,
            embedding: chunk.embedding,
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
    tokenCount: number;
    embeddingModel: string;
    embedding: number[];
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

  resetForTests(): void {
    projectsByOrg.clear();
    filesByProject.clear();
    syncTimesByProject.clear();
    chunksByProject.clear();
    chunkLinksByProject.clear();
  },
};
