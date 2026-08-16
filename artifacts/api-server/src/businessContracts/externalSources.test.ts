import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { buildQuoPhoneCallRow, type QuoCall, type QuoPhoneNumber } from "../integrations/quo/sync.js";
import { detectHeaderRow, parseGoogleSheetsValues } from "../integrations/googleSheets/mapper.js";
import { parseReadymodeRows } from "../integrations/readymode/csvParser.js";
import { parseAgentTable } from "../integrations/readymode/htmlParser.js";
import { prepareReadyModeUpload } from "../integrations/readymode/importer.js";
import { teamFromRingGroupName } from "../integrations/pbx/mapper.js";

const fixtures = path.join(import.meta.dirname, "fixtures");

async function json<T>(...parts: string[]): Promise<T> {
  return JSON.parse(await readFile(path.join(fixtures, ...parts), "utf8")) as T;
}

async function text(...parts: string[]): Promise<string> {
  return readFile(path.join(fixtures, ...parts), "utf8");
}

const quietLog = { warn() {} } as unknown as Parameters<typeof parseReadymodeRows>[1];

test("QUO multi-page fixture preserves empty pages, duplicate IDs, optional fields, dates, agents, and teams", async () => {
  const fixture = await json<{
    phoneNumbers: QuoPhoneNumber[];
    users: Array<{ id: string; displayName: string }>;
    pages: Array<{ data: Array<QuoCall & { phoneNumberId: string }>; nextPageToken: string | null }>;
  }>("quo", "api-pages.json");
  assert.equal(fixture.pages.length, 3);
  assert.deepEqual(fixture.pages[2]!.data, []);

  const lines = new Map(fixture.phoneNumbers.map((line) => [line.id, line]));
  const users = new Map(fixture.users.map((user) => [user.id, user.displayName]));
  const mapped = fixture.pages.flatMap((page) => page.data.map((call) => {
    const line = lines.get(call.phoneNumberId);
    assert.ok(line, `fixture line ${call.phoneNumberId} must exist`);
    return buildQuoPhoneCallRow(call, line, call.participants?.[0] ?? "", users);
  }));

  assert.equal(mapped.length, 5, "the duplicate remains visible to the current database-upsert boundary");
  assert.equal(mapped.filter((row) => row.id === "quo-call-001").length, 2);
  assert.equal(mapped.find((row) => row.id === "quo-call-001")?.status, "completed");
  assert.equal(mapped.find((row) => row.id === "quo-call-002")?.status, "voicemail");
  assert.equal(mapped.find((row) => row.id === "quo-call-003")?.status, "voicemail-brief");
  assert.equal(mapped.find((row) => row.id === "quo-call-004")?.agentName, "Agent Beta");
  assert.equal(mapped.find((row) => row.id === "quo-call-004")?.lineTeam, "nsf");
  assert.equal(mapped.find((row) => row.id === "quo-call-003")?.participant, "");
  assert.deepEqual(
    [...new Set(mapped.map((row) => row.createdAt.toISOString().slice(0, 10)))],
    ["2026-01-15", "2026-01-16", "2026-02-01"],
  );
});

test("ReadyMode CSV fixtures pin accepted rows, duplicate interpretation, empty rows, headers, dates, and duration parsing", async () => {
  const valid = parseReadymodeRows(await text("readymode", "valid.csv"), quietLog, "fixture", "2026-05-15");
  assert.deepEqual(valid, [
    { name: "Agent Alpha", iso: "2026-05-14", dialed: 12, talkSecs: 1230 },
    { name: "Agent Beta", iso: "2026-05-14", dialed: 7, talkSecs: 600 },
    { name: "Agent Alpha", iso: "2026-05-15", dialed: 5, talkSecs: 486 },
    { name: "Agent Gamma", iso: "2026-05-15", dialed: 3, talkSecs: 130 },
  ]);

  const duplicate = parseReadymodeRows(await text("readymode", "duplicate.csv"), quietLog, "fixture");
  assert.equal(duplicate.length, 2, "current parsing does not invent file-level deduplication");
  assert.deepEqual(duplicate[0], duplicate[1]);
  assert.equal(
    prepareReadyModeUpload(duplicate, "fixture-user").length,
    1,
    "the existing upload boundary keeps only the last same-agent same-day row",
  );
  assert.deepEqual(parseReadymodeRows(await text("readymode", "invalid-header.csv"), quietLog, "fixture"), []);
  assert.deepEqual(parseReadymodeRows(await text("readymode", "empty.csv"), quietLog, "fixture"), []);
});

test("the retained ReadyMode HTML parser keeps current name, optional-cell, empty, and summary behavior", async () => {
  const parsed = parseAgentTable(await text("readymode", "report.html"));
  assert.deepEqual(parsed, [
    { agentName: "Agent Alpha", dialed: 12, connected: 8, talkTimeSecs: 1230, avgTalkSecs: 154, connectRate: 66.7 },
    { agentName: "agent alpha - ALPHA", dialed: 4, connected: 2, talkTimeSecs: 250, avgTalkSecs: 125, connectRate: 50 },
  ]);
  assert.deepEqual(parseAgentTable(await text("pbx", "empty.html")), []);
});

test("Google Sheet fixtures pin header discovery, empty rows, duplicate-looking rows, and malformed values", async () => {
  const sheet1 = await json<Record<string, { values: unknown[][] }>>("sheets", "google-sheet-1.json");
  const idpValues = parseGoogleSheetsValues(sheet1.idpHandled);
  assert.equal(detectHeaderRow(idpValues), 1);
  assert.equal(idpValues.filter((row) => row[2] === "FILE-001").length, 2);
  assert.equal(detectHeaderRow(parseGoogleSheetsValues(sheet1.retained)), 0);
  assert.equal(detectHeaderRow(parseGoogleSheetsValues(sheet1.fixed)), 0);
  assert.throws(() => parseGoogleSheetsValues({ values: "not-an-array" }), /invalid/i);
});

test("PBX fixtures preserve the current ring-group and display-name inputs without inventing an HTML ingestion path", async () => {
  const pbx = await json<{
    agents: Array<{ agentName: string; extension?: string }>;
    ringGroups: Array<{ name: string }>;
    empty: { agents: unknown[]; ringGroups: unknown[]; calls: unknown[] };
  }>("pbx", "api.json");
  assert.deepEqual(pbx.ringGroups.map((group) => teamFromRingGroupName(group.name)), ["retention", "nsf", "cs"]);
  assert.equal(pbx.agents[1]!.agentName, "agent alpha - ALPHA");
  assert.equal(pbx.agents[2]!.extension, undefined);
  assert.deepEqual(pbx.empty, { agents: [], ringGroups: [], calls: [] });

  const html = await text("pbx", "report.html");
  assert.match(html, /Agent Beta \(Temp\)/);
  assert.match(html, /<td>3<\/td><\/tr>/, "the last PBX row intentionally omits its optional cell");
  const pbxClient = await readFile(new URL("../integrations/pbx/client.ts", import.meta.url), "utf8");
  assert.match(pbxClient, /async function getPbxSession/);
  assert.match(pbxClient, /return res\.json\(\) as Promise<T>/);
  assert.doesNotMatch(pbxClient, /parseAgentTable|<table|matchAll\(\/<tr/);
});
