/**
 * Typed API Client — Used across all platforms (Web, iOS, Android)
 * Handles authentication, request/response serialization, and error handling
 */

import type {
  AuthLoginRequest,
  AuthLoginResponse,
  AuthTokenResponse,
  AuthMeResponse,
  OneDriveConnectRequest,
  OneDriveConnectResponse,
  OneDriveStatusResponse,
  OneDriveSyncRequest,
  OneDriveSyncResponse,
  OneDriveBrowseResponse,
  ProjectListResponse,
  CreateProjectRequest,
  CreateProjectResponse,
  ProjectDetailsResponse,
  ProjectFilesRequest,
  ProjectFilesResponse,
  CreateChatSessionRequest,
  CreateChatSessionResponse,
  ChatSessionsListResponse,
  SendChatMessageRequest,
  SendChatMessageResponse,
  ChatHistoryResponse,
  ProjectFeaturesResponse,
  UpdateProjectFeatureRequest,
  UpdateProjectFeatureResponse,
  FeaturesRegistryResponse,
  ErrorResponse,
} from "../types/api";
import type { UUID } from "../types/entities";

export interface ApiClientConfig {
  baseUrl: string;
  timeout?: number;
  onTokenRefresh?: (tokens: AuthTokenResponse) => void;
  onAuthError?: () => void;
}

export class ApiClient {
  private baseUrl: string;
  private timeout: number;
  private accessToken?: string;
  private storedRefreshToken?: string;
  private onTokenRefresh?: (tokens: AuthTokenResponse) => void;
  private onAuthError?: () => void;

  constructor(config: ApiClientConfig) {
    this.baseUrl = config.baseUrl;
    this.timeout = config.timeout || 30000;
    this.onTokenRefresh = config.onTokenRefresh;
    this.onAuthError = config.onAuthError;
  }

  private async request<T>(
    method: string,
    path: string,
    options?: { body?: unknown; query?: Record<string, string> }
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);

    if (options?.query) {
      Object.entries(options.query).forEach(([key, value]) => {
        url.searchParams.append(key, value);
      });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url.toString(), {
        method,
        headers: this.getHeaders(),
        body: options?.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        if (response.status === 401) {
          this.onAuthError?.();
          throw new Error("Unauthorized");
        }
        const error = (await response.json()) as ErrorResponse;
        throw new Error(error.message || "API Error");
      }

      return (await response.json()) as T;
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.accessToken) {
      headers.Authorization = `Bearer ${this.accessToken}`;
    }

    return headers;
  }

  setTokens(accessToken: string, refreshToken?: string): void {
    this.accessToken = accessToken;
    if (refreshToken) {
      this.storedRefreshToken = refreshToken;
    }
  }

  clearTokens(): void {
    this.accessToken = undefined;
    this.storedRefreshToken = undefined;
  }

  // ================================
  // AUTH
  // ================================

  async login(req: AuthLoginRequest): Promise<AuthLoginResponse> {
    return this.request<AuthLoginResponse>("POST", "/api/auth/login", {
      body: req,
    });
  }

  async refreshToken(): Promise<AuthTokenResponse> {
    if (!this.storedRefreshToken) {
      throw new Error("No refresh token available");
    }

    const response = await this.request<AuthTokenResponse>(
      "POST",
      "/api/auth/refresh",
      {
        body: { refreshToken: this.storedRefreshToken },
      }
    );

    this.setTokens(response.accessToken, this.storedRefreshToken);
    this.onTokenRefresh?.(response);

    return response;
  }

  async getMe(): Promise<AuthMeResponse> {
    return this.request<AuthMeResponse>("GET", "/api/auth/me");
  }

  // ================================
  // ONEDRIVE
  // ================================

  async connectOneDrive(req: OneDriveConnectRequest): Promise<OneDriveConnectResponse> {
    return this.request<OneDriveConnectResponse>("POST", "/api/onedrive/connect", {
      body: req,
    });
  }

  async getOneDriveStatus(): Promise<OneDriveStatusResponse> {
    return this.request<OneDriveStatusResponse>("GET", "/api/onedrive/status");
  }

  async syncOneDrive(req: OneDriveSyncRequest): Promise<OneDriveSyncResponse> {
    return this.request<OneDriveSyncResponse>("POST", "/api/onedrive/sync", {
      body: req,
    });
  }

  async browseOneDrive(folderId?: string): Promise<OneDriveBrowseResponse> {
    return this.request<OneDriveBrowseResponse>("GET", "/api/onedrive/browse", {
      query: folderId ? { folderId } : undefined,
    });
  }

  // ================================
  // PROJECTS
  // ================================

  async getProjects(): Promise<ProjectListResponse> {
    return this.request<ProjectListResponse>("GET", "/api/projects");
  }

  async createProject(req: CreateProjectRequest): Promise<CreateProjectResponse> {
    return this.request<CreateProjectResponse>("POST", "/api/projects", {
      body: req,
    });
  }

  async getProject(projectId: UUID): Promise<ProjectDetailsResponse> {
    return this.request<ProjectDetailsResponse>("GET", `/api/projects/${projectId}`);
  }

  async getProjectFiles(req: ProjectFilesRequest): Promise<ProjectFilesResponse> {
    return this.request<ProjectFilesResponse>(
      "GET",
      `/api/projects/${req.projectId}/files`,
      {
        query: {
          page: req.page?.toString() || "1",
          pageSize: req.pageSize?.toString() || "50",
          ...(req.search && { search: req.search }),
          ...(req.category && { category: req.category }),
          ...(req.tags && { tags: req.tags.join(",") }),
        },
      }
    );
  }

  // ================================
  // CHAT
  // ================================

  async createChatSession(
    req: CreateChatSessionRequest
  ): Promise<CreateChatSessionResponse> {
    return this.request<CreateChatSessionResponse>(
      "POST",
      "/api/chat/sessions",
      { body: req }
    );
  }

  async getChatSessions(): Promise<ChatSessionsListResponse> {
    return this.request<ChatSessionsListResponse>("GET", "/api/chat/sessions");
  }

  async sendChatMessage(
    req: SendChatMessageRequest
  ): Promise<SendChatMessageResponse> {
    return this.request<SendChatMessageResponse>(
      "POST",
      `/api/chat/sessions/${req.sessionId}/message`,
      { body: req }
    );
  }

  async getChatHistory(
    sessionId: UUID,
    page?: number,
    pageSize?: number
  ): Promise<ChatHistoryResponse> {
    return this.request<ChatHistoryResponse>(
      "GET",
      `/api/chat/sessions/${sessionId}/messages`,
      {
        query: {
          page: page?.toString() || "1",
          pageSize: pageSize?.toString() || "50",
        },
      }
    );
  }

  // ================================
  // FEATURES
  // ================================

  async getProjectFeatures(projectId: UUID): Promise<ProjectFeaturesResponse> {
    return this.request<ProjectFeaturesResponse>(
      "GET",
      `/api/projects/${projectId}/features`
    );
  }

  async updateProjectFeature(
    projectId: UUID,
    req: UpdateProjectFeatureRequest
  ): Promise<UpdateProjectFeatureResponse> {
    return this.request<UpdateProjectFeatureResponse>(
      "PUT",
      `/api/projects/${projectId}/features/${req.featureId}`,
      { body: req }
    );
  }

  async getFeaturesRegistry(): Promise<FeaturesRegistryResponse> {
    return this.request<FeaturesRegistryResponse>("GET", "/api/features/registry");
  }
}

/**
 * Singleton instance for use across the app
 */
let apiClient: ApiClient | undefined;

export function initApiClient(config: ApiClientConfig): ApiClient {
  apiClient = new ApiClient(config);
  return apiClient;
}

export function getApiClient(): ApiClient {
  if (!apiClient) {
    throw new Error("API client not initialized. Call initApiClient() first.");
  }
  return apiClient;
}
