import { db } from './client';
import {
  organizations,
  users,
  projects,
  fileRecords,
  chatSessions,
  chatMessages,
  features,
  projectFeatures,
  vectorChunks,
  NewOrganization,
  NewUser,
  NewProject,
  NewFileRecord,
  NewChatSession,
  NewChatMessage,
} from './schema';
import { eq, and } from 'drizzle-orm';

// ============================================================================
// Organization Queries
// ============================================================================

export async function createOrganization(org: NewOrganization) {
  const result = await db.insert(organizations).values(org).returning();
  return result[0];
}

export async function getOrganizationById(id: string) {
  return db.query.organizations.findFirst({
    where: eq(organizations.id, id),
  });
}

// ============================================================================
// User Queries
// ============================================================================

export async function createUser(user: NewUser) {
  const result = await db.insert(users).values(user).returning();
  return result[0];
}

export async function getUserById(id: string) {
  return db.query.users.findFirst({
    where: eq(users.id, id),
  });
}

export async function getUserByEmail(email: string) {
  return db.query.users.findFirst({
    where: eq(users.email, email),
  });
}

export async function getOrganizationUsers(orgId: string) {
  return db.query.users.findMany({
    where: eq(users.orgId, orgId),
  });
}

// ============================================================================
// Project Queries
// ============================================================================

export async function createProject(project: NewProject) {
  const result = await db.insert(projects).values(project).returning();
  return result[0];
}

export async function getProjectById(id: string) {
  return db.query.projects.findFirst({
    where: eq(projects.id, id),
  });
}

export async function getOrganizationProjects(orgId: string) {
  return db.query.projects.findMany({
    where: eq(projects.orgId, orgId),
  });
}

export async function updateProjectStatus(
  projectId: string,
  status: 'active' | 'archived' | 'deleted'
) {
  const result = await db
    .update(projects)
    .set({ status })
    .where(eq(projects.id, projectId))
    .returning();
  return result[0];
}

// ============================================================================
// File Record Queries
// ============================================================================

export async function createFileRecord(file: NewFileRecord) {
  const result = await db.insert(fileRecords).values(file).returning();
  return result[0];
}

export async function getFileRecordById(id: string) {
  return db.query.fileRecords.findFirst({
    where: eq(fileRecords.id, id),
  });
}

export async function getFileRecordByOnedriveItemId(itemId: string) {
  return db.query.fileRecords.findFirst({
    where: eq(fileRecords.onedriveItemId, itemId),
  });
}

export async function getProjectFileRecords(projectId: string) {
  return db.query.fileRecords.findMany({
    where: eq(fileRecords.projectId, projectId),
  });
}

export async function getFileRecordsByCategory(
  projectId: string,
  category: string
) {
  return db.query.fileRecords.findMany({
    where: and(
      eq(fileRecords.projectId, projectId),
      eq(fileRecords.docCategory, category)
    ),
  });
}

export async function getFileRecordsByTag(projectId: string, tag: string) {
  return db.query.fileRecords.findMany({
    where: and(
      eq(fileRecords.projectId, projectId),
      // Note: This requires custom SQL for array contains
      // We'll need a raw query for this
    ),
  });
}

export async function updateFileRecordIndexStatus(
  fileId: string,
  status: 'pending' | 'processing' | 'indexed' | 'failed'
) {
  const result = await db
    .update(fileRecords)
    .set({
      indexStatus: status,
      lastIndexed:
        status === 'indexed'
          ? new Date()
          : fileRecords.lastIndexed,
    })
    .where(eq(fileRecords.id, fileId))
    .returning();
  return result[0];
}

export async function updateFileRecordMetadata(
  fileId: string,
  updates: Partial<NewFileRecord>
) {
  const result = await db
    .update(fileRecords)
    .set({
      ...updates,
      updatedAt: new Date(),
    })
    .where(eq(fileRecords.id, fileId))
    .returning();
  return result[0];
}

// ============================================================================
// Chat Queries
// ============================================================================

export async function createChatSession(session: NewChatSession) {
  const result = await db.insert(chatSessions).values(session).returning();
  return result[0];
}

export async function getChatSessionById(id: string) {
  return db.query.chatSessions.findFirst({
    where: eq(chatSessions.id, id),
  });
}

export async function getProjectChatSessions(projectId: string) {
  return db.query.chatSessions.findMany({
    where: eq(chatSessions.projectId, projectId),
  });
}

export async function getUserChatSessions(userId: string, projectId: string) {
  return db.query.chatSessions.findMany({
    where: and(
      eq(chatSessions.userId, userId),
      eq(chatSessions.projectId, projectId)
    ),
  });
}

export async function createChatMessage(message: NewChatMessage) {
  const result = await db.insert(chatMessages).values(message).returning();
  return result[0];
}

export async function getChatSessionMessages(sessionId: string) {
  return db.query.chatMessages.findMany({
    where: eq(chatMessages.sessionId, sessionId),
  });
}

// ============================================================================
// Vector Chunk Queries
// ============================================================================

export async function createVectorChunk(chunk: typeof vectorChunks.$inferInsert) {
  const result = await db.insert(vectorChunks).values(chunk).returning();
  return result[0];
}

export async function getFileVectorChunks(fileId: string) {
  return db.query.vectorChunks.findMany({
    where: eq(vectorChunks.fileId, fileId),
  });
}

export async function getVectorChunksByVectorId(vectorId: string) {
  return db.query.vectorChunks.findFirst({
    where: eq(vectorChunks.vectorId, vectorId),
  });
}

// ============================================================================
// Feature Queries
// ============================================================================

export async function createFeature(feature: typeof features.$inferInsert) {
  const result = await db.insert(features).values(feature).returning();
  return result[0];
}

export async function getFeatureById(id: string) {
  return db.query.features.findFirst({
    where: eq(features.id, id),
  });
}

export async function getAllFeatures() {
  return db.query.features.findMany();
}

export async function getProjectFeatures(projectId: string) {
  return db.query.projectFeatures.findMany({
    where: eq(projectFeatures.projectId, projectId),
  });
}

export async function enableProjectFeature(
  projectId: string,
  featureId: string,
  config = {}
) {
  const result = await db
    .insert(projectFeatures)
    .values({
      projectId,
      featureId,
      enabled: true,
      config: JSON.stringify(config),
    })
    .onConflictDoUpdate({
      target: [projectFeatures.projectId, projectFeatures.featureId],
      set: {
        enabled: true,
        config: JSON.stringify(config),
      },
    })
    .returning();
  return result[0];
}

export async function disableProjectFeature(
  projectId: string,
  featureId: string
) {
  const result = await db
    .update(projectFeatures)
    .set({ enabled: false })
    .where(
      and(
        eq(projectFeatures.projectId, projectId),
        eq(projectFeatures.featureId, featureId)
      )
    )
    .returning();
  return result[0];
}
