import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

const configuredUrl = process.env["PASSWORD_UPGRADE_TEST_DATABASE_URL"]?.trim();
const databaseUrl = process.env["DATABASE_URL"]?.trim();
const enabled = Boolean(
  configuredUrl
  && databaseUrl
  && configuredUrl === databaseUrl
  && new URL(configuredUrl).pathname.toLowerCase().includes("test"),
);

test("legacy password upgrading preserves authentication and session security", { skip: !enabled }, async (t) => {
  process.env["SESSION_SECRET"] ??= "password-upgrade-integration-secret-for-tests";
  const [
    { default: express },
    { default: authRouter },
    authMiddleware,
    { default: bcrypt },
    dbModule,
    sessions,
    accessTokens,
    upgradeTokens,
  ] = await Promise.all([
    import("express"),
    import("../routes/auth.js"),
    import("../middleware/auth.js"),
    import("bcryptjs"),
    import("@workspace/db"),
    import("../lib/sessionStore.js"),
    import("../lib/accessToken.js"),
    import("../lib/passwordUpgradeToken.js"),
  ]);
  const { pool } = dbModule;
  const app = express();
  app.use(express.json());
  app.use("/api", authRouter);
  app.get("/api/protected-fixture", authMiddleware.requireAuth, (req, res) => {
    res.json({ userId: req.user!.userId });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const unique = `puw-${process.pid}-${Date.now()}`;
  const modernUsername = `${unique}-modern`;
  const legacyWeakUsername = `${unique}-weak`;
  const inactiveUsername = `${unique}-inactive`;
  const legacyStrongUsername = `${unique}-strong`;
  const limitedUsername = `${unique}-limited`;
  const modernPassword = "modern correct horse battery staple 47";
  const legacyWeakPassword = "weakpass";
  const newPassword = `${legacyWeakUsername} replacement 95`;
  const legacyStrongPassword = "legacy correct horse battery staple 83";

  async function insertUser(username: string, password: string, policyVersion: number, active = true) {
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query<{ id: number; password_hash: string }>(
      `INSERT INTO portal_users
        (username, password_hash, password_policy_version, role, permissions, active)
       VALUES ($1, $2, $3, 'view', '["view_metrics"]', $4)
       RETURNING id, password_hash`,
      [username, passwordHash, policyVersion, active],
    );
    return result.rows[0]!;
  }

  const login = (username: string, password: string) => fetch(`${origin}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const upgrade = (body: Record<string, unknown>) => fetch(`${origin}/auth/password-upgrade`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const protectedRequest = (token: string) => fetch(`${origin}/protected-fixture`, {
    headers: { authorization: `Bearer ${token}` },
  });

  await pool.query(
    "DELETE FROM api_rate_limits WHERE action IN ('login-request', 'login-failure', 'password-upgrade-request')",
  );
  const modern = await insertUser(modernUsername, modernPassword, 1);
  const weak = await insertUser(legacyWeakUsername, legacyWeakPassword, 0);
  await insertUser(inactiveUsername, legacyWeakPassword, 0, false);
  const strong = await insertUser(legacyStrongUsername, legacyStrongPassword, 0);

  try {
    await t.test("valid modern password receives the normal login payload", async () => {
      const response = await login(modernUsername, modernPassword);
      assert.equal(response.status, 200, await response.clone().text());
      const body = await response.json() as Record<string, unknown>;
      assert.equal(typeof body["token"], "string");
      assert.equal(body["passwordChangeRequired"], undefined);
      assert.match(response.headers.get("set-cookie") ?? "", /tracker_refresh=.*HttpOnly/i);
      assert.equal((await protectedRequest(body["token"] as string)).status, 200);
    });

    let upgradeToken = "";
    await t.test("correct weak legacy password returns only a password-upgrade challenge", async () => {
      const response = await login(legacyWeakUsername, legacyWeakPassword);
      assert.equal(response.status, 200, await response.clone().text());
      const body = await response.json() as Record<string, unknown>;
      assert.equal(body["passwordChangeRequired"], true);
      assert.equal(typeof body["upgradeToken"], "string");
      assert.equal(body["token"], undefined);
      assert.equal(body["user"], undefined);
      assert.match(response.headers.get("set-cookie") ?? "", /tracker_refresh=;/i);
      upgradeToken = body["upgradeToken"] as string;
    });

    await t.test("incorrect weak legacy password stays generic", async () => {
      const response = await login(legacyWeakUsername, "incorrect-password");
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: "Invalid credentials" });
    });

    await t.test("inactive users cannot initiate an upgrade", async () => {
      const response = await login(inactiveUsername, legacyWeakPassword);
      assert.equal(response.status, 401);
      const body = await response.json() as Record<string, unknown>;
      assert.equal(body["error"], "Invalid credentials");
      assert.equal(body["passwordChangeRequired"], undefined);
      assert.equal(body["upgradeToken"], undefined);
    });

    await t.test("upgrade tokens cannot authenticate protected endpoints or be confused with access tokens", async () => {
      const protectedResponse = await protectedRequest(upgradeToken);
      assert.equal(protectedResponse.status, 401);

      const modernResponse = await login(modernUsername, modernPassword);
      const modernBody = await modernResponse.json() as { token: string };
      const confused = await upgrade({
        upgradeToken: modernBody.token,
        newPassword,
        confirmPassword: newPassword,
      });
      assert.equal(confused.status, 401);
      assert.deepEqual(await confused.json(), { error: "Invalid or expired password upgrade token" });
    });

    await t.test("expired and tampered upgrade tokens are rejected", async () => {
      const expired = upgradeTokens.signPasswordUpgradeToken(weak.id, weak.password_hash, -1);
      const expiredResponse = await upgrade({
        upgradeToken: expired,
        newPassword,
        confirmPassword: newPassword,
      });
      assert.equal(expiredResponse.status, 401);

      const parts = upgradeToken.split(".");
      assert.equal(parts.length, 3);
      parts[2] = `${parts[2]![0] === "a" ? "b" : "a"}${parts[2]!.slice(1)}`;
      const tamperedResponse = await upgrade({
        upgradeToken: parts.join("."),
        newPassword,
        confirmPassword: newPassword,
      });
      assert.equal(tamperedResponse.status, 401);
    });

    await t.test("weak, oversized, and mismatched new passwords are rejected", async () => {
      const weakResponse = await upgrade({
        upgradeToken,
        newPassword: "too short",
        confirmPassword: "too short",
      });
      assert.equal(weakResponse.status, 400);

      const oversized = "é".repeat(37);
      const oversizedResponse = await upgrade({
        upgradeToken,
        newPassword: oversized,
        confirmPassword: oversized,
      });
      assert.equal(oversizedResponse.status, 400);
      assert.match((await oversizedResponse.json() as { error: string }).error, /72 UTF-8 bytes/i);

      const mismatchResponse = await upgrade({
        upgradeToken,
        newPassword,
        confirmPassword: `${newPassword}!`,
      });
      assert.equal(mismatchResponse.status, 400);
      assert.deepEqual(await mismatchResponse.json(), { error: "Passwords do not match." });
    });

    const oldSessionA = await sessions.createRefreshSession(weak.id);
    const oldSessionB = await sessions.createRefreshSession(weak.id);
    let freshAccessToken = "";
    let freshSessionId = "";
    await t.test("successful upgrade replaces the hash, revokes old sessions, and creates a fresh session", async () => {
      assert.equal(await sessions.isActiveAccessSession(oldSessionA.id, weak.id), true);
      assert.equal(await sessions.isActiveAccessSession(oldSessionB.id, weak.id), true);
      const oldHash = weak.password_hash;

      const response = await upgrade({ upgradeToken, newPassword, confirmPassword: newPassword });
      assert.equal(response.status, 200, await response.clone().text());
      const body = await response.json() as { token: string; user: Record<string, unknown> };
      freshAccessToken = body.token;
      freshSessionId = accessTokens.verifyToken(body.token).sessionId;
      assert.equal(body.user["id"], weak.id);
      assert.equal(Object.prototype.hasOwnProperty.call(body.user, "passwordHash"), false);
      assert.match(response.headers.get("set-cookie") ?? "", /tracker_refresh=.*HttpOnly/i);

      const stored = await pool.query<{
        password_hash: string;
        password_policy_version: number;
        password_changed_at: Date | null;
      }>(
        `SELECT password_hash, password_policy_version, password_changed_at
         FROM portal_users WHERE id = $1`,
        [weak.id],
      );
      const row = stored.rows[0]!;
      assert.notEqual(row.password_hash, oldHash);
      assert.notEqual(row.password_hash, newPassword);
      assert.equal(JSON.stringify(row).includes(newPassword), false);
      assert.equal(await bcrypt.compare(newPassword, row.password_hash), true);
      assert.equal(row.password_policy_version, 1);
      assert.ok(row.password_changed_at);

      assert.equal(await sessions.isActiveAccessSession(oldSessionA.id, weak.id), false);
      assert.equal(await sessions.isActiveAccessSession(oldSessionB.id, weak.id), false);
      assert.notEqual(freshSessionId, oldSessionA.id);
      assert.notEqual(freshSessionId, oldSessionB.id);
      assert.equal(await sessions.isActiveAccessSession(freshSessionId, weak.id), true);
      assert.equal((await protectedRequest(freshAccessToken)).status, 200);
      const activeSessions = await pool.query<{ id: string }>(
        "SELECT id FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()",
        [weak.id],
      );
      assert.deepEqual(activeSessions.rows, [{ id: freshSessionId }]);
    });

    await t.test("the challenge cannot be replayed after success", async () => {
      const response = await upgrade({ upgradeToken, newPassword, confirmPassword: newPassword });
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: "Invalid or expired password upgrade token" });
    });

    await t.test("the old password fails and the replacement password logs in normally", async () => {
      const oldLogin = await login(legacyWeakUsername, legacyWeakPassword);
      assert.equal(oldLogin.status, 401);
      assert.deepEqual(await oldLogin.json(), { error: "Invalid credentials" });

      const newLogin = await login(legacyWeakUsername, newPassword);
      assert.equal(newLogin.status, 200, await newLogin.clone().text());
      const newBody = await newLogin.json() as Record<string, unknown>;
      assert.equal(typeof newBody["token"], "string");
      assert.equal(newBody["passwordChangeRequired"], undefined);
    });

    await t.test("a compliant legacy password logs in and is marked policy version 1 without pretending it changed", async () => {
      const response = await login(legacyStrongUsername, legacyStrongPassword);
      assert.equal(response.status, 200, await response.clone().text());
      const body = await response.json() as Record<string, unknown>;
      assert.equal(typeof body["token"], "string");
      assert.equal(body["passwordChangeRequired"], undefined);
      const row = await pool.query<{ password_policy_version: number; password_changed_at: Date | null }>(
        "SELECT password_policy_version, password_changed_at FROM portal_users WHERE id = $1",
        [strong.id],
      );
      assert.deepEqual(row.rows, [{ password_policy_version: 1, password_changed_at: null }]);
    });

    await t.test("failed-login rate limiting remains independent of password upgrade behavior", async () => {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        statuses.push((await login(limitedUsername, "wrong-password")).status);
      }
      assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 401]);
      assert.equal(statuses[5], 429);
    });

    assert.equal(modern.id > 0, true);
  } finally {
    await pool.query("DELETE FROM portal_users WHERE username LIKE $1", [`${unique}%`]).catch(() => undefined);
    await pool.query(
      "DELETE FROM api_rate_limits WHERE action IN ('login-request', 'login-failure', 'password-upgrade-request')",
    ).catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  }
});
