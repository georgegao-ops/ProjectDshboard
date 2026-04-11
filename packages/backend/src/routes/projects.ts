import { Router, Request, Response } from 'express';
import { Project } from '@contractor/shared';
import { FeaturesService } from '../services/featuresService';

const router = Router();

/**
 * GET /api/projects
 * Get all projects for the authenticated user
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    // TODO: Get projects from database for authenticated user
    const mockProjects: Project[] = [
      {
        id: '1',
        name: 'Building A - Phase 2',
        description: 'Commercial building project',
        status: 'active',
        progress: 65,
        startDate: '2024-01-15',
        endDate: '2025-06-30',
        budget: 500000,
        spent: 325000,
      },
      {
        id: '2',
        name: 'Building B - Foundation',
        description: 'Residential complex development',
        status: 'active',
        progress: 45,
        startDate: '2024-03-01',
        endDate: '2025-12-31',
        budget: 750000,
        spent: 337500,
      },
    ];

    res.json({ success: true, data: mockProjects });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'PROJECT_FETCH_ERROR',
        message: 'Failed to fetch projects',
      },
    });
  }
});

/**
 * GET /api/projects/:id
 * Get a specific project by ID
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    // TODO: Get project from database
    const mockProject: Project = {
      id,
      name: 'Building A',
      description: 'A commercial building project',
      status: 'active',
      progress: 65,
      startDate: '2024-01-15',
      endDate: '2025-06-30',
      budget: 500000,
      spent: 325000,
    };

    res.json({ success: true, data: mockProject });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'PROJECT_FETCH_ERROR',
        message: 'Failed to fetch project',
      },
    });
  }
});

/**
 * POST /api/projects
 * Create a new project
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, description, budget, endDate } = req.body;

    if (!name || !budget) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Name and budget are required',
        },
      });
      return;
    }

    // TODO: Create project in database
    const newProject: Project = {
      id: 'new-project-id',
      name,
      description,
      status: 'planning',
      progress: 0,
      startDate: new Date().toISOString().split('T')[0],
      endDate: endDate || '',
      budget,
      spent: 0,
    };

    res.status(201).json({ success: true, data: newProject });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'PROJECT_CREATE_ERROR',
        message: 'Failed to create project',
      },
    });
  }
});

/**
 * PATCH /api/projects/:id
 * Update a project
 */
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    // TODO: Update project in database
    res.json({ success: true, message: 'Project updated' });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'PROJECT_UPDATE_ERROR',
        message: 'Failed to update project',
      },
    });
  }
});

/**
 * DELETE /api/projects/:id
 * Delete a project
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    // TODO: Delete project from database
    res.json({ success: true, message: 'Project deleted' });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'PROJECT_DELETE_ERROR',
        message: 'Failed to delete project',
      },
    });
  }
});

/**
 * GET /api/projects/:id/files
 * Get indexed files for a project (paginated, filterable)
 */
router.get('/:id/files', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { page = '1', limit = '20', filter = '', sort = 'name' } = req.query;

    // TODO: Query files from database
    // TODO: Apply filters and sorting
    // TODO: Implement pagination

    const mockFiles = [
      {
        id: 'file-1',
        name: 'Floor Plan A.pdf',
        type: 'application/pdf',
        size: 2048000,
        uploadedAt: '2024-01-20T10:30:00Z',
        uploadedBy: 'user-123',
        indexed: true,
        metadata: {
          pages: 5,
          extractedElements: 45,
        },
      },
      {
        id: 'file-2',
        name: 'Material List.xlsx',
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        size: 512000,
        uploadedAt: '2024-01-19T14:15:00Z',
        uploadedBy: 'user-123',
        indexed: true,
        metadata: {
          rows: 150,
          materialsIdentified: 87,
        },
      },
    ];

    res.json({
      success: true,
      data: {
        projectId: id,
        files: mockFiles,
        pagination: {
          page: parseInt(page as string),
          limit: parseInt(limit as string),
          total: 2,
        },
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'FILES_FETCH_ERROR',
        message: 'Failed to fetch project files',
      },
    });
  }
});

/**
 * GET /api/projects/:id/features
 * Get enabled features for a project
 */
router.get('/:id/features', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const features = await FeaturesService.getProjectFeatures(id);

    res.json({
      success: true,
      data: {
        projectId: id,
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
 * Enable/disable or configure a feature for a project
 */
router.put('/:id/features/:fid', async (req: Request, res: Response) => {
  try {
    const { id, fid } = req.params;
    const { enabled, config } = req.body;

    // Validate configuration if provided
    if (config && !FeaturesService.validateFeatureConfig(fid, config)) {
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
      id,
      fid,
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
