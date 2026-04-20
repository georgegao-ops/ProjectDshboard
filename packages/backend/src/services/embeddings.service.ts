import { getEnv } from "../config/env";

export interface EmbeddingResult {
  model: string;
  vector: number[];
}

function deterministicEmbedding(input: string, dimensions = 256): number[] {
  const values = new Array<number>(dimensions).fill(0);
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    values[i % dimensions] += (code % 97) / 97;
  }

  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) {
    return values;
  }

  return values.map((value) => value / norm);
}

export const embeddingsService = {
  async embedText(text: string): Promise<EmbeddingResult> {
    const env = getEnv();
    const model = env.openAiEmbeddingModel;

    if (!env.openAiApiKey) {
      return {
        model: `${model}:deterministic-fallback`,
        vector: deterministicEmbedding(text),
      };
    }

    const response = await fetch(env.openAiEmbeddingEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.openAiApiKey}`,
      },
      body: JSON.stringify({
        model,
        input: text,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Embedding provider error: ${body || response.statusText}`);
    }

    const payload = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
      model?: string;
    };

    const vector = payload.data?.[0]?.embedding;
    if (!vector || vector.length === 0) {
      throw new Error("Embedding provider returned empty vector.");
    }

    return {
      model: payload.model ?? model,
      vector,
    };
  },

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    if (texts.length === 0) {
      return [];
    }

    const env = getEnv();
    const model = env.openAiEmbeddingModel;

    if (!env.openAiApiKey) {
      return texts.map((text) => ({
        model: `${model}:deterministic-fallback`,
        vector: deterministicEmbedding(text),
      }));
    }

    const response = await fetch(env.openAiEmbeddingEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.openAiApiKey}`,
      },
      body: JSON.stringify({
        model,
        input: texts,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Embedding provider error: ${body || response.statusText}`);
    }

    const payload = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
      model?: string;
    };

    const vectors = payload.data?.map((entry) => entry.embedding ?? []) ?? [];
    if (vectors.length !== texts.length) {
      throw new Error("Embedding provider returned mismatched vector count.");
    }

    return vectors.map((vector) => ({
      model: payload.model ?? model,
      vector,
    }));
  },
};
