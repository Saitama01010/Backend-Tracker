import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
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
import { Fragment, useEffect, useMemo, useState } from "react";
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
  Lock,
  PhoneIncoming,
  PhoneOutgoing,
  PhoneMissed,
  Info,
  ChevronLeft,
  PhoneCall,
} from "lucide-react";

const queryClient = new QueryClient();

const RETENTION = {
  status: "https://docs.google.com/spreadsheets/d/1qF5Dc5quGrAywf5Rtx4q7DrX91VlNIFOfKr-REoSkII/export?format=csv&gid=0",
};
const NEW_RETENTION_URL =
  "https://docs.google.com/spreadsheets/d/1Eje6BABFbmRGHa6D1ET2sMvlE8o61iJ71yOvydD-R3o/export?format=csv&gid=837339339";
const NEW_NSF_URL =
  "https://docs.google.com/spreadsheets/d/11kOhk8xBPywxsAoULxS1b2QlofV7Le8ubawPoG7TZdc/export?format=csv&gid=0";
// Records on/after this date come from the new Discord-bot sheets; older records from the old sheets.
const RETENTION_CUTOVER = new Date("2026-05-04T00:00:00");
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


// Derives a normalised status label from the new sheet's "Cancel request update" column.
function deriveNewRetentionStatus(val: string): string {
  const lower = val.toLowerCase();
  if (/retain/.test(lower)) return "Retained";
  if (/\bidp\b/.test(lower)) return "IDP-Handled";
  return "Cancelled";
}

// Fetches both the old and new retention sheets and merges them:
//   – Old sheet  → all rows (historical records, unchanged)
//   – New sheet  → only rows on/after RETENTION_CUTOVER (Discord-bot submissions)
async function fetchRetentionCombinedSheet(): Promise<SheetData> {
  const [oldSheet, newSheet] = await Promise.all([
    fetchHeaderCsv(RETENTION.status),
    fetchHeaderCsv(NEW_RETENTION_URL),
  ]);

  const oldAgentCol = findColumn(oldSheet.headers, ["Agent", "Agent Name", "Rep"]);
  const oldStatusCol = findColumn(oldSheet.headers, ["Status", "Result", "Outcome", "Disposition"]);
  const oldDateCol = findColumn(oldSheet.headers, ["Date", "Day", "Call Date"]);

  const rows: Row[] = [];

  // Keep every row from the old sheet exactly as it was
  if (oldAgentCol && oldStatusCol) {
    for (const r of oldSheet.rows) {
      const dateStr = oldDateCol ? (r[oldDateCol] ?? "") : "";
      const d = oldDateCol ? parseDate(dateStr) : null;
      rows.push({
        Agent: (r[oldAgentCol] ?? "").trim(),
        Status: (r[oldStatusCol] ?? "").trim(),
        Date: d ? toIsoDate(d) : dateStr,
      });
    }
  }

  // Add new-sheet rows that are on/after the cutover date.
  // Timestamps are in Egypt time (UTC+2) — convert to California date.
  for (const r of newSheet.rows) {
    const tsRaw = (r["Timestamp"] ?? "").trim();
    const d = parseEgyptTimestamp(tsRaw);
    if (!d) continue;
    const caDate = toCaliforniaDateStr(d);
    if (caDate < "2026-05-04") continue;
    rows.push({
      Agent: (r["Agent Name"] ?? "").trim(),
      Status: deriveNewRetentionStatus(r["Cancel request update"] ?? ""),
      Date: caDate,
    });
  }

  return { headers: ["Agent", "Status", "Date"], rows };
}

// Fetches both the old and new NSF sheets and merges them:
//   – Old sheet  → all rows (historical records, unchanged)
//   – New sheet  → only rows on/after RETENTION_CUTOVER (Discord-bot submissions)
async function fetchNSFCombinedSheet(): Promise<SheetData> {
  const [oldSheet, newSheet] = await Promise.all([
    fetchHeaderCsv(NSF.status),
    fetchHeaderCsv(NEW_NSF_URL),
  ]);

  const oldAgentCol = findColumn(oldSheet.headers, ["Agent", "Agent Name", "Rep"]);
  const oldStatusCol = findColumn(oldSheet.headers, ["Status", "Result", "Outcome", "Disposition"]);
  const oldDateCol = findColumn(oldSheet.headers, ["Date", "Day", "Call Date"]);

  const rows: Row[] = [];

  // Keep every row from the old sheet exactly as it was
  if (oldAgentCol && oldStatusCol) {
    for (const r of oldSheet.rows) {
      const dateStr = oldDateCol ? (r[oldDateCol] ?? "") : "";
      const d = oldDateCol ? parseDate(dateStr) : null;
      rows.push({
        Agent: (r[oldAgentCol] ?? "").trim(),
        Status: (r[oldStatusCol] ?? "").trim(),
        Date: d ? toIsoDate(d) : dateStr,
      });
    }
  }

  // Add new-sheet rows that are on/after the cutover date.
  // Timestamps are in Egypt time (UTC+2) — convert to California date.
  for (const r of newSheet.rows) {
    const tsRaw = (r["Timestamp"] ?? "").trim();
    const d = parseEgyptTimestamp(tsRaw);
    if (!d) continue;
    const caDate = toCaliforniaDateStr(d);
    if (caDate < "2026-05-04") continue;
    rows.push({
      Agent: (r["Agent Name"] ?? "").trim(),
      Status: (r["File Status"] ?? "").trim(),
      Date: caDate,
    });
  }

  return { headers: ["Agent", "Status", "Date"], rows };
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

// Display names to always exclude everywhere across all panels.
// Use normalized lowercase display names — these are matched against normalizeAgent(agentName).
// NOTE: "Leo Maxwell" is intentionally NOT here. He is an admin who covers calls on
// multiple lines. The Quo Lines tab uses a behavioral filter (outbound===0 && answered===0)
// to hide him when he's inactive. When he IS making calls, he should show.
// NOTE: Do NOT put OpenPhone user IDs here — they are never matched (the check
// compares against display names, not IDs).
const PHONE_BLOCKLIST = new Set(["shahin ."]);

// Extra phone-only agents per team (not in the Google Sheet, but on the team)
// Keys must match OpenPhone agent names (normalized lowercase)
const TEAM_PHONE_EXTRAS: Record<string, string[]> = {
  retention: ["Youssef Nasser", "Michael Ross"],
  nsf: [],
  cs: [],
};

// Strict allowlist per team — normalized phone key variants for each real agent.
// Only agents whose phoneData key appears here will be shown in any view.
const TEAM_ALLOWLIST: Record<string, Set<string>> = {
  retention: new Set([
    // Jacob Stephenson (may appear as either name in OpenPhone)
    "jacob stephenson", "abdulrhman isawi",
    // Jacob Xander
    "jacob xander", "youssef nady",
    // Levi Miller
    "levi miller", "ahmed ayman",
    // Ryan Henderson
    "ryan henderson",
    // Rick Miller (may appear as zeiad fouad)
    "rick miller", "zeiad fouad",
    // Michael Belfort
    "michael belfort",
    // Max Francis
    "max francis",
    // Youssef Nasser (merged from mike johnson / john marcus aliases)
    "youssef nasser",
    // Michael Ross
    "michael ross",
  ]),
  nsf: new Set([
    "alex cruz", "austin white", "rika hart", "jenny morgan",
    "estella cruz", "talia morgan", "katie miller", "ellie moser",
  ]),
  cs: new Set([
    "nora adam", "carla bennet", "leo carter",
  ]),
};

// Merges duplicate phone accounts that belong to the same real person
const PHONE_ALIASES: Record<string, string> = {
  "mike johnson": "youssef nasser",
  "john marcus": "youssef nasser",
  "youssef-john marcus": "youssef nasser",
};

// Maps normalized SHEET agent name → normalized PHONE (OpenPhone) agent name
const SHEET_TO_PHONE: Record<string, string> = {
  "abdlrhman-jacob stephenson": "abdulrhman isawi",
  "muhamed-ryan henderson": "ryan henderson",
  "zeiad fouad-zack ford": "zeiad fouad",
  "youssef nady-jacob xander": "youssef nady",
  "ahmed ayman-levi miller": "ahmed ayman",
  "nour-michael belfort-2900": "michael belfort",
  "mohammed ayman-max francis-2268": "max francis",
  // NSF combined OpenPhone display names
  "engy-ellie moser-2046": "ellie moser",
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

// Discord-bot sheets record timestamps in Egypt local time (EET = UTC+2, no DST since 2011).
// This parses those timestamps and returns a proper UTC Date so the California date can be derived.
// Google Forms timestamp format is typically "M/D/YYYY HH:MM:SS".
function parseEgyptTimestamp(s: string): Date | null {
  if (!s) return null;
  const trimmed = s.trim();

  let year: number, month: number, day: number, hour = 0, minute = 0, second = 0;

  // "M/D/YYYY HH:MM:SS" (Google Forms default)
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(trimmed);
  // "YYYY-MM-DD HH:MM:SS" or "YYYY-MM-DDTHH:MM:SS"
  const iso = /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(trimmed);

  if (us) {
    month  = Number(us[1]); day    = Number(us[2]); year   = Number(us[3]);
    hour   = Number(us[4]); minute = Number(us[5]); second = Number(us[6] ?? 0);
  } else if (iso) {
    year   = Number(iso[1]); month  = Number(iso[2]); day    = Number(iso[3]);
    hour   = Number(iso[4]); minute = Number(iso[5]); second = Number(iso[6] ?? 0);
  } else {
    // Date-only string — no time means no timezone conversion needed
    return parseDate(trimmed);
  }

  // Egypt is permanently UTC+2 → subtract 2 h to get UTC
  const utcMs = Date.UTC(year, month - 1, day, hour - 2, minute, second);
  const d = new Date(utcMs);
  return isNaN(d.getTime()) ? null : d;
}

// Given a UTC Date, return the YYYY-MM-DD date string in California time (America/Los_Angeles).
// This correctly handles Pacific Standard Time (UTC-8) and Pacific Daylight Time (UTC-7).
const _caFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric", month: "2-digit", day: "2-digit",
});
function toCaliforniaDateStr(d: Date): string {
  return _caFmt.format(d); // returns "YYYY-MM-DD"
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

function formatTimeSince(isoStr: string, now: number): string {
  const diff = Math.max(0, now - new Date(isoStr).getTime());
  const totalSecs = Math.floor(diff / 1000);
  const d = Math.floor(totalSecs / 86400);
  const h = Math.floor((totalSecs % 86400) / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ago`;
  if (h > 0) return `${h}h ${m}m ago`;
  if (m > 0) return `${m}m ago`;
  return "just now";
}

function useNow(intervalMs = 30000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function TimeSince({ isoStr }: { isoStr?: string }) {
  const now = useNow(30000);
  if (!isoStr) return <span className="text-muted-foreground/40">—</span>;
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  const color = mins < 30 ? "text-emerald-400" : mins < 120 ? "text-amber-400" : "text-rose-400";
  return <span className={`tabular-nums font-mono ${color}`}>{formatTimeSince(isoStr, now)}</span>;
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

// For counts (daily / monthly / all-time tiles): IDP is excluded.
// IDP still counts toward retention RATE via isRetainedStatus above.
function isPureRetainedStatus(s: string): boolean {
  const lower = s.toLowerCase();
  return /retain/.test(lower) && !/\bidp\b/.test(lower);
}

// Collapse legacy/inconsistent status spellings from old sheets into
// canonical values so they don't appear as duplicate columns.
function normalizeStatus(s: string): string {
  const t = s.trim();
  const l = t.toLowerCase().replace(/[\s\-_]+/g, "");
  if (/^retain(ed)?$/.test(l)) return "Retained";
  if (/^cancel(led)?$/.test(l)) return "Cancelled";
  if (/^idp/.test(l)) return "IDP-Handled";
  if (/^activehandled$/.test(l)) return "IDP-Handled";
  return t;
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
  agentFilter?: string,
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
  const agentFilterKey = agentFilter ? normalizeAgent(agentFilter) : "";
  const filteredStatus = status.rows.filter((r) => {
    const agent = (r[agentColumn] ?? "").trim();
    if (!agent) return false;
    if (/total$/i.test(agent)) return false;
    if (agentFilterKey && normalizeAgent(agent) !== agentFilterKey) return false;
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
    const rawStatus = normalizeStatus((r[statusColumn] ?? "").trim() || "(blank)");
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
      const rawStatus = normalizeStatus((r[statusColumn] ?? "").trim());
      const isToday = toIsoDate(d) === todayIso;
      const inThisMonth = d.getFullYear() === monthYear && d.getMonth() === monthMonth;
      if (isToday) todayCount += 1;
      if (inThisMonth) monthCount += 1;
      if (isPureRetainedStatus(rawStatus)) {
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
  sub,
}: {
  label: string;
  value: number | string;
  icon?: React.ReactNode;
  tone?: TileTone;
  sub?: string;
}) {
  const s = TONE_STYLES[tone];
  return (
    <div className={`rounded-xl border p-4 ${s.bg} ${s.ring} ${s.glow}`}>
      <div className={`flex items-center gap-2 text-xs uppercase tracking-wide ${tone === "slate" ? "text-muted-foreground" : s.text}`}>
        {icon}
        <span>{label}</span>
      </div>
      <div className={`mt-1 text-2xl font-bold tabular-nums font-mono ${tone === "slate" ? "" : s.text}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
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

function ByFilesView({ data }: { data: Aggregated }) {
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
        if (sort.column === "__agent__") { av = a.agent; bv = b.agent; }
        else if (sort.column === "__total__") { av = a.total; bv = b.total; }
        else if (sort.column === "__rate__") {
          av = a.total ? sumRetained(a.byStatus, data.retainedStatuses) / a.total : -1;
          bv = b.total ? sumRetained(b.byStatus, data.retainedStatuses) / b.total : -1;
        } else { av = a.byStatus.get(sort.column) ?? 0; bv = b.byStatus.get(sort.column) ?? 0; }
        if (typeof av === "number" && typeof bv === "number") return sort.dir === "asc" ? av - bv : bv - av;
        const cmp = String(av).localeCompare(String(bv));
        return sort.dir === "asc" ? cmp : -cmp;
      });
    }
    return list;
  }, [data, search, sort]);

  function toggle(column: string) {
    setSort((prev) => {
      if (!prev || prev.column !== column) return { column, dir: column === "__agent__" ? "asc" : "desc" };
      if (prev.dir === "desc") return { column, dir: "asc" };
      return null;
    });
  }

  function exportCsv() {
    const rows = visible.map((a) => {
      const record: Record<string, string | number> = { Agent: a.agent };
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
    a.download = `files_${new Date().toISOString().slice(0, 10)}.csv`;
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
                  <TableCell colSpan={data.statuses.length + 2 + (showRate ? 1 : 0)} className="text-center py-12 text-muted-foreground">
                    No agents match the current filters.
                  </TableCell>
                </TableRow>
              )}
              {visible.map((a) => (
                <TableRow key={a.agent} className="hover-elevate">
                  <TableCell className="font-medium whitespace-nowrap">{a.agent}</TableCell>
                  {data.statuses.map((s) => {
                    const v = a.byStatus.get(s) ?? 0;
                    return (
                      <TableCell key={s} className={`text-right tabular-nums font-mono ${v === 0 ? "text-muted-foreground/40" : statusTone(s)}`}>
                        {v}
                      </TableCell>
                    );
                  })}
                  <TableCell className="text-right tabular-nums font-mono font-semibold bg-primary/5 text-violet-200">{a.total}</TableCell>
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
                  {data.statuses.map((s) => (
                    <TableCell key={s} className="text-right tabular-nums font-mono font-bold">
                      {data.totals.byStatus.get(s) ?? 0}
                    </TableCell>
                  ))}
                  <TableCell className="text-right tabular-nums font-mono font-bold bg-primary/10">{data.totals.grand}</TableCell>
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

function useLiveCalls(): Set<string> {
  const q = useQuery<{ active: string[] }>({
    queryKey: ["liveCalls"],
    queryFn: async () => {
      const r = await fetch("/api/quo/live");
      if (!r.ok) return { active: [] };
      return r.json() as Promise<{ active: string[] }>;
    },
    refetchInterval: 15 * 1000,
    staleTime: 10 * 1000,
    refetchOnWindowFocus: true,
  });
  return useMemo(() => new Set((q.data?.active ?? []).map(normalizeAgent)), [q.data]);
}

function ByCallStatsView({ agentList, phoneData, directKeys }: { agentList: string[]; phoneData: Map<string, PhoneAgentMetrics>; directKeys?: boolean }) {
  const liveAgents = useLiveCalls();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ col: string; dir: "asc" | "desc" }>({ col: "__calls__", dir: "desc" });

  const getPhone = (agent: string) =>
    directKeys ? phoneData.get(normalizeAgent(agent)) : phoneData.get(sheetToPhoneKey(agent));

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const withCalls = agentList.filter((a) => (getPhone(a)?.calls ?? 0) > 0);
    const list = q ? withCalls.filter((a) => a.toLowerCase().includes(q)) : withCalls;
    return [...list].sort((a, b) => {
      const phA = getPhone(a);
      const phB = getPhone(b);
      let av: number = 0;
      let bv: number = 0;
      if (sort.col === "__calls__") { av = phA?.calls ?? 0; bv = phB?.calls ?? 0; }
      else if (sort.col === "__outbound__") { av = phA?.outbound ?? 0; bv = phB?.outbound ?? 0; }
      else if (sort.col === "__inbound__") { av = phA?.inbound ?? 0; bv = phB?.inbound ?? 0; }
      else if (sort.col === "__answered__") { av = phA?.answered ?? 0; bv = phB?.answered ?? 0; }
      else if (sort.col === "__missed__") { av = phA?.missed ?? 0; bv = phB?.missed ?? 0; }
      else if (sort.col === "__vm__") { av = phA?.voicemail ?? 0; bv = phB?.voicemail ?? 0; }
      else if (sort.col === "__vmbrief__") { av = phA?.vmBrief ?? 0; bv = phB?.vmBrief ?? 0; }
      else if (sort.col === "__unique__") { av = phA?.uniqueContacts ?? 0; bv = phB?.uniqueContacts ?? 0; }
      else if (sort.col === "__time__") { av = phA?.seconds ?? 0; bv = phB?.seconds ?? 0; }
      else if (sort.col === "__resp__") { av = phA?.calls ? (phA.answered / phA.calls) : -1; bv = phB?.calls ? (phB.answered / phB.calls) : -1; }
      else if (sort.col === "__agent__") { return sort.dir === "asc" ? a.localeCompare(b) : b.localeCompare(a); }
      return sort.dir === "asc" ? av - bv : bv - av;
    });
  }, [agentList, search, sort, phoneData]);

  function toggle(col: string) {
    setSort((s) => s.col === col ? { col, dir: s.dir === "asc" ? "desc" : "asc" } : { col, dir: col === "__agent__" ? "asc" : "desc" });
  }

  function Th({ id, label, tone = "", align = "right", tip }: { id: string; label: string; tone?: string; align?: "left" | "right"; tip?: string }) {
    const active = sort.col === id;
    return (
      <TableHead className={`whitespace-nowrap ${align === "right" ? "text-right" : ""} ${tone}`}>
        <div className={`inline-flex items-center gap-1 ${align === "right" ? "flex-row-reverse" : ""}`}>
          <button type="button" onClick={() => toggle(id)}
            className={`inline-flex items-center gap-1 font-semibold hover:text-foreground ${active ? "text-violet-300" : "text-muted-foreground"} ${align === "right" ? "flex-row-reverse" : ""}`}>
            {label}
            {active ? (sort.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : <ArrowUpDown className="h-3 w-3 opacity-40" />}
          </button>
          {tip && (
            <Tooltip delayDuration={100}>
              <TooltipTrigger asChild>
                <span className="cursor-help shrink-0">
                  <Info className="h-3 w-3 text-muted-foreground/50 hover:text-muted-foreground transition-colors" />
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[220px] text-center leading-snug">
                {tip}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </TableHead>
    );
  }

  const totCalls = visible.reduce((s, a) => s + (getPhone(a)?.calls ?? 0), 0);
  const totOut = visible.reduce((s, a) => s + (getPhone(a)?.outbound ?? 0), 0);
  const totIn = visible.reduce((s, a) => s + (getPhone(a)?.inbound ?? 0), 0);
  const totAns = visible.reduce((s, a) => s + (getPhone(a)?.answered ?? 0), 0);
  const totMissed = visible.reduce((s, a) => s + (getPhone(a)?.missed ?? 0), 0);
  const totVm = visible.reduce((s, a) => s + (getPhone(a)?.voicemail ?? 0), 0);
  const totVmBrief = visible.reduce((s, a) => s + (getPhone(a)?.vmBrief ?? 0), 0);
  const totUniq = visible.reduce((s, a) => s + (getPhone(a)?.uniqueContacts ?? 0), 0);
  const totSecs = visible.reduce((s, a) => s + (getPhone(a)?.seconds ?? 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="relative w-full sm:max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search agents…" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
        </div>
        <Badge variant="secondary" className="font-mono">{visible.length} agents</Badge>
      </div>
      <div className="rounded-lg border bg-card overflow-hidden">
        <div className="overflow-x-auto max-h-[65vh]">
          <Table>
            <TableHeader className="sticky top-0 bg-muted/80 backdrop-blur z-10">
              <TableRow>
                <Th id="__agent__" label="Agent" align="left" />
                <Th id="__calls__" label="Calls" tip="Total number of calls (inbound + outbound) in the selected period." />
                <Th id="__outbound__" label="Outbound" tone="text-fuchsia-400" tip="Calls the agent placed to customers." />
                <Th id="__inbound__" label="Inbound" tone="text-cyan-400" tip="Calls received from customers." />
                <Th id="__answered__" label="Answered" tone="text-emerald-400" tip="Calls where a real conversation happened. Inbound: agent picked up. Outbound: customer stayed on for 60+ seconds." />
                <Th id="__missed__" label="Missed" tone="text-rose-400" tip="Calls where no one answered at all — phone rang but nothing picked up." />
                <Th id="__vm__" label="VM Left" tone="text-amber-400" tip="Outbound calls where the agent left a voicemail message (20–59s after VM answered)." />
                <Th id="__vmbrief__" label="No VM" tone="text-orange-400" tip="Outbound calls that reached voicemail but the agent hung up without leaving a message." />
                <Th id="__unique__" label="CX Reached" tone="text-sky-400" tip="Unique phone numbers the agent dialed outbound. Each number counted once no matter how many times they called it." />
                <Th id="__time__" label="Talk time" tip="Total duration of all calls combined." />
                <Th id="__resp__" label="Response %" tone="text-amber-400" tip="Percentage of total calls that resulted in a real conversation (Answered ÷ Total Calls)." />
                <TableHead className="whitespace-nowrap text-right text-violet-400">Last call</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.length === 0 && (
                <TableRow>
                  <TableCell colSpan={12} className="text-center py-12 text-muted-foreground">No agents match the current filters.</TableCell>
                </TableRow>
              )}
              {visible.map((agent) => {
                const ph = getPhone(agent);
                const phoneKey = directKeys ? normalizeAgent(agent) : sheetToPhoneKey(agent);
                const isLive = liveAgents.has(phoneKey);
                return (
                  <TableRow key={agent} className="hover-elevate">
                    <TableCell className="font-medium whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        {isLive && (
                          <span className="relative flex h-2.5 w-2.5 shrink-0" title="On a live call now">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
                          </span>
                        )}
                        {agent}
                      </div>
                    </TableCell>
                    <TableCell className={`text-right tabular-nums font-mono ${!ph?.calls ? "text-muted-foreground/40" : ""}`}>{ph?.calls ?? "—"}</TableCell>
                    <TableCell className={`text-right tabular-nums font-mono ${ph?.outbound ? "text-fuchsia-400" : "text-muted-foreground/40"}`}>{ph?.outbound ?? "—"}</TableCell>
                    <TableCell className={`text-right tabular-nums font-mono ${ph?.inbound ? "text-cyan-400" : "text-muted-foreground/40"}`}>{ph?.inbound ?? "—"}</TableCell>
                    <TableCell className={`text-right tabular-nums font-mono ${ph?.answered ? "text-emerald-400" : "text-muted-foreground/40"}`}>{ph?.answered ?? "—"}</TableCell>
                    <TableCell className={`text-right tabular-nums font-mono ${ph?.missed ? "text-rose-400" : "text-muted-foreground/40"}`}>{ph?.missed ?? "—"}</TableCell>
                    <TableCell className={`text-right tabular-nums font-mono ${ph?.voicemail ? "text-amber-400" : "text-muted-foreground/40"}`}>{ph?.voicemail ?? "—"}</TableCell>
                    <TableCell className={`text-right tabular-nums font-mono ${ph?.vmBrief ? "text-orange-400" : "text-muted-foreground/40"}`}>{ph?.vmBrief ?? "—"}</TableCell>
                    <TableCell className={`text-right tabular-nums font-mono ${ph?.uniqueContacts ? "text-sky-400" : "text-muted-foreground/40"}`}>{ph?.uniqueContacts ?? "—"}</TableCell>
                    <TableCell className={`text-right tabular-nums font-mono ${!ph?.seconds ? "text-muted-foreground/40" : ""}`}>{ph?.seconds ? formatDuration(ph.seconds) : "—"}</TableCell>
                    <TableCell className={`text-right tabular-nums font-mono ${ph?.calls ? "text-amber-400" : "text-muted-foreground/40"}`}>{ph ? responseRate(ph.answered, ph.calls) : "—"}</TableCell>
                    <TableCell className="text-right"><TimeSince isoStr={ph?.lastCallAt} /></TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
            {visible.length > 0 && (
              <TableHeader className="sticky bottom-0 bg-muted/80 backdrop-blur z-10">
                <TableRow>
                  <TableCell className="font-bold">Whole team</TableCell>
                  <TableCell className="text-right tabular-nums font-mono font-bold">{totCalls || "—"}</TableCell>
                  <TableCell className="text-right tabular-nums font-mono font-bold text-fuchsia-400">{totOut || "—"}</TableCell>
                  <TableCell className="text-right tabular-nums font-mono font-bold text-cyan-400">{totIn || "—"}</TableCell>
                  <TableCell className="text-right tabular-nums font-mono font-bold text-emerald-400">{totAns || "—"}</TableCell>
                  <TableCell className="text-right tabular-nums font-mono font-bold text-rose-400">{totMissed || "—"}</TableCell>
                  <TableCell className="text-right tabular-nums font-mono font-bold text-amber-400">{totVm || "—"}</TableCell>
                  <TableCell className="text-right tabular-nums font-mono font-bold text-orange-400">{totVmBrief || "—"}</TableCell>
                  <TableCell className="text-right tabular-nums font-mono font-bold text-sky-400">{totUniq || "—"}</TableCell>
                  <TableCell className="text-right tabular-nums font-mono font-bold">{totSecs ? formatDuration(totSecs) : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums font-mono font-bold text-amber-400">{responseRate(totAns, totCalls)}</TableCell>
                  <TableCell />
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

type Preset = { label: string; from: string; to: string };

function getPresets(): Preset[] {
  const now = new Date();
  const today = toIsoDate(now);
  const yesterday = toIsoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const firstOfMonth = toIsoDate(new Date(now.getFullYear(), now.getMonth(), 1));
  const firstOfLastMonth = toIsoDate(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const lastOfLastMonth = toIsoDate(new Date(now.getFullYear(), now.getMonth(), 0));
  return [
    { label: "Today", from: today, to: today },
    { label: "Yesterday", from: yesterday, to: yesterday },
    { label: "This Month", from: firstOfMonth, to: today },
    { label: "Last Month", from: firstOfLastMonth, to: lastOfLastMonth },
    { label: "All time", from: "2024-01-01", to: today },
  ];
}

function PresetFilter({ from, to, setFrom, setTo }: { from: string; to: string; setFrom: (s: string) => void; setTo: (s: string) => void }) {
  const presets = useMemo(() => getPresets(), []);
  const active = presets.find((p) => p.from === from && p.to === to)?.label;
  const todayIso = toIsoDate(new Date());
  return (
    <div className="flex gap-2 flex-wrap items-center">
      <CalendarDays className="h-3.5 w-3.5 text-muted-foreground" />
      {presets.map((p) => (
        <Button
          key={p.label}
          variant={active === p.label ? "default" : "outline"}
          size="sm"
          className={active === p.label ? "bg-violet-600 hover:bg-violet-700 text-white" : ""}
          onClick={() => { setFrom(p.from); setTo(p.to); }}
        >
          {p.label}
        </Button>
      ))}
      <span className="text-muted-foreground text-xs mx-1">|</span>
      <input
        type="date"
        value={from}
        max={todayIso}
        onChange={(e) => { if (e.target.value) setFrom(e.target.value); }}
        className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-violet-500 w-[130px]"
        title="From date"
      />
      <span className="text-muted-foreground text-xs">–</span>
      <input
        type="date"
        value={to}
        max={todayIso}
        onChange={(e) => { if (e.target.value) setTo(e.target.value); }}
        className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-violet-500 w-[130px]"
        title="To date"
      />
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
  vmBrief: number;
  inbound: number;
  outbound: number;
  uniqueContacts: number;
  lastCallAt?: string;
}

interface PhoneAgentDay {
  totalCalls: number;
  talkSeconds: number;
  inbound: number;
  outbound: number;
  answered: number;
  missed: number;
  voicemail: number;
  vmBrief: number;
  uniqueContacts: number;
}

interface PhoneStatsResponse {
  teamStats: Record<string, Record<string, Record<string, PhoneAgentDay>>>;
  agentLastCall?: Record<string, Record<string, string>>;
}

function TeamPanel({
  urls,
  sheetKey,
  label,
  mode,
  statusQueryFn,
}: {
  urls: { status: string };
  sheetKey: string;
  label: string;
  mode: TeamMode;
  statusQueryFn?: () => Promise<SheetData>;
}) {
  const statusQ = useQuery({
    queryKey: ["status", sheetKey],
    queryFn: statusQueryFn ?? (() => fetchHeaderCsv(urls.status)),
    staleTime: 1000 * 10,
    refetchOnWindowFocus: true,
    refetchInterval: 15 * 1000,
  });
  const isLoading = statusQ.isLoading;
  const isFetching = statusQ.isFetching;
  const error = statusQ.error;

  const todayIso = toIsoDate(new Date());
  const [from, setFrom] = useState(todayIso);
  const [to, setTo] = useState(todayIso);
  const [dayAgentFilter, setDayAgentFilter] = useState("");

  const fromDate = from ? parseDate(from) : null;
  const toDate = to ? parseDate(to) : null;
  if (toDate) toDate.setHours(23, 59, 59, 999);

  const phoneQ = useQuery<PhoneStatsResponse | null>({
    queryKey: ["phoneStats", mode, from, to],
    queryFn: async () => {
      const pFrom = from ? new Date(`${from}T00:00:00`).toISOString() : new Date(Date.now() - 30 * 86400000).toISOString();
      const pTo = to ? new Date(`${to}T23:59:59`).toISOString() : new Date().toISOString();
      const res = await fetch(`/api/quo/stats?from=${encodeURIComponent(pFrom)}&to=${encodeURIComponent(pTo)}`);
      if (!res.ok) return null;
      return res.json() as Promise<PhoneStatsResponse>;
    },
    staleTime: 1000 * 10,
    refetchOnWindowFocus: true,
    refetchInterval: 15 * 1000,
  });

  const phoneData = useMemo<Map<string, PhoneAgentMetrics>>(() => {
    const allowlist = TEAM_ALLOWLIST[mode];
    const map = new Map<string, PhoneAgentMetrics>();
    const agentStats = phoneQ.data?.teamStats?.[mode] ?? {};
    const lastCallMap = phoneQ.data?.agentLastCall?.[mode] ?? {};
    for (const [agentName, days] of Object.entries(agentStats)) {
      const rawKey = normalizeAgent(agentName);
      if (PHONE_BLOCKLIST.has(rawKey)) continue;
      const key = PHONE_ALIASES[rawKey] ?? rawKey;
      if (allowlist && !allowlist.has(key)) continue; // strict team allowlist
      const acc: PhoneAgentMetrics = { calls: 0, seconds: 0, answered: 0, missed: 0, voicemail: 0, vmBrief: 0, inbound: 0, outbound: 0, uniqueContacts: 0, lastCallAt: lastCallMap[agentName] };
      for (const day of Object.values(days)) {
        acc.calls += day.totalCalls ?? 0;
        acc.seconds += day.talkSeconds ?? 0;
        acc.answered += day.answered ?? 0;
        acc.missed += day.missed ?? 0;
        acc.voicemail += day.voicemail ?? 0;
        acc.vmBrief += day.vmBrief ?? 0;
        acc.inbound += day.inbound ?? 0;
        acc.outbound += day.outbound ?? 0;
        acc.uniqueContacts += day.uniqueContacts ?? 0;
      }
      if (acc.calls > 0 || acc.seconds > 0) {
        const e = map.get(key);
        if (e) {
          const mergedLast = e.lastCallAt && acc.lastCallAt ? (e.lastCallAt > acc.lastCallAt ? e.lastCallAt : acc.lastCallAt) : (e.lastCallAt ?? acc.lastCallAt);
          map.set(key, { calls: e.calls + acc.calls, seconds: e.seconds + acc.seconds, answered: e.answered + acc.answered, missed: e.missed + acc.missed, voicemail: e.voicemail + acc.voicemail, vmBrief: e.vmBrief + acc.vmBrief, inbound: e.inbound + acc.inbound, outbound: e.outbound + acc.outbound, uniqueContacts: e.uniqueContacts + acc.uniqueContacts, lastCallAt: mergedLast });
        } else {
          map.set(key, acc);
        }
      }
    }
    return map;
  }, [phoneQ.data, mode]);

  const aggregated = useMemo(() => {
    if (!statusQ.data) return null;
    return aggregate(statusQ.data, mode, fromDate, toDate);
  }, [statusQ.data, mode, from, to]);

  const aggregatedForDay = useMemo(() => {
    if (!statusQ.data) return null;
    return aggregate(statusQ.data, mode, fromDate, toDate, dayAgentFilter || undefined);
  }, [statusQ.data, mode, from, to, dayAgentFilter]);

  const dayAgentOptions = useMemo(() => {
    if (!aggregated || "error" in aggregated) return [];
    return aggregated.byAgent.map((a) => a.agent).sort((a, b) => a.localeCompare(b));
  }, [aggregated]);

  const phoneTotals = useMemo(() => {
    let calls = 0;
    let seconds = 0;
    for (const v of phoneData.values()) { calls += v.calls; seconds += v.seconds; }
    return { calls, seconds };
  }, [phoneData]);

  // Build the "By call" agent list:
  // 1. Sheet agents (best display names)
  // 2. Explicit TEAM_PHONE_EXTRAS not already covered
  // 3. Any remaining agent in phoneData (already team-filtered by OpenPhone line)
  const callAgentList = useMemo(() => {
    const result: string[] = [];
    const addedKeys = new Set<string>();

    // Sheet agents — prefer their display names
    if (aggregated && !("error" in aggregated)) {
      for (const { agent } of aggregated.byAgent) {
        const key = sheetToPhoneKey(agent);
        if (!addedKeys.has(key)) { result.push(agent); addedKeys.add(key); }
      }
    }

    // Explicit extras (e.g. Youssef Nasser, Michael Ross)
    for (const extra of TEAM_PHONE_EXTRAS[mode] ?? []) {
      const key = normalizeAgent(extra);
      if (!addedKeys.has(key)) { result.push(extra); addedKeys.add(key); }
    }

    // Everyone else who made calls on this team's OpenPhone lines
    for (const key of phoneData.keys()) {
      if (!addedKeys.has(key)) {
        result.push(key.replace(/\b\w/g, (c) => c.toUpperCase()));
        addedKeys.add(key);
      }
    }

    return result;
  }, [aggregated, phoneData, mode]);

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
            Calls, time, and outcomes · live from OpenPhone · syncs every 30 sec
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
        <PresetFilter from={from} to={to} setFrom={setFrom} setTo={setTo} />

        {(aggregated && !("error" in aggregated)) || callAgentList.length > 0 ? (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {aggregated && !("error" in aggregated) && (
                <StatTile label="Agents" value={aggregated.totals.agents} icon={<Users className="h-3.5 w-3.5" />} tone="violet" />
              )}
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
              {aggregated && !("error" in aggregated) && (mode === "nsf" ? (
                <>
                  <StatTile label="Today's fixed" value={aggregated.todayCount.toLocaleString()} tone="emerald" />
                  <StatTile label="This month's fixed" value={aggregated.monthCount.toLocaleString()} tone="emerald" />
                  <StatTile label="Total fixed" value={aggregated.totals.grand.toLocaleString()} tone="violet" />
                </>
              ) : (
                <>
                  <StatTile label="Today's retains" value={aggregated.todayRetained.toLocaleString()} tone="emerald" />
                  <StatTile label="This month's retains" value={aggregated.monthRetained.toLocaleString()} tone="emerald" />
                  <StatTile label="This month's cancels" value={aggregated.monthCancelled.toLocaleString()} tone="rose" />
                  <StatTile label="Retention rate" value={retentionRate(aggregated.totals.retained, aggregated.totals.grand)} tone="violet" />
                </>
              ))}
            </div>

            <Tabs defaultValue="call" className="space-y-4">
              <TabsList>
                <TabsTrigger value="call" data-testid="subtab-call">By call</TabsTrigger>
                {aggregated && !("error" in aggregated) && (
                  <>
                    <TabsTrigger value="files" data-testid="subtab-agent">By files</TabsTrigger>
                    <TabsTrigger value="day" data-testid="subtab-day">By day</TabsTrigger>
                  </>
                )}
              </TabsList>
              <TabsContent value="call">
                <ByCallStatsView agentList={callAgentList} phoneData={phoneData} />
              </TabsContent>
              {aggregated && !("error" in aggregated) && (
                <>
                  <TabsContent value="files">
                    <ByFilesView data={aggregated} />
                  </TabsContent>
                  <TabsContent value="day">
                    <div className="space-y-3">
                      {dayAgentOptions.length > 0 && (
                        <div className="flex items-center gap-2">
                          <select
                            value={dayAgentFilter}
                            onChange={(e) => setDayAgentFilter(e.target.value)}
                            className="text-sm rounded-md border border-white/10 bg-card px-3 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-violet-500"
                          >
                            <option value="">All agents</option>
                            {dayAgentOptions.map((n) => (
                              <option key={n} value={n}>{n}</option>
                            ))}
                          </select>
                          {dayAgentFilter && (
                            <button
                              type="button"
                              onClick={() => setDayAgentFilter("")}
                              className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
                            >
                              Clear
                            </button>
                          )}
                        </div>
                      )}
                      {aggregatedForDay && !("error" in aggregatedForDay) && (
                        <ByDayView data={aggregatedForDay} />
                      )}
                    </div>
                  </TabsContent>
                </>
              )}
            </Tabs>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

const CS_AGENTS = ["Nora Adam", "Leo Carter", "Carla Bennet"];

function CSPanel() {
  const todayIso = toIsoDate(new Date());
  const [from, setFrom] = useState(todayIso);
  const [to, setTo] = useState(todayIso);

  const phoneQ = useQuery<PhoneStatsResponse | null>({
    queryKey: ["phoneStats", "cs", from, to],
    queryFn: async () => {
      const pFrom = from ? new Date(`${from}T00:00:00`).toISOString() : new Date(Date.now() - 30 * 86400000).toISOString();
      const pTo = to ? new Date(`${to}T23:59:59`).toISOString() : new Date().toISOString();
      const res = await fetch(`/api/quo/stats?from=${encodeURIComponent(pFrom)}&to=${encodeURIComponent(pTo)}`);
      if (!res.ok) return null;
      return res.json() as Promise<PhoneStatsResponse>;
    },
    staleTime: 1000 * 10,
    refetchOnWindowFocus: true,
    refetchInterval: 15 * 1000,
  });

  const phoneData = useMemo<Map<string, PhoneAgentMetrics>>(() => {
    const allowlist = TEAM_ALLOWLIST["cs"];
    const map = new Map<string, PhoneAgentMetrics>();
    const agentStats = phoneQ.data?.teamStats?.["cs"] ?? {};
    const lastCallMap = phoneQ.data?.agentLastCall?.["cs"] ?? {};
    for (const [agentName, days] of Object.entries(agentStats)) {
      const rawKey = normalizeAgent(agentName);
      if (PHONE_BLOCKLIST.has(rawKey)) continue;
      const key = PHONE_ALIASES[rawKey] ?? rawKey;
      if (allowlist && !allowlist.has(key)) continue; // strict team allowlist
      const acc: PhoneAgentMetrics = { calls: 0, seconds: 0, answered: 0, missed: 0, voicemail: 0, vmBrief: 0, inbound: 0, outbound: 0, uniqueContacts: 0, lastCallAt: lastCallMap[agentName] };
      for (const day of Object.values(days)) {
        acc.calls += day.totalCalls ?? 0;
        acc.seconds += day.talkSeconds ?? 0;
        acc.answered += day.answered ?? 0;
        acc.missed += day.missed ?? 0;
        acc.voicemail += day.voicemail ?? 0;
        acc.vmBrief += day.vmBrief ?? 0;
        acc.inbound += day.inbound ?? 0;
        acc.outbound += day.outbound ?? 0;
        acc.uniqueContacts += day.uniqueContacts ?? 0;
      }
      if (acc.calls > 0 || acc.seconds > 0) {
        const e = map.get(key);
        if (e) {
          const mergedLast = e.lastCallAt && acc.lastCallAt ? (e.lastCallAt > acc.lastCallAt ? e.lastCallAt : acc.lastCallAt) : (e.lastCallAt ?? acc.lastCallAt);
          map.set(key, { calls: e.calls + acc.calls, seconds: e.seconds + acc.seconds, answered: e.answered + acc.answered, missed: e.missed + acc.missed, voicemail: e.voicemail + acc.voicemail, vmBrief: e.vmBrief + acc.vmBrief, inbound: e.inbound + acc.inbound, outbound: e.outbound + acc.outbound, uniqueContacts: e.uniqueContacts + acc.uniqueContacts, lastCallAt: mergedLast });
        } else {
          map.set(key, acc);
        }
      }
    }
    return map;
  }, [phoneQ.data]);

  const allAgents = useMemo(() => {
    // phoneData is already filtered by allowlist; prefer CS_AGENTS display names, fill rest from phoneData
    const result: string[] = [];
    const addedKeys = new Set<string>();
    for (const a of CS_AGENTS) {
      const k = normalizeAgent(a);
      if (!addedKeys.has(k)) { result.push(a); addedKeys.add(k); }
    }
    for (const k of phoneData.keys()) {
      if (!addedKeys.has(k)) {
        result.push(k.replace(/\b\w/g, (c) => c.toUpperCase()));
        addedKeys.add(k);
      }
    }
    return result;
  }, [phoneData]);

  const totals = useMemo(() => {
    let calls = 0, seconds = 0, answered = 0, missed = 0, uniqueContacts = 0;
    for (const v of phoneData.values()) {
      calls += v.calls; seconds += v.seconds; answered += v.answered; missed += v.missed; uniqueContacts += v.uniqueContacts;
    }
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

        <PresetFilter from={from} to={to} setFrom={setFrom} setTo={setTo} />

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatTile label="Agents" value={CS_AGENTS.length} icon={<Users className="h-3.5 w-3.5" />} tone="violet" />
          <StatTile label="Total calls" value={totals.calls.toLocaleString()} icon={<Phone className="h-3.5 w-3.5" />} tone="sky" />
          <StatTile label="Answered" value={totals.answered.toLocaleString()} tone="emerald" />
          <StatTile label="Missed" value={totals.missed.toLocaleString()} tone="rose" />
          <StatTile label="Time on calls" value={formatHours(totals.seconds)} icon={<Clock className="h-3.5 w-3.5" />} tone="amber" />
          <StatTile label="Response rate" value={responseRate(totals.answered, totals.calls)} tone="amber" />
        </div>

        <ByCallStatsView agentList={allAgents} phoneData={phoneData} />
      </CardContent>
    </Card>
  );
}

interface CallRecord {
  id: string;
  lineTeam: string;
  lineName: string;
  agentName: string | null;
  participant: string;
  direction: string;
  status: string;
  durationSeconds: number;
  createdAt: string;
}

function directionIcon(dir: string) {
  if (dir === "outgoing") return <PhoneOutgoing className="h-3.5 w-3.5 text-fuchsia-400" />;
  return <PhoneIncoming className="h-3.5 w-3.5 text-cyan-400" />;
}

function statusIcon(status: string) {
  if (status === "completed") return <span className="text-emerald-400 text-xs font-semibold">Answered</span>;
  if (status === "voicemail") return <span className="text-amber-400 text-xs font-semibold">VM Left</span>;
  if (status === "voicemail-brief") return <span className="text-orange-400 text-xs font-semibold">No VM</span>;
  if (status === "missed" || status === "no-answer") return <span className="text-rose-400 text-xs font-semibold">Missed</span>;
  if (status === "in-progress") return <span className="text-sky-400 text-xs font-semibold">Live</span>;
  return <span className="text-muted-foreground text-xs">{status}</span>;
}

function ByCallView({ team, from, to }: { team: string; from: string; to: string }) {
  const pFrom = from ? new Date(`${from}T00:00:00`).toISOString() : new Date(Date.now() - 30 * 86400000).toISOString();
  const pTo = to ? new Date(`${to}T23:59:59`).toISOString() : new Date().toISOString();

  const q = useQuery<{ data: CallRecord[] } | null>({
    queryKey: ["calls", team, pFrom, pTo],
    queryFn: async () => {
      const url = `/api/quo/calls?team=${team}&from=${encodeURIComponent(pFrom)}&to=${encodeURIComponent(pTo)}&limit=500`;
      const r = await fetch(url);
      if (!r.ok) return null;
      return r.json() as Promise<{ data: CallRecord[] }>;
    },
    staleTime: 1000 * 10,
    refetchOnWindowFocus: true,
    refetchInterval: 15 * 1000,
  });

  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ col: string; dir: "asc" | "desc" }>({ col: "createdAt", dir: "desc" });

  const calls = useMemo(() => {
    const raw = q.data?.data ?? [];
    const filtered = search
      ? raw.filter(
          (c) =>
            (c.agentName ?? "").toLowerCase().includes(search.toLowerCase()) ||
            c.participant.includes(search) ||
            c.lineName.toLowerCase().includes(search.toLowerCase()),
        )
      : raw;
    return [...filtered].sort((a, b) => {
      let av: string | number = a[sort.col as keyof CallRecord] as string | number ?? "";
      let bv: string | number = b[sort.col as keyof CallRecord] as string | number ?? "";
      if (sort.col === "durationSeconds") { av = Number(av); bv = Number(bv); }
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sort.dir === "asc" ? cmp : -cmp;
    });
  }, [q.data, search, sort]);

  function toggleSort(col: string) {
    setSort((s) => s.col === col ? { col, dir: s.dir === "asc" ? "desc" : "asc" } : { col, dir: "desc" });
  }

  function SortTh({ col, label, align = "left" }: { col: string; label: string; align?: "left" | "right" }) {
    const active = sort.col === col;
    return (
      <TableHead className={align === "right" ? "text-right" : ""}>
        <button type="button" onClick={() => toggleSort(col)}
          className={`inline-flex items-center gap-1 font-semibold hover:text-foreground ${active ? "text-violet-300" : "text-muted-foreground"} ${align === "right" ? "flex-row-reverse" : ""}`}>
          {label}
          {active ? (sort.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : <ArrowUpDown className="h-3 w-3 opacity-40" />}
        </button>
      </TableHead>
    );
  }

  if (q.isLoading) return <TableSkeleton />;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search agent, number..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
        </div>
        <span className="text-sm text-muted-foreground">{calls.length.toLocaleString()} calls</span>
        <Button variant="ghost" size="sm" onClick={() => q.refetch()} disabled={q.isFetching}>
          <RefreshCw className={`h-4 w-4 mr-1 ${q.isFetching ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>
      <div className="rounded-lg border bg-card overflow-hidden">
        <div className="overflow-x-auto max-h-[65vh]">
          <Table>
            <TableHeader className="sticky top-0 bg-muted/80 backdrop-blur z-10">
              <TableRow>
                <SortTh col="createdAt" label="Date / Time" />
                <SortTh col="agentName" label="Agent" />
                <SortTh col="lineName" label="Line" />
                <TableHead>Dir</TableHead>
                <TableHead>Status</TableHead>
                <SortTh col="durationSeconds" label="Duration" align="right" />
                <TableHead>External #</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {calls.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-12 text-muted-foreground">
                    No calls found for the selected range.
                  </TableCell>
                </TableRow>
              )}
              {calls.map((c) => (
                <TableRow key={c.id} className="hover-elevate text-sm">
                  <TableCell className="tabular-nums font-mono text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(c.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell className="font-medium whitespace-nowrap">{c.agentName ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground text-xs whitespace-nowrap">{c.lineName}</TableCell>
                  <TableCell>{directionIcon(c.direction)}</TableCell>
                  <TableCell>{statusIcon(c.status)}</TableCell>
                  <TableCell className="text-right tabular-nums font-mono">
                    {c.durationSeconds > 0 ? formatDuration(c.durationSeconds) : <span className="text-muted-foreground/40">—</span>}
                  </TableCell>
                  <TableCell className="tabular-nums font-mono text-muted-foreground text-xs">{c.participant || "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}

function PasswordGate({ children }: { children: React.ReactNode }) {
  const [authed, setAuthed] = useState(() => sessionStorage.getItem("tracker_authed") === "1");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const r = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (r.ok) {
        sessionStorage.setItem("tracker_authed", "1");
        setAuthed(true);
      } else {
        setError("Incorrect password. Try again.");
        setPassword("");
      }
    } catch {
      setError("Connection error. Try again.");
    } finally {
      setLoading(false);
    }
  }

  if (authed) return <>{children}</>;

  return (
    <div className="min-h-screen bg-background flex items-center justify-center relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -top-32 -left-32 h-[500px] w-[500px] rounded-full bg-violet-600/20 blur-[120px]" />
        <div className="absolute bottom-0 right-0 h-[400px] w-[400px] rounded-full bg-fuchsia-500/15 blur-[120px]" />
      </div>
      <div className="relative w-full max-w-sm mx-4">
        <div className="rounded-2xl border border-white/10 bg-card/80 backdrop-blur-xl p-8 space-y-6 shadow-2xl">
          <div className="flex flex-col items-center gap-3">
            <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center shadow-[0_0_24px_-6px_rgba(168,85,247,0.7)]">
              <Rocket className="h-6 w-6 text-white" />
            </div>
            <div className="text-center">
              <h1 className="text-xl font-bold bg-gradient-to-r from-violet-300 via-fuchsia-300 to-sky-300 bg-clip-text text-transparent">
                Backend Tracker
              </h1>
              <p className="text-sm text-muted-foreground mt-1">Enter your password to continue</p>
            </div>
          </div>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="pl-10"
                autoFocus
              />
            </div>
            {error && (
              <p className="text-sm text-rose-400 text-center">{error}</p>
            )}
            <Button type="submit" className="w-full bg-gradient-to-r from-violet-500 to-fuchsia-500 hover:from-violet-600 hover:to-fuchsia-600 text-white" disabled={loading || !password}>
              {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : "Sign in"}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}

interface QuoLine {
  id: string;
  name: string;
  formattedNumber: string;
  number: string;
  team: "retention" | "nsf" | "cs" | null;
  users: { id: string; firstName: string; lastName: string; email: string }[];
}

interface LineStatsResponse {
  agentStats: Record<string, Record<string, PhoneAgentDay>>;
  agentLastCall: Record<string, string>;
  lineInbounds?: { total: number; answered: number; missed: number };
  agentUniqueContactsAll?: Record<string, number>;
}

const LINE_TEAM_COLORS: Record<string, string> = {
  retention: "bg-violet-500/20 text-violet-300 border border-violet-500/30",
  nsf: "bg-amber-500/20 text-amber-300 border border-amber-500/30",
  cs: "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30",
};
const LINE_TEAM_LABELS: Record<string, string> = { retention: "Retention", nsf: "NSF", cs: "CS" };

function QuoLinesPanel() {
  const todayIso = toIsoDate(new Date());
  const [from, setFrom] = useState(todayIso);
  const [to, setTo] = useState(todayIso);
  const [selectedLine, setSelectedLine] = useState<QuoLine | null>(null);
  const [agentFilter, setAgentFilter] = useState("");
  const [dayFilter, setDayFilter] = useState("");

  const linesQ = useQuery<{ data: QuoLine[] }>({
    queryKey: ["allLines"],
    queryFn: async () => {
      const r = await fetch("/api/quo/all-lines");
      if (!r.ok) throw new Error("Failed to load lines");
      return r.json() as Promise<{ data: QuoLine[] }>;
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
  });

  const statsQ = useQuery<LineStatsResponse | null>({
    queryKey: ["lineStats", selectedLine?.id, from, to],
    queryFn: async () => {
      if (!selectedLine) return null;
      const pFrom = new Date(`${from}T00:00:00`).toISOString();
      const pTo = new Date(`${to}T23:59:59`).toISOString();
      const r = await fetch(
        `/api/quo/line-stats?lineId=${encodeURIComponent(selectedLine.id)}&from=${encodeURIComponent(pFrom)}&to=${encodeURIComponent(pTo)}`
      );
      if (!r.ok) return null;
      return r.json() as Promise<LineStatsResponse>;
    },
    enabled: !!selectedLine,
    staleTime: 1000 * 10,
    refetchInterval: 15 * 1000,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    setAgentFilter("");
    setDayFilter("");
  }, [selectedLine]);

  const availableDays = useMemo(() => {
    if (!statsQ.data) return [];
    const days = new Set<string>();
    for (const agentDays of Object.values(statsQ.data.agentStats)) {
      for (const d of Object.keys(agentDays)) days.add(d);
    }
    return Array.from(days).sort();
  }, [statsQ.data]);

  const allAgentNames = useMemo(() => {
    if (!statsQ.data) return [];
    return Object.keys(statsQ.data.agentStats)
      .filter((n) => !PHONE_BLOCKLIST.has(normalizeAgent(n)))
      .sort((a, b) => a.localeCompare(b));
  }, [statsQ.data]);

  const phoneData = useMemo<Map<string, PhoneAgentMetrics>>(() => {
    const map = new Map<string, PhoneAgentMetrics>();
    if (!statsQ.data) return map;
    const { agentStats, agentLastCall, agentUniqueContactsAll } = statsQ.data;
    for (const [agentName, days] of Object.entries(agentStats)) {
      const key = normalizeAgent(agentName);
      if (PHONE_BLOCKLIST.has(key)) continue;
      if (agentFilter && normalizeAgent(agentFilter) !== key) continue;
      const acc: PhoneAgentMetrics = {
        calls: 0, seconds: 0, answered: 0, missed: 0,
        voicemail: 0, vmBrief: 0, inbound: 0, outbound: 0,
        uniqueContacts: 0, lastCallAt: agentLastCall?.[agentName],
      };
      const dayEntries = dayFilter
        ? Object.entries(days).filter(([d]) => d === dayFilter)
        : Object.entries(days);
      for (const [, day] of dayEntries) {
        acc.calls += day.totalCalls ?? 0;
        acc.seconds += day.talkSeconds ?? 0;
        acc.answered += day.answered ?? 0;
        acc.missed += day.missed ?? 0;
        acc.voicemail += day.voicemail ?? 0;
        acc.vmBrief += day.vmBrief ?? 0;
        acc.inbound += day.inbound ?? 0;
        acc.outbound += day.outbound ?? 0;
        // Per-day unique used only when a day filter is active;
        // otherwise use the cross-range deduplicated count from the server.
        if (dayFilter) acc.uniqueContacts += day.uniqueContacts ?? 0;
      }
      // When no day filter, use the server's truly unique count (no double-counting across days)
      if (!dayFilter) acc.uniqueContacts = agentUniqueContactsAll?.[agentName] ?? acc.uniqueContacts;
      if (acc.outbound === 0 && acc.answered === 0) continue;
      if (acc.calls > 0 || acc.seconds > 0) {
        const existing = map.get(key);
        if (existing) {
          const mergedLast = existing.lastCallAt && acc.lastCallAt
            ? (existing.lastCallAt > acc.lastCallAt ? existing.lastCallAt : acc.lastCallAt)
            : (existing.lastCallAt ?? acc.lastCallAt);
          map.set(key, {
            calls: existing.calls + acc.calls, seconds: existing.seconds + acc.seconds,
            answered: existing.answered + acc.answered, missed: existing.missed + acc.missed,
            voicemail: existing.voicemail + acc.voicemail, vmBrief: existing.vmBrief + acc.vmBrief,
            inbound: existing.inbound + acc.inbound, outbound: existing.outbound + acc.outbound,
            uniqueContacts: existing.uniqueContacts + acc.uniqueContacts, lastCallAt: mergedLast,
          });
        } else {
          map.set(key, acc);
        }
      }
    }
    return map;
  }, [statsQ.data, agentFilter, dayFilter]);

  const agentList = useMemo(
    () => Array.from(phoneData.keys()).map((k) => k.replace(/\b\w/g, (c) => c.toUpperCase())),
    [phoneData]
  );

  const lineTotals = useMemo(() => {
    let calls = 0, seconds = 0;
    for (const v of phoneData.values()) { calls += v.calls; seconds += v.seconds; }
    return { calls, seconds };
  }, [phoneData]);

  const lineInbounds = statsQ.data?.lineInbounds;
  const isFiltered = agentFilter !== "" || dayFilter !== "";

  if (selectedLine) {
    return (
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0 gap-4">
          <div>
            <button
              type="button"
              onClick={() => setSelectedLine(null)}
              className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mb-2"
            >
              <ChevronLeft className="h-4 w-4" />
              Back to all lines
            </button>
            <CardTitle className="text-xl flex items-center gap-2">
              <PhoneCall className="h-5 w-5 text-violet-400" />
              {selectedLine.name}
              {selectedLine.team && (
                <span className={`text-xs px-1.5 py-0.5 rounded ${LINE_TEAM_COLORS[selectedLine.team]}`}>
                  {LINE_TEAM_LABELS[selectedLine.team]}
                </span>
              )}
            </CardTitle>
            <p className="text-sm text-muted-foreground mt-1">{selectedLine.formattedNumber} · Agent analytics</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => statsQ.refetch()} disabled={statsQ.isFetching}>
            <RefreshCw className={`h-4 w-4 mr-2 ${statsQ.isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </CardHeader>
        <CardContent className="space-y-6">
          <PresetFilter from={from} to={to} setFrom={setFrom} setTo={setTo} />
          {!statsQ.isLoading && allAgentNames.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={agentFilter}
                onChange={(e) => setAgentFilter(e.target.value)}
                className="text-sm rounded-md border border-white/10 bg-card px-3 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-violet-500"
              >
                <option value="">All agents</option>
                {allAgentNames.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
              <select
                value={dayFilter}
                onChange={(e) => setDayFilter(e.target.value)}
                className="text-sm rounded-md border border-white/10 bg-card px-3 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-violet-500"
              >
                <option value="">All days</option>
                {availableDays.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
              {isFiltered && (
                <button
                  type="button"
                  onClick={() => { setAgentFilter(""); setDayFilter(""); }}
                  className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
                >
                  Clear filters
                </button>
              )}
            </div>
          )}
          {(lineTotals.calls > 0 || (lineInbounds?.total ?? 0) > 0) && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatTile label="Total calls" value={lineTotals.calls.toLocaleString()} icon={<Phone className="h-3.5 w-3.5" />} tone="sky" />
              <StatTile label="Time on calls" value={formatHours(lineTotals.seconds)} icon={<Clock className="h-3.5 w-3.5" />} tone="amber" />
              <StatTile label="Agents active" value={agentList.length.toLocaleString()} icon={<Users className="h-3.5 w-3.5" />} tone="violet" />
              {(lineInbounds?.total ?? 0) > 0 && !isFiltered && (
                <StatTile
                  label="Missed inbounds"
                  value={lineInbounds!.missed.toLocaleString()}
                  icon={<PhoneIncoming className="h-3.5 w-3.5" />}
                  tone="rose"
                  sub={lineInbounds!.answered > 0 ? `${lineInbounds!.answered} answered` : undefined}
                />
              )}
            </div>
          )}
          {statsQ.isLoading && <TableSkeleton />}
          {!statsQ.isLoading && agentList.length > 0 && (
            <ByCallStatsView agentList={agentList} phoneData={phoneData} directKeys={true} />
          )}
          {!statsQ.isLoading && agentList.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">
              {isFiltered ? "No calls match the selected filters." : "No calls on this line in the selected period."}
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  const lines = linesQ.data?.data ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0 gap-4">
        <div>
          <CardTitle className="text-xl">Quo Lines</CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            All OpenPhone lines · click any line to view per-agent analytics
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => linesQ.refetch()} disabled={linesQ.isFetching}>
          <RefreshCw className={`h-4 w-4 mr-2 ${linesQ.isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-6">
        <PresetFilter from={from} to={to} setFrom={setFrom} setTo={setTo} />
        {linesQ.isLoading && <TableSkeleton />}
        {linesQ.error && (
          <ErrorState message="Failed to load lines." onRetry={() => linesQ.refetch()} />
        )}
        {lines.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            {lines.map((line) => (
              <button
                key={line.id}
                type="button"
                onClick={() => setSelectedLine(line)}
                className="text-left p-4 rounded-lg border bg-card hover:bg-accent/40 hover:border-violet-500/50 transition-all group"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-sm truncate group-hover:text-violet-300 transition-colors">
                      {line.name}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5 font-mono">{line.formattedNumber}</div>
                  </div>
                  {line.team && (
                    <span className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${LINE_TEAM_COLORS[line.team]}`}>
                      {LINE_TEAM_LABELS[line.team]}
                    </span>
                  )}
                </div>
                {line.users && line.users.length > 0 && (
                  <div className="mt-2 text-xs text-muted-foreground/70 truncate">
                    {line.users.map((u) => `${u.firstName} ${u.lastName}`).join(", ")}
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
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
          <TabsList className="grid w-full max-w-xl grid-cols-4">
            <TabsTrigger value="retention" data-testid="tab-retention">Retention Team</TabsTrigger>
            <TabsTrigger value="nsf" data-testid="tab-nsf">NSF Team</TabsTrigger>
            <TabsTrigger value="cs" data-testid="tab-cs">CS Team</TabsTrigger>
            <TabsTrigger value="quo-lines" data-testid="tab-quo-lines">Quo Lines</TabsTrigger>
          </TabsList>
          <TabsContent value="retention">
            <TeamPanel urls={RETENTION} sheetKey="retention" label="Retention Team" mode="retention" statusQueryFn={fetchRetentionCombinedSheet} />
          </TabsContent>
          <TabsContent value="nsf">
            <TeamPanel urls={NSF} sheetKey="nsf" label="NSF Team" mode="nsf" statusQueryFn={fetchNSFCombinedSheet} />
          </TabsContent>
          <TabsContent value="cs">
            <CSPanel />
          </TabsContent>
          <TabsContent value="quo-lines">
            <QuoLinesPanel />
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
        <PasswordGate>
          <Dashboard />
        </PasswordGate>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
