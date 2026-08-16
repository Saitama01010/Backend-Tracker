import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import bcrypt from "bcryptjs";
import pg from "pg";

const PORT = 8080;
const FIXED_DATE = "2026-08-16";
const ADMIN_EMAIL = "phase-one-admin@example.test";
const ADMIN_PASSWORD = "Phase1-Only!2026";
const fixtureRoot = path.join(import.meta.dirname, "fixtures");

function requiredDisposableDatabaseUrl(): string {
  const raw = (process.env["FULL_STACK_TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"])?.trim();
  if (!raw) throw new Error("FULL_STACK_TEST_DATABASE_URL or DATABASE_URL is required");
  const url = new URL(raw);
  const local = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  const safeName = /(?:test|phase1)/i.test(url.pathname);
  if (!local || !safeName) {
    throw new Error("Full-stack contracts require a local disposable PostgreSQL database whose name contains test or phase1");
  }
  return raw;
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function installProviderFixtures(sheet1: Record<string, { values: unknown[][] }>, sheet2: { idpHandledRetained: { values: unknown[][] } }, readyModeCsv: string): void {
  const originalFetch = globalThis.fetch;
  const sheetTitles = new Map<number, string>([
    [0, "Primary"],
    [837_339_339, "Retention Current"],
    [871_007_220, "IDP Handled"],
    [1_018_337_469, "IDP Cancel Retained"],
  ]);
  const fixtureAgents = ["Agent Alpha", "Agent Beta", "Agent Gamma", "Agent Delta"];
  const defaultSheetValues = [
    ["Timestamp", "Agent Name", "File ID", "File Status", "Cancel request update", "Notes"],
    ...Array.from({ length: 250 }, (_, index) => [
      `8/16/2026 ${String(8 + Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00`,
      fixtureAgents[index % fixtureAgents.length]!,
      `FILE-${String(index + 1).padStart(4, "0")}`,
      index % 5 === 0 ? "Retained" : "Fixed",
      index % 5 === 0 ? "Retained" : "",
      "sanitized fixture",
    ]),
  ];
  const sheetValuesByTitle = new Map<string, unknown[][]>([
    ["Primary", defaultSheetValues],
    ["Retention Current", defaultSheetValues],
    ["IDP Handled", sheet1.idpHandled?.values ?? defaultSheetValues],
    ["IDP Cancel Retained", sheet2.idpHandledRetained.values],
  ]);
  const pbxDashboard = {
    activeCalls: 1,
    totalAgents: 4,
    onlineAgents: 4,
    availableAgents: 3,
    totalCallsToday: 25,
    avgDurationToday: 184,
    totalInboundToday: 9,
    totalOutboundToday: 16,
    missedCallsToday: 2,
    callsByAgent: [
      { agentName: "Agent Alpha", calls: 9, inbound: 3, outbound: 6, avgDuration: 190 },
      { agentName: "Agent Beta", calls: 7, inbound: 2, outbound: 5, avgDuration: 170 },
      { agentName: "Agent Gamma", calls: 5, inbound: 3, outbound: 2, avgDuration: 210 },
      { agentName: "Agent Delta", calls: 4, inbound: 1, outbound: 3, avgDuration: 150 },
    ],
    liveCalls: [{ id: 9001, direction: "outbound", callerNumber: "fixture-line", calledNumber: "fixture-contact", phoneLabel: "Fixture", ringGroupName: "Retention", agentName: "Agent Alpha", duration: 42, startedAt: `${FIXED_DATE}T17:00:00.000Z` }],
    agentStatuses: [
      { id: 1, name: "Agent Alpha", extension: "1001", status: "available", callsToday: 9 },
      { id: 2, name: "Agent Beta", extension: "1002", status: "available", callsToday: 7 },
      { id: 3, name: "Agent Gamma", extension: "1003", status: "busy", callsToday: 5 },
      { id: 4, name: "Agent Delta", extension: "1004", status: "available", callsToday: 4 },
    ],
  };

  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.hostname === "oauth2.googleapis.com") {
      return jsonResponse({ access_token: "sanitized-fixture-token", expires_in: 3600 });
    }
    if (url.hostname === "sheets.googleapis.com") {
      if (!url.pathname.includes("/values/")) {
        return jsonResponse({ sheets: [...sheetTitles].map(([sheetId, title]) => ({ properties: { sheetId, title } })) });
      }
      const title = decodeURIComponent(url.pathname.split("/values/")[1] ?? "Primary");
      return jsonResponse({ values: sheetValuesByTitle.get(title) ?? defaultSheetValues });
    }
    if (url.hostname === "docs.google.com" && url.pathname.includes("/export")) {
      return new Response(readyModeCsv, { headers: { "content-type": "text/csv" } });
    }
    if (url.hostname === "phonesystem.voslogic.com") {
      if (url.pathname === "/api/auth/login") {
        return jsonResponse({ ok: true }, { headers: { "set-cookie": "phase1_fixture=1; Path=/; HttpOnly" } });
      }
      if (url.pathname === "/api/agents") {
        return jsonResponse(pbxDashboard.agentStatuses.map((agent) => ({ ...agent, role: "agent", email: "", ringGroupIds: [agent.id] })));
      }
      if (url.pathname === "/api/ring-groups") {
        return jsonResponse([
          { id: 1, name: "Retention", agentIds: [1] },
          { id: 2, name: "NSF Back Office", agentIds: [2] },
          { id: 3, name: "Customer Support", agentIds: [3] },
          { id: 4, name: "Retention Overflow", agentIds: [4] },
        ]);
      }
      if (url.pathname === "/api/dashboard") return jsonResponse(pbxDashboard);
      if (url.pathname === "/api/calls") return jsonResponse({ calls: [], total: 0 });
      return jsonResponse({});
    }
    if (url.hostname === "api.openphone.com") {
      if (url.pathname.includes("phone-numbers")) return jsonResponse({ data: [] });
      if (url.pathname.includes("users")) return jsonResponse({ data: [] });
      return jsonResponse({ data: [], totalItems: 0 });
    }
    return originalFetch(input, init);
  };
}

async function resetAndSeed(connectionString: string): Promise<void> {
  const { Pool } = pg;
  const pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5_000 });
  try {
    const tableResult = await pool.query<{ tablename: string }>(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> '__drizzle_migrations'
      ORDER BY tablename
    `);
    const quotedTables = tableResult.rows.map(({ tablename }) => `"${tablename.replaceAll('"', '""')}"`);
    if (quotedTables.length > 0) await pool.query(`TRUNCATE TABLE ${quotedTables.join(", ")} RESTART IDENTITY CASCADE`);

    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    await pool.query(`
      INSERT INTO team_agents(name, name_normalized, team, active)
      VALUES
        ('Agent Alpha', 'agent alpha', 'retention', true),
        ('Agent Beta', 'agent beta', 'nsf', true),
        ('Agent Gamma', 'agent gamma', 'cs', true),
        ('Agent Delta', 'agent delta', 'killers', true)
    `);
    await pool.query(`
      INSERT INTO portal_users(
        username, email, email_normalized, password_hash, password_policy_version,
        role, permissions, active
      ) VALUES (
        'phase-one-admin', $1, $1, $2, 1,
        'admin', '["view_metrics","view_attendance","edit_attendance","manage_members","view_missed_tables"]', true
      )
    `, [ADMIN_EMAIL, passwordHash]);
    await pool.query(`
      INSERT INTO phone_calls(
        id, agent_name, agent_id, line_id, line_team, participant, direction,
        status, line_name, duration_seconds, post_answer_seconds, created_at, synced_at
      ) VALUES
        ('phase1-call-1', 'Agent Alpha', 'agent-alpha', 'line-ret', 'retention', 'sanitized-contact-1', 'outgoing', 'completed', 'Retention Main', 240, 180, $1::date + time '09:00', now()),
        ('phase1-call-2', 'Agent Alpha', 'agent-alpha', 'line-ret', 'retention', 'sanitized-contact-2', 'incoming', 'completed', 'Retention Main', 180, null, $1::date + time '10:00', now()),
        ('phase1-call-3', 'Agent Beta', 'agent-beta', 'line-nsf', 'nsf', 'sanitized-contact-3', 'outgoing', 'voicemail', 'NSF Main', 55, 30, $1::date + time '11:00', now()),
        ('phase1-call-4', 'Agent Gamma', 'agent-gamma', 'line-cs', 'cs', 'sanitized-contact-4', 'incoming', 'missed', 'CS Main', 0, null, $1::date + time '12:00', now()),
        ('phase1-call-5', 'Agent Delta', 'agent-delta', 'line-rmk', 'killers', 'sanitized-contact-5', 'outgoing', 'completed', 'RMK Main', 300, 240, $1::date + time '13:00', now())
    `, [FIXED_DATE]);
    await pool.query(`
      INSERT INTO readymode_uploads(agent_name, stat_date, dialed, talk_secs, uploaded_by)
      VALUES
        ('Agent Alpha', $1, 12, 1230, 'phase1-fixture'),
        ('Agent Beta', $1, 7, 600, 'phase1-fixture'),
        ('Agent Delta', $1, 5, 486, 'phase1-fixture')
    `, [FIXED_DATE]);
    await pool.query(`
      INSERT INTO onboarding_classifications(call_id, call_type, customer_name, closer_agent, mentions_tax, tx_status, notes)
      VALUES ('phase1-call-1', 'onboarded', 'Sanitized Customer', 'Agent Alpha', false, 'completed', 'fixture')
    `);
    await pool.query(`
      INSERT INTO live_transfer_classifications(call_id, is_live, kind, company, agent, evidence, tx_status)
      VALUES ('phase1-call-2', true, 'internal', 'Retention', 'Agent Alpha', 'sanitized fixture', 'completed')
    `);
    await pool.query(`
      INSERT INTO qa_reviews(
        id, agent_name, phone_number, call_date, line_team, department, transcript,
        ai_summary, score, soft_skills_score, protocol_score, pass, critical_fail,
        strengths, missed_items, critical_issues, category_scores, reason,
        manager_review_required, model, source
      ) VALUES (
        'phase1-call-1', 'Agent Alpha', null, $1::date + time '09:00', 'retention', 'Retention', null,
        'Sanitized fixture', 91, 45, 46, true, false,
        '["clear"]', '[]', '[]', '{"quality":91}', 'fixture', false, 'fixture', 'legacy'
      )
    `, [FIXED_DATE]);
    await pool.query(`
      INSERT INTO qa_biweekly_runs(trigger, status, result, started_at, finished_at)
      VALUES ('phase1-fixture', 'completed', '{"evaluated":1,"skipped":0}', now(), now())
    `);
  } finally {
    await pool.end();
  }
}

const databaseUrl = requiredDisposableDatabaseUrl();
process.env["DATABASE_URL"] = databaseUrl;
process.env["NODE_ENV"] = "test";
process.env["SESSION_SECRET"] = "phase1-full-stack-session-secret-at-least-32-bytes";
process.env["ENABLE_BACKGROUND_JOBS"] = "false";
process.env["FRONTEND_ORIGIN"] = "http://127.0.0.1:4176,http://127.0.0.1:4178";
process.env["VOSLOGIC_EMAIL"] = "fixture@example.test";
process.env["VOSLOGIC_PASSWORD"] = "fixture-only";
process.env["QUO_API_KEY"] = "fixture-only";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env["GOOGLE_SA_CLIENT_EMAIL"] = "fixture-service-account@example.test";
process.env["GOOGLE_SA_PRIVATE_KEY"] = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const [sheet1, sheet2, readyModeCsv] = await Promise.all([
  readFile(path.join(fixtureRoot, "sheets", "google-sheet-1.json"), "utf8").then((value) => JSON.parse(value) as Record<string, { values: unknown[][] }>),
  readFile(path.join(fixtureRoot, "sheets", "google-sheet-2.json"), "utf8").then((value) => JSON.parse(value) as { idpHandledRetained: { values: unknown[][] } }),
  readFile(path.join(fixtureRoot, "readymode", "valid.csv"), "utf8"),
]);
installProviderFixtures(sheet1, sheet2, readyModeCsv);
await resetAndSeed(databaseUrl);

const { default: app } = await import("../app.js");
const server = http.createServer(app);
server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`PHASE1_FULL_STACK_SERVER_READY http://127.0.0.1:${PORT}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
