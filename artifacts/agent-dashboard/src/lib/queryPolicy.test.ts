import assert from "node:assert/strict";
import test from "node:test";
import { accountQueryScope, pollingDelay } from "./queryPolicy.js";

test("polling pauses when the view is inactive, hidden, offline, or signed out", () => {
  const base = { baseMs: 15_000, visibilityState: "visible" as const, online: true };
  assert.equal(pollingDelay({ ...base, active: false }), false);
  assert.equal(pollingDelay({ ...base, authenticated: false }), false);
  assert.equal(pollingDelay({ ...base, visibilityState: "hidden" }), false);
  assert.equal(pollingDelay({ ...base, online: false }), false);
});

test("polling keeps the active cadence for live data and backs off for idle data", () => {
  const policy = {
    baseMs: 15_000,
    idleMs: 30_000,
    visibilityState: "visible" as const,
    online: true,
    isIdle: (data: { active: string[] } | undefined) => !data?.active.length,
  };
  assert.equal(pollingDelay(policy, { active: ["fixture-agent"] }), 15_000);
  assert.equal(pollingDelay(policy, { active: [] }), 30_000);
});

test("cache scopes never overlap authenticated accounts", () => {
  assert.equal(accountQueryScope(7), "user:7");
  assert.equal(accountQueryScope(8), "user:8");
  assert.notEqual(accountQueryScope(7), accountQueryScope(8));
  assert.equal(accountQueryScope(null), "signed-out");
});
