/**
 * 6.6 Chat/RAG WebSocket Routes
 * Real-time streaming responses for chat queries
 */

import { Router, Request, Response } from 'express';
import { WebSocket } from 'ws';
import { ragOrchestrator } from '../services/ragOrchestrator';
import { db } from '@contractor/data';
import {
  chatSessions,
  chatMessages,
} from '@contractor/data/db/schema';

const router = Router();

/**
 * POST /api/rag/chat
 * Traditional HTTP endpoint for chat (non-streaming)
 * Returns complete response with sources
 */
router.post('/api/rag/chat', async (req: Request, res: Response) => {
  try {
    const { sessionId, projectId, message, userId } = req.body;

    if (!message || !projectId) {
      res.status(400).json({
        success: false,
        error: 'Message and projectId required',
      });
      return;
    }

    console.log(`💬 Chat request: "${message.substring(0, 50)}..."`);

    // Fetch conversation history
    let conversationHistory = [];
    if (sessionId) {
      const recentMessages = await db.query.chatMessages.findMany({
        where: (msg) => msg.sessionId === sessionId,
      });
      conversationHistory = recentMessages.slice(-10).map((m: any) => ({
        role: m.role,
        content: m.content,
        sources: m.sources,
      }));
    }

    // Execute RAG pipeline
    const response = await ragOrchestrator.chat(
      {
        sessionId: sessionId || `session-${Date.now()}`,
        userId: userId || 'anonymous',
        projectId,
        message,
        timestamp: new Date().toISOString(),
      },
      conversationHistory
    );

    // Save to database
    if (sessionId) {
      try {
        // Save user message
        await db.insert(chatMessages).values({
          sessionId,
          role: 'user',
          content: message,
          sources: null,
          createdAt: new Date(),
        });

        // Save assistant response with sources
        await db.insert(chatMessages).values({
          sessionId,
          role: 'assistant',
          content: response.responseText,
          sources: response.citations.map((c) => ({
            fileId: c.fileId,
            fileName: c.fileName,
            chunkIndex: c.chunkIndex,
            relevance: c.relevance,
            link: c.oneDriveLink,
          })),
          createdAt: new Date(),
        });
      } catch (error) {
        console.warn('Failed to save chat to database:', error);
      }
    }

    res.json({
      success: true,
      data: response,
    });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Chat failed',
    });
  }
});

/**
 * POST /api/rag/sessions
 * Create a new chat session
 */
router.post('/api/rag/sessions', async (req: Request, res: Response) => {
  try {
    const { projectId, userId } = req.body;

    if (!projectId || !userId) {
      res.status(400).json({
        success: false,
        error: 'projectId and userId required',
      });
      return;
    }

    const session = await db.insert(chatSessions).values({
      projectId,
      userId,
      createdAt: new Date(),
    });

    res.json({
      success: true,
      data: {
        sessionId: session[0].id,
        createdAt: session[0].createdAt,
      },
    });
  } catch (error) {
    console.error('Session creation error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create session',
    });
  }
});

/**
 * GET /api/rag/sessions/:id/history
 * Get chat history for a session
 */
router.get('/api/rag/sessions/:id/history', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { limit = '50' } = req.query;

    const messages = await db.query.chatMessages.findMany({
      where: (msg) => msg.sessionId === id,
      limit: parseInt(limit as string),
    });

    res.json({
      success: true,
      data: {
        sessionId: id,
        messages: messages.map((m: any) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          sources: m.sources,
          createdAt: m.createdAt,
        })),
      },
    });
  } catch (error) {
    console.error('History fetch error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch history',
    });
  }
});

/**
 * GET /api/rag/health
 * Health check endpoint
 */
router.get('/api/rag/health', async (req: Request, res: Response) => {
  try {
    const health = await ragOrchestrator.healthCheck();

    res.json({
      success: true,
      data: {
        status: 'healthy',
        components: health,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Health check failed',
    });
  }
});

/**
 * GET /api/rag/config
 * Get RAG configuration
 */
router.get('/api/rag/config', (req: Request, res: Response) => {
  const config = ragOrchestrator.getConfig();

  res.json({
    success: true,
    data: config,
  });
});

export default router;

/**
 * WebSocket Handler for Streaming Chat
 * Call this from server.ts with the HTTP server instance
 *
 * Example:
 * ```
 * import { setupWebSocketHandlers } from './routes/ragRoutes';
 * const server = http.createServer(app);
 * setupWebSocketHandlers(server);
 * ```
 */
export function setupWebSocketHandlers(httpServer: any) {
  const { WebSocketServer } = require('ws');
  const wss = new WebSocketServer({ server: httpServer, path: '/ws/chat' });

  wss.on('connection', (ws: WebSocket) => {
    console.log('🔌 WebSocket client connected');

    ws.on('message', async (data: string) => {
      try {
        const request = JSON.parse(data);
        const {
          sessionId,
          projectId,
          userId,
          message,
        } = request;

        if (!message || !projectId) {
          ws.send(
            JSON.stringify({
              type: 'error',
              data: 'Message and projectId required',
            })
          );
          return;
        }

        console.log(`💬 WebSocket message: "${message.substring(0, 50)}..."`);

        // Fetch conversation history
        let conversationHistory = [];
        if (sessionId) {
          const recentMessages = await db.query.chatMessages.findMany({
            where: (msg) => msg.sessionId === sessionId,
          });
          conversationHistory = recentMessages.slice(-10).map((m: any) => ({
            role: m.role,
            content: m.content,
          }));
        }

        // Execute RAG with streaming
        const response = await ragOrchestrator.chat(
          {
            sessionId: sessionId || `session-${Date.now()}`,
            userId: userId || 'anonymous',
            projectId,
            message,
            timestamp: new Date().toISOString(),
          },
          conversationHistory,
          (event) => {
            // Stream events back to client
            ws.send(JSON.stringify(event));
          }
        );

        // Save to database
        if (sessionId) {
          try {
            await db.insert(chatMessages).values({
              sessionId,
              role: 'user',
              content: message,
              sources: null,
              createdAt: new Date(),
            });

            await db.insert(chatMessages).values({
              sessionId,
              role: 'assistant',
              content: response.responseText,
              sources: response.citations.map((c) => ({
                fileId: c.fileId,
                fileName: c.fileName,
                chunkIndex: c.chunkIndex,
                relevance: c.relevance,
                link: c.oneDriveLink,
              })),
              createdAt: new Date(),
            });
          } catch (error) {
            console.warn('Failed to save chat:', error);
          }
        }
      } catch (error) {
        console.error('WebSocket error:', error);
        ws.send(
          JSON.stringify({
            type: 'error',
            data: error instanceof Error ? error.message : 'Unknown error',
          })
        );
      }
    });

    ws.on('close', () => {
      console.log('🔌 WebSocket client disconnected');
    });

    ws.on('error', (error: Error) => {
      console.error('WebSocket error:', error);
    });
  });

  console.log('✅ WebSocket handlers setup on /ws/chat');
}
