export interface Feature {
  id: string;
  name: string;
  description: string;
  category: string;
  configurable: boolean;
  enabled: boolean;
  config?: Record<string, any>;
}

export interface ProjectFeature extends Feature {
  projectId: string;
  enabledAt?: string;
  enabledBy?: string;
}

export class FeaturesService {
  // Feature Registry - all available features
  private static FEATURE_REGISTRY: Feature[] = [
    {
      id: 'material-extraction',
      name: 'Material Extraction',
      description: 'Automatically extract and categorize materials from documents',
      category: 'extraction',
      configurable: true,
      enabled: true,
      config: {
        minConfidence: 0.75,
        autoAssign: true,
      },
    },
    {
      id: 'cost-estimation',
      name: 'Cost Estimation',
      description: 'Calculate project costs based on extracted materials',
      category: 'estimation',
      configurable: true,
      enabled: true,
      config: {
        currency: 'USD',
        includeLabor: true,
        laborCostPerHour: 50,
      },
    },
    {
      id: 'timeline-generation',
      name: 'Timeline Generation',
      description: 'Generate project timeline based on scope',
      category: 'planning',
      configurable: true,
      enabled: true,
      config: {
        allowWebSearch: true,
        riskFactor: 1.2,
      },
    },
    {
      id: 'design-suggestions',
      name: 'Design Suggestions',
      description: 'AI-powered design and material suggestions',
      category: 'ai',
      configurable: false,
      enabled: false,
    },
    {
      id: 'team-collaboration',
      name: 'Team Collaboration',
      description: 'Real-time collaboration features for teams',
      category: 'collaboration',
      configurable: true,
      enabled: true,
      config: {
        maxTeamSize: 10,
        allowComments: true,
        allowVersionControl: true,
      },
    },
    {
      id: 'export-reports',
      name: 'Export Reports',
      description: 'Generate and export project reports',
      category: 'reporting',
      configurable: true,
      enabled: true,
      config: {
        formats: ['pdf', 'excel', 'html'],
        includeCharts: true,
        includeBudget: true,
      },
    },
  ];

  /**
   * Get all available features in the registry
   */
  static async getFeatureRegistry(): Promise<Feature[]> {
    return this.FEATURE_REGISTRY;
  }

  /**
   * Get enabled features for a project
   */
  static async getProjectFeatures(projectId: string): Promise<ProjectFeature[]> {
    try {
      // TODO: Query project features from database
      // Return features that are enabled for this project
      // Include their configuration
      return [];
    } catch (error) {
      throw new Error('Failed to fetch project features');
    }
  }

  /**
   * Enable/disable or configure a feature for a project
   */
  static async updateProjectFeature(
    projectId: string,
    featureId: string,
    enabled: boolean,
    config?: Record<string, any>
  ): Promise<ProjectFeature> {
    try {
      // TODO: Validate feature exists in registry
      const featureInRegistry = this.FEATURE_REGISTRY.find(f => f.id === featureId);
      if (!featureInRegistry) {
        throw new Error('Feature not found in registry');
      }

      // TODO: Update or insert feature configuration in database
      // TODO: Log the change for audit purposes
      // TODO: Notify relevant services of feature enablement/disablement

      const projectFeature: ProjectFeature = {
        ...featureInRegistry,
        projectId,
        enabled,
        config: config || featureInRegistry.config,
        enabledAt: enabled ? new Date().toISOString() : undefined,
        enabledBy: 'current-user', // TODO: Get from auth context
      };

      return projectFeature;
    } catch (error) {
      throw new Error('Failed to update project feature');
    }
  }

  /**
   * Validate feature configuration
   */
  static validateFeatureConfig(featureId: string, config: Record<string, any>): boolean {
    try {
      const feature = this.FEATURE_REGISTRY.find(f => f.id === featureId);
      if (!feature) {
        return false;
      }

      if (!feature.configurable && config && Object.keys(config).length > 0) {
        return false;
      }

      // TODO: Add detailed validation per feature type
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get feature availability based on project plan
   */
  static async getAvailableFeatures(projectPlan: 'free' | 'pro' | 'enterprise'): Promise<Feature[]> {
    const planFeatureAccess: Record<string, string[]> = {
      free: ['material-extraction', 'team-collaboration'],
      pro: [
        'material-extraction',
        'cost-estimation',
        'timeline-generation',
        'team-collaboration',
        'export-reports',
      ],
      enterprise: [
        'material-extraction',
        'cost-estimation',
        'timeline-generation',
        'design-suggestions',
        'team-collaboration',
        'export-reports',
      ],
    };

    const availableFeatureIds = planFeatureAccess[projectPlan] || [];
    return this.FEATURE_REGISTRY.filter(f => availableFeatureIds.includes(f.id));
  }
}
