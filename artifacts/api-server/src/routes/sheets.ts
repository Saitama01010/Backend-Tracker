import { Router } from "express";
// Google Sheets integration (connector id: google-sheet). The SDK handles
// identity + token refresh automatically; never cache the client.
import { ReplitConnectors } from "@replit/connectors-sdk";

const router = Router();
const connectors = new ReplitConnectors();

type SheetData = { headers: string[]; rows: Record<string, string>[] };

// gid (numeric sheetId) -> sheet title, cached per spreadsheet so we don't hit
// the metadata endpoint on every fetch. Refreshed on a miss.
const titleCache = new Map<string, Map<number, string>>();

async function loadTitles(spreadsheetId: string): Promise<Map<number, string>> {
  const resp = await connectors.proxy(
    "google-sheet",
    `/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties(sheetId,title)`,
    { method: "GET" },
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
    const resp = await connectors.proxy(
      "google-sheet",
      `/v4/spreadsheets/${spreadsheetId}/values/${range}`,
      { method: "GET" },
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
