import { Router, Request, Response } from 'express';
import { FeaturesService } from '../services/featuresService';

const router = Router();

/**
 * GET /api/features/registry
 * Get all available features
 */
router.get('/registry', async (req: Request, res: Response) => {
  try {
    const features = await FeaturesService.getFeatureRegistry();

    res.json({
      success: true,
      data: {
        features,
        count: features.length,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'REGISTRY_ERROR',
        message: 'Failed to fetch feature registry',
      },
    });
  }
});

/**
 * GET /api/projects/:id/features
 * Get enabled features for a project
 */
router.get('/:projectId/features', async (req: Request, res: Response) => {
  try {
    const { projectId } = req.params;

    const features = await FeaturesService.getProjectFeatures(projectId);

    res.json({
      success: true,
      data: {
        projectId,
        features,
        count: features.length,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'PROJECT_FEATURES_ERROR',
        message: 'Failed to fetch project features',
      },
    });
  }
});

/**
 * PUT /api/projects/:id/features/:fid
 * Enable/disable or configure a feature
 */
router.put('/:projectId/features/:featureId', async (req: Request, res: Response) => {
  try {
    const { projectId, featureId } = req.params;
    const { enabled, config } = req.body;

    // Validate configuration if provided
    if (config && !FeaturesService.validateFeatureConfig(featureId, config)) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_CONFIG',
          message: 'Invalid feature configuration',
        },
      });
      return;
    }

    const feature = await FeaturesService.updateProjectFeature(
      projectId,
      featureId,
      enabled ?? true,
      config
    );

    res.json({
      success: true,
      data: feature,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'FEATURE_UPDATE_ERROR',
        message: 'Failed to update feature',
      },
    });
  }
});

export default router;
