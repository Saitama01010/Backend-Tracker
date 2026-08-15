import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("User Management offers Onboarding only as a primary team", async () => {
  const source = await readFile(
    new URL("../components/CanonicalUserManagementPanel.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /const PRIMARY_TEAMS:[\s\S]*value: "onboarding", label: "Onboarding"/);
  assert.match(source, /Select primary team[\s\S]*PRIMARY_TEAMS\.map/);
  assert.match(source, /disabledValues=\{includedFullTeams\} options=\{TEAMS\}/);
});
