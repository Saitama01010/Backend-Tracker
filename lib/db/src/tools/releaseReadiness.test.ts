import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import {
  databaseSafety,
  EMPTY_DATABASE_ACKNOWLEDGEMENT,
  requireEmptyDatabaseBootstrapSafety,
} from "./databaseSafety.js";
import { runMigrationPreflight } from "./migrationPreflight.js";
import { loadSchemaContract, verifySchemaContract } from "./schemaContract.js";

test("empty-database bootstrap guard requires acknowledgement, a safe environment, and a disposable name", () => {
  const url =
    "postgresql://fixture:fixture@localhost/backend_tracker_bootstrap_test";
  assert.throws(
    () =>
      requireEmptyDatabaseBootstrapSafety(url, {
        DATABASE_ENVIRONMENT: "test",
      }),
    /EMPTY_DATABASE_BOOTSTRAP_ACK_REQUIRED/,
  );
  assert.equal(
    requireEmptyDatabaseBootstrapSafety(url, {
      DATABASE_ENVIRONMENT: "test",
      EMPTY_DATABASE_BOOTSTRAP_ACK: EMPTY_DATABASE_ACKNOWLEDGEMENT,
    }).safeName,
    true,
  );
  assert.throws(
    () =>
      requireEmptyDatabaseBootstrapSafety(
        "postgresql://fixture:fixture@localhost/backend_tracker_production",
        {
          DATABASE_ENVIRONMENT: "production",
          EMPTY_DATABASE_BOOTSTRAP_ACK: EMPTY_DATABASE_ACKNOWLEDGEMENT,
        },
      ),
    /EMPTY_DATABASE_BOOTSTRAP_SAFETY_REFUSAL/,
  );
  assert.equal(
    databaseSafety(url, { DATABASE_ENVIRONMENT: "test" }).productionIndicator,
    false,
  );
});

test("schema contract is machine-readable, unique, and identifies intentional raw SQL", async () => {
  const contract = await loadSchemaContract();
  assert.ok(contract.objects.length >= 40);
  assert.ok(
    contract.objects.some(
      (object) =>
        object.name === "api_rate_limits_updated_idx" &&
        !object.drizzleRepresented,
    ),
  );
  assert.ok(
    contract.objects.some(
      (object) =>
        object.name === "ai_request_reservations_status_check" &&
        !object.drizzleRepresented,
    ),
  );
  assert.ok(
    contract.objects.some(
      (object) =>
        object.name === "attendance_date_compatibility_sync" &&
        object.type === "trigger",
    ),
  );
});

const databaseUrl = process.env["RELEASE_READINESS_DATABASE_URL"]?.trim();
const enabled = Boolean(
  databaseUrl && new URL(databaseUrl).pathname.toLowerCase().includes("test"),
);

test(
  "migrated disposable database satisfies the raw-SQL schema contract",
  { skip: !enabled },
  async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      const result = await verifySchemaContract(pool);
      assert.equal(
        result.ok,
        true,
        result.results
          .filter((item) => item.error)
          .map((item) => item.name)
          .join(","),
      );
      assert.ok(result.results.length >= 40);
    } finally {
      await pool.end();
    }
  },
);

test(
  "migration preflight is read-only and reports bounded staging evidence",
  { skip: !enabled },
  async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      const report = await runMigrationPreflight(pool, {
        databaseUrl: databaseUrl!,
        mode: "synthetic",
        environment: { DATABASE_ENVIRONMENT: "test" },
        now: new Date("2026-08-12T09:00:00.000Z"),
      });
      assert.equal(report.appearsProduction, false);
      assert.equal(report.postgresMajor >= 14, true);
      assert.equal(report.relations.length, 3);
      assert.equal(report.availableDiskBytes, null);
      assert.equal(report.thresholds.lockTimeout, "5s");
      assert.ok(
        report.warnings.includes(
          "available_disk_space_not_exposed_by_postgresql_confirm_externally",
        ),
      );
    } finally {
      await pool.end();
    }
  },
);
