export interface AppEnv {
  nodeEnv: "development" | "test" | "production";
  port: number;
  apiBaseUrl: string;
  databaseUrl?: string;
  redisUrl?: string;
  microsoftClientId?: string;
  microsoftClientSecret?: string;
  microsoftTenantId?: string;
  oauthRedirectUri: string;
  onedriveApiEndpoint: string;
  openAiApiKey?: string;
  openAiEmbeddingModel: string;
  openAiEmbeddingEndpoint: string;
}

let cachedEnv: AppEnv | null = null;

export function resetEnvCache(): void {
  cachedEnv = null;
}

function parsePort(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "3001", 10);

  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`Invalid PORT value: ${value ?? "undefined"}`);
  }

  return parsed;
}

export function getEnv(): AppEnv {
  if (cachedEnv) {
    return cachedEnv;
  }

  const port = parsePort(process.env.PORT);
  const nodeEnv = (process.env.NODE_ENV ?? "development") as AppEnv["nodeEnv"];
  const apiBaseUrl = process.env.API_BASE_URL ?? `http://localhost:${port}`;

  cachedEnv = {
    nodeEnv,
    port,
    apiBaseUrl,
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: process.env.REDIS_URL,
    microsoftClientId: process.env.MICROSOFT_CLIENT_ID,
    microsoftClientSecret: process.env.MICROSOFT_CLIENT_SECRET,
    microsoftTenantId: process.env.MICROSOFT_TENANT_ID,
    oauthRedirectUri:
      process.env.OAUTH_REDIRECT_URI ?? "http://localhost:3000/auth/callback",
    onedriveApiEndpoint:
      process.env.ONEDRIVE_API_ENDPOINT ?? "https://graph.microsoft.com/v1.0",
    openAiApiKey: process.env.OPENAI_API_KEY,
    openAiEmbeddingModel: process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small",
    openAiEmbeddingEndpoint:
      process.env.OPENAI_EMBEDDING_ENDPOINT ?? "https://api.openai.com/v1/embeddings",
  };

  return cachedEnv;
}

export function hasMicrosoftOAuthConfig(env: AppEnv = getEnv()): boolean {
  return Boolean(env.microsoftClientId && env.microsoftClientSecret);
}

export function hasRedisConfig(env: AppEnv = getEnv()): boolean {
  return Boolean(env.redisUrl);
}
