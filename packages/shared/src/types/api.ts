/**
 * API Request/Response Types
 * Contracts for all backend endpoints
 */

import type {
  UUID,
  User,
  Project,
  FileRecord,
  ChatSession,
  ChatMessage,
  OneDriveStatus,
  ProjectFeature,
  Feature,
} from "./entities";

// ================================
// AUTH
// ================================

export interface AuthLoginRequest {
  code: string; // OAuth2 authorization code
  redirectUri: string;
  state?: string;
}

export interface AuthLoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: User;
}

export interface AuthRefreshRequest {
  refreshToken: string;
}

export interface AuthTokenResponse {
  accessToken: string;
  expiresIn: number;
}

export interface AuthMeResponse {
  user: User;
  organization: {
    id: UUID;
    name: string;
  };
}

// ================================
// ONEDRIVE
// ================================

export interface OneDriveConnectRequest {
  code: string; // OAuth2 code from Microsoft
  redirectUri: string;
  state: string;
}

export interface OneDriveConnectStartResponse {
  authorizationUrl: string;
  state: string;
}

export interface OneDriveConnectResponse {
  connected: boolean;
  message: string;
}

export interface OneDriveStatusResponse extends OneDriveStatus {}

export interface OneDriveSyncRequest {
  projectId: UUID;
}

export interface OneDriveSyncResponse {
  syncStarted: boolean;
  message: string;
  jobId?: string;
  scannedFileCount?: number;
  supportedFileCount?: number;
  unsupportedFileCount?: number;
  lastSyncedAt?: Date;
}

export interface OneDriveBrowseItem {
  id: string; // OneDrive item ID
  name: string;
  isFolder: boolean;
  webUrl: string;
  lastModified?: Date;
  size?: number;
}

export interface OneDriveBrowseResponse {
  items: OneDriveBrowseItem[];
  parentId?: string;
}

// ================================
// PROJECTS
// ================================

export interface ProjectListResponse {
  projects: Project[];
}

export interface CreateProjectRequest {
  name: string;
  onedriveFolderId: string; // OneDrive folder the user selected
}

export interface CreateProjectResponse {
  project: Project;
}

export interface UpdateProjectFolderRequest {
  onedriveFolderId: string;
  resetIndexedData?: boolean;
}

export interface UpdateProjectFolderResponse {
  project: Project;
  resetPerformed: boolean;
  sync: OneDriveSyncResponse;
  message: string;
}

export interface ProjectDetailsResponse {
  project: Project;
  onedrive: OneDriveStatus;
  fileCount: number;
  lastSyncedAt?: Date;
}

export interface ProjectFilesRequest {
  projectId: UUID;
  page?: number;
  pageSize?: number;
  search?: string;
  category?: string;
  tags?: string[];
}

export interface ProjectFilesResponse {
  files: FileRecord[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface GroupedIndexingFailureReason {
  stage: string;
  errorCode: string;
  count: number;
  lastMessage: string;
  lastSeenAt: string;
}

export interface IndexingAnomaly {
  type: string;
  count: number;
  message: string;
}

export interface IndexingRecentError {
  fileName: string;
  stage: string;
  errorCode: string;
  errorMessage: string;
  createdAt: string;
}

export interface ProjectIndexingProgressResponse {
  total: number;
  processableTotal: number;
  pending: number;
  processing: number;
  indexed: number;
  failed: number;
  skipped: number;
  unsupportedCount: number;
  oversizeCount: number;
  completionPercent: number;
  paused: boolean;
  pauseReasonCode?: string;
  pauseMessage?: string;
  pauseSince?: string;
  pauseUntil?: string;
  circuitOpen: boolean;
  categoryBreakdown: Record<string, number>;
  recentErrors: IndexingRecentError[];
  groupedFailureReasons: GroupedIndexingFailureReason[];
  anomalies: IndexingAnomaly[];
}

// ================================
// CHAT
// ================================

export interface CreateChatSessionRequest {
  projectId: UUID;
}

export interface CreateChatSessionResponse {
  session: ChatSession;
}

export interface ChatSessionsListResponse {
  sessions: ChatSession[];
}

export interface ChatHistoryTurn {
  role: "user" | "assistant";
  content: string;
}

export interface OpenDocContext {
  fileName: string;
  fileId?: UUID;
  page?: number;
}

export type ChatIntentLabel =
  | "greeting"
  | "file_lookup"
  | "active_doc_qa"
  | "status_check"
  | "schedule_risk"
  | "cost_risk"
  | "contract_notice"
  | "document_summary"
  | "general_qa";

export interface ChatInterpretation {
  intent: ChatIntentLabel;
  confidence: number;
  source: "rules" | "llm" | "fallback";
  alternatives?: Array<{
    intent: ChatIntentLabel;
    confidence: number;
  }>;
  entities?: {
    rfiNumber?: string;
    submittalNumber?: string;
    specSection?: string;
    dateHint?: "recent" | "latest";
    statusHint?: "open" | "pending" | "closed";
  };
  retrievalHints?: {
    preferredCategories?: string[];
    preferredTags?: string[];
    recencyBias?: boolean;
  };
  fallbackReason?: string;
}

export interface InterpretationFeedbackEvent {
  verdict: "accepted" | "corrected" | "irrelevant";
  correctedIntent?: ChatIntentLabel;
  note?: string;
}

export interface SendChatMessageRequest {
  sessionId: UUID;
  message: string;
  history?: ChatHistoryTurn[];
  openDocs?: OpenDocContext[];
  activeDocFileName?: string;
  activeDocFileId?: UUID;
  feedback?: InterpretationFeedbackEvent;
}

export interface SendChatMessageResponse {
  messageId: UUID;
  role: "assistant";
  content: string;
  interpretation?: ChatInterpretation;
  suggestions?: string[];
  autoOpenFileName?: string;
  sources: Array<{
    fileId: UUID;
    fileName: string;
    displayName?: string;
    relevance: number;
    suggestedPages?: number[];
    bestPage?: number;
    pageOrigin?: "exact" | "fallback" | "mixed";
  }>;
  citations?: Array<{
    chunkId: string;
    fileId: UUID;
    fileName: string;
    chunkIndex: number;
    sourceType: "content" | "summary" | "metadata_stub";
    relevance: number;
    pageNumber?: number;
    sectionLabel?: string;
    metadata?: Record<string, unknown>;
    confidence: number;
  }>;
  coordinator?: {
    domains: string[];
    cacheHit: boolean;
    splitSignals: string[];
    specialistAgents: Array<{
      agent: string;
      domains: string[];
      sourceCount: number;
      nodeCount: number;
      durationMs: number;
    }>;
    estimatedContextTokens: number;
    contradictions: Array<{
      kind: string;
      severity: "info" | "warning";
      message: string;
      evidenceFileIds: UUID[];
    }>;
    telemetry: {
      routeMs: number;
      retrievalMs: number;
      mergeMs: number;
      agentMs: number;
      totalMs: number;
    };
  };
  createdAt: Date;
}

export interface ChatHistoryResponse {
  messages: ChatMessage[];
  total: number;
}

// ================================
// FEATURES (Pluggable Dashboard)
// ================================

export interface ProjectFeaturesResponse {
  features: (ProjectFeature & { feature: Feature })[];
}

export interface UpdateProjectFeatureRequest {
  featureId: string;
  enabled: boolean;
  config?: Record<string, unknown>;
}

export interface UpdateProjectFeatureResponse {
  feature: ProjectFeature;
}

export interface FeaturesRegistryResponse {
  features: Feature[];
}

// ================================
// ERROR RESPONSE
// ================================

export interface ErrorResponse {
  error: string;
  message: string;
  statusCode: number;
  details?: Record<string, string>;
}
