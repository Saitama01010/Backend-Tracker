import { OPERATIONAL_CONFIG } from "./operationalConfig.js";

export const MAX_INTEGRATION_READ_DAYS = 1_096;
export const MAX_QUO_SYNC_DAYS = 31;

const DAY_MS = 24 * 60 * 60 * 1000;
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const SPREADSHEET_ID = /^[a-zA-Z0-9_-]{20,128}$/;

export type ValidatedIntegrationRange =
  | { ok: true; from: string; to: string; fromDate: Date; toDate: Date }
  | { ok: false; error: string };

function isRealCalendarDate(value: string): boolean {
  if (!CALENDAR_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function parseIntegrationDate(value: unknown): { raw: string; date: Date } | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const raw = value.trim();
  if (!raw || (!isRealCalendarDate(raw) && !ISO_INSTANT.test(raw))) return null;
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? { raw, date } : null;
}

export function validateIntegrationDateRange(
  from: unknown,
  to: unknown,
  maxDays = MAX_INTEGRATION_READ_DAYS,
): ValidatedIntegrationRange {
  const parsedFrom = parseIntegrationDate(from);
  const parsedTo = parseIntegrationDate(to);
  if (!parsedFrom || !parsedTo) return { ok: false, error: "Invalid date range." };
  const span = parsedTo.date.getTime() - parsedFrom.date.getTime();
  if (span < 0) return { ok: false, error: "Invalid date range." };
  if (!Number.isFinite(maxDays) || maxDays <= 0 || span > maxDays * DAY_MS) {
    return { ok: false, error: `Date range exceeds ${maxDays} days.` };
  }
  return {
    ok: true,
    from: parsedFrom.raw,
    to: parsedTo.raw,
    fromDate: parsedFrom.date,
    toDate: parsedTo.date,
  };
}

export function validateIntegrationCalendarDate(value: unknown): value is string {
  return typeof value === "string" && isRealCalendarDate(value.trim());
}

export function parseBoundedInteger(
  value: unknown,
  fallback: number,
  { min, max }: { min: number; max: number },
): number | null {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

export function paginateAfterAuthorization<T>(
  rows: readonly T[],
  isAuthorized: (row: T) => boolean,
  offset: number,
  limit: number,
): { data: T[]; total: number } {
  const authorized = rows.filter(isAuthorized);
  return { data: authorized.slice(offset, offset + limit), total: authorized.length };
}

export async function paginateAuthorizedBatches<T>(
  fetchBatch: (offset: number, limit: number) => Promise<readonly T[]>,
  isAuthorized: (row: T) => boolean,
  offset: number,
  limit: number,
  batchSize = 1_000,
): Promise<{ data: T[]; total: number }> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 5_000) {
    throw new Error("Invalid authorization batch size");
  }
  const data: T[] = [];
  let total = 0;
  let databaseOffset = 0;
  for (;;) {
    const rows = await fetchBatch(databaseOffset, batchSize);
    for (const row of rows) {
      if (!isAuthorized(row)) continue;
      if (total >= offset && data.length < limit) data.push(row);
      total++;
    }
    databaseOffset += rows.length;
    if (rows.length < batchSize) break;
  }
  return { data, total };
}

export const APPROVED_READYMODE_PROBE_PATHS = [
  "/",
  "/supervisor/",
  "/reporting/",
  "/report/",
] as const;

const readyModeProbePaths = new Set<string>(APPROVED_READYMODE_PROBE_PATHS);

export function approvedReadyModeProbePath(value: unknown): string | null {
  return typeof value === "string" && readyModeProbePaths.has(value) ? value : null;
}

const approvedVosDebugPaths = new Set([
  "/api/dashboard",
  "/api/agents",
  "/api/ring-groups",
  "/api/calls?limit=1",
]);

export function approvedVosDebugPath(value: unknown): string | null {
  return typeof value === "string" && approvedVosDebugPaths.has(value) ? value : null;
}

function defaultApprovedSheets(): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  for (const source of [
    OPERATIONAL_CONFIG.dashboardSheets.newRetention,
    OPERATIONAL_CONFIG.dashboardSheets.newNsf,
    OPERATIONAL_CONFIG.dashboardSheets.idpHandled,
    OPERATIONAL_CONFIG.dashboardSheets.idpCancelRetained,
    OPERATIONAL_CONFIG.readyModeSheet,
  ]) {
    const gids = result.get(source.spreadsheetId) ?? new Set<number>();
    gids.add(source.gid);
    result.set(source.spreadsheetId, gids);
  }
  return result;
}

export function parseSheetGid(value: unknown): number | null {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,9})$/.test(value)) return null;
  const gid = Number(value);
  return Number.isSafeInteger(gid) && gid >= 0 && gid <= 2_147_483_647 ? gid : null;
}

function sheetAllowlist(additionalSources: string | undefined): Map<string, Set<number>> {
  const result = defaultApprovedSheets();
  if (!additionalSources?.trim()) return result;

  for (const entry of additionalSources.split(",")) {
    const [rawId, rawGids, ...extra] = entry.split("=");
    const id = rawId?.trim() ?? "";
    if (extra.length > 0 || !SPREADSHEET_ID.test(id) || !rawGids?.trim()) {
      throw new Error("GOOGLE_SHEETS_ADDITIONAL_SOURCES is invalid.");
    }
    const gids = rawGids.split("|").map((value) => parseSheetGid(value.trim()));
    if (gids.some((gid) => gid === null)) {
      throw new Error("GOOGLE_SHEETS_ADDITIONAL_SOURCES is invalid.");
    }
    const allowed = result.get(id) ?? new Set<number>();
    for (const gid of gids) allowed.add(gid!);
    result.set(id, allowed);
  }
  return result;
}

export function isApprovedSheetSource(
  spreadsheetId: string,
  gid: number,
  additionalSources = process.env["GOOGLE_SHEETS_ADDITIONAL_SOURCES"],
): boolean {
  if (!SPREADSHEET_ID.test(spreadsheetId)) return false;
  return sheetAllowlist(additionalSources).get(spreadsheetId)?.has(gid) ?? false;
}
