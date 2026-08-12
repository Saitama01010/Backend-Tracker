import { Pool } from "pg";
import { runMigrationPreflight } from "./migrationPreflight.js";

const databaseUrl = process.env["DATABASE_URL"]?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL_REQUIRED");
const modeArgumentIndex = process.argv.indexOf("--mode");
const requestedMode = process.argv.find((argument) => argument.startsWith("--mode="))?.split("=")[1]
  ?? (modeArgumentIndex >= 0 ? process.argv[modeArgumentIndex + 1] : undefined);
if (requestedMode !== "synthetic" && requestedMode !== "staging") {
  throw new Error("MIGRATION_PREFLIGHT_MODE_REQUIRED");
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
try {
  const report = await runMigrationPreflight(pool, {
    databaseUrl,
    mode: requestedMode,
  });
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`Migration preflight: ${report.decision}\n`);
    process.stdout.write(`PostgreSQL: ${report.postgresVersion}\n`);
    for (const relation of report.relations) {
      process.stdout.write(
        `${relation.name}: estimatedRows=${relation.estimatedRows} tableBytes=${relation.tableBytes} indexesBytes=${relation.indexesBytes}\n`,
      );
    }
    process.stdout.write(
      `attendance: backfill=${report.attendance.backfillEligible} invalidPreserved=${report.attendance.invalidLegacyDates}\n`,
    );
    for (const warning of report.warnings) process.stdout.write(`WARN ${warning}\n`);
    for (const blocker of report.blockers) process.stdout.write(`BLOCK ${blocker}\n`);
  }
  if (report.decision !== "GO") process.exitCode = 1;
} finally {
  await pool.end();
}
