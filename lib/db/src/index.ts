import "./env";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;
const databaseUrlSource = process.env.DATABASE_URL ? "DATABASE_URL" : "OLD_DATABASE_URL";
const databaseUrl = process.env.DATABASE_URL || process.env.OLD_DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL or OLD_DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export function databaseConnectionInfo() {
  try {
    const url = new URL(databaseUrl);
    return {
      source: databaseUrlSource,
      host: url.host,
      database: url.pathname.replace(/^\//, "") || null,
    };
  } catch {
    return {
      source: databaseUrlSource,
      host: "unparseable",
      database: null,
    };
  }
}

export const pool = new Pool({ connectionString: databaseUrl });
export const db = drizzle(pool, { schema });

export * from "./schema";
