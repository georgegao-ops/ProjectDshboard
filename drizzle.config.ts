import path from "node:path";
import dotenv from "dotenv";
import type { Config } from "drizzle-kit";

const dotenvCandidates = [
  path.resolve(process.cwd(), ".env"),
  path.resolve(__dirname, ".env"),
];

for (const envPath of [...new Set(dotenvCandidates)]) {
  dotenv.config({ path: envPath, override: false });
}

export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  driver: "pg",
  dbCredentials: {
    connectionString: process.env.DATABASE_URL || "",
  },
} satisfies Config;
