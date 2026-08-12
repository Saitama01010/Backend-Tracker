export type SheetRow = Record<string, string>;

export type SheetPayload = {
  headers: string[];
  rows: SheetRow[];
  meta?: SheetFreshnessMeta;
};

export type SheetFreshnessMeta = {
  fetchedAt: string;
  observedAt: string;
  stale: boolean;
  refreshError: boolean;
  cache: "hit" | "miss" | "stale";
  rowsReceived: number;
  rowsAccepted: number;
  rowsSkipped: number;
};

function isSheetRow(value: unknown): value is SheetRow {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.values(value).every((cell) => typeof cell === "string");
}

function isSheetFreshnessMeta(value: unknown): value is SheetFreshnessMeta {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const meta = value as Record<string, unknown>;
  return typeof meta.fetchedAt === "string"
    && typeof meta.observedAt === "string"
    && typeof meta.stale === "boolean"
    && typeof meta.refreshError === "boolean"
    && (meta.cache === "hit" || meta.cache === "miss" || meta.cache === "stale")
    && typeof meta.rowsReceived === "number"
    && typeof meta.rowsAccepted === "number"
    && typeof meta.rowsSkipped === "number";
}

export function parseSheetPayload(value: unknown): SheetPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Google Sheets returned an invalid response.");
  }
  const payload = value as {
    format?: unknown;
    headers?: unknown;
    columns?: unknown;
    rows?: unknown;
    meta?: unknown;
  };
  if (!Array.isArray(payload.headers)
    || !payload.headers.every((header) => typeof header === "string")
    || !Array.isArray(payload.rows)) {
    throw new Error("Google Sheets returned an invalid response.");
  }
  if (payload.format === "rows-v1") {
    if (!Array.isArray(payload.columns)
      || !payload.columns.every((header) => typeof header === "string")
      || !payload.rows.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === "string"))
      || !isSheetFreshnessMeta(payload.meta)) {
      throw new Error("Google Sheets returned an invalid response.");
    }
    const columns = payload.columns as string[];
    const rows = (payload.rows as string[][]).map((cells) => {
      const row: SheetRow = {};
      const width = Math.max(columns.length, cells.length);
      for (let index = 0; index < width; index++) {
        const cell = cells[index] ?? "";
        const header = columns[index] ?? "";
        row[`__col${index}`] = cell;
        if (header) row[header] = cell;
      }
      return row;
    });
    return { headers: payload.headers, rows, meta: payload.meta };
  }
  if (!payload.rows.every(isSheetRow)) {
    throw new Error("Google Sheets returned an invalid response.");
  }
  return { headers: payload.headers, rows: payload.rows as SheetRow[] };
}

export async function readSheetResponse(response: Response): Promise<SheetPayload> {
  if (!response.ok) {
    throw new Error(`Failed to load Google Sheets data (HTTP ${response.status}).`);
  }
  try {
    return parseSheetPayload(await response.json());
  } catch (error) {
    if (error instanceof Error && error.message === "Google Sheets returned an invalid response.") {
      throw error;
    }
    throw new Error("Google Sheets returned an invalid response.");
  }
}

export type BackendStatsSheetSources = {
  retainedCancels: string;
  fixes: string;
  idpHandled: string;
  idpCancelRetained: string;
};

export async function loadBackendStatsSheetSources(
  fetchSource: (source: string) => Promise<SheetPayload>,
  sources: BackendStatsSheetSources,
): Promise<{
  retainedCancels: SheetPayload;
  fixes: SheetPayload;
  idpHandled: SheetPayload;
  idpCancelRetained: SheetPayload;
}> {
  const [retainedCancels, fixes, idpHandled, idpCancelRetained] = await Promise.all([
    fetchSource(sources.retainedCancels),
    fetchSource(sources.fixes),
    fetchSource(sources.idpHandled),
    fetchSource(sources.idpCancelRetained),
  ]);
  return { retainedCancels, fixes, idpHandled, idpCancelRetained };
}
