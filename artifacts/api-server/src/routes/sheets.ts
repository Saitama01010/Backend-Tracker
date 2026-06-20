import { Router } from "express";
import { sign } from "jsonwebtoken";
// Google Sheets integration (connector id: google-sheet). The SDK handles
// identity + token refresh automatically; never cache the client.
import { ReplitConnectors } from "@replit/connectors-sdk";

const router = Router();
const connectors = new ReplitConnectors();

type SheetData = { headers: string[]; rows: Record<string, string>[] };
type GoogleServiceAccount = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

const GOOGLE_SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
let googleAccessToken: { token: string; expiresAt: number } | null = null;

// gid (numeric sheetId) -> sheet title, cached per spreadsheet so we don't hit
// the metadata endpoint on every fetch. Refreshed on a miss.
const titleCache = new Map<string, Map<number, string>>();

function normalizePrivateKey(privateKey: string): string {
  return privateKey.replace(/\\n/g, "\n");
}

function getGoogleServiceAccount(): GoogleServiceAccount | null {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (json) {
    const parsed = JSON.parse(json) as Partial<GoogleServiceAccount>;
    if (parsed.client_email && parsed.private_key) {
      return {
        client_email: parsed.client_email,
        private_key: normalizePrivateKey(parsed.private_key),
        token_uri: parsed.token_uri,
      };
    }
  }

  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim();
  const privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.trim();
  if (clientEmail && privateKey) {
    return {
      client_email: clientEmail,
      private_key: normalizePrivateKey(privateKey),
    };
  }

  return null;
}

async function getGoogleAccessToken(account: GoogleServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (googleAccessToken && googleAccessToken.expiresAt - 60 > now) {
    return googleAccessToken.token;
  }

  const tokenUrl = account.token_uri || GOOGLE_TOKEN_URL;
  const assertion = sign(
    {
      iss: account.client_email,
      scope: GOOGLE_SHEETS_SCOPE,
      aud: tokenUrl,
      exp: now + 3600,
      iat: now,
    },
    account.private_key,
    { algorithm: "RS256" },
  );

  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`google token HTTP ${resp.status} ${body.slice(0, 200)}`);
  }

  const json = (await resp.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) {
    throw new Error("google token response missing access_token");
  }

  googleAccessToken = {
    token: json.access_token,
    expiresAt: now + (json.expires_in ?? 3600),
  };
  return googleAccessToken.token;
}

async function sheetsApiFetch(path: string): Promise<Response> {
  const account = getGoogleServiceAccount();
  if (account) {
    const token = await getGoogleAccessToken(account);
    return fetch(`https://sheets.googleapis.com${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  return connectors.proxy("google-sheet", path, { method: "GET" });
}

async function loadTitles(spreadsheetId: string): Promise<Map<number, string>> {
  const resp = await sheetsApiFetch(
    `/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties(sheetId,title)`,
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
    const resp = await sheetsApiFetch(
      `/v4/spreadsheets/${spreadsheetId}/values/${range}`,
    );
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
