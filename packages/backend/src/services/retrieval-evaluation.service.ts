import type { SendChatMessageResponse, UUID } from "@contractor/shared";

export interface RetrievalEvaluationCase {
  query: string;
  expectedFileIds: UUID[];
}

export interface RetrievalCaseResult {
  query: string;
  expectedFileIds: UUID[];
  observedFileIds: UUID[];
  hitAtK: boolean;
  recall: number;
  reciprocalRank: number;
}

export interface RetrievalEvaluationSummary {
  total: number;
  hitRateAtK: number;
  meanRecall: number;
  meanReciprocalRank: number;
  results: RetrievalCaseResult[];
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function evaluateRetrievalCase(
  testCase: RetrievalEvaluationCase,
  sources: SendChatMessageResponse["sources"]
): RetrievalCaseResult {
  const expected = new Set(testCase.expectedFileIds);
  const observedFileIds = sources.map((source) => source.fileId);

  const matched = observedFileIds.filter((fileId) => expected.has(fileId));
  const recall = expected.size === 0 ? 1 : matched.length / expected.size;

  let reciprocalRank = 0;
  for (let index = 0; index < observedFileIds.length; index += 1) {
    if (expected.has(observedFileIds[index] as UUID)) {
      reciprocalRank = 1 / (index + 1);
      break;
    }
  }

  return {
    query: testCase.query,
    expectedFileIds: testCase.expectedFileIds,
    observedFileIds,
    hitAtK: matched.length > 0,
    recall: Number(recall.toFixed(3)),
    reciprocalRank: Number(reciprocalRank.toFixed(3)),
  };
}

export function evaluateRetrievalSet(
  cases: RetrievalEvaluationCase[],
  retrievalByQuery: Record<string, SendChatMessageResponse["sources"]>
): RetrievalEvaluationSummary {
  const results = cases.map((testCase) =>
    evaluateRetrievalCase(testCase, retrievalByQuery[testCase.query] ?? [])
  );

  return {
    total: results.length,
    hitRateAtK: Number(average(results.map((result) => (result.hitAtK ? 1 : 0))).toFixed(3)),
    meanRecall: Number(average(results.map((result) => result.recall)).toFixed(3)),
    meanReciprocalRank: Number(
      average(results.map((result) => result.reciprocalRank)).toFixed(3)
    ),
    results,
  };
}
