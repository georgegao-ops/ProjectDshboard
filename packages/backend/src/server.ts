/**
 * Express Server Entry Point
 * Initializes the backend API server with middleware and routes
 */

import express, { Request, Response, NextFunction } from "express";
import dotenv from "dotenv";
import { initializeDb } from "./db";
import { getOAuthConfig } from "./auth/oauth";
import type { AuthMeResponse } from "@contractor/shared";

// Load environment variables
dotenv.config();

// ================================
// Types
// ================================

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        orgId: string;
      };
      orgId?: string;
    }
  }
}

// ================================
// MIDDLEWARE
// ================================

/**
 * Auth middleware (stub - implement JWT verification in Phase 2)
 */
function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // TODO: Verify JWT from Authorization header
  // For MVP phase 1, this is a placeholder
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    // TODO: Verify and decode token, set req.user
    console.log("Token received (verification not implemented yet):", token.slice(0, 20) + "...");
  }
  next();
}

// ================================
// ROUTE HANDLERS (Stubs for Phase 1)
// ================================

/**
 * Auth Routes
 */
async function handleAuthLogin(req: Request, res: Response): Promise<void> {
  try {
    const { code, redirectUri } = req.body as {
      code: string;
      redirectUri: string;
    };

    if (!code) {
      res.status(400).json({ error: "Missing authorization code" });
      return;
    }

    // TODO: Phase 1.3 - Exchange code for tokens, create/get user
    res.json({
      accessToken: "stub-token",
      refreshToken: "stub-refresh",
      expiresIn: 3600,
      user: {
        id: "stub-user-id",
        email: "contractor@example.com",
        name: "Demo Contractor",
        orgId: "stub-org-id",
        role: "admin",
        createdAt: new Date(),
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Login failed" });
  }
}

async function handleAuthMe(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const response: AuthMeResponse = {
    user: {
      id: req.user.id as any,
      email: req.user.email,
      orgId: req.user.orgId as any,
      name: "User",
      role: "member",
      createdAt: new Date(),
    },
    organization: {
      id: req.user.orgId as any,
      name: "Default Org",
    },
  };

  res.json(response);
}

/**
 * OneDrive Routes (stubs)
 */
async function handleOneDriveConnect(req: Request, res: Response): Promise<void> {
  const { code, redirectUri } = req.body;
  // TODO: Exchange code for OneDrive token, validate scopes
  res.json({ connected: true, message: "OneDrive connection initiated" });
}

async function handleOneDriveStatus(req: Request, res: Response): Promise<void> {
  res.json({
    connected: false,
    syncInProgress: false,
    fileCount: 0,
  });
}

async function handleOneDriveSync(req: Request, res: Response): Promise<void> {
  const { projectId } = req.body;
  // TODO: Queue sync job in Redis
  res.json({ syncStarted: true, message: "Sync queued", jobId: "job-123" });
}

/**
 * Projects Routes (stubs)
 */
async function handleGetProjects(req: Request, res: Response): Promise<void> {
  res.json({ projects: [] });
}

async function handleCreateProject(req: Request, res: Response): Promise<void> {
  const { name, onedriveFolderId } = req.body;
  res.json({
    project: {
      id: "project-123",
      orgId: req.orgId || "org-123",
      name,
      onedriveFolderId,
      status: "active",
      createdAt: new Date(),
    },
  });
}

/**
 * Chat Routes (stubs)
 */
async function handleCreateChatSession(req: Request, res: Response): Promise<void> {
  const { projectId } = req.body;
  res.json({
    session: {
      id: "session-123",
      projectId,
      userId: req.user?.id || "user-123",
      createdAt: new Date(),
    },
  });
}

async function handleSendChatMessage(req: Request, res: Response): Promise<void> {
  const { sessionId } = req.params;
  const { message } = req.body as { message: string };

  res.json({
    messageId: "msg-123",
    role: "assistant",
    content: `Echo: ${message}`,
    sources: [],
    createdAt: new Date(),
  });
}

// ================================
// APP INITIALIZATION
// ================================

async function createApp() {
  const app = express();

  // Middleware
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Auth middleware (optional for routes that don't require it)
  app.use(authMiddleware);

  // Health check
  app.get("/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date() });
  });

  // ================================
  // API ROUTES
  // ================================

  // Auth
  app.post("/api/auth/login", handleAuthLogin);
  app.post("/api/auth/refresh", (req, res) => {
    res.json({ accessToken: "new-token", expiresIn: 3600 });
  });
  app.get("/api/auth/me", handleAuthMe);

  // OneDrive
  app.post("/api/onedrive/connect", handleOneDriveConnect);
  app.get("/api/onedrive/status", handleOneDriveStatus);
  app.post("/api/onedrive/sync", handleOneDriveSync);
  app.get("/api/onedrive/browse", (req, res) => {
    res.json({ items: [] });
  });

  // Projects
  app.get("/api/projects", handleGetProjects);
  app.post("/api/projects", handleCreateProject);
  app.get("/api/projects/:id", (req, res) => {
    res.json({
      project: {
        id: req.params.id,
        name: "Project",
        status: "active",
      },
      onedrive: { connected: false },
      fileCount: 0,
    });
  });
  app.get("/api/projects/:id/files", (req, res) => {
    res.json({ files: [], total: 0, page: 1, pageSize: 50, hasMore: false });
  });

  // Chat
  app.post("/api/chat/sessions", handleCreateChatSession);
  app.get("/api/chat/sessions", (req, res) => {
    res.json({ sessions: [] });
  });
  app.post("/api/chat/sessions/:id/message", handleSendChatMessage);
  app.get("/api/chat/sessions/:id/messages", (req, res) => {
    res.json({ messages: [], total: 0 });
  });

  // Features
  app.get("/api/projects/:id/features", (req, res) => {
    res.json({ features: [] });
  });
  app.put("/api/projects/:id/features/:fid", (req, res) => {
    res.json({ feature: {} });
  });
  app.get("/api/features/registry", (req, res) => {
    res.json({
      features: [
        {
          id: "onedrive",
          name: "OneDrive",
          icon: "cloud",
          route: "/onedrive",
          enabled: true,
          sortOrder: 1,
        },
        {
          id: "chat",
          name: "Chat",
          icon: "message",
          route: "/chat",
          enabled: true,
          sortOrder: 2,
        },
      ],
    });
  });

  // Default error handler
  app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    console.error("Unhandled error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  });

  return app;
}

// ================================
// SERVER START
// ================================

async function startServer() {
  try {
    // Validate OAuth config
    getOAuthConfig();
    console.log("✓ OAuth2 configuration loaded");

    // Initialize database
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      throw new Error("DATABASE_URL environment variable is required");
    }

    await initializeDb(dbUrl);
    console.log("✓ Database initialized");

    // Create and start Express app
    const app = await createApp();
    const PORT = process.env.PORT || 3001;

    app.listen(PORT, () => {
      console.log(`
╔══════════════════════════════════════════╗
║     ContractorAI MVP Backend             ║
║     Ready on http://localhost:${PORT}      ║
╚══════════════════════════════════════════╝
      `);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

// Start if this is the main module
if (require.main === module) {
  startServer();
}

export { createApp };
