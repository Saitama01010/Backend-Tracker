import { Pool } from "pg";
import { verifySchemaContract } from "./schemaContract.js";

const databaseUrl = process.env["DATABASE_URL"]?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL_REQUIRED");

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
try {
  const verification = await verifySchemaContract(pool);
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`);
  } else {
    for (const result of verification.results) {
      process.stdout.write(
        `${result.present && result.definitionMatches ? "PASS" : "FAIL"} ${result.migration} ${result.type} ${result.name}\n`,
      );
    }
    process.stdout.write(
      `Schema contract: ${verification.ok ? "PASS" : "FAIL"} (${verification.results.length} objects)\n`,
    );
  }
  if (!verification.ok) process.exitCode = 1;
} finally {
  await pool.end();
}
