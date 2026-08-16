import ExcelJS from "exceljs";
import { logger } from "../../lib/logger.js";
import { sanitizedErrorMessage } from "../../lib/anthropic.js";
import { AiRateLimitError, withDatabaseLease, withDurableAiLimit } from "../../lib/aiRateLimit.js";
import { postgresBackgroundJobStore } from "../../lib/backgroundJobStore.js";
import { manualJobKey } from "../../lib/durableBackgroundJobs.js";
import { OPERATIONAL_CONFIG } from "../../lib/operationalConfig.js";
import { businessDayWindow } from "../../lib/businessTime.js";
import {
  onboardingReportRepository,
  type OnboardingClassificationImportRow,
  type OnboardingReportRepository,
} from "./onboarding.report.repository.js";
import {
  onboardingReportProvider,
  type OnboardingReportProvider,
} from "./onboarding.report.provider.js";

export type { OnboardingClassificationImportRow } from "./onboarding.report.repository.js";

// ─── Onboarding line constants ────────────────────────────────────────────────
const LINE_ID = OPERATIONAL_CONFIG.lineIds.onboarding;
const LINE_LABEL = OPERATIONAL_CONFIG.lineIds.onboardingLabel;
const CONCURRENCY = Math.max(1, Math.min(4, Number(process.env["OB_CONC"] ?? 2) || 2));
const TAX_RE = /\btaxes?\b/i;

// ─── Date range helpers (LA timezone, mirrors obAnalytics) ────────────────────
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Midnight (California) for a YYYY-MM-DD string → UTC bounds for that CA day. */
function caDateBounds(dateStr: string): { from: Date; to: Date } {
  const { start, endExclusive } = businessDayWindow(dateStr);
  return { from: start, to: endExclusive };
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

// ─── Main refresh job ─────────────────────────────────────────────────────────
export async function runOnboardingReportRefresh(
  signal?: AbortSignal,
  repository: OnboardingReportRepository = onboardingReportRepository,
  provider: OnboardingReportProvider = onboardingReportProvider,
): Promise<void> {
  try {
    await withDatabaseLease("outbound_call_classifier", async () => {
      signal?.throwIfAborted();
      await repository.writeState({ isRunning: true, lastError: null, progressDone: 0, progressTotal: 0 });
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
      await provider.syncRecent(syncFrom, new Date(), LINE_ID, signal);
    } catch (err) {
      logger.warn({ errorCode: sanitizedErrorMessage(err) }, "obReport: recent sync failed, continuing with existing data");
    }

    // 2) Find completed calls on the onboarding line that aren't classified yet.
    const pending = await repository.listPending(LINE_ID);

    await repository.writeState({ progressTotal: pending.length, progressDone: 0 });
    logger.info({ pending: pending.length }, "obReport: classifying new calls");

    let done = 0;
    let idx = 0;

    async function worker() {
      while (idx < pending.length) {
        signal?.throwIfAborted();
        const i = idx++;
        const call = pending[i]!;
        try {
          const tx = await provider.fetchTranscript(call.id);
          if (tx.kind === "error") {
            // Transient fetch failure: do NOT persist a row. Leaving the call
            // unclassified means the next refresh will retry it.
            logger.warn({ callId: call.id }, "obReport: transcript fetch failed, will retry next refresh");
          } else if (tx.kind === "notfound" || tx.dialogue.length === 0) {
            await repository.insertClassification({
              callId: call.id,
              callType: "no_transcript",
              customerName: null,
              closerAgent: null,
              mentionsTax: null,
              txStatus: tx.kind === "notfound" ? "notfound" : tx.status,
              notes: "",
            });
          } else {
            const transcript = provider.buildTranscript(tx.dialogue);
            const mentionsTax = TAX_RE.test(transcript);
            const attempt = await provider.classify(call.agentName, call.direction, transcript);
            if (attempt.status === "temporary_error") {
              // LLM failed/timed out: skip so the next refresh retries instead of
              // permanently storing a wrong "error" classification.
              logger.warn({ callId: call.id }, "obReport: classify failed, will retry next refresh");
            } else if (attempt.status === "permanent_error") {
              await repository.insertClassification({
                callId: call.id,
                callType: "error",
                customerName: null,
                closerAgent: null,
                mentionsTax,
                txStatus: "ai_error",
                notes: "Permanent Claude or schema error; review required",
              });
            } else {
              const res = attempt.value;
              await repository.insertClassification({
                callId: call.id,
                callType: res.callType,
                customerName: res.customerName ?? null,
                closerAgent: res.closerAgent ?? null,
                mentionsTax,
                txStatus: "completed",
                notes: res.notes ?? "",
              });
            }
          }
        } catch (err) {
          logger.warn({ errorCode: sanitizedErrorMessage(err), callId: call.id }, "obReport: call processing error");
        }
        done++;
        if (done % 10 === 0 || done === pending.length) {
          await repository.writeState({ progressDone: done });
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, pending.length)) }, worker));

    await repository.writeState({ isRunning: false, lastRunAt: new Date(), progressDone: pending.length, lastError: null });
    logger.info({ classified: pending.length }, "obReport: refresh done");
    });
  } catch (err) {
    const errorCode = sanitizedErrorMessage(err);
    logger.error({ errorCode }, "obReport: refresh failed");
    await repository.writeState({ isRunning: false, lastError: errorCode });
    throw err;
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

async function loadReportRows(
  from?: string,
  to?: string,
  repository: OnboardingReportRepository = onboardingReportRepository,
): Promise<ReportRow[]> {
  const { fromDate, toDate } = parseRange(from, to);
  const rows = await repository.loadReportRows({ lineId: LINE_ID, fromDate, toDate });

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

export type OnboardingRefreshRequestResult =
  | { status: "started" }
  | { status: "already_running" }
  | { status: "rate_limited"; retryAfter: number }
  | { status: "controls_unavailable" }
  | { status: "queue_unavailable"; error: unknown };

export async function requestOnboardingReportRefresh(
  userId: number,
): Promise<OnboardingRefreshRequestResult> {
  if (await postgresBackgroundJobStore.findActive("onboarding_report_refresh")) {
    return { status: "already_running" };
  }
  try {
    await withDurableAiLimit({
      feature: "onboarding_report_refresh",
      userId,
      perMinute: 1,
      perDay: 10,
    }, async () => undefined);
  } catch (error) {
    if (error instanceof AiRateLimitError) {
      return { status: "rate_limited", retryAfter: error.retryAfter };
    }
    return { status: "controls_unavailable" };
  }
  try {
    await postgresBackgroundJobStore.enqueue({
      jobType: "onboarding_report_refresh",
      idempotencyKey: manualJobKey("onboarding_report_refresh", userId),
      requestedByUserId: userId,
      priority: 80,
      maxAttempts: 3,
    });
    return { status: "started" };
  } catch (error) {
    return { status: "queue_unavailable", error };
  }
}

export async function getOnboardingReportStatus(
  from?: string,
  to?: string,
  repository: OnboardingReportRepository = onboardingReportRepository,
) {
  const [state, activeJob] = await Promise.all([
    repository.readState(),
    postgresBackgroundJobStore.findActive("onboarding_report_refresh"),
  ]);
  const { fromDate, toDate } = parseRange(from, to);
  const counts = await repository.loadCounts({ lineId: LINE_ID, fromDate, toDate });

  const typeCounts: Record<string, number> = {};
  for (const count of counts.typeCounts) typeCounts[count.callType] = count.n;
  let taxYes = 0;
  let taxNo = 0;
  for (const item of counts.taxCounts) {
    if (item.mentionsTax === true) taxYes = item.n;
    else if (item.mentionsTax === false) taxNo = item.n;
  }

  return {
    running: Boolean(activeJob),
    progressDone: state?.progressDone ?? 0,
    progressTotal: state?.progressTotal ?? 0,
    lastRunAt: state?.lastRunAt ?? null,
    lastError: state?.lastError ?? null,
    totalCalls: counts.totalCalls,
    classified: Object.values(typeCounts).reduce((sum, count) => sum + count, 0),
    typeCounts,
    taxYes,
    taxNo,
  };
}

export async function buildOnboardingReportWorkbook(
  from?: string,
  to?: string,
  repository: OnboardingReportRepository = onboardingReportRepository,
): Promise<ExcelJS.Workbook> {
  return buildWorkbook(await loadReportRows(from, to, repository));
}

export async function importOnboardingClassifications(
  values: readonly OnboardingClassificationImportRow[],
  repository: OnboardingReportRepository = onboardingReportRepository,
): Promise<{ received: number; total: number }> {
  const total = await repository.importClassifications(values);
  return { received: values.length, total };
}
