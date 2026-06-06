import { Router, type IRouter } from "express";
import ExcelJS from "exceljs";
import OpenAI from "openai";
import {
  db,
  phoneCallsTable,
  liveTransferClassificationsTable,
  liveTransferStateTable,
} from "@workspace/db";
import { and, eq, gte, lte, or, inArray, sql } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { requireAuth } from "../middleware/auth.js";

const router: IRouter = Router();

// ─── Scope ────────────────────────────────────────────────────────────────────
// Inbound live transfers (a partner rep from Aspire/Resync warm-transferring a
// client) land almost entirely on the Onboarding line and the Retention/CS team
// lines. We only classify INCOMING completed calls >= MIN_SECONDS on those lines.
const ONBOARDING_LINE_ID = "PNdcJ0UEu5";
const RELEVANT_TEAMS = ["retention", "cs"];
const MIN_SECONDS = Number(process.env["LT_MIN_SECONDS"] ?? 20);
const MODEL = process.env["LT_MODEL"] ?? "gpt-4.1-mini";
const CONCURRENCY = Number(process.env["LT_CONC"] ?? 4);

const ASPIRE_RE = /\baspire\b/i;
const RESYNC_RE = /re-?sync/i;

// A call is in scope if it's on the onboarding line OR a retention/cs team line.
function scopeFilter() {
  return or(
    eq(phoneCallsTable.lineId, ONBOARDING_LINE_ID),
    inArray(phoneCallsTable.lineTeam, RELEVANT_TEAMS),
  );
}

// ─── Date range helpers (LA timezone, mirrors obReport) ───────────────────────
const TZ = "America/Los_Angeles";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function caDate(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: TZ });
}
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
  if (Number.isNaN(fromDate.getTime())) fromDate = new Date("2000-01-01T00:00:00Z");
  if (Number.isNaN(toDate.getTime())) toDate = new Date();
  return { fromDate, toDate };
}
function rangeFromQuery(req: { query: Record<string, unknown> }): { fromDate: Date; toDate: Date } {
  const from = typeof req.query["from"] === "string" ? req.query["from"] : undefined;
  const to = typeof req.query["to"] === "string" ? req.query["to"] : undefined;
  return parseRange(from, to);
}

// ─── OpenPhone transcript fetch (mirrors obReport) ────────────────────────────
const QUO_BASE = "https://api.openphone.com/v1";
function quoHeaders(): Record<string, string> {
  const key = process.env["QUO_API_KEY"];
  if (!key) throw new Error("QUO_API_KEY not configured");
  return { Authorization: key, Accept: "application/json" };
}
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

interface DialogueLine {
  identifier?: string;
  content?: string;
}
interface TranscriptBody {
  data?: { dialogue?: DialogueLine[]; status?: string };
}
type TranscriptResult =
  | { kind: "ok"; dialogue: DialogueLine[]; status: string }
  | { kind: "notfound" }
  | { kind: "error" };

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

function dialogueText(dialogue: DialogueLine[]): string {
  return dialogue
    .map((d) => (d.content ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

// ─── AI client (Replit AI Integrations OpenAI proxy) ──────────────────────────
function aiClient(): OpenAI {
  return new OpenAI({
    baseURL: process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"],
    apiKey: process.env["AI_INTEGRATIONS_OPENAI_API_KEY"],
  });
}

const SYS_PROMPT = `You analyze the OPENING of an INCOMING phone call to a debt-relief company.
On these calls a partner-company representative (from "Aspire" or "Resync", sometimes said "re-sync") warm-transfers a client to us (usually because the client wants to cancel or has an issue). The rep typically introduces themselves by name and company, e.g. "Hi, this is Marcus with Aspire, I have a client for you".
Return STRICT JSON only:
{
  "isTransfer": boolean,                    // true ONLY if the opening clearly shows a rep from Aspire or Resync warm-transferring/handing off a client to us; false if the company name is merely mentioned in passing, the caller is the client themselves, or it is any other kind of call
  "company": "Aspire" | "Resync" | "",   // which partner company the rep is from; "" if not clearly stated
  "agent": string,                         // the transferring partner rep's name as introduced; "" if none stated
  "evidence": string                       // <= 18 words: the intro line / why this is (or isn't) a partner transfer
}`;

interface ExtractResult {
  isTransfer: boolean;
  company: string;
  agent: string;
  evidence: string;
}

async function extract(ai: OpenAI, transcript: string): Promise<ExtractResult | null> {
  try {
    const resp = await ai.chat.completions.create(
      {
        model: MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYS_PROMPT },
          { role: "user", content: `OPENING TRANSCRIPT:\n${transcript.slice(0, 4000)}` },
        ],
      },
      { timeout: 60000, maxRetries: 2 },
    );
    const content = resp.choices[0]?.message?.content;
    if (!content) return null;
    return JSON.parse(content) as ExtractResult;
  } catch (err) {
    logger.warn({ err: String(err) }, "liveTransfers: extract failed");
    return null;
  }
}

// ─── State helpers ────────────────────────────────────────────────────────────
async function readState() {
  const rows = await db
    .select()
    .from(liveTransferStateTable)
    .where(eq(liveTransferStateTable.id, "singleton"));
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
    .insert(liveTransferStateTable)
    .values({ id: "singleton", ...patch, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: liveTransferStateTable.id,
      set: { ...patch, updatedAt: new Date() },
    });
}

// ─── Classifier job ───────────────────────────────────────────────────────────
let jobRunning = false;

async function runClassifier(): Promise<void> {
  if (jobRunning) return;
  jobRunning = true;
  try {
    await writeState({ isRunning: true, lastError: null, progressDone: 0, progressTotal: 0 });
    logger.info("liveTransfers: classify started");

    // Incoming completed calls in scope, long enough to be a real conversation,
    // that have not been classified yet.
    const pending = await db
      .select({ id: phoneCallsTable.id })
      .from(phoneCallsTable)
      .leftJoin(
        liveTransferClassificationsTable,
        eq(liveTransferClassificationsTable.callId, phoneCallsTable.id),
      )
      .where(
        and(
          eq(phoneCallsTable.direction, "incoming"),
          eq(phoneCallsTable.status, "completed"),
          gte(phoneCallsTable.durationSeconds, MIN_SECONDS),
          scopeFilter(),
          sql`${liveTransferClassificationsTable.callId} IS NULL`,
        ),
      );

    await writeState({ progressTotal: pending.length, progressDone: 0 });
    logger.info({ pending: pending.length }, "liveTransfers: classifying new calls");

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
            // transient — leave unclassified so the next run retries.
            logger.warn({ callId: call.id }, "liveTransfers: transcript fetch failed, will retry");
          } else if (tx.kind === "notfound" || tx.dialogue.length === 0) {
            await db
              .insert(liveTransferClassificationsTable)
              .values({
                callId: call.id,
                isLive: false,
                company: null,
                agent: null,
                evidence: null,
                txStatus: tx.kind === "notfound" ? "notfound" : tx.status,
              })
              .onConflictDoNothing();
          } else {
            const text = dialogueText(tx.dialogue);
            const aspire = ASPIRE_RE.test(text);
            const resync = RESYNC_RE.test(text);
            const isLive = aspire || resync;
            if (!isLive) {
              await db
                .insert(liveTransferClassificationsTable)
                .values({
                  callId: call.id,
                  isLive: false,
                  company: null,
                  agent: null,
                  evidence: null,
                  txStatus: "completed",
                })
                .onConflictDoNothing();
            } else {
              // Keyword match is only a cheap pre-filter; the AI decides whether
              // this is actually a partner warm-transfer (isTransfer).
              const opening = tx.dialogue.slice(0, 26);
              const res = await extract(ai, dialogueText(opening));
              if (res === null) {
                // AI failed — leave unclassified so the next run retries.
                logger.warn({ callId: call.id }, "liveTransfers: AI extract failed, will retry");
              } else if (!res.isTransfer) {
                await db
                  .insert(liveTransferClassificationsTable)
                  .values({
                    callId: call.id,
                    isLive: false,
                    company: null,
                    agent: null,
                    evidence: res.evidence?.trim() || null,
                    txStatus: "completed",
                  })
                  .onConflictDoNothing();
              } else {
                // Prefer AI company; fall back to unambiguous keyword.
                let company = aspire && !resync ? "Aspire" : resync && !aspire ? "Resync" : "";
                if (res.company === "Aspire" || res.company === "Resync") company = res.company;
                await db
                  .insert(liveTransferClassificationsTable)
                  .values({
                    callId: call.id,
                    isLive: true,
                    company: company || null,
                    agent: res.agent?.trim() || null,
                    evidence: res.evidence?.trim() || null,
                    txStatus: "completed",
                  })
                  .onConflictDoNothing();
              }
            }
          }
        } catch (err) {
          logger.warn({ err: String(err), callId: call.id }, "liveTransfers: processing error");
        }
        done++;
        if (done % 10 === 0 || done === pending.length) await writeState({ progressDone: done });
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, Math.max(1, pending.length)) }, worker),
    );

    await writeState({
      isRunning: false,
      lastRunAt: new Date(),
      progressDone: pending.length,
      lastError: null,
    });
    logger.info({ classified: pending.length }, "liveTransfers: classify done");
  } catch (err) {
    logger.error({ err: String(err) }, "liveTransfers: classify failed");
    await writeState({ isRunning: false, lastError: String(err) });
  } finally {
    jobRunning = false;
  }
}

// ─── Report rows ──────────────────────────────────────────────────────────────
interface LiveRow {
  dateLa: string;
  customerPhone: string;
  line: string;
  company: string;
  agent: string;
  evidence: string;
  handlingAgent: string;
  durationMin: number;
  callId: string;
  createdAt: Date;
}

async function loadLiveRows(from?: string, to?: string): Promise<LiveRow[]> {
  const { fromDate, toDate } = parseRange(from, to);
  const rows = await db
    .select({
      id: phoneCallsTable.id,
      participant: phoneCallsTable.participant,
      lineName: phoneCallsTable.lineName,
      agentName: phoneCallsTable.agentName,
      durationSeconds: phoneCallsTable.durationSeconds,
      createdAt: phoneCallsTable.createdAt,
      company: liveTransferClassificationsTable.company,
      agent: liveTransferClassificationsTable.agent,
      evidence: liveTransferClassificationsTable.evidence,
    })
    .from(phoneCallsTable)
    .innerJoin(
      liveTransferClassificationsTable,
      eq(liveTransferClassificationsTable.callId, phoneCallsTable.id),
    )
    .where(
      and(
        eq(liveTransferClassificationsTable.isLive, true),
        gte(phoneCallsTable.createdAt, fromDate),
        lte(phoneCallsTable.createdAt, toDate),
      ),
    )
    .orderBy(phoneCallsTable.createdAt);

  return rows.map((c) => ({
    dateLa: new Date(c.createdAt).toLocaleString("en-US", { timeZone: TZ }),
    customerPhone: c.participant ?? "",
    line: c.lineName ?? "",
    company: c.company ?? "",
    agent: c.agent ?? "",
    evidence: c.evidence ?? "",
    handlingAgent: c.agentName ?? "",
    durationMin: Number(((c.durationSeconds ?? 0) / 60).toFixed(1)),
    callId: c.id,
    createdAt: new Date(c.createdAt),
  }));
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /api/live-transfers/status — counts + refresh progress for a date range.
router.get("/live-transfers/status", requireAuth, async (req, res) => {
  try {
    const { fromDate, toDate } = rangeFromQuery(req);
    const inRange = and(
      gte(phoneCallsTable.createdAt, fromDate),
      lte(phoneCallsTable.createdAt, toDate),
    );

    // Denominator: in-scope incoming completed calls considered.
    const [{ totalIncoming }] = await db
      .select({ totalIncoming: sql<number>`cast(count(*) as int)` })
      .from(phoneCallsTable)
      .where(
        and(
          eq(phoneCallsTable.direction, "incoming"),
          eq(phoneCallsTable.status, "completed"),
          gte(phoneCallsTable.durationSeconds, MIN_SECONDS),
          scopeFilter(),
          inRange,
        ),
      );

    // Live transfers, split by company.
    const byCompany = await db
      .select({
        company: liveTransferClassificationsTable.company,
        cnt: sql<number>`cast(count(*) as int)`,
      })
      .from(liveTransferClassificationsTable)
      .innerJoin(phoneCallsTable, eq(phoneCallsTable.id, liveTransferClassificationsTable.callId))
      .where(and(eq(liveTransferClassificationsTable.isLive, true), inRange))
      .groupBy(liveTransferClassificationsTable.company);

    let aspire = 0;
    let resync = 0;
    let unspecified = 0;
    for (const r of byCompany) {
      const n = Number(r.cnt) || 0;
      if (r.company === "Aspire") aspire += n;
      else if (r.company === "Resync") resync += n;
      else unspecified += n;
    }
    const totalLive = aspire + resync + unspecified;

    const st = await readState();
    return res.json({
      running: jobRunning,
      lastRunAt: st?.lastRunAt ?? null,
      progressDone: st?.progressDone ?? 0,
      progressTotal: st?.progressTotal ?? 0,
      totalIncoming: Number(totalIncoming) || 0,
      totalLive,
      aspire,
      resync,
      unspecified,
    });
  } catch (err) {
    req.log.error(err, "live-transfers status error");
    return res.status(500).json({ error: String(err) });
  }
});

// POST /api/live-transfers/refresh — classify new incoming calls in the background.
router.post("/live-transfers/refresh", requireAuth, async (_req, res) => {
  if (jobRunning) return res.status(409).json({ started: false, reason: "already running" });
  void runClassifier();
  return res.json({ started: true });
});

// GET /api/live-transfers/download — Excel of live transfer calls in range.
router.get("/live-transfers/download", requireAuth, async (req, res) => {
  try {
    const from = typeof req.query["from"] === "string" ? req.query["from"] : undefined;
    const to = typeof req.query["to"] === "string" ? req.query["to"] : undefined;
    const rows = await loadLiveRows(from, to);
    const wb = await buildWorkbook(rows);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", `attachment; filename="Live_Transfers.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
    return;
  } catch (err) {
    req.log.error(err, "live-transfers download error");
    res.status(500).json({ error: String(err) });
    return;
  }
});

// ─── Workbook ─────────────────────────────────────────────────────────────────
function thinBorder(): Partial<ExcelJS.Borders> {
  const side = { style: "thin" as const, color: { argb: "FFD1D5DB" } };
  return { top: side, left: side, bottom: side, right: side };
}
function solid(argb: string): ExcelJS.Fill {
  return { type: "pattern", pattern: "solid", fgColor: { argb } };
}

async function buildWorkbook(rows: LiveRow[]): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Backend Tracker";
  wb.created = new Date();

  const ws = wb.addWorksheet("Live Transfers", {
    views: [{ state: "frozen", ySplit: 4 }],
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  const headers = [
    "Date (Los Angeles)",
    "Customer Phone",
    "Line",
    "Transferred From (Company)",
    "Transferred By (Agent)",
    "Evidence",
    "Handling Agent (our system)",
    "Duration (min)",
    "Call ID",
  ];
  const widths = [22, 16, 22, 22, 22, 44, 24, 13, 36];
  widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));

  const ncols = headers.length;
  ws.mergeCells(1, 1, 1, ncols);
  const titleCell = ws.getCell(1, 1);
  titleCell.value = "Inbound Live Transfers — Aspire / Resync";
  titleCell.font = { bold: true, size: 16, color: { argb: "FF3B0764" } };

  ws.mergeCells(2, 1, 2, ncols);
  const subCell = ws.getCell(2, 1);
  const generated = new Date().toLocaleString("en-US", { timeZone: TZ });
  subCell.value = `${rows.length} live transfers  •  Generated ${generated} (LA)`;
  subCell.font = { italic: true, size: 10, color: { argb: "FF666666" } };

  const headerRow = ws.getRow(4);
  headers.forEach((h, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = h;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = solid("FF6D28D9");
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = thinBorder();
  });
  headerRow.commit();

  const companyFill: Record<string, ExcelJS.Fill> = {
    Aspire: solid("FFDBEAFE"),
    Resync: solid("FFDCFCE7"),
  };
  const companyFont: Record<string, Partial<ExcelJS.Font>> = {
    Aspire: { bold: true, color: { argb: "FF1E40AF" } },
    Resync: { bold: true, color: { argb: "FF166534" } },
  };

  let r = 5;
  for (const row of rows) {
    const xr = ws.getRow(r);
    xr.getCell(1).value = row.dateLa;
    xr.getCell(2).value = row.customerPhone;
    xr.getCell(3).value = row.line;
    const compCell = xr.getCell(4);
    compCell.value = row.company || "—";
    compCell.alignment = { horizontal: "center", vertical: "middle" };
    if (row.company && companyFill[row.company]) {
      compCell.fill = companyFill[row.company]!;
      compCell.font = companyFont[row.company]!;
    } else {
      compCell.font = { color: { argb: "FF9CA3AF" } };
    }
    xr.getCell(5).value = row.agent;
    xr.getCell(6).value = row.evidence;
    xr.getCell(7).value = row.handlingAgent;
    const durCell = xr.getCell(8);
    durCell.value = row.durationMin;
    durCell.numFmt = "0.0";
    xr.getCell(9).value = row.callId;
    for (let c = 1; c <= ncols; c++) xr.getCell(c).border = thinBorder();
    xr.commit();
    r++;
  }

  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: Math.max(4, r - 1), column: ncols } };

  // ── Summary ──
  const s = wb.addWorksheet("Summary");
  s.getColumn(1).width = 34;
  s.getColumn(2).width = 16;
  const byCompany: Record<string, number> = {};
  for (const row of rows) {
    const key = row.company || "(unspecified)";
    byCompany[key] = (byCompany[key] ?? 0) + 1;
  }
  let sr = 1;
  const title = s.getCell(sr, 1);
  title.value = "Live Transfers — Summary";
  title.font = { bold: true, size: 14, color: { argb: "FF3B0764" } };
  sr += 2;
  for (const [a, b] of [["Transferred From", "Count"]] as const) {
    s.getCell(sr, 1).value = a;
    s.getCell(sr, 2).value = b;
    s.getCell(sr, 1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    s.getCell(sr, 2).font = { bold: true, color: { argb: "FFFFFFFF" } };
    s.getCell(sr, 1).fill = solid("FF6D28D9");
    s.getCell(sr, 2).fill = solid("FF6D28D9");
    sr++;
  }
  for (const key of ["Aspire", "Resync", "(unspecified)"]) {
    s.getCell(sr, 1).value = key;
    s.getCell(sr, 2).value = byCompany[key] ?? 0;
    s.getCell(sr, 2).alignment = { horizontal: "right" };
    sr++;
  }
  s.getCell(sr, 1).value = "TOTAL";
  s.getCell(sr, 1).font = { bold: true };
  s.getCell(sr, 2).value = rows.length;
  s.getCell(sr, 2).font = { bold: true };
  s.getCell(sr, 2).alignment = { horizontal: "right" };

  return wb;
}

export function startLiveTransfersBackground(): void {
  // Kick off shortly after boot, then every 15 minutes.
  setTimeout(() => void runClassifier(), 30_000);
  setInterval(() => void runClassifier(), 15 * 60 * 1000);
}

export default router;
