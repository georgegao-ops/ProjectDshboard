import { Router, Request, Response } from 'express';
import { ChatService } from '../services/chatService';

const router = Router();

/**
 * POST /api/chat/sessions
 * Create new chat session
 */
router.post('/sessions', async (req: Request, res: Response) => {
  try {
    const { projectId, title } = req.body;
    const userId = 'current-user-id'; // TODO: Get from auth middleware

    if (!projectId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Project ID is required',
        },
      });
      return;
    }

    const session = await ChatService.createSession(userId, projectId, title);

    res.json({
      success: true,
      data: session,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'SESSION_CREATE_ERROR',
        message: 'Failed to create chat session',
      },
    });
  }
});

/**
 * GET /api/chat/sessions
 * List chat sessions
 */
router.get('/sessions', async (req: Request, res: Response) => {
  try {
    const { projectId } = req.query;
    const userId = 'current-user-id'; // TODO: Get from auth middleware

    const sessions = await ChatService.getSessions(
      userId,
      projectId as string | undefined
    );

    res.json({
      success: true,
      data: sessions,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'SESSION_FETCH_ERROR',
        message: 'Failed to fetch sessions',
      },
    });
  }
});

/**
 * POST /api/chat/sessions/:id/message
 * Send message and stream response
 */
router.post('/sessions/:id/message', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { message } = req.body;
    const userId = 'current-user-id'; // TODO: Get from auth middleware

    if (!message) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Message content is required',
        },
      });
      return;
    }

    // TODO: Get chatQueue from app.locals
    const chatQueue = req.app.locals.chatQueue;

    const messageId = await ChatService.sendMessage(id, userId, message, chatQueue);

    // TODO: Implement streaming response using Server-Sent Events or WebSocket
    // For now, return a basic response
    res.json({
      success: true,
      data: {
        messageId,
        sessionId: id,
        status: 'processing',
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'MESSAGE_ERROR',
        message: 'Failed to send message',
      },
    });
  }
});

/**
 * GET /api/chat/sessions/:id/messages
 * Get chat history
 */
router.get('/sessions/:id/messages', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { limit = '50', offset = '0' } = req.query;
    const userId = 'current-user-id'; // TODO: Get from auth middleware

    const messages = await ChatService.getMessages(
      id,
      userId,
      parseInt(limit as string),
      parseInt(offset as string)
    );

    res.json({
      success: true,
      data: {
        messages,
        sessionId: id,
        count: messages.length,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'HISTORY_ERROR',
        message: 'Failed to fetch message history',
      },
    });
  }
});

export default router;
