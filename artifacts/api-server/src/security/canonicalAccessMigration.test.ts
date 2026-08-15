import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("canonical access migration is additive and leaves existing Portal rows in legacy mode", async () => {
  const migration = await readFile(
    new URL("../../../../lib/db/drizzle/0014_canonical_dashboard_access.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /ADD COLUMN "access_role" text;/);
  assert.match(migration, /ADD COLUMN "team_agent_id" integer;/);
  assert.match(migration, /ADD COLUMN "primary_team" text;/);
  assert.doesNotMatch(migration, /\bUPDATE\s+"?portal_users"?/i);
  assert.doesNotMatch(migration, /\bDELETE\s+FROM\s+"?portal_users"?/i);
  assert.doesNotMatch(migration, /\bDROP\s+(?:TABLE|COLUMN)/i);
  for (const historicalTable of [
    "phone_calls", "attendance_records", "qa_reviews", "pbx_missed_calls", "readymode_uploads", "team_agents",
  ]) {
    assert.doesNotMatch(migration, new RegExp(`(?:UPDATE|DELETE\\s+FROM|TRUNCATE)\\s+"?${historicalTable}"?`, "i"));
  }
  assert.match(migration, /ON DELETE RESTRICT/);
  assert.match(migration, /portal_users_team_agent_id_uidx/);
  assert.match(migration, /portal_user_team_grants_user_team_uidx/);
  assert.match(migration, /portal_user_tab_grants_user_tab_uidx/);
});
