import jwt from "jsonwebtoken";
import { performance } from "node:perf_hooks";

const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

let cachedToken: { token: string; exp: number } | null = null;

function roundedMs(value: number): number {
  return Math.round(value * 100) / 100;
}

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

async function sheetsApi(path: string, signal?: AbortSignal): Promise<Response> {
  const token = await getAccessToken();
  return fetch(`${SHEETS_BASE}${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
}

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
  for (const sheet of json.sheets ?? []) {
    const properties = sheet.properties;
    if (properties && typeof properties.sheetId === "number" && typeof properties.title === "string") {
      map.set(properties.sheetId, properties.title);
    }
  }
  titleCache.set(spreadsheetId, map);
  return map;
}

export async function googleSheetTitleForGid(
  spreadsheetId: string,
  gid: number,
): Promise<string | null> {
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

export async function fetchGoogleSheetValues(
  spreadsheetId: string,
  title: string,
): Promise<{ payload: unknown; providerMs: number }> {
  const providerStartedAt = performance.now();
  const range = encodeURIComponent(title);
  const resp = await sheetsApi(
    `/${spreadsheetId}/values/${range}`,
    AbortSignal.timeout(15_000),
  );
  if (!resp.ok) {
    throw new Error(`Google Sheets values request failed with status ${resp.status}`);
  }
  const payload = await resp.json();
  return { payload, providerMs: roundedMs(performance.now() - providerStartedAt) };
}
