import { createHealthService } from "./health.service";
import type { AppEnv } from "../config/env";

const BASE_TEST_ENV: AppEnv = {
  nodeEnv: "test",
  port: 3001,
  apiBaseUrl: "http://localhost:3001",
  deepseekChatModel: "deepseek-v3.2",
  deepseekChatEndpoint: "https://api.deepseek.com/v1/chat/completions",
  oauthRedirectUri: "http://localhost:3000/auth/callback",
  onedriveApiEndpoint: "https://graph.microsoft.com/v1.0",
  openAiEmbeddingModel: "text-embedding-3-small",
  openAiEmbeddingEndpoint: "https://api.openai.com/v1/embeddings",
  documentStorageProvider: "filesystem",
  documentStorageLocalRoot: ".tmp/document-storage-test",
  documentStorageEncryptionKeyVersion: 1,
  documentRetentionDaysDefault: 2555,
  chatActiveDocBoostEnabled: true,
  chatCitationFallbackEnabled: true,
  chatStrictFactualActiveDocMode: true,
  chatSectionProximityBoostEnabled: true,
  chatStrictCitationVerificationEnabled: true,
  chatRetrievalTraceEnabled: false,
  indexingExtractorPipelineV2Enabled: false,
  docParserTimeoutMs: 12000,
  retrievalHybridEnabled: false,
  retrievalBlendProfile: "balanced",
  retrievalRerankEnabled: false,
  retrievalRerankTopN: 20,
  retrievalRerankProvider: "none",
};

function createMockEnv(overrides?: Partial<AppEnv>): AppEnv {
  return {
    ...BASE_TEST_ENV,
    ...overrides,
  };
}

describe("healthService", () => {
  it("reports skipped queue health when redis is not configured", async () => {
    const service = createHealthService({
      getEnv: () => createMockEnv(),
      runDatabaseCheck: async () => undefined,
      createQueueClient: () => {
        throw new Error("queue client should not be created");
      },
    });

    const result = await service.getQueueHealth();

    expect(result.status).toBe("skipped");
    expect(result.details?.message).toBe("REDIS_URL is not configured");
  });

  it("reports queue health errors when redis ping fails", async () => {
    const service = createHealthService({
      getEnv: () => createMockEnv({ redisUrl: "redis://localhost:6379" }),
      runDatabaseCheck: async () => undefined,
      createQueueClient: () => ({
        connect: async () => undefined,
        ping: async () => {
          throw new Error("redis unavailable");
        },
        disconnect: async () => undefined,
      }),
    });

    const result = await service.getQueueHealth();

    expect(result.status).toBe("error");
    expect(result.details?.message).toContain("redis unavailable");
  });

  it("reports database health errors when the probe fails", async () => {
    const service = createHealthService({
      getEnv: () => createMockEnv(),
      runDatabaseCheck: async () => {
        throw new Error("db unavailable");
      },
      createQueueClient: () => ({
        connect: async () => undefined,
        ping: async () => undefined,
        disconnect: async () => undefined,
      }),
    });

    const result = await service.getDatabaseHealth();

    expect(result.status).toBe("error");
    expect(result.details?.message).toContain("db unavailable");
  });

  it("marks overall health degraded when queue checks are skipped", async () => {
    const service = createHealthService({
      getEnv: () => createMockEnv(),
      runDatabaseCheck: async () => undefined,
      createQueueClient: () => ({
        connect: async () => undefined,
        ping: async () => undefined,
        disconnect: async () => undefined,
      }),
    });

    const result = await service.getSystemHealth();

    expect(result.status).toBe("degraded");
    expect(result.dependencies.api.status).toBe("ok");
    expect(result.dependencies.database.status).toBe("ok");
    expect(result.dependencies.queue.status).toBe("skipped");
  });
});
