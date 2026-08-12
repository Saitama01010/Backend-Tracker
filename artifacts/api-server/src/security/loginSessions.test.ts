import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import jwt from "jsonwebtoken";
import type { Request } from "express";
import { signToken, verifyToken } from "../lib/accessToken.js";
import type { AuthPayload, SessionAuthPayload } from "../middleware/authCore.js";
import { createRequireAuth } from "../middleware/authCore.js";
import { protectedActionForRequest } from "../middleware/abusePolicy.js";
import { PASSWORD_POLICY_MESSAGE, validateNewPassword } from "../lib/passwordPolicy.js";
import { hashRefreshToken, readRefreshCookie, refreshCookieOptions } from "../lib/sessionToken.js";
import { isPublicApiRoute } from "../routes/apiPolicy.js";
import { boundedAnonymousScope } from "../lib/privateScope.js";

const fakeViewUser: SessionAuthPayload = {
  userId: 7001,
  username: "fake-view-user",
  role: "view",
  permissions: ["view_metrics"],
  sessionId: "00000000-0000-4000-8000-000000000001",
};
const fakeAdmin: SessionAuthPayload = {
  ...fakeViewUser,
  userId: 7002,
  username: "fake-admin-user",
  role: "admin",
};

test("active admin and ordinary-user access tokens preserve their authorization payload", () => {
  const oldSecret = process.env["SESSION_SECRET"];
  const oldTtl = process.env["AUTH_ACCESS_TOKEN_TTL"];
  process.env["SESSION_SECRET"] = "fake-session-secret-long-enough-for-tests";
  process.env["AUTH_ACCESS_TOKEN_TTL"] = "15m";
  try {
    for (const fixture of [fakeAdmin, fakeViewUser]) {
      const verified = verifyToken(signToken(fixture));
      assert.equal(verified.userId, fixture.userId);
      assert.equal(verified.role, fixture.role);
      assert.equal(verified.sessionId, fixture.sessionId);
    }
  } finally {
    if (oldSecret === undefined) delete process.env["SESSION_SECRET"]; else process.env["SESSION_SECRET"] = oldSecret;
    if (oldTtl === undefined) delete process.env["AUTH_ACCESS_TOKEN_TTL"]; else process.env["AUTH_ACCESS_TOKEN_TTL"] = oldTtl;
  }
});

test("expired access tokens are rejected", () => {
  const oldSecret = process.env["SESSION_SECRET"];
  const oldTtl = process.env["AUTH_ACCESS_TOKEN_TTL"];
  process.env["SESSION_SECRET"] = "fake-session-secret-long-enough-for-tests";
  process.env["AUTH_ACCESS_TOKEN_TTL"] = "-1s";
  try {
    const expired = signToken(fakeViewUser);
    assert.throws(() => verifyToken(expired), /expired/i);
  } finally {
    if (oldSecret === undefined) delete process.env["SESSION_SECRET"]; else process.env["SESSION_SECRET"] = oldSecret;
    if (oldTtl === undefined) delete process.env["AUTH_ACCESS_TOKEN_TTL"]; else process.env["AUTH_ACCESS_TOKEN_TTL"] = oldTtl;
  }
});

test("sessionless legacy, malformed, invalid-signature, and unsupported-algorithm tokens fail closed", () => {
  const oldSecret = process.env["SESSION_SECRET"];
  process.env["SESSION_SECRET"] = "fake-session-secret-long-enough-for-tests";
  try {
    const { sessionId: _sessionId, ...legacyClaims } = fakeViewUser;
    const legacy = jwt.sign(legacyClaims, process.env["SESSION_SECRET"], { algorithm: "HS256", expiresIn: "15m" });
    const unsupported = jwt.sign(fakeViewUser, process.env["SESSION_SECRET"], { algorithm: "HS384", expiresIn: "15m" });
    const badSignature = jwt.sign(fakeViewUser, "different-fake-secret", { algorithm: "HS256", expiresIn: "15m" });
    assert.throws(() => verifyToken(legacy), /claims/i);
    assert.throws(() => verifyToken(unsupported), /algorithm/i);
    assert.throws(() => verifyToken(badSignature), /signature/i);
    assert.throws(() => verifyToken("not-a-jwt"));
  } finally {
    if (oldSecret === undefined) delete process.env["SESSION_SECRET"]; else process.env["SESSION_SECRET"] = oldSecret;
  }
});

test("authentication uses authoritative session and user state with generic failures", async () => {
  const acceptedClaims = { ...fakeViewUser, role: "admin" as const };
  let nextCalled = false;
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  };
  const request = { headers: { authorization: "Bearer fixture-token" } } as unknown as Request & { user?: AuthPayload };
  const middleware = createRequireAuth({
    verifyToken: () => acceptedClaims,
    loadActiveUser: async () => ({ ...fakeViewUser, role: "view" }),
  });
  await middleware(request, response as never, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(request.user?.role, "view", "stale JWT roles must not override authoritative user state");

  for (const reason of ["revoked", "logged-out", "administratively-invalidated"] as const) {
    const deniedRequest = { headers: { authorization: `Bearer ${reason}` } } as unknown as Request & { user?: AuthPayload };
    const deniedResponse = {
      statusCode: 200,
      body: undefined as unknown,
      status(code: number) { this.statusCode = code; return this; },
      json(body: unknown) { this.body = body; return this; },
    };
    const denied = createRequireAuth({ verifyToken: () => fakeViewUser, loadActiveUser: async () => null });
    await denied(deniedRequest, deniedResponse as never, () => assert.fail("revoked session continued"));
    assert.equal(deniedResponse.statusCode, 401);
    assert.deepEqual(deniedResponse.body, { error: "Invalid or expired token" });
    assert.doesNotMatch(JSON.stringify(deniedResponse.body), new RegExp(reason, "i"));
  }
});

test("new and changed passwords use the stronger policy without evaluating stored passwords", () => {
  assert.equal(validateNewPassword("Long-Fake-Passphrase-47", "fixture-user"), null);
  assert.equal(validateNewPassword("short7!", "fixture-user"), PASSWORD_POLICY_MESSAGE);
  assert.equal(validateNewPassword("fixture-user-Passphrase-47!", "fixture-user"), "Password must not contain the username.");
  assert.equal(validateNewPassword(undefined, "fixture-user"), PASSWORD_POLICY_MESSAGE);
});

test("refresh cookies are HttpOnly, same-site, scoped, and raw tokens are only represented by hashes", () => {
  const oldNodeEnv = process.env["NODE_ENV"];
  try {
    process.env["NODE_ENV"] = "production";
    const options = refreshCookieOptions();
    assert.equal(options.httpOnly, true);
    assert.equal(options.secure, true);
    assert.equal(options.sameSite, "strict");
    assert.equal(options.path, "/api/auth");
    assert.equal(options.maxAge, 30 * 24 * 60 * 60 * 1_000);
    const raw = "fake-refresh-token-never-store-this-value";
    const digest = hashRefreshToken(raw);
    assert.notEqual(digest, raw);
    assert.match(digest, /^[a-f0-9]{64}$/);
    const token = "A".repeat(43);
    assert.equal(readRefreshCookie({ headers: { cookie: `sidebar=open; tracker_refresh=${token}` } } as Request), token);
    assert.equal(readRefreshCookie({ headers: { cookie: "tracker_refresh[]=tampered" } } as Request), null);
  } finally {
    if (oldNodeEnv === undefined) delete process.env["NODE_ENV"]; else process.env["NODE_ENV"] = oldNodeEnv;
  }
});

test("refresh and logout bypass bearer auth only because they validate or clear the session cookie", () => {
  assert.equal(isPublicApiRoute("POST", "/auth/login"), true);
  assert.equal(isPublicApiRoute("POST", "/auth/refresh"), true);
  assert.equal(isPublicApiRoute("POST", "/auth/logout"), true);
  assert.equal(isPublicApiRoute("GET", "/auth/refresh"), false);
  assert.equal(isPublicApiRoute("GET", "/auth/logout"), false);
});

test("expensive actions and password changes are selected for per-user database limits", () => {
  for (const [method, path] of [
    ["POST", "/quo/sync"],
    ["POST", "/vos/refresh"],
    ["POST", "/readymode/session/reset"],
    ["POST", "/ob-report/refresh"],
    ["POST", "/qa/process"],
    ["POST", "/attendance/import"],
    ["POST", "/samia/chat"],
    ["POST", "/users"],
  ]) {
    assert.ok(protectedActionForRequest(method!, path!), `${method} ${path}`);
  }
  const passwordRequest = { body: { password: "Long-Fake-Passphrase-47" } } as Request;
  assert.ok(protectedActionForRequest("PATCH", "/users/7", passwordRequest));
  assert.equal(protectedActionForRequest("PATCH", "/users/7", { body: { role: "view" } } as Request), null);
  assert.equal(protectedActionForRequest("GET", "/quo/stats"), null);
});

test("auth logs and HTTP logger configuration contain no credential-bearing diagnostic fields", async () => {
  const authSource = await readFile(new URL("../routes/auth.ts", import.meta.url), "utf8");
  const loggerSource = await readFile(new URL("../lib/logger.ts", import.meta.url), "utf8");
  assert.doesNotMatch(authSource, /passwordMatch|passwordHashPrefix|authorizationHeader|cookieValue/);
  assert.match(loggerSource, /req\.headers\.authorization/);
  assert.match(loggerSource, /req\.headers\.cookie/);
  assert.match(loggerSource, /set-cookie/);
  assert.match(authSource, /Cache-Control", "no-store/);
});

test("failed-login protection combines a per-IP request limit with an independent account limit", async () => {
  const authSource = await readFile(new URL("../routes/auth.ts", import.meta.url), "utf8");
  assert.match(authSource, /login-ip:\$\{address\}/);
  assert.match(authSource, /login-failure:\$\{normalizedUsername\}/);
  assert.doesNotMatch(authSource, /login-failure:\$\{address\}/);
  assert.match(authSource, /boundedAnonymousScope/);
  assert.equal(boundedAnonymousScope("login-failure:fixture-a").length, 4);
  assert.equal(boundedAnonymousScope("login-failure:fixture-a"), boundedAnonymousScope("login-failure:fixture-a"));
  assert.doesNotMatch(boundedAnonymousScope("login-failure:fixture-a"), /fixture/i);
});

test("refresh sessions rotate with one atomic compare-and-swap update", async () => {
  const storeSource = await readFile(new URL("../lib/sessionStore.ts", import.meta.url), "utf8");
  const authSource = await readFile(new URL("../routes/auth.ts", import.meta.url), "utf8");
  assert.match(storeSource, /rotateRefreshSession/);
  assert.match(storeSource, /refreshTokenHash:\s*hashRefreshToken\(rotatedToken\)/);
  assert.match(storeSource, /eq\(authSessionsTable\.refreshTokenHash, hashRefreshToken\(token\)\)/);
  assert.match(storeSource, /isNull\(authSessionsTable\.revokedAt\)/);
  assert.match(storeSource, /\.returning\(\{ id: authSessionsTable\.id, userId: authSessionsTable\.userId \}\)/);
  assert.doesNotMatch(authSource, /findActiveRefreshSession|touchRefreshSession/);
  assert.match(authSource, /setRefreshCookie\(res, session\.token\)/);
});

test("session and rate-limit tables are supplied by an additive migration", async () => {
  const migration = await readFile(new URL("../../../../lib/db/drizzle/0005_login_sessions.sql", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "auth_sessions"/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "api_rate_limits"/);
  assert.match(migration, /ON DELETE cascade/);
});
