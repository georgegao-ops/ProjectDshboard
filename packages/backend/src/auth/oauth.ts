/**
 * Microsoft OAuth2 Configuration
 * Handles authentication flow with Microsoft Azure AD
 */

import { getEnv } from "../config/env";

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  authority: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  expiresIn: number;
  tokenType: string;
  scope: string;
}

/**
 * Get OAuth configuration from environment
 */
export function getOAuthConfig(): OAuthConfig {
  const env = getEnv();
  const config: OAuthConfig = {
    clientId: env.microsoftClientId || "",
    clientSecret: env.microsoftClientSecret || "",
    redirectUri: env.oauthRedirectUri,
    scopes: [
      "openid",
      "profile",
      "email",
      "offline_access", // for refresh token
      "Files.Read", // OneDrive read access
    ],
    authority: `https://login.microsoftonline.com/${env.microsoftTenantId ?? "common"}`,
  };

  if (!config.clientId || !config.clientSecret) {
    throw new Error(
      "Missing MICROSOFT_CLIENT_ID or MICROSOFT_CLIENT_SECRET environment variables"
    );
  }

  return config;
}

/**
 * Construct OAuth authorization URL
 */
export function getAuthorizationUrl(
  state: string,
  codeChallenge?: string,
  redirectUri?: string,
  scopes?: string[],
  prompt?: "select_account" | "login" | "consent"
): string {
  const config = getOAuthConfig();
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri ?? config.redirectUri,
    response_type: "code",
    scope: (scopes ?? config.scopes).join(" "),
    state,
    ...(prompt && { prompt }),
    ...(codeChallenge && {
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    }),
  });

  return `${config.authority}/oauth2/v2.0/authorize?${params.toString()}`;
}

/**
 * Exchange authorization code for tokens
 * Call this endpoint: https://login.microsoftonline.com/common/oauth2/v2.0/token
 */
export async function exchangeCodeForTokens(
  code: string,
  codeVerifier?: string,
  redirectUri?: string,
  scopes?: string[]
): Promise<TokenSet> {
  const config = getOAuthConfig();

  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: redirectUri ?? config.redirectUri,
    grant_type: "authorization_code",
    scope: (scopes ?? config.scopes).join(" "),
    ...(codeVerifier && { code_verifier: codeVerifier }),
  });

  const response = await fetch(
    "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OAuth token exchange failed: ${error}`);
  }

  const data = await response.json() as {
    access_token: string;
    refresh_token?: string;
    id_token?: string;
    expires_in: number;
    token_type: string;
    scope: string;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || "",
    idToken: data.id_token,
    expiresIn: data.expires_in,
    tokenType: data.token_type,
    scope: data.scope,
  };
}

/**
 * Refresh an access token using refresh token
 */
export async function refreshAccessToken(
  refreshToken: string,
  scopes?: string[]
): Promise<TokenSet> {
  const config = getOAuthConfig();

  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
    scope: (scopes ?? config.scopes).join(" "),
  });

  const response = await fetch(
    "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to refresh token: ${error}`);
  }

  const data = await response.json() as {
    access_token: string;
    refresh_token?: string;
    id_token?: string;
    expires_in: number;
    token_type: string;
    scope: string;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    idToken: data.id_token,
    expiresIn: data.expires_in,
    tokenType: data.token_type,
    scope: data.scope,
  };
}

/**
 * Verify and decode JWT token (basic validation)
 * For production, consider using jwt-verify library
 */
export function decodeIdToken(
  idToken: string
): Record<string, unknown> | null {
  try {
    // JWT format: header.payload.signature
    const parts = idToken.split(".");
    if (parts.length !== 3) return null;

    const payload = Buffer.from(parts[1], "base64").toString();
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return null;
  }
}
