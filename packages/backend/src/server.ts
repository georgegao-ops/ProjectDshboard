import express, { Express, Request, Response } from 'express';
import http from 'http';
import dotenv from 'dotenv';
import cors from 'cors';
import { createClient } from 'redis';
import { Queue } from 'bullmq';

// Routes
import authRoutes from './routes/auth';
import projectRoutes from './routes/projects';
import taskRoutes from './routes/tasks';
import oneDriveRoutes from './routes/onedrive';
import chatRoutes from './routes/chat';
import featuresRoutes from './routes/features';
import indexingRoutes from './routes/indexingRoutes';
import ragRoutes, { setupWebSocketHandlers } from './routes/ragRoutes';

// Services
import { IndexingQueueWorker } from './services/indexingQueueWorker';

dotenv.config();

const app: Express = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Redis client for caching
const redisClient = createClient({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
});

// Job queues for background tasks
const chatQueue = new Queue('chat', { connection: redisClient });
const syncQueue = new Queue('sync', { connection: redisClient });
const emailQueue = new Queue('email', { connection: redisClient });

// Make queues available globally
app.locals.chatQueue = chatQueue;
app.locals.syncQueue = syncQueue;
app.locals.emailQueue = emailQueue;
app.locals.redisClient = redisClient;

// Health check endpoint
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/onedrive', oneDriveRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/features', featuresRoutes);
app.use('/api/indexing', indexingRoutes);
app.use('/api/rag', ragRoutes);

// Error handling middleware
app.use((err: any, _req: Request, res: Response) => {
  console.error('Error:', err);
  res.status(500).json({
    success: false,
    error: {
      message: err.message || 'Internal Server Error',
      code: 'INTERNAL_ERROR',
    },
  });
});

// Start server
const httpServer = http.createServer(app);
const server = httpServer.listen(port, async () => {
  console.log(`🚀 Server running on http://localhost:${port}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔌 WebSocket available at ws://localhost:${port}/ws/chat`);

  // Setup WebSocket handlers for RAG chat
  try {
    setupWebSocketHandlers(httpServer);
    console.log('✅ WebSocket handlers initialized');
  } catch (error) {
    console.error('❌ Failed to setup WebSocket:', error);
  }

  // Initialize indexing queue worker
  try {
    const redisUrl = process.env.REDIS_URL;
    await IndexingQueueWorker.initialize(redisUrl);
    console.log('✅ Indexing queue worker initialized');
  } catch (error) {
    console.error('❌ Failed to initialize indexing queue worker:', error);
  }
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  server.close(async () => {
    await IndexingQueueWorker.close();
    await redisClient.quit();
    process.exit(0);
  });
});

export default app;
