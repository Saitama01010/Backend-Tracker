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
const CLARITY_RE = /\bclarity\b/i;
const CONCORDIA_RE = /\bconcordia\b/i;
const PARTNER_NAMES = ["Aspire", "Resync", "Clarity", "Concordia"];
// Recall-only pre-filter for INTERNAL transfers (one of our own departments
// handing the client to this team). The AI confirms; this just decides whether
// a transcript is worth an AI call so we don't classify every single call.
const TRANSFER_INTENT_RE =
  /\btransfer|hand(?:ing)?\s+(?:you|them|him|her|it)\s+(?:over|off)|get(?:ting)?\s+you\s+(?:over\s+)?to|i(?:'?ve| have)?\s+(?:have\s+)?got?\s+a\s+(?:client|customer|member)|my\s+(?:colleague|co-?worker)|\b(?:nsf|retention|onboarding|billing|customer\s+service)\b|over\s+to\s+(?:retention|onboarding|cs|customer\s+service|billing)/i;

// When the AI doesn't name the partner company, fall back to an unambiguous
// single keyword hit.
function keywordPartner(flags: { aspire: boolean; resync: boolean; clarity: boolean; concordia: boolean }): string {
  const hits: string[] = [];
  if (flags.aspire) hits.push("Aspire");
  if (flags.resync) hits.push("Resync");
  if (flags.clarity) hits.push("Clarity");
  if (flags.concordia) hits.push("Concordia");
  return hits.length === 1 ? hits[0]! : "";
}

// Canonicalize internal department names so casing/wording variants
// ("Account services" vs "Account Services", "lending") don't split into
// separate buckets in the breakdown.
const DEPT_CANON: Record<string, string> = {
  cs: "CS",
  "customer service": "CS",
  "customer care": "Client Care",
  "client care": "Client Care",
  nsf: "NSF",
  onboarding: "Onboarding",
  retention: "Retention",
  billing: "Billing",
  compliance: "Compliance",
  lending: "Lending",
  sales: "Sales",
  "account services": "Account Services",
  other: "Other",
};
function normalizeDept(raw: string): string {
  const base = raw.trim().toLowerCase().replace(/\s+(team|department|dept\.?|division)$/i, "").trim();
  if (!base) return "Other";
  if (DEPT_CANON[base]) return DEPT_CANON[base]!;
  return base.replace(/\b\w/g, (c) => c.toUpperCase());
}

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

const SYS_PROMPT = `You analyze the OPENING of an INCOMING phone call to a debt-relief company. Classify whether the call is a warm-transfer (someone handing a client off to this team), and if so, what KIND.

Two kinds of transfer:
1. PARTNER — a representative from an EXTERNAL partner company warm-transfers a client to us. The partner companies are "Aspire", "Resync" (sometimes said "re-sync"), "Clarity", and "Concordia". e.g. "Hi, this is Marcus with Aspire, I have a client for you".
2. INTERNAL — one of OUR OWN departments/agents hands the client to this team. Internal departments include Customer Service ("CS"), "NSF", "Retention", "Onboarding", "Billing", "Sales". e.g. "Hey, it's Sarah from the NSF team, I've got a customer who needs...".

If the caller is the client themselves, a company name is only mentioned in passing, or it is any other kind of call, it is NOT a transfer.

Return STRICT JSON only:
{
  "kind": "partner" | "internal" | "none",
  "company": string,   // for partner: one of "Aspire","Resync","Clarity","Concordia" (or "" if a partner transfer but company unclear); for internal: the department that transferred, e.g. "CS","NSF","Retention","Onboarding","Billing" ("" if unclear); "" when kind is "none"
  "agent": string,     // the transferring rep/agent's name as introduced; "" if none stated
  "evidence": string   // <= 18 words: the intro line / why this is (or isn't) a transfer
}`;

type TransferKind = "partner" | "internal" | "none";
interface ExtractResult {
  kind: TransferKind;
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
            const flags = {
              aspire: ASPIRE_RE.test(text),
              resync: RESYNC_RE.test(text),
              clarity: CLARITY_RE.test(text),
              concordia: CONCORDIA_RE.test(text),
            };
            const partnerHit = flags.aspire || flags.resync || flags.clarity || flags.concordia;
            const intentHit = TRANSFER_INTENT_RE.test(text);
            // Cheap pre-filter (partner name OR internal transfer intent). The AI
            // decides the actual kind so the keyword match never alone sets isLive.
            if (!partnerHit && !intentHit) {
              await db
                .insert(liveTransferClassificationsTable)
                .values({
                  callId: call.id,
                  isLive: false,
                  kind: null,
                  company: null,
                  agent: null,
                  evidence: null,
                  txStatus: "completed",
                })
                .onConflictDoNothing();
            } else {
              const opening = tx.dialogue.slice(0, 26);
              const res = await extract(ai, dialogueText(opening));
              if (res === null) {
                // AI failed — leave unclassified so the next run retries.
                logger.warn({ callId: call.id }, "liveTransfers: AI extract failed, will retry");
              } else if (res.kind !== "partner" && res.kind !== "internal") {
                await db
                  .insert(liveTransferClassificationsTable)
                  .values({
                    callId: call.id,
                    isLive: false,
                    kind: null,
                    company: null,
                    agent: null,
                    evidence: res.evidence?.trim() || null,
                    txStatus: "completed",
                  })
                  .onConflictDoNothing();
              } else {
                let company: string;
                if (res.kind === "partner") {
                  // Prefer AI company; fall back to an unambiguous keyword hit.
                  company = PARTNER_NAMES.includes(res.company) ? res.company : keywordPartner(flags);
                } else {
                  // Internal: the AI names the source department; canonicalize it.
                  company = normalizeDept(res.company ?? "");
                }
                await db
                  .insert(liveTransferClassificationsTable)
                  .values({
                    callId: call.id,
                    isLive: true,
                    kind: res.kind,
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
  kind: string;
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
      kind: liveTransferClassificationsTable.kind,
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
    kind: c.kind === "internal" ? "Internal" : "Partner",
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

    // Live transfers, split by kind + company/department.
    const byKindCompany = await db
      .select({
        kind: liveTransferClassificationsTable.kind,
        company: liveTransferClassificationsTable.company,
        cnt: sql<number>`cast(count(*) as int)`,
      })
      .from(liveTransferClassificationsTable)
      .innerJoin(phoneCallsTable, eq(phoneCallsTable.id, liveTransferClassificationsTable.callId))
      .where(and(eq(liveTransferClassificationsTable.isLive, true), inRange))
      .groupBy(liveTransferClassificationsTable.kind, liveTransferClassificationsTable.company);

    let aspire = 0;
    let resync = 0;
    let clarity = 0;
    let concordia = 0;
    let unspecified = 0; // partner transfer with no clear company
    let internalTotal = 0;
    const internalMap = new Map<string, number>();
    for (const r of byKindCompany) {
      const n = Number(r.cnt) || 0;
      if (r.kind === "internal") {
        const dept = r.company || "Other";
        internalMap.set(dept, (internalMap.get(dept) ?? 0) + n);
        internalTotal += n;
      } else {
        // partner (or legacy null kind, treated as partner)
        if (r.company === "Aspire") aspire += n;
        else if (r.company === "Resync") resync += n;
        else if (r.company === "Clarity") clarity += n;
        else if (r.company === "Concordia") concordia += n;
        else unspecified += n;
      }
    }
    const partnerTotal = aspire + resync + clarity + concordia + unspecified;
    const internalByDept = [...internalMap.entries()]
      .map(([dept, count]) => ({ dept, count }))
      .sort((a, b) => b.count - a.count);
    const totalLive = partnerTotal + internalTotal;

    const st = await readState();
    return res.json({
      running: jobRunning,
      lastRunAt: st?.lastRunAt ?? null,
      progressDone: st?.progressDone ?? 0,
      progressTotal: st?.progressTotal ?? 0,
      totalIncoming: Number(totalIncoming) || 0,
      totalLive,
      partnerTotal,
      aspire,
      resync,
      clarity,
      concordia,
      unspecified,
      internalTotal,
      internalByDept,
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
    "Type",
    "Transferred From (Company / Dept)",
    "Transferred By (Agent)",
    "Evidence",
    "Handling Agent (our system)",
    "Duration (min)",
    "Call ID",
  ];
  const widths = [22, 16, 22, 12, 26, 22, 44, 24, 13, 36];
  widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));

  const ncols = headers.length;
  ws.mergeCells(1, 1, 1, ncols);
  const titleCell = ws.getCell(1, 1);
  titleCell.value = "Inbound Live Transfers — Partner & Internal";
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
    Clarity: solid("FFFEF9C3"),
    Concordia: solid("FFFCE7F3"),
  };
  const companyFont: Record<string, Partial<ExcelJS.Font>> = {
    Aspire: { bold: true, color: { argb: "FF1E40AF" } },
    Resync: { bold: true, color: { argb: "FF166534" } },
    Clarity: { bold: true, color: { argb: "FF854D0E" } },
    Concordia: { bold: true, color: { argb: "FF9D174D" } },
  };

  let r = 5;
  for (const row of rows) {
    const xr = ws.getRow(r);
    xr.getCell(1).value = row.dateLa;
    xr.getCell(2).value = row.customerPhone;
    xr.getCell(3).value = row.line;
    const kindCell = xr.getCell(4);
    kindCell.value = row.kind;
    kindCell.alignment = { horizontal: "center", vertical: "middle" };
    kindCell.font =
      row.kind === "Internal"
        ? { bold: true, color: { argb: "FF7C3AED" } }
        : { bold: true, color: { argb: "FF0F766E" } };
    const compCell = xr.getCell(5);
    compCell.value = row.company || "—";
    compCell.alignment = { horizontal: "center", vertical: "middle" };
    if (row.kind === "Partner" && row.company && companyFill[row.company]) {
      compCell.fill = companyFill[row.company]!;
      compCell.font = companyFont[row.company]!;
    } else if (row.company) {
      compCell.font = { color: { argb: "FF374151" } };
    } else {
      compCell.font = { color: { argb: "FF9CA3AF" } };
    }
    xr.getCell(6).value = row.agent;
    xr.getCell(7).value = row.evidence;
    xr.getCell(8).value = row.handlingAgent;
    const durCell = xr.getCell(9);
    durCell.value = row.durationMin;
    durCell.numFmt = "0.0";
    xr.getCell(10).value = row.callId;
    for (let c = 1; c <= ncols; c++) xr.getCell(c).border = thinBorder();
    xr.commit();
    r++;
  }

  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: Math.max(4, r - 1), column: ncols } };

  // ── Summary ──
  const s = wb.addWorksheet("Summary");
  s.getColumn(1).width = 34;
  s.getColumn(2).width = 16;

  // Partner companies (fixed order, always shown) + internal departments (dynamic).
  const partnerCounts: Record<string, number> = {};
  const internalCounts: Record<string, number> = {};
  let partnerTotal = 0;
  let internalTotal = 0;
  for (const row of rows) {
    if (row.kind === "Internal") {
      const key = row.company || "Other";
      internalCounts[key] = (internalCounts[key] ?? 0) + 1;
      internalTotal++;
    } else {
      const key = row.company || "(unspecified)";
      partnerCounts[key] = (partnerCounts[key] ?? 0) + 1;
      partnerTotal++;
    }
  }

  let sr = 1;
  const title = s.getCell(sr, 1);
  title.value = "Live Transfers — Summary";
  title.font = { bold: true, size: 14, color: { argb: "FF3B0764" } };
  sr += 2;

  const sectionHeader = (label: string) => {
    s.getCell(sr, 1).value = label;
    s.getCell(sr, 2).value = "Count";
    s.getCell(sr, 1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    s.getCell(sr, 2).font = { bold: true, color: { argb: "FFFFFFFF" } };
    s.getCell(sr, 1).fill = solid("FF6D28D9");
    s.getCell(sr, 2).fill = solid("FF6D28D9");
    sr++;
  };
  const dataRow = (label: string, n: number) => {
    s.getCell(sr, 1).value = label;
    s.getCell(sr, 2).value = n;
    s.getCell(sr, 2).alignment = { horizontal: "right" };
    sr++;
  };
  const totalRow = (label: string, n: number) => {
    s.getCell(sr, 1).value = label;
    s.getCell(sr, 1).font = { bold: true };
    s.getCell(sr, 2).value = n;
    s.getCell(sr, 2).font = { bold: true };
    s.getCell(sr, 2).alignment = { horizontal: "right" };
    sr++;
  };

  sectionHeader("Partner — Transferred From");
  for (const key of ["Aspire", "Resync", "Clarity", "Concordia", "(unspecified)"]) {
    dataRow(key, partnerCounts[key] ?? 0);
  }
  totalRow("Partner Total", partnerTotal);
  sr++;

  sectionHeader("Internal — Transferred By (Dept)");
  const internalKeys = Object.keys(internalCounts).sort(
    (a, b) => (internalCounts[b] ?? 0) - (internalCounts[a] ?? 0),
  );
  if (internalKeys.length === 0) dataRow("(none)", 0);
  for (const key of internalKeys) dataRow(key, internalCounts[key] ?? 0);
  totalRow("Internal Total", internalTotal);
  sr++;

  totalRow("TOTAL LIVE TRANSFERS", rows.length);

  return wb;
}

export function startLiveTransfersBackground(): void {
  // Kick off shortly after boot, then every 15 minutes.
  setTimeout(() => void runClassifier(), 30_000);
  setInterval(() => void runClassifier(), 15 * 60 * 1000);
}

export default router;
