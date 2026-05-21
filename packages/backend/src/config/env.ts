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
  geminiApiKey?: string;
  geminiChatModel?: string;
  geminiChatEndpoint?: string;
  deepseekApiKey?: string;
  deepseekChatModel: string;
  deepseekChatEndpoint: string;
  openAiApiKey?: string;
  openAiChatModel?: string;
  openAiChatEndpoint?: string;
  openAiEmbeddingModel: string;
  openAiEmbeddingEndpoint: string;
  documentStorageProvider: "filesystem";
  documentStorageLocalRoot: string;
  documentStorageEncryptionKey?: string;
  documentStorageEncryptionKeyVersion: number;
  documentRetentionDaysDefault: number;
  chatActiveDocBoostEnabled: boolean;
  chatCitationFallbackEnabled: boolean;
  chatStrictFactualActiveDocMode: boolean;
  chatSectionProximityBoostEnabled: boolean;
  chatStrictCitationVerificationEnabled: boolean;
  chatRetrievalTraceEnabled: boolean;
  indexingExtractorPipelineV2Enabled: boolean;
  docParserTimeoutMs: number;
  docParserEndpoint?: string;
  retrievalHybridEnabled: boolean;
  retrievalBlendProfile: "balanced" | "lexical_heavy" | "semantic_heavy";
  retrievalRerankEnabled: boolean;
  retrievalRerankTopN: number;
  retrievalRerankProvider: string;
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

function parseBooleanFlag(value: string | undefined, defaultValue: boolean): boolean {
  if (typeof value !== "string") {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

export function getEnv(): AppEnv {
  if (cachedEnv) {
    return cachedEnv;
  }

  const port = parsePort(process.env.PORT);
  const nodeEnv = (process.env.NODE_ENV ?? "development") as AppEnv["nodeEnv"];
  const apiBaseUrl = process.env.API_BASE_URL ?? `http://localhost:${port}`;
  const encryptionKeyVersion = Number.parseInt(
    process.env.DOCUMENT_STORAGE_ENCRYPTION_KEY_VERSION ?? "1",
    10
  );
  const retentionDays = Number.parseInt(
    process.env.DOCUMENT_RETENTION_DAYS_DEFAULT ?? "2555",
    10
  );
  const docParserTimeoutMs = Number.parseInt(process.env.DOC_PARSER_TIMEOUT_MS ?? "12000", 10);
  const retrievalRerankTopN = Number.parseInt(process.env.RETRIEVAL_RERANK_TOP_N ?? "20", 10);
  const retrievalBlendProfileRaw = (process.env.RETRIEVAL_BLEND_PROFILE ?? "balanced").trim().toLowerCase();
  const retrievalBlendProfile: AppEnv["retrievalBlendProfile"] =
    retrievalBlendProfileRaw === "lexical_heavy" || retrievalBlendProfileRaw === "semantic_heavy"
      ? retrievalBlendProfileRaw
      : "balanced";

  const geminiApiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  const geminiChatModel = process.env.GEMINI_CHAT_MODEL ?? "gemini-2.5-flash";
  const geminiChatEndpoint =
    process.env.GEMINI_CHAT_ENDPOINT ??
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

  // DeepSeek-native variables with OPENAI_* compatibility fallback.
  const deepseekApiKey = process.env.DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY;
  const deepseekChatModel =
    process.env.DEEPSEEK_CHAT_MODEL ??
    process.env.OPENAI_CHAT_MODEL ??
    "deepseek-v3.2";
  const deepseekChatEndpoint =
    process.env.DEEPSEEK_CHAT_ENDPOINT ??
    process.env.OPENAI_CHAT_ENDPOINT ??
    "https://api.deepseek.com/v1/chat/completions";

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
    geminiApiKey,
    geminiChatModel,
    geminiChatEndpoint,
    deepseekApiKey,
    deepseekChatModel,
    deepseekChatEndpoint,
    // Backward-compatible aliases used by existing services.
    openAiApiKey: deepseekApiKey,
    openAiChatModel: deepseekChatModel,
    openAiChatEndpoint: deepseekChatEndpoint,
    openAiEmbeddingModel: process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small",
    openAiEmbeddingEndpoint:
      process.env.OPENAI_EMBEDDING_ENDPOINT ?? "https://api.openai.com/v1/embeddings",
    documentStorageProvider: "filesystem",
    documentStorageLocalRoot:
      process.env.DOCUMENT_STORAGE_LOCAL_ROOT ?? ".tmp/document-storage",
    documentStorageEncryptionKey: process.env.DOCUMENT_STORAGE_ENCRYPTION_KEY,
    documentStorageEncryptionKeyVersion:
      Number.isNaN(encryptionKeyVersion) || encryptionKeyVersion < 1 ? 1 : encryptionKeyVersion,
    documentRetentionDaysDefault:
      Number.isNaN(retentionDays) || retentionDays < 1 ? 2555 : retentionDays,
    chatActiveDocBoostEnabled: parseBooleanFlag(process.env.CHAT_ACTIVE_DOC_BOOST_ENABLED, true),
    chatCitationFallbackEnabled: parseBooleanFlag(process.env.CHAT_CITATION_FALLBACK_ENABLED, true),
    chatStrictFactualActiveDocMode: parseBooleanFlag(process.env.CHAT_STRICT_FACTUAL_ACTIVE_DOC_MODE, true),
    chatSectionProximityBoostEnabled: parseBooleanFlag(process.env.CHAT_SECTION_PROXIMITY_BOOST_ENABLED, true),
    chatStrictCitationVerificationEnabled: parseBooleanFlag(process.env.CHAT_STRICT_CITATION_VERIFICATION_ENABLED, true),
    chatRetrievalTraceEnabled: parseBooleanFlag(process.env.CHAT_RETRIEVAL_TRACE_ENABLED, false),
    indexingExtractorPipelineV2Enabled: parseBooleanFlag(process.env.INDEXING_EXTRACTOR_PIPELINE_V2_ENABLED, false),
    docParserTimeoutMs: Number.isNaN(docParserTimeoutMs) || docParserTimeoutMs < 500 ? 12000 : docParserTimeoutMs,
    docParserEndpoint: process.env.DOC_PARSER_ENDPOINT,
    retrievalHybridEnabled: parseBooleanFlag(process.env.RETRIEVAL_HYBRID_ENABLED, false),
    retrievalBlendProfile,
    retrievalRerankEnabled: parseBooleanFlag(process.env.RETRIEVAL_RERANK_ENABLED, false),
    retrievalRerankTopN: Number.isNaN(retrievalRerankTopN) || retrievalRerankTopN < 1 ? 20 : retrievalRerankTopN,
    retrievalRerankProvider: process.env.RETRIEVAL_RERANK_PROVIDER ?? "none",
  };

  return cachedEnv;
}

export function hasMicrosoftOAuthConfig(env: AppEnv = getEnv()): boolean {
  return Boolean(env.microsoftClientId && env.microsoftClientSecret);
}

export function hasRedisConfig(env: AppEnv = getEnv()): boolean {
  return Boolean(env.redisUrl);
}
