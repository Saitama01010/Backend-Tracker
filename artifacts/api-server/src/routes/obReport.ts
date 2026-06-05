import { Router, type IRouter } from "express";
import ExcelJS from "exceljs";
import OpenAI from "openai";
import { db, phoneCallsTable, onboardingClassificationsTable, onboardingReportStateTable } from "@workspace/db";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { runSync } from "./quoSync.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

// ─── Onboarding line constants ────────────────────────────────────────────────
const LINE_ID = "PNdcJ0UEu5";
const LINE_NUMBER = "+19493157441";
const LINE_LABEL = "(949) 315-7441";
const MODEL = process.env["OB_MODEL"] ?? "gpt-4.1-mini";
const CONCURRENCY = Number(process.env["OB_CONC"] ?? 4);
const TAX_RE = /\btaxes?\b/i;

// ─── Date range helpers (LA timezone, mirrors obAnalytics) ────────────────────
const TZ = "America/Los_Angeles";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function caDate(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: TZ });
}
/** Midnight (California) for a YYYY-MM-DD string → UTC bounds for that CA day. */
function caDateBounds(dateStr: string): { from: Date; to: Date } {
  const pdtMidnight = new Date(`${dateStr}T07:00:00Z`);
  const fromMs =
    caDate(pdtMidnight) === dateStr ? pdtMidnight.getTime() : pdtMidnight.getTime() + 60 * 60 * 1000;
  return { from: new Date(fromMs), to: new Date(fromMs + 24 * 60 * 60 * 1000) };
}
function parseRange(from?: string, to?: string): { fromDate: Date; toDate: Date } {
  let fromDate = !from
    ? new Date("2000-01-01T00:00:00Z")
    : DATE_RE.test(from)
      ? caDateBounds(from).from
      : new Date(from);
  let toDate = !to ? new Date() : DATE_RE.test(to) ? caDateBounds(to).to : new Date(to);
  // Guard against malformed input so bad query strings can't reach the DB filter.
  if (Number.isNaN(fromDate.getTime())) fromDate = new Date("2000-01-01T00:00:00Z");
  if (Number.isNaN(toDate.getTime())) toDate = new Date();
  return { fromDate, toDate };
}
function rangeFromQuery(req: { query: Record<string, unknown> }): { fromDate: Date; toDate: Date } {
  const from = typeof req.query["from"] === "string" ? req.query["from"] : undefined;
  const to = typeof req.query["to"] === "string" ? req.query["to"] : undefined;
  return parseRange(from, to);
}

const QUO_BASE = "https://api.openphone.com/v1";
function quoHeaders(): Record<string, string> {
  const key = process.env["QUO_API_KEY"];
  if (!key) throw new Error("QUO_API_KEY not configured");
  return { Authorization: key, Accept: "application/json" };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

interface TranscriptBody {
  data?: { dialogue?: DialogueLine[]; status?: string };
}

type TranscriptResult =
  | { kind: "ok"; dialogue: DialogueLine[]; status: string }
  | { kind: "notfound" } // call genuinely has no transcript (HTTP 404)
  | { kind: "error" }; // transient failure — caller should NOT persist, retry next refresh

/**
 * Fetch a call transcript with a per-attempt timeout and bounded retries.
 *
 * Critically, this distinguishes a genuine "no transcript" (HTTP 404, safe to
 * persist permanently) from a transient failure (429/5xx/network/timeout), so a
 * temporary OpenPhone outage never permanently mislabels a real call as
 * `no_transcript`. On transient failure the caller skips the call, leaving it
 * unclassified so the next refresh reprocesses it.
 */
async function fetchTranscript(callId: string, tries = 5): Promise<TranscriptResult> {
  const url = `${QUO_BASE}/call-transcripts/${callId}`;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(url, { headers: quoHeaders(), signal: ctrl.signal });
      if (res.status === 404) return { kind: "notfound" };
      if (res.status === 429 || res.status >= 500) {
        await sleep(2000 * (i + 1));
        continue;
      }
      if (!res.ok) return { kind: "error" };
      const body = (await res.json()) as TranscriptBody;
      return { kind: "ok", dialogue: body?.data?.dialogue ?? [], status: body?.data?.status ?? "none" };
    } catch {
      await sleep(1500 * (i + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  return { kind: "error" };
}

// ─── AI client (Replit AI Integrations OpenAI proxy) ──────────────────────────
function aiClient(): OpenAI {
  return new OpenAI({
    baseURL: process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"],
    apiKey: process.env["AI_INTEGRATIONS_OPENAI_API_KEY"],
  });
}

interface DialogueLine {
  identifier?: string;
  content?: string;
}

function buildTranscript(dialogue: DialogueLine[]): string {
  const lines: string[] = [];
  for (const d of dialogue) {
    const who = d.identifier === LINE_NUMBER ? "AGENT" : "CUSTOMER";
    const c = (d.content ?? "").trim();
    if (c) lines.push(`${who}: ${c}`);
  }
  let text = lines.join("\n");
  if (text.length > 14000) text = text.slice(0, 11000) + "\n...\n" + text.slice(-3000);
  return text;
}

const SYS_PROMPT = `You analyze transcripts from a debt-relief company's ONBOARDING phone line (Better Lending).
On this line, a closer/sales rep usually warm-transfers a customer who just signed up, and the ONBOARDING agent enrolls them (collects file/case number, sets up the payment schedule, confirms the program, welcomes them).
Return STRICT JSON only with these keys:
{
  "customerName": string | null,   // the CUSTOMER's full name as stated on the call (not the agent). null if unknown.
  "closerAgent": string | null,    // name of the SALES CLOSER who closed the deal and warm-transferred the customer, IF mentioned (e.g. "transferred from John", "I have X for you", a rep who hands off then leaves). NOT the onboarding agent. null if none.
  "callType": "onboarded" | "connection" | "other",
  "notes": string                  // <= 12 words, why you chose callType
}
callType rubric:
- "onboarded": the customer was actually enrolled/onboarded — file or case number taken, payment/draft schedule set up, program confirmed, welcome to the program.
- "connection": someone called to get connected / inquire / was transferred but was NOT onboarded — just a connection, a question, not ready, declined, wrong dept, callback only, no enrollment completed.
- "other": internal/test/unclear/no real conversation.`;

interface ClassifyResult {
  customerName: string | null;
  closerAgent: string | null;
  callType: string;
  notes: string;
}

async function classify(
  ai: OpenAI,
  agentName: string | null,
  direction: string,
  transcript: string,
): Promise<ClassifyResult | null> {
  try {
    const resp = await ai.chat.completions.create(
      {
        model: MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYS_PROMPT },
          {
            role: "user",
            content: `Onboarding agent who handled this call (our system): ${agentName ?? "unknown"}\nDirection: ${direction}\n\nTRANSCRIPT:\n${transcript}`,
          },
        ],
      },
      { timeout: 60000, maxRetries: 2 },
    );
    const content = resp.choices[0]?.message?.content;
    if (!content) return null;
    return JSON.parse(content) as ClassifyResult;
  } catch (err) {
    logger.warn({ err: String(err) }, "obReport: classify failed");
    return null;
  }
}

// ─── State helpers ────────────────────────────────────────────────────────────
async function readState() {
  const rows = await db.select().from(onboardingReportStateTable).where(eq(onboardingReportStateTable.id, "singleton"));
  return rows[0] ?? null;
}

async function writeState(patch: {
  isRunning?: boolean;
  progressDone?: number;
  progressTotal?: number;
  lastRunAt?: Date | null;
  lastError?: string | null;
}) {
  await db
    .insert(onboardingReportStateTable)
    .values({ id: "singleton", ...patch, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: onboardingReportStateTable.id,
      set: { ...patch, updatedAt: new Date() },
    });
}

// ─── Main refresh job ─────────────────────────────────────────────────────────
let jobRunning = false;

async function runReport(): Promise<void> {
  if (jobRunning) return;
  jobRunning = true;

  try {
    await writeState({ isRunning: true, lastError: null, progressDone: 0, progressTotal: 0 });
    logger.info("obReport: refresh started");

    // 1) Pull the newest calls (extend the range up to today). The background
    //    sync covers all lines on a 15-min cycle; here we only need a small
    //    top-up window to catch anything since the last background sync.
    //    NOTE: the OpenPhone /conversations endpoint ignores the phoneNumberId
    //    filter, so every sync pages *all* lines' conversations in the window.
    //    A wide window therefore triggers heavy rate-limiting and makes a manual
    //    refresh take many minutes — keep this window small. Override via OB_SYNC_HOURS.
    const syncHours = Number(process.env["OB_SYNC_HOURS"] ?? 6);
    const syncFrom = new Date(Date.now() - syncHours * 60 * 60 * 1000);
    try {
      await runSync(syncFrom, new Date(), { onlyLineId: LINE_ID });
    } catch (err) {
      logger.warn({ err: String(err) }, "obReport: recent sync failed, continuing with existing data");
    }

    // 2) Find completed calls on the onboarding line that aren't classified yet.
    const pending = await db
      .select({
        id: phoneCallsTable.id,
        agentName: phoneCallsTable.agentName,
        direction: phoneCallsTable.direction,
      })
      .from(phoneCallsTable)
      .leftJoin(onboardingClassificationsTable, eq(onboardingClassificationsTable.callId, phoneCallsTable.id))
      .where(
        and(
          eq(phoneCallsTable.lineId, LINE_ID),
          eq(phoneCallsTable.status, "completed"),
          sql`${onboardingClassificationsTable.callId} IS NULL`,
        ),
      );

    await writeState({ progressTotal: pending.length, progressDone: 0 });
    logger.info({ pending: pending.length }, "obReport: classifying new calls");

    const ai = aiClient();
    let done = 0;
    let idx = 0;

    async function worker() {
      while (idx < pending.length) {
        const i = idx++;
        const call = pending[i]!;
        try {
          const tx = await fetchTranscript(call.id);
          if (tx.kind === "error") {
            // Transient fetch failure: do NOT persist a row. Leaving the call
            // unclassified means the next refresh will retry it.
            logger.warn({ callId: call.id }, "obReport: transcript fetch failed, will retry next refresh");
          } else if (tx.kind === "notfound" || tx.dialogue.length === 0) {
            await db
              .insert(onboardingClassificationsTable)
              .values({
                callId: call.id,
                callType: "no_transcript",
                customerName: null,
                closerAgent: null,
                mentionsTax: null,
                txStatus: tx.kind === "notfound" ? "notfound" : tx.status,
                notes: "",
              })
              .onConflictDoNothing();
          } else {
            const transcript = buildTranscript(tx.dialogue);
            const mentionsTax = TAX_RE.test(transcript);
            const res = await classify(ai, call.agentName, call.direction, transcript);
            if (!res) {
              // LLM failed/timed out: skip so the next refresh retries instead of
              // permanently storing a wrong "error" classification.
              logger.warn({ callId: call.id }, "obReport: classify failed, will retry next refresh");
            } else {
              await db
                .insert(onboardingClassificationsTable)
                .values({
                  callId: call.id,
                  callType: res.callType,
                  customerName: res.customerName ?? null,
                  closerAgent: res.closerAgent ?? null,
                  mentionsTax,
                  txStatus: "completed",
                  notes: res.notes ?? "",
                })
                .onConflictDoNothing();
            }
          }
        } catch (err) {
          logger.warn({ err: String(err), callId: call.id }, "obReport: call processing error");
        }
        done++;
        if (done % 10 === 0 || done === pending.length) {
          await writeState({ progressDone: done });
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, pending.length)) }, worker));

    await writeState({ isRunning: false, lastRunAt: new Date(), progressDone: pending.length, lastError: null });
    logger.info({ classified: pending.length }, "obReport: refresh done");
  } catch (err) {
    logger.error({ err: String(err) }, "obReport: refresh failed");
    await writeState({ isRunning: false, lastError: String(err) });
  } finally {
    jobRunning = false;
  }
}

// ─── Report data + workbook ───────────────────────────────────────────────────
const TYPE_LABEL: Record<string, string> = {
  onboarded: "Onboarded Customer",
  connection: "Connection Call",
  other: "Other",
  no_transcript: "No Transcript",
  no_conversation: "No Conversation (voicemail/missed)",
  error: "Unclassified (review)",
};

interface ReportRow {
  dateLa: string;
  direction: string;
  customerPhone: string;
  customerName: string;
  handlingAgent: string;
  closerAgent: string;
  callType: string;
  mentionsTax: boolean | null;
  status: string;
  durationMin: number;
  callId: string;
}

async function loadReportRows(from?: string, to?: string): Promise<ReportRow[]> {
  const { fromDate, toDate } = parseRange(from, to);
  const rows = await db
    .select({
      id: phoneCallsTable.id,
      participant: phoneCallsTable.participant,
      agentName: phoneCallsTable.agentName,
      direction: phoneCallsTable.direction,
      status: phoneCallsTable.status,
      durationSeconds: phoneCallsTable.durationSeconds,
      createdAt: phoneCallsTable.createdAt,
      callType: onboardingClassificationsTable.callType,
      customerName: onboardingClassificationsTable.customerName,
      closerAgent: onboardingClassificationsTable.closerAgent,
      mentionsTax: onboardingClassificationsTable.mentionsTax,
    })
    .from(phoneCallsTable)
    .leftJoin(onboardingClassificationsTable, eq(onboardingClassificationsTable.callId, phoneCallsTable.id))
    .where(
      and(
        eq(phoneCallsTable.lineId, LINE_ID),
        gte(phoneCallsTable.createdAt, fromDate),
        lte(phoneCallsTable.createdAt, toDate),
      ),
    )
    .orderBy(phoneCallsTable.createdAt);

  return rows.map((c) => ({
    dateLa: new Date(c.createdAt).toLocaleString("en-US", { timeZone: "America/Los_Angeles" }),
    direction: c.direction === "incoming" ? "Incoming" : "Outgoing",
    customerPhone: c.participant ?? "",
    customerName: c.customerName ?? "",
    handlingAgent: c.agentName ?? "",
    closerAgent: c.closerAgent ?? "",
    callType: c.callType ?? (c.status === "completed" ? "error" : "no_conversation"),
    mentionsTax: c.mentionsTax,
    status: c.status,
    durationMin: Number(((c.durationSeconds ?? 0) / 60).toFixed(1)),
    callId: c.id,
  }));
}

function taxLabel(v: boolean | null): "Yes" | "No" | "—" {
  if (v === true) return "Yes";
  if (v === false) return "No";
  return "—";
}

async function buildWorkbook(rows: ReportRow[]): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Backend Tracker";
  wb.created = new Date();

  // ── Sheet 1: All Calls ──
  const ws = wb.addWorksheet("All Calls", {
    views: [{ state: "frozen", ySplit: 4 }],
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  const headers = [
    "Date (Los Angeles)",
    "Direction",
    "Customer Phone",
    "Customer Name",
    "Handling Agent (our system)",
    "Closer Agent (from transcript)",
    "Call Type",
    "Mentions Tax / Taxes",
    "Status",
    "Duration (min)",
    "Call ID",
  ];
  const widths = [22, 11, 16, 22, 24, 24, 26, 15, 16, 13, 36];
  widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));

  const ncols = headers.length;
  ws.mergeCells(1, 1, 1, ncols);
  const titleCell = ws.getCell(1, 1);
  titleCell.value = `Onboarding Line — Call Report  ${LINE_LABEL}`;
  titleCell.font = { bold: true, size: 16, color: { argb: "FF3B0764" } };

  ws.mergeCells(2, 1, 2, ncols);
  const subCell = ws.getCell(2, 1);
  const generated = new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" });
  subCell.value = `All calls on the Onboarding line  •  ${rows.length} total calls  •  Generated ${generated} (LA)`;
  subCell.font = { italic: true, size: 10, color: { argb: "FF666666" } };

  const headerRow = ws.getRow(4);
  headers.forEach((h, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = h;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF6D28D9" } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = thinBorder();
  });
  headerRow.commit();

  const fills = {
    onboarded: solid("FFDCFCE7"),
    connection: solid("FFDBEAFE"),
    error: solid("FFFEE2E2"),
    muted: solid("FFF3F4F6"),
    taxYes: solid("FFFEF3C7"),
  };
  const fonts = {
    onboarded: { bold: true, color: { argb: "FF166534" } },
    connection: { bold: true, color: { argb: "FF1E40AF" } },
    error: { color: { argb: "FF991B1B" } },
    muted: { color: { argb: "FF6B7280" } },
    taxYes: { bold: true, color: { argb: "FF92400E" } },
    dash: { color: { argb: "FF9CA3AF" } },
  };

  let r = 5;
  for (const row of rows) {
    const ct = row.callType;
    const xr = ws.getRow(r);
    xr.getCell(1).value = row.dateLa;
    xr.getCell(2).value = row.direction;
    xr.getCell(3).value = row.customerPhone;
    xr.getCell(4).value = row.customerName;
    xr.getCell(5).value = row.handlingAgent;
    xr.getCell(6).value = row.closerAgent;

    const typeCell = xr.getCell(7);
    typeCell.value = TYPE_LABEL[ct] ?? ct;
    typeCell.alignment = { horizontal: "center", vertical: "middle" };
    if (ct === "onboarded") {
      typeCell.fill = fills.onboarded;
      typeCell.font = fonts.onboarded;
    } else if (ct === "connection") {
      typeCell.fill = fills.connection;
      typeCell.font = fonts.connection;
    } else if (ct === "error") {
      typeCell.fill = fills.error;
      typeCell.font = fonts.error;
    } else {
      typeCell.fill = fills.muted;
      typeCell.font = fonts.muted;
    }

    const tl = taxLabel(row.mentionsTax);
    const taxCell = xr.getCell(8);
    taxCell.value = tl;
    taxCell.alignment = { horizontal: "center", vertical: "middle" };
    if (tl === "Yes") {
      taxCell.fill = fills.taxYes;
      taxCell.font = fonts.taxYes;
    } else if (tl === "—") {
      taxCell.font = fonts.dash;
    }

    xr.getCell(9).value = row.status;
    xr.getCell(9).alignment = { horizontal: "center" };
    const durCell = xr.getCell(10);
    durCell.value = row.durationMin;
    durCell.numFmt = "0.0";
    xr.getCell(11).value = row.callId;

    for (let c = 1; c <= ncols; c++) xr.getCell(c).border = thinBorder();
    xr.commit();
    r++;
  }

  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: Math.max(4, r - 1), column: ncols } };

  // ── Sheet 2: Summary ──
  const s = wb.addWorksheet("Summary");
  s.getColumn(1).width = 34;
  s.getColumn(2).width = 16;

  const byType = countBy(rows.map((x) => x.callType));
  const byDir = countBy(rows.map((x) => x.direction));
  const byTax = countBy(rows.map((x) => taxLabel(x.mentionsTax)));
  const closers = countBy(rows.filter((x) => x.callType === "onboarded").map((x) => x.closerAgent || "(unknown)"));
  const handlers = countBy(
    rows.filter((x) => ["onboarded", "connection", "other"].includes(x.callType)).map((x) => x.handlingAgent || "(unknown)"),
  );

  let sr = 1;
  const writeTitle = (text: string) => {
    const c = s.getCell(sr, 1);
    c.value = text;
    c.font = { bold: true, size: 14, color: { argb: "FF3B0764" } };
    sr += 2;
  };
  const writeSection = (a: string, b: string) => {
    for (const [col, val] of [
      [1, a],
      [2, b],
    ] as const) {
      const c = s.getCell(sr, col);
      c.value = val;
      c.font = { bold: true, color: { argb: "FFFFFFFF" } };
      c.fill = solid("FF6D28D9");
      c.border = thinBorder();
    }
    sr++;
  };
  const writeKV = (k: string, v: number, bold = false) => {
    const kc = s.getCell(sr, 1);
    kc.value = k;
    kc.border = thinBorder();
    const vc = s.getCell(sr, 2);
    vc.value = v;
    vc.alignment = { horizontal: "right" };
    vc.border = thinBorder();
    if (bold) vc.font = { bold: true };
    sr++;
  };

  writeTitle("Onboarding Line — Summary");

  writeSection("Call Type", "Count");
  for (const ct of ["onboarded", "connection", "other", "no_conversation", "no_transcript", "error"]) {
    if (byType[ct]) writeKV(TYPE_LABEL[ct] ?? ct, byType[ct]);
  }
  writeSection("TOTAL", String(rows.length));
  sr++;

  writeSection("Mentions Tax / Taxes", "Count");
  for (const label of ["Yes", "No", "—"]) {
    const disp = label === "—" ? "No transcript / not connected" : label;
    writeKV(disp, byTax[label] ?? 0);
  }
  sr++;

  writeSection("Direction", "Count");
  for (const d of Object.keys(byDir).sort()) writeKV(d, byDir[d]!);
  sr++;

  writeSection("Closer Agent — Onboarded Customers", "Deals");
  for (const [name, n] of sortByCount(closers)) writeKV(name, n);
  sr++;

  writeSection("Handling Agent — Calls Handled", "Calls");
  for (const [name, n] of sortByCount(handlers)) writeKV(name, n);

  return wb;
}

function thinBorder(): Partial<ExcelJS.Borders> {
  const side = { style: "thin" as const, color: { argb: "FFD1D5DB" } };
  return { top: side, left: side, bottom: side, right: side };
}
function solid(argb: string): ExcelJS.Fill {
  return { type: "pattern", pattern: "solid", fgColor: { argb } };
}
function countBy(arr: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of arr) out[v] = (out[v] ?? 0) + 1;
  return out;
}
function sortByCount(rec: Record<string, number>): [string, number][] {
  return Object.entries(rec).sort((a, b) => b[1] - a[1]);
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// POST /api/ob-report/refresh — start a background refresh (sync + classify new calls)
router.post("/ob-report/refresh", async (req, res) => {
  if (jobRunning) {
    return res.status(409).json({ error: "A refresh is already running" });
  }
  void runReport();
  return res.json({ started: true });
});

// GET /api/ob-report/status — current refresh + report stats
router.get("/ob-report/status", async (req, res) => {
  try {
    const state = await readState();
    const { fromDate, toDate } = rangeFromQuery(req);
    const rangeWhere = and(
      eq(phoneCallsTable.lineId, LINE_ID),
      gte(phoneCallsTable.createdAt, fromDate),
      lte(phoneCallsTable.createdAt, toDate),
    );
    const counts = await db
      .select({ callType: onboardingClassificationsTable.callType, n: sql<number>`count(*)::int` })
      .from(onboardingClassificationsTable)
      .innerJoin(phoneCallsTable, eq(phoneCallsTable.id, onboardingClassificationsTable.callId))
      .where(rangeWhere)
      .groupBy(onboardingClassificationsTable.callType);
    const tax = await db
      .select({ mentionsTax: onboardingClassificationsTable.mentionsTax, n: sql<number>`count(*)::int` })
      .from(onboardingClassificationsTable)
      .innerJoin(phoneCallsTable, eq(phoneCallsTable.id, onboardingClassificationsTable.callId))
      .where(rangeWhere)
      .groupBy(onboardingClassificationsTable.mentionsTax);
    const totalCallsRow = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(phoneCallsTable)
      .where(rangeWhere);

    const typeCounts: Record<string, number> = {};
    for (const c of counts) typeCounts[c.callType] = c.n;
    let taxYes = 0;
    let taxNo = 0;
    for (const t of tax) {
      if (t.mentionsTax === true) taxYes = t.n;
      else if (t.mentionsTax === false) taxNo = t.n;
    }

    return res.json({
      // Derive `running` from the in-memory flag only. The DB `isRunning` can be
      // left stale-true if the server restarts mid-job, which would otherwise pin
      // the UI in a perpetual "refreshing" state.
      running: jobRunning,
      progressDone: state?.progressDone ?? 0,
      progressTotal: state?.progressTotal ?? 0,
      lastRunAt: state?.lastRunAt ?? null,
      lastError: state?.lastError ?? null,
      totalCalls: totalCallsRow[0]?.n ?? 0,
      classified: Object.values(typeCounts).reduce((s, n) => s + n, 0),
      typeCounts,
      taxYes,
      taxNo,
    });
  } catch (err) {
    req.log.error(err, "ob-report status error");
    return res.status(500).json({ error: "Failed to load report status" });
  }
});

// GET /api/ob-report/download — stream the latest Excel workbook
router.get("/ob-report/download", async (req, res) => {
  try {
    const from = typeof req.query["from"] === "string" ? req.query["from"] : undefined;
    const to = typeof req.query["to"] === "string" ? req.query["to"] : undefined;
    const rows = await loadReportRows(from, to);
    const wb = await buildWorkbook(rows);
    const stamp = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", `attachment; filename="Onboarding_Line_Report_${stamp}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
    return;
  } catch (err) {
    req.log.error(err, "ob-report download error");
    res.status(500).json({ error: "Failed to generate report" });
    return;
  }
});

// ─── POST /api/ob-report/import — one-time bulk seed of classifications ────────
// Guarded by OB_IMPORT_SECRET. Lets an already-classified environment (dev) seed a
// fresh one (production) without re-running thousands of rate-limited transcript
// fetches + LLM calls. Idempotent: existing rows are left untouched.
interface ImportRow {
  callId: string;
  callType: string;
  customerName?: string | null;
  closerAgent?: string | null;
  mentionsTax?: boolean | null;
  txStatus?: string | null;
  notes?: string | null;
}

router.post("/ob-report/import", async (req, res) => {
  const secret = process.env["OB_IMPORT_SECRET"];
  if (!secret) {
    res.status(403).json({ error: "import disabled" });
    return;
  }
  if (req.header("x-import-secret") !== secret) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const rows: unknown = req.body?.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    res.status(400).json({ error: "rows[] required" });
    return;
  }
  if (rows.length > 5000) {
    res.status(400).json({ error: "too many rows in one request (max 5000)" });
    return;
  }
  const values: ImportRow[] = [];
  for (const r of rows as ImportRow[]) {
    if (!r || typeof r.callId !== "string" || typeof r.callType !== "string") {
      res.status(400).json({ error: "each row needs callId and callType" });
      return;
    }
    values.push({
      callId: r.callId,
      callType: r.callType,
      customerName: r.customerName ?? null,
      closerAgent: r.closerAgent ?? null,
      mentionsTax: typeof r.mentionsTax === "boolean" ? r.mentionsTax : null,
      txStatus: r.txStatus ?? null,
      notes: r.notes ?? null,
    });
  }
  try {
    const CHUNK = 500;
    for (let i = 0; i < values.length; i += CHUNK) {
      await db
        .insert(onboardingClassificationsTable)
        .values(values.slice(i, i + CHUNK))
        .onConflictDoNothing();
    }
    const total = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(onboardingClassificationsTable);
    res.json({ received: values.length, total: total[0]?.n ?? 0 });
    return;
  } catch (err) {
    req.log.error(err, "ob-report import error");
    res.status(500).json({ error: "import failed" });
    return;
  }
});

export default router;
