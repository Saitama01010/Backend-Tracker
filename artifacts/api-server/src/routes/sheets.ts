import { Router } from "express";
import jwt from "jsonwebtoken";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { requireAuth } from "../middleware/auth.js";
import { loadAuthorizationAgentDirectory, scopeSheetData } from "../lib/authorizationScope.js";
import { isApprovedSheetSource, parseGoogleSheetsValues, parseSheetGid } from "../lib/externalIntegrationPolicy.js";

const router = Router();
router.use("/sheet", requireAuth);

type SheetData = { headers: string[]; rows: Record<string, string>[] };
type SheetSourceSnapshot = {
  data: SheetData;
  rawHeaders: string[];
  fetchedAt: Date;
  providerMs: number;
  parseMs: number;
  rowsReceived: number;
  rowsAccepted: number;
  rowsSkipped: number;
};

const SHEET_CACHE_TTL_MS = 60_000;
const SHEET_MAX_STALE_MS = 5 * 60_000;
const sheetCache = new Map<string, SheetSourceSnapshot>();
const sheetRefreshes = new Map<string, Promise<SheetSourceSnapshot>>();

function roundedMs(value: number): number {
  return Math.round(value * 100) / 100;
}

// ─── Google Sheets auth (service account) ────────────────────────────────────
// Replaces Replit's connector proxy with a self-hosted service account so the
// source spreadsheets can stay private off Replit.
//
// Setup:
//   1. Create a Google Cloud service account, enable the Google Sheets API.
//   2. Share each spreadsheet with the service account's email (Viewer).
//   3. Set these env vars from the service account's JSON key:
//        GOOGLE_SA_CLIENT_EMAIL  = <client_email>
//        GOOGLE_SA_PRIVATE_KEY   = <private_key>  (newlines may be escaped as \n)
const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

function normalizeHeaderName(s: string): string {
  return s
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

const KNOWN_HEADER_ALIASES = new Set([
  "timestamp", "time stamp", "submitted at", "created at", "date", "date/time", "submission time", "submit time",
  "agent name", "agent", "representative", "employee", "user", "submitted by",
  "cancel request update", "cancel update", "request update", "status", "update", "cancel status",
  "file id", "fileid", "file #", "account #", "account id", "loan #", "id",
].map(normalizeHeaderName));

function looksLikeHeaderRow(row: unknown[]): boolean {
  let matches = 0;
  let nonEmpty = 0;
  for (const cell of row) {
    const value = String(cell ?? "");
    if (value.trim()) nonEmpty++;
    if (KNOWN_HEADER_ALIASES.has(normalizeHeaderName(value))) matches++;
  }
  return matches >= 2;
}

export function detectHeaderRow(values: unknown[][]): number {
  const limit = Math.min(values.length, 10);
  for (let i = 0; i < limit; i++) {
    if (looksLikeHeaderRow(values[i] ?? [])) return i;
  }
  return 0;
}

// Cache the OAuth token until shortly before it expires.
let cachedToken: { token: string; exp: number } | null = null;

async function getAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 60 > now) return cachedToken.token;

  let clientEmail =
    process.env["GOOGLE_SA_CLIENT_EMAIL"] ??
    process.env["GOOGLE_SERVICE_ACCOUNT_EMAIL"];
  let privateKey = (
    process.env["GOOGLE_SA_PRIVATE_KEY"] ??
    process.env["GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY"] ??
    ""
  ).replace(/\\n/g, "\n");
  const serviceAccountJson = process.env["GOOGLE_SERVICE_ACCOUNT_JSON"]?.trim();
  if ((!clientEmail || !privateKey) && serviceAccountJson) {
    const parsed = JSON.parse(serviceAccountJson) as { client_email?: string; private_key?: string };
    clientEmail = parsed.client_email;
    privateKey = (parsed.private_key ?? "").replace(/\\n/g, "\n");
  }
  if (!clientEmail || !privateKey) {
    throw new Error(
      "GOOGLE_SA_CLIENT_EMAIL / GOOGLE_SA_PRIVATE_KEY must be set for Google Sheets access",
    );
  }

  const assertion = jwt.sign(
    { iss: clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 },
    privateKey,
    { algorithm: "RS256" },
  );

  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!resp.ok) {
    throw new Error(`Google OAuth token request failed with status ${resp.status}`);
  }
  const json = (await resp.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("no access_token in token response");
  cachedToken = { token: json.access_token, exp: now + (json.expires_in ?? 3600) };
  return json.access_token;
}

// Authenticated GET against the Sheets API. `path` starts with "/<spreadsheetId>".
async function sheetsApi(path: string, signal?: AbortSignal): Promise<Response> {
  const token = await getAccessToken();
  return fetch(`${SHEETS_BASE}${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
}

// gid (numeric sheetId) -> sheet title, cached per spreadsheet so we don't hit
// the metadata endpoint on every fetch. Refreshed on a miss.
const titleCache = new Map<string, Map<number, string>>();
const titleRefreshes = new Map<string, Promise<Map<number, string>>>();

async function loadTitles(spreadsheetId: string): Promise<Map<number, string>> {
  const resp = await sheetsApi(
    `/${spreadsheetId}?fields=sheets.properties(sheetId,title)`,
    AbortSignal.timeout(15_000),
  );
  if (!resp.ok) {
    throw new Error(`Google Sheets metadata request failed with status ${resp.status}`);
  }
  const json = (await resp.json()) as {
    sheets?: { properties?: { sheetId?: number; title?: string } }[];
  };
  const map = new Map<number, string>();
  for (const s of json.sheets ?? []) {
    const p = s.properties;
    if (p && typeof p.sheetId === "number" && typeof p.title === "string") {
      map.set(p.sheetId, p.title);
    }
  }
  titleCache.set(spreadsheetId, map);
  return map;
}

async function titleForGid(spreadsheetId: string, gid: number): Promise<string | null> {
  let map = titleCache.get(spreadsheetId);
  if (!map || !map.has(gid)) {
    let refresh = titleRefreshes.get(spreadsheetId);
    if (!refresh) {
      refresh = loadTitles(spreadsheetId);
      titleRefreshes.set(spreadsheetId, refresh);
      void refresh.finally(() => {
        if (titleRefreshes.get(spreadsheetId) === refresh) titleRefreshes.delete(spreadsheetId);
      }).catch(() => undefined);
    }
    map = await refresh;
  }
  return map.get(gid) ?? null;
}

async function refreshSheetSnapshot(
  spreadsheetId: string,
  gid: number,
  title: string,
): Promise<SheetSourceSnapshot> {
  const providerStartedAt = performance.now();
  const range = encodeURIComponent(title);
  const resp = await sheetsApi(
    `/${spreadsheetId}/values/${range}`,
    AbortSignal.timeout(15_000),
  );
  if (!resp.ok) {
    throw new Error(`Google Sheets values request failed with status ${resp.status}`);
  }
  const json = await resp.json();
  const providerMs = roundedMs(performance.now() - providerStartedAt);

  const parseStartedAt = performance.now();
  const values = parseGoogleSheetsValues(json);
  const headerRowIndex = detectHeaderRow(values);
  const headerCells = (values[headerRowIndex] ?? []).map((header) => String(header ?? "").trim());
  const sourceWidth = values.slice(headerRowIndex + 1)
    .reduce((width, row) => Math.max(width, row.length), headerCells.length);
  // Keep unnamed and trailing source columns so rows-v1 can reconstruct every
  // legacy __colN field, including cells beyond the last named header.
  const rawHeaders = Array.from({ length: sourceWidth }, (_, index) => headerCells[index] ?? "");
  const headers = rawHeaders.filter((header) => header.length > 0);
  const rows: Record<string, string>[] = [];
  let rowsSkipped = 0;
  for (let i = headerRowIndex + 1; i < values.length; i++) {
    const row = values[i] ?? [];
    const obj: Record<string, string> = {};
    let hasData = false;
    const width = Math.max(rawHeaders.length, row.length);
    for (let column = 0; column < width; column++) {
      const key = rawHeaders[column];
      const cell = row[column];
      const value = cell == null ? "" : String(cell);
      obj[`__col${column}`] = value;
      if (key) obj[key] = value;
      if (value.trim() !== "") hasData = true;
    }
    if (hasData) rows.push(obj);
    else rowsSkipped++;
  }
  return {
    data: { headers, rows },
    rawHeaders,
    fetchedAt: new Date(),
    providerMs,
    parseMs: roundedMs(performance.now() - parseStartedAt),
    rowsReceived: Math.max(0, values.length - headerRowIndex - 1),
    rowsAccepted: rows.length,
    rowsSkipped,
  };
}

async function loadSheetSnapshot(
  spreadsheetId: string,
  gid: number,
  title: string,
): Promise<{
  snapshot: SheetSourceSnapshot;
  cache: "hit" | "miss" | "stale";
  refreshError: boolean;
}> {
  const key = `${spreadsheetId}:${gid}`;
  const now = Date.now();
  const cached = sheetCache.get(key);
  if (cached && now - cached.fetchedAt.getTime() <= SHEET_CACHE_TTL_MS) {
    return { snapshot: cached, cache: "hit", refreshError: false };
  }

  let refresh = sheetRefreshes.get(key);
  if (!refresh) {
    refresh = refreshSheetSnapshot(spreadsheetId, gid, title);
    sheetRefreshes.set(key, refresh);
    void refresh.finally(() => {
      if (sheetRefreshes.get(key) === refresh) sheetRefreshes.delete(key);
    }).catch(() => undefined);
  }

  try {
    const snapshot = await refresh;
    sheetCache.set(key, snapshot);
    return { snapshot, cache: "miss", refreshError: false };
  } catch (error) {
    if (cached && now - cached.fetchedAt.getTime() <= SHEET_MAX_STALE_MS) {
      return { snapshot: cached, cache: "stale", refreshError: true };
    }
    throw error;
  }
}

// GET /api/sheet?id=<spreadsheetId>&gid=<numericSheetId>
// Reads a single tab via the authenticated Google Sheets API and returns it as
// { headers, rows } — the same shape the dashboard previously built from the
// public CSV export. This lets the source spreadsheets stay private.
router.get("/sheet", async (req, res) => {
  const spreadsheetId = String(req.query.id ?? "").trim();
  const gid = parseSheetGid(String(req.query.gid ?? "0"));
  if (!spreadsheetId || !/^[a-zA-Z0-9_-]+$/.test(spreadsheetId)) {
    res.status(400).json({ error: "missing or invalid id" });
    return;
  }
  if (gid === null) {
    res.status(400).json({ error: "invalid gid" });
    return;
  }
  try {
    if (!isApprovedSheetSource(spreadsheetId, gid)) {
      res.status(403).json({ error: "Spreadsheet source is not approved." });
      return;
    }
  } catch {
    req.log.error("Google Sheets source allowlist configuration is invalid");
    res.status(500).json({ error: "Google Sheets source policy is not configured correctly." });
    return;
  }

  try {
    const title = await titleForGid(spreadsheetId, gid);
    if (!title) {
      res.status(404).json({ error: `gid ${gid} not found in spreadsheet` });
      return;
    }
    const loaded = await loadSheetSnapshot(spreadsheetId, gid, title);
    const authorizationStartedAt = performance.now();
    const scoped = scopeSheetData(
      req.user!,
      loaded.snapshot.data,
      await loadAuthorizationAgentDirectory(),
    );
    const authorizationMs = roundedMs(performance.now() - authorizationStartedAt);
    if (!scoped.ok) {
      res.status(403).json({ error: "Forbidden", reason: scoped.reason });
      return;
    }

    const wantsCompact = req.query.format === "rows-v1";
    // Keep the validator stable while the same parsed snapshot is served. A
    // request-time timestamp would change the body and defeat conditional GETs.
    const observedAt = loaded.snapshot.fetchedAt.toISOString();
    const stale = loaded.cache === "stale";
    const responsePayload = wantsCompact ? {
      format: "rows-v1",
      headers: scoped.data.headers,
      columns: loaded.snapshot.rawHeaders,
      rows: scoped.data.rows.map((row) =>
        loaded.snapshot.rawHeaders.map((_, index) => row[`__col${index}`] ?? ""),
      ),
      meta: {
        fetchedAt: loaded.snapshot.fetchedAt.toISOString(),
        observedAt,
        stale,
        refreshError: loaded.refreshError,
        cache: loaded.cache,
        // Counts are scoped too. Returning source-wide counts after filtering
        // would disclose the existence of rows the current actor cannot read.
        rowsReceived: scoped.data.rows.length,
        rowsAccepted: scoped.data.rows.length,
        rowsSkipped: 0,
      },
    } : scoped.data;
    const serializeStartedAt = performance.now();
    const body = JSON.stringify(responsePayload);
    const serializeMs = roundedMs(performance.now() - serializeStartedAt);
    const etag = `\"${createHash("sha256").update(body).digest("base64url")}\"`;

    res.set("Cache-Control", "private, max-age=0, must-revalidate");
    res.set("Vary", "Authorization");
    res.set("ETag", etag);
    res.set("X-Sheet-Cache", loaded.cache);
    res.set("X-Data-Stale", stale ? "true" : "false");
    res.set("X-Source-Updated-At", loaded.snapshot.fetchedAt.toISOString());
    res.set("X-Rows-Returned", String(scoped.data.rows.length));
    res.set("Server-Timing", [
      `provider;dur=${loaded.cache === "miss" ? loaded.snapshot.providerMs : 0}`,
      `parse;dur=${loaded.cache === "miss" ? loaded.snapshot.parseMs : 0}`,
      `authz;dur=${authorizationMs}`,
      `authn;dur=${req.authTimingMs ?? 0}`,
      `serialize;dur=${serializeMs}`,
    ].join(", "));
    if (stale) res.set("Warning", '110 - "Google Sheets response is stale after a refresh failure"');
    if (req.headers["if-none-match"] === etag) {
      res.status(304).end();
      return;
    }
    res.type("application/json").send(body);
  } catch (err) {
    req.log.error({ err, spreadsheetId, gid }, "sheet fetch failed");
    res.status(502).json({ error: "Fetch failed" });
  }
});

export default router;
