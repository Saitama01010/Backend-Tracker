import type { Pool, PoolClient } from "pg";
import { databaseSafety } from "./databaseSafety.js";

const RELEVANT_TABLES = ["phone_calls", "pbx_missed_calls", "attendance_records"] as const;
const TARGET_OBJECTS = [
  "phone_calls_created_at_idx",
  "phone_calls_attendance_created_agent_idx",
  "phone_calls_participant_created_idx",
  "phone_calls_missed_line_created_idx",
  "phone_calls_live_synced_idx",
  "pbx_missed_from_created_idx",
  "attendance_records_date_member_idx",
  "attendance_records_attendance_date_member_idx",
] as const;

export const MIGRATION_PREFLIGHT_THRESHOLDS = Object.freeze({
  minimumPostgresMajor: 14,
  maximumLongTransactionSeconds: 300,
  maximumConnectionUtilizationPercent: 80,
  maximumUngrantedRelevantLocks: 0,
  representativeBackfillRows: 250_000,
  representativeTableBytes: 2 * 1024 * 1024 * 1024,
  requiredFreeSpaceMultiplier: 2,
  lockTimeout: "5s",
  statementTimeout0008: "30min",
  statementTimeout0010: "20min",
});

export interface MigrationPreflightReport {
  mode: "synthetic" | "staging";
  generatedAt: string;
  databaseName: string;
  appearsProduction: boolean;
  postgresVersion: string;
  postgresMajor: number;
  relations: Array<{
    name: string;
    estimatedRows: number;
    tableBytes: number;
    indexesBytes: number;
    totalBytes: number;
  }>;
  locks: Array<{ relation: string; mode: string; granted: boolean; count: number }>;
  transactions: { olderThanThreshold: number; oldestSeconds: number | null };
  connections: { used: number; maximum: number; utilizationPercent: number } | null;
  databaseBytes: number;
  attendance: {
    backfillEligible: number;
    invalidLegacyDates: number;
    alreadyBackfilled: number;
  };
  migrationLedger: { applied: number; latestCreatedAt: number | null };
  targetObjects: Array<{ name: string; present: boolean }>;
  estimatedIndexScanBytes: number;
  availableDiskBytes: null;
  thresholds: typeof MIGRATION_PREFLIGHT_THRESHOLDS;
  warnings: string[];
  blockers: string[];
  decision: "GO" | "NO-GO";
}

async function optionalQuery<T extends Record<string, unknown>>(
  client: Pick<PoolClient, "query">,
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  try {
    const result = await client.query<T>(text, values);
    return result.rows;
  } catch {
    return [];
  }
}

export async function runMigrationPreflight(
  pool: Pick<Pool, "connect">,
  input: {
    databaseUrl: string;
    mode: "synthetic" | "staging";
    environment?: NodeJS.ProcessEnv;
    now?: Date;
  },
): Promise<MigrationPreflightReport> {
  const safety = databaseSafety(input.databaseUrl, input.environment);
  if (safety.productionIndicator || !safety.safeName) {
    throw new Error("MIGRATION_PREFLIGHT_PRODUCTION_REFUSAL");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const versionResult = await client.query<{ server_version: string }>("SHOW server_version");
    const relationRows = await client.query<{
          name: string;
          estimated_rows: string | number;
          table_bytes: string | number;
          indexes_bytes: string | number;
          total_bytes: string | number;
        }>(
          `SELECT relation.relname AS name,
                  greatest(relation.reltuples, 0)::bigint AS estimated_rows,
                  pg_relation_size(relation.oid) AS table_bytes,
                  pg_indexes_size(relation.oid) AS indexes_bytes,
                  pg_total_relation_size(relation.oid) AS total_bytes
             FROM pg_class AS relation
             JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'public' AND relation.relname = ANY($1::text[])
            ORDER BY relation.relname`,
          [[...RELEVANT_TABLES]],
        );
    const lockRows = await client.query<{ relation: string; mode: string; granted: boolean; count: string | number }>(
          `SELECT relation.relname AS relation, lock.mode, lock.granted, count(*) AS count
             FROM pg_locks AS lock
             JOIN pg_class AS relation ON relation.oid = lock.relation
             JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'public' AND relation.relname = ANY($1::text[])
            GROUP BY relation.relname, lock.mode, lock.granted
            ORDER BY relation.relname, lock.mode, lock.granted`,
          [[...RELEVANT_TABLES]],
        );
    const transactionRows = await client.query<{ older: string | number; oldest_seconds: string | number | null }>(
          `SELECT count(*) FILTER (
                    WHERE xact_start IS NOT NULL
                      AND extract(epoch FROM now() - xact_start) > $1
                  ) AS older,
                  max(extract(epoch FROM now() - xact_start)) FILTER (
                    WHERE xact_start IS NOT NULL AND pid <> pg_backend_pid()
                  ) AS oldest_seconds
             FROM pg_stat_activity`,
          [MIGRATION_PREFLIGHT_THRESHOLDS.maximumLongTransactionSeconds],
        );
    const connectionRows = await client.query<{ used: string | number; maximum: string | number }>(
          `SELECT count(*) AS used, current_setting('max_connections')::integer AS maximum
             FROM pg_stat_activity`,
        );
    const databaseRows = await client.query<{ database_bytes: string | number }>(
          "SELECT pg_database_size(current_database()) AS database_bytes",
        );
    const attendanceRows = await optionalQuery<{
          backfill_eligible: string | number;
          invalid_legacy_dates: string | number;
          already_backfilled: string | number;
        }>(
          client,
          `SELECT count(*) FILTER (
                    WHERE attendance_date IS NULL
                      AND attendance_text_to_date_compatibility(date) IS NOT NULL
                  ) AS backfill_eligible,
                  count(*) FILTER (
                    WHERE attendance_date IS NULL
                      AND attendance_text_to_date_compatibility(date) IS NULL
                  ) AS invalid_legacy_dates,
                  count(*) FILTER (WHERE attendance_date IS NOT NULL) AS already_backfilled
             FROM attendance_records`,
        );
    const ledgerRows = await optionalQuery<{ applied: string | number; latest_created_at: string | number | null }>(
          client,
          `SELECT count(*) AS applied, max(created_at) AS latest_created_at
             FROM drizzle.__drizzle_migrations`,
        );

    const targetObjects = [];
    for (const name of TARGET_OBJECTS) {
      const result = await client.query<{ object_name: string | null }>(
        "SELECT to_regclass($1)::text AS object_name",
        [`public.${name}`],
      );
      targetObjects.push({ name, present: Boolean(result.rows[0]?.object_name) });
    }
    await client.query("COMMIT");

    const postgresVersion = versionResult.rows[0]?.server_version ?? "unknown";
    const postgresMajor = Number(postgresVersion.split(".")[0]);
    const relations = relationRows.rows.map((row) => ({
      name: row.name,
      estimatedRows: Number(row.estimated_rows),
      tableBytes: Number(row.table_bytes),
      indexesBytes: Number(row.indexes_bytes),
      totalBytes: Number(row.total_bytes),
    }));
    const locks = lockRows.rows.map((row) => ({
      relation: row.relation,
      mode: row.mode,
      granted: row.granted,
      count: Number(row.count),
    }));
    const transaction = transactionRows.rows[0];
    const connection = connectionRows.rows[0];
    const connectionSummary = connection
      ? {
          used: Number(connection.used),
          maximum: Number(connection.maximum),
          utilizationPercent: Math.round((Number(connection.used) / Number(connection.maximum)) * 10_000) / 100,
        }
      : null;
    const attendance = attendanceRows[0] ?? {
      backfill_eligible: 0,
      invalid_legacy_dates: 0,
      already_backfilled: 0,
    };
    const blockers: string[] = [];
    const warnings: string[] = [];
    if (postgresMajor < MIGRATION_PREFLIGHT_THRESHOLDS.minimumPostgresMajor) blockers.push("postgres_version_below_supported_preflight_floor");
    if (locks.some((lock) => !lock.granted)) blockers.push("ungranted_lock_on_relevant_relation");
    if (Number(transaction?.older ?? 0) > 0) blockers.push("long_running_transaction_exceeds_threshold");
    if (connectionSummary && connectionSummary.utilizationPercent >= MIGRATION_PREFLIGHT_THRESHOLDS.maximumConnectionUtilizationPercent) blockers.push("connection_utilization_exceeds_threshold");
    if (relations.length !== RELEVANT_TABLES.length) blockers.push("required_relation_missing");
    if (Number(attendance.backfill_eligible) >= MIGRATION_PREFLIGHT_THRESHOLDS.representativeBackfillRows) warnings.push("attendance_backfill_requires_measured_low_write_window");
    if (relations.some((relation) => relation.tableBytes >= MIGRATION_PREFLIGHT_THRESHOLDS.representativeTableBytes)) warnings.push("large_relation_requires_measured_index_window");
    warnings.push("available_disk_space_not_exposed_by_postgresql_confirm_externally");

    return {
      mode: input.mode,
      generatedAt: (input.now ?? new Date()).toISOString(),
      databaseName: safety.databaseName,
      appearsProduction: safety.productionIndicator,
      postgresVersion,
      postgresMajor,
      relations,
      locks,
      transactions: {
        olderThanThreshold: Number(transaction?.older ?? 0),
        oldestSeconds: transaction?.oldest_seconds === null || transaction?.oldest_seconds === undefined
          ? null
          : Math.round(Number(transaction.oldest_seconds)),
      },
      connections: connectionSummary,
      databaseBytes: Number(databaseRows.rows[0]?.database_bytes ?? 0),
      attendance: {
        backfillEligible: Number(attendance.backfill_eligible),
        invalidLegacyDates: Number(attendance.invalid_legacy_dates),
        alreadyBackfilled: Number(attendance.already_backfilled),
      },
      migrationLedger: {
        applied: Number(ledgerRows[0]?.applied ?? 0),
        latestCreatedAt: ledgerRows[0]?.latest_created_at === null || ledgerRows[0]?.latest_created_at === undefined
          ? null
          : Number(ledgerRows[0].latest_created_at),
      },
      targetObjects,
      estimatedIndexScanBytes: relations.reduce((total, relation) => total + relation.tableBytes, 0),
      availableDiskBytes: null,
      thresholds: MIGRATION_PREFLIGHT_THRESHOLDS,
      warnings,
      blockers,
      decision: blockers.length === 0 ? "GO" : "NO-GO",
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
