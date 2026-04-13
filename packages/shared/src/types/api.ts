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

export interface SendChatMessageRequest {
  sessionId: UUID;
  message: string;
}

export interface SendChatMessageResponse {
  messageId: UUID;
  role: "assistant";
  content: string;
  sources: Array<{
    fileId: UUID;
    fileName: string;
    relevance: number;
  }>;
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
