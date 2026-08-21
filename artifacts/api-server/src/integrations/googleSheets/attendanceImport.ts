import { canonicalAttendanceStatus } from "../../lib/attendancePolicy.js";
import type { AttendanceImportCandidate } from "../../lib/databasePerformance.js";
import { googleCsvUrl, OPERATIONAL_CONFIG } from "../../lib/operationalConfig.js";
import { validateWorkflowCalendarDate } from "../../lib/sensitiveWorkflowPolicy.js";

export class AttendanceImportSourceError extends Error {}

const MONTH_MAP: Record<string, string> = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

export function parseAttendanceImportDate(
  raw: string,
  year = OPERATIONAL_CONFIG.attendanceImportYear,
): string | null {
  const match = raw.trim().match(/^(\d{1,2})-([A-Za-z]{3})$/);
  if (!match) return null;
  const month = MONTH_MAP[match[2]];
  if (!month) return null;
  const day = match[1].padStart(2, "0");
  const date = `${year}-${month}-${day}`;
  return validateWorkflowCalendarDate(date) ? date : null;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const cells: string[] = [];
    let current = "";
    let quoted = false;
    for (const character of line) {
      if (character === '"') quoted = !quoted;
      else if (character === "," && !quoted) {
        cells.push(current);
        current = "";
      } else current += character;
    }
    cells.push(current);
    rows.push(cells);
  }
  return rows;
}

export async function loadAttendanceImportCandidates(): Promise<AttendanceImportCandidate[]> {
  const sources = OPERATIONAL_CONFIG.attendanceImportSources.map((source) => ({
    url: googleCsvUrl(source),
    department: source.department,
  }));
  const sourceRows = await Promise.all(sources.map(async ({ url, department }) => {
    const response = await fetch(url);
    if (!response.ok) throw new AttendanceImportSourceError();
    const rows = parseCsv(await response.text());
    if (rows.length < 2 || rows[0]!.length < 3) throw new AttendanceImportSourceError();
    return { rows, department };
  }));

  const candidates: AttendanceImportCandidate[] = [];
  for (const { rows, department } of sourceRows) {
    const header = rows[0]!;
    const dateIndices: { idx: number; iso: string }[] = [];
    for (let index = 2; index < header.length; index++) {
      const iso = parseAttendanceImportDate(header[index] ?? "");
      if (iso) dateIndices.push({ idx: index, iso });
    }
    if (dateIndices.length === 0) throw new AttendanceImportSourceError();

    for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex]!;
      const shift = row[0]?.trim() ?? "";
      const name = row[1]?.trim() ?? "";
      if (!name || !shift || shift === '"' || name.toUpperCase() === "NA" || !/^\d+$/.test(shift)) continue;

      const records: Array<{ date: string; status: string }> = [];
      for (const { idx, iso } of dateIndices) {
        const rawStatus = row[idx]?.trim() ?? "";
        if (!rawStatus) continue;
        const status = canonicalAttendanceStatus(rawStatus);
        if (!status) throw new AttendanceImportSourceError();
        records.push({ date: iso, status });
      }
      candidates.push({ name, shift, department, records });
    }
  }
  return candidates;
}
