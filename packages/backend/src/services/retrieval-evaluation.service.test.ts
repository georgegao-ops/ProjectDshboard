import type { UUID } from "@contractor/shared";
import { describe, expect, it } from "vitest";
import { evaluateRetrievalCase, evaluateRetrievalSet } from "./retrieval-evaluation.service";

function asUuid(value: string): UUID {
  return value as UUID;
}

describe("retrieval evaluation", () => {
  it("computes per-query retrieval metrics", () => {
    const result = evaluateRetrievalCase(
      {
        query: "Where is HVAC sequence of operations?",
        expectedFileIds: [asUuid("file-spec"), asUuid("file-rfi")],
      },
      [
        { fileId: asUuid("file-drawing"), fileName: "A101.pdf", relevance: 0.9 },
        { fileId: asUuid("file-spec"), fileName: "Section 23.pdf", relevance: 0.8 },
      ]
    );

    expect(result.hitAtK).toBe(true);
    expect(result.recall).toBe(0.5);
    expect(result.reciprocalRank).toBe(0.5);
  });

  it("aggregates retrieval metrics across an evaluation set", () => {
    const summary = evaluateRetrievalSet(
      [
        {
          query: "q1",
          expectedFileIds: [asUuid("file-1")],
        },
        {
          query: "q2",
          expectedFileIds: [asUuid("file-2")],
        },
      ],
      {
        q1: [{ fileId: asUuid("file-1"), fileName: "Spec.pdf", relevance: 0.9 }],
        q2: [{ fileId: asUuid("file-3"), fileName: "Other.pdf", relevance: 0.6 }],
      }
    );

    expect(summary.total).toBe(2);
    expect(summary.hitRateAtK).toBe(0.5);
    expect(summary.meanRecall).toBe(0.5);
    expect(summary.meanReciprocalRank).toBe(0.5);
  });
});
