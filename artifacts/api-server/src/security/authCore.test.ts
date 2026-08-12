import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import { createRequireAuth, type AuthPayload } from "../middleware/authCore.js";

const activeFixture: AuthPayload = {
  userId: 101,
  username: "sanitized-active-user",
  role: "view",
  permissions: [],
};

function requestWithAuthorization(authorization?: string, user?: AuthPayload) {
  return {
    headers: authorization ? { authorization } : {},
    user,
  } as unknown as Request & { user?: AuthPayload };
}

function responseRecorder() {
  let statusCode = 200;
  let body: unknown;
  const response = {
    status(code: number) {
      statusCode = code;
      return response;
    },
    json(value: unknown) {
      body = value;
      return response;
    },
  } as unknown as Response;
  return { response, status: () => statusCode, body: () => body };
}

test("logged-out private requests return 401 before token verification", async () => {
  let verified = false;
  const requireAuth = createRequireAuth({
    verifyToken: () => { verified = true; return activeFixture; },
    loadActiveUser: async () => activeFixture,
  });
  const res = responseRecorder();
  let nextCalled = false;

  await requireAuth(requestWithAuthorization(), res.response, () => { nextCalled = true; });

  assert.equal(res.status(), 401);
  assert.deepEqual(res.body(), { error: "Unauthorized" });
  assert.equal(verified, false);
  assert.equal(nextCalled, false);
});

test("invalid bearer tokens return 401", async () => {
  const requireAuth = createRequireAuth({
    verifyToken: () => { throw new Error("invalid fixture token"); },
    loadActiveUser: async () => activeFixture,
  });
  const res = responseRecorder();

  await requireAuth(requestWithAuthorization("Bearer invalid-fixture"), res.response, () => assert.fail("next must not run"));

  assert.equal(res.status(), 401);
  assert.deepEqual(res.body(), { error: "Invalid or expired token" });
});

test("valid active users receive the current database-backed authorization payload", async () => {
  const refreshedFixture = { ...activeFixture, permissions: ["view_metrics"] as AuthPayload["permissions"] };
  const requireAuth = createRequireAuth({
    verifyToken: () => activeFixture,
    loadActiveUser: async () => refreshedFixture,
  });
  const req = requestWithAuthorization("Bearer valid-fixture");
  const res = responseRecorder();
  let nextCalled = false;

  await requireAuth(req, res.response, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(res.status(), 200);
  assert.deepEqual(req.user, refreshedFixture);
});

test("deactivated or missing users are rejected even when their token verifies", async () => {
  const requireAuth = createRequireAuth({
    verifyToken: () => activeFixture,
    loadActiveUser: async () => null,
  });
  const res = responseRecorder();

  await requireAuth(requestWithAuthorization("Bearer valid-but-deactivated"), res.response, () => assert.fail("next must not run"));

  assert.equal(res.status(), 401);
  assert.deepEqual(res.body(), { error: "Invalid or expired token" });
});

test("route-level authorization reuses the user loaded by the default-private guard", async () => {
  let dependencyCalls = 0;
  const requireAuth = createRequireAuth({
    verifyToken: () => { dependencyCalls += 1; return activeFixture; },
    loadActiveUser: async () => { dependencyCalls += 1; return activeFixture; },
  });
  const res = responseRecorder();
  let nextCalled = false;

  await requireAuth(requestWithAuthorization(undefined, activeFixture), res.response, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(dependencyCalls, 0);
});
