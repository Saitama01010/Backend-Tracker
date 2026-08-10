export type SheetRow = Record<string, string>;

export type SheetPayload = {
  headers: string[];
  rows: SheetRow[];
};

function isSheetRow(value: unknown): value is SheetRow {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.values(value).every((cell) => typeof cell === "string");
}

export function parseSheetPayload(value: unknown): SheetPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Google Sheets returned an invalid response.");
  }
  const payload = value as { headers?: unknown; rows?: unknown };
  if (!Array.isArray(payload.headers)
    || !payload.headers.every((header) => typeof header === "string")
    || !Array.isArray(payload.rows)
    || !payload.rows.every(isSheetRow)) {
    throw new Error("Google Sheets returned an invalid response.");
  }
  return { headers: payload.headers, rows: payload.rows };
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
  const [retainedCancels, fixes] = await Promise.all([
    fetchSource(sources.retainedCancels),
    fetchSource(sources.fixes),
  ]);
  // These tabs share the fixes spreadsheet, so retain the existing sequential
  // loading order while allowing any provider failure to reach React Query.
  const idpHandled = await fetchSource(sources.idpHandled);
  const idpCancelRetained = await fetchSource(sources.idpCancelRetained);
  return { retainedCancels, fixes, idpHandled, idpCancelRetained };
}
