import assert from "node:assert/strict";
import test from "node:test";

const enabled = process.env["RUN_LOGIN_SESSION_INTEGRATION_TEST"] === "1";

test(
  "refresh rotation is single-use and revocation invalidates the access session",
  { skip: !enabled },
  async () => {
    const databaseUrl = process.env["DATABASE_URL"] ?? "";
    assert.match(
      databaseUrl,
      /test/i,
      "integration test requires an isolated test database URL",
    );
    const [{ pool }, sessionStore] = await Promise.all([
      import("@workspace/db"),
      import("../lib/sessionStore.js"),
    ]);
    const username = `session-rotation-fixture-${process.pid}`;
    try {
      const inserted = await pool.query<{ id: number }>(
        `INSERT INTO portal_users (username, password_hash, role, permissions, active)
       VALUES ($1, 'unused-in-integration-test', 'view', '[]', true)
       RETURNING id`,
        [username],
      );
      const userId = inserted.rows[0]!.id;
      const created = await sessionStore.createRefreshSession(userId);
      const [first, replay] = await Promise.all([
        sessionStore.rotateRefreshSession(created.token),
        sessionStore.rotateRefreshSession(created.token),
      ]);
      const winner = first ?? replay;
      assert.ok(winner);
      assert.equal(
        first === null || replay === null,
        true,
        "only one concurrent refresh may consume the token",
      );
      assert.equal(
        await sessionStore.rotateRefreshSession(created.token),
        null,
        "the consumed token cannot be replayed",
      );
      assert.equal(
        await sessionStore.isActiveAccessSession(created.id, userId),
        true,
      );

      await sessionStore.revokeRefreshSession(winner.token);
      assert.equal(
        await sessionStore.isActiveAccessSession(created.id, userId),
        false,
        "logout revocation invalidates access tokens for the session",
      );
      assert.equal(await sessionStore.rotateRefreshSession(winner.token), null);

      const tabSession = await sessionStore.createRefreshSession(userId, undefined, { tabBound: true });
      assert.equal(tabSession.tabBound, true);
      assert.match(tabSession.binding ?? "", /^[A-Za-z0-9_-]{43}$/);
      assert.equal(
        await sessionStore.rotateRefreshSession(tabSession.token),
        null,
        "a session-only cookie cannot refresh without its tab binding",
      );
      const rotatedTabSession = await sessionStore.rotateRefreshSession(tabSession.token, tabSession.binding);
      assert.ok(rotatedTabSession);
      assert.equal(rotatedTabSession.tabBound, true);
      assert.notEqual(rotatedTabSession.binding, tabSession.binding);
      assert.equal(
        await sessionStore.rotateRefreshSession(tabSession.token, tabSession.binding),
        null,
        "a tab-bound credential remains one-time-use",
      );
      await sessionStore.revokeRefreshSession(rotatedTabSession.token, rotatedTabSession.binding);
      assert.equal(await sessionStore.isActiveAccessSession(tabSession.id, userId), false);
    } finally {
      await pool
        .query("DELETE FROM portal_users WHERE username = $1", [username])
        .catch(() => undefined);
      await pool.end();
    }
  },
);
