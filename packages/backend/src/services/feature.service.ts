import type {
  Feature,
  FeaturesRegistryResponse,
  ProjectFeaturesResponse,
  UpdateProjectFeatureResponse,
  UUID,
} from "@contractor/shared";
import { featureRegistry } from "@contractor/shared";

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
};
