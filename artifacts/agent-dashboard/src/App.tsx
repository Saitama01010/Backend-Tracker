import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { createContext, useContext, Fragment, useEffect, useMemo, useState, useCallback } from "react";
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
  LogOut,
  ShieldCheck,
  UserCog,
  Eye,
  Pencil,
  ShieldAlert,
  X,
  Plus,
  KeyRound,
  UserCheck,
  UserX,
  PhoneOff,
  Filter,
} from "lucide-react";

const queryClient = new QueryClient();

// ─── Auth Context ────────────────────────────────────────────────────────────

type Permission = "view_metrics" | "view_attendance" | "edit_attendance" | "manage_members";
const ALL_PERMISSIONS: { key: Permission; label: string; desc: string }[] = [
  { key: "view_metrics",     label: "View Metrics",       desc: "See Retention, NSF, CS & Quo Lines tabs" },
  { key: "view_attendance",  label: "View Attendance",    desc: "See the Attendance grid" },
  { key: "edit_attendance",  label: "Edit Attendance",    desc: "Click cells to mark status & add notes" },
  { key: "manage_members",   label: "Manage Members",     desc: "Add, edit, or remove attendance members" },
];

type TeamAccess = "retention" | "nsf" | "cs";
interface AuthUser { id: number; username: string; role: "admin" | "edit" | "view"; permissions: Permission[]; teamAccess?: TeamAccess | null; }
interface AuthCtx { user: AuthUser; token: string; logout: () => void; can: (p: Permission) => boolean; }
const UserContext = createContext<AuthCtx | null>(null);
function useUser() {
  const ctx = useContext(UserContext);
  if (!ctx) throw new Error("useUser must be used inside LoginGate");
  return ctx;
}
function authHeaders(token: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

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
    // Jacob Stephenson / Abdulrhman Isawi
    "jacob stephenson", "abdulrhman isawi",
    // Ryan Henderson
    "ryan henderson",
    // Rick Miller / Zeiad Fouad
    "rick miller", "zeiad fouad",
    // Henry Hart
    "henry hart",
    // Chase Miller
    "chase miller",
    // Katherine Adams
    "katherine adams",
    // Leo Carter
    "leo carter",
    // Legacy extras kept for historical data
    "max francis",
    "youssef nasser",
    "michael ross",
  ]),
  nsf: new Set([
    "alex cruz", "austin white", "rika hart", "jenny morgan",
    "estella cruz", "katie miller", "ellie moser",
  ]),
  cs: new Set([
    // Levi Miller / Ahmed Ayman
    "levi miller", "ahmed ayman",
    // Ella Monroe / Hiba Kamil
    "ella monroe", "hiba kamil",
    // Michael Belfort
    "michael belfort",
    // Nora Adam
    "nora adam",
    // Jacob Xander / Youssef Nady
    "jacob xander", "youssef nady",
    // Talia Morgan
    "talia morgan",
    // Carla Bennet
    "carla bennet",
  ]),
};

// Merges duplicate phone accounts that belong to the same real person
const PHONE_ALIASES: Record<string, string> = {
  "mike johnson": "youssef nasser",
  "john marcus": "youssef nasser",
  "youssef-john marcus": "youssef nasser",
  // Retention: Arabic OpenPhone name → English display name
  "abdulrhman isawi": "jacob stephenson",
  "zeiad fouad": "rick miller",
  // CS: Arabic OpenPhone name → English display name
  "ahmed ayman": "levi miller",
  "hiba kamil": "ella monroe",
  "youssef nady": "jacob xander",
};

// Maps normalized SHEET agent name → normalized PBX (VoSLogic) agent name
// Format: "QuoName-PBXAlias" sheet entries decode as QuoName=Quo key, PBXAlias=PBX key
const SHEET_TO_PBX: Record<string, string> = {
  "ahmed ayman-levi miller": "levi miller",       // PBX: Levi Miller = Ahmed Ayman
  "youssef nady-jacob xander": "jacob xander",    // PBX: Jacob Xander = Youssef Nady
  "zeiad fouad-zack ford": "rick miller",          // PBX: Rick Miller = Zeiad Fouad
  "nour-michael belfort-2900": "michael belfort",  // PBX: Michael Belfort = Nour/Michael
  "mohammed ayman-max francis-2268": "max francis",
  "engy-ellie moser-2046": "ellie moser",
  "muhamed-ryan henderson": "jacob ahmed",         // PBX: Jacob Ahmed = Ryan Henderson
  "abdlrhman-jacob stephenson": "abdulrhman isawi",
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
  // Note: jacob stephenson, rick miller, levi miller, ella monroe, jacob xander
  // no longer need entries here — PHONE_ALIASES now maps their Arabic OpenPhone names
  // directly to these English display-name keys in the phone data map.
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

type PbxAgentEntry = {
  calls: number;
  inbound: number;
  outbound: number;
  answered: number;
  missed: number;
  voicemail: number;
  durationSeconds: number;
  lastCallAt: string | null;
  groups: string[];
};
type PbxCalls = Map<string, PbxAgentEntry>;

interface VosStatsResponse {
  dashboard: { callsByAgent: { agentName: string; calls: number; inbound: number; outbound: number }[] };
  agents: { id: number; name: string }[];
  ringGroups: { id: number; name: string; agentIds: number[] }[];
  callHistory?: { agentName: string; calls: number; inbound: number; outbound: number; answered: number; missed: number; voicemail: number; durationSeconds: number; lastCallAt: string | null }[];
  ringGroupMissed?: Record<number, number>;
}

function useVosStats() {
  return useQuery<VosStatsResponse>({
    queryKey: ["vosStats"],
    queryFn: async () => {
      const r = await fetch("/api/vos/stats");
      if (!r.ok) return { dashboard: { callsByAgent: [] }, agents: [], ringGroups: [], callHistory: [], ringGroupMissed: {} };
      return r.json();
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}

/** Returns missed call counts per ring group ID sourced from PBX voicemail/no-answer records. */
function useVosRingGroupMissed(): Map<number, number> {
  const q = useVosStats();
  return useMemo(() => {
    const raw = q.data?.ringGroupMissed ?? {};
    return new Map(Object.entries(raw).map(([k, v]) => [Number(k), v as number]));
  }, [q.data]);
}

function useVosCalls(): PbxCalls {
  const q = useVosStats();
  return useMemo(() => {
    const m: PbxCalls = new Map();
    const data = q.data;
    if (!data) return m;
    // Build agent ID → ring group names
    const agentGroups = new Map<number, string[]>();
    for (const g of data.ringGroups ?? []) {
      for (const id of g.agentIds) {
        if (!agentGroups.has(id)) agentGroups.set(id, []);
        agentGroups.get(id)!.push(g.name);
      }
    }
    // Build normalized PBX name → agent ID
    const nameToId = new Map<string, number>();
    for (const a of data.agents ?? []) {
      nameToId.set(normalizeAgent(a.name), a.id);
    }
    // Prefer callHistory (rich data) — fall back to dashboard callsByAgent
    const source = (data.callHistory?.length ? data.callHistory : data.dashboard?.callsByAgent) ?? [];
    for (const a of source) {
      const key = normalizeAgent(a.agentName);
      const id = nameToId.get(key);
      const groups = id !== undefined ? (agentGroups.get(id) ?? []) : [];
      const rich = a as { answered?: unknown; missed?: unknown; voicemail?: unknown; durationSeconds?: unknown; lastCallAt?: unknown };
      m.set(key, {
        calls: a.calls,
        inbound: a.inbound,
        outbound: a.outbound,
        answered: typeof rich.answered === "number" ? rich.answered : 0,
        missed: typeof rich.missed === "number" ? rich.missed : 0,
        voicemail: typeof rich.voicemail === "number" ? rich.voicemail : 0,
        durationSeconds: typeof rich.durationSeconds === "number" ? rich.durationSeconds : 0,
        lastCallAt: typeof rich.lastCallAt === "string" ? rich.lastCallAt : null,
        groups,
      });
    }
    return m;
  }, [q.data]);
}

interface MissedNoCallbackItem {
  id: string | number;
  fromNumber: string;
  toNumber: string;
  createdAt: string;
  ringGroupId: number;
  ringGroupName: string;
  team: "retention" | "nsf" | "cs" | "other";
  source?: "pbx" | "quo";
}

function useMissedNoCB() {
  return useQuery<{ items: MissedNoCallbackItem[]; fetchedAt: number }>({
    queryKey: ["missedNoCB"],
    queryFn: async () => {
      const r = await fetch("/api/vos/missed-no-callback");
      if (!r.ok) return { items: [], fetchedAt: 0 };
      return r.json();
    },
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true,
  });
}

function buildTeamPhoneData(teamMode: string, data: PhoneStatsResponse | null | undefined): Map<string, PhoneAgentMetrics> {
  const allowlist = TEAM_ALLOWLIST[teamMode];
  const map = new Map<string, PhoneAgentMetrics>();
  const agentStats = data?.teamStats?.[teamMode] ?? {};
  const lastCallMap = data?.agentLastCall?.[teamMode] ?? {};
  for (const [agentName, days] of Object.entries(agentStats)) {
    const rawKey = normalizeAgent(agentName);
    if (PHONE_BLOCKLIST.has(rawKey)) continue;
    const key = PHONE_ALIASES[rawKey] ?? rawKey;
    if (allowlist && !allowlist.has(key)) continue;
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
}

function ByCallStatsView({ agentList, phoneData, directKeys, pbxData, extraMissed, agentDept }: { agentList: string[]; phoneData: Map<string, PhoneAgentMetrics>; directKeys?: boolean; pbxData?: PbxCalls; extraMissed?: number; agentDept?: Map<string, "Retention" | "CS"> }) {
  const liveAgents = useLiveCalls();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ col: string; dir: "asc" | "desc" }>({ col: "__calls__", dir: "desc" });

  const getPhone = (agent: string) =>
    directKeys ? phoneData.get(normalizeAgent(agent)) : phoneData.get(sheetToPhoneKey(agent));

  const getPbx = (agent: string) => {
    if (!pbxData) return undefined;
    const norm = normalizeAgent(agent);
    if (directKeys) return pbxData.get(norm);
    // Check explicit PBX alias map first, then fall back to phone key
    const pbxKey = SHEET_TO_PBX[norm] ?? sheetToPhoneKey(agent);
    return pbxData.get(pbxKey);
  };

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const withCalls = agentList.filter((a) => (getPhone(a)?.calls ?? 0) > 0 || (getPbx(a)?.calls ?? 0) > 0);
    const list = q ? withCalls.filter((a) => a.toLowerCase().includes(q)) : withCalls;
    return [...list].sort((a, b) => {
      const phA = getPhone(a);
      const phB = getPhone(b);
      let av: number = 0;
      let bv: number = 0;
      if (sort.col === "__calls__") { av = (phA?.calls ?? 0) + (getPbx(a)?.calls ?? 0); bv = (phB?.calls ?? 0) + (getPbx(b)?.calls ?? 0); }
      else if (sort.col === "__outbound__") { av = (phA?.outbound ?? 0) + (getPbx(a)?.outbound ?? 0); bv = (phB?.outbound ?? 0) + (getPbx(b)?.outbound ?? 0); }
      else if (sort.col === "__inbound__") { av = (phA?.inbound ?? 0) + (getPbx(a)?.inbound ?? 0); bv = (phB?.inbound ?? 0) + (getPbx(b)?.inbound ?? 0); }
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
  }, [agentList, search, sort, phoneData, pbxData]);

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

  const totQuoCalls = visible.reduce((s, a) => s + (getPhone(a)?.calls ?? 0), 0);
  const totPbxCalls = visible.reduce((s, a) => s + (getPbx(a)?.calls ?? 0), 0);
  const totCalls = totQuoCalls + totPbxCalls;
  const totOut = visible.reduce((s, a) => s + (getPhone(a)?.outbound ?? 0) + (getPbx(a)?.outbound ?? 0), 0);
  const totIn = visible.reduce((s, a) => s + (getPhone(a)?.inbound ?? 0) + (getPbx(a)?.inbound ?? 0), 0);
  const totAns = visible.reduce((s, a) => s + (getPhone(a)?.answered ?? 0) + (getPbx(a)?.answered ?? 0), 0);
  const totMissed = visible.reduce((s, a) => s + (getPhone(a)?.missed ?? 0) + (getPbx(a)?.missed ?? 0), 0) + (extraMissed ?? 0);
  const totVm = visible.reduce((s, a) => s + (getPhone(a)?.voicemail ?? 0) + (getPbx(a)?.voicemail ?? 0), 0);
  const totVmBrief = visible.reduce((s, a) => s + (getPhone(a)?.vmBrief ?? 0), 0);
  const totUniq = visible.reduce((s, a) => s + (getPhone(a)?.uniqueContacts ?? 0), 0);
  const totSecs = visible.reduce((s, a) => s + (getPhone(a)?.seconds ?? 0) + (getPbx(a)?.durationSeconds ?? 0), 0);

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
                <TableHead className="whitespace-nowrap text-right text-violet-400">Last call</TableHead>
                <Th id="__calls__" label="Calls" tip="Total calls across all phone systems (Quo + PBX) in the selected period." />
                {pbxData && <Th id="__pbx__" label="PBX" tone="text-blue-400" tip="Calls via the PBX phone system only." />}
                <Th id="__outbound__" label="Outbound" tone="text-fuchsia-400" tip="Calls the agent placed to customers (all systems)." />
                <Th id="__inbound__" label="Inbound" tone="text-cyan-400" tip="Calls received from customers (all systems)." />
                <Th id="__answered__" label="Answered" tone="text-emerald-400" tip="Calls where a real conversation happened. Inbound: agent picked up. Outbound: customer stayed on for 60+ seconds." />
                <Th id="__missed__" label="Missed" tone="text-rose-400" tip="Calls where no one answered at all — phone rang but nothing picked up." />
                <Th id="__vm__" label="VM Left" tone="text-amber-400" tip="Outbound calls where the agent left a voicemail message (20–59s after VM answered)." />
                <Th id="__vmbrief__" label="No VM" tone="text-orange-400" tip="Outbound calls that reached voicemail but the agent hung up without leaving a message." />
                <Th id="__unique__" label="CX Reached" tone="text-sky-400" tip="Unique phone numbers the agent dialed outbound. Each number counted once no matter how many times they called it." />
                <Th id="__time__" label="Talk time" tip="Total duration of all calls combined." />
                <Th id="__resp__" label="Response %" tone="text-amber-400" tip="Percentage of total calls that resulted in a real conversation (Answered ÷ Total Calls)." />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.length === 0 && (
                <TableRow>
                  <TableCell colSpan={pbxData ? 13 : 12} className="text-center py-12 text-muted-foreground">No agents match the current filters.</TableCell>
                </TableRow>
              )}
              {visible.map((agent) => {
                const ph = getPhone(agent);
                const px = getPbx(agent);
                const combinedCalls = (ph?.calls ?? 0) + (px?.calls ?? 0);
                const combinedOut = (ph?.outbound ?? 0) + (px?.outbound ?? 0);
                const combinedIn = (ph?.inbound ?? 0) + (px?.inbound ?? 0);
                const combinedAns = (ph?.answered ?? 0) + (px?.answered ?? 0);
                const combinedMissed = (ph?.missed ?? 0) + (px?.missed ?? 0);
                const combinedVm = (ph?.voicemail ?? 0) + (px?.voicemail ?? 0);
                const combinedSecs = (ph?.seconds ?? 0) + (px?.durationSeconds ?? 0);
                const lastCall = ph?.lastCallAt && px?.lastCallAt
                  ? (ph.lastCallAt > px.lastCallAt ? ph.lastCallAt : px.lastCallAt)
                  : (ph?.lastCallAt ?? px?.lastCallAt ?? null);
                const phoneKey = directKeys ? normalizeAgent(agent) : sheetToPhoneKey(agent);
                const isLive = liveAgents.has(phoneKey);
                const dept = agentDept?.get(normalizeAgent(agent));
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
                        {dept && (
                          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold leading-none ${dept === "Retention" ? "bg-violet-500/20 text-violet-300 border border-violet-500/30" : "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"}`}>
                            {dept}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      {isLive
                        ? <span className="text-emerald-400 font-medium text-xs">On call</span>
                        : <TimeSince isoStr={lastCall ?? undefined} />
                      }
                    </TableCell>
                    <TableCell className={`text-right tabular-nums font-mono ${!combinedCalls ? "text-muted-foreground/40" : ""}`}>{combinedCalls || "—"}</TableCell>
                    {pbxData && <TableCell className={`text-right tabular-nums font-mono ${px?.calls ? "text-blue-400" : "text-muted-foreground/40"}`}>{px?.calls || "—"}</TableCell>}
                    <TableCell className={`text-right tabular-nums font-mono ${combinedOut ? "text-fuchsia-400" : "text-muted-foreground/40"}`}>{combinedOut || "—"}</TableCell>
                    <TableCell className={`text-right tabular-nums font-mono ${combinedIn ? "text-cyan-400" : "text-muted-foreground/40"}`}>{combinedIn || "—"}</TableCell>
                    <TableCell className={`text-right tabular-nums font-mono ${combinedAns ? "text-emerald-400" : "text-muted-foreground/40"}`}>{combinedAns || "—"}</TableCell>
                    <TableCell className={`text-right tabular-nums font-mono ${combinedMissed ? "text-rose-400" : "text-muted-foreground/40"}`}>{combinedMissed || "—"}</TableCell>
                    <TableCell className={`text-right tabular-nums font-mono ${combinedVm ? "text-amber-400" : "text-muted-foreground/40"}`}>{combinedVm || "—"}</TableCell>
                    <TableCell className={`text-right tabular-nums font-mono ${ph?.vmBrief ? "text-orange-400" : "text-muted-foreground/40"}`}>{ph?.vmBrief || "—"}</TableCell>
                    <TableCell className={`text-right tabular-nums font-mono ${ph?.uniqueContacts ? "text-sky-400" : "text-muted-foreground/40"}`}>{ph?.uniqueContacts || "—"}</TableCell>
                    <TableCell className={`text-right tabular-nums font-mono ${!combinedSecs ? "text-muted-foreground/40" : ""}`}>{combinedSecs ? formatDuration(combinedSecs) : "—"}</TableCell>
                    <TableCell className={`text-right tabular-nums font-mono ${combinedCalls ? "text-amber-400" : "text-muted-foreground/40"}`}>{(ph || px) ? responseRate(combinedAns, combinedCalls) : "—"}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
            {visible.length > 0 && (
              <TableHeader className="sticky bottom-0 bg-muted/80 backdrop-blur z-10">
                <TableRow>
                  <TableCell className="font-bold">Whole team</TableCell>
                  <TableCell />
                  <TableCell className="text-right tabular-nums font-mono font-bold">{totCalls || "—"}</TableCell>
                  {pbxData && <TableCell className="text-right tabular-nums font-mono font-bold text-blue-400">{totPbxCalls || "—"}</TableCell>}
                  <TableCell className="text-right tabular-nums font-mono font-bold text-fuchsia-400">{totOut || "—"}</TableCell>
                  <TableCell className="text-right tabular-nums font-mono font-bold text-cyan-400">{totIn || "—"}</TableCell>
                  <TableCell className="text-right tabular-nums font-mono font-bold text-emerald-400">{totAns || "—"}</TableCell>
                  <TableCell className="text-right tabular-nums font-mono font-bold text-rose-400">{totMissed || "—"}</TableCell>
                  <TableCell className="text-right tabular-nums font-mono font-bold text-amber-400">{totVm || "—"}</TableCell>
                  <TableCell className="text-right tabular-nums font-mono font-bold text-orange-400">{totVmBrief || "—"}</TableCell>
                  <TableCell className="text-right tabular-nums font-mono font-bold text-sky-400">{totUniq || "—"}</TableCell>
                  <TableCell className="text-right tabular-nums font-mono font-bold">{totSecs ? formatDuration(totSecs) : "—"}</TableCell>
                  <TableCell />
                  <TableCell className="text-right tabular-nums font-mono font-bold text-amber-400">{responseRate(totAns, totCalls)}</TableCell>
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
  const pbxData = useVosCalls();
  const ringGroupMissed = useVosRingGroupMissed();
  // Retention ring group = 2, Back-end (NSF) ring group = 3 in VoSLogic
  const pbxMissed = mode === "retention" ? (ringGroupMissed.get(2) ?? 0) : mode === "nsf" ? (ringGroupMissed.get(3) ?? 0) : 0;
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
    let calls = 0, seconds = 0, answered = 0;
    for (const v of phoneData.values()) { calls += v.calls; seconds += v.seconds; answered += v.answered; }
    return { calls, seconds, answered };
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

    // PBX-only agents: in the right ring group but not already listed or covered by a sheet alias
    const pbxRingGroup = mode === "retention" ? "Retention" : mode === "nsf" ? "Back-end" : null;
    // Don't add standalone rows for PBX names that are already covered as aliases via SHEET_TO_PBX
    const coveredPbxKeys = new Set(Object.values(SHEET_TO_PBX));
    if (pbxRingGroup && pbxData) {
      for (const [pbxKey, pbxAgent] of pbxData.entries()) {
        if (pbxAgent.groups.includes(pbxRingGroup) && !addedKeys.has(pbxKey) && !coveredPbxKeys.has(pbxKey)) {
          result.push(pbxKey.replace(/\b\w/g, (c) => c.toUpperCase()));
          addedKeys.add(pbxKey);
        }
      }
    }

    return result;
  }, [aggregated, phoneData, mode, pbxData]);

  const pbxTotals = useMemo(() => {
    if (!pbxData) return { calls: 0, answered: 0, seconds: 0 };
    let calls = 0, answered = 0, seconds = 0;
    for (const agent of callAgentList) {
      const norm = normalizeAgent(agent);
      const pbxKey = SHEET_TO_PBX[norm] ?? norm;
      const px = pbxData.get(pbxKey);
      calls += px?.calls ?? 0;
      answered += px?.answered ?? 0;
      seconds += px?.durationSeconds ?? 0;
    }
    return { calls, answered, seconds };
  }, [pbxData, callAgentList]);

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
                value={(phoneTotals.calls + pbxTotals.calls).toLocaleString()}
                icon={<Phone className="h-3.5 w-3.5" />}
                tone="sky"
              />
              <StatTile
                label="Answered"
                value={(phoneTotals.answered + pbxTotals.answered).toLocaleString()}
                tone="emerald"
              />
              <StatTile
                label="Time on calls"
                value={formatHours(phoneTotals.seconds + pbxTotals.seconds)}
                icon={<Clock className="h-3.5 w-3.5" />}
                tone="amber"
              />
              <StatTile
                label="Response rate"
                value={responseRate(phoneTotals.answered + pbxTotals.answered, phoneTotals.calls + pbxTotals.calls)}
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
                <ByCallStatsView agentList={callAgentList} phoneData={phoneData} pbxData={pbxData} extraMissed={pbxMissed} />
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

const CS_AGENTS = ["Levi Miller", "Ella Monroe", "Michael Belfort", "Nora Adam", "Jacob Xander", "Talia Morgan", "Carla Bennet"];
const RETENTION_AGENTS = ["Ryan Henderson", "Henry Hart", "Chase Miller", "Jacob Stephenson", "Katherine Adams", "Leo Carter", "Rick Miller"];

function CSPanel() {
  const pbxData = useVosCalls();
  const ringGroupMissed = useVosRingGroupMissed();
  // CS ring group ID = 4 in VoSLogic
  const pbxMissed = ringGroupMissed.get(4) ?? 0;
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
    // PBX-only agents in the Customer Support ring group
    if (pbxData) {
      for (const [pbxKey, pbxAgent] of pbxData.entries()) {
        if (pbxAgent.groups.includes("Customer Support") && !addedKeys.has(pbxKey)) {
          result.push(pbxKey.replace(/\b\w/g, (c) => c.toUpperCase()));
          addedKeys.add(pbxKey);
        }
      }
    }
    return result;
  }, [phoneData, pbxData]);

  const totals = useMemo(() => {
    let calls = 0, seconds = 0, answered = 0, missed = 0, uniqueContacts = 0;
    for (const v of phoneData.values()) {
      calls += v.calls; seconds += v.seconds; answered += v.answered; missed += v.missed; uniqueContacts += v.uniqueContacts;
    }
    return { calls, seconds, answered, missed, uniqueContacts };
  }, [phoneData]);

  // PBX call totals for agents in allAgents (each agent looked up by direct or alias key)
  const pbxTotals = useMemo(() => {
    if (!pbxData) return { calls: 0, answered: 0, seconds: 0 };
    let calls = 0, answered = 0, seconds = 0;
    for (const agent of allAgents) {
      const norm = normalizeAgent(agent);
      const pbxKey = SHEET_TO_PBX[norm] ?? norm;
      const px = pbxData.get(pbxKey);
      calls += px?.calls ?? 0;
      answered += px?.answered ?? 0;
      seconds += px?.durationSeconds ?? 0;
    }
    return { calls, answered, seconds };
  }, [pbxData, allAgents]);

  function refresh() { phoneQ.refetch(); }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0 gap-4">
        <div>
          <CardTitle className="text-xl">CS Team</CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Call activity · live from OpenPhone + PBX
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
          <StatTile label="Agents" value={allAgents.length} icon={<Users className="h-3.5 w-3.5" />} tone="violet" />
          <StatTile label="Total calls" value={(totals.calls + pbxTotals.calls).toLocaleString()} icon={<Phone className="h-3.5 w-3.5" />} tone="sky" />
          <StatTile label="Answered" value={(totals.answered + pbxTotals.answered).toLocaleString()} tone="emerald" />
          <StatTile label="Missed" value={(totals.missed + pbxMissed).toLocaleString()} tone="rose" />
          <StatTile label="Time on calls" value={formatHours(totals.seconds + pbxTotals.seconds)} icon={<Clock className="h-3.5 w-3.5" />} tone="amber" />
          <StatTile label="Response rate" value={responseRate(totals.answered + pbxTotals.answered, totals.calls + pbxTotals.calls)} tone="amber" />
        </div>

        <ByCallStatsView agentList={allAgents} phoneData={phoneData} pbxData={pbxData} extraMissed={pbxMissed} />
      </CardContent>
    </Card>
  );
}

function RetentionCSPanel() {
  const pbxData = useVosCalls();
  const ringGroupMissed = useVosRingGroupMissed();
  const pbxMissed = (ringGroupMissed.get(2) ?? 0) + (ringGroupMissed.get(4) ?? 0);

  const todayIso = toIsoDate(new Date());
  const [from, setFrom] = useState(todayIso);
  const [to, setTo] = useState(todayIso);
  const [dayAgentFilter, setDayAgentFilter] = useState("");

  const fromDate = from ? parseDate(from) : null;
  const toDate = to ? parseDate(to) : null;
  if (toDate) toDate.setHours(23, 59, 59, 999);

  const statusQ = useQuery({
    queryKey: ["status", "retention"],
    queryFn: fetchRetentionCombinedSheet,
    staleTime: 1000 * 10,
    refetchOnWindowFocus: true,
    refetchInterval: 15 * 1000,
  });

  const phoneQ = useQuery<PhoneStatsResponse | null>({
    queryKey: ["phoneStats", "backend", from, to],
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

  const aggregated = useMemo(() => {
    if (!statusQ.data) return null;
    return aggregate(statusQ.data, "retention", fromDate, toDate);
  }, [statusQ.data, from, to]);

  const aggregatedForDay = useMemo(() => {
    if (!statusQ.data) return null;
    return aggregate(statusQ.data, "retention", fromDate, toDate, dayAgentFilter || undefined);
  }, [statusQ.data, from, to, dayAgentFilter]);

  const dayAgentOptions = useMemo(() => {
    if (!aggregated || "error" in aggregated) return [];
    return aggregated.byAgent.map((a) => a.agent).sort((a, b) => a.localeCompare(b));
  }, [aggregated]);

  const retentionPhoneData = useMemo(() => buildTeamPhoneData("retention", phoneQ.data), [phoneQ.data]);
  const csPhoneData = useMemo(() => buildTeamPhoneData("cs", phoneQ.data), [phoneQ.data]);

  const combinedPhoneData = useMemo(() => {
    const merged = new Map(retentionPhoneData);
    for (const [key, val] of csPhoneData) {
      const e = merged.get(key);
      if (e) {
        const mergedLast = e.lastCallAt && val.lastCallAt ? (e.lastCallAt > val.lastCallAt ? e.lastCallAt : val.lastCallAt) : (e.lastCallAt ?? val.lastCallAt);
        merged.set(key, { calls: e.calls + val.calls, seconds: e.seconds + val.seconds, answered: e.answered + val.answered, missed: e.missed + val.missed, voicemail: e.voicemail + val.voicemail, vmBrief: e.vmBrief + val.vmBrief, inbound: e.inbound + val.inbound, outbound: e.outbound + val.outbound, uniqueContacts: e.uniqueContacts + val.uniqueContacts, lastCallAt: mergedLast });
      } else {
        merged.set(key, val);
      }
    }
    return merged;
  }, [retentionPhoneData, csPhoneData]);

  const { agentList, agentDept } = useMemo(() => {
    const dept = new Map<string, "Retention" | "CS">();
    const result: string[] = [];
    const addedKeys = new Set<string>();

    for (const a of RETENTION_AGENTS) {
      const k = normalizeAgent(a);
      if (!addedKeys.has(k)) { result.push(a); addedKeys.add(k); dept.set(k, "Retention"); }
    }
    for (const extra of TEAM_PHONE_EXTRAS["retention"] ?? []) {
      const k = normalizeAgent(extra);
      if (!addedKeys.has(k)) { result.push(extra); addedKeys.add(k); dept.set(k, "Retention"); }
    }
    for (const k of retentionPhoneData.keys()) {
      if (!addedKeys.has(k)) {
        result.push(k.replace(/\b\w/g, (c) => c.toUpperCase()));
        addedKeys.add(k); dept.set(k, "Retention");
      }
    }

    for (const a of CS_AGENTS) {
      const k = normalizeAgent(a);
      if (!addedKeys.has(k)) { result.push(a); addedKeys.add(k); dept.set(k, "CS"); }
    }
    for (const k of csPhoneData.keys()) {
      if (!addedKeys.has(k)) {
        result.push(k.replace(/\b\w/g, (c) => c.toUpperCase()));
        addedKeys.add(k); dept.set(k, "CS");
      }
    }
    if (pbxData) {
      for (const [pbxKey, pbxAgent] of pbxData.entries()) {
        if (pbxAgent.groups.includes("Customer Support") && !addedKeys.has(pbxKey)) {
          result.push(pbxKey.replace(/\b\w/g, (c) => c.toUpperCase()));
          addedKeys.add(pbxKey); dept.set(pbxKey, "CS");
        }
      }
    }

    return { agentList: result, agentDept: dept };
  }, [retentionPhoneData, csPhoneData, pbxData]);

  const totals = useMemo(() => {
    let calls = 0, seconds = 0, answered = 0, missed = 0;
    for (const v of combinedPhoneData.values()) {
      calls += v.calls; seconds += v.seconds; answered += v.answered; missed += v.missed;
    }
    return { calls, seconds, answered, missed };
  }, [combinedPhoneData]);

  const pbxTotals = useMemo(() => {
    if (!pbxData) return { calls: 0, answered: 0, seconds: 0 };
    let calls = 0, answered = 0, seconds = 0;
    for (const agent of agentList) {
      const norm = normalizeAgent(agent);
      const pbxKey = SHEET_TO_PBX[norm] ?? norm;
      const px = pbxData.get(pbxKey);
      calls += px?.calls ?? 0;
      answered += px?.answered ?? 0;
      seconds += px?.durationSeconds ?? 0;
    }
    return { calls, answered, seconds };
  }, [pbxData, agentList]);

  function refresh() { statusQ.refetch(); phoneQ.refetch(); }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0 gap-4">
        <div>
          <CardTitle className="text-xl">Retention &amp; CS Team</CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Calls &amp; retention files · live from OpenPhone + PBX ·{" "}
            <span className="inline-flex items-center gap-1">
              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-violet-500/20 text-violet-300 border border-violet-500/30">Retention</span>
              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">CS</span>
            </span>
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={phoneQ.isFetching || statusQ.isFetching}>
          <RefreshCw className={`h-4 w-4 mr-2 ${(phoneQ.isFetching || statusQ.isFetching) ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-6">
        {(phoneQ.isLoading || statusQ.isLoading) && <TableSkeleton />}
        {aggregated && "error" in aggregated && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {aggregated.error}
          </div>
        )}
        <PresetFilter from={from} to={to} setFrom={setFrom} setTo={setTo} />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatTile label="Agents" value={agentList.length} icon={<Users className="h-3.5 w-3.5" />} tone="violet" />
          <StatTile label="Total calls" value={(totals.calls + pbxTotals.calls).toLocaleString()} icon={<Phone className="h-3.5 w-3.5" />} tone="sky" />
          <StatTile label="Answered" value={(totals.answered + pbxTotals.answered).toLocaleString()} tone="emerald" />
          <StatTile label="Missed" value={(totals.missed + pbxMissed).toLocaleString()} tone="rose" />
          <StatTile label="Time on calls" value={formatHours(totals.seconds + pbxTotals.seconds)} icon={<Clock className="h-3.5 w-3.5" />} tone="amber" />
          <StatTile label="Response rate" value={responseRate(totals.answered + pbxTotals.answered, totals.calls + pbxTotals.calls)} tone="amber" />
          {aggregated && !("error" in aggregated) && (
            <>
              <StatTile label="Today's retains" value={aggregated.todayRetained.toLocaleString()} tone="emerald" />
              <StatTile label="This month's retains" value={aggregated.monthRetained.toLocaleString()} tone="emerald" />
              <StatTile label="This month's cancels" value={aggregated.monthCancelled.toLocaleString()} tone="rose" />
              <StatTile label="Retention rate" value={retentionRate(aggregated.totals.retained, aggregated.totals.grand)} tone="violet" />
            </>
          )}
        </div>

        <Tabs defaultValue="call" className="space-y-4">
          <TabsList>
            <TabsTrigger value="call">By call</TabsTrigger>
            {aggregated && !("error" in aggregated) && (
              <>
                <TabsTrigger value="files">By files</TabsTrigger>
                <TabsTrigger value="day">By day</TabsTrigger>
              </>
            )}
          </TabsList>
          <TabsContent value="call">
            <ByCallStatsView agentList={agentList} phoneData={combinedPhoneData} pbxData={pbxData} extraMissed={pbxMissed} agentDept={agentDept} />
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

function LoginGate({ children }: { children: React.ReactNode }) {
  const stored = localStorage.getItem("tracker_token");
  const storedUser = localStorage.getItem("tracker_user");
  const [auth, setAuth] = useState<{ token: string; user: AuthUser } | null>(() => {
    if (stored && storedUser) {
      try { return { token: stored, user: JSON.parse(storedUser) as AuthUser }; } catch { return null; }
    }
    return null;
  });
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const logout = useCallback(() => {
    localStorage.removeItem("tracker_token");
    localStorage.removeItem("tracker_user");
    setAuth(null);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      if (r.ok) {
        const data = await r.json() as { token: string; user: AuthUser };
        localStorage.setItem("tracker_token", data.token);
        localStorage.setItem("tracker_user", JSON.stringify(data.user));
        setAuth(data);
      } else {
        setError("Invalid username or password.");
        setPassword("");
      }
    } catch {
      setError("Connection error. Try again.");
    } finally {
      setLoading(false);
    }
  }

  if (auth) {
    const can = (p: Permission) => auth.user.role === "admin" || auth.user.permissions.includes(p);
    return (
      <UserContext.Provider value={{ user: auth.user, token: auth.token, logout, can }}>
        {children}
      </UserContext.Provider>
    );
  }

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
              <p className="text-sm text-muted-foreground mt-1">Sign in to continue</p>
            </div>
          </div>
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="relative">
              <Users className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="pl-10"
                autoFocus
                autoComplete="username"
              />
            </div>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="pl-10"
                autoComplete="current-password"
              />
            </div>
            {error && <p className="text-sm text-rose-400 text-center">{error}</p>}
            <Button type="submit" className="w-full bg-gradient-to-r from-violet-500 to-fuchsia-500 hover:from-violet-600 hover:to-fuchsia-600 text-white" disabled={loading || !username || !password}>
              {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : "Sign in"}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}

// ─── User Management Panel (Admin only) ──────────────────────────────────────

interface PortalUser { id: number; username: string; role: string; permissions: Permission[]; teamAccess?: TeamAccess | null; active: boolean; }

const DEFAULT_PERMS: Record<string, Permission[]> = {
  admin: ["view_metrics", "view_attendance", "edit_attendance", "manage_members"],
  edit:  ["view_metrics", "view_attendance", "edit_attendance", "manage_members"],
  view:  ["view_metrics", "view_attendance"],
};

function PermCheckboxes({ perms, onChange, disabled }: { perms: Permission[]; onChange: (p: Permission[]) => void; disabled?: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-1.5 mt-1">
      {ALL_PERMISSIONS.map(({ key, label, desc }) => {
        const checked = perms.includes(key);
        return (
          <label key={key} className={`flex items-start gap-2.5 rounded-md px-3 py-2 cursor-pointer transition-colors ${checked ? "bg-violet-500/10 border border-violet-500/20" : "bg-zinc-900/60 border border-white/5 hover:border-white/10"} ${disabled ? "opacity-40 pointer-events-none" : ""}`}>
            <div className={`mt-0.5 w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${checked ? "bg-violet-500 border-violet-500" : "border-zinc-600"}`}
              onClick={() => !disabled && onChange(checked ? perms.filter((p) => p !== key) : [...perms, key])}>
              {checked && <span className="text-white text-[10px] font-bold leading-none">✓</span>}
            </div>
            <div className="min-w-0">
              <div className={`text-xs font-medium leading-tight ${checked ? "text-violet-200" : "text-zinc-300"}`}>{label}</div>
              <div className="text-[11px] text-zinc-500 leading-tight mt-0.5">{desc}</div>
            </div>
          </label>
        );
      })}
    </div>
  );
}

const TEAM_ACCESS_LABELS: Record<string, string> = { retention: "Retention", nsf: "NSF", cs: "CS" };
const TEAM_ACCESS_COLORS: Record<string, string> = {
  retention: "bg-violet-500/20 text-violet-300 border-violet-500/30",
  nsf:       "bg-sky-500/20 text-sky-300 border-sky-500/30",
  cs:        "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
};

function UserManagementPanel({ onClose }: { onClose: () => void }) {
  const { token } = useUser();
  const [users, setUsers] = useState<PortalUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<"admin" | "edit" | "view">("view");
  const [newPerms, setNewPerms] = useState<Permission[]>(DEFAULT_PERMS["view"]);
  const [newTeamAccess, setNewTeamAccess] = useState<TeamAccess | "">("");
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editPw, setEditPw] = useState("");
  const [editRole, setEditRole] = useState<"admin" | "edit" | "view">("view");
  const [editPerms, setEditPerms] = useState<Permission[]>([]);
  const [editTeamAccess, setEditTeamAccess] = useState<TeamAccess | "">("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/users", { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setUsers(await r.json() as PortalUser[]);
    } finally { setLoading(false); }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  async function addUser() {
    if (!newUsername.trim() || !newPassword.trim()) return;
    setSaving(true); setError("");
    const perms = newRole === "admin" ? DEFAULT_PERMS["admin"] : newPerms;
    const r = await fetch("/api/users", { method: "POST", headers: authHeaders(token), body: JSON.stringify({ username: newUsername.trim(), password: newPassword.trim(), role: newRole, permissions: perms, teamAccess: newTeamAccess || null }) });
    if (r.ok) { setNewUsername(""); setNewPassword(""); setNewRole("view"); setNewPerms(DEFAULT_PERMS["view"]); setNewTeamAccess(""); await load(); }
    else { const d = await r.json() as { error?: string }; setError(d.error ?? "Failed to add user"); }
    setSaving(false);
  }

  async function patchUser(id: number, updates: Record<string, unknown>) {
    await fetch(`/api/users/${id}`, { method: "PATCH", headers: authHeaders(token), body: JSON.stringify(updates) });
    setEditingId(null); await load();
  }

  function startEdit(u: PortalUser) {
    if (editingId === u.id) { setEditingId(null); return; }
    setEditingId(u.id);
    setEditPw("");
    setEditRole(u.role as "admin" | "edit" | "view");
    setEditPerms(u.permissions);
    setEditTeamAccess((u.teamAccess ?? "") as TeamAccess | "");
  }

  const roleBadge = (role: string) =>
    role === "admin" ? "bg-fuchsia-500/20 text-fuchsia-300 border-fuchsia-500/30" :
    role === "edit"  ? "bg-amber-500/20 text-amber-300 border-amber-500/30" :
                       "bg-zinc-500/20 text-zinc-300 border-zinc-500/30";

  const roleIcon = (role: string) =>
    role === "admin" ? <ShieldCheck className="h-3 w-3" /> :
    role === "edit"  ? <Pencil className="h-3 w-3" /> :
                       <Eye className="h-3 w-3" />;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="relative w-full max-w-lg mx-4 rounded-2xl border border-white/10 bg-zinc-950 shadow-2xl">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-white/10">
          <div className="flex items-center gap-2">
            <UserCog className="h-5 w-5 text-fuchsia-400" />
            <h2 className="text-lg font-semibold text-white">User Management</h2>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-white transition-colors"><X className="h-5 w-5" /></button>
        </div>

        <div className="p-6 space-y-6 max-h-[80vh] overflow-y-auto">
          {/* Add user */}
          <div className="space-y-3">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Add New User</p>
            <div className="flex gap-2 flex-wrap">
              <Input placeholder="Username" value={newUsername} onChange={(e) => setNewUsername(e.target.value)} className="h-8 text-sm flex-1 min-w-[130px]" />
              <Input placeholder="Password" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className="h-8 text-sm flex-1 min-w-[130px]" />
              <select value={newRole} onChange={(e) => { const r = e.target.value as "admin"|"edit"|"view"; setNewRole(r); setNewPerms(DEFAULT_PERMS[r]); }} className="h-8 rounded-md bg-zinc-800 border border-white/10 text-sm text-white px-2 focus:outline-none focus:ring-2 focus:ring-violet-500/50">
                <option value="view">View</option>
                <option value="edit">Edit</option>
                <option value="admin">Admin</option>
              </select>
              <select value={newTeamAccess} onChange={(e) => setNewTeamAccess(e.target.value as TeamAccess | "")} className="h-8 rounded-md bg-zinc-800 border border-white/10 text-sm text-white px-2 focus:outline-none focus:ring-2 focus:ring-violet-500/50">
                <option value="">All Teams</option>
                <option value="retention">Retention</option>
                <option value="nsf">NSF</option>
                <option value="cs">CS</option>
              </select>
            </div>
            {newRole !== "admin" && (
              <div>
                <p className="text-[11px] font-medium text-zinc-400 mb-1.5">What this user can access:</p>
                <PermCheckboxes perms={newPerms} onChange={setNewPerms} />
              </div>
            )}
            {newRole === "admin" && (
              <p className="text-[11px] text-zinc-500 px-1">Admins always have full access to everything.</p>
            )}
            <Button size="sm" className="bg-violet-600 hover:bg-violet-700 text-white w-full" onClick={addUser} disabled={saving || !newUsername.trim() || !newPassword.trim()}>
              <Plus className="h-3.5 w-3.5 mr-1" />Add User
            </Button>
            {error && <p className="text-xs text-rose-400">{error}</p>}
          </div>

          {/* User list */}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Users ({users.length})</p>
            {loading ? <Skeleton className="h-24 w-full" /> : users.map((u) => (
              <div key={u.id} className={`rounded-lg border space-y-2 ${u.active ? "border-white/10 bg-zinc-900/60" : "border-white/5 bg-zinc-900/30 opacity-60"}`}>
                {/* Header row */}
                <div className="flex items-center justify-between gap-2 px-3 pt-3 pb-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-white">{u.username}</span>
                    <Badge className={`text-[10px] px-1.5 py-0 flex items-center gap-1 border ${roleBadge(u.role)}`}>
                      {roleIcon(u.role)}{u.role}
                    </Badge>
                    {u.teamAccess && (
                      <Badge className={`text-[10px] px-1.5 py-0 border ${TEAM_ACCESS_COLORS[u.teamAccess] ?? ""}`}>
                        {TEAM_ACCESS_LABELS[u.teamAccess] ?? u.teamAccess}
                      </Badge>
                    )}
                    {!u.active && <Badge className="text-[10px] px-1.5 py-0 bg-red-500/20 text-red-400 border-red-500/30">Disabled</Badge>}
                    {/* Permission pills */}
                    {u.role !== "admin" && (u.permissions ?? []).map((p) => {
                      const info = ALL_PERMISSIONS.find((x) => x.key === p);
                      return info ? (
                        <span key={p} className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-300 border border-violet-500/20">
                          {info.label}
                        </span>
                      ) : null;
                    })}
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button onClick={() => startEdit(u)} className={`p-1 rounded transition-colors ${editingId === u.id ? "text-violet-400 bg-violet-500/10" : "text-zinc-500 hover:text-white"}`} title="Edit">
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    {u.active
                      ? <button onClick={() => patchUser(u.id, { active: false })} className="p-1 rounded text-zinc-500 hover:text-red-400 transition-colors" title="Disable"><UserX className="h-3.5 w-3.5" /></button>
                      : <button onClick={() => patchUser(u.id, { active: true })} className="p-1 rounded text-zinc-500 hover:text-emerald-400 transition-colors" title="Enable"><UserCheck className="h-3.5 w-3.5" /></button>
                    }
                  </div>
                </div>

                {/* Edit panel */}
                {editingId === u.id && (
                  <div className="px-3 pb-3 pt-0 space-y-3 border-t border-white/5">
                    <div className="flex gap-2 items-center flex-wrap pt-2">
                      <Input placeholder="New password (optional)" type="password" value={editPw} onChange={(e) => setEditPw(e.target.value)} className="h-7 text-xs flex-1 min-w-[140px]" />
                      <select value={editRole} onChange={(e) => { const r = e.target.value as "admin"|"edit"|"view"; setEditRole(r); if (r === "admin") setEditPerms(DEFAULT_PERMS["admin"]); }} className="h-7 rounded-md bg-zinc-800 border border-white/10 text-xs text-white px-2 focus:outline-none focus:ring-2 focus:ring-violet-500/50">
                        <option value="view">View</option>
                        <option value="edit">Edit</option>
                        <option value="admin">Admin</option>
                      </select>
                      <select value={editTeamAccess} onChange={(e) => setEditTeamAccess(e.target.value as TeamAccess | "")} className="h-7 rounded-md bg-zinc-800 border border-white/10 text-xs text-white px-2 focus:outline-none focus:ring-2 focus:ring-violet-500/50">
                        <option value="">All Teams</option>
                        <option value="retention">Retention</option>
                        <option value="nsf">NSF</option>
                        <option value="cs">CS</option>
                      </select>
                    </div>
                    {editRole !== "admin" && (
                      <div>
                        <p className="text-[11px] font-medium text-zinc-400 mb-1">Permissions:</p>
                        <PermCheckboxes perms={editPerms} onChange={setEditPerms} />
                      </div>
                    )}
                    {editRole === "admin" && <p className="text-[11px] text-zinc-500">Admins always have full access.</p>}
                    <div className="flex gap-2 justify-end">
                      <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditingId(null)}>Cancel</Button>
                      <Button size="sm" className="h-7 text-xs bg-violet-600 hover:bg-violet-700 text-white px-3" onClick={() => patchUser(u.id, { role: editRole, permissions: editRole === "admin" ? DEFAULT_PERMS["admin"] : editPerms, teamAccess: editTeamAccess || null, ...(editPw ? { password: editPw } : {}) })}>
                        <KeyRound className="h-3 w-3 mr-1" />Save
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
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
        acc.uniqueContacts += day.uniqueContacts ?? 0;
      }
      // When no day filter and the server provides the cross-range deduplicated count, use it.
      // This prevents double-counting numbers called on multiple days.
      if (!dayFilter && agentUniqueContactsAll?.[agentName] != null) {
        acc.uniqueContacts = agentUniqueContactsAll[agentName];
      }
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

// ─── VoSLogic Panel ────────────────────────────────────────────────────────────

interface VosAgentStat {
  agentName: string;
  calls: number;
  inbound: number;
  outbound: number;
  avgDuration: number;
}

interface VosLiveCall {
  id: number;
  direction: string;
  agentName: string | null;
  phoneLabel: string;
  ringGroupName: string | null;
  duration: number;
  startedAt: string;
}

interface VosAgentStatus {
  id: number;
  name: string;
  extension: string;
  status: string;
  callsToday: number;
}

interface VosRingGroup {
  id: number;
  name: string;
  agentIds: number[];
}

interface VosAgent {
  id: number;
  name: string;
  extension: string;
  status: string;
  ringGroupIds: number[];
}

interface VosDashboardData {
  activeCalls: number;
  totalAgents: number;
  onlineAgents: number;
  availableAgents: number;
  totalCallsToday: number;
  avgDurationToday: number;
  totalInboundToday: number;
  totalOutboundToday: number;
  missedCallsToday: number;
  callsByAgent: VosAgentStat[];
  liveCalls: VosLiveCall[];
  agentStatuses: VosAgentStatus[];
}

interface VosStatsResponse {
  dashboard: VosDashboardData;
  agents: VosAgent[];
  ringGroups: VosRingGroup[];
}

function VoSPanel() {
  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState("All");
  const [sort, setSort] = useState<{ col: string; dir: "asc" | "desc" }>({ col: "calls", dir: "desc" });

  const q = useQuery<VosStatsResponse>({
    queryKey: ["vosStats"],
    queryFn: async () => {
      const r = await fetch("/api/vos/stats");
      if (!r.ok) throw new Error("Failed to load VoSLogic stats");
      return r.json() as Promise<VosStatsResponse>;
    },
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const liveQ = useQuery<{ liveCalls: VosLiveCall[]; agentStatuses: VosAgentStatus[] }>({
    queryKey: ["vosLive"],
    queryFn: async () => {
      const r = await fetch("/api/vos/live");
      if (!r.ok) return { liveCalls: [], agentStatuses: [] };
      return r.json();
    },
    staleTime: 10_000,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });

  const liveAgentNames = useMemo(() => {
    const s = new Set<string>();
    for (const c of liveQ.data?.liveCalls ?? []) if (c.agentName) s.add(c.agentName.trim().toLowerCase());
    for (const a of liveQ.data?.agentStatuses ?? []) if (a.status === "on_call") s.add(a.name.trim().toLowerCase());
    return s;
  }, [liveQ.data]);

  const agentGroupMap = useMemo(() => {
    const m = new Map<number, string>();
    for (const g of q.data?.ringGroups ?? []) for (const id of g.agentIds) m.set(id, g.name);
    return m;
  }, [q.data]);

  const agentIdMap = useMemo(() => {
    const m = new Map<string, VosAgent>();
    for (const a of q.data?.agents ?? []) m.set(a.name.trim().toLowerCase(), a);
    return m;
  }, [q.data]);

  const groups = useMemo(() => {
    const s = new Set<string>(["All"]);
    for (const g of q.data?.ringGroups ?? []) s.add(g.name);
    return [...s];
  }, [q.data]);

  function toggle(col: string) {
    setSort((s) => s.col === col ? { col, dir: s.dir === "asc" ? "desc" : "asc" } : { col, dir: "desc" });
  }

  function SortTh({ col, label, tone = "" }: { col: string; label: string; tone?: string }) {
    const active = sort.col === col;
    return (
      <TableHead className={`whitespace-nowrap text-right ${tone}`}>
        <button type="button" onClick={() => toggle(col)}
          className={`inline-flex items-center gap-1 flex-row-reverse font-semibold hover:text-foreground ${active ? "text-violet-300" : "text-muted-foreground"}`}>
          {label}
          {active ? (sort.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : <ArrowUpDown className="h-3 w-3 opacity-40" />}
        </button>
      </TableHead>
    );
  }

  const visible = useMemo(() => {
    const stats = q.data?.dashboard.callsByAgent ?? [];
    const q2 = search.trim().toLowerCase();
    let list = stats.filter((a) => a.calls > 0);
    if (q2) list = list.filter((a) => a.agentName.toLowerCase().includes(q2));
    if (groupFilter !== "All") {
      const group = q.data?.ringGroups.find((g) => g.name === groupFilter);
      if (group) {
        const ids = new Set(group.agentIds);
        list = list.filter((a) => {
          const agent = agentIdMap.get(a.agentName.trim().toLowerCase());
          return agent && ids.has(agent.id);
        });
      }
    }
    return [...list].sort((a, b) => {
      let av = 0, bv = 0;
      if (sort.col === "calls") { av = a.calls; bv = b.calls; }
      else if (sort.col === "inbound") { av = a.inbound; bv = b.inbound; }
      else if (sort.col === "outbound") { av = a.outbound; bv = b.outbound; }
      else if (sort.col === "avgDuration") { av = a.avgDuration; bv = b.avgDuration; }
      else if (sort.col === "name") return sort.dir === "asc" ? a.agentName.localeCompare(b.agentName) : b.agentName.localeCompare(a.agentName);
      return sort.dir === "asc" ? av - bv : bv - av;
    });
  }, [q.data, search, groupFilter, sort, agentIdMap]);

  const d = q.data?.dashboard;
  const isFetching = q.isFetching || liveQ.isFetching;
  const totCalls = visible.reduce((s, a) => s + a.calls, 0);
  const totIn = visible.reduce((s, a) => s + a.inbound, 0);
  const totOut = visible.reduce((s, a) => s + a.outbound, 0);
  const totAvgDur = totCalls > 0 ? Math.round(visible.reduce((s, a) => s + a.avgDuration * a.calls, 0) / totCalls) : 0;
  const visibleNameSet = useMemo(() => new Set(visible.map((a) => a.agentName.trim().toLowerCase())), [visible]);
  const filteredActiveCalls = (liveQ.data?.liveCalls ?? []).filter((c) => c.agentName && visibleNameSet.has(c.agentName.trim().toLowerCase())).length;

  const tileTotals = groupFilter === "All" && d
    ? { activeCalls: d.activeCalls, totalCalls: d.totalCallsToday, inbound: d.totalInboundToday, outbound: d.totalOutboundToday, missed: d.missedCallsToday, avgDuration: d.avgDurationToday }
    : { activeCalls: filteredActiveCalls, totalCalls: totCalls, inbound: totIn, outbound: totOut, missed: null as number | null, avgDuration: totAvgDur };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0 gap-4">
        <div>
          <CardTitle className="text-xl flex items-center gap-2">
            PBX
            <Badge className="text-[10px] px-1.5 py-0.5 bg-blue-500/20 text-blue-300 border-blue-500/30">Live</Badge>
          </CardTitle>
          <p className="text-sm text-muted-foreground mt-1">Real-time call stats from PBX phone system · refreshes every 30s</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => { q.refetch(); liveQ.refetch(); }} disabled={isFetching}>
          <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-5">
        {q.isLoading && <Skeleton className="h-40 w-full" />}
        {q.error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {String(q.error)}
          </div>
        )}
        {d && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
              <StatTile label="Active calls" value={tileTotals.activeCalls} icon={<PhoneCall className="h-3.5 w-3.5" />} tone="emerald" />
              <StatTile label="Total today" value={tileTotals.totalCalls} icon={<Phone className="h-3.5 w-3.5" />} tone="sky" />
              <StatTile label="Inbound today" value={tileTotals.inbound} icon={<PhoneIncoming className="h-3.5 w-3.5" />} tone="sky" />
              <StatTile label="Outbound today" value={tileTotals.outbound} icon={<PhoneOutgoing className="h-3.5 w-3.5" />} tone="violet" />
              {tileTotals.missed !== null && <StatTile label="Missed today" value={tileTotals.missed} icon={<PhoneMissed className="h-3.5 w-3.5" />} tone="rose" />}
              <StatTile label="Avg duration" value={formatDuration(tileTotals.avgDuration)} icon={<Clock className="h-3.5 w-3.5" />} tone="amber" />
            </div>

            {(liveQ.data?.liveCalls ?? []).length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Live calls right now</p>
                <div className="flex flex-wrap gap-2">
                  {(liveQ.data?.liveCalls ?? []).map((c) => (
                    <div key={c.id} className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-xs">
                      <span className="relative flex h-2 w-2 shrink-0">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                      </span>
                      <span className="text-emerald-300 font-medium">{c.agentName ?? "Unknown"}</span>
                      <span className="text-zinc-500">·</span>
                      <span className="text-zinc-400">{c.direction === "outbound" ? "↑" : "↓"} {formatDuration(c.duration)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center gap-3 flex-wrap">
              <div className="relative w-full sm:max-w-xs">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input placeholder="Search agents…" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
              </div>
              <div className="flex gap-1.5 flex-wrap">
                {groups.map((g) => (
                  <button key={g} onClick={() => setGroupFilter(g)}
                    className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${groupFilter === g ? "bg-violet-600 text-white" : "text-muted-foreground hover:text-white hover:bg-white/5"}`}>
                    {g}
                  </button>
                ))}
              </div>
              <Badge variant="secondary" className="font-mono ml-auto">{visible.length} agents</Badge>
            </div>

            <div className="rounded-lg border bg-card overflow-hidden">
              <div className="overflow-x-auto max-h-[60vh]">
                <Table>
                  <TableHeader className="sticky top-0 bg-muted/80 backdrop-blur z-10">
                    <TableRow>
                      <TableHead className="text-left text-muted-foreground">
                        <button type="button" onClick={() => toggle("name")}
                          className={`inline-flex items-center gap-1 font-semibold hover:text-foreground ${sort.col === "name" ? "text-violet-300" : "text-muted-foreground"}`}>
                          Agent {sort.col === "name" ? (sort.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : <ArrowUpDown className="h-3 w-3 opacity-40" />}
                        </button>
                      </TableHead>
                      <TableHead className="text-center text-xs text-muted-foreground font-medium">Status</TableHead>
                      <SortTh col="calls" label="Total calls" />
                      <SortTh col="inbound" label="Inbound" tone="text-cyan-400" />
                      <SortTh col="outbound" label="Outbound" tone="text-fuchsia-400" />
                      <SortTh col="avgDuration" label="Avg duration" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visible.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center py-12 text-muted-foreground">No agents match the current filters.</TableCell>
                      </TableRow>
                    )}
                    {visible.map((agent) => {
                      const nameKey = agent.agentName.trim().toLowerCase();
                      const isLive = liveAgentNames.has(nameKey);
                      const vosAgent = agentIdMap.get(nameKey);
                      const statusObj = liveQ.data?.agentStatuses.find((s) => s.name.trim().toLowerCase() === nameKey);
                      const status = statusObj?.status ?? vosAgent?.status ?? "offline";
                      const statusColor = status === "on_call" ? "text-emerald-400" : status === "available" ? "text-sky-400" : status === "idle" ? "text-amber-400" : "text-zinc-500";
                      const statusLabel = status === "on_call" ? "On call" : status === "available" ? "Available" : status === "idle" ? "Idle" : "Offline";
                      const group = vosAgent ? agentGroupMap.get(vosAgent.id) : undefined;
                      return (
                        <TableRow key={agent.agentName} className="hover-elevate">
                          <TableCell className="font-medium whitespace-nowrap">
                            <div className="flex items-center gap-2">
                              {isLive && (
                                <span className="relative flex h-2.5 w-2.5 shrink-0">
                                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
                                </span>
                              )}
                              <span>{agent.agentName}</span>
                              {group && <Badge className="text-[9px] px-1 py-0 bg-violet-500/15 text-violet-300 border-violet-500/20">{group}</Badge>}
                            </div>
                          </TableCell>
                          <TableCell className={`text-center text-xs font-medium ${statusColor}`}>{statusLabel}</TableCell>
                          <TableCell className={`text-right tabular-nums font-mono ${!agent.calls ? "text-muted-foreground/40" : ""}`}>{agent.calls || "—"}</TableCell>
                          <TableCell className={`text-right tabular-nums font-mono ${agent.inbound ? "text-cyan-400" : "text-muted-foreground/40"}`}>{agent.inbound || "—"}</TableCell>
                          <TableCell className={`text-right tabular-nums font-mono ${agent.outbound ? "text-fuchsia-400" : "text-muted-foreground/40"}`}>{agent.outbound || "—"}</TableCell>
                          <TableCell className="text-right tabular-nums font-mono text-muted-foreground">{agent.avgDuration ? formatDuration(agent.avgDuration) : "—"}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                  {visible.length > 0 && (
                    <TableHeader className="sticky bottom-0 bg-muted/80 backdrop-blur z-10">
                      <TableRow>
                        <TableCell className="font-bold">Whole team</TableCell>
                        <TableCell />
                        <TableCell className="text-right tabular-nums font-mono font-bold">{totCalls || "—"}</TableCell>
                        <TableCell className="text-right tabular-nums font-mono font-bold text-cyan-400">{totIn || "—"}</TableCell>
                        <TableCell className="text-right tabular-nums font-mono font-bold text-fuchsia-400">{totOut || "—"}</TableCell>
                        <TableCell />
                      </TableRow>
                    </TableHeader>
                  )}
                </Table>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Missed / No Callback Panel ───────────────────────────────────────────────

function maskNumber(num: string): string {
  const digits = num.replace(/\D/g, "");
  const last = digits.slice(-10);
  if (last.length === 10) return `(${last.slice(0,3)}) ${last.slice(3,6)}-${last.slice(6)}`.replace(/\d{4}$/, (m) => "****".slice(0, m.length));
  return num.length > 4 ? `${"*".repeat(num.length - 4)}${num.slice(-4)}` : num;
}

function formatCallTime(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" });
  const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "America/Los_Angeles" });
  return `${date}, ${time}`;
}

const TEAM_LABELS: Record<string, string> = { retention: "Retention", nsf: "NSF", cs: "CS", backend: "Retention & CS", other: "Other" };
const TEAM_COLORS: Record<string, string> = {
  retention: "bg-violet-500/15 text-violet-300 border-violet-500/20",
  nsf: "bg-sky-500/15 text-sky-300 border-sky-500/20",
  cs: "bg-emerald-500/15 text-emerald-300 border-emerald-500/20",
  backend: "bg-violet-500/15 text-violet-300 border-violet-500/20",
  other: "bg-zinc-500/15 text-zinc-300 border-zinc-500/20",
};

function MissedNoCBPanel({ lockedTeam }: { lockedTeam?: TeamAccess | null }) {
  const q = useMissedNoCB();
  const qc = useQueryClient();
  const allItems = q.data?.items ?? [];
  // If the user has a team scope, only ever show their team's items
  const items = lockedTeam ? allItems.filter((it) => it.team === lockedTeam) : allItems;
  const fetchedAt = q.data?.fetchedAt ?? 0;
  const [teamFilter, setTeamFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<"all" | "pbx" | "quo">("all");
  const [search, setSearch] = useState("");

  const teams = useMemo(() => {
    const s = new Set<string>();
    for (const it of items) if (it.team !== "other") s.add(it.team);
    return Array.from(s).sort();
  }, [items]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const it of items) {
      c[it.team] = (c[it.team] ?? 0) + 1;
      if (it.team === "retention" || it.team === "cs") c["backend"] = (c["backend"] ?? 0) + 1;
    }
    return c;
  }, [items]);

  const visible = useMemo(() => {
    let list = items;
    if (!lockedTeam && teamFilter !== "all") {
      if (teamFilter === "backend") list = list.filter((it) => it.team === "retention" || it.team === "cs");
      else list = list.filter((it) => it.team === teamFilter);
    }
    if (sourceFilter !== "all") list = list.filter((it) => it.source === sourceFilter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((it) => it.fromNumber.includes(q) || it.ringGroupName.toLowerCase().includes(q));
    }
    return [...list].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [items, teamFilter, sourceFilter, lockedTeam, search]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <PhoneOff className="h-4 w-4 text-rose-400" />
            <CardTitle className="text-base">Missed Calls — No Callback</CardTitle>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {fetchedAt > 0 && <span>Updated {new Date(fetchedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "America/Los_Angeles" })} PDT</span>}
            <Button size="sm" variant="ghost" className="h-7 px-2 gap-1" onClick={() => qc.invalidateQueries({ queryKey: ["missedNoCB"] })}>
              <RefreshCw className="h-3 w-3" /> Refresh
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Missed calls (PBX ring groups + Quo/OpenPhone) with no outbound callback made after the missed call today.
        </p>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* Team count tiles */}
        {lockedTeam ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-sm">
            <StatTile label="Missed / No CB" value={q.isLoading ? "…" : items.length.toLocaleString()} tone="rose" icon={<PhoneOff className="h-3.5 w-3.5" />} />
            <StatTile
              label={TEAM_LABELS[lockedTeam] ?? lockedTeam}
              value={q.isLoading ? "…" : (counts[lockedTeam] ?? 0).toLocaleString()}
              tone={lockedTeam === "retention" ? "violet" : lockedTeam === "nsf" ? "sky" : "emerald"}
            />
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <StatTile label="Total missed / no CB" value={q.isLoading ? "…" : items.length.toLocaleString()} tone="rose" icon={<PhoneOff className="h-3.5 w-3.5" />} />
            <StatTile label="Retention & CS" value={q.isLoading ? "…" : (counts["backend"] ?? 0).toLocaleString()} tone="violet" />
            <StatTile label="NSF" value={q.isLoading ? "…" : (counts["nsf"] ?? 0).toLocaleString()} tone="sky" />
          </div>
        )}

        {/* Filters — hidden for team-locked users */}
        <div className="flex items-center gap-3 flex-wrap">
          {!lockedTeam && (
            <>
              <div className="flex items-center gap-1.5">
                <Filter className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">Team:</span>
              </div>
              {(["all", "backend", "nsf"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTeamFilter(t)}
                  className={`text-xs px-2.5 py-1 rounded-md border transition-colors ${
                    teamFilter === t
                      ? "bg-violet-500/25 text-violet-200 border-violet-500/40"
                      : "bg-zinc-800/50 text-zinc-400 border-zinc-700/50 hover:border-zinc-500"
                  }`}
                >
                  {t === "all" ? "All" : TEAM_LABELS[t] ?? t}
                </button>
              ))}
            </>
          )}
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Source:</span>
          </div>
          {(["all", "pbx", "quo"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSourceFilter(s)}
              className={`text-xs px-2.5 py-1 rounded-md border transition-colors ${
                sourceFilter === s
                  ? s === "quo"
                    ? "bg-sky-500/25 text-sky-200 border-sky-500/40"
                    : "bg-zinc-500/25 text-zinc-200 border-zinc-500/40"
                  : "bg-zinc-800/50 text-zinc-400 border-zinc-700/50 hover:border-zinc-500"
              }`}
            >
              {s === "all" ? "All" : s === "quo" ? "Quo" : "PBX"}
            </button>
          ))}
          <div className={`${lockedTeam ? "" : "ml-auto"} flex items-center gap-2`}>
            <Search className="h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search number or group…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-7 w-44 text-xs"
            />
          </div>
        </div>

        {/* Table */}
        {q.isLoading ? (
          <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}</div>
        ) : visible.length === 0 ? (
          <div className="py-16 text-center text-muted-foreground text-sm">
            {items.length === 0 ? "No missed calls without a callback today." : "No results match the current filters."}
          </div>
        ) : (
          <div className="rounded-lg border border-zinc-800 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="border-zinc-800 bg-zinc-900/60">
                  <TableHead className="text-xs w-36">Date & Time</TableHead>
                  <TableHead className="text-xs">Number</TableHead>
                  {!lockedTeam && <TableHead className="text-xs">Team</TableHead>}
                  <TableHead className="text-xs w-20">Source</TableHead>
                  <TableHead className="text-xs">Ring Group / Line</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((it) => (
                  <TableRow key={String(it.id)} className="border-zinc-800 hover:bg-zinc-800/40">
                    <TableCell className="text-xs tabular-nums text-muted-foreground whitespace-nowrap">
                      {formatCallTime(it.createdAt)}
                    </TableCell>
                    <TableCell className="font-mono text-xs tracking-wider">
                      {it.fromNumber}
                    </TableCell>
                    {!lockedTeam && (
                      <TableCell>
                        <Badge className={`text-[10px] px-1.5 py-0 ${TEAM_COLORS[it.team] ?? TEAM_COLORS["other"]}`}>
                          {TEAM_LABELS[it.team] ?? it.team}
                        </Badge>
                      </TableCell>
                    )}
                    <TableCell>
                      <Badge className={`text-[10px] px-1.5 py-0 border ${it.source === "quo" ? "bg-sky-500/20 text-sky-300 border-sky-500/30" : "bg-zinc-700/40 text-zinc-300 border-zinc-600/30"}`}>
                        {it.source === "quo" ? "Quo" : "PBX"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {it.ringGroupName}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

type DashView = "metrics" | "attendance";

function Dashboard() {
  const { user, logout, can } = useUser();
  const [showUsers, setShowUsers] = useState(false);
  const defaultView: DashView = can("view_metrics") ? "metrics" : "attendance";
  const [view, setView] = useState<DashView>(defaultView);

  const ta = user.teamAccess ?? null;
  const allTeams = ta === null;
  const metricsTabs = [
    ...(allTeams ? [
      { value: "backend",   label: "Retention & CS" },
      { value: "nsf",       label: "NSF"            },
    ] : []),
    { value: "missed-no-cb", label: "Missed / No CB" },
    ...(allTeams ? [{ value: "quo-lines", label: "Quo Lines" }, { value: "vos", label: "PBX" }] : []),
  ];

  const roleBadgeCls =
    user.role === "admin" ? "bg-fuchsia-500/20 text-fuchsia-300 border-fuchsia-500/30" :
    user.role === "edit"  ? "bg-amber-500/20 text-amber-300 border-amber-500/30" :
                            "bg-zinc-500/20 text-zinc-300 border-zinc-500/30";
  const RoleIcon = user.role === "admin" ? ShieldCheck : user.role === "edit" ? Pencil : Eye;

  return (
    <div className="min-h-screen bg-background relative overflow-hidden">
      {showUsers && <UserManagementPanel onClose={() => setShowUsers(false)} />}

      <div className="pointer-events-none absolute inset-0 -z-0">
        <div className="absolute -top-32 -left-32 h-[500px] w-[500px] rounded-full bg-violet-600/20 blur-[120px]" />
        <div className="absolute top-20 right-0 h-[400px] w-[400px] rounded-full bg-sky-500/15 blur-[120px]" />
        <div className="absolute bottom-0 left-1/3 h-[400px] w-[400px] rounded-full bg-fuchsia-500/10 blur-[120px]" />
      </div>

      <header className="relative border-b border-white/5 bg-card/60 backdrop-blur-xl">
        <div className="max-w-[1400px] mx-auto px-6 py-4 flex items-center gap-4">
          <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white flex items-center justify-center shadow-[0_0_24px_-6px_rgba(168,85,247,0.7)]">
            <Rocket className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <h1 className="text-xl font-bold tracking-tight bg-gradient-to-r from-violet-300 via-fuchsia-300 to-sky-300 bg-clip-text text-transparent">
              Backend Tracker
            </h1>
            <p className="text-sm text-muted-foreground">Retention, NSF &amp; CS team metrics at a glance</p>
          </div>

          {/* View switcher — only show tabs user has access to */}
          {(can("view_metrics") || can("view_attendance")) && (
            <div className="relative">
              <select
                value={view}
                onChange={(e) => setView(e.target.value as DashView)}
                className="appearance-none pl-4 pr-9 py-2 rounded-lg bg-zinc-800/80 border border-white/10 text-sm font-medium text-white cursor-pointer hover:bg-zinc-700/80 transition-colors focus:outline-none focus:ring-2 focus:ring-violet-500/50"
              >
                {can("view_metrics") && <option value="metrics">📊 Metrics</option>}
                {can("view_attendance") && <option value="attendance">🗓 Attendance</option>}
              </select>
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 text-xs">▾</span>
            </div>
          )}

          {/* User info */}
          <div className="flex items-center gap-2 pl-2 border-l border-white/10">
            <div className="text-right hidden sm:block">
              <p className="text-xs font-medium text-white leading-tight">{user.username}</p>
              <Badge className={`text-[10px] px-1.5 py-0 flex items-center gap-1 border w-fit ml-auto mt-0.5 ${roleBadgeCls}`}>
                <RoleIcon className="h-2.5 w-2.5" />{user.role}
              </Badge>
            </div>
            {user.role === "admin" && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button onClick={() => setShowUsers(true)} className="p-2 rounded-lg text-zinc-400 hover:text-fuchsia-300 hover:bg-fuchsia-500/10 transition-colors">
                    <UserCog className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Manage users</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <button onClick={logout} className="p-2 rounded-lg text-zinc-400 hover:text-rose-300 hover:bg-rose-500/10 transition-colors">
                  <LogOut className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Sign out</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto px-6 py-8">
        {view === "metrics" && can("view_metrics") ? (
          <Tabs defaultValue={ta ?? "backend"} className="space-y-6">
            <TabsList className="grid w-full max-w-3xl" style={{ gridTemplateColumns: `repeat(${metricsTabs.length}, minmax(0, 1fr))` }}>
              {metricsTabs.map((t) => (
                <TabsTrigger key={t.value} value={t.value} data-testid={`tab-${t.value}`}>{t.label}</TabsTrigger>
              ))}
            </TabsList>
            {allTeams && (
              <TabsContent value="backend">
                <RetentionCSPanel />
              </TabsContent>
            )}
            {(allTeams || ta === "nsf") && (
              <TabsContent value="nsf">
                <TeamPanel urls={NSF} sheetKey="nsf" label="NSF Team" mode="nsf" statusQueryFn={fetchNSFCombinedSheet} />
              </TabsContent>
            )}
            <TabsContent value="missed-no-cb">
              <MissedNoCBPanel lockedTeam={ta} />
            </TabsContent>
            {allTeams && (
              <TabsContent value="quo-lines">
                <QuoLinesPanel />
              </TabsContent>
            )}
            {allTeams && (
              <TabsContent value="vos">
                <VoSPanel />
              </TabsContent>
            )}
          </Tabs>
        ) : view === "attendance" && can("view_attendance") ? (
          <AttendancePanel />
        ) : (
          <div className="flex flex-col items-center justify-center py-32 gap-3 text-zinc-500">
            <ShieldCheck className="h-10 w-10 opacity-30" />
            <p className="text-sm">You don't have permission to view this section.</p>
          </div>
        )}
      </main>
    </div>
  );
}


// ─── Attendance ────────────────────────────────────────────────────────────────

interface AttMember { id: number; name: string; shift: string; department: string; active: boolean; }
interface AttRecord { id: number; memberId: number; date: string; status: string; note: string | null; coaching: boolean; }
interface AttData { members: AttMember[]; records: AttRecord[]; }

const ATT_STATUS = [
  { s: "in",   label: "In",        cell: "bg-emerald-500/25 text-emerald-300", badge: "text-emerald-400" },
  { s: "off",  label: "Off",       cell: "bg-amber-500/25 text-amber-300",     badge: "text-amber-400" },
  { s: "late", label: "Late",      cell: "bg-yellow-400/25 text-yellow-300",   badge: "text-yellow-400" },
  { s: "pto",  label: "PTO",       cell: "bg-blue-500/25 text-blue-300",       badge: "text-blue-400" },
  { s: "nsnc", label: "NSNC",      cell: "bg-red-700/30 text-red-400",         badge: "text-red-400" },
  { s: "conf", label: "Confirmed", cell: "bg-teal-500/25 text-teal-300",       badge: "text-teal-400" },
  { s: "",     label: "Clear",     cell: "",                                    badge: "text-zinc-500" },
] as const;

function AttCell({ status, note, coaching, weekend }: { status: string; note?: string | null; coaching?: boolean; weekend?: boolean }) {
  const cfg = ATT_STATUS.find((x) => x.s === status);
  if (!status) return weekend
    ? <span className="text-zinc-800 text-xs font-medium select-none">—</span>
    : <span className="text-zinc-700 text-base leading-none">·</span>;
  const label = status === "in" ? "In" : status === "off" ? "Off" : status === "late" ? "Late" : status === "pto" ? "PTO" : status === "nsnc" ? "NSNC" : "Conf";
  return (
    <span className={`relative inline-flex items-center justify-center px-1.5 h-5 rounded text-[10px] font-bold whitespace-nowrap ${cfg?.cell ?? ""}`}>
      {label}
      {note && <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-red-500 ring-1 ring-zinc-900" />}
      {coaching && <span className="absolute -bottom-1 -right-1 w-2 h-2 rounded-full bg-indigo-400 ring-1 ring-zinc-900" title="Got coaching" />}
    </span>
  );
}

const WDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function AttendancePanel() {
  const { token, can } = useUser();
  const canEdit = can("edit_attendance");
  const canManage = can("manage_members");
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const tomorrowStr = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).toISOString().slice(0, 10);
  const [monthOff, setMonthOff] = useState(0);
  const [deptFilter, setDeptFilter] = useState("All");
  const [editCell, setEditCell] = useState<{ memberId: number; date: string; name: string } | null>(null);
  const [editStatus, setEditStatus] = useState("");
  const [editNote, setEditNote] = useState("");
  const [editCoaching, setEditCoaching] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [newShift, setNewShift] = useState("");
  const [newDept, setNewDept] = useState("");
  const [importing, setImporting] = useState(false);
  const [editingMember, setEditingMember] = useState<AttMember | null>(null);

  const monthStart = new Date(today.getFullYear(), today.getMonth() + monthOff, 1);
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + monthOff + 1, 0);
  const fromStr = monthStart.toISOString().slice(0, 10);
  const toStr = monthEnd.toISOString().slice(0, 10);
  const monthLabel = monthStart.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const dateCols = useMemo(() => {
    const cols: string[] = [];
    const d = new Date(monthStart);
    while (d <= monthEnd) {
      const iso = d.toISOString().slice(0, 10);
      if (iso <= tomorrowStr) cols.push(iso);
      d.setDate(d.getDate() + 1);
    }
    return cols;
  }, [monthOff, tomorrowStr]);

  const qc = useQueryClient();
  const { data, isLoading } = useQuery<AttData>({
    queryKey: ["attendance", fromStr, toStr],
    queryFn: async () => {
      const r = await fetch(`/api/attendance?from=${fromStr}&to=${toStr}`);
      if (!r.ok) throw new Error("fetch failed");
      return r.json();
    },
    staleTime: 15_000,
    refetchInterval: 60_000,
  });

  const recordMap = useMemo(() => {
    const m = new Map<string, AttRecord>();
    for (const rec of data?.records ?? []) m.set(`${rec.memberId}_${rec.date}`, rec);
    return m;
  }, [data]);

  const departments = useMemo(() => {
    const s = new Set<string>(["All"]);
    for (const m of data?.members ?? []) if (m.department) s.add(m.department);
    return [...s];
  }, [data]);

  const visible = useMemo(
    () => (data?.members ?? [])
      .filter((m) => deptFilter === "All" || m.department === deptFilter)
      .sort((a, b) => parseFloat(a.shift || "0") - parseFloat(b.shift || "0")),
    [data, deptFilter],
  );

  const todaySummary = useMemo(() => {
    const c = { in: 0, off: 0, late: 0, pto: 0, nsnc: 0, absent: 0 };
    for (const m of data?.members ?? []) {
      const s = recordMap.get(`${m.id}_${todayStr}`)?.status ?? "";
      if (s === "in") c.in++; else if (s === "off") c.off++;
      else if (s === "late") c.late++; else if (s === "pto") c.pto++;
      else if (s === "nsnc") c.nsnc++; else c.absent++;
    }
    return c;
  }, [data, recordMap, todayStr]);

  const teamSummary = useMemo(() => {
    const map = new Map<string, { present: number; total: number }>();
    for (const m of data?.members ?? []) {
      const dept = m.department || "Other";
      if (!map.has(dept)) map.set(dept, { present: 0, total: 0 });
      const entry = map.get(dept)!;
      entry.total++;
      const s = recordMap.get(`${m.id}_${todayStr}`)?.status ?? "";
      if (s === "in" || s === "late") entry.present++;
    }
    return [...map.entries()]
      .map(([dept, { present, total }]) => ({ dept, present, total }))
      .sort((a, b) => a.dept.localeCompare(b.dept));
  }, [data, recordMap, todayStr]);

  async function upsert(memberId: number, date: string, status: string, note: string, coaching: boolean) {
    await fetch("/api/attendance/record", {
      method: "PUT", headers: authHeaders(token),
      body: JSON.stringify({ memberId, date, status, note: note || null, coaching }),
    });
    qc.invalidateQueries({ queryKey: ["attendance"] });
  }

  function openCell(m: AttMember, date: string) {
    const rec = recordMap.get(`${m.id}_${date}`);
    setEditCell({ memberId: m.id, date, name: m.name });
    setEditStatus(rec?.status ?? "");
    setEditNote(rec?.note ?? "");
    setEditCoaching(rec?.coaching ?? false);
  }

  async function saveCell() {
    if (!editCell) return;
    await upsert(editCell.memberId, editCell.date, editStatus, editNote, editCoaching);
    setEditCell(null);
  }

  async function addMember() {
    if (!newName.trim()) return;
    await fetch("/api/attendance/members", {
      method: "POST", headers: authHeaders(token),
      body: JSON.stringify({ name: newName.trim(), shift: newShift.trim(), department: newDept.trim() }),
    });
    setNewName(""); setNewShift(""); setNewDept(""); setShowAdd(false);
    qc.invalidateQueries({ queryKey: ["attendance"] });
  }

  async function saveMember() {
    if (!editingMember) return;
    await fetch(`/api/attendance/members/${editingMember.id}`, {
      method: "PATCH", headers: authHeaders(token),
      body: JSON.stringify({ name: editingMember.name, shift: editingMember.shift, department: editingMember.department }),
    });
    setEditingMember(null);
    qc.invalidateQueries({ queryKey: ["attendance"] });
  }

  async function deactivateMember(id: number) {
    await fetch(`/api/attendance/members/${id}`, {
      method: "PATCH", headers: authHeaders(token),
      body: JSON.stringify({ active: false }),
    });
    qc.invalidateQueries({ queryKey: ["attendance"] });
  }

  async function doImport() {
    setImporting(true);
    await fetch("/api/attendance/import", { method: "POST", headers: authHeaders(token) });
    qc.invalidateQueries({ queryKey: ["attendance"] });
    setImporting(false);
  }

  const showTodaySummary = dateCols.includes(todayStr) && (data?.members?.length ?? 0) > 0;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-semibold text-white">Attendance</h2>
          <p className="text-sm text-muted-foreground">Track daily presence, mark status, and add notes per member</p>
        </div>
        <div className="flex items-center gap-2">
          {canManage && (data?.members.length ?? 0) === 0 && (
            <Button size="sm" variant="outline" onClick={doImport} disabled={importing}>
              {importing ? "Importing…" : "Import from Sheets"}
            </Button>
          )}
          {canManage && (
            <Button size="sm" className="bg-violet-600 hover:bg-violet-700 text-white" onClick={() => setShowAdd((v) => !v)}>
              + Add Member
            </Button>
          )}
          {!canEdit && !canManage && (
            <Badge className="text-[10px] px-2 py-1 bg-zinc-500/20 text-zinc-400 border-zinc-500/30 border flex items-center gap-1">
              <Eye className="h-3 w-3" />View only
            </Badge>
          )}
        </div>
      </div>

      {/* Add Member form */}
      {showAdd && (
        <Card className="border-violet-500/30 bg-zinc-900/70 p-4">
          <div className="flex gap-3 items-end flex-wrap">
            <div className="flex-1 min-w-[160px]">
              <Label className="text-xs text-muted-foreground mb-1 block">Name *</Label>
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Full name" className="h-8" onKeyDown={(e) => e.key === "Enter" && addMember()} />
            </div>
            <div className="w-24">
              <Label className="text-xs text-muted-foreground mb-1 block">Shift</Label>
              <Input value={newShift} onChange={(e) => setNewShift(e.target.value)} placeholder="e.g. 8" className="h-8" />
            </div>
            <div className="w-44">
              <Label className="text-xs text-muted-foreground mb-1 block">Department</Label>
              <Input value={newDept} onChange={(e) => setNewDept(e.target.value)} placeholder="e.g. Backend" className="h-8" />
            </div>
            <Button size="sm" onClick={addMember} disabled={!newName.trim()}>Add</Button>
            <Button size="sm" variant="ghost" onClick={() => setShowAdd(false)}>Cancel</Button>
          </div>
        </Card>
      )}

      {/* Today summary tiles */}
      {showTodaySummary && (
        <div className="space-y-3">
          {/* Overall breakdown */}
          <div className="grid grid-cols-6 gap-3">
            {[
              { label: "Present", value: todaySummary.in,     color: "text-emerald-400" },
              { label: "Off",     value: todaySummary.off,    color: "text-amber-400" },
              { label: "Late",    value: todaySummary.late,   color: "text-yellow-400" },
              { label: "PTO",     value: todaySummary.pto,    color: "text-blue-400" },
              { label: "NSNC",    value: todaySummary.nsnc,   color: "text-red-400" },
              { label: "No Data", value: todaySummary.absent, color: "text-zinc-500" },
            ].map(({ label, value, color }) => (
              <Card key={label} className="bg-zinc-900/60 border-white/10 p-3">
                <div className="text-xs text-muted-foreground mb-1">Today — {label}</div>
                <div className={`text-2xl font-bold tabular-nums ${color}`}>{value}</div>
              </Card>
            ))}
          </div>

          {/* Per-team present breakdown */}
          <div className="flex gap-3 flex-wrap">
            {teamSummary.map(({ dept, present, total }) => {
              const pct = total > 0 ? Math.round((present / total) * 100) : 0;
              const barColor = pct >= 80 ? "bg-emerald-500" : pct >= 50 ? "bg-yellow-500" : "bg-red-500";
              return (
                <Card key={dept} className="bg-zinc-900/60 border-white/10 p-3 flex-1 min-w-[120px]">
                  <div className="text-xs text-muted-foreground mb-1">{dept} — Present</div>
                  <div className={`text-2xl font-bold tabular-nums ${pct >= 80 ? "text-emerald-400" : pct >= 50 ? "text-yellow-400" : "text-red-400"}`}>
                    {present}<span className="text-sm font-normal text-muted-foreground">/{total}</span>
                  </div>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      {/* Dept filter + month navigation */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex gap-1.5">
          {departments.map((d) => (
            <button
              key={d}
              onClick={() => setDeptFilter(d)}
              className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${deptFilter === d ? "bg-violet-600 text-white" : "text-muted-foreground hover:text-white hover:bg-white/5"}`}
            >
              {d}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setMonthOff((v) => v - 1)} className="px-2 py-1 rounded text-muted-foreground hover:text-white hover:bg-white/5 transition-colors">←</button>
          <span className="text-sm font-medium text-white w-32 text-center">{monthLabel}</span>
          <button onClick={() => setMonthOff((v) => v + 1)} className="px-2 py-1 rounded text-muted-foreground hover:text-white hover:bg-white/5 transition-colors">→</button>
        </div>
      </div>

      {/* Grid */}
      {isLoading ? (
        <Skeleton className="h-56 w-full" />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-white/10">
          <table className="border-collapse text-sm" style={{ minWidth: `${260 + dateCols.length * 50}px` }}>
            <thead>
              <tr className="bg-zinc-950">
                <th className="sticky left-0 z-20 bg-zinc-950 text-left text-xs text-muted-foreground font-medium px-3 py-2 border-b border-white/10 min-w-[160px]">Member</th>
                <th className="sticky left-[160px] z-20 bg-zinc-950 text-center text-xs text-muted-foreground font-medium px-1 py-2 border-b border-white/10 w-10">Shift</th>
                <th className="sticky left-[200px] z-20 bg-zinc-950 text-left text-xs text-muted-foreground font-medium px-2 py-2 border-b border-white/10 w-24">Dept</th>
                {dateCols.map((d) => {
                  const dt = new Date(d + "T12:00:00");
                  const isToday = d === todayStr;
                  const isTomorrow = d === tomorrowStr;
                  const isWknd = dt.getDay() === 0 || dt.getDay() === 6;
                  return (
                    <th
                      key={d}
                      className={`text-center px-0 py-1 border-b border-white/10 w-12 ${isToday ? "bg-violet-900/40" : isTomorrow ? "bg-teal-900/30" : ""}`}
                      style={isWknd && !isToday && !isTomorrow ? { background: "repeating-linear-gradient(135deg, #0f0f12 0px, #0f0f12 4px, #16141a 4px, #16141a 8px)" } : undefined}
                    >
                      <div className={`text-[11px] font-semibold ${isToday ? "text-violet-300" : isTomorrow ? "text-teal-300" : isWknd ? "text-amber-700/80" : "text-muted-foreground"}`}>{dt.getDate()}</div>
                      <div className={`text-[9px] ${isToday ? "text-violet-400" : isTomorrow ? "text-teal-500" : isWknd ? "text-amber-800/70" : "text-zinc-600"}`}>{WDAYS[dt.getDay()]}</div>
                    </th>
                  );
                })}
                <th className="text-center text-xs text-emerald-500/70 font-medium px-2 py-2 border-b border-white/10 border-l border-white/10 w-8">In</th>
                <th className="text-center text-xs text-amber-500/70 font-medium px-2 py-2 border-b border-white/10 w-8">Off</th>
                <th className="text-center text-xs text-yellow-400/70 font-medium px-2 py-2 border-b border-white/10 w-8">Late</th>
                <th className="text-center text-xs text-blue-400/70 font-medium px-2 py-2 border-b border-white/10 w-8">PTO</th>
                <th className="text-center text-xs text-red-400/70 font-medium px-2 py-2 border-b border-white/10 w-10">NSNC</th>
                {canManage && <th className="text-center text-xs text-muted-foreground/50 font-medium px-1 py-2 border-b border-white/10 w-6" title="Edit member">⋯</th>}
              </tr>
            </thead>
            <tbody>
              {visible.map((member, mi) => {
                let cIn = 0, cOff = 0, cLate = 0, cPto = 0, cNsnc = 0;
                for (const d of dateCols) {
                  const s = recordMap.get(`${member.id}_${d}`)?.status ?? "";
                  if (s === "in") cIn++; else if (s === "off") cOff++;
                  else if (s === "late") cLate++; else if (s === "pto") cPto++;
                  else if (s === "nsnc") cNsnc++;
                }
                const rowBg = mi % 2 === 0 ? "bg-zinc-900/20" : "bg-zinc-900/50";
                return (
                  <tr key={member.id} className={`${rowBg} hover:bg-white/[0.03] transition-colors`}>
                    <td className={`sticky left-0 z-10 ${mi % 2 === 0 ? "bg-zinc-950" : "bg-zinc-900"} px-3 py-1.5 text-sm text-white font-medium border-b border-white/5 whitespace-nowrap`}>
                      {member.name}
                    </td>
                    <td className={`sticky left-[160px] z-10 ${mi % 2 === 0 ? "bg-zinc-950" : "bg-zinc-900"} text-center text-xs text-zinc-500 px-1 border-b border-white/5`}>{member.shift}</td>
                    <td className={`sticky left-[200px] z-10 ${mi % 2 === 0 ? "bg-zinc-950" : "bg-zinc-900"} px-2 border-b border-white/5`}>
                      {member.department && (
                        <Badge className="text-[10px] px-1.5 py-0 bg-violet-500/20 text-violet-300 border-violet-500/30">{member.department}</Badge>
                      )}
                    </td>
                    {dateCols.map((d) => {
                      const rec = recordMap.get(`${member.id}_${d}`);
                      const isTomorrow = d === tomorrowStr;
                      const isFuture = d > tomorrowStr;
                      const isToday = d === todayStr;
                      const dt = new Date(d + "T12:00:00");
                      const isWknd = dt.getDay() === 0 || dt.getDay() === 6;
                      return (
                        <td
                          key={d}
                          onClick={() => canEdit && !isFuture && openCell(member, d)}
                          title={rec?.note ? `📝 ${rec.note}` : (canEdit && isTomorrow) ? "Click to pre-confirm tomorrow's attendance" : undefined}
                          className={`text-center border-b border-white/5 w-12 h-8 transition-colors
                            ${isToday ? "bg-violet-950/40" : isTomorrow ? "bg-teal-950/30" : ""}
                            ${isFuture || !canEdit ? "cursor-default" : "cursor-pointer hover:bg-white/5"}
                            ${!canEdit ? "opacity-20" : ""}`}
                          style={isWknd && !isToday && !isTomorrow ? { background: "repeating-linear-gradient(135deg, #0f0f12 0px, #0f0f12 4px, #16141a 4px, #16141a 8px)" } : undefined}
                        >
                          <AttCell status={rec?.status ?? ""} note={rec?.note} coaching={rec?.coaching} weekend={isWknd && !isTomorrow} />
                        </td>
                      );
                    })}
                    <td className="text-center text-xs font-mono border-b border-white/5 border-l border-white/10 tabular-nums text-emerald-400">{cIn || "—"}</td>
                    <td className="text-center text-xs font-mono border-b border-white/5 tabular-nums text-amber-400">{cOff || "—"}</td>
                    <td className="text-center text-xs font-mono border-b border-white/5 tabular-nums text-yellow-400">{cLate || "—"}</td>
                    <td className="text-center text-xs font-mono border-b border-white/5 tabular-nums text-blue-400">{cPto || "—"}</td>
                    <td className="text-center text-xs font-mono border-b border-white/5 tabular-nums text-red-400">{cNsnc || "—"}</td>
                    <td className="text-center border-b border-white/5">
                      {canManage && <button onClick={() => setEditingMember(member)} className="text-zinc-600 hover:text-zinc-300 transition-colors px-1 text-base leading-none">⋯</button>}
                    </td>
                  </tr>
                );
              })}
              {visible.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={dateCols.length + 9} className="text-center py-16 text-muted-foreground text-sm">
                    {(data?.members.length ?? 0) === 0 ? (
                      <>No members yet — <button onClick={doImport} disabled={importing} className="text-violet-400 hover:text-violet-300 underline">{importing ? "Importing…" : "import from Google Sheets"}</button> or add one above.</>
                    ) : (
                      <>No members in this department.</>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Legend */}
      <div className="flex items-center gap-4 text-xs text-muted-foreground pt-1">
        <span className="font-medium">Legend:</span>
        {ATT_STATUS.filter((x) => x.s).map(({ s, label, badge }) => (
          <span key={s} className={`flex items-center gap-1 ${badge}`}>
            <AttCell status={s} /> {label}
          </span>
        ))}
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500 inline-block" /> Has note</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-indigo-400 inline-block" /> Got coaching</span>
        <span className="ml-auto italic">Click any past cell to mark attendance or add a note</span>
      </div>

      {/* Cell editor overlay */}
      {editCell && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={(e) => { if (e.target === e.currentTarget) setEditCell(null); }}>
          <Card className="w-80 bg-zinc-900 border-violet-500/40 p-5 space-y-4 shadow-2xl">
            <div>
              <div className="font-semibold text-white">{editCell.name}</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {new Date(editCell.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
              </div>
            </div>
            <div className="flex gap-2 flex-wrap">
              {ATT_STATUS.map(({ s, label, cell }) => (
                <button
                  key={s}
                  onClick={() => setEditStatus(s)}
                  className={`px-3 py-1.5 rounded border text-xs font-medium transition-all
                    ${s ? cell : "bg-zinc-800/60 text-zinc-400 border-zinc-700/50"}
                    ${editStatus === s ? "ring-2 ring-white/40 opacity-100" : "opacity-60 hover:opacity-90"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1.5 block">Note (optional)</Label>
              <Input
                value={editNote}
                onChange={(e) => setEditNote(e.target.value)}
                placeholder="e.g. working from home, sick leave…"
                className="h-8 text-sm"
                onKeyDown={(e) => e.key === "Enter" && saveCell()}
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1.5 block">Coaching</Label>
              <button
                onClick={() => setEditCoaching((v) => !v)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded border text-xs font-medium transition-all w-full
                  ${editCoaching
                    ? "bg-indigo-500/25 text-indigo-300 border-indigo-500/50 ring-2 ring-indigo-400/40"
                    : "bg-zinc-800/60 text-zinc-400 border-zinc-700/50 hover:opacity-90"}`}
              >
                <span className={`w-2 h-2 rounded-full ${editCoaching ? "bg-indigo-400" : "bg-zinc-600"}`} />
                {editCoaching ? "Got coaching today" : "No coaching"}
              </button>
            </div>
            <div className="flex gap-2 justify-end pt-1">
              <Button size="sm" variant="ghost" onClick={() => setEditCell(null)}>Cancel</Button>
              <Button size="sm" className="bg-violet-600 hover:bg-violet-700 text-white" onClick={saveCell}>Save</Button>
            </div>
          </Card>
        </div>
      )}

      {/* Edit member overlay */}
      {editingMember && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={(e) => { if (e.target === e.currentTarget) setEditingMember(null); }}>
          <Card className="w-80 bg-zinc-900 border-white/20 p-5 space-y-4 shadow-2xl">
            <div className="font-semibold text-white">Edit Member</div>
            <div className="space-y-3">
              <div>
                <Label className="text-xs text-muted-foreground mb-1 block">Name</Label>
                <Input value={editingMember.name} onChange={(e) => setEditingMember({ ...editingMember, name: e.target.value })} className="h-8" />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground mb-1 block">Shift</Label>
                <Input value={editingMember.shift} onChange={(e) => setEditingMember({ ...editingMember, shift: e.target.value })} className="h-8" placeholder="e.g. 8" />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground mb-1 block">Department</Label>
                <Input value={editingMember.department} onChange={(e) => setEditingMember({ ...editingMember, department: e.target.value })} className="h-8" placeholder="e.g. Backend" />
              </div>
            </div>
            <div className="flex gap-2 justify-between pt-1">
              <Button size="sm" variant="destructive" onClick={() => { deactivateMember(editingMember.id); setEditingMember(null); }}>Remove</Button>
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => setEditingMember(null)}>Cancel</Button>
                <Button size="sm" className="bg-violet-600 hover:bg-violet-700 text-white" onClick={saveMember}>Save</Button>
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <LoginGate>
          <Dashboard />
        </LoginGate>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
