import { Router } from "express";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fetchGoogleSheetValues, googleSheetTitleForGid } from "../integrations/googleSheets/client.js";
import { mapGoogleSheetValues, type GoogleSheetData } from "../integrations/googleSheets/mapper.js";
import { requireAuth } from "../middleware/auth.js";
import { loadAuthorizationAgentDirectory, scopeSheetData } from "../lib/authorizationScope.js";
import { isApprovedSheetSource, parseSheetGid } from "../lib/externalIntegrationPolicy.js";

const router = Router();
router.use("/sheet", requireAuth);

type SheetSourceSnapshot = {
  data: GoogleSheetData;
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

async function refreshSheetSnapshot(
  spreadsheetId: string,
  gid: number,
  title: string,
): Promise<SheetSourceSnapshot> {
  const fetched = await fetchGoogleSheetValues(spreadsheetId, title);
  const mapped = mapGoogleSheetValues(fetched.payload);
  return {
    ...mapped,
    fetchedAt: new Date(),
    providerMs: fetched.providerMs,
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
    const title = await googleSheetTitleForGid(spreadsheetId, gid);
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
