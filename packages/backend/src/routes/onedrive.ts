import { Router, Request, Response } from 'express';
import { OneDriveService } from '../services/oneDriveService';

const router = Router();

/**
 * POST /api/onedrive/connect
 * Initiate OAuth and store tokens
 */
router.post('/connect', async (req: Request, res: Response) => {
  try {
    const { authCode } = req.body;
    const userId = 'current-user-id'; // TODO: Get from auth middleware

    if (!authCode) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Authorization code is required',
        },
      });
      return;
    }

    const token = await OneDriveService.connectOneDrive(userId, authCode);

    res.json({
      success: true,
      data: {
        connected: true,
        message: 'OneDrive connected successfully',
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'ONEDRIVE_CONNECT_ERROR',
        message: 'Failed to connect OneDrive',
      },
    });
  }
});

/**
 * GET /api/onedrive/status
 * Get connection and sync status
 */
router.get('/status', async (req: Request, res: Response) => {
  try {
    const userId = 'current-user-id'; // TODO: Get from auth middleware

    const status = await OneDriveService.getConnectionStatus(userId);

    res.json({
      success: true,
      data: status,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'STATUS_ERROR',
        message: 'Failed to fetch status',
      },
    });
  }
});

/**
 * POST /api/onedrive/sync
 * Trigger manual sync
 */
router.post('/sync', async (req: Request, res: Response) => {
  try {
    const { folderId } = req.body;
    const userId = 'current-user-id'; // TODO: Get from auth middleware

    if (!folderId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Folder ID is required',
        },
      });
      return;
    }

    const result = await OneDriveService.triggerSync(userId, folderId);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'SYNC_ERROR',
        message: 'Failed to trigger sync',
      },
    });
  }
});

/**
 * GET /api/onedrive/browse
 * Browse OneDrive folders and files
 */
router.get('/browse', async (req: Request, res: Response) => {
  try {
    const { folderId = 'root' } = req.query;
    const userId = 'current-user-id'; // TODO: Get from auth middleware

    const files = await OneDriveService.browseFolders(userId, folderId as string);

    res.json({
      success: true,
      data: {
        files,
        folderId,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'BROWSE_ERROR',
        message: 'Failed to browse folders',
      },
    });
  }
});

export default router;
