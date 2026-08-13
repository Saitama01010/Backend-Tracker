import pg from "pg";
import {
  canonicalizeAgentDisplayName,
  isValidAgentEmail,
  normalizeAgentArabicName,
  normalizeAgentEmail,
  normalizeAgentEnglishName,
} from "@workspace/api-zod/agent-identity";

type AuditRow = {
  id: number;
  name: string;
  arabic_name: string | null;
  email: string | null;
  team: string;
  active: boolean;
};

type ConflictRecord = {
  id: number;
  value: string;
  active: boolean;
  department: string;
};

type Conflict = {
  normalized: string;
  records: ConflictRecord[];
};

function conflictsFor(
  rows: AuditRow[],
  field: "name" | "arabic_name" | "email",
  normalize: (value: string) => string,
): Conflict[] {
  const groups = new Map<string, ConflictRecord[]>();
  for (const row of rows) {
    const value = row[field];
    if (typeof value !== "string") continue;
    const normalized = normalize(value);
    if (!normalized) continue;
    const records = groups.get(normalized) ?? [];
    records.push({
      id: row.id,
      value,
      active: row.active,
      department: row.team,
    });
    groups.set(normalized, records);
  }
  return Array.from(groups, ([normalized, records]) => ({ normalized, records }))
    .filter(({ records }) => records.length > 1);
}

const connectionString = process.env["DATABASE_URL"] || process.env["OLD_DATABASE_URL"];
if (!connectionString) throw new Error("DATABASE_URL_OR_OLD_DATABASE_URL_REQUIRED");

const { Pool } = pg;
const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000 });
const client = await pool.connect();

try {
  await client.query("BEGIN TRANSACTION READ ONLY");
  await client.query("SET LOCAL statement_timeout = '10s'");
  const emailColumnResult = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'team_agents'
          AND column_name = 'email'
     ) AS present`,
  );
  const emailColumnPresent = emailColumnResult.rows[0]?.present === true;
  const emailSelection = emailColumnPresent ? '"email"' : 'NULL::text AS "email"';
  const result = await client.query<AuditRow>(
    `SELECT id, name, arabic_name, ${emailSelection}, team, active
       FROM team_agents
      ORDER BY id`,
  );
  const rows = result.rows;
  const report = {
    emailColumnPresent,
    total: rows.length,
    active: rows.filter((row) => row.active).length,
    inactive: rows.filter((row) => !row.active).length,
    missingEmail: rows.filter(
      (row) => typeof row.email !== "string" || normalizeAgentEmail(row.email) === "",
    ).length,
    englishConflicts: conflictsFor(rows, "name", normalizeAgentEnglishName),
    arabicConflicts: conflictsFor(rows, "arabic_name", normalizeAgentArabicName),
    emailConflicts: conflictsFor(rows, "email", normalizeAgentEmail),
    invalidEnglish: rows
      .filter((row) => canonicalizeAgentDisplayName(row.name) === "")
      .map((row) => ({
        id: row.id,
        value: row.name,
        active: row.active,
        department: row.team,
      })),
    malformedEmail: rows
      .filter(
        (row) => typeof row.email === "string"
          && normalizeAgentEmail(row.email) !== ""
          && !isValidAgentEmail(row.email),
      )
      .map((row) => ({
        id: row.id,
        value: row.email!,
        active: row.active,
        department: row.team,
      })),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  await client.query("ROLLBACK");
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
