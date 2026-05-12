import { Router } from "express";
import { logger as rootLogger } from "../lib/logger";

const router = Router();
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
  params.set("use_phone_module", "no-phone");
  params.set("user_tz", "America/Los_Angeles");
  params.set("autoequals", "WebRTC");

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

/**
 * GET /api/readymode/stats
 * Returns per-agent dialer stats from ReadyMode.
 */
router.get("/readymode/stats", async (req, res) => {
  const log = req.log ?? rootLogger;
  try {
    for (const path of REPORT_PROBE_PATHS) {
      const result = await rmFetch(path);
      log.info({ path, status: result.status, bodyLen: result.body.length }, "ReadyMode probe");

      if (result.status !== 200) continue;
      if (result.body.includes("login_new") || result.body.includes("login-form")) continue;

      const agents = parseAgentTable(result.body);
      const totals = {
        dialed: agents.reduce((s, a) => s + a.dialed, 0),
        connected: agents.reduce((s, a) => s + a.connected, 0),
        talkTimeSecs: agents.reduce((s, a) => s + a.talkTimeSecs, 0),
        connectRate: 0,
      };
      if (totals.dialed > 0) {
        totals.connectRate = Math.round((totals.connected / totals.dialed) * 1000) / 10;
      }

      const response: RmStatsResponse = {
        agents,
        totals,
        updatedAt: new Date().toISOString(),
        // Return first 3000 chars of body for debugging until endpoints are confirmed
        raw: result.body.slice(0, 3000),
      };
      return res.json(response);
    }

    // All paths redirected to login or returned non-data
    return res.status(503).json({ error: "ReadyMode data unavailable — session established but no parseable report found. Use /api/readymode/probe to inspect available pages." });
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
