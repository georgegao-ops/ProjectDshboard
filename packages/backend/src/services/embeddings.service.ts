import { getEnv } from "../config/env";

export interface EmbeddingResult {
  model: string;
  vector: number[];
}

export type EmbeddingErrorCode =
  | "embedding_auth"
  | "embedding_bad_request"
  | "embedding_rate_limit"
  | "embedding_provider_unavailable"
  | "embedding_timeout"
  | "embedding_network"
  | "embedding_invalid_response"
  | "embedding_unknown";

export class EmbeddingProviderError extends Error {
  constructor(
    public readonly code: EmbeddingErrorCode,
    public readonly retryable: boolean,
    message: string,
    public readonly statusCode?: number
  ) {
    super(message);
    this.name = "EmbeddingProviderError";
  }
}

export interface EmbeddingPreflightResult {
  ok: boolean;
  code?: EmbeddingErrorCode;
  message?: string;
}

const EMBEDDING_MAX_ATTEMPTS = 3;
const EMBEDDING_RETRY_BASE_MS = 300;
const EMBEDDING_REQUEST_TIMEOUT_MS = 30_000;

function classifyHttpStatus(status: number): {
  code: EmbeddingErrorCode;
  retryable: boolean;
} {
  if (status === 400 || status === 404 || status === 422) {
    return { code: "embedding_bad_request", retryable: false };
  }

  if (status === 401 || status === 403) {
    return { code: "embedding_auth", retryable: false };
  }

  if (status === 429) {
    return { code: "embedding_rate_limit", retryable: true };
  }

  if (status >= 500) {
    return { code: "embedding_provider_unavailable", retryable: true };
  }

  return { code: "embedding_unknown", retryable: false };
}

function asErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(attempt: number): number {
  const jitter = Math.floor(Math.random() * 150);
  return EMBEDDING_RETRY_BASE_MS * Math.pow(2, Math.max(0, attempt - 1)) + jitter;
}

async function requestEmbeddings(input: string | string[]): Promise<{
  model: string;
  vectors: number[][];
}> {
  const env = getEnv();
  const model = env.openAiEmbeddingModel;

  if (!env.openAiApiKey) {
    throw new EmbeddingProviderError(
      "embedding_auth",
      false,
      "OPENAI_API_KEY is not configured."
    );
  }

  if (typeof input === "string") {
    if (!input.trim()) {
      throw new EmbeddingProviderError("embedding_bad_request", false, "Embedding input cannot be empty.");
    }
  } else if (input.some((entry) => !entry.trim())) {
    throw new EmbeddingProviderError(
      "embedding_bad_request",
      false,
      "Embedding batch contains empty input values."
    );
  }

  let response: Response;
  try {
    response = await fetch(env.openAiEmbeddingEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.openAiApiKey}`,
      },
      body: JSON.stringify({
        model,
        input,
      }),
      signal: AbortSignal.timeout(EMBEDDING_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const message = asErrorMessage(error);
    if (message.toLowerCase().includes("timeout") || message.toLowerCase().includes("aborted")) {
      throw new EmbeddingProviderError("embedding_timeout", true, `Embedding timeout: ${message}`);
    }

    throw new EmbeddingProviderError("embedding_network", true, `Embedding network error: ${message}`);
  }

  if (!response.ok) {
    const body = await response.text();
    const details = body || response.statusText || "unknown provider failure";
    const classified = classifyHttpStatus(response.status);
    throw new EmbeddingProviderError(
      classified.code,
      classified.retryable,
      `Embedding provider error (${response.status}): ${details}`,
      response.status
    );
  }

  const payload = (await response.json()) as {
    data?: Array<{ embedding?: number[] }>;
    model?: string;
  };

  const vectors = payload.data?.map((entry) => entry.embedding ?? []) ?? [];
  const expectedLength = Array.isArray(input) ? input.length : 1;
  if (vectors.length !== expectedLength) {
    throw new EmbeddingProviderError(
      "embedding_invalid_response",
      false,
      "Embedding provider returned mismatched vector count."
    );
  }

  if (vectors.some((vector) => vector.length === 0)) {
    throw new EmbeddingProviderError(
      "embedding_invalid_response",
      false,
      "Embedding provider returned one or more empty vectors."
    );
  }

  return {
    model: payload.model ?? model,
    vectors,
  };
}

async function requestEmbeddingsWithRetry(input: string | string[]): Promise<{
  model: string;
  vectors: number[][];
}> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= EMBEDDING_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await requestEmbeddings(input);
    } catch (error) {
      lastError = error;

      if (!(error instanceof EmbeddingProviderError) || !error.retryable || attempt >= EMBEDDING_MAX_ATTEMPTS) {
        throw error;
      }

      await sleep(retryDelayMs(attempt));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new EmbeddingProviderError("embedding_unknown", false, "Unknown embedding failure.");
}

function shouldSplitBatchAfterFailure(error: unknown): boolean {
  if (!(error instanceof EmbeddingProviderError)) {
    return false;
  }

  return (
    error.code === "embedding_timeout" ||
    error.code === "embedding_network" ||
    error.code === "embedding_rate_limit" ||
    error.code === "embedding_provider_unavailable"
  );
}

async function embedBatchResilient(texts: string[]): Promise<EmbeddingResult[]> {
  const result = await requestEmbeddingsWithRetry(texts);

  return result.vectors.map((vector) => ({
    model: result.model,
    vector,
  }));
}

async function embedBatchWithFallback(texts: string[]): Promise<EmbeddingResult[]> {
  try {
    return await embedBatchResilient(texts);
  } catch (error) {
    if (texts.length <= 1 || !shouldSplitBatchAfterFailure(error)) {
      throw error;
    }

    const midpoint = Math.ceil(texts.length / 2);
    const firstHalf = texts.slice(0, midpoint);
    const secondHalf = texts.slice(midpoint);

    const [firstResults, secondResults] = await Promise.all([
      embedBatchWithFallback(firstHalf),
      embedBatchWithFallback(secondHalf),
    ]);

    return [...firstResults, ...secondResults];
  }
}

export const embeddingsService = {
  async preflight(): Promise<EmbeddingPreflightResult> {
    try {
      await requestEmbeddings("preflight-check");
      return { ok: true };
    } catch (error) {
      if (error instanceof EmbeddingProviderError) {
        return {
          ok: false,
          code: error.code,
          message: error.message,
        };
      }

      return {
        ok: false,
        code: "embedding_unknown",
        message: asErrorMessage(error),
      };
    }
  },

  async embedText(text: string): Promise<EmbeddingResult> {
    const [result] = await this.embedBatch([text]);
    return result;
  },

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    if (texts.length === 0) {
      return [];
    }

    return embedBatchWithFallback(texts);
  },
};
