import assert from "node:assert/strict";
import test from "node:test";
import { pool } from "@workspace/db";
import { postgresBackgroundJobStore } from "../lib/backgroundJobStore.js";
import { getDurableRuntimeState, putDurableRuntimeState } from "../lib/durableRuntimeState.js";

const databaseUrl = process.env["BACKGROUND_JOBS_TEST_DATABASE_URL"]?.trim();
const activeDatabaseUrl = process.env["DATABASE_URL"]?.trim();
const databaseName = databaseUrl ? new URL(databaseUrl).pathname.toLowerCase() : "";
const enabled = Boolean(
  process.env["NODE_ENV"] === "test"
  && databaseUrl
  && activeDatabaseUrl === databaseUrl
  && databaseName.includes("test"),
);

test("PostgreSQL queue enforces idempotency, type leases, restart recovery, and terminal results", {
  skip: enabled ? false : "DATABASE_URL and BACKGROUND_JOBS_TEST_DATABASE_URL must match an isolated test database",
}, async () => {
  await pool.query("TRUNCATE TABLE background_jobs RESTART IDENTITY");
  const now = new Date("2026-08-10T10:00:00.000Z");
  const first = await postgresBackgroundJobStore.enqueue({
    jobType: "integration_live_refresh",
    idempotencyKey: "integration:postgres:duplicate",
    maxAttempts: 3,
  });
  const duplicate = await postgresBackgroundJobStore.enqueue({
    jobType: "integration_live_refresh",
    idempotencyKey: "integration:postgres:duplicate",
    maxAttempts: 3,
  });
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(first.job.id, duplicate.job.id);

  await postgresBackgroundJobStore.enqueue({
    jobType: "integration_live_refresh",
    idempotencyKey: "integration:postgres:concurrent",
    maxAttempts: 3,
  });
  const claims = await Promise.all([
    postgresBackgroundJobStore.claim("postgres-worker-a", 1_000, now),
    postgresBackgroundJobStore.claim("postgres-worker-b", 1_000, now),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  const claimed = claims.find(Boolean)!;
  assert.equal(await postgresBackgroundJobStore.claim("postgres-worker-c", 1_000, new Date(now.getTime() + 999)), null);

  const reclaimed = await postgresBackgroundJobStore.claim(
    "postgres-worker-restarted",
    1_000,
    new Date(now.getTime() + 1_001),
    claimed.id,
  );
  assert.equal(reclaimed?.attempts, 2);
  assert.equal(await postgresBackgroundJobStore.complete(
    reclaimed!.id,
    "postgres-worker-restarted",
    { refreshed: true },
  ), true);
  assert.equal((await postgresBackgroundJobStore.get(reclaimed!.id))?.status, "completed");
  assert.deepEqual((await postgresBackgroundJobStore.get(reclaimed!.id))?.result, { refreshed: true });

  const terminalLease = await postgresBackgroundJobStore.enqueue({
    jobType: "onboarding_report_refresh",
    idempotencyKey: "integration:postgres:terminal-lease",
    maxAttempts: 1,
  });
  assert.ok(await postgresBackgroundJobStore.claim("postgres-worker-dead", 1_000, now, terminalLease.job.id));
  assert.equal(
    await postgresBackgroundJobStore.claim("postgres-worker-after-death", 1_000, new Date(now.getTime() + 1_001), terminalLease.job.id),
    null,
  );
  assert.equal((await postgresBackgroundJobStore.get(terminalLease.job.id))?.status, "failed");
  assert.equal((await postgresBackgroundJobStore.get(terminalLease.job.id))?.lastErrorCode, "lease_expired");
  assert.deepEqual(
    (await postgresBackgroundJobStore.list({ status: "failed", limit: 10 })).map((job) => job.id),
    [terminalLease.job.id],
  );

  await putDurableRuntimeState("integration:sanitized-live-state", { active: ["Agent One"] }, 60_000);
  assert.deepEqual(
    (await getDurableRuntimeState<{ active: string[] }>("integration:sanitized-live-state"))?.value,
    { active: ["Agent One"] },
  );
});

test.after(async () => {
  if (enabled) await pool.end();
});
