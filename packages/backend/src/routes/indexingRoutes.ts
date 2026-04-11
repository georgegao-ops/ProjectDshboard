import { Router, Request, Response } from 'express';
import { IndexingOrchestrator } from '../services/indexingOrchestrator';
import { IndexingQueueWorker } from '../services/indexingQueueWorker';

const router = Router();

/**
 * POST /api/indexing/sync
 * Trigger a new sync for a project
 */
router.post('/sync', async (req: Request, res: Response) => {
  try {
    const { projectId, accessToken } = req.body;

    if (!projectId || !accessToken) {
      return res.status(400).json({
        error: 'Missing required fields: projectId, accessToken',
      });
    }

    const result = await IndexingOrchestrator.startIndexingSync(
      projectId,
      accessToken
    );

    res.json(result);
  } catch (error) {
    console.error('Sync error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to start sync',
    });
  }
});

/**
 * GET /api/indexing/sync/:syncJobId
 * Get status of a sync job
 */
router.get('/sync/:syncJobId', async (req: Request, res: Response) => {
  try {
    const { syncJobId } = req.params;
    const status = await IndexingOrchestrator.getSyncStatus(syncJobId);
    res.json(status);
  } catch (error) {
    console.error('Status error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get sync status',
    });
  }
});

/**
 * GET /api/indexing/projects/:projectId/stats
 * Get indexing statistics for a project
 */
router.get('/projects/:projectId/stats', async (req: Request, res: Response) => {
  try {
    const { projectId } = req.params;
    const stats = await IndexingOrchestrator.getProjectIndexingStats(projectId);
    res.json(stats);
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get project statistics',
    });
  }
});

/**
 * POST /api/indexing/files/:fileId/reindex
 * Reindex a specific file
 */
router.post('/files/:fileId/reindex', async (req: Request, res: Response) => {
  try {
    const { fileId } = req.params;
    const result = await IndexingOrchestrator.reindexFile(fileId);
    res.json(result);
  } catch (error) {
    console.error('Reindex error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to reindex file',
    });
  }
});

/**
 * POST /api/indexing/projects/:projectId/reindex
 * Reindex all files in a project
 */
router.post('/projects/:projectId/reindex', async (req: Request, res: Response) => {
  try {
    const { projectId } = req.params;
    const result = await IndexingOrchestrator.reindexProject(projectId);
    res.json(result);
  } catch (error) {
    console.error('Project reindex error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to reindex project',
    });
  }
});

/**
 * GET /api/indexing/projects/:projectId/failed
 * Get list of failed indexing jobs
 */
router.get('/projects/:projectId/failed', async (req: Request, res: Response) => {
  try {
    const { projectId } = req.params;
    const failed = await IndexingOrchestrator.getFailedIndexingJobs(projectId);
    res.json({ failed });
  } catch (error) {
    console.error('Failed jobs error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get failed jobs',
    });
  }
});

/**
 * GET /api/indexing/queue/stats
 * Get queue statistics
 */
router.get('/queue/stats', async (req: Request, res: Response) => {
  try {
    const stats = await IndexingQueueWorker.getQueueStats();
    res.json(stats);
  } catch (error) {
    console.error('Queue stats error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get queue statistics',
    });
  }
});

export default router;
