import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Portal user email migration is normalized, unique, guarded, and does not change administrator roles", async () => {
  const migration = await readFile(
    new URL("../../../../lib/db/drizzle/0016_portal_user_email.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /ADD COLUMN "email" text/);
  assert.match(migration, /ADD COLUMN "email_normalized" text/);
  assert.match(migration, /portal_users_email_identity_pair/);
  assert.match(migration, /CREATE UNIQUE INDEX "portal_users_email_normalized_uidx"/);
  assert.match(migration, /EXPECTED_TWO_ADMIN_TARGETS/);
  assert.match(migration, /"username" IN \('admin', 'johnwilliam'\)/);
  assert.match(migration, /"access_role" = 'admin'/);
  assert.match(migration, /"access_role" IS NULL AND "role" = 'admin'/);
  assert.match(migration, /IF EXISTS \(SELECT 1 FROM "portal_users"\)/);

  const assignment = migration.slice(
    migration.indexOf('UPDATE "portal_users"'),
    migration.indexOf("GET DIAGNOSTICS"),
  );
  assert.match(assignment, /SET "email" = CASE "username"/);
  assert.match(assignment, /"email_normalized" = CASE "username"/);
  assert.doesNotMatch(assignment, /SET[\s\S]*"role"\s*=/);
  assert.doesNotMatch(assignment, /SET[\s\S]*"access_role"\s*=/);
});

test("Portal user API validates and normalizes email while keeping the internal identity column private", async () => {
  const source = await readFile(new URL("../routes/users.ts", import.meta.url), "utf8");
  assert.match(source, /isValidAgentEmail/);
  assert.match(source, /normalizeAgentEmail/);
  assert.match(source, /Email is already assigned to another user/);
  assert.match(source, /emailNormalized: _emailNormalized/);
  assert.match(source, /Object\.prototype\.hasOwnProperty\.call\(body, "email"\)/);
});
