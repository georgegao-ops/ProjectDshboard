/**
 * PostgreSQL Database Schema
 * Using Drizzle ORM for type-safe queries
 * 
 * Tables:
 * - organizations (multi-tenant container)
 * - users (team members)
 * - projects (OneDrive folders)
 * - file_records (indexed files)
 * - chat_sessions
 * - chat_messages
 * - features (registry)
 * - project_features (feature enablement)
 */

import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  timestamp,
  boolean,
  jsonb,
  primaryKey,
  index,
  customType,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

// ================================
// CUSTOM TYPES
// ================================

/**
 * pgvector column type — stores a floating-point vector.
 * The `dimensions` config is baked into the SQL type.
 */
export const vector = customType<{ data: number[]; driverData: string; config: { dimensions: number } }>({
  dataType(config) {
    return `vector(${config?.dimensions ?? 1536})`;
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return value.replace(/^\[|\]$/g, "").split(",").map(Number);
  },
});

// Full set of construction document categories
export const CONSTRUCTION_CATEGORIES = [
  "drawing",
  "rfi",
  "submittal",
  "change_order",
  "contract",
  "schedule",
  "spec",
  "meeting_minutes",
  "permit",
  "invoice",
  "safety",
  "photo",
  "report",
  "correspondence",
  "unknown",
] as const;
export type ConstructionCategory = (typeof CONSTRUCTION_CATEGORIES)[number];

// ================================
// ORGANIZATIONS (Multi-tenant)
// ================================

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  onedriveTeantId: text("onedrive_tenant_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// ================================
// USERS
// ================================

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id)
      .notNull(),
    email: text("email").unique().notNull(),
    name: text("name").notNull(),
    role: text("role", { enum: ["super", "admin", "pm", "member"] })
      .default("member")
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    orgIdIdx: index("idx_users_org").on(table.orgId),
  })
);

// ================================
// AUTH SESSIONS
// ================================

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .references(() => users.id)
      .notNull(),
    refreshToken: uuid("refresh_token").unique().notNull(),
    microsoftRefreshToken: text("microsoft_refresh_token").notNull(),
    microsoftAccessTokenExpiresAt: timestamp("microsoft_access_token_expires_at", {
      withTimezone: true,
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    userIdx: index("idx_auth_sessions_user").on(table.userId),
    expiresIdx: index("idx_auth_sessions_expires").on(table.expiresAt),
  })
);

// ================================
// ONEDRIVE CONNECTIONS
// ================================

export const onedriveConnections = pgTable(
  "onedrive_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id)
      .notNull(),
    userId: uuid("user_id")
      .references(() => users.id)
      .notNull()
      .unique(),
    tenantId: text("tenant_id"),
    accountEmail: text("account_email"),
    driveId: text("drive_id").notNull(),
    driveType: text("drive_type"),
    refreshToken: text("refresh_token").notNull(),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    orgIdx: index("idx_onedrive_connections_org").on(table.orgId),
    userIdx: index("idx_onedrive_connections_user").on(table.userId),
  })
);

// ================================
// PROJECTS
// ================================

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id)
      .notNull(),
    name: text("name").notNull(),
    onedriveFolderId: text("onedrive_folder_id"),
    status: text("status", { enum: ["active", "archived"] })
      .default("active")
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    orgIdIdx: index("idx_projects_org").on(table.orgId),
  })
);

// ================================
// FILE RECORDS (Indexed files)
// ================================

export const fileRecords = pgTable(
  "file_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .references(() => projects.id)
      .notNull(),
    onedriveItemId: text("onedrive_item_id").unique(),
    fileName: text("file_name").notNull(),
    filePath: text("file_path").notNull(),
    fileType: text("file_type"),
    fileSize: bigint("file_size", { mode: "number" }),
    mimeType: text("mime_type"),

    // Memory fields (AI-generated)
    summary: text("summary"),
    keyTopics: text("key_topics").array(),
    tags: text("tags").array(),
    // Full construction category set — enforced at application layer
    docCategory: text("doc_category"),
    specSection: text("spec_section"), // e.g., "23 05 00"
    sheetNumber: text("sheet_number"), // e.g., "A101"
    revision: text("revision"), // e.g., "Rev 3"

    // Construction intelligence — extracted structured fields
    // e.g. { rfiNumber, submittarNumber, vendor, dateApproved, costImpact, ... }
    extractedFields: jsonb("extracted_fields"),

    // Priority score 0-100; higher = process first
    priorityScore: integer("priority_score").default(50).notNull(),
    processingMode: text("processing_mode", {
      enum: ["full", "reduced", "metadata_only"],
    })
      .default("full")
      .notNull(),
    processingReason: text("processing_reason"),
    reducedCoverage: boolean("reduced_coverage").default(false).notNull(),
    extractedContentPercent: integer("extracted_content_percent"),
    normalizedTextObjectKey: text("normalized_text_object_key"),
    normalizedTextChecksum: text("normalized_text_checksum"),
    normalizedTextLength: integer("normalized_text_length"),
    normalizedTextStoredAt: timestamp("normalized_text_stored_at", { withTimezone: true }),
    encryptionKeyVersion: integer("encryption_key_version"),

    // Change detection
    versionHash: text("version_hash"),
    owner: text("owner"),

    // Sync metadata
    onedriveEtag: text("onedrive_etag"),
    lastSynced: timestamp("last_synced", { withTimezone: true }),
    indexStatus: text("index_status", {
      enum: ["pending", "processing", "indexed", "failed"],
    })
      .default("pending")
      .notNull(),
    lastIndexed: timestamp("last_indexed", { withTimezone: true }),

    // Chunks
    chunkCount: integer("chunk_count").default(0).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    projectIdx: index("idx_file_records_project").on(table.projectId),
    categoryIdx: index("idx_file_records_category").on(table.docCategory),
    tagsIdx: index("idx_file_records_tags").on(table.tags),
    specSectionIdx: index("idx_file_records_spec").on(table.specSection),
  })
);

export const fileChunks = pgTable(
  "file_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .references(() => projects.id)
      .notNull(),
    fileId: uuid("file_id")
      .references(() => fileRecords.id)
      .notNull(),
    onedriveItemId: text("onedrive_item_id").notNull(),
    fileName: text("file_name").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    chunkText: text("chunk_text").notNull(),
    sourceType: text("source_type", {
      enum: ["content", "summary", "metadata_stub"],
    })
      .default("content")
      .notNull(),
    pageNumber: integer("page_number"),
    sectionLabel: text("section_label"),
    metadata: jsonb("metadata").default(sql`'{}'::jsonb`).notNull(),
    tokenCount: integer("token_count").default(0).notNull(),
    embeddingModel: text("embedding_model").notNull(),
    // Legacy JSONB embedding (kept for backward-compat, populated by older code)
    embedding: jsonb("embedding"),
    // pgvector column for high-performance ANN search
    embeddingVector: vector("embedding_vector", { dimensions: 1536 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    projectIdx: index("idx_file_chunks_project").on(table.projectId),
    fileIdx: index("idx_file_chunks_file").on(table.fileId),
    onedriveItemIdx: index("idx_file_chunks_onedrive_item").on(table.onedriveItemId),
    sourceTypeIdx: index("idx_file_chunks_source_type").on(table.sourceType),
    pageNumberIdx: index("idx_file_chunks_page_number").on(table.pageNumber),
  })
);

export const chunkLinks = pgTable(
  "chunk_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .references(() => projects.id)
      .notNull(),
    fileId: uuid("file_id")
      .references(() => fileRecords.id)
      .notNull(),
    sourceChunkId: uuid("source_chunk_id")
      .references(() => fileChunks.id)
      .notNull(),
    targetChunkId: uuid("target_chunk_id")
      .references(() => fileChunks.id)
      .notNull(),
    relation: text("relation").notNull(),
    weight: integer("weight").default(100).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    projectIdx: index("idx_chunk_links_project").on(table.projectId),
    sourceIdx: index("idx_chunk_links_source").on(table.sourceChunkId),
    targetIdx: index("idx_chunk_links_target").on(table.targetChunkId),
  })
);

export const syncRuns = pgTable(
  "sync_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .references(() => projects.id)
      .notNull(),
    status: text("status", { enum: ["success", "failed"] })
      .default("success")
      .notNull(),
    scannedFileCount: integer("scanned_file_count").default(0).notNull(),
    supportedFileCount: integer("supported_file_count").default(0).notNull(),
    unsupportedFileCount: integer("unsupported_file_count").default(0).notNull(),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    projectIdx: index("idx_sync_runs_project").on(table.projectId),
    finishedAtIdx: index("idx_sync_runs_finished_at").on(table.finishedAt),
  })
);

export const rechunkRuns = pgTable(
  "rechunk_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .references(() => projects.id)
      .notNull(),
    fileId: uuid("file_id")
      .references(() => fileRecords.id)
      .notNull(),
    status: text("status", {
      enum: ["pending", "in_progress", "completed", "failed"],
    })
      .default("pending")
      .notNull(),
    triggerReason: text("trigger_reason").notNull(),
    strategyVersion: text("strategy_version").default("v1").notNull(),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    projectIdx: index("idx_rechunk_runs_project").on(table.projectId),
    fileIdx: index("idx_rechunk_runs_file").on(table.fileId),
    statusIdx: index("idx_rechunk_runs_status").on(table.status),
    createdAtIdx: index("idx_rechunk_runs_created_at").on(table.createdAt),
  })
);

// ================================
// CHAT SESSIONS & MESSAGES
// ================================

export const chatSessions = pgTable(
  "chat_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .references(() => projects.id)
      .notNull(),
    userId: uuid("user_id")
      .references(() => users.id)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    projectIdx: index("idx_chat_sessions_project").on(table.projectId),
    userIdx: index("idx_chat_sessions_user").on(table.userId),
  })
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .references(() => chatSessions.id)
      .notNull(),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    content: text("content").notNull(),
    sources: jsonb("sources"), // [{file_id, file_name, chunk_id, relevance}]
    interpretation: jsonb("interpretation"),
    feedback: jsonb("feedback"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    sessionIdx: index("idx_chat_messages_session").on(table.sessionId),
  })
);

// ================================
// FEATURES (Registry & Enablement)
// ================================

export const features = pgTable("features", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  icon: text("icon").notNull(),
  route: text("route").notNull(),
  description: text("description"),
  enabled: boolean("enabled").default(false).notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
  config: jsonb("config").default(sql`'{}'`),
});

export const projectFeatures = pgTable(
  "project_features",
  {
    projectId: uuid("project_id")
      .references(() => projects.id)
      .notNull(),
    featureId: text("feature_id")
      .references(() => features.id)
      .notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    config: jsonb("config").default(sql`'{}'`),
  },
  (table) => ({
    projectFeaturePk: primaryKey({ columns: [table.projectId, table.featureId] }),
  })
);

// ================================
// DOCUMENT RELATIONSHIPS
// ================================

export const documentRelationships = pgTable(
  "document_relationships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    sourceFileId: uuid("source_file_id")
      .references(() => fileRecords.id, { onDelete: "cascade" })
      .notNull(),
    targetFileId: uuid("target_file_id")
      .references(() => fileRecords.id, { onDelete: "cascade" })
      .notNull(),
    // 'references' | 'supersedes' | 'responds_to' | 'tied_to' | 'part_of'
    relationType: text("relation_type").notNull(),
    confidence: integer("confidence").default(80).notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdx: index("idx_doc_relationships_project").on(table.projectId),
    sourceIdx: index("idx_doc_relationships_source").on(table.sourceFileId),
    targetIdx: index("idx_doc_relationships_target").on(table.targetFileId),
  })
);

// ================================
// INDEXING ERRORS
// ================================

export const indexingErrors = pgTable(
  "indexing_errors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    fileId: uuid("file_id").references(() => fileRecords.id, { onDelete: "cascade" }),
    onedriveItemId: text("onedrive_item_id"),
    fileName: text("file_name"),
    // 'metadata' | 'download' | 'extract' | 'chunk' | 'embed' | 'classify'
    stage: text("stage").notNull(),
    errorCode: text("error_code").notNull(),
    errorMessage: text("error_message").notNull(),
    attempt: integer("attempt").default(1).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdx: index("idx_indexing_errors_project").on(table.projectId),
    fileIdx: index("idx_indexing_errors_file").on(table.fileId),
  })
);

// ================================
// RELATIONS (for query convenience)
// ================================

export const organizationsRelations = relations(
  organizations,
  ({ many }) => ({
    users: many(users),
    projects: many(projects),
  })
);

export const usersRelations = relations(users, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [users.orgId],
    references: [organizations.id],
  }),
  chatSessions: many(chatSessions),
  authSessions: many(authSessions),
  onedriveConnections: many(onedriveConnections),
}));

export const authSessionsRelations = relations(authSessions, ({ one }) => ({
  user: one(users, {
    fields: [authSessions.userId],
    references: [users.id],
  }),
}));

export const onedriveConnectionsRelations = relations(onedriveConnections, ({ one }) => ({
  organization: one(organizations, {
    fields: [onedriveConnections.orgId],
    references: [organizations.id],
  }),
  user: one(users, {
    fields: [onedriveConnections.userId],
    references: [users.id],
  }),
}));

export const projectsRelations = relations(
  projects,
  ({ one, many }) => ({
    organization: one(organizations, {
      fields: [projects.orgId],
      references: [organizations.id],
    }),
    fileRecords: many(fileRecords),
    syncRuns: many(syncRuns),
    chatSessions: many(chatSessions),
    features: many(projectFeatures),
  })
);

export const fileRecordsRelations = relations(fileRecords, ({ one }) => ({
  project: one(projects, {
    fields: [fileRecords.projectId],
    references: [projects.id],
  }),
}));

export const syncRunsRelations = relations(syncRuns, ({ one }) => ({
  project: one(projects, {
    fields: [syncRuns.projectId],
    references: [projects.id],
  }),
}));

export const chatSessionsRelations = relations(
  chatSessions,
  ({ one, many }) => ({
    project: one(projects, {
      fields: [chatSessions.projectId],
      references: [projects.id],
    }),
    user: one(users, {
      fields: [chatSessions.userId],
      references: [users.id],
    }),
    messages: many(chatMessages),
  })
);

export const chatMessagesRelations = relations(chatMessages, ({ one }) => ({
  session: one(chatSessions, {
    fields: [chatMessages.sessionId],
    references: [chatSessions.id],
  }),
}));

export const featuresRelations = relations(features, ({ many }) => ({
  projectFeatures: many(projectFeatures),
}));

export const projectFeaturesRelations = relations(
  projectFeatures,
  ({ one }) => ({
    project: one(projects, {
      fields: [projectFeatures.projectId],
      references: [projects.id],
    }),
    feature: one(features, {
      fields: [projectFeatures.featureId],
      references: [features.id],
    }),
  })
);
