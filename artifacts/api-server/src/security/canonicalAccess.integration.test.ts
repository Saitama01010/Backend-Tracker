import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

const configuredUrl = process.env["CANONICAL_ACCESS_TEST_DATABASE_URL"]?.trim();
const databaseUrl = process.env["DATABASE_URL"]?.trim();
const enabled = Boolean(
  configuredUrl
  && databaseUrl
  && configuredUrl === databaseUrl
  && new URL(configuredUrl).pathname.toLowerCase().includes("test"),
);

test("canonical Portal access persists normalized grants and revokes deactivated Agent sessions", { skip: !enabled }, async (t) => {
  const [{ default: express }, { default: usersRouter }, { default: teamAgentsRouter }, { default: authRouter }, authMiddleware, { default: bcrypt }, dbModule, authUser, authScope, sessions] = await Promise.all([
    import("express"),
    import("../routes/users.js"),
    import("../routes/teamAgents.js"),
    import("../routes/auth.js"),
    import("../middleware/auth.js"),
    import("bcryptjs"),
    import("@workspace/db"),
    import("../lib/authUser.js"),
    import("../lib/authorizationScope.js"),
    import("../lib/sessionStore.js"),
  ]);
  const { pool } = dbModule;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.headers["x-fixture-real-auth"] !== "1") {
      req.user = {
        userId: 1,
        username: "canonical-access-integration-admin",
        role: "admin",
        permissions: [],
        accessModel: "legacy",
        accessRole: null,
      };
    }
    req.log = { error: () => undefined } as unknown as typeof req.log;
    next();
  });
  app.use(authRouter);
  app.use(usersRouter);
  app.use(teamAgentsRouter);
  app.get("/protected-fixture", authMiddleware.requireAuth, (req, res) => res.json({ userId: req.user!.userId }));
  const metricRows: { agentId: number; agentName: string; team: "retention" | "nsf" | "cs" | "killers"; value: number }[] = [];
  app.get("/metrics-fixture", authMiddleware.requireAuth, async (req, res) => {
    const requestedTeam = typeof req.query["team"] === "string" ? req.query["team"] : null;
    const directory = await authScope.loadAuthorizationAgentDirectory();
    const rows = metricRows
      .filter((row) => !requestedTeam || row.team === requestedTeam)
      .filter((row) => authScope.canAccessMetricAgent(req.user!, row.agentName, directory));
    res.json({ rows });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const unique = `${process.pid}-${Date.now()}`;
  const usernamePrefix = `canonical-access-${unique}`;
  const agentPrefix = `canonical access fixture ${unique}`;
  const initialAgentPassword = "correct horse battery staple 47";
  const resetAgentPassword = "reset horse battery staple 59";

  const postUser = (body: Record<string, unknown>) => fetch(`${origin}/users`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const login = (username: string, password: string) => fetch(`${origin}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const createAgent = async (suffix: string, active = true, team: "retention" | "nsf" | "cs" | "killers" = "retention") => {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO team_agents
        (name, name_normalized, arabic_name, arabic_name_normalized, email, email_normalized, shift, team, active)
       VALUES ($1, $2, NULL, NULL, $3, $3, '9-5', $4, $5)
       RETURNING id`,
      [
        `Canonical Access Fixture ${unique} ${suffix}`,
        `${agentPrefix} ${suffix.toLowerCase()}`,
        `canonical-access-${unique}-${suffix.toLowerCase()}@example.test`,
        team,
        active,
      ],
    );
    return result.rows[0]!.id;
  };

  try {
    const agentId = await createAgent("Agent");
    const inactiveAgentId = await createAgent("Inactive", false);
    const retentionPeerId = await createAgent("Retention Peer");
    const nsfAgentId = await createAgent("NSF Agent", true, "nsf");
    const csAgentId = await createAgent("CS Agent", true, "cs");
    const killersAgentId = await createAgent("Killers Agent", true, "killers");
    metricRows.push(
      { agentId, agentName: `Canonical Access Fixture ${unique} Agent`, team: "retention", value: 1 },
      { agentId: retentionPeerId, agentName: `Canonical Access Fixture ${unique} Retention Peer`, team: "retention", value: 2 },
      { agentId: nsfAgentId, agentName: `Canonical Access Fixture ${unique} NSF Agent`, team: "nsf", value: 3 },
      { agentId: csAgentId, agentName: `Canonical Access Fixture ${unique} CS Agent`, team: "cs", value: 4 },
      { agentId: killersAgentId, agentName: `Canonical Access Fixture ${unique} Killers Agent`, team: "killers", value: 5 },
    );
    const legacyPassword = "legacy horse battery staple 83";
    const legacyHash = await bcrypt.hash(legacyPassword, 10);
    const legacyResult = await pool.query<{ id: number }>(
      `INSERT INTO portal_users (username, password_hash, role, permissions, active)
       VALUES ($1, $2, 'view', '["view_metrics"]', true)
       RETURNING id`,
      [`${usernamePrefix}-legacy`, legacyHash],
    );

    await t.test("legacy rows remain NULL-linked and retain the legacy resolver", async () => {
      const row = await pool.query<{ access_role: string | null; team_agent_id: number | null; primary_team: string | null }>(
        "SELECT access_role, team_agent_id, primary_team FROM portal_users WHERE id = $1",
        [legacyResult.rows[0]!.id],
      );
      assert.deepEqual(row.rows, [{ access_role: null, team_agent_id: null, primary_team: null }]);
      const access = await authUser.loadAuthenticatablePortalUser(legacyResult.rows[0]!.id);
      assert.equal(access?.payload.accessModel, "legacy");
    });

    let agentUserId = 0;
    await t.test("Agent creation links one active canonical identity without returning a password hash", async () => {
      const response = await postUser({
        username: `${usernamePrefix}-agent`,
        password: initialAgentPassword,
        accessRole: "agent",
        teamAgentId: agentId,
        primaryTeam: null,
        teamGrants: [],
        tabGrants: ["violations"],
        permissions: ["view_metrics", "view_attendance"],
      });
      assert.equal(response.status, 201);
      const body = await response.json() as Record<string, unknown> & { id: number };
      agentUserId = body.id;
      assert.equal(Object.prototype.hasOwnProperty.call(body, "passwordHash"), false);
      assert.equal(body["accessRole"], "agent");
      const access = await authUser.loadAuthenticatablePortalUser(agentUserId);
      assert.equal(access?.payload.selfAgentId, agentId);
      assert.equal(access?.payload.selfAgentTeam, "retention");
      assert.deepEqual(access?.payload.fullTeamAccess, []);
      assert.deepEqual(new Set(access?.payload.allowedTabs), new Set(["retention", "violations"]));
    });

    await t.test("one canonical Agent cannot be assigned to two Portal accounts", async () => {
      const response = await postUser({
        username: `${usernamePrefix}-duplicate`,
        password: "another correct horse battery staple",
        accessRole: "agent",
        teamAgentId: agentId,
        primaryTeam: null,
        teamGrants: [],
        tabGrants: [],
        permissions: ["view_metrics"],
      });
      assert.equal(response.status, 409);
    });

    await t.test("inactive Agent identities cannot receive new canonical access", async () => {
      const response = await postUser({
        username: `${usernamePrefix}-inactive`,
        password: "inactive correct horse battery staple",
        accessRole: "agent",
        teamAgentId: inactiveAgentId,
        primaryTeam: null,
        teamGrants: [],
        tabGrants: [],
        permissions: ["view_metrics"],
      });
      assert.equal(response.status, 400);
    });

    const managerPassword = "manager correct horse battery staple";
    let managerUserId = 0;
    await t.test("Manager primary, extra-team, and extra-tab grants resolve centrally", async () => {
      const response = await postUser({
        username: `${usernamePrefix}-manager`,
        password: managerPassword,
        accessRole: "manager",
        teamAgentId: null,
        primaryTeam: "nsf",
        teamGrants: ["cs"],
        tabGrants: ["qa"],
        permissions: ["view_metrics", "view_missed_tables"],
      });
      assert.equal(response.status, 201);
      const manager = await response.json() as { id: number };
      managerUserId = manager.id;
      const access = await authUser.loadAuthenticatablePortalUser(manager.id);
      assert.deepEqual(new Set(access?.payload.fullTeamAccess), new Set(["nsf", "cs"]));
      assert.deepEqual(new Set(access?.payload.allowedTabs), new Set(["nsf", "cs", "qa"]));
      const grants = await pool.query<{ team: string }>(
        "SELECT team FROM portal_user_team_grants WHERE portal_user_id = $1",
        [manager.id],
      );
      assert.deepEqual(grants.rows, [{ team: "cs" }]);
    });

    const adminPassword = "admin correct horse battery staple";
    let adminUserId = 0;
    await t.test("Admin creation remains unrestricted without roster or primary-team linkage", async () => {
      const response = await postUser({
        username: `${usernamePrefix}-admin`,
        password: adminPassword,
        accessRole: "admin",
        teamAgentId: null,
        primaryTeam: null,
        teamGrants: [],
        tabGrants: [],
        permissions: [],
      });
      assert.equal(response.status, 201);
      const admin = await response.json() as Record<string, unknown> & { id: number };
      adminUserId = admin.id;
      assert.equal(admin["accessRole"], "admin");
      assert.equal(admin["teamAgentId"], null);
      assert.equal(admin["primaryTeam"], null);
      const access = await authUser.loadAuthenticatablePortalUser(admin.id);
      assert.equal(access?.payload.role, "admin");
      assert.deepEqual(new Set(access?.payload.permissions), new Set([
        "view_metrics", "view_attendance", "edit_attendance", "manage_members", "view_missed_tables",
      ]));
    });

    let agentToken = "";
    let managerToken = "";
    let adminToken = "";
    await t.test("active Agent, Manager, Admin, and legacy authentication resolve through their correct models", async () => {
      const agentLogin = await login(`${usernamePrefix}-agent`, initialAgentPassword);
      assert.equal(agentLogin.status, 200);
      const agentBody = await agentLogin.json() as { token: string; user: Record<string, unknown> };
      agentToken = agentBody.token;
      assert.equal(agentBody.user["accessRole"], "agent");
      assert.equal(agentBody.user["selfAgentId"], agentId);
      assert.equal(Object.prototype.hasOwnProperty.call(agentBody.user, "passwordHash"), false);
      const protectedResponse = await fetch(`${origin}/protected-fixture`, {
        headers: { Authorization: `Bearer ${agentBody.token}`, "x-fixture-real-auth": "1" },
      });
      assert.equal(protectedResponse.status, 200);
      const meResponse = await fetch(`${origin}/auth/me`, {
        headers: { Authorization: `Bearer ${agentBody.token}`, "x-fixture-real-auth": "1" },
      });
      assert.equal(meResponse.status, 200);

      const managerLogin = await login(`${usernamePrefix}-manager`, managerPassword);
      assert.equal(managerLogin.status, 200);
      const managerBody = await managerLogin.json() as { token: string; user: Record<string, unknown> };
      managerToken = managerBody.token;
      assert.equal(managerBody.user["accessRole"], "manager");
      assert.equal(managerBody.user["selfAgentId"], null);

      const adminLogin = await login(`${usernamePrefix}-admin`, adminPassword);
      assert.equal(adminLogin.status, 200);
      const adminBody = await adminLogin.json() as { token: string; user: { accessRole: string } };
      adminToken = adminBody.token;
      assert.equal(adminBody.user.accessRole, "admin");

      const legacyLogin = await login(`${usernamePrefix}-legacy`, legacyPassword);
      assert.equal(legacyLogin.status, 200);
      assert.equal((await legacyLogin.json() as { user: { accessModel: string } }).user.accessModel, "legacy");
    });

    await t.test("server-side metric filtering resists team parameter changes for Agent and Manager scopes", async () => {
      const metricIds = async (token: string, team?: string) => {
        const response = await fetch(`${origin}/metrics-fixture${team ? `?team=${encodeURIComponent(team)}` : ""}`, {
          headers: { Authorization: `Bearer ${token}`, "x-fixture-real-auth": "1" },
        });
        assert.equal(response.status, 200);
        return (await response.json() as { rows: { agentId: number }[] }).rows.map(({ agentId: id }) => id);
      };
      assert.deepEqual(await metricIds(agentToken), [agentId]);
      assert.deepEqual(await metricIds(agentToken, "retention"), [agentId]);
      assert.deepEqual(await metricIds(agentToken, "cs"), []);
      assert.deepEqual(new Set(await metricIds(managerToken)), new Set([nsfAgentId, csAgentId]));
      assert.deepEqual(await metricIds(managerToken, "retention"), []);
      assert.deepEqual(await metricIds(managerToken, "cs"), [csAgentId]);
      assert.deepEqual(new Set(await metricIds(adminToken)), new Set(metricRows.map(({ agentId: id }) => id)));
      const deactivateHistoricalAgent = await fetch(`${origin}/team-agents/${csAgentId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ active: false }),
      });
      assert.equal(deactivateHistoricalAgent.status, 200);
      assert.deepEqual(await metricIds(managerToken, "cs"), [csAgentId]);
      assert.deepEqual((await pool.query<{ active: boolean }>("SELECT active FROM team_agents WHERE id = $1", [csAgentId])).rows, [{ active: false }]);

      const ownTeamGrant = await fetch(`${origin}/users/${agentUserId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accessRole: "agent", teamAgentId: agentId, primaryTeam: null,
          teamGrants: ["retention"], tabGrants: ["violations"],
          permissions: ["view_metrics", "view_attendance"],
        }),
      });
      assert.equal(ownTeamGrant.status, 200);
      assert.deepEqual(new Set(await metricIds(agentToken, "retention")), new Set([agentId, retentionPeerId]));

      const otherTeamGrant = await fetch(`${origin}/users/${agentUserId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accessRole: "agent", teamAgentId: agentId, primaryTeam: null,
          teamGrants: ["retention", "cs"], tabGrants: ["violations"],
          permissions: ["view_metrics", "view_attendance"],
        }),
      });
      assert.equal(otherTeamGrant.status, 200);
      assert.deepEqual(await metricIds(agentToken, "cs"), [csAgentId]);
      assert.deepEqual(await metricIds(agentToken, "killers"), []);
    });

    await t.test("password creation and reset hash safely, enforce byte limits, preserve blank edits, and revoke sessions", async () => {
      const stored = await pool.query<{ password_hash: string }>("SELECT password_hash FROM portal_users WHERE id = $1", [agentUserId]);
      const initialHash = stored.rows[0]!.password_hash;
      assert.notEqual(initialHash, initialAgentPassword);
      assert.equal(await bcrypt.compare(initialAgentPassword, initialHash), true);

      for (const [suffix, password] of [
        ["short-password", "too short"],
        ["long-password", "é".repeat(37)],
      ]) {
        const response = await postUser({
          username: `${usernamePrefix}-${suffix}`,
          password,
          accessRole: "manager",
          teamAgentId: null,
          primaryTeam: "retention",
          teamGrants: [],
          tabGrants: [],
          permissions: ["view_metrics"],
        });
        assert.equal(response.status, 400);
      }

      const beforeResetLogin = await login(`${usernamePrefix}-agent`, initialAgentPassword);
      assert.equal(beforeResetLogin.status, 200);
      const beforeResetBody = await beforeResetLogin.json() as { token: string };
      const resetResponse = await fetch(`${origin}/users/${agentUserId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: resetAgentPassword }),
      });
      assert.equal(resetResponse.status, 200);
      const resetBody = await resetResponse.json() as Record<string, unknown>;
      assert.equal(Object.prototype.hasOwnProperty.call(resetBody, "passwordHash"), false);
      const resetStored = await pool.query<{ password_hash: string }>("SELECT password_hash FROM portal_users WHERE id = $1", [agentUserId]);
      const resetHash = resetStored.rows[0]!.password_hash;
      assert.notEqual(resetHash, initialHash);
      assert.notEqual(resetHash, resetAgentPassword);
      assert.equal(await bcrypt.compare(resetAgentPassword, resetHash), true);
      assert.equal((await fetch(`${origin}/protected-fixture`, {
        headers: { Authorization: `Bearer ${beforeResetBody.token}`, "x-fixture-real-auth": "1" },
      })).status, 401);

      const blankResponse = await fetch(`${origin}/users/${agentUserId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          password: "",
          accessRole: "agent",
          teamAgentId: agentId,
          primaryTeam: null,
          teamGrants: [],
          tabGrants: ["violations"],
          permissions: ["view_metrics", "view_attendance"],
        }),
      });
      assert.equal(blankResponse.status, 200);
      const afterBlank = await pool.query<{ password_hash: string }>("SELECT password_hash FROM portal_users WHERE id = $1", [agentUserId]);
      assert.equal(afterBlank.rows[0]!.password_hash, resetHash);

      const forbiddenReset = await fetch(`${origin}/users/${agentUserId}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${managerToken}`,
          "content-type": "application/json",
          "x-fixture-real-auth": "1",
        },
        body: JSON.stringify({ password: "unauthorized horse battery staple" }),
      });
      assert.equal(forbiddenReset.status, 403);
    });

    await t.test("database invariants reject invalid role shape and duplicate normalized grants", async () => {
      await assert.rejects(
        pool.query(
          `INSERT INTO portal_users (username, password_hash, role, permissions, access_role, active)
           VALUES ($1, 'fixture-hash', 'view', '[]', 'agent', true)`,
          [`${usernamePrefix}-invalid-shape`],
        ),
        (error: unknown) => (error as { code?: string; constraint?: string }).code === "23514"
          && (error as { constraint?: string }).constraint === "portal_users_canonical_access_shape_check",
      );
      for (const [suffix, accessRole, teamAgentId, primaryTeam] of [
        ["manager-no-primary", "manager", null, null],
        ["manager-with-agent", "manager", inactiveAgentId, "nsf"],
        ["admin-with-agent", "admin", inactiveAgentId, null],
        ["admin-with-primary", "admin", null, "nsf"],
      ] as const) {
        await assert.rejects(
          pool.query(
            `INSERT INTO portal_users
              (username, password_hash, role, permissions, access_role, team_agent_id, primary_team, active)
             VALUES ($1, 'fixture-hash', 'view', '[]', $2, $3, $4, true)`,
            [`${usernamePrefix}-${suffix}`, accessRole, teamAgentId, primaryTeam],
          ),
          (error: unknown) => (error as { code?: string; constraint?: string }).code === "23514"
            && (error as { constraint?: string }).constraint === "portal_users_canonical_access_shape_check",
        );
      }
      await assert.rejects(
        pool.query(
          `INSERT INTO portal_users
            (username, password_hash, role, permissions, access_role, team_agent_id, active)
           VALUES ($1, 'fixture-hash', 'view', '[]', 'agent', 2147483647, true)`,
          [`${usernamePrefix}-invalid-agent-fk`],
        ),
        (error: unknown) => (error as { code?: string; constraint?: string }).code === "23503"
          && (error as { constraint?: string }).constraint === "portal_users_team_agent_id_team_agents_id_fk",
      );
      await assert.rejects(
        pool.query("DELETE FROM team_agents WHERE id = $1", [agentId]),
        (error: unknown) => (error as { code?: string; constraint?: string }).code === "23503"
          && (error as { constraint?: string }).constraint === "portal_users_team_agent_id_team_agents_id_fk",
      );
      const killers = await pool.query<{ primary_team: string }>(
        `INSERT INTO portal_users
          (username, password_hash, role, permissions, access_role, primary_team, active)
         VALUES ($1, 'fixture-hash', 'view', '[]', 'manager', 'killers', true)
         RETURNING primary_team`,
        [`${usernamePrefix}-killers-manager`],
      );
      assert.deepEqual(killers.rows, [{ primary_team: "killers" }]);
      await pool.query(
        "INSERT INTO portal_user_team_grants (portal_user_id, team) VALUES ($1, 'retention')",
        [managerUserId],
      );
      await assert.rejects(
        pool.query("INSERT INTO portal_user_team_grants (portal_user_id, team) VALUES ($1, 'retention')", [managerUserId]),
        (error: unknown) => (error as { code?: string; constraint?: string }).code === "23505"
          && (error as { constraint?: string }).constraint === "portal_user_team_grants_user_team_uidx",
      );
      await pool.query(
        "INSERT INTO portal_user_tab_grants (portal_user_id, tab) VALUES ($1, 'qa') ON CONFLICT DO NOTHING",
        [agentUserId],
      );
      await assert.rejects(
        pool.query("INSERT INTO portal_user_tab_grants (portal_user_id, tab) VALUES ($1, 'qa')", [agentUserId]),
        (error: unknown) => (error as { code?: string; constraint?: string }).code === "23505"
          && (error as { constraint?: string }).constraint === "portal_user_tab_grants_user_tab_uidx",
      );
      assert.ok(adminUserId > 0);
    });

    await t.test("inactive Agent state denies login, refresh, auth-me, and protected requests; reactivation restores eligibility", async () => {
      const authenticated = await login(`${usernamePrefix}-agent`, resetAgentPassword);
      assert.equal(authenticated.status, 200);
      const authenticatedBody = await authenticated.json() as { token: string };
      const refreshCookie = authenticated.headers.get("set-cookie");
      assert.ok(refreshCookie);
      const session = await sessions.createRefreshSession(agentUserId);
      assert.equal(await sessions.isActiveAccessSession(session.id, agentUserId), true);
      const deactivateResponse = await fetch(`${origin}/team-agents/${agentId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ active: false }),
      });
      assert.equal(deactivateResponse.status, 200);
      assert.equal(await sessions.isActiveAccessSession(session.id, agentUserId), false);
      assert.equal(await authUser.loadAuthenticatablePortalUser(agentUserId), null);
      for (const path of ["/protected-fixture", "/auth/me"]) {
        const response = await fetch(`${origin}${path}`, {
          headers: { Authorization: `Bearer ${authenticatedBody.token}`, "x-fixture-real-auth": "1" },
        });
        assert.equal(response.status, 401, path);
      }
      const refreshResponse = await fetch(`${origin}/auth/refresh`, {
        method: "POST",
        headers: { Cookie: refreshCookie!, "x-fixture-real-auth": "1" },
      });
      assert.equal(refreshResponse.status, 401);
      const inactiveLogin = await login(`${usernamePrefix}-agent`, resetAgentPassword);
      assert.equal(inactiveLogin.status, 401);
      assert.deepEqual(await inactiveLogin.json(), { error: "Invalid credentials" });
      assert.equal(await login(`${usernamePrefix}-manager`, managerPassword).then(({ status }) => status), 200);
      assert.equal(await login(`${usernamePrefix}-admin`, adminPassword).then(({ status }) => status), 200);

      const reactivateResponse = await fetch(`${origin}/team-agents/${agentId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ active: true }),
      });
      assert.equal(reactivateResponse.status, 200);
      assert.ok(await authUser.loadAuthenticatablePortalUser(agentUserId));
      const reactivatedLogin = await login(`${usernamePrefix}-agent`, resetAgentPassword);
      assert.equal(reactivatedLogin.status, 200);
      const reactivatedBody = await reactivatedLogin.json() as { token: string };

      const deactivatePortal = await fetch(`${origin}/users/${agentUserId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ active: false }),
      });
      assert.equal(deactivatePortal.status, 200);
      assert.equal((await login(`${usernamePrefix}-agent`, resetAgentPassword)).status, 401);
      assert.equal((await fetch(`${origin}/protected-fixture`, {
        headers: { Authorization: `Bearer ${reactivatedBody.token}`, "x-fixture-real-auth": "1" },
      })).status, 401);
      assert.equal((await fetch(`${origin}/users/${agentUserId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ active: true }),
      })).status, 200);
      assert.equal((await login(`${usernamePrefix}-agent`, resetAgentPassword)).status, 200);
    });
  } finally {
    await pool.query("DELETE FROM portal_users WHERE username LIKE $1", [`${usernamePrefix}%`]);
    await pool.query("DELETE FROM team_agents WHERE name_normalized LIKE $1", [`${agentPrefix}%`]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  }
});
