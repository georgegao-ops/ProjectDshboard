/**
 * Database Connection & Query Layer
 * Initializes Drizzle ORM with PostgreSQL
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

let db: ReturnType<typeof drizzle> | null = null;

/**
 * Initialize database connection
 */
export async function initializeDb(databaseUrl: string) {
  if (db) {
    return db;
  }

  const client = postgres(databaseUrl, {
    ssl: process.env.NODE_ENV === "production" ? "require" : false,
  });

  db = drizzle(client, { schema });
  return db;
}

/**
 * Get database instance (must call initializeDb first)
 */
export function getDb() {
  if (!db) {
    throw new Error("Database not initialized. Call initializeDb() first.");
  }
  return db;
}

export function getDbIfInitialized() {
  return db;
}

// Export schema for migrations
export * from "./schema";
