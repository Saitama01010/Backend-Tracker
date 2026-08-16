import type { Logger } from "pino";

export type ReadyModeDayRow = {
  name: string;
  iso: string;
  dialed: number;
  talkSecs: number;
};

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { cur.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        cur.push(field); field = "";
        rows.push(cur); cur = [];
      } else field += c;
    }
  }
  if (field.length > 0 || cur.length > 0) { cur.push(field); rows.push(cur); }
  return rows.filter((row) => row.length > 1 || (row.length === 1 && row[0]!.trim()));
}

function parseDurationToSecs(value: string): number {
  if (!value || value === "-") return 0;
  let total = 0;
  const h = value.match(/(\d+)\s*hours?/i);
  const m = value.match(/(\d+)\s*min\./i);
  const sec = value.match(/([\d.]+)\s*s\./i);
  if (h?.[1]) total += parseInt(h[1], 10) * 3600;
  if (m?.[1]) total += parseInt(m[1], 10) * 60;
  if (sec?.[1]) total += parseFloat(sec[1]);
  return Math.round(total);
}

function parseIntSafe(value: string | undefined): number {
  if (!value || value === "-") return 0;
  const parsed = parseInt(value.replace(/[^0-9-]/g, ""), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function dayToIso(day: string, yearHint?: number): string | null {
  const trimmed = day.trim();
  if (!trimmed || trimmed === "-") return null;
  const match = trimmed.match(/^([A-Za-z]+)\s+(\d{1,2})$/);
  if (!match) return null;
  const month = MONTHS[match[1]!.slice(0, 3).toLowerCase()];
  if (!month) return null;
  const date = parseInt(match[2]!, 10);
  if (!date) return null;
  const year = yearHint ?? new Date().getFullYear();
  return `${year}-${String(month).padStart(2, "0")}-${String(date).padStart(2, "0")}`;
}

export function parseReadymodeRows(
  text: string,
  log: Logger,
  source: string,
  fallbackIso?: string,
): ReadyModeDayRow[] {
  const parsed = parseCsv(text);
  if (parsed.length < 2) return [];
  const header = parsed[0]!.map((value) => value.trim().toLowerCase());
  const idx = {
    day: header.findIndex((value) => value.includes("day") || value.includes("date")),
    name: header.findIndex((value) => value === "name" || value.includes("agent")),
    calls: header.findIndex((value) => value.includes("logged call") || value === "calls"),
    talk: header.findIndex((value) => value.includes("talk time")),
  };
  if (idx.name < 0 || idx.calls < 0) {
    log.warn({ source, header }, "readymode source missing required columns");
    return [];
  }
  const out: ReadyModeDayRow[] = [];
  for (const row of parsed.slice(1)) {
    const name = (row[idx.name] ?? "").trim();
    if (!name) continue;
    if (/^(summary|total)$/i.test(name)) continue;
    const dayRaw = idx.day >= 0 ? (row[idx.day] ?? "") : "";
    const iso = dayToIso(dayRaw) ?? fallbackIso ?? null;
    if (!iso) continue;
    out.push({
      name,
      iso,
      dialed: parseIntSafe(row[idx.calls]),
      talkSecs: idx.talk >= 0 ? parseDurationToSecs(row[idx.talk] ?? "") : 0,
    });
  }
  return out;
}
