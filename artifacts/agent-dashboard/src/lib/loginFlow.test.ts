import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  initialLoginFlowState,
  isPasswordUpgradeResponse,
  loginFlowReducer,
  persistAuthenticatedSession,
  validatePasswordUpgradeForm,
} from "./loginFlow.js";

test("passwordChangeRequired moves the existing login flow into in-memory upgrade mode", () => {
  const initial = initialLoginFlowState();
  const challenged = loginFlowReducer(initial, {
    type: "password-upgrade-required",
    upgradeToken: "short-lived-fixture-token",
    username: "legacy-user",
  });
  assert.equal(challenged.mode, "password-upgrade");
  assert.equal(challenged.upgradeToken, "short-lived-fixture-token");
  assert.equal(challenged.username, "legacy-user");
  assert.equal(isPasswordUpgradeResponse({ passwordChangeRequired: true, upgradeToken: "fixture" }), true);
  assert.equal(isPasswordUpgradeResponse({ token: "ordinary-access-token" }), false);
});

test("a fresh LoginGate state does not retain an unfinished upgrade credential", () => {
  const challenged = loginFlowReducer(initialLoginFlowState(), {
    type: "password-upgrade-required",
    upgradeToken: "memory-only-token",
    username: "legacy-user",
  });
  assert.equal(challenged.upgradeToken, "memory-only-token");
  assert.deepEqual(initialLoginFlowState(), {
    mode: "login",
    upgradeToken: null,
    username: null,
  });
  assert.deepEqual(loginFlowReducer(challenged, { type: "reset" }), initialLoginFlowState());
});

test("password confirmation and the displayed policy constraints are validated", () => {
  assert.equal(
    validatePasswordUpgradeForm("correct horse battery staple", "different horse battery staple"),
    "Passwords do not match.",
  );
  assert.equal(validatePasswordUpgradeForm("too short", "too short"), "Password must be at least 15 characters.");
  assert.equal(
    validatePasswordUpgradeForm("legacy-user correct horse battery", "legacy-user correct horse battery"),
    null,
  );
  const tooManyBytes = "é".repeat(37);
  assert.equal(
    validatePasswordUpgradeForm(tooManyBytes, tooManyBytes),
    "Password must be no more than 72 UTF-8 bytes.",
  );
  assert.equal(validatePasswordUpgradeForm("correct horse battery staple", "correct horse battery staple"), null);
});

test("successful upgrade persists only the normal returned auth session", () => {
  const values = new Map<string, string>();
  persistAuthenticatedSession({ setItem: (key, value) => values.set(key, value) }, {
    token: "fresh-access-token",
    user: { id: 7, username: "legacy-user" },
  });
  assert.equal(values.get("tracker_token"), "fresh-access-token");
  assert.deepEqual(JSON.parse(values.get("tracker_user")!), { id: 7, username: "legacy-user" });
  assert.equal([...values.keys()].some((key) => /upgrade/i.test(key)), false);
  assert.equal([...values.values()].includes("memory-only-token"), false);
});

test("LoginGate wires the memory-only challenge into password fields and the upgrade endpoint", async () => {
  const source = await readFile(new URL("../App.tsx", import.meta.url), "utf8");
  assert.match(source, /Create your new password/);
  assert.match(source, /Update Password & Continue/);
  assert.match(source, /\/api\/auth\/password-upgrade/);
  assert.match(source, /autoComplete="new-password"/);
  assert.doesNotMatch(source, /Must not contain your username/);
  assert.doesNotMatch(source, /localStorage\.setItem\([^\n]*upgrade/i);
});
