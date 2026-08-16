import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import test from "node:test";
import express from "express";
import type { AuthPayload } from "../middleware/authCore.js";
import {
  canAccessLiveAgent,
  createAuthorizationAgentDirectory,
} from "../lib/authorizationScope.js";
import {
  authorizeApiDateParameters,
  authorizeApiRoute,
} from "../routes/authorizationPolicy.js";

const endpoint = "/attendance/agent-contacts";
const databaseUrl = process.env["DATABASE_URL"];
process.env["DATABASE_URL"] ??=
  "postgresql://fixture:fixture@127.0.0.1:9/fixture";

const viewer: AuthPayload = {
  userId: 301,
  username: "sanitized-attendance-viewer",
  role: "view",
  permissions: ["view_attendance"],
  teamAccess: "retention",
  allowedAgents: ["Agent Alpha"],
};
const admin: AuthPayload = {
  ...viewer,
  userId: 1,
  username: "sanitized-admin",
  role: "admin",
  permissions: [],
  teamAccess: null,
  allowedAgents: null,
};

async function endpointStatus(user?: AuthPayload): Promise<number> {
  const { default: apiRouter } = await import("../routes/index.js");
  const app = express();
  if (user) {
    app.use((req, _res, next) => {
      req.user = user;
      next();
    });
  }
  app.use("/api", apiRouter);
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api${endpoint}?agent=Agent%20Alpha&date=2000-01-01`,
    );
    return response.status;
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test.after(() => {
  if (databaseUrl === undefined) delete process.env["DATABASE_URL"];
  else process.env["DATABASE_URL"] = databaseUrl;
});

test("agent contacts rejects unauthenticated requests and users without view_attendance", async () => {
  assert.equal(await endpointStatus(), 401);
  assert.equal(await endpointStatus({ ...viewer, permissions: [] }), 403);
  assert.equal(authorizeApiRoute("GET", endpoint, undefined).allowed, false);
  assert.equal(
    authorizeApiRoute("GET", endpoint, { ...viewer, permissions: [] }).allowed,
    false,
  );
});

test("agent contacts rejects another date for a today-only user", async () => {
  assert.equal(await endpointStatus({ ...viewer, lockToToday: true }), 403);
  assert.equal(
    authorizeApiDateParameters(
      "GET",
      endpoint,
      { ...viewer, lockToToday: true },
      { date: "2000-01-01" },
      {},
      new Date("2026-08-12T18:00:00Z"),
    ),
    false,
  );
});

test("agent request and returned rows use authoritative agent scope while admins retain access", () => {
  const directory = createAuthorizationAgentDirectory([
    { name: "Agent Alpha", arabicName: "Alpha Alias", team: "retention" },
    { name: "Agent Beta", arabicName: null, team: "cs" },
  ]);
  const requestedAgent = "Agent Beta";
  const matchingAgents = directory.agents.filter((agent) =>
    agent.name.toLowerCase().includes(requestedAgent.toLowerCase()),
  );
  assert.equal(
    matchingAgents.some((agent) =>
      canAccessLiveAgent(viewer, agent.name, directory),
    ),
    false,
  );

  const rows = [
    { id: "allowed-row", agentName: "Agent Alpha" },
    { id: "forbidden-row", agentName: "Agent Beta" },
  ];
  assert.deepEqual(
    rows
      .filter(
        (row) =>
          !!row.agentName &&
          canAccessLiveAgent(viewer, row.agentName, directory),
      )
      .map((row) => row.id),
    ["allowed-row"],
  );
  assert.equal(authorizeApiRoute("GET", endpoint, admin).allowed, true);
  assert.equal(
    authorizeApiDateParameters(
      "GET",
      endpoint,
      admin,
      { date: "2000-01-01" },
      {},
    ),
    true,
  );
  assert.deepEqual(
    rows.filter((row) => canAccessLiveAgent(admin, row.agentName, directory)),
    rows,
  );
});

test("agent-contact route wires independent controls before contact aggregation", async () => {
  const attendance = await readFile(
    new URL("../routes/attendance.ts", import.meta.url),
    "utf8",
  );
  const policy = await readFile(
    new URL("../routes/authorizationPolicy.ts", import.meta.url),
    "utf8",
  );
  assert.match(attendance, /router\.use\("\/attendance", requireAuth\)/);
  assert.match(
    policy,
    /\/attendance\\\/\(\?:call-logs\|agent-contacts\).*view_attendance/,
  );

  const route = attendance.slice(
    attendance.indexOf('router.get("/attendance/agent-contacts"'),
  );
  const dateScope = route.indexOf("canAccessDateRange(req.user!");
  const requestAgentScope = route.indexOf(
    "matchingAgents.some((agent) => canAccessLiveAgent",
  );
  const databaseQuery = route.indexOf("const matchingRows = await attendanceRepository");
  const rowScope = route.indexOf("const rows = matchingRows.filter");
  const aggregation = route.indexOf("const contactMap = new Map");
  assert.ok(dateScope >= 0);
  assert.ok(requestAgentScope > dateScope);
  assert.ok(databaseQuery > requestAgentScope);
  assert.ok(rowScope > databaseQuery);
  assert.ok(aggregation > rowScope);
});
