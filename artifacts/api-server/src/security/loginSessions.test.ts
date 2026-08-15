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
import {
  passwordCredentialStampMatches,
  signPasswordUpgradeToken,
  verifyPasswordUpgradeToken,
} from "../lib/passwordUpgradeToken.js";
import { hashRefreshToken, readRefreshCookie, readSessionBinding, refreshCookieOptions } from "../lib/sessionToken.js";
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

test("password-upgrade challenges are short-lived, password-bound, and purpose-separated from access tokens", () => {
  const oldSecret = process.env["SESSION_SECRET"];
  process.env["SESSION_SECRET"] = "fake-session-secret-long-enough-for-tests";
  try {
    const passwordHash = "$2b$10$fixture-password-hash-never-plaintext";
    const upgradeToken = signPasswordUpgradeToken(fakeViewUser.userId, passwordHash);
    const claims = verifyPasswordUpgradeToken(upgradeToken);
    assert.equal(claims.userId, fakeViewUser.userId);
    assert.equal(passwordCredentialStampMatches(fakeViewUser.userId, passwordHash, claims.credentialStamp), true);
    assert.equal(passwordCredentialStampMatches(fakeViewUser.userId, `${passwordHash}-changed`, claims.credentialStamp), false);
    assert.throws(() => verifyToken(upgradeToken), /signature|claims/i);

    const accessToken = signToken(fakeViewUser);
    assert.throws(() => verifyPasswordUpgradeToken(accessToken), /signature|audience|issuer|claims/i);
    const expired = signPasswordUpgradeToken(fakeViewUser.userId, passwordHash, -1);
    assert.throws(() => verifyPasswordUpgradeToken(expired), /expired/i);
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

test("new and changed passwords use the current length and UTF-8 byte policy without evaluating stored passwords", () => {
  assert.equal(validateNewPassword("Long-Fake-Passphrase-47"), null);
  assert.equal(validateNewPassword("fifteen chars ok"), null);
  assert.equal(validateNewPassword("correct horse battery staple"), null);
  assert.equal(validateNewPassword("!".repeat(72)), null);
  assert.equal(validateNewPassword("é".repeat(37)), PASSWORD_POLICY_MESSAGE);
  assert.equal(validateNewPassword("short7!"), PASSWORD_POLICY_MESSAGE);
  assert.equal(validateNewPassword("fixture-user-Passphrase-47!"), null);
  assert.equal(validateNewPassword(undefined), PASSWORD_POLICY_MESSAGE);
});

test("persistent admin and session-only tab cookies are HttpOnly, same-site, scoped, and hashed", () => {
  const oldNodeEnv = process.env["NODE_ENV"];
  try {
    process.env["NODE_ENV"] = "production";
    const options = refreshCookieOptions();
    assert.equal(options.httpOnly, true);
    assert.equal(options.secure, true);
    assert.equal(options.sameSite, "strict");
    assert.equal(options.path, "/api/auth");
    assert.equal(options.maxAge, 30 * 24 * 60 * 60 * 1_000);
    assert.equal(refreshCookieOptions(false).maxAge, undefined);
    const raw = "fake-refresh-token-never-store-this-value";
    const digest = hashRefreshToken(raw);
    assert.notEqual(digest, raw);
    assert.match(digest, /^[a-f0-9]{64}$/);
    const token = "A".repeat(43);
    assert.equal(readRefreshCookie({ headers: { cookie: `sidebar=open; tracker_refresh=${token}` } } as Request), token);
    assert.equal(readRefreshCookie({ headers: { cookie: "tracker_refresh[]=tampered" } } as Request), null);
    assert.equal(readSessionBinding({ headers: { "x-tracker-session-binding": token } } as unknown as Request), token);
    assert.equal(readSessionBinding({ headers: { "x-tracker-session-binding": "tampered" } } as unknown as Request), null);
  } finally {
    if (oldNodeEnv === undefined) delete process.env["NODE_ENV"]; else process.env["NODE_ENV"] = oldNodeEnv;
  }
});

test("refresh and logout bypass bearer auth only because they validate or clear the session cookie", () => {
  assert.equal(isPublicApiRoute("POST", "/auth/login"), true);
  assert.equal(isPublicApiRoute("POST", "/auth/password-upgrade"), true);
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
  assert.match(loggerSource, /upgradeToken/);
  assert.match(loggerSource, /newPassword/);
  assert.match(loggerSource, /confirmPassword/);
  assert.match(authSource, /Cache-Control", "no-store/);
});

test("legacy policy validation happens only after successful bcrypt verification", async () => {
  const authSource = await readFile(new URL("../routes/auth.ts", import.meta.url), "utf8");
  const compareIndex = authSource.indexOf("await bcrypt.compare(password");
  const policyIndex = authSource.indexOf("validateNewPassword(password)");
  const challengeIndex = authSource.indexOf("passwordChangeRequired: true");
  assert.ok(compareIndex >= 0);
  assert.ok(policyIndex > compareIndex);
  assert.ok(challengeIndex > policyIndex);
  assert.match(authSource, /Invalid credentials/);
  assert.doesNotMatch(authSource, /passwordChangeRequired[^\n]+Invalid credentials/);
});

test("password replacement revokes old sessions before creating the replacement session", async () => {
  const authSource = await readFile(new URL("../routes/auth.ts", import.meta.url), "utf8");
  const upgradeRoute = authSource.slice(authSource.indexOf('router.post("/auth/password-upgrade"'));
  assert.ok(upgradeRoute.indexOf("revokeUserSessions(current.id, tx)") >= 0);
  assert.ok(upgradeRoute.indexOf("createRefreshSession(current.id, tx,") > upgradeRoute.indexOf("revokeUserSessions(current.id, tx)"));
  assert.match(upgradeRoute, /\.for\("update"\)/);
  assert.match(upgradeRoute, /passwordCredentialStampMatches/);
});

test("email login protection combines a per-IP request limit with an independent normalized-account limit", async () => {
  const authSource = await readFile(new URL("../routes/auth.ts", import.meta.url), "utf8");
  assert.match(authSource, /eq\(portalUsersTable\.emailNormalized, normalizedEmail\)/);
  assert.match(authSource, /eq\(teamAgentsTable\.emailNormalized, normalizedEmail\)/);
  assert.match(authSource, /isNull\(portalUsersTable\.emailNormalized\)/);
  assert.doesNotMatch(authSource, /eq\(portalUsersTable\.username, normalized/);
  assert.match(authSource, /login-ip:\$\{address\}/);
  assert.match(authSource, /login-failure:\$\{normalizedEmail\}/);
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
  assert.match(storeSource, /refreshTokenHash:\s*rotated\.hash/);
  assert.match(storeSource, /hashRefreshToken\(refreshCredential\(token, binding\)\)/);
  assert.match(storeSource, /isNull\(authSessionsTable\.revokedAt\)/);
  assert.match(storeSource, /\.returning\(\{ id: authSessionsTable\.id, userId: authSessionsTable\.userId \}\)/);
  assert.doesNotMatch(authSource, /findActiveRefreshSession|touchRefreshSession/);
  assert.match(authSource, /setRefreshCookie\(res, session\.token, !session\.tabBound\)/);
  assert.match(authSource, /readSessionBinding\(req\)/);
});

test("session and rate-limit tables are supplied by an additive migration", async () => {
  const migration = await readFile(new URL("../../../../lib/db/drizzle/0005_login_sessions.sql", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "auth_sessions"/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "api_rate_limits"/);
  assert.match(migration, /ON DELETE cascade/);
});

test("legacy password metadata is additive and existing rows begin unverified while new rows default current", async () => {
  const migration = await readFile(new URL("../../../../lib/db/drizzle/0015_legacy_password_upgrade.sql", import.meta.url), "utf8");
  assert.match(migration, /password_policy_version[^;]+DEFAULT 0 NOT NULL/is);
  assert.match(migration, /password_policy_version" SET DEFAULT 1/i);
  assert.match(migration, /password_changed_at" timestamp with time zone/i);
  assert.doesNotMatch(migration, /password_hash[^;]*(?:length|strength|policy)/i);
});

test("admin-created and reset passwords record current policy metadata without returning hashes", async () => {
  const usersSource = await readFile(new URL("../routes/users.ts", import.meta.url), "utf8");
  const startupSource = await readFile(new URL("../app/startupDatabase.ts", import.meta.url), "utf8");
  assert.match(usersSource, /passwordPolicyVersion:\s*CURRENT_PASSWORD_POLICY_VERSION/);
  assert.match(usersSource, /passwordChangedAt:\s*new Date\(\)/);
  assert.match(usersSource, /passwordHash: _passwordHash, emailNormalized: _emailNormalized/);
  assert.match(startupSource, /passwordPolicyVersion:\s*CURRENT_PASSWORD_POLICY_VERSION/);
  assert.match(startupSource, /passwordChangedAt:\s*new Date\(\)/);
});
