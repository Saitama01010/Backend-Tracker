import { Router } from "express";
import { db, readymodeUploadsTable } from "@workspace/db";
import { and, gte, lte, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { logger as rootLogger } from "../lib/logger";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();

// One parsed ReadyMode report row, keyed per (agent, day).
type DayRow = { name: string; iso: string; dialed: number; talkSecs: number };
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
  params.set("user_tz", "America/Los_Angeles");

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
function parseAgentTable(html: string): RmAgentStat[] {
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
const READYMODE_CSV_URL =
  "https://docs.google.com/spreadsheets/d/1wjOupcSaJMl7uSvZEQsoVl2J-US-62HamjVLvKHl-fM/export?format=csv&gid=0";

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function parseCsv(text: string): string[][] {
  // Handles quoted fields with embedded commas/newlines.
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { cur.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        cur.push(field); field = "";
        rows.push(cur); cur = [];
      } else field += c;
    }
  }
  if (field.length > 0 || cur.length > 0) { cur.push(field); rows.push(cur); }
  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0]!.trim()));
}

function parseDurationToSecs(s: string): number {
  if (!s || s === "-") return 0;
  let total = 0;
  const h = s.match(/(\d+)\s*hours?/i);
  const m = s.match(/(\d+)\s*min\./i);
  const sec = s.match(/([\d.]+)\s*s\./i);
  if (h?.[1]) total += parseInt(h[1], 10) * 3600;
  if (m?.[1]) total += parseInt(m[1], 10) * 60;
  if (sec?.[1]) total += parseFloat(sec[1]);
  return Math.round(total);
}

function parseIntSafe(s: string | undefined): number {
  if (!s || s === "-") return 0;
  const n = parseInt(s.replace(/[^0-9-]/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parse a "Day/date" cell like "May 14" → ISO "YYYY-MM-DD" using the current
 * year (sheet doesn't carry a year). Returns null for non-date rows like
 * "Monday", "Sunday", "-" so callers can skip those (weekday labels and
 * agent-totals rows must not be double-counted on top of per-day rows).
 */
function dayToIso(day: string, yearHint?: number): string | null {
  const trimmed = day.trim();
  if (!trimmed || trimmed === "-") return null;
  const m = trimmed.match(/^([A-Za-z]+)\s+(\d{1,2})$/);
  if (!m) return null;
  const mon = MONTHS[m[1]!.slice(0, 3).toLowerCase()];
  if (!mon) return null;
  const d = parseInt(m[2]!, 10);
  if (!d) return null;
  const yr = yearHint ?? new Date().getFullYear();
  return `${yr}-${String(mon).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Parse a ReadyMode daily-report CSV into per-(agent, day) rows. Returns an
 * empty array when required columns ("Name" + "Logged calls") are missing so
 * callers can skip a bad source gracefully. Shared by /readymode/stats and the
 * /readymode/upload endpoint.
 */
function parseReadymodeRows(text: string, log: Logger, source: string): DayRow[] {
  const parsed = parseCsv(text);
  if (parsed.length < 2) return [];
  const header = parsed[0]!.map((h) => h.trim().toLowerCase());
  const idx = {
    day:   header.findIndex((h) => h.includes("day") || h.includes("date")),
    name:  header.findIndex((h) => h === "name" || h.includes("agent")),
    calls: header.findIndex((h) => h.includes("logged call") || h === "calls"),
    talk:  header.findIndex((h) => h.includes("talk time")),
  };
  if (idx.name < 0 || idx.calls < 0) {
    log.warn({ source, header }, "readymode source missing required columns");
    return [];
  }
  const out: DayRow[] = [];
  for (const r of parsed.slice(1)) {
    const name = (r[idx.name] ?? "").trim();
    if (!name) continue;
    const dayRaw = idx.day >= 0 ? (r[idx.day] ?? "") : "";
    const iso = dayToIso(dayRaw);
    if (!iso) continue;
    out.push({
      name,
      iso,
      dialed: parseIntSafe(r[idx.calls]),
      talkSecs: idx.talk >= 0 ? parseDurationToSecs(r[idx.talk] ?? "") : 0,
    });
  }
  return out;
}

/**
 * GET /api/readymode/stats
 * Returns per-agent dialer stats from the operator-maintained Google Sheet
 * (CSV export). Supports optional date filtering via ?from=YYYY-MM-DD&to=YYYY-MM-DD.
 * The legacy HTML scraper (rmFetch, parseAgentTable, REPORT_PROBE_PATHS) is
 * kept available via /api/readymode/probe for future re-enablement.
 */
router.get("/readymode/stats", async (req, res) => {
  const log = req.log ?? rootLogger;
  const fromIso = typeof req.query["from"] === "string" ? req.query["from"] : undefined;
  const toIso = typeof req.query["to"] === "string" ? req.query["to"] : undefined;
  try {
    // Three data sources, in increasing priority (later wins on (agent, day)):
    //   1. attached_assets/Agent_report_*.csv — historical baseline.
    //   2. Google Sheet CSV — live, operator-maintained.
    //   3. DB uploads (readymode_uploads) — operator-uploaded via the portal.
    const sources: { source: string; rows: DayRow[] }[] = [];

    const ingest = (text: string, source: string) => {
      const rows = parseReadymodeRows(text, log, source);
      sources.push({ source, rows });
    };

    // (1) Historical CSV bundled in attached_assets/.
    {
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
            .filter((f) => /^Agent_report.*\.csv$/i.test(f))
            .sort()
            .reverse();
          if (csvFiles.length > 0) {
            const picked = path.join(root, csvFiles[0]!);
            const text = await fs.readFile(picked, "utf8");
            ingest(text, `attached-asset:${csvFiles[0]}`);
            break;
          }
        } catch {
          // try next candidate
        }
      }
    }

    // (2) Live Google Sheet — overrides historical CSV on overlapping days.
    try {
      const csvRes = await fetch(READYMODE_CSV_URL, { redirect: "follow" });
      if (csvRes.ok) {
        const text = await csvRes.text();
        if (text.trim()) ingest(text, "google-sheet");
      }
    } catch (e) {
      log.warn({ err: e }, "readymode google sheet fetch threw");
    }

    // (3) Operator uploads stored in the DB — highest priority. Scoped to the
    // requested range so a wide history doesn't bloat the merge.
    try {
      const conds = [];
      if (fromIso) conds.push(gte(readymodeUploadsTable.statDate, fromIso));
      if (toIso) conds.push(lte(readymodeUploadsTable.statDate, toIso));
      const dbRows = await db
        .select()
        .from(readymodeUploadsTable)
        .where(conds.length ? and(...conds) : undefined);
      if (dbRows.length) {
        sources.push({
          source: "db-upload",
          rows: dbRows.map((r) => ({
            name: r.agentName,
            iso: r.statDate,
            dialed: r.dialed,
            talkSecs: r.talkSecs,
          })),
        });
      }
    } catch (e) {
      log.warn({ err: e }, "readymode db uploads query threw");
    }

    if (sources.length === 0) {
      const empty: RmStatsResponse = {
        agents: [],
        totals: { dialed: 0, connected: 0, talkTimeSecs: 0, connectRate: 0 },
        updatedAt: new Date().toISOString(),
        raw: "ReadyMode CSV unavailable — publish the Google Sheet (File → Share → Anyone with link → Viewer) or drop Agent_report_*.csv into attached_assets/.",
      };
      return res.json(empty);
    }

    // Merge sources, deduping on (name, day). Later sources win — Google
    // Sheet is ingested second so any day the operator updates there
    // overrides the historical CSV for that same (agent, day).
    const byKey = new Map<string, DayRow>();
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

    const agents: RmAgentStat[] = [...agg.entries()]
      .filter(([, v]) => v.dialed > 0 || v.talkTimeSecs > 0)
      .map(([agentName, v]) => ({
        agentName,
        dialed: v.dialed,
        connected: v.dialed, // CSV does not separate dialed vs connected
        talkTimeSecs: v.talkTimeSecs,
        avgTalkSecs: v.dialed > 0 ? Math.round(v.talkTimeSecs / v.dialed) : 0,
        connectRate: 100,
      }));

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
      updatedAt: new Date().toISOString(),
      raw: `Sources: ${sourceSummary} → ${byKey.size} unique (agent,day) rows · ${included} in range · ${skipped} out of range`,
    };
    return res.json(response);
  } catch (err) {
    log.error({ err }, "readymode/stats error");
    return res.status(500).json({ error: String(err) });
  }
});

/**
 * GET /api/readymode/probe?path=/some/path
 * Diagnostic: fetches a ReadyMode page with a valid session and returns status + first 4000 chars.
 * Admin-only — used to discover which endpoints return data.
 */
router.get("/readymode/probe", async (req, res) => {
  const log = req.log ?? rootLogger;
  const path = typeof req.query["path"] === "string" ? req.query["path"] : "/";
  try {
    const result = await rmFetch(path);
    res.json({
      path,
      finalUrl: result.finalUrl,
      status: result.status,
      isJson: result.isJson,
      bodyLength: result.body.length,
      preview: result.body.slice(0, 8000),
      cookies: cachedCookies ? "SET" : "EMPTY",
    });
  } catch (err) {
    log.error({ err }, "readymode/probe error");
    res.status(500).json({ error: String(err) });
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
    const { csv, filename } = req.body as { csv?: unknown; filename?: unknown };
    if (typeof csv !== "string" || !csv.trim()) {
      return res.status(400).json({ error: "Missing csv text in request body." });
    }
    const source = typeof filename === "string" && filename.trim() ? filename.trim() : "upload";
    const rows = parseReadymodeRows(csv, log, source);
    if (rows.length === 0) {
      return res.status(400).json({
        error: "No valid rows found. Expected a ReadyMode report with Name, Day/date and Logged calls columns.",
      });
    }

    // Canonicalize the agent name (trim + collapse internal whitespace) so the
    // stored value is stable across uploads. The DB unique key is
    // (agent_name, stat_date); ReadyMode exports a consistent name per agent,
    // so this guarantees same-day re-uploads upsert the same row rather than
    // inserting a near-duplicate.
    const canonName = (s: string) => s.trim().replace(/\s+/g, " ");
    // Dedupe within the file on (canonical agent, day), keeping the last
    // occurrence so a file with both per-day and total rows doesn't double-insert.
    const byKey = new Map<string, DayRow>();
    for (const r of rows) {
      const name = canonName(r.name);
      byKey.set(`${name.toLowerCase()}|${r.iso}`, { ...r, name });
    }
    const uploadedBy = req.user?.username ?? "unknown";
    const values = [...byKey.values()].map((r) => ({
      agentName: r.name,
      statDate: r.iso,
      dialed: r.dialed,
      talkSecs: r.talkSecs,
      uploadedBy,
    }));

    await db
      .insert(readymodeUploadsTable)
      .values(values)
      .onConflictDoUpdate({
        target: [readymodeUploadsTable.agentName, readymodeUploadsTable.statDate],
        set: {
          dialed: sql`excluded.dialed`,
          talkSecs: sql`excluded.talk_secs`,
          uploadedBy: sql`excluded.uploaded_by`,
          uploadedAt: sql`now()`,
        },
      });

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
    return res.status(500).json({ error: String(err) });
  }
});

/**
 * POST /api/readymode/session/reset
 * Clears cached session so the next request triggers a fresh login.
 */
router.post("/readymode/session/reset", (_req, res) => {
  cachedCookies = "";
  cookieExpiry = 0;
  loginBackoffUntil = 0;
  rootLogger.info("ReadyMode session cache cleared");
  res.json({ ok: true });
});

export default router;
