import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "../config/env";
import { logger } from "../lib/logger";
import { featureService } from "./feature.service";

describe("featureService rollout flags", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.CANARY_PROJECT_IDS;
    delete process.env.INDEXING_EXTRACTOR_PIPELINE_V2_ENABLED;
    delete process.env.RETRIEVAL_HYBRID_ENABLED;
    delete process.env.RETRIEVAL_RERANK_ENABLED;
    resetEnvCache();
  });

  it("disables rollout when global switch is off", () => {
    process.env.RETRIEVAL_HYBRID_ENABLED = "false";
    resetEnvCache();

    const enabled = featureService.isRolloutFlagEnabledForProject(
      "project-a" as any,
      "RETRIEVAL_HYBRID_ENABLED"
    );

    expect(enabled).toBe(false);
  });

  it("enables rollout only for canary projects when canary list is configured", () => {
    process.env.RETRIEVAL_HYBRID_ENABLED = "true";
    process.env.CANARY_PROJECT_IDS = "project-canary,project-b";
    resetEnvCache();

    const canaryEnabled = featureService.isRolloutFlagEnabledForProject(
      "project-canary" as any,
      "RETRIEVAL_HYBRID_ENABLED"
    );
    const nonCanaryEnabled = featureService.isRolloutFlagEnabledForProject(
      "project-other" as any,
      "RETRIEVAL_HYBRID_ENABLED"
    );

    expect(canaryEnabled).toBe(true);
    expect(nonCanaryEnabled).toBe(false);
  });

  it("logs rollout audit events for observability", () => {
    process.env.RETRIEVAL_RERANK_ENABLED = "true";
    process.env.CANARY_PROJECT_IDS = "project-canary";
    resetEnvCache();

    const infoSpy = vi.spyOn(logger, "info");

    featureService.isRolloutFlagEnabledForProject(
      "project-canary" as any,
      "RETRIEVAL_RERANK_ENABLED"
    );

    expect(infoSpy).toHaveBeenCalledWith(
      "feature.rollout.evaluated",
      expect.objectContaining({
        projectId: "project-canary",
        flag: "RETRIEVAL_RERANK_ENABLED",
        enabled: true,
      })
    );
  });
});
