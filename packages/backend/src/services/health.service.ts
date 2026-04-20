import { sql } from "drizzle-orm";
import { createClient } from "redis";
import { getEnv } from "../config/env";
import { getDb } from "../db";

export type HealthStatus = "ok" | "error" | "skipped" | "degraded";

export interface HealthCheckResult {
  status: HealthStatus;
  latencyMs: number;
  details?: Record<string, unknown>;
}

interface QueueHealthClient {
  connect(): Promise<unknown>;
  ping(): Promise<unknown>;
  disconnect(): Promise<void>;
}

interface HealthServiceDependencies {
  getEnv: typeof getEnv;
  runDatabaseCheck: () => Promise<void>;
  createQueueClient: (url: string) => QueueHealthClient;
}

function elapsed(startTime: number): number {
  return Date.now() - startTime;
}

function defaultRunDatabaseCheck(): Promise<void> {
  const db = getDb();
  return db.execute(sql`select 1`).then(() => undefined);
}

function defaultCreateQueueClient(url: string): QueueHealthClient {
  return createClient({ url });
}

export function createHealthService(
  dependencies: HealthServiceDependencies = {
    getEnv,
    runDatabaseCheck: defaultRunDatabaseCheck,
    createQueueClient: defaultCreateQueueClient,
  }
) {
  return {
  async getApiHealth(): Promise<HealthCheckResult> {
    const startedAt = Date.now();

    return {
      status: "ok",
      latencyMs: elapsed(startedAt),
      details: {
        uptimeSeconds: Math.round(process.uptime()),
        nodeVersion: process.version,
      },
    };
  },

  async getDatabaseHealth(): Promise<HealthCheckResult> {
    const startedAt = Date.now();

    try {
      await dependencies.runDatabaseCheck();

      return {
        status: "ok",
        latencyMs: elapsed(startedAt),
      };
    } catch (error) {
      return {
        status: "error",
        latencyMs: elapsed(startedAt),
        details: {
          message: error instanceof Error ? error.message : "Database health check failed",
        },
      };
    }
  },

  async getQueueHealth(): Promise<HealthCheckResult> {
    const startedAt = Date.now();
    const { redisUrl } = dependencies.getEnv();

    if (!redisUrl) {
      return {
        status: "skipped",
        latencyMs: elapsed(startedAt),
        details: {
          message: "REDIS_URL is not configured",
        },
      };
    }

    const client = dependencies.createQueueClient(redisUrl);

    try {
      await client.connect();
      await client.ping();

      return {
        status: "ok",
        latencyMs: elapsed(startedAt),
      };
    } catch (error) {
      return {
        status: "error",
        latencyMs: elapsed(startedAt),
        details: {
          message: error instanceof Error ? error.message : "Queue health check failed",
        },
      };
    } finally {
      await client.disconnect().catch(() => undefined);
    }
  },

  async getSystemHealth() {
    const [api, database, queue] = await Promise.all([
      this.getApiHealth(),
      this.getDatabaseHealth(),
      this.getQueueHealth(),
    ]);

    const dependencyStates = [api.status, database.status, queue.status];
    const status = dependencyStates.includes("error")
      ? "error"
      : dependencyStates.includes("skipped")
        ? "degraded"
        : "ok";

    return {
      status,
      timestamp: new Date().toISOString(),
      dependencies: {
        api,
        database,
        queue,
      },
    };
  },
  };
}

export const healthService = createHealthService();
