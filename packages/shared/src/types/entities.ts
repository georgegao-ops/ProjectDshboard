/**
 * Core Entity Types — Shared across all platforms
 * These match the PostgreSQL schema defined in the MVP plan
 */

export type UUID = string & { readonly __brand: "UUID" };

export type UserRole = "super" | "admin" | "pm" | "member";

/** Full set of construction document categories */
export type DocumentCategory =
  | "drawing"
  | "rfi"
  | "submittal"
  | "change_order"
  | "contract"
  | "schedule"
  | "spec"
  | "meeting_minutes"
  | "permit"
  | "invoice"
  | "safety"
  | "photo"
  | "report"
  | "correspondence"
  | "unknown";

export type IndexStatus = "pending" | "processing" | "indexed" | "failed";
export type ProcessingMode = "full" | "reduced" | "metadata_only";

/**
 * Organization — Multi-tenant container
 */
export interface Organization {
  id: UUID;
  name: string;
  onedriveTeantId?: string;
  createdAt: Date;
}

/**
 * User — Contractor team member
 */
export interface User {
  id: UUID;
  orgId: UUID;
  email: string;
  name: string;
  role: UserRole;
  createdAt: Date;
}

/**
 * Project — Tied to a OneDrive folder
 */
export interface Project {
  id: UUID;
  orgId: UUID;
  name: string;
  onedriveFolderId?: string;
  status: "active" | "archived";
  createdAt: Date;
}

/**
 * FileRecord — The "memory object" for every indexed file
 * This is the core of the indexing pipeline
 */
export interface FileRecord {
  id: UUID;
  projectId: UUID;
  onedriveItemId: string;
  fileName: string;
  filePath: string; // path within project folder
  fileType?: string; // 'pdf', 'docx', 'image', etc.
  fileSize?: number;
  mimeType?: string;

  // The "memory" fields
  summary?: string; // AI-generated summary (500 chars max)
  keyTopics?: string[]; // extracted topics
  tags?: string[]; // auto + manual tags
  docCategory?: DocumentCategory;
  specSection?: string; // e.g., '23 05 00'
  sheetNumber?: string; // e.g., 'A101'
  revision?: string; // e.g., 'Rev 3'

  // Construction intelligence — structured extracted fields
  extractedFields?: Record<string, string | undefined>;

  // Priority score 0-100 (higher = indexed first)
  priorityScore?: number;
  processingMode?: ProcessingMode;
  processingReason?: string;
  reducedCoverage?: boolean;
  extractedContentPercent?: number;
  normalizedTextObjectKey?: string;
  normalizedTextChecksum?: string;
  normalizedTextLength?: number;
  normalizedTextStoredAt?: Date;
  encryptionKeyVersion?: number;

  // Sync metadata
  onedriveEtag?: string; // for change detection
  versionHash?: string;
  lastSynced?: Date;
  indexStatus: IndexStatus;
  lastIndexed?: Date;

  // Chunk tracking
  chunkCount: number;

  createdAt: Date;
  updatedAt: Date;
}

/**
 * ChatSession — Conversation thread
 */
export interface ChatSession {
  id: UUID;
  projectId: UUID;
  userId: UUID;
  createdAt: Date;
}

/**
 * ChatMessage — Individual message in a chat
 */
export interface ChatMessage {
  id: UUID;
  sessionId: UUID;
  role: "user" | "assistant";
  content: string;
  sources?: ChatMessageSource[]; // [{file_id, file_name, chunk_id, relevance}]
  interpretation?: {
    intent: string;
    confidence: number;
    source: "rules" | "llm" | "fallback";
  };
  feedback?: {
    verdict: "accepted" | "corrected" | "irrelevant";
    correctedIntent?: string;
    note?: string;
  };
  createdAt: Date;
}

export interface ChatMessageSource {
  fileId: UUID;
  fileName: string;
  chunkId?: string;
  relevance?: number; // 0-1 score
}

/**
 * Feature — Dashboard plugin system
 */
export interface Feature {
  id: string; // 'onedrive', 'chat', 'daily_photos', etc.
  name: string;
  icon: string; // icon identifier (lucide or expo/vector-icons)
  route: string; // frontend route
  description: string;
  enabled: boolean;
  sortOrder: number;
  config: Record<string, unknown>; // feature-specific settings
}

/**
 * ProjectFeature — Feature enablement per project
 */
export interface ProjectFeature {
  projectId: UUID;
  featureId: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

/**
 * OneDrive Connection Status
 */
export interface OneDriveStatus {
  connected: boolean;
  lastSyncedAt?: Date;
  syncInProgress: boolean;
  fileCount?: number;
  accountEmail?: string;
  tenantId?: string;
  driveId?: string;
  driveType?: string;
}

/**
 * Vector Embedding Metadata (for Pinecone/pgvector)
 */
export interface VectorEmbedding {
  id: string; // "{file_id}_{chunk_index}"
  values: number[]; // 1536-dim float array
  metadata: {
    fileId: UUID;
    fileName: string;
    chunkIndex: number;
    chunkText: string;
    docCategory?: DocumentCategory;
    specSection?: string;
    sheetNumber?: string;
    tags?: string[];
  };
}

/**
 * Chat Context Assembly
 */
export interface ChatContext {
  chunks: VectorEmbedding[];
  fileMetadata: Record<UUID, FileRecord>;
  totalTokens: number;
}
