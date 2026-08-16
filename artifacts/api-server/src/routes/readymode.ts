import { Router } from "express";
import { performance } from "node:perf_hooks";
import { db, readymodeUploadsTable } from "@workspace/db";
import { and, gte, lte } from "drizzle-orm";
import type { Logger } from "pino";
import { parseReadymodeRows, type ReadyModeDayRow } from "../integrations/readymode/csvParser.js";
import { persistReadyModeUpload, prepareReadyModeUpload } from "../integrations/readymode/importer.js";
import { logger as rootLogger } from "../lib/logger";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { canAccessDateRange, isAdministrator } from "../middleware/authorizationCore.js";
import { canAccessMetricAgent, loadAuthorizationAgentDirectory } from "../lib/authorizationScope.js";
import {
  approvedReadyModeProbePath,
  validateIntegrationDateRange,
} from "../lib/externalIntegrationPolicy.js";
import { googleCsvUrl, OPERATIONAL_CONFIG } from "../lib/operationalConfig.js";

const router = Router();
router.use("/readymode", requireAuth);

const RM_BASE = "https://icydeals.readymode.com";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ─── Session ─────────────────────────────────────────────────────────────────

let cachedCookies = "";
let cookieExpiry = 0;
let loginBackoffUntil = 0; // don't attempt login before this timestamp

async function getSession(): Promise<string> {
  if (cachedCookies && Date.now() < cookieExpiry) return cachedCookies;

  // Respect backoff: if a recent login attempt failed, wait before retrying
  const now = Date.now();
  if (now < loginBackoffUntil) {
    const waitSecs = Math.ceil((loginBackoffUntil - now) / 1000);
    throw new Error(`ReadyMode login cooling down — retry in ${waitSecs}s`);
  }

  const username = process.env["READYMODE_USERNAME"];
  const password = process.env["READYMODE_PASSWORD"];
  if (!username || !password) throw new Error("READYMODE_USERNAME / READYMODE_PASSWORD not set");

  // Step 1: GET login page to obtain a fresh PHPSESSID (required by PHP session validation)
  const getRes = await fetch(`${RM_BASE}/login_new/`, {
    headers: { "User-Agent": UA, "Accept": "text/html" },
    redirect: "manual",
  });
  const initialCookies = (getRes.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");

  // Step 2: POST credentials with that PHPSESSID in cookie header
  const params = new URLSearchParams();
  params.set("login_account", username);
  params.set("login_password", password);
  params.set("then", "");
  params.set("use_phone_module", "auto");
  params.set("user_tz", OPERATIONAL_CONFIG.businessTimeZone);

  const postRes = await fetch(`${RM_BASE}/login_new/`, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      "Cookie": initialCookies,
      "Referer": `${RM_BASE}/login_new/`,
      "Accept": "text/html,application/xhtml+xml,*/*",
    },
    body: params.toString(),
    redirect: "manual",
  });

  if (postRes.status !== 302) {
    const body = await postRes.text();
    const errMsg = body.match(/class="[^"]*error[^"]*"[^>]*>([^<]+)/i)?.[1]?.trim() ?? `HTTP ${postRes.status}`;
    // Back off 15 minutes to let the account lockout expire
    loginBackoffUntil = Date.now() + 15 * 60 * 1000;
    throw new Error(`ReadyMode login failed: ${errMsg}`);
  }

  // Merge initial session cookie with new auth cookies from login response
  const authCookies = (postRes.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]);
  const allCookies = new Map<string, string>();
  for (const kv of [...initialCookies.split("; "), ...authCookies]) {
    const eq = kv.indexOf("=");
    if (eq > 0) allCookies.set(kv.slice(0, eq), kv.slice(eq + 1));
  }

  cachedCookies = [...allCookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  cookieExpiry = Date.now() + 4 * 60 * 60 * 1000;
  rootLogger.info("ReadyMode session established");
  return cachedCookies;
}

async function rmFetch(path: string, maxRedirects = 5): Promise<{ status: number; body: string; isJson: boolean; finalUrl: string }> {
  await getSession(); // ensures cachedCookies is populated
  let currentPath = path;
  let hops = 0;

  while (hops < maxRedirects) {
    const res = await fetch(`${RM_BASE}${currentPath}`, {
      headers: { "User-Agent": UA, "Accept": "text/html,application/json,*/*", "Cookie": cachedCookies },
      redirect: "manual",
    });

    if (res.status === 302 || res.status === 301) {
      const location = res.headers.get("location") ?? "";
      // If redirected to login page → session expired, invalidate and re-login once
      if (location.includes("login_new") || location.includes("login.php")) {
        if (hops > 0) throw new Error("ReadyMode session expired (redirected to login after re-auth)");
        rootLogger.info({ location }, "ReadyMode session expired, re-authenticating");
        cachedCookies = "";
        cookieExpiry = 0;
        await new Promise((r) => setTimeout(r, 1500)); // brief pause to avoid rate-limit
        await getSession();
        hops++;
        continue;
      }
      // Otherwise it's a normal app redirect — follow it
      if (location.startsWith("http")) {
        // Absolute URL — extract path component
        try {
          const u = new URL(location);
          currentPath = u.pathname + u.search;
        } catch { currentPath = location; }
      } else {
        currentPath = location;
      }
      rootLogger.info({ from: path, to: currentPath }, "ReadyMode redirect followed");
      hops++;
      continue;
    }

    const body = await res.text();
    const ct = res.headers.get("content-type") ?? "";
    return { status: res.status, body, isJson: ct.includes("application/json"), finalUrl: currentPath };
  }

  throw new Error(`ReadyMode: too many redirects from ${path}`);
}

async function probeReadyModePath(path: string): Promise<{ status: number; isJson: boolean; bodyLength: number }> {
  await getSession();
  const res = await fetch(`${RM_BASE}${path}`, {
    headers: { "User-Agent": UA, "Accept": "text/html,application/json,*/*", "Cookie": cachedCookies },
    redirect: "manual",
  });
  if (res.status >= 300 && res.status < 400) {
    throw new Error("ReadyMode probe redirect rejected");
  }
  const body = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  return { status: res.status, isJson: contentType.includes("application/json"), bodyLength: body.length };
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RmAgentStat {
  agentName: string;
  dialed: number;
  connected: number;
  talkTimeSecs: number;
  avgTalkSecs: number;
  connectRate: number;
}

export interface RmStatsResponse {
  agents: RmAgentStat[];
  totals: {
    dialed: number;
    connected: number;
    talkTimeSecs: number;
    connectRate: number;
  };
  updatedAt: string;
  raw?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseSecs(val: string): number {
  // Parses "H:MM:SS", "M:SS", or plain seconds string
  const parts = val.trim().split(":").map(Number);
  if (parts.some(isNaN)) return 0;
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  return parts[0]!;
}

/**
 * Attempt to parse agent rows from a ReadyMode HTML report table.
 * ReadyMode renders data in <table> elements with <tr> rows.
 * This is a best-effort parser; it returns an empty array when the structure
 * cannot be recognized so the caller can fall back gracefully.
 */
export function parseAgentTable(html: string): RmAgentStat[] {
  // Look for a table that has agent names and numeric call counts
  // Typical pattern: rows of <td> with agent name, dialed, connected, talk time
  const tableMatch = html.match(/<table[^>]*>([\s\S]*?)<\/table>/gi);
  if (!tableMatch) return [];

  const agents: RmAgentStat[] = [];

  for (const table of tableMatch) {
    const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
    if (rows.length < 2) continue;

    // Find header row to understand column positions
    const headerRow = rows[0]?.[1] ?? "";
    const headers = [...headerRow.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((m) =>
      m[1]?.replace(/<[^>]+>/g, "").trim().toLowerCase() ?? ""
    );

    // Detect if this looks like a dialer report
    const hasAgent = headers.some((h) => h.includes("agent") || h.includes("name"));
    const hasCalls = headers.some((h) => h.includes("dial") || h.includes("call") || h.includes("total"));
    if (!hasAgent || !hasCalls) continue;

    const nameIdx = headers.findIndex((h) => h.includes("agent") || h.includes("name"));
    const dialIdx = headers.findIndex((h) => h.includes("dial") || h.includes("total call") || h.includes("calls"));
    const connIdx = headers.findIndex((h) => h.includes("connect") || h.includes("answer") || h.includes("talk"));
    const timeIdx = headers.findIndex((h) => h.includes("time") || h.includes("duration") || h.includes("talk"));

    for (const row of rows.slice(1)) {
      const cells = [...row[1]!.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((m) =>
        m[1]?.replace(/<[^>]+>/g, "").trim() ?? ""
      );
      if (cells.length < 2) continue;

      const name = cells[nameIdx] ?? cells[0] ?? "";
      if (!name || name.toLowerCase().includes("total") || name.toLowerCase().includes("summary")) continue;

      const dialedRaw = cells[dialIdx] ?? cells[1] ?? "0";
      const connRaw = connIdx >= 0 ? (cells[connIdx] ?? "0") : "0";
      const timeRaw = timeIdx >= 0 ? (cells[timeIdx] ?? "0") : "0";

      const dialed = parseInt(dialedRaw.replace(/[^0-9]/g, ""), 10) || 0;
      const connected = connIdx >= 0 ? parseInt(connRaw.replace(/[^0-9]/g, ""), 10) || 0 : 0;
      const talkTimeSecs = timeRaw.includes(":") ? parseSecs(timeRaw) : parseInt(timeRaw.replace(/[^0-9]/g, ""), 10) || 0;
      const connectRate = dialed > 0 ? Math.round((connected / dialed) * 1000) / 10 : 0;
      const avgTalkSecs = connected > 0 ? Math.round(talkTimeSecs / connected) : 0;

      if (dialed > 0 || connected > 0) {
        agents.push({ agentName: name, dialed, connected, talkTimeSecs, avgTalkSecs, connectRate });
      }
    }

    if (agents.length > 0) break;
  }

  return agents;
}

// Paths to probe in order for agent call data (ReadyMode/XenCALL)
const REPORT_PROBE_PATHS = [
  "/supervisor/",
  "/reporting/",
  "/report/",
  "/",
];

// ─── Routes ──────────────────────────────────────────────────────────────────

// ─── CSV source (Google Sheet) ────────────────────────────────────────────────
// Operator-maintained Google Sheet exported as CSV. Replaces the broken HTML
// scraper. The sheet is published with daily ReadyMode agent reports
// (Day/date, Name, Ready (t), Break (t), Logged calls, Transfers,
//  Ready:Avg wait, Ready:Avg wrap, Ready:Talk Time).
const READYMODE_CSV_URL = googleCsvUrl(OPERATIONAL_CONFIG.readyModeSheet);

type ReadyModeSourceSnapshot = {
  sources: { source: string; rows: ReadyModeDayRow[] }[];
  fetchedAt: Date;
  providerMs: number;
  databaseMs: number;
  parseMs: number;
  refreshError: boolean;
};

const READYMODE_CACHE_TTL_MS = 60_000;
const READYMODE_MAX_STALE_MS = 5 * 60_000;
const READYMODE_CACHE_MAX_ENTRIES = 50;
const readyModeSourceCache = new Map<string, ReadyModeSourceSnapshot>();
const readyModeSourceRefreshes = new Map<string, Promise<ReadyModeSourceSnapshot>>();
let readyModeCacheGeneration = 0;

function roundedTiming(value: number): number {
  return Math.round(value * 100) / 100;
}

function readyModeSourceKey(fromIso?: string, toIso?: string): string {
  return `${fromIso ?? "all"}:${toIso ?? "all"}`;
}

async function refreshReadyModeSources(
  fromIso: string | undefined,
  toIso: string | undefined,
  log: Logger,
): Promise<ReadyModeSourceSnapshot> {
  const sources: { source: string; rows: ReadyModeDayRow[] }[] = [];
  let parseMs = 0;
  let refreshError = false;
  const ingest = (text: string, source: string) => {
    const parseStartedAt = performance.now();
    const rows = parseReadymodeRows(text, log, source);
    parseMs += performance.now() - parseStartedAt;
    sources.push({ source, rows });
  };

  const sourceStartedAt = performance.now();
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const candidates = [
    path.resolve(process.cwd(), "..", "..", "attached_assets"),
    path.resolve(process.cwd(), "attached_assets"),
    "/home/runner/workspace/attached_assets",
  ];
  for (const root of candidates) {
    try {
      const files = await fs.readdir(root);
      const csvFiles = files
        .filter((file) => /^Agent_report.*\.csv$/i.test(file))
        .sort()
        .reverse();
      if (csvFiles.length > 0) {
        const picked = path.join(root, csvFiles[0]!);
        ingest(await fs.readFile(picked, "utf8"), `attached-asset:${csvFiles[0]}`);
        break;
      }
    } catch {
      // Try the next known local asset location.
    }
  }

  try {
    const csvRes = await fetch(READYMODE_CSV_URL, {
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    if (csvRes.ok) {
      const text = await csvRes.text();
      if (text.trim()) ingest(text, "google-sheet");
    } else {
      refreshError = true;
      log.warn({ status: csvRes.status }, "readymode google sheet fetch failed");
    }
  } catch (error) {
    refreshError = true;
    log.warn({ err: error }, "readymode google sheet fetch threw");
  }
  const providerMs = roundedTiming(performance.now() - sourceStartedAt);

  const databaseStartedAt = performance.now();
  try {
    const conditions = [];
    if (fromIso) conditions.push(gte(readymodeUploadsTable.statDate, fromIso));
    if (toIso) conditions.push(lte(readymodeUploadsTable.statDate, toIso));
    const dbRows = await db
      .select()
      .from(readymodeUploadsTable)
      .where(conditions.length ? and(...conditions) : undefined);
    if (dbRows.length) {
      sources.push({
        source: "db-upload",
        rows: dbRows.map((row) => ({
          name: row.agentName,
          iso: row.statDate,
          dialed: row.dialed,
          talkSecs: row.talkSecs,
        })),
      });
    }
  } catch (error) {
    refreshError = true;
    log.warn({ err: error }, "readymode db uploads query threw");
  }

  return {
    sources,
    fetchedAt: new Date(),
    providerMs,
    databaseMs: roundedTiming(performance.now() - databaseStartedAt),
    parseMs: roundedTiming(parseMs),
    refreshError,
  };
}

async function loadReadyModeSources(
  fromIso: string | undefined,
  toIso: string | undefined,
  log: Logger,
): Promise<{
  snapshot: ReadyModeSourceSnapshot;
  cache: "hit" | "miss" | "stale";
  refreshError: boolean;
}> {
  const key = readyModeSourceKey(fromIso, toIso);
  const cacheGeneration = readyModeCacheGeneration;
  const now = Date.now();
  const cached = readyModeSourceCache.get(key);
  if (cached && now - cached.fetchedAt.getTime() <= READYMODE_CACHE_TTL_MS) {
    return {
      snapshot: cached,
      cache: cached.refreshError ? "stale" : "hit",
      refreshError: cached.refreshError,
    };
  }

  let refresh = readyModeSourceRefreshes.get(key);
  if (!refresh) {
    refresh = refreshReadyModeSources(fromIso, toIso, log);
    readyModeSourceRefreshes.set(key, refresh);
    void refresh.finally(() => {
      if (readyModeSourceRefreshes.get(key) === refresh) readyModeSourceRefreshes.delete(key);
    }).catch(() => undefined);
  }
  const snapshot = await refresh;
  if (snapshot.refreshError && cached && now - cached.fetchedAt.getTime() <= READYMODE_MAX_STALE_MS) {
    return { snapshot: cached, cache: "stale", refreshError: true };
  }
  for (const [candidate, value] of readyModeSourceCache) {
    if (now - value.fetchedAt.getTime() > READYMODE_MAX_STALE_MS) readyModeSourceCache.delete(candidate);
  }
  if (readyModeSourceCache.size >= READYMODE_CACHE_MAX_ENTRIES) {
    const oldest = readyModeSourceCache.keys().next().value as string | undefined;
    if (oldest) readyModeSourceCache.delete(oldest);
  }
  if (cacheGeneration === readyModeCacheGeneration) readyModeSourceCache.set(key, snapshot);
  return {
    snapshot,
    cache: snapshot.refreshError ? "stale" : "miss",
    refreshError: snapshot.refreshError,
  };
}

/**
 * GET /api/readymode/stats
 * Returns per-agent dialer stats from the operator-maintained Google Sheet
 * (CSV export). Supports optional date filtering via ?from=YYYY-MM-DD&to=YYYY-MM-DD.
 * The diagnostic route exposes only metadata for a small set of approved
 * upstream paths; it is not a general-purpose scraper.
 */
router.get("/readymode/stats", async (req, res) => {
  const log = req.log ?? rootLogger;
  const fromIso = typeof req.query["from"] === "string" ? req.query["from"] : undefined;
  const toIso = typeof req.query["to"] === "string" ? req.query["to"] : undefined;
  if (!canAccessDateRange(req.user!, [fromIso, toIso])) {
    return res.status(403).json({ error: "Forbidden" });
  }
  if ((fromIso && !toIso) || (!fromIso && toIso)) {
    return res.status(400).json({ error: "Both from and to are required." });
  }
  if (fromIso && toIso) {
    const range = validateIntegrationDateRange(fromIso, toIso);
    if (!range.ok) return res.status(400).json({ error: range.error });
  }
  const requestStartedAt = performance.now();
  try {
    // Three data sources, in increasing priority (later wins on (agent, day)):
    //   1. attached_assets/Agent_report_*.csv — historical baseline.
    //   2. Google Sheet CSV — live, operator-maintained.
    //   3. DB uploads (readymode_uploads) — operator-uploaded via the portal.
    const loaded = await loadReadyModeSources(fromIso, toIso, log);
    const sources = loaded.snapshot.sources;
    const transformStartedAt = performance.now();
    const sendResponse = (response: RmStatsResponse, rowCount: number, authorizationMs = 0) => {
      const transformMs = roundedTiming(performance.now() - transformStartedAt);
      const serializeStartedAt = performance.now();
      const body = JSON.stringify(response);
      const serializeMs = roundedTiming(performance.now() - serializeStartedAt);
      const stale = loaded.cache === "stale";
      res.set("Cache-Control", "private, no-store");
      res.set("X-ReadyMode-Cache", loaded.cache);
      res.set("X-Data-Stale", stale ? "true" : "false");
      res.set("X-Result-Rows", String(rowCount));
      res.set("Server-Timing", [
        `provider;dur=${loaded.cache === "miss" ? loaded.snapshot.providerMs : 0}`,
        `db;dur=${loaded.cache === "miss" ? loaded.snapshot.databaseMs : 0}`,
        `parse;dur=${loaded.cache === "miss" ? loaded.snapshot.parseMs : 0}`,
        `authz;dur=${authorizationMs}`,
        `authn;dur=${req.authTimingMs ?? 0}`,
        `transform;dur=${transformMs}`,
        `serialize;dur=${serializeMs}`,
        `app;dur=${roundedTiming(performance.now() - requestStartedAt)}`,
      ].join(", "));
      if (stale) res.set("Warning", '110 - "ReadyMode response is stale after a refresh failure"');
      return res.type("application/json").send(body);
    };

    // (1) Historical CSV bundled in attached_assets/.
    // Source I/O and parsing are cached and coalesced above.

    // (2) Live Google Sheet — overrides historical CSV on overlapping days.
    // (3) Operator uploads stored in the DB — highest priority. Scoped to the
    // requested range so a wide history doesn't bloat the merge.
    if (sources.length === 0) {
      const empty: RmStatsResponse = {
        agents: [],
        totals: { dialed: 0, connected: 0, talkTimeSecs: 0, connectRate: 0 },
        updatedAt: loaded.snapshot.fetchedAt.toISOString(),
        raw: "ReadyMode CSV unavailable — publish the Google Sheet (File → Share → Anyone with link → Viewer) or drop Agent_report_*.csv into attached_assets/.",
      };
      return sendResponse(empty, 0);
    }

    // Merge sources, deduping on (name, day). Later sources win — Google
    // Sheet is ingested second so any day the operator updates there
    // overrides the historical CSV for that same (agent, day).
    const byKey = new Map<string, ReadyModeDayRow>();
    for (const { rows } of sources) {
      for (const r of rows) {
        byKey.set(`${r.name.trim().toLowerCase().replace(/\s+/g, " ")}|${r.iso}`, r);
      }
    }

    // Aggregate per agent. Skip non-date rows ("Monday"/"Sunday" weekday
    // aggregates and "-" agent-total rows) to avoid double-counting.
    type Agg = { dialed: number; talkTimeSecs: number; days: Set<string> };
    const agg = new Map<string, Agg>();
    let included = 0;
    let skipped = 0;
    for (const r of byKey.values()) {
      if (fromIso && r.iso < fromIso) { skipped++; continue; }
      if (toIso && r.iso > toIso) { skipped++; continue; }
      const e = agg.get(r.name) ?? { dialed: 0, talkTimeSecs: 0, days: new Set<string>() };
      e.dialed += r.dialed;
      e.talkTimeSecs += r.talkSecs;
      e.days.add(r.iso);
      agg.set(r.name, e);
      included++;
    }

    const allAgents: RmAgentStat[] = [...agg.entries()]
      .filter(([, v]) => v.dialed > 0 || v.talkTimeSecs > 0)
      .map(([agentName, v]) => ({
        agentName,
        dialed: v.dialed,
        connected: v.dialed, // CSV does not separate dialed vs connected
        talkTimeSecs: v.talkTimeSecs,
        avgTalkSecs: v.dialed > 0 ? Math.round(v.talkTimeSecs / v.dialed) : 0,
        connectRate: 100,
      }));
    const authorizationStartedAt = performance.now();
    const directory = isAdministrator(req.user!) ? null : await loadAuthorizationAgentDirectory();
    const agents = directory
      ? allAgents.filter((agent) => canAccessMetricAgent(req.user!, agent.agentName, directory))
      : allAgents;
    const authorizationMs = roundedTiming(performance.now() - authorizationStartedAt);

    const totals = {
      dialed: agents.reduce((s, a) => s + a.dialed, 0),
      connected: agents.reduce((s, a) => s + a.connected, 0),
      talkTimeSecs: agents.reduce((s, a) => s + a.talkTimeSecs, 0),
      connectRate: 100,
    };

    const sourceSummary = sources.map((s) => `${s.source}(${s.rows.length})`).join(" + ");
    log.info({ included, skipped, agents: agents.length, fromIso, toIso, sources: sourceSummary }, "readymode/stats merged");
    const response: RmStatsResponse = {
      agents,
      totals,
      updatedAt: loaded.snapshot.fetchedAt.toISOString(),
      raw: directory
        ? `Scoped to ${agents.length} authorized agent(s) · ${included} rows in requested range`
        : `Sources: ${sourceSummary} → ${byKey.size} unique (agent,day) rows · ${included} in range · ${skipped} out of range`,
    };
    return sendResponse(response, agents.length, authorizationMs);
  } catch (err) {
    log.error({ err }, "readymode/stats error");
    return res.status(500).json({ error: "ReadyMode statistics are temporarily unavailable." });
  }
});

/**
 * GET /api/readymode/probe?path=/approved/path
 * Admin-only diagnostic for approved ReadyMode paths. It returns response
 * metadata only and rejects redirects and response bodies.
 */
router.get("/readymode/probe", requireRole("admin"), async (req, res) => {
  const log = req.log ?? rootLogger;
  const path = approvedReadyModeProbePath(req.query["path"] ?? "/");
  if (!path) {
    res.status(400).json({ error: "ReadyMode probe path is not approved." });
    return;
  }
  try {
    const result = await probeReadyModePath(path);
    res.json({
      path,
      status: result.status,
      isJson: result.isJson,
      bodyLength: result.bodyLength,
    });
  } catch (err) {
    log.error({ err }, "readymode/probe error");
    res.status(500).json({ error: "ReadyMode probe failed." });
  }
});

/**
 * POST /api/readymode/upload
 * Body: { csv: string, filename?: string }
 * Parses an uploaded ReadyMode daily-report CSV and upserts its per-(agent, day)
 * rows into readymode_uploads. These rows are the highest-priority source for
 * /readymode/stats, so re-uploading a day overwrites it. Admin/edit only.
 */
router.post("/readymode/upload", requireAuth, requireRole("admin", "edit"), async (req, res) => {
  const log = req.log ?? rootLogger;
  try {
    const { csv, filename, date } = req.body as {
      csv?: unknown;
      filename?: unknown;
      date?: unknown;
    };
    if (typeof csv !== "string" || !csv.trim()) {
      return res.status(400).json({ error: "Missing csv text in request body." });
    }
    let fallbackIso: string | undefined;
    if (date !== undefined && date !== null && date !== "") {
      if (
        typeof date !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        // Reject format-valid but non-existent dates (e.g. 2026-02-30): round-trip
        // through Date and confirm it normalizes back to the same string.
        new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
      ) {
        return res.status(400).json({ error: "Invalid date; expected a real YYYY-MM-DD date." });
      }
      fallbackIso = date;
    }
    const source = typeof filename === "string" && filename.trim() ? filename.trim() : "upload";
    const rows = parseReadymodeRows(csv, log, source, fallbackIso);
    if (rows.length === 0) {
      return res.status(400).json({
        error:
          "No valid rows found. Daily reports have no calendar date — pick the report date when uploading. Expected a ReadyMode report with Name and Logged calls columns.",
      });
    }

    const uploadedBy = req.user?.username ?? "unknown";
    const values = prepareReadyModeUpload(rows, uploadedBy);
    await persistReadyModeUpload(values);

    // A successful upload is authoritative and must be visible on the next
    // stats read rather than waiting for the bounded source-cache TTL.
    readyModeCacheGeneration++;
    readyModeSourceCache.clear();
    readyModeSourceRefreshes.clear();

    const dates = [...new Set(values.map((v) => v.statDate))].sort();
    log.info({ rows: values.length, dates: dates.length, uploadedBy, source }, "readymode/upload stored");
    return res.json({
      ok: true,
      rowsStored: values.length,
      dateRange: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
      days: dates.length,
    });
  } catch (err) {
    log.error({ err }, "readymode/upload error");
    return res.status(500).json({ error: "ReadyMode upload could not be processed." });
  }
});

/**
 * POST /api/readymode/session/reset
 * Clears cached session so the next request triggers a fresh login.
 */
router.post("/readymode/session/reset", requireRole("admin"), (_req, res) => {
  cachedCookies = "";
  cookieExpiry = 0;
  loginBackoffUntil = 0;
  rootLogger.info("ReadyMode session cache cleared");
  res.json({ ok: true });
});

export default router;
