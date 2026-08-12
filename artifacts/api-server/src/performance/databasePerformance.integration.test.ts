import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import test from "node:test";
import pg, { type PoolClient, type QueryResult } from "pg";
import {
  attendanceImportMemberKey,
  buildAttendanceImportPlan,
  buildQuoFirstCallMap,
  planWeeklyQaAssignments,
  type AttendanceImportCandidate,
  type WeeklyQaPick,
  type WeeklyQaReview,
} from "../lib/databasePerformance.js";

const { Pool } = pg;
const fileDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(fileDir, "../../../..");

function safePerformanceDatabaseUrl(): string | null {
  const raw = process.env.PERFORMANCE_DATABASE_URL?.trim();
  if (!raw) return null;
  const url = new URL(raw);
  const localHost = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  const database = url.pathname.slice(1).toLowerCase();
  if (!localHost || (!database.includes("test") && !database.includes("performance"))) {
    throw new Error("PERFORMANCE_DATABASE_URL must target a local database whose name contains test or performance");
  }
  return raw;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function serializeFirstCalls(map: Map<string, Date>) {
  return [...map].map(([agent, date]) => [agent, date.toISOString()]).sort(([a], [b]) => a.localeCompare(b));
}

function legacyFirstCalls(rows: readonly { agent_name: string | null; created_at: Date | null }[]) {
  const values = new Map<string, Date[]>();
  for (const row of rows) {
    if (!row.agent_name || !row.created_at) continue;
    const key = row.agent_name.trim().toLowerCase();
    const calls = values.get(key);
    if (calls) calls.push(row.created_at);
    else values.set(key, [row.created_at]);
  }
  return new Map([...values].map(([key, calls]) => [
    key,
    calls.reduce((earliest, call) => call < earliest ? call : earliest),
  ]));
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function planEvidence(result: QueryResult): {
  nodeTypes: string[];
  indexes: string[];
  executionMs: number | null;
  rowsExamined: number | null;
  sharedBlocks: number | null;
} {
  const root = result.rows[0]?.["QUERY PLAN"]?.[0];
  const nodeTypes = new Set<string>();
  const indexes = new Set<string>();
  function visit(node: Record<string, unknown> | undefined) {
    if (!node) return;
    if (typeof node["Node Type"] === "string") nodeTypes.add(node["Node Type"]);
    if (typeof node["Index Name"] === "string") indexes.add(node["Index Name"]);
    const children = node["Plans"];
    if (Array.isArray(children)) for (const child of children) visit(child as Record<string, unknown>);
  }
  visit(root?.Plan);
  return {
    nodeTypes: [...nodeTypes],
    indexes: [...indexes],
    executionMs: typeof root?.["Execution Time"] === "number" ? root["Execution Time"] : null,
    rowsExamined: typeof root?.Plan?.["Actual Rows"] === "number"
      ? root.Plan["Actual Rows"] + (typeof root.Plan["Rows Removed by Filter"] === "number" ? root.Plan["Rows Removed by Filter"] : 0)
      : null,
    sharedBlocks: root?.Plan
      ? Number(root.Plan["Shared Hit Blocks"] ?? 0) + Number(root.Plan["Shared Read Blocks"] ?? 0)
      : null,
  };
}

function percentile(values: number[], quantile: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * quantile) - 1)]!;
}

type LegacyDashboardCall = {
  agent_name: string | null;
  line_id: string;
  line_name: string;
  line_team: string;
  participant: string;
  direction: string;
  status: string;
  duration_seconds: number;
  post_answer_seconds: number | null;
  created_at: Date;
};

type ComparableDashboardAggregate = {
  kind: "team" | "all" | "line" | "meta";
  resolvedTeam: string | null;
  agentName: string | null;
  day: string | null;
  lineId: string | null;
  lineName: string | null;
  totalCalls: number;
  outbound: number;
  inbound: number;
  answered: number;
  missed: number;
  voicemail: number;
  vmBrief: number;
  talkSeconds: number;
  uniqueContacts: number;
  lastCall: string | null;
};

function legacyEffectiveStatus(row: LegacyDashboardCall): string {
  if (row.status !== "completed") return row.status;
  if (row.direction === "outgoing") {
    if (row.post_answer_seconds !== null) {
      if (row.post_answer_seconds >= 60) return "completed";
      if (row.post_answer_seconds >= 20) return "voicemail";
      return "voicemail-brief";
    }
    if (row.duration_seconds >= 75) return "completed";
    if (row.duration_seconds >= 35) return "voicemail";
    return "voicemail-brief";
  }
  if (row.direction === "incoming" && row.duration_seconds === 0 && row.post_answer_seconds === null) {
    return "voicemail-brief";
  }
  return "completed";
}

function comparableSort(rows: ComparableDashboardAggregate[]): ComparableDashboardAggregate[] {
  return rows.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function legacyDashboardAggregates(
  rows: readonly LegacyDashboardCall[],
  blockedNumbers: ReadonlySet<string>,
): ComparableDashboardAggregate[] {
  type MutableBucket = Omit<ComparableDashboardAggregate, "uniqueContacts" | "lastCall"> & {
    uniqueContacts: Set<string>;
    lastCall: Date | null;
  };
  const buckets = new Map<string, MutableBucket>();
  const getBucket = (
    key: string,
    base: Pick<ComparableDashboardAggregate, "kind" | "resolvedTeam" | "agentName" | "day" | "lineId" | "lineName">,
  ) => {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        ...base,
        totalCalls: 0,
        outbound: 0,
        inbound: 0,
        answered: 0,
        missed: 0,
        voicemail: 0,
        vmBrief: 0,
        talkSeconds: 0,
        uniqueContacts: new Set<string>(),
        lastCall: null,
      };
      buckets.set(key, bucket);
    }
    return bucket;
  };
  const increment = (bucket: MutableBucket, row: LegacyDashboardCall) => {
    const effectiveStatus = legacyEffectiveStatus(row);
    bucket.totalCalls++;
    bucket.talkSeconds += row.duration_seconds;
    if (row.participant) bucket.uniqueContacts.add(row.participant);
    if (row.direction === "outgoing") bucket.outbound++;
    else bucket.inbound++;
    if (effectiveStatus === "completed") bucket.answered++;
    else if (effectiveStatus === "voicemail") bucket.voicemail++;
    else if (effectiveStatus === "voicemail-brief") bucket.vmBrief++;
    else bucket.missed++;
    const end = new Date(row.created_at.getTime() + row.duration_seconds * 1000);
    if (!bucket.lastCall || end > bucket.lastCall) bucket.lastCall = end;
  };

  for (const row of rows) {
    if (row.participant && blockedNumbers.has(row.participant)) continue;
    const agentName = row.agent_name ?? "Unknown";
    const team = ["retention", "nsf", "cs"].includes(row.line_team) ? row.line_team : "other";
    const day = row.created_at.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    increment(getBucket(`team:${team}:${agentName}:${day}`, {
      kind: "team", resolvedTeam: team, agentName, day, lineId: null, lineName: null,
    }), row);
    increment(getBucket(`all:${agentName}:${day}`, {
      kind: "all", resolvedTeam: null, agentName, day, lineId: null, lineName: null,
    }), row);
    if (row.direction === "incoming") {
      const line = getBucket(`line:${row.line_id}:${day}`, {
        kind: "line", resolvedTeam: null, agentName: null, day, lineId: row.line_id, lineName: row.line_name,
      });
      const effectiveStatus = legacyEffectiveStatus(row);
      line.totalCalls++;
      line.inbound++;
      if (effectiveStatus === "completed") line.answered++;
      else if (effectiveStatus === "voicemail") line.voicemail++;
      else line.missed++;
    }
  }
  const comparable = [...buckets.values()].map((row) => ({
    ...row,
    uniqueContacts: row.kind === "line" ? 0 : row.uniqueContacts.size,
    lastCall: row.kind === "line" ? null : row.lastCall?.toISOString() ?? null,
  }));
  comparable.push({
    kind: "meta", resolvedTeam: null, agentName: null, day: null, lineId: null, lineName: null,
    totalCalls: rows.length, outbound: 0, inbound: 0, answered: 0, missed: 0,
    voicemail: 0, vmBrief: 0, talkSeconds: 0, uniqueContacts: 0, lastCall: null,
  });
  return comparableSort(comparable);
}

async function timed<T>(operation: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await operation();
  return { value, ms: Math.round((performance.now() - start) * 100) / 100 };
}

async function applyPerformanceMigration(client: PoolClient) {
  for (const migrationName of ["0008_database_performance.sql", "0012_dashboard_runtime_performance.sql"]) {
    const migration = await readFile(path.join(repoRoot, "lib/db/drizzle", migrationName), "utf8");
    for (const statement of migration.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) {
      await client.query(statement);
    }
  }
}

async function legacyQaAssignment(client: PoolClient, weekStart: Date) {
  let queryCount = 0;
  const reviewsResult = await client.query<WeeklyQaReview>(`
    SELECT id, agent_name AS "agentName", department, score, critical_fail AS "criticalFail"
    FROM qa_reviews
    ORDER BY fixture_order
  `);
  queryCount++;
  const byAgent = new Map<string, WeeklyQaReview[]>();
  for (const review of reviewsResult.rows) {
    const list = byAgent.get(review.agentName);
    if (list) list.push(review);
    else byAgent.set(review.agentName, [review]);
  }
  const random = seededRandom(42);
  const picks: WeeklyQaPick[] = [];
  for (const [agentName, reviews] of byAgent) {
    const weekly = await client.query<{ id: string }>(`
      SELECT id FROM manager_qa_tasks
      WHERE agent_name = $1
        AND source IN ('weekly_lowest', 'weekly_random')
        AND created_at >= $2
    `, [agentName, weekStart]);
    queryCount++;
    if (weekly.rowCount) continue;
    const tasks = await client.query<{ id: string }>(
      "SELECT id FROM manager_qa_tasks WHERE agent_name = $1",
      [agentName],
    );
    queryCount++;
    const existingIds = new Set(tasks.rows.map((task) => task.id));
    const eligible = reviews.filter((review) => !existingIds.has(review.id));
    if (eligible.length === 0) continue;
    const lowest = [...eligible].sort((a, b) => a.score - b.score)[0]!;
    const others = eligible.filter((review) => review.id !== lowest.id);
    const randomReview = others.length > 0 ? others[Math.floor(random() * others.length)]! : null;
    picks.push({
      id: lowest.id,
      agentName,
      department: lowest.department,
      aiScore: lowest.score,
      score: lowest.score,
      reason: `Weekly review: lowest AI score (${lowest.score}/100)`,
      criticalFail: lowest.criticalFail,
      source: "weekly_lowest",
      status: "open",
    });
    if (randomReview) picks.push({
      id: randomReview.id,
      agentName,
      department: randomReview.department,
      aiScore: randomReview.score,
      score: randomReview.score,
      reason: `Weekly review: random sample (${randomReview.score}/100)`,
      criticalFail: randomReview.criticalFail,
      source: "weekly_random",
      status: "open",
    });
  }
  return { picks, agents: byAgent.size, queryCount };
}

test("sanitized database benchmark proves query and batch equivalence", async (t) => {
  const connectionString = safePerformanceDatabaseUrl();
  if (!connectionString) {
    t.skip("PERFORMANCE_DATABASE_URL is not configured");
    return;
  }
  process.env.DATABASE_URL = connectionString;
  const setupPool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5_000 });
  const client = await setupPool.connect();
  let workspacePool: { end(): Promise<void> } | null = null;
  try {
    const dbModule = await import("@workspace/db");
    workspacePool = dbModule.pool;
    await client.query(`
      DROP TABLE IF EXISTS attendance_set_records, attendance_set_members, attendance_import_records, attendance_import_members, attendance_records, attendance_members, manager_qa_tasks, qa_reviews, pbx_missed_calls, phone_calls CASCADE;
      CREATE TABLE phone_calls (
        id text PRIMARY KEY,
        agent_name text,
        line_id text NOT NULL,
        line_team text NOT NULL,
        participant text NOT NULL,
        direction text NOT NULL,
        status text NOT NULL,
        line_name text NOT NULL,
        duration_seconds integer NOT NULL DEFAULT 0,
        post_answer_seconds integer,
        created_at timestamptz NOT NULL,
        synced_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE pbx_missed_calls (
        id integer PRIMARY KEY,
        from_number text NOT NULL,
        created_at timestamptz NOT NULL
      );
      CREATE TABLE attendance_members (
        id serial PRIMARY KEY,
        name text NOT NULL,
        shift text NOT NULL DEFAULT '',
        shift_hours text NOT NULL DEFAULT '8',
        department text NOT NULL DEFAULT '',
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE attendance_records (
        id serial PRIMARY KEY,
        member_id integer NOT NULL REFERENCES attendance_members(id) ON DELETE CASCADE,
        date text NOT NULL,
        attendance_date date,
        status text NOT NULL DEFAULT '',
        note text,
        coaching boolean NOT NULL DEFAULT false,
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT attendance_records_member_date UNIQUE (member_id, date)
      );
      CREATE TABLE qa_reviews (
        fixture_order integer PRIMARY KEY,
        id text NOT NULL,
        agent_name text NOT NULL,
        department text NOT NULL,
        score integer NOT NULL,
        critical_fail boolean NOT NULL,
        call_date timestamptz NOT NULL
      );
      CREATE TABLE manager_qa_tasks (
        id text PRIMARY KEY,
        agent_name text NOT NULL,
        source text NOT NULL,
        created_at timestamptz NOT NULL
      );
      CREATE INDEX manager_qa_tasks_agent ON manager_qa_tasks(agent_name);
      CREATE TABLE attendance_import_members (
        id serial PRIMARY KEY,
        name text NOT NULL,
        shift text NOT NULL,
        department text NOT NULL
      );
      CREATE TABLE attendance_import_records (
        id serial PRIMARY KEY,
        member_id integer NOT NULL REFERENCES attendance_import_members(id) ON DELETE CASCADE,
        date text NOT NULL,
        status text NOT NULL,
        UNIQUE(member_id, date)
      );
      CREATE TABLE attendance_set_members (
        id serial PRIMARY KEY,
        name text NOT NULL,
        active boolean NOT NULL DEFAULT true
      );
      CREATE TABLE attendance_set_records (
        id serial PRIMARY KEY,
        member_id integer NOT NULL REFERENCES attendance_set_members(id) ON DELETE CASCADE,
        date text NOT NULL,
        status text NOT NULL,
        note text,
        coaching boolean NOT NULL DEFAULT false,
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(member_id, date)
      );
    `);

    await client.query(`
      INSERT INTO phone_calls(id, agent_name, line_id, line_team, participant, direction, status, line_name, duration_seconds, post_answer_seconds, created_at, synced_at)
      SELECT
        'sanitized-call-' || value,
        CASE WHEN value % 997 = 0 THEN NULL ELSE 'Synthetic Agent ' || (value % 120) END,
        'synthetic-line-id-' || (value % 8),
        CASE WHEN value % 3 = 0 THEN 'cs' WHEN value % 3 = 1 THEN 'retention' ELSE 'nsf' END,
        'synthetic-contact-' || (value % 5000),
        CASE WHEN value % 4 = 0 THEN 'incoming' ELSE 'outgoing' END,
        CASE WHEN value % 28 = 0 THEN 'missed' WHEN value % 113 = 0 THEN 'in-progress' ELSE 'completed' END,
        'Synthetic Line ' || (value % 8),
        value % 900,
        CASE WHEN value % 4 = 0 THEN NULL ELSE value % 300 END,
        timestamptz '2026-01-01T00:00:00Z' + (value % 129600) * interval '1 minute',
        timestamptz '2026-04-01T00:00:00Z' + (value % 7200) * interval '1 second'
      FROM generate_series(1, 220000) AS value;
      INSERT INTO pbx_missed_calls(id, from_number, created_at)
      SELECT value, 'synthetic-source-' || (value % 1000), timestamptz '2026-01-01T00:00:00Z' + value * interval '1 minute'
      FROM generate_series(1, 12000) AS value;
      INSERT INTO attendance_members(name, shift, department)
      SELECT 'Synthetic Member ' || value, '4', CASE WHEN value % 2 = 0 THEN 'CS' ELSE 'Retention' END
      FROM generate_series(1, 80) AS value;
      INSERT INTO attendance_records(member_id, date, status, note, coaching)
      VALUES (1, '2026-08-03', 'in', NULL, false), (2, '2026-08-03', 'late', 'legacy note', false);
      INSERT INTO qa_reviews(fixture_order, id, agent_name, department, score, critical_fail, call_date)
      SELECT value, 'qa-call-' || value, 'QA Agent ' || (value % 100),
        CASE WHEN value % 3 = 0 THEN 'CS' WHEN value % 3 = 1 THEN 'Retention' ELSE 'NSF' END,
        40 + (value * 17) % 61, value % 31 = 0,
        timestamptz '2026-07-27T07:00:00Z' + (value % 10000) * interval '1 minute'
      FROM generate_series(1, 12000) AS value;
      INSERT INTO manager_qa_tasks(id, agent_name, source, created_at)
      SELECT 'qa-call-' || (value + 100), 'QA Agent ' || value, 'auto_flag', timestamptz '2026-08-01T12:00:00Z'
      FROM generate_series(0, 99) AS value;
      INSERT INTO manager_qa_tasks(id, agent_name, source, created_at)
      SELECT 'current-weekly-' || value, 'QA Agent ' || (value * 10), 'weekly_lowest', timestamptz '2026-08-04T12:00:00Z'
      FROM generate_series(0, 9) AS value;
      INSERT INTO attendance_import_members(name, shift, department)
      SELECT 'Import Agent ' || value, '4', 'CS' FROM generate_series(0, 19) AS value;
      INSERT INTO attendance_set_members(name)
      SELECT 'Set Agent ' || value FROM generate_series(1, 200) AS value;
      INSERT INTO attendance_set_records(member_id, date, status)
      SELECT value, '2026-08-03', 'in' FROM generate_series(1, 100) AS value;
    `);
    await client.query("ANALYZE phone_calls");
    const dashboardFrom = new Date("2026-02-01T00:00:00Z");
    const dashboardTo = new Date("2026-02-28T23:59:59.999Z");
    const oldDashboardPlan = planEvidence(await client.query(`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT agent_name, line_name, line_team, line_id, participant, direction,
             status, duration_seconds, created_at
      FROM phone_calls
      WHERE created_at >= $1 AND created_at <= $2 AND status <> 'in-progress'
    `, [dashboardFrom, dashboardTo]));

    await applyPerformanceMigration(client);
    // Prove rerunning the migration does not create duplicate index definitions.
    await applyPerformanceMigration(client);
    await client.query("VACUUM (ANALYZE) phone_calls");
    await client.query("ANALYZE pbx_missed_calls; ANALYZE attendance_records; ANALYZE qa_reviews; ANALYZE manager_qa_tasks;");
    const newDashboardPlan = planEvidence(await client.query(`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT agent_name, line_name, line_team, line_id, participant, direction,
             status, duration_seconds, created_at
      FROM phone_calls
      WHERE created_at >= $1 AND created_at <= $2 AND status <> 'in-progress'
    `, [dashboardFrom, dashboardTo]));
    await client.query("SET enable_indexscan = off; SET enable_indexonlyscan = off; SET enable_bitmapscan = off");
    const sequentialDashboardSamples = [];
    for (let sample = 0; sample < 6; sample++) {
      const evidence = planEvidence(await client.query(`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT agent_name, line_name, line_team, line_id, participant, direction,
               status, duration_seconds, created_at
        FROM phone_calls
        WHERE created_at >= $1 AND created_at <= $2 AND status <> 'in-progress'
      `, [dashboardFrom, dashboardTo]));
      if (sample > 0) sequentialDashboardSamples.push(evidence.executionMs!);
    }
    await client.query("RESET enable_indexscan; RESET enable_indexonlyscan; RESET enable_bitmapscan; SET enable_seqscan = off");
    const indexedDashboardSamples = [];
    for (let sample = 0; sample < 6; sample++) {
      const evidence = planEvidence(await client.query(`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT agent_name, line_name, line_team, line_id, participant, direction,
               status, duration_seconds, created_at
        FROM phone_calls
        WHERE created_at >= $1 AND created_at <= $2 AND status <> 'in-progress'
      `, [dashboardFrom, dashboardTo]));
      if (sample > 0) indexedDashboardSamples.push(evidence.executionMs!);
    }
    await client.query("RESET enable_seqscan");
    const dashboardIndexSize = await client.query<{ bytes: string }>(
      "SELECT pg_relation_size($1)::bigint::text AS bytes",
      ["phone_calls_dashboard_stats_cover_idx"],
    );
    assert.ok(newDashboardPlan.indexes.includes("phone_calls_dashboard_stats_cover_idx"));
    assert.ok(
      oldDashboardPlan.rowsExamined !== null
        && newDashboardPlan.rowsExamined !== null
        && newDashboardPlan.rowsExamined <= oldDashboardPlan.rowsExamined * 0.5,
    );
    assert.ok(
      oldDashboardPlan.sharedBlocks !== null
        && newDashboardPlan.sharedBlocks !== null
        && newDashboardPlan.sharedBlocks < oldDashboardPlan.sharedBlocks,
    );
    assert.ok(
      percentile(indexedDashboardSamples, 0.5) < percentile(sequentialDashboardSamples, 0.5) * 0.8,
    );

    const dashboardRows = await client.query<LegacyDashboardCall>(`
      SELECT agent_name, line_id, line_name, line_team, participant, direction,
             status, duration_seconds, post_answer_seconds, created_at
      FROM phone_calls
      WHERE created_at >= $1 AND created_at <= $2 AND status <> 'in-progress'
      ORDER BY created_at ASC, id ASC
    `, [dashboardFrom, dashboardTo]);
    const dashboardBlocklist = new Set(["synthetic-contact-42", "synthetic-contact-4242"]);
    const legacyDashboard = legacyDashboardAggregates(dashboardRows.rows, dashboardBlocklist);
    const { loadPhoneStatsAggregates } = await import("../lib/phoneStatsAggregation.js");
    const optimizedDashboardResult = await loadPhoneStatsAggregates({
      fromDate: dashboardFrom,
      toDate: dashboardTo,
      timeZone: "America/Los_Angeles",
      blockedNumbers: dashboardBlocklist,
      resolveDimension: (row) => ({
        agentName: row.rawAgentName ?? "Unknown",
        team: ["retention", "nsf", "cs"].includes(row.lineTeam) ? row.lineTeam : "other",
        authorized: true,
      }),
    });
    const optimizedDashboard = comparableSort(optimizedDashboardResult.rows.map((row) => ({
      ...row,
      lastCall: row.lastCall?.toISOString() ?? null,
    })));
    assert.deepEqual(optimizedDashboard, legacyDashboard);

    const from = new Date("2026-02-10T00:00:00Z");
    const to = new Date("2026-02-10T23:59:59.999Z");
    const oldAttendance = await timed(() => client.query<{ agent_name: string | null; created_at: Date | null }>(`
      SELECT agent_name, created_at FROM phone_calls
      WHERE created_at >= $1 AND created_at <= $2
        AND (direction = 'outgoing' OR (direction = 'incoming' AND status = 'completed'))
    `, [from, to]));
    const newAttendance = await timed(() => client.query<{ agent_name: string | null; first_call_at: Date | null }>(`
      SELECT agent_name, min(created_at) AS first_call_at FROM phone_calls
      WHERE created_at >= $1 AND created_at <= $2
        AND agent_name IS NOT NULL
        AND (direction = 'outgoing' OR (direction = 'incoming' AND status = 'completed'))
      GROUP BY agent_name
    `, [from, to]));
    const oldFirstCalls = serializeFirstCalls(legacyFirstCalls(oldAttendance.value.rows));
    const newFirstCalls = serializeFirstCalls(buildQuoFirstCallMap(newAttendance.value.rows.map((row) => ({
      agentName: row.agent_name,
      firstCallAt: row.first_call_at,
    }))));
    assert.deepEqual(newFirstCalls, oldFirstCalls);

    const oldAttendancePlan = planEvidence(await client.query(`
      EXPLAIN (ANALYZE, FORMAT JSON)
      SELECT agent_name, created_at FROM phone_calls
      WHERE created_at >= $1 AND created_at <= $2
        AND (direction = 'outgoing' OR (direction = 'incoming' AND status = 'completed'))
    `, [from, to]));
    const newAttendancePlan = planEvidence(await client.query(`
      EXPLAIN (ANALYZE, FORMAT JSON)
      SELECT agent_name, min(created_at) FROM phone_calls
      WHERE created_at >= $1 AND created_at <= $2
        AND agent_name IS NOT NULL
        AND (direction = 'outgoing' OR (direction = 'incoming' AND status = 'completed'))
      GROUP BY agent_name
    `, [from, to]));
    assert.ok(newAttendancePlan.indexes.includes("phone_calls_attendance_created_agent_idx"));

    const weekStart = new Date("2026-08-03T07:00:00Z");
    const oldQa = await timed(() => legacyQaAssignment(client, weekStart));
    const newQa = await timed(async () => {
      let queryCount = 0;
      const reviews = await client.query<WeeklyQaReview>(`
        SELECT id, agent_name AS "agentName", department, score, critical_fail AS "criticalFail"
        FROM qa_reviews ORDER BY fixture_order
      `);
      queryCount++;
      const agents = [...new Set(reviews.rows.map((review) => review.agentName))];
      const tasks = await client.query<{
        id: string; agentName: string; source: string; createdAt: Date;
      }>(`
        SELECT id, agent_name AS "agentName", source, created_at AS "createdAt"
        FROM manager_qa_tasks WHERE agent_name = ANY($1::text[])
      `, [agents]);
      queryCount++;
      return { ...planWeeklyQaAssignments(reviews.rows, tasks.rows, weekStart, seededRandom(42)), queryCount };
    });
    assert.deepEqual(newQa.value.picks, oldQa.value.picks);
    assert.equal(newQa.value.agents, oldQa.value.agents);
    assert.ok(newQa.value.queryCount < oldQa.value.queryCount);
    const oldQaWrites = await timed(async () => {
      await client.query("BEGIN");
      try {
        let inserted = 0;
        for (const pick of oldQa.value.picks) {
          const result = await client.query(`
            INSERT INTO manager_qa_tasks(id, agent_name, source, created_at)
            VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id
          `, [pick.id, pick.agentName, pick.source, weekStart]);
          inserted += result.rowCount ?? 0;
        }
        return inserted;
      } finally {
        await client.query("ROLLBACK");
      }
    });
    const newQaWrites = await timed(async () => {
      await client.query("BEGIN");
      try {
        const parameters: unknown[] = [];
        const values = newQa.value.picks.map((pick, index) => {
          const offset = index * 4;
          parameters.push(pick.id, pick.agentName, pick.source, weekStart);
          return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`;
        });
        const result = await client.query(`
          INSERT INTO manager_qa_tasks(id, agent_name, source, created_at)
          VALUES ${values.join(", ")} ON CONFLICT DO NOTHING RETURNING id
        `, parameters);
        return result.rowCount ?? 0;
      } finally {
        await client.query("ROLLBACK");
      }
    });
    assert.equal(newQaWrites.value, oldQaWrites.value);
    const newQaPlan = planEvidence(await client.query(`
      EXPLAIN (ANALYZE, FORMAT JSON)
      SELECT id, agent_name, source, created_at FROM manager_qa_tasks
      WHERE agent_name = ANY($1::text[])
    `, [["QA Agent 1", "QA Agent 2", "QA Agent 3"]]));

    const importCandidates: AttendanceImportCandidate[] = Array.from({ length: 100 }, (_, agent) => ({
      name: `Import Agent ${agent}`,
      shift: String(4 + agent % 4),
      department: "CS",
      records: Array.from({ length: 14 }, (_, day) => ({
        date: `2026-08-${String(day + 1).padStart(2, "0")}`,
        status: day % 5 === 0 ? "late" : "in",
      })),
    }));
    const oldImport = await timed(async () => {
      await client.query("BEGIN");
      let totalMembers = 0;
      let totalRecords = 0;
      let queryCount = 0;
      try {
        for (const candidate of importCandidates) {
          let member = await client.query<{ id: number }>(`
            SELECT id FROM attendance_import_members
            WHERE name = $1 AND department = $2 LIMIT 1
          `, [candidate.name, candidate.department]);
          queryCount++;
          if (!member.rowCount) {
            member = await client.query<{ id: number }>(`
              INSERT INTO attendance_import_members(name, shift, department)
              VALUES ($1, $2, $3) RETURNING id
            `, [candidate.name, candidate.shift, candidate.department]);
            queryCount++;
            totalMembers++;
          }
          for (const record of candidate.records) {
            await client.query(`
              INSERT INTO attendance_import_records(member_id, date, status)
              VALUES ($1, $2, $3) ON CONFLICT DO NOTHING
            `, [member.rows[0]!.id, record.date, record.status]);
            queryCount++;
            totalRecords++;
          }
        }
        const persisted = await client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM attendance_import_records",
        );
        queryCount++;
        return { totalMembers, totalRecords, persisted: persisted.rows[0]!.count, queryCount };
      } finally {
        await client.query("ROLLBACK");
      }
    });
    const newImport = await timed(async () => {
      await client.query("BEGIN");
      let queryCount = 0;
      try {
        const plan = buildAttendanceImportPlan(importCandidates);
        const existing = await client.query<{ id: number; name: string; department: string }>(
          "SELECT id, name, department FROM attendance_import_members ORDER BY id",
        );
        queryCount++;
        const memberIds = new Map(existing.rows.map((member) => [
          attendanceImportMemberKey(member.department, member.name),
          member.id,
        ]));
        const missing = plan.members.filter((member) => !memberIds.has(member.key));
        if (missing.length > 0) {
          const parameters: unknown[] = [];
          const values = missing.map((member, index) => {
            const offset = index * 3;
            parameters.push(member.name, member.shift, member.department);
            return `($${offset + 1}, $${offset + 2}, $${offset + 3})`;
          });
          const inserted = await client.query<{ id: number; name: string; department: string }>(`
            INSERT INTO attendance_import_members(name, shift, department)
            VALUES ${values.join(", ")} RETURNING id, name, department
          `, parameters);
          queryCount++;
          for (const member of inserted.rows) {
            memberIds.set(attendanceImportMemberKey(member.department, member.name), member.id);
          }
        }
        const records = plan.members.flatMap((member) => member.records.map((record) => ({
          memberId: memberIds.get(member.key)!,
          ...record,
        })));
        for (let offset = 0; offset < records.length; offset += 500) {
          const chunk = records.slice(offset, offset + 500);
          const parameters: unknown[] = [];
          const values = chunk.map((record, index) => {
            const parameterOffset = index * 3;
            parameters.push(record.memberId, record.date, record.status);
            return `($${parameterOffset + 1}, $${parameterOffset + 2}, $${parameterOffset + 3})`;
          });
          await client.query(`
            INSERT INTO attendance_import_records(member_id, date, status)
            VALUES ${values.join(", ")} ON CONFLICT DO NOTHING
          `, parameters);
          queryCount++;
        }
        const persisted = await client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM attendance_import_records",
        );
        queryCount++;
        return {
          totalMembers: missing.length,
          totalRecords: plan.totalRecords,
          persisted: persisted.rows[0]!.count,
          queryCount,
        };
      } finally {
        await client.query("ROLLBACK");
      }
    });
    assert.deepEqual(newImport.value, {
      ...oldImport.value,
      queryCount: newImport.value.queryCount,
    });

    const setInputs = Array.from({ length: 200 }, (_, index) => ({
      memberId: index + 1,
      date: "2026-08-03",
      status: "in",
    }));
    const oldAttendanceSet = await timed(async () => {
      await client.query("BEGIN");
      let queryCount = 0;
      const actions: string[] = [];
      try {
        for (const input of setInputs) {
          await client.query("SELECT id FROM attendance_set_members WHERE id = $1 AND active = true", [input.memberId]);
          queryCount++;
        }
        for (const input of setInputs) {
          const member = await client.query<{ id: number }>(
            "SELECT id FROM attendance_set_members WHERE id = $1 AND active = true",
            [input.memberId],
          );
          queryCount++;
          const previous = await client.query<{ status: string; note: string | null; coaching: boolean }>(`
            SELECT status, note, coaching FROM attendance_set_records
            WHERE member_id = $1 AND date = $2 LIMIT 1
          `, [member.rows[0]!.id, input.date]);
          queryCount++;
          if (previous.rows[0]?.status === input.status) {
            actions.push("unchanged");
            continue;
          }
          await client.query(`
            INSERT INTO attendance_set_records(member_id, date, status, note, coaching)
            VALUES ($1, $2, $3, NULL, false)
            ON CONFLICT (member_id, date) DO UPDATE SET status = excluded.status, updated_at = now()
          `, [input.memberId, input.date, input.status]);
          queryCount++;
          await client.query(`
            SELECT status, note, coaching FROM attendance_set_records
            WHERE member_id = $1 AND date = $2 LIMIT 1
          `, [input.memberId, input.date]);
          queryCount++;
          actions.push(previous.rowCount ? "updated" : "created");
        }
        const persisted = await client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM attendance_set_records",
        );
        queryCount++;
        return { actions, persisted: persisted.rows[0]!.count, queryCount };
      } finally {
        await client.query("ROLLBACK");
      }
    });
    const newAttendanceSet = await timed(async () => {
      await client.query("BEGIN");
      let queryCount = 0;
      try {
        const members = await client.query<{ id: number }>(
          "SELECT id FROM attendance_set_members WHERE active = true ORDER BY id",
        );
        queryCount++;
        const activeIds = new Set(members.rows.map((member) => member.id));
        const existing = await client.query<{ member_id: number; status: string; note: string | null; coaching: boolean }>(`
          SELECT member_id, status, note, coaching FROM attendance_set_records
          WHERE member_id = ANY($1::int[]) AND date = $2
        `, [setInputs.map((input) => input.memberId), "2026-08-03"]);
        queryCount++;
        const states = new Map(existing.rows.map((record) => [record.member_id, record]));
        const actions: string[] = [];
        const writes: typeof setInputs = [];
        for (const input of setInputs) {
          assert.ok(activeIds.has(input.memberId));
          const previous = states.get(input.memberId);
          if (previous?.status === input.status) {
            actions.push("unchanged");
          } else {
            actions.push(previous ? "updated" : "created");
            writes.push(input);
            states.set(input.memberId, { member_id: input.memberId, status: input.status, note: null, coaching: false });
          }
        }
        const parameters: unknown[] = [];
        const values = writes.map((input, index) => {
          const offset = index * 3;
          parameters.push(input.memberId, input.date, input.status);
          return `($${offset + 1}, $${offset + 2}, $${offset + 3}, NULL, false)`;
        });
        await client.query(`
          INSERT INTO attendance_set_records(member_id, date, status, note, coaching)
          VALUES ${values.join(", ")}
          ON CONFLICT (member_id, date) DO UPDATE SET status = excluded.status, updated_at = now()
        `, parameters);
        queryCount++;
        const verified = await client.query<{ member_id: number; status: string }>(`
          SELECT member_id, status FROM attendance_set_records
          WHERE member_id = ANY($1::int[]) AND date = $2
        `, [setInputs.map((input) => input.memberId), "2026-08-03"]);
        queryCount++;
        return { actions, persisted: verified.rowCount ?? 0, queryCount };
      } finally {
        await client.query("ROLLBACK");
      }
    });
    assert.deepEqual(newAttendanceSet.value, {
      ...oldAttendanceSet.value,
      queryCount: newAttendanceSet.value.queryCount,
    });

    assert.deepEqual(
      dbModule.databasePoolConfig("postgresql://sanitized@localhost/performance_test", {}),
      {
        connectionString: "postgresql://sanitized@localhost/performance_test",
        max: 10,
        idleTimeoutMillis: 10_000,
        connectionTimeoutMillis: 10_000,
      },
    );
    assert.equal(dbModule.databasePoolConfig("postgresql://sanitized@localhost/performance_test", {
      DB_POOL_MAX: "4",
      DB_POOL_IDLE_TIMEOUT_MS: "30000",
      DB_POOL_CONNECTION_TIMEOUT_MS: "5000",
    }).max, 4);
    const members = await dbModule.db.select().from(dbModule.attendanceMembersTable)
      .orderBy(dbModule.attendanceMembersTable.id);
    const { setAttendanceRecords } = await import("../lib/attendanceService.js");
    const batch = await setAttendanceRecords([
      { memberId: 1, date: "2026-08-03", status: "in", overwrite: false },
      { memberId: 2, date: "2026-08-03", status: "in", overwrite: false },
      { memberId: 3, date: "2026-08-03", status: "late", note: "sanitized late", overwrite: false },
      { memberId: 3, date: "2026-08-03", status: "late", note: "sanitized late", overwrite: false },
      { memberId: 9999, date: "2026-08-03", status: "in", overwrite: false },
    ], members);
    assert.deepEqual(batch.map((result) => result.kind === "saved" ? result.action : result.kind), [
      "unchanged", "conflict", "created", "unchanged", "member_missing",
    ]);
    const attendanceTotal = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM attendance_records");
    assert.equal(attendanceTotal.rows[0]!.count, "3");

    const expectedIndexes = [
      "phone_calls_created_at_idx",
      "phone_calls_attendance_created_agent_idx",
      "phone_calls_participant_created_idx",
      "phone_calls_missed_line_created_idx",
      "phone_calls_live_synced_idx",
      "phone_calls_dashboard_stats_cover_idx",
      "pbx_missed_from_created_idx",
      "attendance_records_date_member_idx",
    ];
    const indexRows = await client.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ANY($1::text[])
    `, [expectedIndexes]);
    assert.equal(indexRows.rows.length, expectedIndexes.length);
    const indexPlans = {
      participant: planEvidence(await client.query(`
        EXPLAIN (ANALYZE, FORMAT JSON)
        SELECT id, created_at FROM phone_calls
        WHERE participant = $1 AND created_at >= $2 ORDER BY created_at DESC LIMIT 50
      `, ["synthetic-contact-42", new Date("2026-01-01T00:00:00Z")])),
      missedLine: planEvidence(await client.query(`
        EXPLAIN (ANALYZE, FORMAT JSON)
        SELECT id, created_at FROM phone_calls
        WHERE line_name = $1 AND direction = 'incoming'
          AND status IN ('no-answer', 'voicemail', 'missed', 'voicemail-brief')
          AND created_at >= $2
      `, ["Synthetic Line 4", new Date("2026-01-01T00:00:00Z")])),
      live: planEvidence(await client.query(`
        EXPLAIN (ANALYZE, FORMAT JSON)
        SELECT id, synced_at FROM phone_calls
        WHERE status = 'in-progress' AND synced_at >= $1
      `, [new Date("2026-04-01T00:00:00Z")])),
      pbxSource: planEvidence(await client.query(`
        EXPLAIN (ANALYZE, FORMAT JSON)
        SELECT id, created_at FROM pbx_missed_calls
        WHERE from_number = $1 AND created_at >= $2 ORDER BY created_at DESC LIMIT 50
      `, ["synthetic-source-42", new Date("2026-01-01T00:00:00Z")])),
      attendanceDate: planEvidence(await client.query(`
        EXPLAIN (ANALYZE, FORMAT JSON)
        SELECT id FROM attendance_records WHERE date = $1
      `, ["2026-08-03"])),
    };
    assert.ok(indexPlans.participant.indexes.includes("phone_calls_participant_created_idx"));
    assert.ok(indexPlans.missedLine.indexes.includes("phone_calls_missed_line_created_idx"));
    assert.ok(indexPlans.live.indexes.includes("phone_calls_live_synced_idx"));
    assert.ok(indexPlans.pbxSource.indexes.includes("pbx_missed_from_created_idx"));

    const evidence = {
      dataset: {
        phoneCalls: 220_000,
        qaReviews: 12_000,
        qaAgents: 100,
        managerQaTasks: 110,
        attendanceMembers: 80,
      },
      attendanceFirstCall: {
        oldResult: { agents: oldFirstCalls.length, digest: digest(oldFirstCalls), transferredRows: oldAttendance.value.rowCount },
        newResult: { agents: newFirstCalls.length, digest: digest(newFirstCalls), transferredRows: newAttendance.value.rowCount },
        equal: true,
        oldQueryMs: oldAttendance.ms,
        newQueryMs: newAttendance.ms,
        oldPlan: oldAttendancePlan,
        newPlan: newAttendancePlan,
      },
      weeklyQaAssignment: {
        oldResult: { agents: oldQa.value.agents, picks: oldQa.value.picks.length, digest: digest(oldQa.value.picks) },
        newResult: { agents: newQa.value.agents, picks: newQa.value.picks.length, digest: digest(newQa.value.picks) },
        equal: true,
        oldQueryMs: Math.round((oldQa.ms + oldQaWrites.ms) * 100) / 100,
        newQueryMs: Math.round((newQa.ms + newQaWrites.ms) * 100) / 100,
        oldReadMs: oldQa.ms,
        newReadMs: newQa.ms,
        oldWriteMs: oldQaWrites.ms,
        newWriteMs: newQaWrites.ms,
        oldQueryCount: oldQa.value.queryCount + oldQa.value.picks.length,
        newQueryCount: newQa.value.queryCount + 1,
        bulkPlan: newQaPlan,
      },
      attendanceBatch: {
        actions: batch.map((result) => result.kind === "saved" ? result.action : result.kind),
        finalRecordCount: Number(attendanceTotal.rows[0]!.count),
        writeStatements: 1,
      },
      attendanceSet: {
        oldResult: {
          unchanged: oldAttendanceSet.value.actions.filter((action) => action === "unchanged").length,
          created: oldAttendanceSet.value.actions.filter((action) => action === "created").length,
          persisted: oldAttendanceSet.value.persisted,
        },
        newResult: {
          unchanged: newAttendanceSet.value.actions.filter((action) => action === "unchanged").length,
          created: newAttendanceSet.value.actions.filter((action) => action === "created").length,
          persisted: newAttendanceSet.value.persisted,
        },
        equal: true,
        oldQueryMs: oldAttendanceSet.ms,
        newQueryMs: newAttendanceSet.ms,
        oldQueryCount: oldAttendanceSet.value.queryCount,
        newQueryCount: newAttendanceSet.value.queryCount,
      },
      attendanceImport: {
        oldResult: {
          totalMembers: oldImport.value.totalMembers,
          totalRecords: oldImport.value.totalRecords,
          persisted: oldImport.value.persisted,
        },
        newResult: {
          totalMembers: newImport.value.totalMembers,
          totalRecords: newImport.value.totalRecords,
          persisted: newImport.value.persisted,
        },
        equal: true,
        oldQueryMs: oldImport.ms,
        newQueryMs: newImport.ms,
        oldQueryCount: oldImport.value.queryCount,
        newQueryCount: newImport.value.queryCount,
      },
      indexes: indexRows.rows.map((row) => row.indexname).sort(),
      indexPlans,
      dashboardSummaryPlan: {
        old: oldDashboardPlan,
        optimized: newDashboardPlan,
        repeatableExecutionMs: {
          sequential: sequentialDashboardSamples,
          indexed: indexedDashboardSamples,
          sequentialP50: percentile(sequentialDashboardSamples, 0.5),
          sequentialP95: percentile(sequentialDashboardSamples, 0.95),
          indexedP50: percentile(indexedDashboardSamples, 0.5),
          indexedP95: percentile(indexedDashboardSamples, 0.95),
        },
        indexSizeBytes: Number(dashboardIndexSize.rows[0]!.bytes),
      },
      dashboardResultEquivalence: {
        legacyRows: dashboardRows.rowCount,
        aggregateRows: optimizedDashboard.length,
        legacyDigest: digest(legacyDashboard),
        optimizedDigest: digest(optimizedDashboard),
        equal: true,
        databaseMs: optimizedDashboardResult.timings.databaseMs,
      },
    };
    console.log(`PERFORMANCE_EVIDENCE ${JSON.stringify(evidence)}`);
  } finally {
    client.release();
    if (workspacePool) await workspacePool.end();
    await setupPool.end();
  }
});
