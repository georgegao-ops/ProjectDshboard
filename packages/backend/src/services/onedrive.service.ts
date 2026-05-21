import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  OneDriveConnectStartResponse,
  OneDriveBrowseResponse,
  OneDriveConnectRequest,
  OneDriveConnectResponse,
  OneDriveStatusResponse,
} from "@contractor/shared";
import {
  exchangeCodeForTokens,
  decodeIdToken,
  getAuthorizationUrl,
  refreshAccessToken,
  type TokenSet,
} from "../auth/oauth";
import { getEnv, hasMicrosoftOAuthConfig } from "../config/env";
import { getDbIfInitialized, onedriveConnections } from "../db";
import { AppError } from "../lib/errors";
import type { RequestUserContext } from "./service-types";
import { toUuid } from "./service-types";
import { eq } from "drizzle-orm";

const ONEDRIVE_SCOPES = ["offline_access", "Files.Read"] as const;
const STATE_TTL_MS = 1000 * 60 * 10;
const GRAPH_RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const GRAPH_MAX_ATTEMPTS = 4;
const GRAPH_BASE_DELAY_MS = 600;

interface OneDriveConnection {
  id?: string;
  userId: string;
  orgId: string;
  tenantId?: string;
  accountEmail?: string;
  driveId: string;
  driveType?: string;
  refreshToken: string;
  accessToken?: string;
  accessTokenExpiresAt?: number;
  connectedAt: Date;
  updatedAt?: Date;
  fileCount?: number;
}

export interface OneDriveFileMetadata {
  id: string;
  name: string;
  path: string;
  mimeType?: string;
  size?: number;
  eTag?: string;
  lastModified?: Date;
}

export interface OneDriveListFilesProgress {
  downloadedFileCount: number;
  currentFilePath: string;
}

export interface DownloadedOneDriveFile {
  tempFilePath: string;
  originalName: string;
  byteLength: number;
}

export interface OneDriveFileContent {
  buffer: Buffer;
  contentType?: string;
}

const connectionStates = new Map<
  string,
  { userId: string; redirectUri: string; createdAt: number }
>();
const connectionsByUser = new Map<string, OneDriveConnection>();

function buildStatus(connection?: OneDriveConnection): OneDriveStatusResponse {
  return {
    connected: Boolean(connection),
    syncInProgress: false,
    fileCount: connection?.fileCount ?? 0,
    accountEmail: connection?.accountEmail,
    tenantId: connection?.tenantId,
    driveId: connection?.driveId,
    driveType: connection?.driveType,
  };
}

function getGraphBaseUrl(): string {
  return getEnv().onedriveApiEndpoint.replace(/\/$/, "");
}

function requireUser(user?: RequestUserContext): RequestUserContext {
  if (!user) {
    throw new AppError(401, "unauthorized", "Unauthorized");
  }

  return user;
}

function ensureOAuthConfigured(): void {
  if (!hasMicrosoftOAuthConfig()) {
    throw new AppError(
      503,
      "oauth_not_configured",
      "Microsoft OAuth is not configured"
    );
  }
}

function isExpired(createdAt: number): boolean {
  return Date.now() - createdAt > STATE_TTL_MS;
}

async function fetchGraph(path: string, accessToken: string): Promise<Response> {
  return fetchGraphWithRetry(`${getGraphBaseUrl()}${path}`, accessToken);
}

async function fetchGraphAbsolute(url: string, accessToken: string): Promise<Response> {
  return fetchGraphWithRetry(url, accessToken);
}

async function waitMs(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getRetryDelayMs(response: Response | undefined, attempt: number): number {
  const retryAfterHeader = response?.headers.get("retry-after");
  const retryAfterSeconds = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : NaN;
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return retryAfterSeconds * 1000;
  }

  const exponentialBackoff = GRAPH_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1);
  return Math.min(8_000, exponentialBackoff);
}

async function fetchGraphWithRetry(url: string, accessToken: string): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= GRAPH_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      });

      if (!GRAPH_RETRYABLE_STATUS_CODES.has(response.status) || attempt === GRAPH_MAX_ATTEMPTS) {
        return response;
      }

      await waitMs(getRetryDelayMs(response, attempt));
      continue;
    } catch (error) {
      lastError = error;
      if (attempt === GRAPH_MAX_ATTEMPTS) {
        throw error;
      }

      await waitMs(getRetryDelayMs(undefined, attempt));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Graph request failed after retries.");
}

async function fetchGraphRaw(url: string, accessToken: string): Promise<Response> {
  return fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
}

async function exchangeRefreshToken(connection: OneDriveConnection): Promise<string> {
  const hasCachedToken =
    typeof connection.accessToken === "string" &&
    typeof connection.accessTokenExpiresAt === "number" &&
    connection.accessTokenExpiresAt > Date.now() + 10_000;

  if (hasCachedToken) {
    return connection.accessToken as string;
  }

  const refreshed = await refreshAccessToken(
    connection.refreshToken,
    Array.from(ONEDRIVE_SCOPES)
  );
  applyTokenSet(connection, refreshed);
  await persistConnection(connection);

  return refreshed.accessToken;
}

function applyTokenSet(connection: OneDriveConnection, tokenSet: TokenSet): void {
  connection.accessToken = tokenSet.accessToken;
  connection.refreshToken = tokenSet.refreshToken || connection.refreshToken;
  connection.accessTokenExpiresAt = Date.now() + tokenSet.expiresIn * 1000;
  connection.updatedAt = new Date();
}

function toConnectionFromDb(record: {
  id: string;
  orgId: string;
  userId: string;
  tenantId: string | null;
  accountEmail: string | null;
  driveId: string;
  driveType: string | null;
  refreshToken: string;
  accessTokenExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): OneDriveConnection {
  return {
    id: record.id,
    orgId: record.orgId,
    userId: record.userId,
    tenantId: record.tenantId ?? undefined,
    accountEmail: record.accountEmail ?? undefined,
    driveId: record.driveId,
    driveType: record.driveType ?? undefined,
    refreshToken: record.refreshToken,
    accessTokenExpiresAt: record.accessTokenExpiresAt?.getTime(),
    connectedAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

async function persistConnection(connection: OneDriveConnection): Promise<void> {
  const db = getDbIfInitialized();
  if (!db) {
    return;
  }

  await db
    .insert(onedriveConnections)
    .values({
      orgId: connection.orgId,
      userId: connection.userId,
      tenantId: connection.tenantId,
      accountEmail: connection.accountEmail,
      driveId: connection.driveId,
      driveType: connection.driveType,
      refreshToken: connection.refreshToken,
      accessTokenExpiresAt: connection.accessTokenExpiresAt
        ? new Date(connection.accessTokenExpiresAt)
        : null,
      createdAt: connection.connectedAt,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: onedriveConnections.userId,
      set: {
        orgId: connection.orgId,
        tenantId: connection.tenantId,
        accountEmail: connection.accountEmail,
        driveId: connection.driveId,
        driveType: connection.driveType,
        refreshToken: connection.refreshToken,
        accessTokenExpiresAt: connection.accessTokenExpiresAt
          ? new Date(connection.accessTokenExpiresAt)
          : null,
        updatedAt: new Date(),
      },
    });
}

async function loadConnectionForUser(userId: string): Promise<OneDriveConnection | undefined> {
  const inMemory = connectionsByUser.get(userId);
  if (inMemory) {
    return inMemory;
  }

  const db = getDbIfInitialized();
  if (!db) {
    return undefined;
  }

  const record = await db
    .select()
    .from(onedriveConnections)
    .where(eq(onedriveConnections.userId, toUuid(userId)))
    .limit(1);

  const row = record[0];
  if (!row) {
    return undefined;
  }

  const connection = toConnectionFromDb(row);
  connectionsByUser.set(userId, connection);
  return connection;
}

async function getConnectionOrThrow(
  user: RequestUserContext
): Promise<OneDriveConnection> {
  const connection = await loadConnectionForUser(user.id);

  if (!connection) {
    throw new AppError(
      412,
      "onedrive_not_connected",
      "OneDrive is not connected for this account"
    );
  }

  return connection;
}

export const onedriveService = {
  getConnectUrl(
    user: RequestUserContext | undefined,
    redirectUri?: string
  ): OneDriveConnectStartResponse {
    ensureOAuthConfigured();
    const authenticatedUser = requireUser(user);
    const resolvedRedirectUri = redirectUri ?? getEnv().oauthRedirectUri;
    const state = randomUUID();

    connectionStates.set(state, {
      userId: authenticatedUser.id,
      redirectUri: resolvedRedirectUri,
      createdAt: Date.now(),
    });

    return {
      authorizationUrl: getAuthorizationUrl(
        state,
        undefined,
        resolvedRedirectUri,
        Array.from(ONEDRIVE_SCOPES)
      ),
      state,
    };
  },

  async connect(
    request: OneDriveConnectRequest,
    user: RequestUserContext | undefined
  ): Promise<OneDriveConnectResponse> {
    ensureOAuthConfigured();
    const authenticatedUser = requireUser(user);

    if (!request.code) {
      throw new AppError(400, "onedrive_code_missing", "Missing OneDrive authorization code");
    }

    if (!request.state) {
      throw new AppError(400, "onedrive_state_missing", "Missing OneDrive OAuth state");
    }

    const stateRecord = connectionStates.get(request.state);
    if (!stateRecord || isExpired(stateRecord.createdAt)) {
      connectionStates.delete(request.state);
      throw new AppError(400, "invalid_oauth_state", "OAuth state is invalid or expired");
    }

    if (stateRecord.userId !== authenticatedUser.id) {
      throw new AppError(403, "oauth_state_mismatch", "OAuth state does not match current user");
    }

    // Consume the state before network I/O so duplicate callback attempts fail fast.
    connectionStates.delete(request.state);

    let tokenSet;
    try {
      tokenSet = await exchangeCodeForTokens(
        request.code,
        undefined,
        stateRecord.redirectUri,
        Array.from(ONEDRIVE_SCOPES)
      );
    } catch (error) {
      const details = error instanceof Error ? error.message : undefined;
      throw new AppError(
        401,
        "onedrive_oauth_exchange_failed",
        "OneDrive authorization could not be completed. Try connecting again.",
        details ? { details } : undefined
      );
    }

    const driveResponse = await fetchGraph(
      "/me/drive?$select=id,driveType,webUrl",
      tokenSet.accessToken
    );
    if (!driveResponse.ok) {
      const errorBody = await driveResponse.text();
      throw new AppError(
        502,
        "onedrive_validation_failed",
        `OneDrive validation failed: ${errorBody || driveResponse.statusText}`
      );
    }

    const driveData = (await driveResponse.json()) as {
      id?: string;
      driveType?: string;
    };

    if (!driveData.id) {
      throw new AppError(502, "onedrive_validation_failed", "OneDrive drive id missing");
    }

    const identityClaims = tokenSet.idToken ? decodeIdToken(tokenSet.idToken) : null;
    const emailClaim =
      typeof identityClaims?.preferred_username === "string"
        ? identityClaims.preferred_username
        : typeof identityClaims?.email === "string"
          ? identityClaims.email
          : authenticatedUser.email;
    const tenantClaim =
      typeof identityClaims?.tid === "string"
        ? identityClaims.tid
        : authenticatedUser.orgId;

    const connection: OneDriveConnection = {
      userId: authenticatedUser.id,
      orgId: authenticatedUser.orgId,
      tenantId: tenantClaim,
      accountEmail: emailClaim,
      driveId: driveData.id,
      driveType: driveData.driveType,
      refreshToken: tokenSet.refreshToken,
      connectedAt: new Date(),
    };
    applyTokenSet(connection, tokenSet);
    connectionsByUser.set(authenticatedUser.id, connection);
    await persistConnection(connection);

    return {
      connected: true,
      message: "OneDrive connected",
    };
  },

  async getStatus(user: RequestUserContext | undefined): Promise<OneDriveStatusResponse> {
    const authenticatedUser = requireUser(user);
    const connection = await loadConnectionForUser(authenticatedUser.id);

    return buildStatus(connection);
  },

  async browse(
    user: RequestUserContext | undefined,
    folderId?: string
  ): Promise<OneDriveBrowseResponse> {
    const authenticatedUser = requireUser(user);
    const connection = await getConnectionOrThrow(authenticatedUser);
    const accessToken = await exchangeRefreshToken(connection);

    const target = folderId
      ? `/me/drive/items/${encodeURIComponent(folderId)}/children?` +
        "$select=id,name,webUrl,folder,size,lastModifiedDateTime"
      : "/me/drive/root/children?$select=id,name,webUrl,folder,size,lastModifiedDateTime";

    const childrenResponse = await fetchGraph(target, accessToken);
    if (!childrenResponse.ok) {
      const errorBody = await childrenResponse.text();
      throw new AppError(
        502,
        "onedrive_browse_failed",
        `OneDrive browse failed: ${errorBody || childrenResponse.statusText}`
      );
    }

    const childrenData = (await childrenResponse.json()) as {
      value?: Array<{
        id: string;
        name: string;
        webUrl: string;
        folder?: Record<string, unknown>;
        size?: number;
        lastModifiedDateTime?: string;
      }>;
    };

    let parentId: string | undefined;
    if (folderId) {
      const folderResponse = await fetchGraph(
        `/me/drive/items/${encodeURIComponent(folderId)}?$select=id,parentReference`,
        accessToken
      );

      if (folderResponse.ok) {
        const folderData = (await folderResponse.json()) as {
          parentReference?: { id?: string };
        };
        parentId = folderData.parentReference?.id;
      }
    }

    const items = (childrenData.value ?? []).map((item) => ({
      id: item.id,
      name: item.name,
      isFolder: Boolean(item.folder),
      webUrl: item.webUrl,
      size: item.size,
      lastModified: item.lastModifiedDateTime
        ? new Date(item.lastModifiedDateTime)
        : undefined,
    }));

    connection.fileCount = items.length;
    await persistConnection(connection);

    return {
      items,
      parentId,
    };
  },

  async listFiles(
    user: RequestUserContext | undefined,
    rootFolderId: string,
    onProgress?: (progress: OneDriveListFilesProgress) => void
  ): Promise<OneDriveFileMetadata[]> {
    const authenticatedUser = requireUser(user);
    const connection = await getConnectionOrThrow(authenticatedUser);
    const accessToken = await exchangeRefreshToken(connection);
    const files: OneDriveFileMetadata[] = [];
    const stack: Array<{ folderId: string; pathPrefix: string }> = [
      { folderId: rootFolderId, pathPrefix: "" },
    ];

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) {
        continue;
      }

      let nextUrl =
        `${getGraphBaseUrl()}/me/drive/items/${encodeURIComponent(current.folderId)}/children?` +
        "$select=id,name,folder,file,size,eTag,lastModifiedDateTime";

      while (nextUrl) {
        const response = await fetchGraphAbsolute(nextUrl, accessToken);
        if (!response.ok) {
          const errorBody = await response.text();
          throw new AppError(
            502,
            "onedrive_sync_list_failed",
            `OneDrive list failed: ${errorBody || response.statusText}`
          );
        }

        const payload = (await response.json()) as {
          value?: Array<{
            id: string;
            name: string;
            folder?: Record<string, unknown>;
            file?: { mimeType?: string };
            size?: number;
            eTag?: string;
            lastModifiedDateTime?: string;
          }>;
          "@odata.nextLink"?: string;
        };

        for (const item of payload.value ?? []) {
          const itemPath = current.pathPrefix
            ? `${current.pathPrefix}/${item.name}`
            : item.name;

          if (item.folder) {
            stack.push({ folderId: item.id, pathPrefix: itemPath });
            continue;
          }

          files.push({
            id: item.id,
            name: item.name,
            path: itemPath,
            mimeType: item.file?.mimeType,
            size: item.size,
            eTag: item.eTag,
            lastModified: item.lastModifiedDateTime
              ? new Date(item.lastModifiedDateTime)
              : undefined,
          });

          onProgress?.({
            downloadedFileCount: files.length,
            currentFilePath: itemPath,
          });
        }

        nextUrl = payload["@odata.nextLink"] ?? "";
      }
    }

    connection.fileCount = files.length;
    await persistConnection(connection);

    return files;
  },

  async downloadFileToTemp(
    user: RequestUserContext | undefined,
    itemId: string,
    originalName: string
  ): Promise<DownloadedOneDriveFile> {
    const authenticatedUser = requireUser(user);
    const connection = await getConnectionOrThrow(authenticatedUser);
    const accessToken = await exchangeRefreshToken(connection);

    const response = await fetch(
      `${getGraphBaseUrl()}/me/drive/items/${encodeURIComponent(itemId)}/content`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    if (!response.ok) {
      const errorBody = await response.text();
      throw new AppError(
        502,
        "onedrive_download_failed",
        `OneDrive download failed: ${errorBody || response.statusText}`
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    const fileBuffer = Buffer.from(arrayBuffer);

    const tempDir = path.resolve(process.cwd(), ".tmp", "onedrive-indexing");
    await mkdir(tempDir, { recursive: true });

    const safeName = originalName.replace(/[^a-zA-Z0-9_.-]/g, "_");
    const tempFilePath = path.join(tempDir, `${randomUUID()}-${safeName || "file"}`);
    await writeFile(tempFilePath, fileBuffer);

    return {
      tempFilePath,
      originalName,
      byteLength: fileBuffer.length,
    };
  },

  async downloadFileContent(
    user: RequestUserContext | undefined,
    itemId: string
  ): Promise<OneDriveFileContent> {
    const authenticatedUser = requireUser(user);
    const connection = await getConnectionOrThrow(authenticatedUser);
    const accessToken = await exchangeRefreshToken(connection);

    const response = await fetch(
      `${getGraphBaseUrl()}/me/drive/items/${encodeURIComponent(itemId)}/content`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    if (!response.ok) {
      const errorBody = await response.text();
      throw new AppError(
        502,
        "onedrive_download_failed",
        `OneDrive download failed: ${errorBody || response.statusText}`
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      contentType: response.headers.get("content-type") ?? undefined,
    };
  },

  resetForTests(): void {
    connectionsByUser.clear();
    connectionStates.clear();
  },
};
