import {
  pgTable,
  text,
  uuid,
  timestamp,
  bigint,
  integer,
  jsonb,
  boolean,
  primaryKey,
  foreignKey,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ============================================================================
// Organizations & Users
// ============================================================================

/**
 * Multi-tenant organization table
 */
export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  name: text('name').notNull(),
  onedriveTenanttId: text('onedrive_tenant_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

/**
 * Users table with organizational membership
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  email: text('email').unique().notNull(),
  name: text('name').notNull(),
  role: text('role').default('member'), // 'admin', 'pm', 'super', 'member'
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ============================================================================
// Projects & File Records
// ============================================================================

/**
 * Projects table
 */
export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  onedriveFolderId: text('onedrive_folder_id'), // root folder in OneDrive
  status: text('status').default('active'), // 'active', 'archived', 'deleted'
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

/**
 * File records - the core "memory object" for every file
 * Stores metadata about files in OneDrive and their processing state
 */
export const fileRecords = pgTable(
  'file_records',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    onedriveItemId: text('onedrive_item_id').unique(),
    fileName: text('file_name').notNull(),
    filePath: text('file_path').notNull(), // path within project folder
    fileType: text('file_type'), // 'pdf', 'docx', 'image', etc.
    fileSize: bigint('file_size'),
    mimeType: text('mime_type'),

    // The "memory object" fields - AI-generated content
    summary: text('summary'), // AI-generated summary (500 chars max)
    keyTopics: text('key_topics').array(), // extracted topics
    tags: text('tags').array(), // auto + manual tags
    docCategory: text('doc_category'), // 'submittal', 'spec', 'drawing', 'rfi', 'photo', 'report'
    specSection: text('spec_section'), // e.g., '23 05 00' if detected
    sheetNumber: text('sheet_number'), // e.g., 'A101' for drawings
    revision: text('revision'), // e.g., 'Rev 3'

    // Sync and indexing metadata
    onedriveEtag: text('onedrive_etag'), // for change detection
    lastSynced: timestamp('last_synced', { withTimezone: true }),
    indexStatus: text('index_status').default('pending'), // 'pending', 'processing', 'indexed', 'failed'
    lastIndexed: timestamp('last_indexed', { withTimezone: true }),

    // Chunk tracking for vector search
    chunkCount: integer('chunk_count').default(0),

    // Timestamps
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_file_records_project').on(table.projectId),
    index('idx_file_records_category').on(table.docCategory),
    index('idx_file_records_tags').on(table.tags),
    index('idx_file_records_spec').on(table.specSection),
  ]
);

// ============================================================================
// Chat & Conversations
// ============================================================================

/**
 * Chat sessions - conversation containers
 */
export const chatSessions = pgTable('chat_sessions', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

/**
 * Chat messages - individual messages in a conversation
 */
export const chatMessages = pgTable('chat_messages', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  sessionId: uuid('session_id')
    .notNull()
    .references(() => chatSessions.id, { onDelete: 'cascade' }),
  role: text('role').notNull(), // 'user', 'assistant'
  content: text('content').notNull(),
  sources: jsonb('sources'), // [{file_id, file_name, chunk_id, relevance}]
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ============================================================================
// Feature Registry & Configuration
// ============================================================================

/**
 * Features registry - defines available dashboard features
 */
export const features = pgTable('features', {
  id: text('id').primaryKey(), // 'onedrive', 'chat', 'daily_photos', etc.
  name: text('name').notNull(),
  icon: text('icon').notNull(), // icon identifier
  route: text('route').notNull(), // frontend route
  enabled: boolean('enabled').default(false),
  sortOrder: integer('sort_order').default(0),
  config: jsonb('config').default(sql`'{}'`), // feature-specific settings
});

/**
 * Project features - which features are enabled per project
 */
export const projectFeatures = pgTable(
  'project_features',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    featureId: text('feature_id')
      .notNull()
      .references(() => features.id, { onDelete: 'cascade' }),
    enabled: boolean('enabled').default(true),
    config: jsonb('config').default(sql`'{}'`),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.featureId] }),
  ]
);

// ============================================================================
// Vector Store Metadata (for Pinecone/pgvector reference)
// ============================================================================

/**
 * Vector chunks - metadata about text chunks vectorized for semantic search
 * Note: The actual vectors are stored in Pinecone or pgvector
 * This table tracks which chunks exist for RAG context
 */
export const vectorChunks = pgTable(
  'vector_chunks',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    fileId: uuid('file_id')
      .notNull()
      .references(() => fileRecords.id, { onDelete: 'cascade' }),
    chunkIndex: integer('chunk_index').notNull(),
    chunkText: text('chunk_text').notNull(), // first 500 chars for preview
    vectorId: text('vector_id'), // reference to Pinecone/pgvector ID
    tokenCount: integer('token_count'), // approximate token count
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_vector_chunks_file').on(table.fileId),
    index('idx_vector_chunks_vector_id').on(table.vectorId),
  ]
);

// ============================================================================
// Type Exports for Application Use
// ============================================================================

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;

export type FileRecord = typeof fileRecords.$inferSelect;
export type NewFileRecord = typeof fileRecords.$inferInsert;

export type ChatSession = typeof chatSessions.$inferSelect;
export type NewChatSession = typeof chatSessions.$inferInsert;

export type ChatMessage = typeof chatMessages.$inferSelect;
export type NewChatMessage = typeof chatMessages.$inferInsert;

export type Feature = typeof features.$inferSelect;
export type NewFeature = typeof features.$inferInsert;

export type ProjectFeature = typeof projectFeatures.$inferSelect;
export type NewProjectFeature = typeof projectFeatures.$inferInsert;

export type VectorChunk = typeof vectorChunks.$inferSelect;
export type NewVectorChunk = typeof vectorChunks.$inferInsert;
