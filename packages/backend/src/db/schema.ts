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
  int,
  bigint,
  timestamp,
  boolean,
  jsonb,
  primaryKey,
  foreignKey,
  index,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

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
  (table) => [index("idx_users_org").on(table.orgId)]
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
  (table) => [index("idx_projects_org").on(table.orgId)]
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
    fileSize: bigint("file_size"),
    mimeType: text("mime_type"),

    // Memory fields (AI-generated)
    summary: text("summary"),
    keyTopics: text("key_topics").array(),
    tags: text("tags").array(),
    docCategory: text("doc_category", {
      enum: ["submittal", "spec", "drawing", "rfi", "photo", "report"],
    }),
    specSection: text("spec_section"), // e.g., "23 05 00"
    sheetNumber: text("sheet_number"), // e.g., "A101"
    revision: text("revision"), // e.g., "Rev 3"

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
    chunkCount: int("chunk_count").default(0).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_file_records_project").on(table.projectId),
    index("idx_file_records_category").on(table.docCategory),
    index("idx_file_records_tags").on(table.tags),
    index("idx_file_records_spec").on(table.specSection),
  ]
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
  (table) => [
    index("idx_chat_sessions_project").on(table.projectId),
    index("idx_chat_sessions_user").on(table.userId),
  ]
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("idx_chat_messages_session").on(table.sessionId)]
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
  sortOrder: int("sort_order").default(0).notNull(),
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
  (table) => [primaryKey({ columns: [table.projectId, table.featureId] })]
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
}));

export const projectsRelations = relations(
  projects,
  ({ one, many }) => ({
    organization: one(organizations, {
      fields: [projects.orgId],
      references: [organizations.id],
    }),
    fileRecords: many(fileRecords),
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
