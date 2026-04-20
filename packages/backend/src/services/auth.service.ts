import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type {
  AuthLoginRequest,
  AuthLoginResponse,
  AuthMeResponse,
  AuthTokenResponse,
  User,
} from "@contractor/shared";
import {
  decodeIdToken,
  exchangeCodeForTokens,
  getAuthorizationUrl,
  refreshAccessToken,
} from "../auth/oauth";
import { getEnv, hasMicrosoftOAuthConfig } from "../config/env";
import {
  authSessions,
  getDbIfInitialized,
  organizations,
  users,
} from "../db";
import { AppError } from "../lib/errors";
import type { RequestUserContext } from "./service-types";
import { toUuid } from "./service-types";

interface AuthSession {
  accessToken: string;
  refreshToken: string;
  microsoftRefreshToken: string;
  expiresIn: number;
  expiresAt: Date;
  user: User;
  organization: {
    id: string;
    name: string;
  };
}

const accessSessions = new Map<string, AuthSession>();
const refreshSessions = new Map<string, AuthSession>();
const oauthStates = new Map<string, { redirectUri: string; createdAt: number }>();
const APP_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function toDeterministicUuid(seed: string): string {
  const hash = createHash("sha256").update(seed).digest("hex");
  const base = hash.slice(0, 32).split("");
  base[12] = "4";
  const variantNibble = Number.parseInt(base[16], 16);
  base[16] = ((variantNibble & 0x3) | 0x8).toString(16);
  const compact = base.join("");

  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20, 32),
  ].join("-");
}

function normalizeUuidClaim(claim: unknown, fallbackSeed: string): string {
  if (typeof claim === "string" && UUID_PATTERN.test(claim)) {
    return claim;
  }

  const source = typeof claim === "string" && claim.length > 0
    ? claim
    : fallbackSeed;

  return toDeterministicUuid(source);
}

function buildUserFromIdToken(idToken?: string): AuthSession["user"] {
  const claims = idToken ? decodeIdToken(idToken) : null;
  const emailClaim = claims?.preferred_username ?? claims?.email;
  const email = typeof emailClaim === "string" ? emailClaim : "unknown@contractor.local";
  const displayNameClaim = claims?.name;
  const displayName = typeof displayNameClaim === "string" ? displayNameClaim : email;
  const userIdClaim = normalizeUuidClaim(claims?.oid ?? claims?.sub, `user:${email}`);
  const tenantSeed =
    typeof claims?.tid === "string" && claims.tid.length > 0
      ? claims.tid
      : `tenant:${email.split("@")[1] ?? "default-org"}`;
  const tenantIdClaim = normalizeUuidClaim(claims?.tid, tenantSeed);

  return {
    id: toUuid(String(userIdClaim)),
    email,
    name: displayName,
    orgId: toUuid(String(tenantIdClaim)),
    role: "admin",
    createdAt: new Date(),
  };
}

function createSession(
  user: User,
  microsoftRefreshToken: string,
  expiresIn: number
): AuthSession {
  const accessToken = randomUUID();
  const refreshToken = randomUUID();
  const organizationName = user.email.split("@")[1] ?? "Contractor Organization";

  const session: AuthSession = {
    accessToken,
    refreshToken,
    microsoftRefreshToken,
    expiresIn,
    expiresAt: new Date(Date.now() + APP_SESSION_TTL_MS),
    user,
    organization: {
      id: user.orgId,
      name: organizationName,
    },
  };

  accessSessions.set(accessToken, session);
  refreshSessions.set(refreshToken, session);

  return session;
}

async function persistSession(session: AuthSession): Promise<void> {
  const db = getDbIfInitialized();
  if (!db) {
    return;
  }

  await db
    .insert(organizations)
    .values({
      id: session.organization.id,
      name: session.organization.name,
    })
    .onConflictDoUpdate({
      target: organizations.id,
      set: {
        name: session.organization.name,
      },
    });

  const persistedUsers = await db
    .insert(users)
    .values({
      id: session.user.id,
      orgId: session.user.orgId,
      email: session.user.email,
      name: session.user.name,
      role: session.user.role,
      createdAt: session.user.createdAt,
    })
    .onConflictDoUpdate({
      target: users.email,
      set: {
        orgId: session.user.orgId,
        name: session.user.name,
        role: session.user.role,
      },
    })
    .returning({
      id: users.id,
      orgId: users.orgId,
    });

  const persistedUser = persistedUsers[0];
  if (persistedUser) {
    // Reuse canonical IDs from the DB to keep downstream FK writes consistent.
    session.user.id = toUuid(persistedUser.id);
    session.user.orgId = toUuid(persistedUser.orgId);
    session.organization.id = session.user.orgId;
  }

  await db
    .insert(authSessions)
    .values({
      id: session.accessToken,
      userId: session.user.id,
      refreshToken: session.refreshToken,
      microsoftRefreshToken: session.microsoftRefreshToken,
      microsoftAccessTokenExpiresAt: new Date(Date.now() + session.expiresIn * 1000),
      expiresAt: session.expiresAt,
      lastAccessedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: authSessions.id,
      set: {
        refreshToken: session.refreshToken,
        microsoftRefreshToken: session.microsoftRefreshToken,
        microsoftAccessTokenExpiresAt: new Date(Date.now() + session.expiresIn * 1000),
        expiresAt: session.expiresAt,
        lastAccessedAt: new Date(),
      },
    });
}

function sessionFromRecord(record: {
  id: string;
  refreshToken: string;
  microsoftRefreshToken: string;
  microsoftAccessTokenExpiresAt: Date | null;
  expiresAt: Date;
  user: {
    id: string;
    orgId: string;
    email: string;
    name: string;
    role: "super" | "admin" | "pm" | "member";
    createdAt: Date;
    organization: {
      id: string;
      name: string;
    };
  };
}): AuthSession {
  return {
    accessToken: record.id,
    refreshToken: record.refreshToken,
    microsoftRefreshToken: record.microsoftRefreshToken,
    expiresIn: Math.max(
      0,
      Math.floor(
        ((record.microsoftAccessTokenExpiresAt ?? new Date()).getTime() - Date.now()) / 1000
      )
    ),
    expiresAt: record.expiresAt,
    user: {
      id: toUuid(record.user.id),
      orgId: toUuid(record.user.orgId),
      email: record.user.email,
      name: record.user.name,
      role: record.user.role,
      createdAt: record.user.createdAt,
    },
    organization: {
      id: record.user.organization.id,
      name: record.user.organization.name,
    },
  };
}

async function getSessionByAccessToken(accessToken: string): Promise<AuthSession | undefined> {
  const inMemorySession = accessSessions.get(accessToken);
  if (inMemorySession) {
    if (inMemorySession.expiresAt.getTime() <= Date.now()) {
      accessSessions.delete(inMemorySession.accessToken);
      refreshSessions.delete(inMemorySession.refreshToken);
      return undefined;
    }

    return inMemorySession;
  }

  const db = getDbIfInitialized();
  if (!db) {
    return undefined;
  }

  const record = await db
    .select({
      sessionId: authSessions.id,
      sessionRefreshToken: authSessions.refreshToken,
      microsoftRefreshToken: authSessions.microsoftRefreshToken,
      microsoftAccessTokenExpiresAt: authSessions.microsoftAccessTokenExpiresAt,
      sessionExpiresAt: authSessions.expiresAt,
      userId: users.id,
      userOrgId: users.orgId,
      userEmail: users.email,
      userName: users.name,
      userRole: users.role,
      userCreatedAt: users.createdAt,
      organizationId: organizations.id,
      organizationName: organizations.name,
    })
    .from(authSessions)
    .innerJoin(users, eq(authSessions.userId, users.id))
    .innerJoin(organizations, eq(users.orgId, organizations.id))
    .where(
      and(
        eq(authSessions.id, accessToken),
        gt(authSessions.expiresAt, new Date())
      )
    )
    .limit(1);

  const row = record[0];
  if (!row) {
    return undefined;
  }

  const session = sessionFromRecord({
    id: row.sessionId,
    refreshToken: row.sessionRefreshToken,
    microsoftRefreshToken: row.microsoftRefreshToken,
    microsoftAccessTokenExpiresAt: row.microsoftAccessTokenExpiresAt,
    expiresAt: row.sessionExpiresAt,
    user: {
      id: row.userId,
      orgId: row.userOrgId,
      email: row.userEmail,
      name: row.userName,
      role: row.userRole,
      createdAt: row.userCreatedAt,
      organization: {
        id: row.organizationId,
        name: row.organizationName,
      },
    },
  });
  accessSessions.set(session.accessToken, session);
  refreshSessions.set(session.refreshToken, session);

  await db
    .update(authSessions)
    .set({ lastAccessedAt: new Date() })
    .where(eq(authSessions.id, session.accessToken));

  return session;
}

async function getSessionByRefreshToken(refreshToken: string): Promise<AuthSession | undefined> {
  const inMemorySession = refreshSessions.get(refreshToken);
  if (inMemorySession) {
    return inMemorySession;
  }

  const db = getDbIfInitialized();
  if (!db) {
    return undefined;
  }

  const record = await db
    .select({
      sessionId: authSessions.id,
      sessionRefreshToken: authSessions.refreshToken,
      microsoftRefreshToken: authSessions.microsoftRefreshToken,
      microsoftAccessTokenExpiresAt: authSessions.microsoftAccessTokenExpiresAt,
      sessionExpiresAt: authSessions.expiresAt,
      userId: users.id,
      userOrgId: users.orgId,
      userEmail: users.email,
      userName: users.name,
      userRole: users.role,
      userCreatedAt: users.createdAt,
      organizationId: organizations.id,
      organizationName: organizations.name,
    })
    .from(authSessions)
    .innerJoin(users, eq(authSessions.userId, users.id))
    .innerJoin(organizations, eq(users.orgId, organizations.id))
    .where(
      and(
        eq(authSessions.refreshToken, refreshToken),
        gt(authSessions.expiresAt, new Date())
      )
    )
    .limit(1);

  const row = record[0];
  if (!row) {
    return undefined;
  }

  const session = sessionFromRecord({
    id: row.sessionId,
    refreshToken: row.sessionRefreshToken,
    microsoftRefreshToken: row.microsoftRefreshToken,
    microsoftAccessTokenExpiresAt: row.microsoftAccessTokenExpiresAt,
    expiresAt: row.sessionExpiresAt,
    user: {
      id: row.userId,
      orgId: row.userOrgId,
      email: row.userEmail,
      name: row.userName,
      role: row.userRole,
      createdAt: row.userCreatedAt,
      organization: {
        id: row.organizationId,
        name: row.organizationName,
      },
    },
  });
  accessSessions.set(session.accessToken, session);
  refreshSessions.set(session.refreshToken, session);

  return session;
}

function replaceAccessToken(session: AuthSession): string {
  accessSessions.delete(session.accessToken);
  session.accessToken = randomUUID();
  session.expiresAt = new Date(Date.now() + APP_SESSION_TTL_MS);
  accessSessions.set(session.accessToken, session);
  return session.accessToken;
}

async function revokeSession(session: AuthSession): Promise<void> {
  accessSessions.delete(session.accessToken);
  refreshSessions.delete(session.refreshToken);

  const db = getDbIfInitialized();
  if (!db) {
    return;
  }

  await db.delete(authSessions).where(eq(authSessions.id, session.accessToken));
}

export const authService = {
  getLoginUrl(
    redirectUri?: string,
    prompt?: "select_account" | "login" | "consent"
  ): { authorizationUrl: string; state: string } {
    if (!hasMicrosoftOAuthConfig()) {
      throw new AppError(
        503,
        "oauth_not_configured",
        "Microsoft OAuth is not configured"
      );
    }

    const state = randomUUID();
    const resolvedRedirectUri = redirectUri ?? getEnv().oauthRedirectUri;
    oauthStates.set(state, {
      redirectUri: resolvedRedirectUri,
      createdAt: Date.now(),
    });

    return {
      authorizationUrl: getAuthorizationUrl(
        state,
        undefined,
        resolvedRedirectUri,
        undefined,
        prompt
      ),
      state,
    };
  },

  async login(request: AuthLoginRequest): Promise<AuthLoginResponse> {
    if (!request.code) {
      throw new AppError(400, "auth_code_missing", "Missing authorization code");
    }

    const stateRecord = request.state ? oauthStates.get(request.state) : undefined;
    if (request.state && !stateRecord) {
      throw new AppError(400, "invalid_oauth_state", "OAuth state is invalid or expired");
    }

    // Consume the state before network I/O so duplicate callback attempts fail fast.
    if (request.state) {
      oauthStates.delete(request.state);
    }

    const redirectUri = stateRecord?.redirectUri ?? request.redirectUri;
    if (!redirectUri) {
      throw new AppError(400, "redirect_uri_missing", "Redirect URI is required");
    }

    let tokenSet;
    try {
      tokenSet = await exchangeCodeForTokens(request.code, undefined, redirectUri);
    } catch (error) {
      const details = error instanceof Error ? error.message : undefined;
      throw new AppError(
        401,
        "oauth_exchange_failed",
        "Microsoft sign-in could not be completed. Start sign-in again.",
        details ? { details } : undefined
      );
    }
    const user = buildUserFromIdToken(tokenSet.idToken);
    const session = createSession(user, tokenSet.refreshToken, tokenSet.expiresIn);
    try {
      await persistSession(session);
    } catch (error) {
      const details = error instanceof Error ? error.message : undefined;
      throw new AppError(
        500,
        "auth_session_persist_failed",
        "Sign-in succeeded, but saving your local session failed. Please retry.",
        details ? { details } : undefined
      );
    }

    return {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresIn: tokenSet.expiresIn,
      user: session.user,
    };
  },

  async refresh(refreshToken: string): Promise<AuthTokenResponse> {
    if (!refreshToken) {
      throw new AppError(400, "refresh_token_missing", "Refresh token is required");
    }

    const session = await getSessionByRefreshToken(refreshToken);
    if (!session) {
      throw new AppError(401, "invalid_refresh_token", "Refresh token is invalid");
    }

    if (session.microsoftRefreshToken && hasMicrosoftOAuthConfig()) {
      const refreshedTokenSet = await refreshAccessToken(session.microsoftRefreshToken);
      session.microsoftRefreshToken = refreshedTokenSet.refreshToken;
      session.expiresIn = refreshedTokenSet.expiresIn;
    }

    const accessToken = replaceAccessToken(session);
    await persistSession(session);

    return {
      accessToken,
      expiresIn: session.expiresIn,
    };
  },

  async logout(accessToken?: string, refreshToken?: string): Promise<void> {
    if (accessToken) {
      const session = await getSessionByAccessToken(accessToken);
      if (session) {
        await revokeSession(session);
        return;
      }
    }

    if (refreshToken) {
      const session = await getSessionByRefreshToken(refreshToken);
      if (session) {
        await revokeSession(session);
      }
    }
  },

  async getRequestUser(token?: string): Promise<RequestUserContext | undefined> {
    if (!token) {
      return undefined;
    }

    const session = await getSessionByAccessToken(token);
    if (!session) {
      return undefined;
    }

    return {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      orgId: session.user.orgId,
      orgName: session.organization.name,
      role: session.user.role,
    };
  },

  async getCurrentUser(user?: RequestUserContext): Promise<AuthMeResponse> {
    if (!user) {
      throw new AppError(401, "unauthorized", "Unauthorized");
    }

    return {
      user: {
        id: toUuid(user.id),
        email: user.email,
        orgId: toUuid(user.orgId),
        name: user.name,
        role: user.role,
        createdAt: new Date(),
      },
      organization: {
        id: toUuid(user.orgId),
        name: user.orgName,
      },
    };
  },

  getConfigurationStatus(): { oauthConfigured: boolean } {
    return {
      oauthConfigured: hasMicrosoftOAuthConfig(),
    };
  },

  resetForTests(): void {
    accessSessions.clear();
    refreshSessions.clear();
    oauthStates.clear();
  },
};
