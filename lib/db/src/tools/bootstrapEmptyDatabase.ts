import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { Pool } from "pg";
import { requireEmptyDatabaseBootstrapSafety } from "./databaseSafety.js";
import { verifySchemaContract } from "./schemaContract.js";

const BASELINE_PATH = fileURLToPath(
  new URL("../../bootstrap/0004_baseline.sql", import.meta.url),
);
const MIGRATIONS_PATH = fileURLToPath(new URL("../../drizzle", import.meta.url));
const BASELINE_MIGRATION_COUNT = 5;

interface CountRow extends Record<string, unknown> {
  count: string | number;
}

async function userObjectCount(pool: Pick<Pool, "query">): Promise<number> {
  const result = await pool.query<CountRow>(
    `SELECT count(*) AS count
       FROM pg_class AS relation
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
        AND namespace.nspname NOT LIKE 'pg_toast%'
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

function baselineObjectNames(sql: string): { tables: string[]; indexes: string[] } {
  return {
    tables: [...sql.matchAll(/CREATE TABLE "([^"]+)"/g)].map((match) => match[1]!),
    indexes: [...sql.matchAll(/CREATE(?: UNIQUE)? INDEX "([^"]+)"/g)].map((match) => match[1]!),
  };
}

async function verifyBaselineObjects(
  pool: Pick<Pool, "query">,
  sql: string,
): Promise<void> {
  const objects = baselineObjectNames(sql);
  for (const table of objects.tables) {
    const result = await pool.query<{ object_name: string | null }>(
      "SELECT to_regclass($1)::text AS object_name",
      [`public.${table}`],
    );
    if (!result.rows[0]?.object_name) throw new Error(`BASELINE_TABLE_MISSING:${table}`);
  }
  for (const index of objects.indexes) {
    const result = await pool.query<{ object_name: string | null }>(
      "SELECT to_regclass($1)::text AS object_name",
      [`public.${index}`],
    );
    if (!result.rows[0]?.object_name) throw new Error(`BASELINE_INDEX_MISSING:${index}`);
  }
  const requiredColumns = [
    ["team_agents", "arabic_name"],
    ["team_agents", "shift"],
    ["team_agents", "notes"],
    ["qa_reviews", "source"],
  ] as const;
  for (const [table, column] of requiredColumns) {
    const result = await pool.query<CountRow>(
      `SELECT count(*) AS count
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
      [table, column],
    );
    if (Number(result.rows[0]?.count ?? 0) !== 1) {
      throw new Error(`BASELINE_COLUMN_MISSING:${table}.${column}`);
    }
  }
}

async function seedVerifiedBaselineLedger(pool: Pick<Pool, "query">): Promise<void> {
  const migrations = readMigrationFiles({ migrationsFolder: MIGRATIONS_PATH });
  if (migrations.length < BASELINE_MIGRATION_COUNT) {
    throw new Error("BASELINE_MIGRATION_METADATA_INCOMPLETE");
  }
  await pool.query('CREATE SCHEMA IF NOT EXISTS "drizzle"');
  await pool.query(
    `CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
       id serial PRIMARY KEY,
       hash text NOT NULL,
       created_at bigint
     )`,
  );
  const existing = await pool.query<CountRow>(
    'SELECT count(*) AS count FROM "drizzle"."__drizzle_migrations"',
  );
  if (Number(existing.rows[0]?.count ?? 0) !== 0) {
    throw new Error("BASELINE_LEDGER_NOT_EMPTY");
  }
  for (const migration of migrations.slice(0, BASELINE_MIGRATION_COUNT)) {
    await pool.query(
      'INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ($1, $2)',
      [migration.hash, migration.folderMillis],
    );
  }
}

async function verifyMigrationLedger(
  pool: Pick<Pool, "query">,
  expectedCount: number,
): Promise<void> {
  const migrations = readMigrationFiles({ migrationsFolder: MIGRATIONS_PATH });
  const ledger = await pool.query<{ hash: string; created_at: string | number }>(
    'SELECT hash, created_at FROM "drizzle"."__drizzle_migrations" ORDER BY created_at',
  );
  if (ledger.rows.length !== expectedCount) throw new Error("MIGRATION_LEDGER_COUNT_MISMATCH");
  for (let index = 0; index < expectedCount; index += 1) {
    if (
      ledger.rows[index]?.hash !== migrations[index]?.hash ||
      Number(ledger.rows[index]?.created_at) !== migrations[index]?.folderMillis
    ) {
      throw new Error(`MIGRATION_LEDGER_MISMATCH:${index}`);
    }
  }
}

const databaseUrl = process.env["DATABASE_URL"]?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL_REQUIRED");
const safety = requireEmptyDatabaseBootstrapSafety(databaseUrl);
const applyMigrations = process.argv.includes("--apply-migrations");
const pool = new Pool({ connectionString: databaseUrl, max: 1 });

try {
  const objectCount = await userObjectCount(pool);
  if (objectCount !== 0) throw new Error("EMPTY_DATABASE_REQUIRED");
  const baselineSql = (await readFile(BASELINE_PATH, "utf8")).replace(/^\uFEFF/, "");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(baselineSql);
    await verifyBaselineObjects(client, baselineSql);
    await seedVerifiedBaselineLedger(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  await verifyMigrationLedger(pool, BASELINE_MIGRATION_COUNT);
  const baselineObjects = baselineObjectNames(baselineSql);
  for (const table of baselineObjects.tables) {
    process.stdout.write(`PASS baseline table ${table}\n`);
  }
  for (const index of baselineObjects.indexes) {
    process.stdout.write(`PASS baseline index ${index}\n`);
  }
  process.stdout.write(`PASS baseline through 0004 (${safety.databaseName})\n`);

  if (applyMigrations) {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_PATH });
    const migrationCount = readMigrationFiles({ migrationsFolder: MIGRATIONS_PATH }).length;
    await verifyMigrationLedger(pool, migrationCount);
    const contract = await verifySchemaContract(pool);
    if (!contract.ok) throw new Error("SCHEMA_CONTRACT_FAILED_AFTER_BOOTSTRAP");
    process.stdout.write(`PASS migrations 0005-0012 (${migrationCount} ledger rows)\n`);
    process.stdout.write(`PASS schema contract (${contract.results.length} objects)\n`);
  }
} finally {
  await pool.end();
}
