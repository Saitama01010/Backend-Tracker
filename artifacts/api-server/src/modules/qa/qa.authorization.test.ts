import assert from "node:assert/strict";
import test from "node:test";
import type { AuthPayload } from "../../middleware/authCore.js";
import { authorizeQaDepartments } from "./qa.authorization.js";

const user = (overrides: Partial<AuthPayload>): AuthPayload => ({
  userId: 1,
  username: "qa-fixture",
  role: "view",
  permissions: [],
  ...overrides,
});

test("QA department authorization preserves canonical team scope and default-private behavior", () => {
  const manager = user({
    accessModel: "canonical",
    accessRole: "manager",
    primaryTeam: "retention",
    fullTeamAccess: ["nsf"],
  });
  assert.deepEqual(authorizeQaDepartments(manager, null), {
    ok: true,
    departments: ["Retention", "NSF"],
  });
  assert.deepEqual(authorizeQaDepartments(manager, "CS"), {
    ok: false,
    status: 403,
    error: "Forbidden",
  });
});

test("QA department authorization preserves legacy team and administrator behavior", () => {
  assert.deepEqual(authorizeQaDepartments(user({ teamAccess: "cs" }), null), {
    ok: true,
    departments: ["CS"],
  });
  assert.deepEqual(authorizeQaDepartments(user({ teamAccess: "cs" }), "NSF"), {
    ok: false,
    status: 403,
    error: "Forbidden",
  });
  assert.deepEqual(authorizeQaDepartments(user({ role: "admin" }), null), {
    ok: true,
    departments: null,
  });
});
