import { performance } from "node:perf_hooks";

export type GoogleSheetData = { headers: string[]; rows: Record<string, string>[] };

export type GoogleSheetMapping = {
  data: GoogleSheetData;
  rawHeaders: string[];
  parseMs: number;
  rowsReceived: number;
  rowsAccepted: number;
  rowsSkipped: number;
};

function roundedMs(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeHeaderName(value: string): string {
  return value
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

export function parseGoogleSheetsValues(payload: unknown): unknown[][] {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("Invalid Google Sheets response");
  }
  const values = (payload as { values?: unknown }).values;
  if (values === undefined) return [];
  if (!Array.isArray(values) || !values.every(Array.isArray)) {
    throw new Error("Invalid Google Sheets response");
  }
  return values;
}

export function mapGoogleSheetValues(payload: unknown): GoogleSheetMapping {
  const parseStartedAt = performance.now();
  const values = parseGoogleSheetsValues(payload);
  const headerRowIndex = detectHeaderRow(values);
  const headerCells = (values[headerRowIndex] ?? []).map((header) => String(header ?? "").trim());
  const sourceWidth = values.slice(headerRowIndex + 1)
    .reduce((width, row) => Math.max(width, row.length), headerCells.length);
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
    parseMs: roundedMs(performance.now() - parseStartedAt),
    rowsReceived: Math.max(0, values.length - headerRowIndex - 1),
    rowsAccepted: rows.length,
    rowsSkipped,
  };
}
