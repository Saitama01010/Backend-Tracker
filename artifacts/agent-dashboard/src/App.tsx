import { QueryClient, QueryClientProvider, useQueries } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import Papa from "papaparse";
import { Fragment, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  RefreshCw,
  Rocket,
  Search,
  Calendar,
  Phone,
  Clock,
  Users,
} from "lucide-react";

const queryClient = new QueryClient();

const RETENTION = {
  status: "https://docs.google.com/spreadsheets/d/1qF5Dc5quGrAywf5Rtx4q7DrX91VlNIFOfKr-REoSkII/export?format=csv&gid=0",
  calls: "https://docs.google.com/spreadsheets/d/1qF5Dc5quGrAywf5Rtx4q7DrX91VlNIFOfKr-REoSkII/export?format=csv&gid=1502000110",
};
const NSF = {
  status: "https://docs.google.com/spreadsheets/d/16qoZESE0gGQPdOXQUSh2JsadWDmUE7OyCajRwBy0E38/export?format=csv&gid=0",
  calls: "https://docs.google.com/spreadsheets/d/16qoZESE0gGQPdOXQUSh2JsadWDmUE7OyCajRwBy0E38/export?format=csv&gid=1820789434",
};

type Row = Record<string, string>;
type SheetData = { headers: string[]; rows: Row[] };
type Matrix = string[][];

async function fetchHeaderCsv(url: string): Promise<SheetData> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load sheet (HTTP ${res.status}).`);
  const text = await res.text();
  const parsed = Papa.parse<Row>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });
  const headers = (parsed.meta.fields ?? []).filter((h) => h && h.length > 0);
  const rows = (parsed.data ?? []).filter((r) =>
    headers.some((h) => (r[h] ?? "").toString().trim() !== ""),
  );
  return { headers, rows };
}

async function fetchMatrixCsv(url: string): Promise<Matrix> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load sheet (HTTP ${res.status}).`);
  const text = await res.text();
  const parsed = Papa.parse<string[]>(text, { header: false });
  return (parsed.data ?? []) as string[][];
}

function findColumn(headers: string[], candidates: string[]): string | null {
  const lower = headers.map((h) => h.toLowerCase().trim());
  for (const c of candidates) {
    const idx = lower.indexOf(c.toLowerCase().trim());
    if (idx >= 0) return headers[idx];
  }
  return null;
}

const NAME_ALIASES: Record<string, string> = {
  "kaite miller": "katie miller",
};
const NAME_DISPLAY: Record<string, string> = {
  "katie miller": "Katie Miller",
};
function normalizeAgent(s: string): string {
  const base = s.replace(/\s+/g, " ").trim().toLowerCase();
  return NAME_ALIASES[base] ?? base;
}

function parseDate(s: string): Date | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(trimmed);
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return isNaN(d.getTime()) ? null : d;
  }
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(trimmed);
  if (us) {
    let year = Number(us[3]);
    if (year < 100) year += 2000;
    const d = new Date(year, Number(us[1]) - 1, Number(us[2]));
    return isNaN(d.getTime()) ? null : d;
  }
  const fallback = new Date(trimmed);
  return isNaN(fallback.getTime()) ? null : fallback;
}

function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function parseDuration(s: string): number {
  if (!s) return 0;
  const trimmed = s.trim();
  if (!trimmed) return 0;
  const parts = trimmed.split(":").map((p) => Number(p.trim()));
  if (parts.some((p) => isNaN(p))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 3600 + parts[1] * 60;
  return parts[0] * 60;
}

function formatDuration(sec: number): string {
  if (!sec) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatHours(sec: number): string {
  if (!sec) return "0h";
  const h = sec / 3600;
  return h >= 10 ? `${Math.round(h)}h` : `${h.toFixed(1)}h`;
}

// ---------- Calls parsing ----------

type CallEntry = { calls: number; seconds: number };
// agent -> isoDate -> { calls, seconds }
type CallsByAgent = Map<string, Map<string, CallEntry>>;

function parseRetentionCalls(rows: Matrix): CallsByAgent {
  const out: CallsByAgent = new Map();
  if (rows.length === 0) return out;
  // Find date row: first row whose cells from col 1 contain at least one parseable date
  let dateRowIdx = -1;
  let dateCols: { col: number; iso: string }[] = [];
  for (let i = 0; i < Math.min(rows.length, 6); i++) {
    const cols: { col: number; iso: string }[] = [];
    for (let j = 1; j < rows[i].length; j++) {
      const d = parseDate(rows[i][j] ?? "");
      if (d) cols.push({ col: j, iso: toIsoDate(d) });
    }
    if (cols.length >= 1) {
      dateRowIdx = i;
      dateCols = cols;
      break;
    }
  }
  if (dateRowIdx < 0) return out;
  for (let r = dateRowIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    const agent = (row[0] ?? "").trim();
    if (!agent) continue;
    if (/^total$/i.test(agent) || /^grand total/i.test(agent)) continue;
    const m = new Map<string, CallEntry>();
    for (const { col, iso } of dateCols) {
      const v = (row[col] ?? "").trim();
      if (v && !isNaN(Number(v))) {
        m.set(iso, { calls: Number(v), seconds: 0 });
      }
    }
    if (m.size > 0) out.set(agent, m);
  }
  return out;
}

function parseNsfCalls(rows: Matrix): CallsByAgent {
  const out: CallsByAgent = new Map();
  if (rows.length === 0) return out;
  const header = rows[0];

  // Calls section: agent names start at col 2 until empty cell
  const callsAgentCols: { col: number; agent: string }[] = [];
  for (let i = 2; i < header.length; i++) {
    const v = (header[i] ?? "").trim();
    if (!v) break;
    if (/^time on calls/i.test(v)) break;
    callsAgentCols.push({ col: i, agent: v });
  }
  // Find time section start
  const timeLabelIdx = header.findIndex((h, i) => i > 0 && /^time on calls/i.test((h ?? "").trim()));
  const timeAgentCols: { col: number; agent: string }[] = [];
  let timeDateCol = -1;
  if (timeLabelIdx >= 0) {
    timeDateCol = timeLabelIdx + 1;
    for (let i = timeLabelIdx + 2; i < header.length; i++) {
      const v = (header[i] ?? "").trim();
      if (!v) continue;
      timeAgentCols.push({ col: i, agent: v });
    }
  }

  const ensure = (agent: string, iso: string) => {
    if (!out.has(agent)) out.set(agent, new Map());
    const m = out.get(agent)!;
    if (!m.has(iso)) m.set(iso, { calls: 0, seconds: 0 });
    return m.get(iso)!;
  };

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length === 0) continue;
    // Calls dates live in col 1
    const callsDate = parseDate(row[1] ?? "");
    if (callsDate) {
      const iso = toIsoDate(callsDate);
      for (const { col, agent } of callsAgentCols) {
        const v = (row[col] ?? "").trim();
        if (v && !isNaN(Number(v))) {
          ensure(agent, iso).calls += Number(v);
        }
      }
    }
    if (timeDateCol >= 0) {
      const timeDate = parseDate(row[timeDateCol] ?? "");
      if (timeDate) {
        const iso = toIsoDate(timeDate);
        for (const { col, agent } of timeAgentCols) {
          const v = (row[col] ?? "").trim();
          const sec = parseDuration(v);
          if (sec > 0) {
            ensure(agent, iso).seconds += sec;
          }
        }
      }
    }
  }
  return out;
}

// ---------- Aggregation ----------

type TeamMode = "retention" | "nsf";

type DayBreakdown = {
  iso: string;
  date: Date;
  calls: number;
  seconds: number;
  byStatus: Map<string, number>;
  total: number;
};

type AgentBreakdown = {
  agent: string;
  calls: number;
  seconds: number;
  byStatus: Map<string, number>;
  total: number;
};

type Aggregated = {
  mode: TeamMode;
  statusColumn: string;
  agentColumn: string;
  dateColumn: string | null;
  statuses: string[];
  retainedStatuses: Set<string>;
  byDay: DayBreakdown[];
  byAgent: AgentBreakdown[];
  totals: {
    calls: number;
    seconds: number;
    byStatus: Map<string, number>;
    grand: number;
    agents: number;
    retained: number;
  };
  todayRetained: number;
  monthRetained: number;
  totalRowCount: number;
  filteredRowCount: number;
  minDate: Date | null;
  maxDate: Date | null;
};

function isRetainedStatus(s: string): boolean {
  const lower = s.toLowerCase();
  return /retain/.test(lower) || /\bidp\b/.test(lower);
}

function retentionRate(retained: number, total: number): string {
  if (!total) return "—";
  return `${((retained / total) * 100).toFixed(1)}%`;
}

function aggregate(
  status: SheetData,
  calls: CallsByAgent,
  mode: TeamMode,
  fromDate: Date | null,
  toDate: Date | null,
): Aggregated | { error: string } {
  const agentColumn = findColumn(status.headers, ["Agent", "Agent Name", "Rep"]);
  const statusColumn = findColumn(status.headers, ["Status", "Result", "Outcome", "Disposition"]);
  const dateColumn = findColumn(status.headers, ["Date", "Day", "Call Date"]);
  if (!agentColumn) return { error: `Couldn't find "Agent" column.` };
  if (!statusColumn) return { error: `Couldn't find "Status" column.` };

  // Determine global date range from BOTH sources for the filter UI
  let minDate: Date | null = null;
  let maxDate: Date | null = null;
  const consider = (d: Date) => {
    if (!minDate || d < minDate) minDate = d;
    if (!maxDate || d > maxDate) maxDate = d;
  };
  if (dateColumn) {
    for (const r of status.rows) {
      const d = parseDate(r[dateColumn] ?? "");
      if (d) consider(d);
    }
  }
  for (const m of calls.values()) {
    for (const iso of m.keys()) {
      const d = parseDate(iso);
      if (d) consider(d);
    }
  }

  const inRange = (d: Date) => {
    if (fromDate && d < fromDate) return false;
    if (toDate && d > toDate) return false;
    return true;
  };

  // Filter status rows
  const filteredStatus = status.rows.filter((r) => {
    const agent = (r[agentColumn] ?? "").trim();
    if (!agent) return false;
    if (/total$/i.test(agent)) return false;
    if (dateColumn && (fromDate || toDate)) {
      const d = parseDate(r[dateColumn] ?? "");
      if (!d) return false;
      if (!inRange(d)) return false;
    }
    return true;
  });

  // Build status counts
  // For NSF mode, collapse every record to "Fixed"
  const allStatuses = new Set<string>();
  const dayMap = new Map<string, DayBreakdown>();
  const agentMap = new Map<string, AgentBreakdown>();
  const totalsByStatus = new Map<string, number>();

  const ensureDay = (iso: string, d: Date): DayBreakdown => {
    if (!dayMap.has(iso)) {
      dayMap.set(iso, {
        iso,
        date: d,
        calls: 0,
        seconds: 0,
        byStatus: new Map(),
        total: 0,
      });
    }
    return dayMap.get(iso)!;
  };
  const ensureAgent = (a: string): AgentBreakdown => {
    const key = normalizeAgent(a);
    if (!key) return { agent: "", calls: 0, seconds: 0, byStatus: new Map(), total: 0 };
    if (!agentMap.has(key)) {
      agentMap.set(key, {
        agent: NAME_DISPLAY[key] ?? a.replace(/\s+/g, " ").trim(),
        calls: 0,
        seconds: 0,
        byStatus: new Map(),
        total: 0,
      });
    }
    return agentMap.get(key)!;
  };

  for (const r of filteredStatus) {
    const agent = (r[agentColumn] ?? "").trim();
    const rawStatus = (r[statusColumn] ?? "").trim() || "(blank)";
    const status = mode === "nsf" ? "Fixed" : rawStatus;
    allStatuses.add(status);
    const ag = ensureAgent(agent);
    ag.byStatus.set(status, (ag.byStatus.get(status) ?? 0) + 1);
    ag.total += 1;
    totalsByStatus.set(status, (totalsByStatus.get(status) ?? 0) + 1);
    if (dateColumn) {
      const d = parseDate(r[dateColumn] ?? "");
      if (d) {
        const day = ensureDay(toIsoDate(d), d);
        day.byStatus.set(status, (day.byStatus.get(status) ?? 0) + 1);
        day.total += 1;
      }
    }
  }

  // Apply calls
  for (const [agent, perDate] of calls.entries()) {
    for (const [iso, entry] of perDate.entries()) {
      const d = parseDate(iso);
      if (!d) continue;
      if (!inRange(d)) continue;
      const ag = ensureAgent(agent);
      ag.calls += entry.calls;
      ag.seconds += entry.seconds;
      const day = ensureDay(iso, d);
      day.calls += entry.calls;
      day.seconds += entry.seconds;
    }
  }

  const statuses = Array.from(allStatuses).sort((a, b) => {
    const ta = totalsByStatus.get(a) ?? 0;
    const tb = totalsByStatus.get(b) ?? 0;
    if (ta !== tb) return tb - ta;
    return a.localeCompare(b);
  });

  const byDay = Array.from(dayMap.values()).sort(
    (a, b) => a.date.getTime() - b.date.getTime(),
  );
  const byAgent = Array.from(agentMap.values()).sort((a, b) =>
    a.agent.localeCompare(b.agent),
  );

  const totalCalls = byAgent.reduce((s, a) => s + a.calls, 0);
  const totalSeconds = byAgent.reduce((s, a) => s + a.seconds, 0);
  const grand = byAgent.reduce((s, a) => s + a.total, 0);
  const retainedStatuses = new Set(statuses.filter(isRetainedStatus));
  const totalRetained = Array.from(retainedStatuses).reduce(
    (s, st) => s + (totalsByStatus.get(st) ?? 0),
    0,
  );

  let todayRetained = 0;
  let monthRetained = 0;
  if (dateColumn) {
    const now = new Date();
    const todayIso = toIsoDate(now);
    const monthYear = now.getFullYear();
    const monthMonth = now.getMonth();
    for (const r of status.rows) {
      const d = parseDate(r[dateColumn] ?? "");
      if (!d) continue;
      const rawStatus = (r[statusColumn] ?? "").trim();
      if (!isRetainedStatus(rawStatus)) continue;
      if (toIsoDate(d) === todayIso) todayRetained += 1;
      if (d.getFullYear() === monthYear && d.getMonth() === monthMonth) monthRetained += 1;
    }
  }

  return {
    mode,
    agentColumn,
    statusColumn,
    dateColumn,
    statuses,
    retainedStatuses,
    byDay,
    byAgent,
    totals: {
      calls: totalCalls,
      seconds: totalSeconds,
      byStatus: totalsByStatus,
      grand,
      agents: byAgent.length,
      retained: totalRetained,
    },
    todayRetained,
    monthRetained,
    totalRowCount: status.rows.length,
    filteredRowCount: filteredStatus.length,
    minDate,
    maxDate,
  };
}

// ---------- UI ----------

function StatTile({
  label,
  value,
  icon,
  accent,
}: {
  label: string;
  value: number | string;
  icon?: React.ReactNode;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-4 ${accent ? "bg-primary/5 border-primary/20" : "bg-card"}`}
    >
      <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-1 text-2xl font-bold tabular-nums font-mono">{value}</div>
    </div>
  );
}

type SortState = { column: string; dir: "asc" | "desc" } | null;

function SortHeader({
  id,
  label,
  align = "left",
  sort,
  onToggle,
}: {
  id: string;
  label: string;
  align?: "left" | "right";
  sort: SortState;
  onToggle: (id: string) => void;
}) {
  const active = sort?.column === id;
  return (
    <button
      type="button"
      onClick={() => onToggle(id)}
      className={`inline-flex items-center gap-1.5 font-semibold text-foreground hover-elevate active-elevate-2 px-2 py-1 -mx-2 rounded-md ${align === "right" ? "flex-row-reverse" : ""}`}
      data-testid={`button-sort-${id}`}
    >
      <span>{label}</span>
      {!active && <ArrowUpDown className="h-3.5 w-3.5 opacity-50" />}
      {active && sort?.dir === "asc" && <ArrowUp className="h-3.5 w-3.5" />}
      {active && sort?.dir === "desc" && <ArrowDown className="h-3.5 w-3.5" />}
    </button>
  );
}

function startOfWeek(d: Date): Date {
  // Group week as Monday–Sunday (Sunday is the closing day, like the old sheet)
  const day = d.getDay(); // 0=Sun..6=Sat
  const offset = day === 0 ? -6 : 1 - day; // back to Monday
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset);
  return start;
}

function sumRetained(byStatus: Map<string, number>, retained: Set<string>): number {
  let n = 0;
  for (const s of retained) n += byStatus.get(s) ?? 0;
  return n;
}

function ByDayView({ data }: { data: Aggregated }) {
  const showRate = data.mode === "retention";
  // Group days into weeks (Mon–Sun) and emit a subtotal row at the end of each week
  type WeekGroup = { weekStart: Date; days: DayBreakdown[] };
  const weeks: WeekGroup[] = [];
  for (const day of data.byDay) {
    const ws = startOfWeek(day.date);
    const wsTime = ws.getTime();
    let group = weeks[weeks.length - 1];
    if (!group || group.weekStart.getTime() !== wsTime) {
      group = { weekStart: ws, days: [] };
      weeks.push(group);
    }
    group.days.push(day);
  }

  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <div className="overflow-x-auto max-h-[65vh]">
        <Table>
          <TableHeader className="sticky top-0 bg-muted/80 backdrop-blur z-10">
            <TableRow>
              <TableHead className="whitespace-nowrap">Day</TableHead>
              <TableHead className="whitespace-nowrap">Date</TableHead>
              <TableHead className="text-right whitespace-nowrap">Calls</TableHead>
              <TableHead className="text-right whitespace-nowrap">Time on calls</TableHead>
              {data.statuses.map((s) => (
                <TableHead key={s} className="text-right whitespace-nowrap">
                  {s}
                </TableHead>
              ))}
              <TableHead className="text-right whitespace-nowrap bg-primary/5">Total</TableHead>
              {showRate && (
                <TableHead className="text-right whitespace-nowrap bg-primary/10">Retention rate</TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {weeks.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={data.statuses.length + 5 + (showRate ? 1 : 0)}
                  className="text-center py-12 text-muted-foreground"
                >
                  No data for the selected date range.
                </TableCell>
              </TableRow>
            )}
            {weeks.map((week, wi) => {
              const subtotal = week.days.reduce(
                (acc, d) => {
                  acc.calls += d.calls;
                  acc.seconds += d.seconds;
                  acc.total += d.total;
                  for (const [s, n] of d.byStatus) {
                    acc.byStatus.set(s, (acc.byStatus.get(s) ?? 0) + n);
                  }
                  return acc;
                },
                {
                  calls: 0,
                  seconds: 0,
                  total: 0,
                  byStatus: new Map<string, number>(),
                },
              );
              const weekEnd = new Date(week.weekStart);
              weekEnd.setDate(weekEnd.getDate() + 6);
              return (
                <Fragment key={`week-frag-${wi}`}>
                  {week.days.map((d) => (
                    <TableRow key={d.iso} className="hover-elevate">
                      <TableCell className="font-medium whitespace-nowrap">
                        {DAY_NAMES[d.date.getDay()]}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground tabular-nums">
                        {d.date.toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-mono">
                        {d.calls || ""}
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-mono">
                        {formatDuration(d.seconds)}
                      </TableCell>
                      {data.statuses.map((s) => {
                        const v = d.byStatus.get(s) ?? 0;
                        return (
                          <TableCell
                            key={s}
                            className={`text-right tabular-nums font-mono ${v === 0 ? "text-muted-foreground/40" : ""}`}
                          >
                            {v}
                          </TableCell>
                        );
                      })}
                      <TableCell className="text-right tabular-nums font-mono font-semibold bg-primary/5">
                        {d.total || ""}
                      </TableCell>
                      {showRate && (
                        <TableCell className="text-right tabular-nums font-mono font-semibold bg-primary/10">
                          {retentionRate(sumRetained(d.byStatus, data.retainedStatuses), d.total)}
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                  <TableRow key={`week-${wi}`} className="bg-accent/40 font-semibold">
                    <TableCell className="whitespace-nowrap">Week of</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground tabular-nums">
                      {week.weekStart.toLocaleDateString()} – {weekEnd.toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-mono">
                      {subtotal.calls || ""}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-mono">
                      {formatDuration(subtotal.seconds)}
                    </TableCell>
                    {data.statuses.map((s) => (
                      <TableCell key={s} className="text-right tabular-nums font-mono">
                        {subtotal.byStatus.get(s) ?? 0}
                      </TableCell>
                    ))}
                    <TableCell className="text-right tabular-nums font-mono bg-primary/10">
                      {subtotal.total}
                    </TableCell>
                    {showRate && (
                      <TableCell className="text-right tabular-nums font-mono bg-primary/10">
                        {retentionRate(sumRetained(subtotal.byStatus, data.retainedStatuses), subtotal.total)}
                      </TableCell>
                    )}
                  </TableRow>
                </Fragment>
              );
            })}
          </TableBody>
          {data.byDay.length > 0 && (
            <TableHeader className="sticky bottom-0 bg-muted/80 backdrop-blur z-10">
              <TableRow>
                <TableCell className="font-bold">Total</TableCell>
                <TableCell></TableCell>
                <TableCell className="text-right tabular-nums font-mono font-bold">
                  {data.totals.calls}
                </TableCell>
                <TableCell className="text-right tabular-nums font-mono font-bold">
                  {formatDuration(data.totals.seconds)}
                </TableCell>
                {data.statuses.map((s) => (
                  <TableCell
                    key={s}
                    className="text-right tabular-nums font-mono font-bold"
                  >
                    {data.totals.byStatus.get(s) ?? 0}
                  </TableCell>
                ))}
                <TableCell className="text-right tabular-nums font-mono font-bold bg-primary/10">
                  {data.totals.grand}
                </TableCell>
                {showRate && (
                  <TableCell className="text-right tabular-nums font-mono font-bold bg-primary/10">
                    {retentionRate(data.totals.retained, data.totals.grand)}
                  </TableCell>
                )}
              </TableRow>
            </TableHeader>
          )}
        </Table>
      </div>
    </div>
  );
}

function ByAgentView({ data }: { data: Aggregated }) {
  const showRate = data.mode === "retention";
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortState>({ column: "__total__", dir: "desc" });

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = data.byAgent;
    if (q) list = list.filter((a) => a.agent.toLowerCase().includes(q));
    if (sort) {
      list = [...list].sort((a, b) => {
        let av: number | string;
        let bv: number | string;
        if (sort.column === "__agent__") {
          av = a.agent;
          bv = b.agent;
        } else if (sort.column === "__total__") {
          av = a.total;
          bv = b.total;
        } else if (sort.column === "__calls__") {
          av = a.calls;
          bv = b.calls;
        } else if (sort.column === "__time__") {
          av = a.seconds;
          bv = b.seconds;
        } else if (sort.column === "__rate__") {
          av = a.total ? sumRetained(a.byStatus, data.retainedStatuses) / a.total : -1;
          bv = b.total ? sumRetained(b.byStatus, data.retainedStatuses) / b.total : -1;
        } else {
          av = a.byStatus.get(sort.column) ?? 0;
          bv = b.byStatus.get(sort.column) ?? 0;
        }
        if (typeof av === "number" && typeof bv === "number") {
          return sort.dir === "asc" ? av - bv : bv - av;
        }
        const cmp = String(av).localeCompare(String(bv));
        return sort.dir === "asc" ? cmp : -cmp;
      });
    }
    return list;
  }, [data, search, sort]);

  function toggle(column: string) {
    setSort((prev) => {
      if (!prev || prev.column !== column) {
        return { column, dir: column === "__agent__" ? "asc" : "desc" };
      }
      if (prev.dir === "desc") return { column, dir: "asc" };
      return null;
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="relative w-full sm:max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search agents…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
            data-testid="input-search-agent"
          />
        </div>
        <Badge variant="secondary" className="font-mono w-fit">
          {visible.length} of {data.byAgent.length} agents
        </Badge>
      </div>

      <div className="rounded-lg border bg-card overflow-hidden">
        <div className="overflow-x-auto max-h-[65vh]">
          <Table>
            <TableHeader className="sticky top-0 bg-muted/80 backdrop-blur z-10">
              <TableRow>
                <TableHead className="whitespace-nowrap min-w-[200px]">
                  <SortHeader id="__agent__" label="Agent" sort={sort} onToggle={toggle} />
                </TableHead>
                <TableHead className="whitespace-nowrap text-right">
                  <SortHeader id="__calls__" label="Calls" align="right" sort={sort} onToggle={toggle} />
                </TableHead>
                <TableHead className="whitespace-nowrap text-right">
                  <SortHeader id="__time__" label="Time on calls" align="right" sort={sort} onToggle={toggle} />
                </TableHead>
                {data.statuses.map((s) => (
                  <TableHead key={s} className="whitespace-nowrap text-right">
                    <SortHeader id={s} label={s} align="right" sort={sort} onToggle={toggle} />
                  </TableHead>
                ))}
                <TableHead className="whitespace-nowrap text-right bg-primary/5">
                  <SortHeader id="__total__" label="Total" align="right" sort={sort} onToggle={toggle} />
                </TableHead>
                {showRate && (
                  <TableHead className="whitespace-nowrap text-right bg-primary/10">
                    <SortHeader id="__rate__" label="Retention rate" align="right" sort={sort} onToggle={toggle} />
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={data.statuses.length + 4 + (showRate ? 1 : 0)}
                    className="text-center py-12 text-muted-foreground"
                  >
                    No agents match the current filters.
                  </TableCell>
                </TableRow>
              )}
              {visible.map((a) => (
                <TableRow key={a.agent} className="hover-elevate">
                  <TableCell className="font-medium whitespace-nowrap">{a.agent}</TableCell>
                  <TableCell
                    className={`text-right tabular-nums font-mono ${a.calls === 0 ? "text-muted-foreground/40" : ""}`}
                  >
                    {a.calls}
                  </TableCell>
                  <TableCell
                    className={`text-right tabular-nums font-mono ${a.seconds === 0 ? "text-muted-foreground/40" : ""}`}
                  >
                    {formatDuration(a.seconds)}
                  </TableCell>
                  {data.statuses.map((s) => {
                    const v = a.byStatus.get(s) ?? 0;
                    return (
                      <TableCell
                        key={s}
                        className={`text-right tabular-nums font-mono ${v === 0 ? "text-muted-foreground/40" : ""}`}
                      >
                        {v}
                      </TableCell>
                    );
                  })}
                  <TableCell className="text-right tabular-nums font-mono font-semibold bg-primary/5">
                    {a.total}
                  </TableCell>
                  {showRate && (
                    <TableCell className="text-right tabular-nums font-mono font-semibold bg-primary/10">
                      {retentionRate(sumRetained(a.byStatus, data.retainedStatuses), a.total)}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
            {visible.length > 0 && (
              <TableHeader className="sticky bottom-0 bg-muted/80 backdrop-blur z-10">
                <TableRow>
                  <TableCell className="font-bold whitespace-nowrap">Whole team</TableCell>
                  <TableCell className="text-right tabular-nums font-mono font-bold">
                    {data.totals.calls}
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-mono font-bold">
                    {formatDuration(data.totals.seconds)}
                  </TableCell>
                  {data.statuses.map((s) => (
                    <TableCell
                      key={s}
                      className="text-right tabular-nums font-mono font-bold"
                    >
                      {data.totals.byStatus.get(s) ?? 0}
                    </TableCell>
                  ))}
                  <TableCell className="text-right tabular-nums font-mono font-bold bg-primary/10">
                    {data.totals.grand}
                  </TableCell>
                  {showRate && (
                    <TableCell className="text-right tabular-nums font-mono font-bold bg-primary/10">
                      {retentionRate(data.totals.retained, data.totals.grand)}
                    </TableCell>
                  )}
                </TableRow>
              </TableHeader>
            )}
          </Table>
        </div>
      </div>
    </div>
  );
}

function DateFilters({
  minDate,
  maxDate,
  from,
  to,
  setFrom,
  setTo,
  onReset,
}: {
  minDate: Date | null;
  maxDate: Date | null;
  from: string;
  to: string;
  setFrom: (s: string) => void;
  setTo: (s: string) => void;
  onReset: () => void;
}) {
  const minIso = minDate ? toIsoDate(minDate) : undefined;
  const maxIso = maxDate ? toIsoDate(maxDate) : undefined;
  return (
    <div className="flex flex-col sm:flex-row sm:items-end gap-3 flex-wrap">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Calendar className="h-4 w-4" />
        <span className="text-sm font-medium">Date range</span>
      </div>
      <div className="space-y-1">
        <Label htmlFor="from" className="text-xs text-muted-foreground">From</Label>
        <Input
          id="from"
          type="date"
          value={from}
          min={minIso}
          max={maxIso}
          onChange={(e) => setFrom(e.target.value)}
          className="w-[170px]"
          data-testid="input-from"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="to" className="text-xs text-muted-foreground">To</Label>
        <Input
          id="to"
          type="date"
          value={to}
          min={minIso}
          max={maxIso}
          onChange={(e) => setTo(e.target.value)}
          className="w-[170px]"
          data-testid="input-to"
        />
      </div>
      <div className="flex gap-2 flex-wrap">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            const today = toIsoDate(new Date());
            setFrom(today);
            setTo(today);
          }}
          data-testid="button-today"
        >
          Today
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            const now = new Date();
            const start = new Date(now.getFullYear(), now.getMonth(), 1);
            const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
            setFrom(toIsoDate(start));
            setTo(toIsoDate(end));
          }}
          data-testid="button-this-month"
        >
          This month
        </Button>
        {minDate && maxDate && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setFrom(toIsoDate(minDate));
              setTo(toIsoDate(maxDate));
            }}
            data-testid="button-all-time"
          >
            All time
          </Button>
        )}
        <Button type="button" variant="ghost" size="sm" onClick={onReset} data-testid="button-clear">
          Clear
        </Button>
      </div>
      {minDate && maxDate && (
        <span className="text-xs text-muted-foreground sm:ml-auto">
          Sheet covers {minDate.toLocaleDateString()} – {maxDate.toLocaleDateString()}
        </span>
      )}
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-10 w-64" />
      <div className="space-y-2 rounded-lg border p-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center space-y-3">
      <p className="text-sm text-destructive font-medium">{message}</p>
      <Button variant="outline" onClick={onRetry} data-testid="button-retry">
        <RefreshCw className="h-4 w-4 mr-2" />
        Try again
      </Button>
    </div>
  );
}

function TeamPanel({
  urls,
  sheetKey,
  label,
  mode,
}: {
  urls: { status: string; calls: string };
  sheetKey: string;
  label: string;
  mode: TeamMode;
}) {
  const results = useQueries({
    queries: [
      {
        queryKey: ["status", sheetKey],
        queryFn: () => fetchHeaderCsv(urls.status),
        staleTime: 1000 * 60 * 2,
        refetchOnWindowFocus: false,
      },
      {
        queryKey: ["calls", sheetKey],
        queryFn: () => fetchMatrixCsv(urls.calls),
        staleTime: 1000 * 60 * 2,
        refetchOnWindowFocus: false,
      },
    ],
  });
  const statusQ = results[0];
  const callsQ = results[1];
  const isLoading = statusQ.isLoading || callsQ.isLoading;
  const isFetching = statusQ.isFetching || callsQ.isFetching;
  const error = statusQ.error || callsQ.error;

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const fromDate = from ? parseDate(from) : null;
  const toDate = to ? parseDate(to) : null;
  if (toDate) toDate.setHours(23, 59, 59, 999);

  const aggregated = useMemo(() => {
    if (!statusQ.data) return null;
    const callsParsed = callsQ.data
      ? mode === "retention"
        ? parseRetentionCalls(callsQ.data)
        : parseNsfCalls(callsQ.data)
      : new Map<string, Map<string, CallEntry>>();
    return aggregate(statusQ.data, callsParsed, mode, fromDate, toDate);
  }, [statusQ.data, callsQ.data, mode, from, to]);

  function refresh() {
    statusQ.refetch();
    callsQ.refetch();
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0 gap-4">
        <div>
          <CardTitle className="text-xl">{label}</CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Calls, time, and outcomes · live from Google Sheets · cached for 30 min
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={refresh}
          disabled={isFetching}
          data-testid="button-refresh"
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading && <TableSkeleton />}
        {error && (
          <ErrorState
            message={error instanceof Error ? error.message : "Failed to load data."}
            onRetry={refresh}
          />
        )}
        {aggregated && "error" in aggregated && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {aggregated.error}
          </div>
        )}
        {aggregated && !("error" in aggregated) && (
          <>
            <DateFilters
              minDate={aggregated.minDate}
              maxDate={aggregated.maxDate}
              from={from}
              to={to}
              setFrom={setFrom}
              setTo={setTo}
              onReset={() => {
                setFrom("");
                setTo("");
              }}
            />

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatTile label="Agents" value={aggregated.totals.agents} icon={<Users className="h-3.5 w-3.5" />} />
              <StatTile
                label="Total calls"
                value={aggregated.totals.calls.toLocaleString()}
                icon={<Phone className="h-3.5 w-3.5" />}
              />
              <StatTile
                label="Time on calls"
                value={formatHours(aggregated.totals.seconds)}
                icon={<Clock className="h-3.5 w-3.5" />}
              />
              {mode === "nsf" ? (
                <StatTile
                  label="Total fixed"
                  value={aggregated.totals.grand.toLocaleString()}
                  accent
                />
              ) : (
                <>
                  <StatTile
                    label="Today's retains"
                    value={aggregated.todayRetained.toLocaleString()}
                    accent
                  />
                  <StatTile
                    label="This month's retains"
                    value={aggregated.monthRetained.toLocaleString()}
                    accent
                  />
                  <StatTile
                    label="Retention rate"
                    value={retentionRate(aggregated.totals.retained, aggregated.totals.grand)}
                    accent
                  />
                </>
              )}
            </div>

            <Tabs defaultValue="day" className="space-y-4">
              <TabsList>
                <TabsTrigger value="day" data-testid="subtab-day">By day</TabsTrigger>
                <TabsTrigger value="agent" data-testid="subtab-agent">By agent</TabsTrigger>
              </TabsList>
              <TabsContent value="day">
                <ByDayView data={aggregated} />
              </TabsContent>
              <TabsContent value="agent">
                <ByAgentView data={aggregated} />
              </TabsContent>
            </Tabs>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Dashboard() {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="max-w-[1400px] mx-auto px-6 py-5 flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-primary text-primary-foreground flex items-center justify-center">
            <Rocket className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight">Agent Performance Dashboard</h1>
            <p className="text-sm text-muted-foreground">Retention &amp; NSF team metrics at a glance</p>
          </div>
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto px-6 py-8">
        <Tabs defaultValue="retention" className="space-y-6">
          <TabsList className="grid w-full max-w-md grid-cols-2">
            <TabsTrigger value="retention" data-testid="tab-retention">Retention Team</TabsTrigger>
            <TabsTrigger value="nsf" data-testid="tab-nsf">NSF Team</TabsTrigger>
          </TabsList>
          <TabsContent value="retention">
            <TeamPanel urls={RETENTION} sheetKey="retention" label="Retention Team" mode="retention" />
          </TabsContent>
          <TabsContent value="nsf">
            <TeamPanel urls={NSF} sheetKey="nsf" label="NSF Team" mode="nsf" />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Dashboard />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
