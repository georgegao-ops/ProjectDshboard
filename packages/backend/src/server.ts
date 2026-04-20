/**
 * Express Server Entry Point
 * Initializes the backend API server with middleware and routes
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import express, { type Express, Request, Response, NextFunction } from "express";
import dotenv from "dotenv";
import { initializeDb } from "./db";
import type {
  AuthLoginRequest,
  CreateChatSessionRequest,
  CreateProjectRequest,
  OneDriveConnectRequest,
  OneDriveSyncRequest,
  SendChatMessageRequest,
  UpdateProjectFeatureRequest,
} from "@contractor/shared";
import { getEnv, hasMicrosoftOAuthConfig } from "./config/env";
import { AppError, asyncHandler, isAppError } from "./lib/errors";
import { logger } from "./lib/logger";
import {
  authService,
  chatService,
  featureService,
  healthService,
  indexingService,
  onedriveService,
  projectService,
  startIndexingWorker,
  syncService,
} from "./services";
import { toUuid } from "./services/service-types";

// Load environment variables from both package and workspace root locations.
const dotenvCandidates = [
  path.resolve(process.cwd(), ".env"),
  path.resolve(__dirname, "../.env"),
  path.resolve(__dirname, "../../.env"),
  path.resolve(__dirname, "../../../.env"),
];

for (const envPath of [...new Set(dotenvCandidates)]) {
  dotenv.config({ path: envPath, override: false });
}

// ================================
// Types
// ================================

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      user?: {
        id: string;
        email: string;
        name: string;
        orgId: string;
        orgName: string;
        role: "super" | "admin" | "pm" | "member";
      };
      orgId?: string;
    }
  }
}

// ================================
// MIDDLEWARE
// ================================

/**
 * Auth middleware for bearer session tokens issued by authService.
 */
function authMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;

  void (async () => {
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      const user = await authService.getRequestUser(token);

      if (user) {
        req.user = user;
        req.orgId = user.orgId;
        logger.info("auth.token.received", {
          requestId: req.requestId,
          tokenPreview: `${token.slice(0, 8)}...`,
        });
      }
    }

    next();
  })().catch(next);
}

function requireAuthenticatedRequest(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  if (!req.user || !req.orgId) {
    next(new AppError(401, "unauthorized", "Unauthorized"));
    return;
  }

  next();
}

// ================================
// ROUTE HANDLERS (Stubs for Phase 1)
// ================================
const handleAuthLogin = asyncHandler(async (req, res) => {
  const response = await authService.login(req.body as AuthLoginRequest);
  res.json(response);
});

const handleAuthMe = asyncHandler(async (req, res) => {
  const response = await authService.getCurrentUser(req.user);
  res.json(response);
});

const handleOneDriveConnect = asyncHandler(async (req, res) => {
  const response = await onedriveService.connect(
    req.body as OneDriveConnectRequest,
    req.user
  );
  res.json(response);
});

const handleOneDriveConnectStart = asyncHandler(async (req, res) => {
  const redirectUri =
    typeof req.query.redirectUri === "string" ? req.query.redirectUri : undefined;
  res.json(onedriveService.getConnectUrl(req.user, redirectUri));
});

const handleOneDriveStatus = asyncHandler(async (req, res) => {
  res.json(await onedriveService.getStatus(req.user));
});

const handleOneDriveSync = asyncHandler(async (req, res) => {
  const body = req.body as OneDriveSyncRequest;
  res.json(await syncService.syncProjectMetadata(body.projectId, req.user, req.orgId));
});

const handleGetProjects = asyncHandler(async (req, res) => {
  res.json(await projectService.listProjects(req.orgId));
});

const handleCreateProject = asyncHandler(async (req, res) => {
  const response = await projectService.createProject(
    req.body as CreateProjectRequest,
    req.orgId
  );
  res.json(response);
});

const handleCreateChatSession = asyncHandler(async (req, res) => {
  const body = req.body as CreateChatSessionRequest;
  res.json(await chatService.createSession(body.projectId, req.user));
});

const handleSendChatMessage = asyncHandler(async (req, res) => {
  const body = req.body as SendChatMessageRequest;
  res.json(await chatService.sendMessage(toUuid(req.params.id), body.message));
});

const handleGetProjectFeatures = asyncHandler(async (req, res) => {
  res.json(await featureService.getProjectFeatures(toUuid(req.params.id)));
});

const handleUpdateProjectFeature = asyncHandler(async (req, res) => {
  const body = req.body as UpdateProjectFeatureRequest;
  res.json(
    await featureService.updateProjectFeature(
      toUuid(req.params.id),
      req.params.fid,
      body.enabled,
      body.config
    )
  );
});

const handleGetFeatureRegistry = asyncHandler(async (_req, res) => {
  res.json(await featureService.getRegistry());
});

// ================================
// APP INITIALIZATION
// ================================

async function createApp(): Promise<Express> {
  const app = express();

  // Middleware
  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.setHeader("x-request-id", req.requestId);

    const startedAt = Date.now();
    logger.info("http.request.started", {
      requestId: req.requestId,
      method: req.method,
      path: req.path,
    });

    res.on("finish", () => {
      logger.info("http.request.completed", {
        requestId: req.requestId,
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt,
      });
    });

    next();
  });
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Auth middleware (optional for routes that don't require it)
  app.use(authMiddleware);

  // Health check
  app.get("/health", asyncHandler(async (_req, res) => {
    const health = await healthService.getSystemHealth();
    const statusCode = health.status === "error" ? 503 : 200;
    res.status(statusCode).json(health);
  }));
  app.get("/health/api", asyncHandler(async (_req, res) => {
    res.json(await healthService.getApiHealth());
  }));
  app.get("/health/db", asyncHandler(async (_req, res) => {
    const health = await healthService.getDatabaseHealth();
    res.status(health.status === "error" ? 503 : 200).json(health);
  }));
  app.get("/health/queue", asyncHandler(async (_req, res) => {
    const health = await healthService.getQueueHealth();
    res.status(health.status === "error" ? 503 : 200).json(health);
  }));

  // ================================
  // API ROUTES
  // ================================

  // Auth
  app.get("/api/auth/login", asyncHandler(async (req, res) => {
    const redirectUri = typeof req.query.redirectUri === "string"
      ? req.query.redirectUri
      : undefined;
    const prompt = typeof req.query.prompt === "string"
      ? req.query.prompt
      : undefined;
    const allowedPrompt =
      prompt === "select_account" || prompt === "login" || prompt === "consent"
        ? prompt
        : undefined;
    const { authorizationUrl } = authService.getLoginUrl(redirectUri, allowedPrompt);
    res.redirect(302, authorizationUrl);
  }));
  app.post("/api/auth/login", handleAuthLogin);
  app.post("/api/auth/refresh", asyncHandler(async (req, res) => {
    const refreshToken = (req.body as { refreshToken?: string }).refreshToken ?? "";
    res.json(await authService.refresh(refreshToken));
  }));
  app.post("/api/auth/logout", asyncHandler(async (req, res) => {
    const authHeader = req.headers.authorization;
    const accessToken = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : undefined;
    const refreshToken = (req.body as { refreshToken?: string }).refreshToken;

    await authService.logout(accessToken, refreshToken);
    res.status(204).send();
  }));
  app.get("/api/auth/me", handleAuthMe);

  // OneDrive
  app.get(
    "/api/onedrive/connect/start",
    requireAuthenticatedRequest,
    handleOneDriveConnectStart
  );
  app.post("/api/onedrive/connect", requireAuthenticatedRequest, handleOneDriveConnect);
  app.get("/api/onedrive/status", requireAuthenticatedRequest, handleOneDriveStatus);
  app.post("/api/onedrive/sync", requireAuthenticatedRequest, handleOneDriveSync);
  app.get("/api/onedrive/browse", requireAuthenticatedRequest, asyncHandler(async (req, res) => {
    const folderId = typeof req.query.folderId === "string" ? req.query.folderId : undefined;
    res.json(await onedriveService.browse(req.user, folderId));
  }));

  // Projects
  app.get("/api/projects", requireAuthenticatedRequest, handleGetProjects);
  app.post("/api/projects", requireAuthenticatedRequest, handleCreateProject);
  app.get("/api/projects/:id", requireAuthenticatedRequest, asyncHandler(async (req, res) => {
    res.json(await projectService.getProjectDetails(toUuid(req.params.id)));
  }));
  app.get("/api/projects/:id/files", requireAuthenticatedRequest, asyncHandler(async (req, res) => {
    const page = Number(req.query.page ?? 1);
    const pageSize = Number(req.query.pageSize ?? 50);
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const category = typeof req.query.category === "string" ? req.query.category : undefined;
    const tags = typeof req.query.tags === "string"
      ? req.query.tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean)
      : undefined;

    const projectId = toUuid(req.params.id);
    await projectService.getProjectOrThrow(projectId, req.orgId);

    const response = await projectService.listProjectFiles(projectId, {
      page,
      pageSize,
      search,
      category,
      tags,
    });
    res.json(response);
  }));
  app.get("/api/projects/:id/indexing/progress", requireAuthenticatedRequest, asyncHandler(async (req, res) => {
    const projectId = toUuid(req.params.id);
    await projectService.getProjectOrThrow(projectId, req.orgId);
    res.json(await indexingService.getProjectIndexingProgress(projectId));
  }));
  app.get("/api/projects/:id/sync/progress", requireAuthenticatedRequest, asyncHandler(async (req, res) => {
    const projectId = toUuid(req.params.id);
    await projectService.getProjectOrThrow(projectId, req.orgId);
    res.json(syncService.getProjectSyncProgress(projectId));
  }));
  app.get("/api/projects/:id/chunks", requireAuthenticatedRequest, asyncHandler(async (req, res) => {
    const projectId = toUuid(req.params.id);
    await projectService.getProjectOrThrow(projectId, req.orgId);
    res.json({ chunks: await projectService.listProjectChunks(projectId) });
  }));
  app.get("/api/projects/:id/retrieval/preview", requireAuthenticatedRequest, asyncHandler(async (req, res) => {
    const projectId = toUuid(req.params.id);
    await projectService.getProjectOrThrow(projectId, req.orgId);
    const query = typeof req.query.q === "string" ? req.query.q : "";
    res.json({ sources: await retrievalService.retrieveSources(projectId, query) });
  }));

  // Chat
  app.post("/api/chat/sessions", requireAuthenticatedRequest, handleCreateChatSession);
  app.get("/api/chat/sessions", requireAuthenticatedRequest, asyncHandler(async (_req, res) => {
    res.json(await chatService.listSessions());
  }));
  app.post("/api/chat/sessions/:id/message", requireAuthenticatedRequest, handleSendChatMessage);
  app.get("/api/chat/sessions/:id/messages", requireAuthenticatedRequest, asyncHandler(async (req, res) => {
    res.json(await chatService.getHistory(toUuid(req.params.id)));
  }));

  // Features
  app.get("/api/projects/:id/features", handleGetProjectFeatures);
  app.put("/api/projects/:id/features/:fid", handleUpdateProjectFeature);
  app.get("/api/features/registry", handleGetFeatureRegistry);

  app.use((req, res) => {
    res.status(404).json({
      error: "Not Found",
      message: `No route registered for ${req.method} ${req.path}`,
      requestId: req.requestId,
    });
  });

  // Default error handler
  app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    const statusCode = isAppError(err) ? err.statusCode : 500;
    logger.error("http.request.failed", err, {
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      statusCode,
    });

    if (isAppError(err)) {
      res.status(err.statusCode).json({
        error: err.code,
        message: err.message,
        details: err.details,
        requestId: req.requestId,
      });
      return;
    }

    res.status(500).json({
      error: "internal_server_error",
      message: "Internal Server Error",
      requestId: req.requestId,
    });
  });

  return app;
}

// ================================
// SERVER START
// ================================

async function startServer() {
  try {
    const env = getEnv();

    if (hasMicrosoftOAuthConfig(env)) {
      logger.info("auth.oauth.config.loaded", {
        redirectUri: env.oauthRedirectUri,
      });
    } else {
      logger.warn("auth.oauth.config.missing", {
        message: "Microsoft OAuth is not configured yet. Auth routes remain stubbed.",
      });
    }

    // Initialize database when configured; otherwise continue in in-memory mode.
    if (env.databaseUrl) {
      await initializeDb(env.databaseUrl);
      logger.info("database.initialized", {
        hasRedisConfig: Boolean(env.redisUrl),
      });
    } else {
      logger.warn("database.config.missing", {
        message:
          "DATABASE_URL is not configured. Starting backend with in-memory fallbacks for local testing.",
      });
    }

    const indexingWorkerRuntime = startIndexingWorker();

    // Create and start Express app
    const app = await createApp();

    const server = app.listen(env.port, () => {
      logger.info("server.started", {
        port: env.port,
        baseUrl: env.apiBaseUrl,
        healthUrl: `${env.apiBaseUrl}/health`,
      });
    });

    const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
      logger.info("server.shutdown.started", { signal });

      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });

      if (indexingWorkerRuntime) {
        await indexingWorkerRuntime.close();
      }

      logger.info("server.shutdown.completed", { signal });
      process.exit(0);
    };

    process.once("SIGINT", () => {
      void shutdown("SIGINT").catch((error) => {
        logger.error("server.shutdown.failed", error, { signal: "SIGINT" });
        process.exit(1);
      });
    });
    process.once("SIGTERM", () => {
      void shutdown("SIGTERM").catch((error) => {
        logger.error("server.shutdown.failed", error, { signal: "SIGTERM" });
        process.exit(1);
      });
    });
  } catch (error) {
    logger.error("server.start.failed", error);
    process.exit(1);
  }
}

// Start if this is the main module
if (require.main === module) {
  startServer();
}

export { createApp };
