import { Router } from "express";
import jwt from "jsonwebtoken";

const router = Router();

type SheetData = { headers: string[]; rows: Record<string, string>[] };

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
    const body = await resp.text().catch(() => "");
    throw new Error(`token HTTP ${resp.status} ${body.slice(0, 200)}`);
  }
  const json = (await resp.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("no access_token in token response");
  cachedToken = { token: json.access_token, exp: now + (json.expires_in ?? 3600) };
  return json.access_token;
}

// Authenticated GET against the Sheets API. `path` starts with "/<spreadsheetId>".
async function sheetsApi(path: string): Promise<Response> {
  const token = await getAccessToken();
  return fetch(`${SHEETS_BASE}${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
}

// gid (numeric sheetId) -> sheet title, cached per spreadsheet so we don't hit
// the metadata endpoint on every fetch. Refreshed on a miss.
const titleCache = new Map<string, Map<number, string>>();

async function loadTitles(spreadsheetId: string): Promise<Map<number, string>> {
  const resp = await sheetsApi(
    `/${spreadsheetId}?fields=sheets.properties(sheetId,title)`,
  );
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`metadata HTTP ${resp.status} ${body.slice(0, 200)}`);
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
    map = await loadTitles(spreadsheetId);
  }
  return map.get(gid) ?? null;
}

// GET /api/sheet?id=<spreadsheetId>&gid=<numericSheetId>
// Reads a single tab via the authenticated Google Sheets API and returns it as
// { headers, rows } — the same shape the dashboard previously built from the
// public CSV export. This lets the source spreadsheets stay private.
router.get("/sheet", async (req, res) => {
  const spreadsheetId = String(req.query.id ?? "").trim();
  const gid = Number(req.query.gid ?? 0);
  if (!spreadsheetId || !/^[a-zA-Z0-9_-]+$/.test(spreadsheetId)) {
    res.status(400).json({ error: "missing or invalid id" });
    return;
  }
  if (!Number.isFinite(gid)) {
    res.status(400).json({ error: "invalid gid" });
    return;
  }

  try {
    const title = await titleForGid(spreadsheetId, gid);
    if (!title) {
      res.status(404).json({ error: `gid ${gid} not found in spreadsheet` });
      return;
    }
    const range = encodeURIComponent(title);
    const resp = await sheetsApi(`/${spreadsheetId}/values/${range}`);
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      req.log.warn({ status: resp.status, spreadsheetId, gid }, "sheets values error");
      res.status(502).json({ error: `values HTTP ${resp.status} ${body.slice(0, 200)}` });
      return;
    }
    const json = (await resp.json()) as { values?: unknown[][] };
    const values = json.values ?? [];
    const rawHeaders = (values[0] ?? []).map((h) => String(h ?? "").trim());
    const headers = rawHeaders.filter((h) => h.length > 0);
    const rows: Record<string, string>[] = [];
    for (let i = 1; i < values.length; i++) {
      const row = values[i] ?? [];
      const obj: Record<string, string> = {};
      let hasData = false;
      for (let c = 0; c < rawHeaders.length; c++) {
        const key = rawHeaders[c];
        if (!key) continue;
        const cell = row[c];
        const val = cell == null ? "" : String(cell);
        obj[key] = val;
        if (val.trim() !== "") hasData = true;
      }
      if (hasData) rows.push(obj);
    }
    const payload: SheetData = { headers, rows };
    res.set("Cache-Control", "no-cache, no-store, max-age=0");
    res.json(payload);
  } catch (err) {
    req.log.error({ err, spreadsheetId, gid }, "sheet fetch failed");
    res.status(502).json({ error: "Fetch failed" });
  }
});

export default router;
