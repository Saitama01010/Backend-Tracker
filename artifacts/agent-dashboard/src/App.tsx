import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
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
  CalendarDays,
  Users,
  Download,
} from "lucide-react";

const queryClient = new QueryClient();

const RETENTION = {
  status: "https://docs.google.com/spreadsheets/d/1qF5Dc5quGrAywf5Rtx4q7DrX91VlNIFOfKr-REoSkII/export?format=csv&gid=0",
};
const NSF = {
  status: "https://docs.google.com/spreadsheets/d/16qoZESE0gGQPdOXQUSh2JsadWDmUE7OyCajRwBy0E38/export?format=csv&gid=0",
};

type Row = Record<string, string>;
type SheetData = { headers: string[]; rows: Row[] };

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

// Maps normalized SHEET agent name → normalized PHONE (OpenPhone) agent name
const SHEET_TO_PHONE: Record<string, string> = {
  "abdlrhman-jacob stephenson": "abdulrhman isawi",
  "muhamed-ryan henderson": "ryan henderson",
  "zeiad fouad-zack ford": "zeiad fouad",
  "youssef nady-jacob xander": "youssef nady",
  "ahmed ayman-levi miller": "ahmed ayman",
  "nour-michael belfort-2900": "michael belfort",
  "mohammed ayman-max francis-2268": "max francis",
};

function sheetToPhoneKey(sheetAgent: string): string {
  const norm = normalizeAgent(sheetAgent);
  return SHEET_TO_PHONE[norm] ?? norm;
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
  monthCancelled: number;
  todayCount: number;
  monthCount: number;
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
  mode: TeamMode,
  fromDate: Date | null,
  toDate: Date | null,
): Aggregated | { error: string } {
  const agentColumn = findColumn(status.headers, ["Agent", "Agent Name", "Rep"]);
  const statusColumn = findColumn(status.headers, ["Status", "Result", "Outcome", "Disposition"]);
  const dateColumn = findColumn(status.headers, ["Date", "Day", "Call Date"]);
  if (!agentColumn) return { error: `Couldn't find "Agent" column.` };
  if (!statusColumn) return { error: `Couldn't find "Status" column.` };

  // Determine global date range from status sheet for the filter UI
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
  let monthCancelled = 0;
  let todayCount = 0;
  let monthCount = 0;
  if (dateColumn) {
    const now = new Date();
    const todayIso = toIsoDate(now);
    const monthYear = now.getFullYear();
    const monthMonth = now.getMonth();
    for (const r of status.rows) {
      const d = parseDate(r[dateColumn] ?? "");
      if (!d) continue;
      const rawStatus = (r[statusColumn] ?? "").trim();
      const isToday = toIsoDate(d) === todayIso;
      const inThisMonth = d.getFullYear() === monthYear && d.getMonth() === monthMonth;
      if (isToday) todayCount += 1;
      if (inThisMonth) monthCount += 1;
      if (isRetainedStatus(rawStatus)) {
        if (isToday) todayRetained += 1;
        if (inThisMonth) monthRetained += 1;
      }
      if (/cancel/i.test(rawStatus) && inThisMonth) monthCancelled += 1;
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
    monthCancelled,
    todayCount,
    monthCount,
    totalRowCount: status.rows.length,
    filteredRowCount: filteredStatus.length,
    minDate,
    maxDate,
  };
}

// ---------- UI ----------

type TileTone = "violet" | "emerald" | "amber" | "sky" | "rose" | "slate";

const TONE_STYLES: Record<TileTone, { bg: string; ring: string; text: string; glow: string }> = {
  violet: {
    bg: "bg-gradient-to-br from-violet-500/15 via-fuchsia-500/10 to-transparent",
    ring: "border-violet-500/30",
    text: "text-violet-300",
    glow: "shadow-[0_0_24px_-12px_rgba(168,85,247,0.6)]",
  },
  emerald: {
    bg: "bg-gradient-to-br from-emerald-500/15 via-teal-500/10 to-transparent",
    ring: "border-emerald-500/30",
    text: "text-emerald-300",
    glow: "shadow-[0_0_24px_-12px_rgba(16,185,129,0.6)]",
  },
  amber: {
    bg: "bg-gradient-to-br from-amber-500/15 via-orange-500/10 to-transparent",
    ring: "border-amber-500/30",
    text: "text-amber-300",
    glow: "shadow-[0_0_24px_-12px_rgba(245,158,11,0.6)]",
  },
  sky: {
    bg: "bg-gradient-to-br from-sky-500/15 via-cyan-500/10 to-transparent",
    ring: "border-sky-500/30",
    text: "text-sky-300",
    glow: "shadow-[0_0_24px_-12px_rgba(14,165,233,0.6)]",
  },
  rose: {
    bg: "bg-gradient-to-br from-rose-500/15 via-pink-500/10 to-transparent",
    ring: "border-rose-500/30",
    text: "text-rose-300",
    glow: "shadow-[0_0_24px_-12px_rgba(244,63,94,0.6)]",
  },
  slate: {
    bg: "bg-card",
    ring: "border-border",
    text: "text-foreground",
    glow: "",
  },
};

function StatTile({
  label,
  value,
  icon,
  tone = "slate",
}: {
  label: string;
  value: number | string;
  icon?: React.ReactNode;
  tone?: TileTone;
}) {
  const s = TONE_STYLES[tone];
  return (
    <div className={`rounded-xl border p-4 ${s.bg} ${s.ring} ${s.glow}`}>
      <div className={`flex items-center gap-2 text-xs uppercase tracking-wide ${tone === "slate" ? "text-muted-foreground" : s.text}`}>
        {icon}
        <span>{label}</span>
      </div>
      <div className={`mt-1 text-2xl font-bold tabular-nums font-mono ${tone === "slate" ? "" : s.text}`}>{value}</div>
    </div>
  );
}

function statusTone(s: string): string {
  const lower = s.toLowerCase();
  if (/retain/.test(lower)) return "text-emerald-400";
  if (/idp/.test(lower)) return "text-sky-400";
  if (/cancel/.test(lower)) return "text-rose-400";
  if (/fixed/.test(lower)) return "text-emerald-400";
  return "text-foreground";
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
                <TableHead key={s} className={`text-right whitespace-nowrap ${statusTone(s)}`}>
                  {s}
                </TableHead>
              ))}
              <TableHead className="text-right whitespace-nowrap bg-primary/10 text-violet-300">Total</TableHead>
              {showRate && (
                <TableHead className="text-right whitespace-nowrap bg-primary/10 text-violet-200">Retention rate</TableHead>
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
                            className={`text-right tabular-nums font-mono ${v === 0 ? "text-muted-foreground/40" : statusTone(s)}`}
                          >
                            {v}
                          </TableCell>
                        );
                      })}
                      <TableCell className="text-right tabular-nums font-mono font-semibold bg-primary/5 text-violet-200">
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

function responseRate(answered: number, total: number): string {
  if (!total) return "—";
  return `${Math.round((answered / total) * 100)}%`;
}

function avgDuration(seconds: number, calls: number): string {
  if (!calls) return "—";
  return formatDuration(Math.round(seconds / calls));
}

function ByAgentView({ data, phoneData }: { data: Aggregated; phoneData?: Map<string, PhoneAgentMetrics> }) {
  const showRate = data.mode === "retention";
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortState>({ column: "__total__", dir: "desc" });

  const getPhone = (agent: string) => phoneData?.get(sheetToPhoneKey(agent));

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = data.byAgent;
    if (q) list = list.filter((a) => a.agent.toLowerCase().includes(q));
    if (sort) {
      list = [...list].sort((a, b) => {
        let av: number | string;
        let bv: number | string;
        const phA = phoneData?.get(sheetToPhoneKey(a.agent));
        const phB = phoneData?.get(sheetToPhoneKey(b.agent));
        if (sort.column === "__agent__") {
          av = a.agent;
          bv = b.agent;
        } else if (sort.column === "__total__") {
          av = a.total;
          bv = b.total;
        } else if (sort.column === "__calls__") {
          av = phA?.calls ?? 0;
          bv = phB?.calls ?? 0;
        } else if (sort.column === "__time__") {
          av = phA?.seconds ?? 0;
          bv = phB?.seconds ?? 0;
        } else if (sort.column === "__outbound__") {
          av = phA?.outbound ?? 0;
          bv = phB?.outbound ?? 0;
        } else if (sort.column === "__inbound__") {
          av = phA?.inbound ?? 0;
          bv = phB?.inbound ?? 0;
        } else if (sort.column === "__answered__") {
          av = phA?.answered ?? 0;
          bv = phB?.answered ?? 0;
        } else if (sort.column === "__missed__") {
          av = phA?.missed ?? 0;
          bv = phB?.missed ?? 0;
        } else if (sort.column === "__unique__") {
          av = phA?.uniqueContacts ?? 0;
          bv = phB?.uniqueContacts ?? 0;
        } else if (sort.column === "__avg__") {
          av = phA && phA.calls ? phA.seconds / phA.calls : 0;
          bv = phB && phB.calls ? phB.seconds / phB.calls : 0;
        } else if (sort.column === "__resp__") {
          av = phA && phA.calls ? phA.answered / phA.calls : -1;
          bv = phB && phB.calls ? phB.answered / phB.calls : -1;
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
  }, [data, search, sort, phoneData]);

  function toggle(column: string) {
    setSort((prev) => {
      if (!prev || prev.column !== column) {
        return { column, dir: column === "__agent__" ? "asc" : "desc" };
      }
      if (prev.dir === "desc") return { column, dir: "asc" };
      return null;
    });
  }

  function exportCsv() {
    const rows = visible.map((a) => {
      const ph = getPhone(a.agent);
      const record: Record<string, string | number> = { Agent: a.agent };
      record["Calls"] = ph?.calls ?? 0;
      record["Outbound"] = ph?.outbound ?? 0;
      record["Inbound"] = ph?.inbound ?? 0;
      record["Answered"] = ph?.answered ?? 0;
      record["Missed"] = ph?.missed ?? 0;
      record["Unique #"] = ph?.uniqueContacts ?? 0;
      record["Talk Time"] = ph?.seconds ? formatDuration(ph.seconds) : "";
      record["Avg Duration"] = ph ? avgDuration(ph.seconds, ph.calls) : "";
      record["Response %"] = ph ? responseRate(ph.answered, ph.calls) : "";
      for (const s of data.statuses) record[s] = a.byStatus.get(s) ?? 0;
      record["Total"] = a.total;
      if (showRate) record["Retention Rate"] = retentionRate(sumRetained(a.byStatus, data.retainedStatuses), a.total);
      return record;
    });
    const csv = Papa.unparse(rows);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `agents_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
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
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="font-mono">
            {visible.length} of {data.byAgent.length} agents
          </Badge>
          <Button variant="outline" size="sm" onClick={exportCsv} data-testid="button-export-csv">
            <Download className="h-3.5 w-3.5 mr-1.5" />
            Export CSV
          </Button>
        </div>
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
                <TableHead className="whitespace-nowrap text-right text-fuchsia-400">
                  <SortHeader id="__outbound__" label="Outbound" align="right" sort={sort} onToggle={toggle} />
                </TableHead>
                <TableHead className="whitespace-nowrap text-right text-cyan-400">
                  <SortHeader id="__inbound__" label="Inbound" align="right" sort={sort} onToggle={toggle} />
                </TableHead>
                <TableHead className="whitespace-nowrap text-right text-emerald-400">
                  <SortHeader id="__answered__" label="Answered" align="right" sort={sort} onToggle={toggle} />
                </TableHead>
                <TableHead className="whitespace-nowrap text-right text-rose-400">
                  <SortHeader id="__missed__" label="Missed" align="right" sort={sort} onToggle={toggle} />
                </TableHead>
                <TableHead className="whitespace-nowrap text-right text-sky-400">
                  <SortHeader id="__unique__" label="Unique #" align="right" sort={sort} onToggle={toggle} />
                </TableHead>
                <TableHead className="whitespace-nowrap text-right">
                  <SortHeader id="__time__" label="Talk time" align="right" sort={sort} onToggle={toggle} />
                </TableHead>
                <TableHead className="whitespace-nowrap text-right">
                  <SortHeader id="__avg__" label="Avg duration" align="right" sort={sort} onToggle={toggle} />
                </TableHead>
                <TableHead className="whitespace-nowrap text-right text-amber-400">
                  <SortHeader id="__resp__" label="Response %" align="right" sort={sort} onToggle={toggle} />
                </TableHead>
                {data.statuses.map((s) => (
                  <TableHead key={s} className={`whitespace-nowrap text-right ${statusTone(s)}`}>
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
              {visible.map((a) => {
                const ph = getPhone(a.agent);
                return (
                  <TableRow key={a.agent} className="hover-elevate">
                    <TableCell className="font-medium whitespace-nowrap">{a.agent}</TableCell>
                    <TableCell className={`text-right tabular-nums font-mono ${!ph?.calls ? "text-muted-foreground/40" : ""}`}>
                      {ph?.calls ?? "—"}
                    </TableCell>
                    <TableCell className={`text-right tabular-nums font-mono ${ph?.outbound ? "text-fuchsia-400" : "text-muted-foreground/40"}`}>
                      {ph?.outbound ?? "—"}
                    </TableCell>
                    <TableCell className={`text-right tabular-nums font-mono ${ph?.inbound ? "text-cyan-400" : "text-muted-foreground/40"}`}>
                      {ph?.inbound ?? "—"}
                    </TableCell>
                    <TableCell className={`text-right tabular-nums font-mono ${ph?.answered ? "text-emerald-400" : "text-muted-foreground/40"}`}>
                      {ph?.answered ?? "—"}
                    </TableCell>
                    <TableCell className={`text-right tabular-nums font-mono ${ph?.missed ? "text-rose-400" : "text-muted-foreground/40"}`}>
                      {ph?.missed ?? "—"}
                    </TableCell>
                    <TableCell className={`text-right tabular-nums font-mono ${ph?.uniqueContacts ? "text-sky-400" : "text-muted-foreground/40"}`}>
                      {ph?.uniqueContacts ?? "—"}
                    </TableCell>
                    <TableCell className={`text-right tabular-nums font-mono ${!ph?.seconds ? "text-muted-foreground/40" : ""}`}>
                      {ph?.seconds ? formatDuration(ph.seconds) : "—"}
                    </TableCell>
                    <TableCell className={`text-right tabular-nums font-mono ${!ph?.calls ? "text-muted-foreground/40" : ""}`}>
                      {ph ? avgDuration(ph.seconds, ph.calls) : "—"}
                    </TableCell>
                    <TableCell className={`text-right tabular-nums font-mono ${ph?.calls ? "text-amber-400" : "text-muted-foreground/40"}`}>
                      {ph ? responseRate(ph.answered, ph.calls) : "—"}
                    </TableCell>
                    {data.statuses.map((s) => {
                      const v = a.byStatus.get(s) ?? 0;
                      return (
                        <TableCell
                          key={s}
                          className={`text-right tabular-nums font-mono ${v === 0 ? "text-muted-foreground/40" : statusTone(s)}`}
                        >
                          {v}
                        </TableCell>
                      );
                    })}
                    <TableCell className="text-right tabular-nums font-mono font-semibold bg-primary/5 text-violet-200">
                      {a.total}
                    </TableCell>
                    {showRate && (
                      <TableCell className="text-right tabular-nums font-mono font-semibold bg-primary/10">
                        {retentionRate(sumRetained(a.byStatus, data.retainedStatuses), a.total)}
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
            {visible.length > 0 && (
              <TableHeader className="sticky bottom-0 bg-muted/80 backdrop-blur z-10">
                <TableRow>
                  <TableCell className="font-bold whitespace-nowrap">Whole team</TableCell>
                  <TableCell className="text-right tabular-nums font-mono font-bold">
                    {visible.reduce((s, a) => s + (getPhone(a.agent)?.calls ?? 0), 0)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-mono font-bold text-fuchsia-400">
                    {visible.reduce((s, a) => s + (getPhone(a.agent)?.outbound ?? 0), 0)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-mono font-bold text-cyan-400">
                    {visible.reduce((s, a) => s + (getPhone(a.agent)?.inbound ?? 0), 0)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-mono font-bold text-emerald-400">
                    {visible.reduce((s, a) => s + (getPhone(a.agent)?.answered ?? 0), 0)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-mono font-bold text-rose-400">
                    {visible.reduce((s, a) => s + (getPhone(a.agent)?.missed ?? 0), 0)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-mono font-bold text-sky-400">
                    {visible.reduce((s, a) => s + (getPhone(a.agent)?.uniqueContacts ?? 0), 0)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-mono font-bold">
                    {formatDuration(visible.reduce((s, a) => s + (getPhone(a.agent)?.seconds ?? 0), 0))}
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-mono font-bold">
                    {(() => {
                      const totCalls = visible.reduce((s, a) => s + (getPhone(a.agent)?.calls ?? 0), 0);
                      const totSecs = visible.reduce((s, a) => s + (getPhone(a.agent)?.seconds ?? 0), 0);
                      return avgDuration(totSecs, totCalls);
                    })()}
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-mono font-bold text-amber-400">
                    {(() => {
                      const totAns = visible.reduce((s, a) => s + (getPhone(a.agent)?.answered ?? 0), 0);
                      const totCalls = visible.reduce((s, a) => s + (getPhone(a.agent)?.calls ?? 0), 0);
                      return responseRate(totAns, totCalls);
                    })()}
                  </TableCell>
                  {data.statuses.map((s) => (
                    <TableCell key={s} className="text-right tabular-nums font-mono font-bold">
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

interface PhoneAgentMetrics {
  calls: number;
  seconds: number;
  answered: number;
  missed: number;
  voicemail: number;
  inbound: number;
  outbound: number;
  uniqueContacts: number;
}

interface PhoneAgentDay {
  totalCalls: number;
  talkSeconds: number;
  inbound: number;
  outbound: number;
  answered: number;
  missed: number;
  voicemail: number;
  uniqueContacts: number;
}

interface PhoneStatsResponse {
  teamStats: Record<string, Record<string, Record<string, PhoneAgentDay>>>;
}

function TeamPanel({
  urls,
  sheetKey,
  label,
  mode,
}: {
  urls: { status: string };
  sheetKey: string;
  label: string;
  mode: TeamMode;
}) {
  const statusQ = useQuery({
    queryKey: ["status", sheetKey],
    queryFn: () => fetchHeaderCsv(urls.status),
    staleTime: 1000 * 60 * 2,
    refetchOnWindowFocus: false,
  });
  const isLoading = statusQ.isLoading;
  const isFetching = statusQ.isFetching;
  const error = statusQ.error;

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const fromDate = from ? parseDate(from) : null;
  const toDate = to ? parseDate(to) : null;
  if (toDate) toDate.setHours(23, 59, 59, 999);

  const phoneQ = useQuery<PhoneStatsResponse | null>({
    queryKey: ["phoneStats", mode, from || "last30", to || "now"],
    queryFn: async () => {
      const pFrom = from ? `${from}T00:00:00Z` : new Date(Date.now() - 30 * 86400000).toISOString();
      const pTo = to ? `${to}T23:59:59Z` : new Date().toISOString();
      const res = await fetch(`/api/quo/stats?from=${encodeURIComponent(pFrom)}&to=${encodeURIComponent(pTo)}`);
      if (!res.ok) return null;
      return res.json() as Promise<PhoneStatsResponse>;
    },
    staleTime: 1000 * 60 * 2,
    refetchOnWindowFocus: false,
  });

  const phoneData = useMemo<Map<string, PhoneAgentMetrics>>(() => {
    const map = new Map<string, PhoneAgentMetrics>();
    const agentStats = phoneQ.data?.teamStats?.[mode] ?? {};
    for (const [agentName, days] of Object.entries(agentStats)) {
      const key = normalizeAgent(agentName);
      const acc: PhoneAgentMetrics = { calls: 0, seconds: 0, answered: 0, missed: 0, voicemail: 0, inbound: 0, outbound: 0, uniqueContacts: 0 };
      for (const day of Object.values(days)) {
        acc.calls += day.totalCalls ?? 0;
        acc.seconds += day.talkSeconds ?? 0;
        acc.answered += day.answered ?? 0;
        acc.missed += day.missed ?? 0;
        acc.voicemail += day.voicemail ?? 0;
        acc.inbound += day.inbound ?? 0;
        acc.outbound += day.outbound ?? 0;
        acc.uniqueContacts += day.uniqueContacts ?? 0;
      }
      if (acc.calls > 0 || acc.seconds > 0) {
        const e = map.get(key);
        if (e) {
          map.set(key, { calls: e.calls + acc.calls, seconds: e.seconds + acc.seconds, answered: e.answered + acc.answered, missed: e.missed + acc.missed, voicemail: e.voicemail + acc.voicemail, inbound: e.inbound + acc.inbound, outbound: e.outbound + acc.outbound, uniqueContacts: e.uniqueContacts + acc.uniqueContacts });
        } else {
          map.set(key, acc);
        }
      }
    }
    return map;
  }, [phoneQ.data, mode]);

  const phoneTotals = useMemo(() => {
    let calls = 0;
    let seconds = 0;
    for (const v of phoneData.values()) { calls += v.calls; seconds += v.seconds; }
    return { calls, seconds };
  }, [phoneData]);

  const aggregated = useMemo(() => {
    if (!statusQ.data) return null;
    return aggregate(statusQ.data, mode, fromDate, toDate);
  }, [statusQ.data, mode, from, to]);

  function refresh() {
    statusQ.refetch();
    phoneQ.refetch();
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
              <StatTile label="Agents" value={aggregated.totals.agents} icon={<Users className="h-3.5 w-3.5" />} tone="violet" />
              <StatTile
                label="Total calls"
                value={phoneTotals.calls.toLocaleString()}
                icon={<Phone className="h-3.5 w-3.5" />}
                tone="sky"
              />
              <StatTile
                label="Time on calls"
                value={formatHours(phoneTotals.seconds)}
                icon={<Clock className="h-3.5 w-3.5" />}
                tone="amber"
              />
              {mode === "nsf" ? (
                <>
                  <StatTile
                    label="Today's fixed"
                    value={aggregated.todayCount.toLocaleString()}
                    tone="emerald"
                  />
                  <StatTile
                    label="This month's fixed"
                    value={aggregated.monthCount.toLocaleString()}
                    tone="emerald"
                  />
                  <StatTile
                    label="Total fixed"
                    value={aggregated.totals.grand.toLocaleString()}
                    tone="violet"
                  />
                </>
              ) : (
                <>
                  <StatTile
                    label="Today's retains"
                    value={aggregated.todayRetained.toLocaleString()}
                    tone="emerald"
                  />
                  <StatTile
                    label="This month's retains"
                    value={aggregated.monthRetained.toLocaleString()}
                    tone="emerald"
                  />
                  <StatTile
                    label="This month's cancels"
                    value={aggregated.monthCancelled.toLocaleString()}
                    tone="rose"
                  />
                  <StatTile
                    label="Retention rate"
                    value={retentionRate(aggregated.totals.retained, aggregated.totals.grand)}
                    tone="violet"
                  />
                </>
              )}
            </div>

            <Tabs defaultValue="agent" className="space-y-4">
              <TabsList>
                <TabsTrigger value="agent" data-testid="subtab-agent">By agent</TabsTrigger>
                <TabsTrigger value="day" data-testid="subtab-day">By day</TabsTrigger>
              </TabsList>
              <TabsContent value="agent">
                <ByAgentView data={aggregated} phoneData={phoneData} />
              </TabsContent>
              <TabsContent value="day">
                <ByDayView data={aggregated} />
              </TabsContent>
            </Tabs>
          </>
        )}
      </CardContent>
    </Card>
  );
}

const CS_AGENTS = ["Nora Adam", "Leo Carter", "Carla Bennet"];

function CSPanel() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const phoneQ = useQuery<PhoneStatsResponse | null>({
    queryKey: ["phoneStats", "cs", from || "last30", to || "now"],
    queryFn: async () => {
      const pFrom = from ? `${from}T00:00:00Z` : new Date(Date.now() - 30 * 86400000).toISOString();
      const pTo = to ? `${to}T23:59:59Z` : new Date().toISOString();
      const res = await fetch(`/api/quo/stats?from=${encodeURIComponent(pFrom)}&to=${encodeURIComponent(pTo)}`);
      if (!res.ok) return null;
      return res.json() as Promise<PhoneStatsResponse>;
    },
    staleTime: 1000 * 60 * 2,
    refetchOnWindowFocus: false,
  });

  const phoneData = useMemo<Map<string, PhoneAgentMetrics>>(() => {
    const map = new Map<string, PhoneAgentMetrics>();
    const agentStats = phoneQ.data?.teamStats?.["cs"] ?? {};
    for (const [agentName, days] of Object.entries(agentStats)) {
      const key = normalizeAgent(agentName);
      const acc: PhoneAgentMetrics = { calls: 0, seconds: 0, answered: 0, missed: 0, voicemail: 0, inbound: 0, outbound: 0, uniqueContacts: 0 };
      for (const day of Object.values(days)) {
        acc.calls += day.totalCalls ?? 0;
        acc.seconds += day.talkSeconds ?? 0;
        acc.answered += day.answered ?? 0;
        acc.missed += day.missed ?? 0;
        acc.voicemail += day.voicemail ?? 0;
        acc.inbound += day.inbound ?? 0;
        acc.outbound += day.outbound ?? 0;
        acc.uniqueContacts += day.uniqueContacts ?? 0;
      }
      if (acc.calls > 0 || acc.seconds > 0) {
        const e = map.get(key);
        if (e) {
          map.set(key, { calls: e.calls + acc.calls, seconds: e.seconds + acc.seconds, answered: e.answered + acc.answered, missed: e.missed + acc.missed, voicemail: e.voicemail + acc.voicemail, inbound: e.inbound + acc.inbound, outbound: e.outbound + acc.outbound, uniqueContacts: e.uniqueContacts + acc.uniqueContacts });
        } else {
          map.set(key, acc);
        }
      }
    }
    return map;
  }, [phoneQ.data]);

  const allAgents = useMemo(() => {
    const known = new Set(CS_AGENTS.map(normalizeAgent));
    const extra = [...phoneData.keys()].filter((k) => !known.has(k));
    return [
      ...CS_AGENTS,
      ...extra.map((k) => k.replace(/\b\w/g, (c) => c.toUpperCase())),
    ];
  }, [phoneData]);

  const totals = useMemo(() => {
    let calls = 0, seconds = 0, answered = 0, missed = 0, uniqueContacts = 0;
    for (const v of phoneData.values()) { calls += v.calls; seconds += v.seconds; answered += v.answered; missed += v.missed; uniqueContacts += v.uniqueContacts; }
    return { calls, seconds, answered, missed, uniqueContacts };
  }, [phoneData]);

  function refresh() { phoneQ.refetch(); }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0 gap-4">
        <div>
          <CardTitle className="text-xl">CS Team</CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Call activity · live from OpenPhone
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={phoneQ.isFetching}>
          <RefreshCw className={`h-4 w-4 mr-2 ${phoneQ.isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-6">
        {phoneQ.isLoading && <TableSkeleton />}

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatTile label="Agents" value={CS_AGENTS.length} icon={<Users className="h-3.5 w-3.5" />} tone="violet" />
          <StatTile label="Total calls" value={totals.calls.toLocaleString()} icon={<Phone className="h-3.5 w-3.5" />} tone="sky" />
          <StatTile label="Answered" value={totals.answered.toLocaleString()} tone="emerald" />
          <StatTile label="Missed" value={totals.missed.toLocaleString()} tone="rose" />
          <StatTile label="Time on calls" value={formatHours(totals.seconds)} icon={<Clock className="h-3.5 w-3.5" />} tone="amber" />
          <StatTile label="Response rate" value={responseRate(totals.answered, totals.calls)} tone="amber" />
        </div>

        <div className="mb-3 flex items-center gap-3 flex-wrap">
          <span className="text-sm text-muted-foreground flex items-center gap-1">
            <CalendarDays className="h-3.5 w-3.5" /> Date range
          </span>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
          />
          <span className="text-muted-foreground text-sm">to</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
          />
          <Button variant="ghost" size="sm" onClick={() => { setFrom(""); setTo(""); }}>Clear</Button>
        </div>

        <div className="rounded-lg border bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader className="sticky top-0 bg-muted/80 backdrop-blur z-10">
                <TableRow>
                  <TableHead className="min-w-[200px]">Agent</TableHead>
                  <TableHead className="text-right">Calls</TableHead>
                  <TableHead className="text-right text-fuchsia-400">Outbound</TableHead>
                  <TableHead className="text-right text-cyan-400">Inbound</TableHead>
                  <TableHead className="text-right text-emerald-400">Answered</TableHead>
                  <TableHead className="text-right text-rose-400">Missed</TableHead>
                  <TableHead className="text-right text-sky-400">Unique #</TableHead>
                  <TableHead className="text-right">Talk time</TableHead>
                  <TableHead className="text-right">Avg duration</TableHead>
                  <TableHead className="text-right text-amber-400">Response %</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {allAgents.map((agent) => {
                  const ph = phoneData.get(normalizeAgent(agent));
                  return (
                    <TableRow key={agent} className="hover-elevate">
                      <TableCell className="font-medium">{agent}</TableCell>
                      <TableCell className={`text-right tabular-nums font-mono ${!ph?.calls ? "text-muted-foreground/40" : ""}`}>
                        {ph?.calls ?? "—"}
                      </TableCell>
                      <TableCell className={`text-right tabular-nums font-mono ${ph?.outbound ? "text-fuchsia-400" : "text-muted-foreground/40"}`}>
                        {ph?.outbound ?? "—"}
                      </TableCell>
                      <TableCell className={`text-right tabular-nums font-mono ${ph?.inbound ? "text-cyan-400" : "text-muted-foreground/40"}`}>
                        {ph?.inbound ?? "—"}
                      </TableCell>
                      <TableCell className={`text-right tabular-nums font-mono ${ph?.answered ? "text-emerald-400" : "text-muted-foreground/40"}`}>
                        {ph?.answered ?? "—"}
                      </TableCell>
                      <TableCell className={`text-right tabular-nums font-mono ${ph?.missed ? "text-rose-400" : "text-muted-foreground/40"}`}>
                        {ph?.missed ?? "—"}
                      </TableCell>
                      <TableCell className={`text-right tabular-nums font-mono ${ph?.uniqueContacts ? "text-sky-400" : "text-muted-foreground/40"}`}>
                        {ph?.uniqueContacts ?? "—"}
                      </TableCell>
                      <TableCell className={`text-right tabular-nums font-mono ${!ph?.seconds ? "text-muted-foreground/40" : ""}`}>
                        {ph?.seconds ? formatDuration(ph.seconds) : "—"}
                      </TableCell>
                      <TableCell className={`text-right tabular-nums font-mono ${!ph?.calls ? "text-muted-foreground/40" : ""}`}>
                        {ph ? avgDuration(ph.seconds, ph.calls) : "—"}
                      </TableCell>
                      <TableCell className={`text-right tabular-nums font-mono ${ph?.calls ? "text-amber-400" : "text-muted-foreground/40"}`}>
                        {ph ? responseRate(ph.answered, ph.calls) : "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
              {allAgents.length > 0 && (
                <TableHeader className="sticky bottom-0 bg-muted/80 backdrop-blur z-10">
                  <TableRow>
                    <TableCell className="font-bold">Whole team</TableCell>
                    <TableCell className="text-right tabular-nums font-mono font-bold">{totals.calls || "—"}</TableCell>
                    <TableCell className="text-right tabular-nums font-mono font-bold text-fuchsia-400">{[...phoneData.values()].reduce((s, v) => s + v.outbound, 0) || "—"}</TableCell>
                    <TableCell className="text-right tabular-nums font-mono font-bold text-cyan-400">{[...phoneData.values()].reduce((s, v) => s + v.inbound, 0) || "—"}</TableCell>
                    <TableCell className="text-right tabular-nums font-mono font-bold text-emerald-400">{totals.answered || "—"}</TableCell>
                    <TableCell className="text-right tabular-nums font-mono font-bold text-rose-400">{totals.missed || "—"}</TableCell>
                    <TableCell className="text-right tabular-nums font-mono font-bold text-sky-400">{totals.uniqueContacts || "—"}</TableCell>
                    <TableCell className="text-right tabular-nums font-mono font-bold">{totals.seconds ? formatDuration(totals.seconds) : "—"}</TableCell>
                    <TableCell className="text-right tabular-nums font-mono font-bold">{avgDuration(totals.seconds, totals.calls)}</TableCell>
                    <TableCell className="text-right tabular-nums font-mono font-bold text-amber-400">{responseRate(totals.answered, totals.calls)}</TableCell>
                  </TableRow>
                </TableHeader>
              )}
            </Table>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function Dashboard() {
  return (
    <div className="min-h-screen bg-background relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 -z-0">
        <div className="absolute -top-32 -left-32 h-[500px] w-[500px] rounded-full bg-violet-600/20 blur-[120px]" />
        <div className="absolute top-20 right-0 h-[400px] w-[400px] rounded-full bg-sky-500/15 blur-[120px]" />
        <div className="absolute bottom-0 left-1/3 h-[400px] w-[400px] rounded-full bg-fuchsia-500/10 blur-[120px]" />
      </div>
      <header className="relative border-b border-white/5 bg-card/60 backdrop-blur-xl">
        <div className="max-w-[1400px] mx-auto px-6 py-5 flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white flex items-center justify-center shadow-[0_0_24px_-6px_rgba(168,85,247,0.7)]">
            <Rocket className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight bg-gradient-to-r from-violet-300 via-fuchsia-300 to-sky-300 bg-clip-text text-transparent">
              Backend Tracker
            </h1>
            <p className="text-sm text-muted-foreground">Retention, NSF &amp; CS team metrics at a glance</p>
          </div>
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto px-6 py-8">
        <Tabs defaultValue="retention" className="space-y-6">
          <TabsList className="grid w-full max-w-md grid-cols-3">
            <TabsTrigger value="retention" data-testid="tab-retention">Retention Team</TabsTrigger>
            <TabsTrigger value="nsf" data-testid="tab-nsf">NSF Team</TabsTrigger>
            <TabsTrigger value="cs" data-testid="tab-cs">CS Team</TabsTrigger>
          </TabsList>
          <TabsContent value="retention">
            <TeamPanel urls={RETENTION} sheetKey="retention" label="Retention Team" mode="retention" />
          </TabsContent>
          <TabsContent value="nsf">
            <TeamPanel urls={NSF} sheetKey="nsf" label="NSF Team" mode="nsf" />
          </TabsContent>
          <TabsContent value="cs">
            <CSPanel />
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
