import { describe, expect, it } from "vitest";
import { EmbeddingProviderError } from "./embeddings.service";
import { indexingServiceInternals } from "./indexing.service";

describe("indexingServiceInternals", () => {
  it("maps embedding auth failures to fatal embedding stage", () => {
    const error = new EmbeddingProviderError(
      "embedding_auth",
      false,
      "invalid key"
    );

    const failure = indexingServiceInternals.normalizeFailure(error, "pipeline");

    expect(failure.stage).toBe("embedding");
    expect(failure.code).toBe("embedding_auth");
    expect(failure.fatal).toBe(true);
  });

  it("redacts bearer tokens in error messages", () => {
    const redacted = indexingServiceInternals.redactSensitiveText(
      "request failed with Bearer sk-abcdef1234567890"
    );

    expect(redacted).not.toContain("sk-abcdef1234567890");
    expect(redacted).toContain("[REDACTED]");
  });

  it("groups failure rows by stage and error code", () => {
    const now = new Date();
    const rows = [
      {
        stage: "embedding",
        errorCode: "embedding_rate_limit",
        errorMessage: "rate limited",
        createdAt: now,
      },
      {
        stage: "embedding",
        errorCode: "embedding_rate_limit",
        errorMessage: "rate limited again",
        createdAt: new Date(now.getTime() + 1000),
      },
      {
        stage: "persistence",
        errorCode: "db_write_timeout",
        errorMessage: "timeout",
        createdAt: now,
      },
    ];

    const grouped = indexingServiceInternals.groupedFailureReasonsFromRows(rows);

    expect(grouped[0]).toMatchObject({
      stage: "embedding",
      errorCode: "embedding_rate_limit",
      count: 2,
    });
    expect(grouped[1]).toMatchObject({
      stage: "persistence",
      errorCode: "db_write_timeout",
      count: 1,
    });
  });
});
