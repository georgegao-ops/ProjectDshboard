/**
 * @contractor/shared - Shared TypeScript package used across all platforms
 * 
 * This package contains:
 * - TypeScript types for all entities and API contracts
 * - Typed API client for cross-platform API calls
 * - Zustand stores for state management
 * - Feature registry for pluggable dashboard system
 */

export const API_VERSION = "v1";

// ================================
// TYPES
// ================================
export type {
  UUID,
  UserRole,
  DocumentCategory,
  IndexStatus,
  ProcessingMode,
  Organization,
  User,
  Project,
  FileRecord,
  ChatSession,
  ChatMessage,
  ChatMessageSource,
  Feature,
  ProjectFeature,
  OneDriveStatus,
  VectorEmbedding,
  ChatContext,
} from "./types/entities";

export type {
  AuthLoginRequest,
  AuthLoginResponse,
  AuthRefreshRequest,
  AuthTokenResponse,
  AuthMeResponse,
  OneDriveConnectRequest,
  OneDriveConnectStartResponse,
  OneDriveConnectResponse,
  OneDriveStatusResponse,
  OneDriveSyncRequest,
  OneDriveSyncResponse,
  OneDriveBrowseItem,
  OneDriveBrowseResponse,
  ProjectListResponse,
  CreateProjectRequest,
  CreateProjectResponse,
  UpdateProjectFolderRequest,
  UpdateProjectFolderResponse,
  ProjectDetailsResponse,
  ProjectFilesRequest,
  ProjectFilesResponse,
  CreateChatSessionRequest,
  CreateChatSessionResponse,
  ChatSessionsListResponse,
  SendChatMessageRequest,
  SendChatMessageResponse,
  ChatHistoryResponse,
  ChatHistoryTurn,
  OpenDocContext,
  ChatIntentLabel,
  ChatInterpretation,
  InterpretationFeedbackEvent,
  ProjectFeaturesResponse,
  UpdateProjectFeatureRequest,
  UpdateProjectFeatureResponse,
  FeaturesRegistryResponse,
  ErrorResponse,
} from "./types/api";

// ================================
// API CLIENT
// ================================
export {
  ApiClient,
  initApiClient,
  getApiClient,
  type ApiClientConfig,
} from "./api/client";

// ================================
// STATE STORES (Zustand)
// ================================
export {
  useAuthStore,
  type AuthState,
} from "./state/authStore";

export {
  useProjectsStore,
  type ProjectsState,
} from "./state/projectsStore";

export {
  useChatStore,
  type ChatState,
} from "./state/chatStore";

export {
  useFilesStore,
  type FilesState,
} from "./state/filesStore";

export {
  useFeaturesStore,
  type FeaturesState,
} from "./state/featuresStore";

// ================================
// FEATURE REGISTRY
// ================================
export {
  featureRegistry,
  FeatureRegistry,
  BUILTIN_FEATURES,
  type FeatureModule,
  type FeaturePlatform,
} from "./features/registry";
