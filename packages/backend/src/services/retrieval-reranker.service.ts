import { tokenizeQuery, keywordHitScore } from "./text-ranking.utils";

export interface RerankCandidate {
  chunkId: string;
  chunkText: string;
  relevance: number;
}

export interface RerankResult<T> {
  candidates: T[];
  applied: boolean;
  durationMs: number;
  costEstimateTokens: number;
  provider: string;
}

function estimateTokenCost(query: string, candidates: Array<{ chunkText: string }>): number {
  const queryTokens = query.split(/\s+/).filter(Boolean).length;
  const candidateTokens = candidates.reduce((sum, candidate) => {
    return sum + candidate.chunkText.split(/\s+/).filter(Boolean).length;
  }, 0);
  return queryTokens + candidateTokens;
}

function heuristicRerank<T extends RerankCandidate>(query: string, candidates: T[], topN: number): T[] {
  const tokens = tokenizeQuery(query, 3, 12);
  const head = candidates
    .slice(0, topN)
    .map((candidate) => {
      const lexicalScore = tokens.length > 0 ? keywordHitScore(tokens, candidate.chunkText) / tokens.length : 0;
      const rerankScore = candidate.relevance * 0.65 + lexicalScore * 0.35;
      return {
        candidate,
        rerankScore,
      };
    })
    .sort((left, right) => right.rerankScore - left.rerankScore)
    .map((item) => item.candidate);

  const headIds = new Set(head.map((candidate) => candidate.chunkId));
  const tail = candidates
    .slice(topN)
    .filter((candidate) => !headIds.has(candidate.chunkId));

  return head.concat(tail);
}

export const retrievalRerankerService = {
  async rerank<T extends RerankCandidate>(input: {
    query: string;
    candidates: T[];
    topN: number;
    provider: string;
  }): Promise<RerankResult<T>> {
    const startedAt = Date.now();
    const limitedTopN = Math.max(1, Math.min(input.topN, input.candidates.length));
    const costEstimateTokens = estimateTokenCost(input.query, input.candidates.slice(0, limitedTopN));

    if (input.provider === "none") {
      return {
        candidates: input.candidates,
        applied: false,
        durationMs: Date.now() - startedAt,
        costEstimateTokens,
        provider: input.provider,
      };
    }

    if (input.provider === "heuristic") {
      return {
        candidates: heuristicRerank(input.query, input.candidates, limitedTopN),
        applied: true,
        durationMs: Date.now() - startedAt,
        costEstimateTokens,
        provider: input.provider,
      };
    }

    throw new Error(`unsupported_rerank_provider:${input.provider}`);
  },
};
