import { describe, expect, it } from "vitest";
import { retrievalRerankerService } from "./retrieval-reranker.service";

describe("retrievalRerankerService", () => {
  it("reorders top candidates with heuristic provider", async () => {
    const result = await retrievalRerankerService.rerank({
      query: "expansion joint specification",
      provider: "heuristic",
      topN: 2,
      candidates: [
        {
          chunkId: "a",
          chunkText: "Administrative intro text only.",
          relevance: 0.85,
        },
        {
          chunkId: "b",
          chunkText: "Expansion joint specification details and requirements.",
          relevance: 0.6,
        },
      ],
    });

    expect(result.applied).toBe(true);
    expect(result.candidates[0]?.chunkId).toBe("b");
    expect(result.costEstimateTokens).toBeGreaterThan(0);
  });

  it("throws for unsupported providers so caller can fallback safely", async () => {
    await expect(
      retrievalRerankerService.rerank({
        query: "q",
        provider: "unknown-provider",
        topN: 1,
        candidates: [
          {
            chunkId: "a",
            chunkText: "text",
            relevance: 0.5,
          },
        ],
      })
    ).rejects.toThrow("unsupported_rerank_provider");
  });
});
