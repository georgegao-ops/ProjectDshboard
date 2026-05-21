import type {
  Feature,
  FeaturesRegistryResponse,
  ProjectFeaturesResponse,
  UpdateProjectFeatureResponse,
  UUID,
} from "@contractor/shared";
import { featureRegistry } from "@contractor/shared";
import { getEnv } from "../config/env";
import { logger } from "../lib/logger";

type RolloutFlagKey =
  | "INDEXING_EXTRACTOR_PIPELINE_V2_ENABLED"
  | "RETRIEVAL_HYBRID_ENABLED"
  | "RETRIEVAL_RERANK_ENABLED";

// Rollback switches are intentionally mapped 1:1 to env vars so operations can
// disable a rollout path without code changes or redeploy-time migrations.
const rolloutAuditCache = new Map<string, number>();
const ROLLOUT_AUDIT_TTL_MS = 30_000;

function shouldEmitRolloutAudit(projectId: UUID, flag: RolloutFlagKey, enabled: boolean): boolean {
  const key = `${projectId}:${flag}:${enabled ? "on" : "off"}`;
  const now = Date.now();
  const lastSeen = rolloutAuditCache.get(key);

  if (typeof lastSeen === "number" && now - lastSeen < ROLLOUT_AUDIT_TTL_MS) {
    return false;
  }

  rolloutAuditCache.set(key, now);
  return true;
}

function parseCanaryProjectIds(): Set<string> {
  return new Set(
    (process.env.CANARY_PROJECT_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function isGlobalRolloutEnabled(flag: RolloutFlagKey): boolean {
  const env = getEnv();
  if (flag === "INDEXING_EXTRACTOR_PIPELINE_V2_ENABLED") {
    return env.indexingExtractorPipelineV2Enabled;
  }
  if (flag === "RETRIEVAL_HYBRID_ENABLED") {
    return env.retrievalHybridEnabled;
  }
  return env.retrievalRerankEnabled;
}

function toFeature(module: (typeof featureRegistry)["getAll"] extends () => (infer T)[] ? T : never): Feature {
  return {
    id: module.id,
    name: module.name,
    icon: module.icon,
    route: module.route,
    description: module.description,
    enabled: module.defaultEnabled,
    sortOrder: module.order,
    config: module.config ?? {},
  };
}

export const featureService = {
  async getRegistry(): Promise<FeaturesRegistryResponse> {
    return {
      features: featureRegistry.getAllForPlatform("web").map(toFeature),
    };
  },

  async getProjectFeatures(projectId: UUID): Promise<ProjectFeaturesResponse> {
    return {
      features: featureRegistry.getAllForPlatform("web").map((module) => ({
        projectId,
        featureId: module.id,
        enabled: module.defaultEnabled,
        config: module.config ?? {},
        feature: toFeature(module),
      })),
    };
  },

  async updateProjectFeature(
    projectId: UUID,
    featureId: string,
    enabled: boolean,
    config?: Record<string, unknown>
  ): Promise<UpdateProjectFeatureResponse> {
    const module = featureRegistry.get(featureId);

    return {
      feature: {
        projectId,
        featureId,
        enabled,
        config: config ?? module?.config ?? {},
      },
    };
  },

  isRolloutFlagEnabledForProject(projectId: UUID, flag: RolloutFlagKey): boolean {
    const globallyEnabled = isGlobalRolloutEnabled(flag);
    if (!globallyEnabled) {
      if (shouldEmitRolloutAudit(projectId, flag, false)) {
        logger.info("feature.rollout.evaluated", {
          projectId,
          flag,
          enabled: false,
          reason: "global_flag_disabled",
        });
      }
      return false;
    }

    const canaryProjectIds = parseCanaryProjectIds();
    const canaryConfigured = canaryProjectIds.size > 0;
    const enabled = !canaryConfigured || canaryProjectIds.has(String(projectId));

    if (shouldEmitRolloutAudit(projectId, flag, enabled)) {
      logger.info("feature.rollout.evaluated", {
        projectId,
        flag,
        enabled,
        canaryConfigured,
        reason: enabled ? "project_in_canary_or_open_rollout" : "project_not_in_canary",
      });
    }

    return enabled;
  },
};
