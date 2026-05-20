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
import { createContext, useContext, Fragment, useEffect, useMemo, useState, useCallback, useRef } from "react";
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
  ChevronRight,
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
  MessageCircle,
  Send,
  Sparkles,
  Paperclip,
  Minimize2,
  Maximize2,
  ChevronDown,
  Activity,
} from "lucide-react";

const queryClient = new QueryClient();

// ─── Auth Context ────────────────────────────────────────────────────────────

type Permission = "view_metrics" | "view_attendance" | "edit_attendance" | "manage_members" | "view_missed_tables";
const ALL_PERMISSIONS: { key: Permission; label: string; desc: string }[] = [
  { key: "view_metrics",      label: "View Metrics",        desc: "See Retention, NSF, CS & Quo Lines tabs" },
  { key: "view_attendance",   label: "View Attendance",     desc: "See the Attendance grid" },
  { key: "edit_attendance",   label: "Edit Attendance",     desc: "Click cells to mark status & add notes" },
  { key: "manage_members",    label: "Manage Members",      desc: "Add, edit, or remove attendance members" },
  { key: "view_missed_tables", label: "View Missed Tables", desc: "See Today's Missed by Hour and Daily Missed history (managers only)" },
];

const ALL_TABS: { value: string; label: string }[] = [
  { value: "retention",       label: "Retention" },
  { value: "cs",              label: "Internal CS" },
  { value: "nsf",             label: "NSF" },
  { value: "missed-no-cb",    label: "Missed / No CB" },
  { value: "callback-review", label: "CB Review" },
  { value: "violations",      label: "Violations" },
];

type TeamAccess = "retention" | "nsf" | "cs";
interface AuthUser { id: number; username: string; role: "admin" | "edit" | "view"; permissions: Permission[]; teamAccess?: TeamAccess | null; allowedTabs?: string[] | null; allowedAgents?: string[] | null; }
interface AuthCtx { user: AuthUser; token: string; logout: () => void; can: (p: Permission) => boolean; canSeeTab: (tab: string) => boolean; }
const UserContext = createContext<AuthCtx | null>(null);
function useUser() {
  const ctx = useContext(UserContext);
  if (!ctx) throw new Error("useUser must be used inside LoginGate");
  return ctx;
}
function authHeaders(token: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

// ─── Roster Context ──────────────────────────────────────────────────────────
// The team roster (`team_agents` DB table) is the canonical identity registry.
// Adding an agent here automatically makes them appear in Google Sheets matching
// AND OpenPhone/PBX call matching — no code change required.

type RosterTeam = "retention" | "nsf" | "cs";
interface RosterAgent { id: number; name: string; arabicName: string | null; shift: string | null; team: RosterTeam; active: boolean; }
interface RosterIndex {
  agents: RosterAgent[];
  version: number; // bump on any roster mutation; included in React Query keys for invalidation
  teamNames: Record<RosterTeam, Set<string>>;        // normalized name aliases per team (active only) — for "current visibility"
  teamNamesAll: Record<RosterTeam, Set<string>>;     // normalized name aliases per team (active + inactive) — for historical attribution
  phoneAliases: Record<string, string>;              // normalized arabic name → normalized english name (all agents)
  allowlist: Record<RosterTeam, Set<string>>;        // normalized phone keys allowed per team (active only)
  // Reverse lookup table: any normalized name (en or ar, full or compound segment) → roster agent.
  // Includes inactive agents so historical sheet rows still attribute correctly.
  byName: Map<string, RosterAgent>;
  // Helpers (resolve undefined when the roster has no entry for that name).
  lookupByAnyName(rawName: string): RosterAgent | null;
  teamForAgent(rawName: string): RosterTeam | null;
  agentsForTeam(team: RosterTeam, opts?: { includeInactive?: boolean }): RosterAgent[];
}

function emptyRosterIndex(): RosterIndex {
  const idx: RosterIndex = {
    agents: [],
    version: 0,
    teamNames: { retention: new Set(), nsf: new Set(), cs: new Set() },
    teamNamesAll: { retention: new Set(), nsf: new Set(), cs: new Set() },
    phoneAliases: {},
    allowlist: { retention: new Set(), nsf: new Set(), cs: new Set() },
    byName: new Map(),
    lookupByAnyName: () => null,
    teamForAgent: () => null,
    agentsForTeam: () => [],
  };
  return idx;
}

function buildRosterIndex(agents: RosterAgent[]): RosterIndex {
  const idx = emptyRosterIndex();
  idx.agents = agents;
  // Mutation-sensitive hash: changes on any add/remove/team/active/name/arabic/shift edit
  // so React Query keys keyed on `version` reliably re-fetch dependent sheet queries.
  idx.version = agents.reduce((acc, a) => {
    const s = `${a.id}|${a.team}|${a.active ? 1 : 0}|${a.name}|${a.arabicName ?? ""}|${a.shift ?? ""}`;
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return (acc + h) | 0;
  }, agents.length);
  for (const a of agents) {
    const enNorm = a.name.replace(/\s+/g, " ").trim().toLowerCase();
    const arNorm = a.arabicName ? a.arabicName.replace(/\s+/g, " ").trim().toLowerCase() : "";
    // Identity mappings (used for historical attribution) include EVERY agent, active or not —
    // so a deactivated person's past sheet rows still attribute to them and their team.
    if (enNorm) {
      idx.teamNamesAll[a.team].add(enNorm);
      idx.byName.set(enNorm, a);
    }
    if (arNorm) {
      idx.teamNamesAll[a.team].add(arNorm);
      idx.byName.set(arNorm, a);
      if (enNorm) idx.phoneAliases[arNorm] = enNorm;
    }
    // Active-only sets drive "current visibility" — which agents show up on tiles & phone allowlists.
    if (a.active) {
      if (enNorm) {
        idx.teamNames[a.team].add(enNorm);
        idx.allowlist[a.team].add(enNorm);
      }
      if (arNorm) {
        idx.teamNames[a.team].add(arNorm);
        idx.allowlist[a.team].add(arNorm);
      }
    }
  }

  // Bind helpers (use Map closures so call sites get a clean API).
  function norm(s: string): string { return s.replace(/\s+/g, " ").trim().toLowerCase(); }
  idx.lookupByAnyName = (rawName: string): RosterAgent | null => {
    if (!rawName) return null;
    const n = norm(rawName);
    const direct = idx.byName.get(n);
    if (direct) return direct;
    // Compound "Ahmed Ayman-Levi Miller-1234" → try each "-" segment.
    for (const seg of n.split("-").map(s => s.trim()).filter(Boolean)) {
      const hit = idx.byName.get(seg);
      if (hit) return hit;
    }
    return null;
  };
  idx.teamForAgent = (rawName: string): RosterTeam | null => idx.lookupByAnyName(rawName)?.team ?? null;
  idx.agentsForTeam = (team: RosterTeam, opts?: { includeInactive?: boolean }): RosterAgent[] => {
    const includeInactive = opts?.includeInactive ?? false;
    return agents.filter(a => a.team === team && (includeInactive || a.active));
  };
  return idx;
}

const RosterContext = createContext<RosterIndex>(emptyRosterIndex());
function useRoster(): RosterIndex { return useContext(RosterContext); }

function RosterProvider({ children }: { children: React.ReactNode }) {
  const { token } = useUser();
  const q = useQuery<RosterAgent[]>({
    queryKey: ["roster"],
    queryFn: async () => {
      const r = await fetch("/api/team-agents", { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) return [];
      return r.json() as Promise<RosterAgent[]>;
    },
    staleTime: 15_000,
    refetchInterval: 30_000, // poll every 30s so new roster entries appear within ~30s
    refetchOnWindowFocus: true,
  });
  const idx = useMemo(() => buildRosterIndex(q.data ?? []), [q.data]);
  return <RosterContext.Provider value={idx}>{children}</RosterContext.Provider>;
}

// Merge a roster's per-team aliases into a hardcoded fallback Set (returns a new Set).
// Roster-authoritative resolver per team.
// When the roster has at least one active name for this team, the roster is the
// canonical source of truth and the hardcoded fallback is IGNORED.
// The hardcoded list is only used as a safety net when the roster is empty for
// that team (e.g. fresh DB, before any roster entry has been added).
function unionTeamSet(hardcoded: Set<string> | undefined, fromRoster: Set<string> | undefined): Set<string> {
  if (fromRoster && fromRoster.size > 0) return new Set(fromRoster);
  return new Set(hardcoded ?? []);
}

// Roster-authoritative membership for a team. The AUTHORITY switch is based on
// ACTIVE roster presence (so a team that has only inactive roster rows still
// falls back to the hardcoded list and never goes empty). When at least one
// active roster row exists, membership = active + inactive (so historical
// rows for deactivated agents still attribute via past-date views).
function rosterTeamMembers(
  hardcoded: Set<string>,
  roster: RosterIndex | null | undefined,
  team: "retention" | "nsf" | "cs",
): Set<string> {
  if (!roster) return new Set(hardcoded);
  const active = roster.teamNames[team];
  if (!active || active.size === 0) return new Set(hardcoded);
  const all = roster.teamNamesAll[team] ?? active;
  return new Set([...active, ...all]);
}

// Per-team check: is the roster actively driving this team's membership?
function rosterDrivesTeam(roster: RosterIndex | null | undefined, team: "retention" | "nsf" | "cs"): boolean {
  return !!roster && (roster.teamNames[team]?.size ?? 0) > 0;
}

const RETENTION = {
  status: "https://docs.google.com/spreadsheets/d/1qF5Dc5quGrAywf5Rtx4q7DrX91VlNIFOfKr-REoSkII/export?format=csv&gid=0",
};
const NEW_RETENTION_URL =
  "https://docs.google.com/spreadsheets/d/1Eje6BABFbmRGHa6D1ET2sMvlE8o61iJ71yOvydD-R3o/export?format=csv&gid=837339339";
const NEW_NSF_URL =
  "https://docs.google.com/spreadsheets/d/11kOhk8xBPywxsAoULxS1b2QlofV7Le8ubawPoG7TZdc/export?format=csv&gid=0";
// IDP-Handled submissions tab in the same Discord-bot spreadsheet — all rows count as IDP-Handled.
// Browser fetches of this tab fail silently when fetched concurrently with gid=0 (same spreadsheet).
// Route through the API server proxy so the server fetches it without browser CORS constraints.
const IDP_RETENTION_URL =
  `/api/csv-proxy?url=${encodeURIComponent("https://docs.google.com/spreadsheets/d/11kOhk8xBPywxsAoULxS1b2QlofV7Le8ubawPoG7TZdc/export?format=csv&gid=871007220")}`;
// IDP Cancel Retained tab — same spreadsheet, fetched sequentially to avoid silent drops.
// Every row counts as "Retained" (file was ultimately retained via the IDP cancel path).
const IDP_CANCEL_RETAINED_URL =
  `/api/csv-proxy?url=${encodeURIComponent("https://docs.google.com/spreadsheets/d/11kOhk8xBPywxsAoULxS1b2QlofV7Le8ubawPoG7TZdc/export?format=csv&gid=1018337469")}`;
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

// Inspects every plausible text column on a submission row for the retain/cancel
// keywords. Used across all 4 sheet sources so the rule is consistent.
function detectKeywordStatus(r: Row): "Retained" | "Cancelled" | null {
  const fields = [
    r["Cancel request update"], r["File Status"], r["Status"],
    r["Notes"], r["Note"], r["Notes "], r["Note "],
    r["Comments"], r["Comment"], r["Reason"], r["Action"], r["Result"],
  ];
  let hasRetain = false;
  let hasCancel = false;
  for (const v of fields) {
    if (!v) continue;
    const s = v.toLowerCase();
    if (/retain|retention form/.test(s)) hasRetain = true;
    if (/\bcancel(?:l?ed|ling)?\b|revok/.test(s)) hasCancel = true;
  }
  // Retain wins over cancel — an ultimately retained file overrides a cancel-flagged note.
  if (hasRetain) return "Retained";
  if (hasCancel) return "Cancelled";
  return null;
}

// Normalized set of Retention agent names for fast membership checks.
// Defined here (before fetchRetentionCombinedSheet) but after normalizeAgent.
const RETENTION_AGENTS_NORM_EARLY = new Set([
  "levi miller", "ahmed ayman-levi miller", "henry hart", "ryan henderson", "michael belfort",
  "jacob stephenson", "katherine adams", "talia morgan", "rick miller", "dean lewis", "haythem",
]);

// Fetches old + new retention sheets AND the Discord-bot sheet (which Retention agents
// can now also submit to) AND the IDP-Handled tab, merging them all together.
// Agents who were temporarily on NSF but whose old NSF-sheet rows belong in the Retention panel.
const RETENTION_TEMP_NSF_AGENTS = new Set(["talia morgan", "tuqa hossam"]);

async function fetchRetentionCombinedSheet(
  roster?: RosterIndex,
  opts: { includeInactive?: boolean } = {},
): Promise<SheetData> {
  // Authority switch is based on ACTIVE roster presence — a team with only inactive
  // roster rows falls back to the hardcoded list (membership never goes empty).
  const rosterDrivesRetention = rosterDrivesTeam(roster, "retention");
  // Membership = active + inactive when roster is authoritative (so historical rows
  // for deactivated agents still route correctly when viewing past dates).
  const retentionNames = rosterTeamMembers(RETENTION_AGENTS_NORM_EARLY, roster, "retention");
  const nsfExcludeNames = rosterTeamMembers(RETENTION_SHEET_NSF_AGENTS, roster, "nsf");
  const csExcludeNames = rosterTeamMembers(RETENTION_SHEET_CS_AGENTS, roster, "cs");
  // Helper: should this raw "Agent Name" cell flow into the Retention panel?
  // Roster-authoritative when populated; otherwise legacy "exclude NSF/CS" behaviour.
  // Inactive-agent rows are dropped from CURRENT views only (opts.includeInactive=true
  // preserves them for past-date views — identity in roster.byName is always intact).
  const hideInactive = !opts.includeInactive;
  const includeForRetention = (agentRaw: string): boolean => {
    const hit = roster?.lookupByAnyName(agentRaw);
    if (hideInactive && hit && hit.active === false) return false;
    if (rosterDrivesRetention) {
      return roster!.teamForAgent(agentRaw) === "retention";
    }
    const n = normalizeAgent(agentRaw);
    return !nsfExcludeNames.has(n) && !csExcludeNames.has(n);
  };
  // Fetch the first four sheets in parallel (all from different spreadsheets).
  // IDP_RETENTION_URL shares the same spreadsheet as NEW_NSF_URL — fetching them
  // concurrently causes Google to silently drop one, so fetch IDP sequentially after.
  const [oldSheet, newSheet, discordSheet, oldNsfSheet] = await Promise.all([
    fetchHeaderCsv(RETENTION.status),
    fetchHeaderCsv(NEW_RETENTION_URL),
    fetchHeaderCsv(NEW_NSF_URL),
    fetchHeaderCsv(NSF.status).catch(() => ({ headers: [] as string[], rows: [] as Row[] })),
  ]);
  const idpSheet = await fetchHeaderCsv(IDP_RETENTION_URL).catch(() => ({ headers: [] as string[], rows: [] as Row[] }));
  const idpCancelSheet = await fetchHeaderCsv(IDP_CANCEL_RETAINED_URL).catch(() => ({ headers: [] as string[], rows: [] as Row[] }));

  const oldAgentCol = findColumn(oldSheet.headers, ["Agent", "Agent Name", "Rep"]);
  const oldStatusCol = findColumn(oldSheet.headers, ["Status", "Result", "Outcome", "Disposition"]);
  const oldDateCol = findColumn(oldSheet.headers, ["Date", "Day", "Call Date"]);
  const oldFileIdCol = findColumn(oldSheet.headers, ["File ID", "File Id", "FileID", "File #", "Account #", "Account ID", "Loan #", "ID"]);

  const rows: Row[] = [];

  // Keep every row from the old sheet exactly as it was
  // — but skip agents who belong to NSF (they're counted there instead).
  if (oldAgentCol && oldStatusCol) {
    for (const r of oldSheet.rows) {
      const agentRaw = (r[oldAgentCol] ?? "").trim();
      if (!includeForRetention(agentRaw)) continue;
      const dateStr = oldDateCol ? (r[oldDateCol] ?? "") : "";
      const d = oldDateCol ? parseDate(dateStr) : null;
      // Apply keyword override: Notes/other text fields containing retain/cancel
      // override the explicit Status column.
      const kw = detectKeywordStatus(r);
      rows.push({
        Agent: agentRaw,
        Status: kw ?? (r[oldStatusCol] ?? "").trim(),
        Date: d ? toIsoDate(d) : dateStr,
        "File ID": oldFileIdCol ? (r[oldFileIdCol] ?? "").trim() : "",
      });
    }
  }

  // Add new retention-specific sheet rows on/after the cutover date.
  // Skip NSF/CS cross-over agents here too.
  for (const r of newSheet.rows) {
    const tsRaw = (r["Timestamp"] ?? "").trim();
    const d = parseEgyptTimestamp(tsRaw);
    if (!d) continue;
    const caDate = toCaliforniaDateStr(d);
    if (caDate < "2026-05-04") continue;
    const agentRaw = (r["Agent Name"] ?? "").trim();
    if (!includeForRetention(agentRaw)) continue;
    const kw = detectKeywordStatus(r);
    rows.push({
      Agent: agentRaw,
      Status: kw ?? deriveNewRetentionStatus(r["Cancel request update"] ?? ""),
      Date: caDate,
      "File ID": (r["File ID"] ?? "").trim(),
    });
  }

  // Add Discord-bot sheet (same spreadsheet NSF uses, gid=0) rows for Retention agents.
  // Retention agents can now also submit there.
  for (const r of discordSheet.rows) {
    const tsRaw = (r["Timestamp"] ?? "").trim();
    const d = parseEgyptTimestamp(tsRaw);
    if (!d) continue;
    const caDate = toCaliforniaDateStr(d);
    if (caDate < "2026-05-04") continue;
    const agentRaw = (r["Agent Name"] ?? "").trim();
    const agentNorm = normalizeAgent(agentRaw);
    const segs = agentNorm.split("-").map(s => s.trim()).filter(Boolean);
    if (!retentionNames.has(agentNorm) && !segs.some(s => retentionNames.has(s))) continue;
    // Keyword wins, then fall back to the structured File Status mapping.
    const kw = detectKeywordStatus(r);
    let derivedStatus: string;
    if (kw) {
      derivedStatus = kw;
    } else {
      const fileStatus = (r["File Status"] ?? "").toLowerCase();
      derivedStatus = /cancel|revok/.test(fileStatus)
        ? "Cancelled"
        : /\bfixed\b|\bidp\b/.test(fileStatus)
        ? "IDP-Handled"
        : "Retained";
    }
    rows.push({
      Agent: agentRaw,
      Status: derivedStatus,
      Date: caDate,
      "File ID": (r["File ID"] ?? "").trim(),
    });
  }

  // Add IDP-Handled tab rows (gid=871007220) — every row from Retention agents = IDP-Handled,
  // unless Notes explicitly say retain/cancel.
  // Compound names like "nour-michael belfort-2900" are matched by checking each segment.
  for (const r of idpSheet.rows) {
    const tsRaw = (r["Timestamp"] ?? "").trim();
    const d = parseEgyptTimestamp(tsRaw);
    if (!d) continue;
    const caDate = toCaliforniaDateStr(d);
    const agentRaw = (r["Agent Name"] ?? "").trim();
    if (!agentRaw) continue;
    const agentNorm = normalizeAgent(agentRaw);
    const segments = agentNorm.split("-").map(s => s.trim()).filter(Boolean);
    const isRetentionAgent = retentionNames.has(agentNorm)
      || segments.some(seg => retentionNames.has(seg));
    if (!isRetentionAgent) continue;
    // IDP-Handled tab is its own classification; keyword override does NOT apply here
    // (every submission to this sheet is by definition an IDP-Handled action).
    rows.push({ Agent: agentRaw, Status: "IDP-Handled", Date: caDate, "File ID": (r["File ID"] ?? "").trim() });
  }

  // Add IDP Cancel Retained tab rows (gid=1018337469) — every row counts as "Retained"
  // (folded into the regular Retained metric). Keyword override still wins (e.g. a row
  // whose Notes explicitly say "cancel" should be a Cancellation).
  for (const r of idpCancelSheet.rows) {
    const tsRaw = (r["Timestamp"] ?? "").trim();
    const d = parseEgyptTimestamp(tsRaw);
    if (!d) continue;
    const caDate = toCaliforniaDateStr(d);
    const agentRaw = (r["Agent Name"] ?? "").trim();
    if (!agentRaw) continue;
    // Per task plan: every row from the IDP Cancel Retained tab counts as Retained.
    // The keyword scanner does NOT apply here — this tab is its own "ultimately
    // retained via the IDP cancel path" classification.
    rows.push({ Agent: agentRaw, Status: "Retained", Date: caDate, "File ID": (r["File ID"] ?? "").trim() });
  }

  // Pull Talia Morgan / Tuqa Hossam rows from the old NSF sheet.
  // She was temporarily on NSF; all her NSF submissions count as "Fixed" in Retention.
  const nsfAgentCol = findColumn(oldNsfSheet.headers, ["Agent", "Agent Name", "Rep"]);
  const nsfDateCol = findColumn(oldNsfSheet.headers, ["Date", "Day", "Call Date"]);
  const nsfFileIdCol = findColumn(oldNsfSheet.headers, ["File ID", "File Id", "FileID", "File #", "Account #", "Account ID", "Loan #", "ID"]);
  if (nsfAgentCol) {
    for (const r of oldNsfSheet.rows) {
      const agentRaw = (r[nsfAgentCol] ?? "").trim();
      if (!agentRaw || /total$/i.test(agentRaw)) continue;
      const agentNorm = normalizeAgent(agentRaw);
      const resolvedKey = NAME_ALIASES[agentNorm] ?? agentNorm;
      const segments = agentNorm.split("-").map(s => s.trim()).filter(Boolean);
      const matches = RETENTION_TEMP_NSF_AGENTS.has(agentNorm)
        || RETENTION_TEMP_NSF_AGENTS.has(resolvedKey)
        || segments.some(seg => RETENTION_TEMP_NSF_AGENTS.has(seg));
      if (!matches) continue;
      const dateStr = nsfDateCol ? (r[nsfDateCol] ?? "").trim() : "";
      const d = parseDate(dateStr);
      rows.push({
        Agent: "Talia Morgan",
        Status: "Fixed",
        Date: d ? toIsoDate(d) : dateStr,
        "File ID": nsfFileIdCol ? (r[nsfFileIdCol] ?? "").trim() : "",
      });
    }
  }

  // Manually added retained files not present in CRM portal (added 2026-05-13)
  const MANUAL_RETAINED: Row[] = [
    { Agent: "Ahmed Ayman-Levi Miller", Status: "Retained", Date: "2026-05-12", "File ID": "1178162824" },
    { Agent: "Ahmed Ayman-Levi Miller", Status: "Retained", Date: "2026-05-12", "File ID": "1206222742" },
  ];
  rows.push(...MANUAL_RETAINED);

  return { headers: ["Agent", "Status", "Date", "File ID"], rows };
}

// Pulls Retention-sheet rows for NSF cross-over agents (e.g. Katie Miller) and maps
// their *retained* submissions to "Fixed" so they count in the NSF panel.
async function fetchRetentionSheetNSFCrossoverRows(
  roster?: RosterIndex,
  opts: { includeInactive?: boolean } = {},
): Promise<Row[]> {
  // Membership preserves history (active + inactive when roster authoritative).
  const nsfNames = rosterTeamMembers(RETENTION_SHEET_NSF_AGENTS, roster, "nsf");
  // Current-view hide is gated — past-date callers pass includeInactive=true.
  const hideInactive = !opts.includeInactive;
  const isInactive = (raw: string) => hideInactive && roster?.lookupByAnyName(raw)?.active === false;
  const [oldSheet, newSheet] = await Promise.all([
    fetchHeaderCsv(RETENTION.status),
    fetchHeaderCsv(NEW_RETENTION_URL),
  ]);

  const oldAgentCol = findColumn(oldSheet.headers, ["Agent", "Agent Name", "Rep"]);
  const oldStatusCol = findColumn(oldSheet.headers, ["Status", "Result", "Outcome", "Disposition"]);
  const oldDateCol = findColumn(oldSheet.headers, ["Date", "Day", "Call Date"]);

  const rows: Row[] = [];

  if (oldAgentCol && oldStatusCol) {
    for (const r of oldSheet.rows) {
      const agentRaw = (r[oldAgentCol] ?? "").trim();
      if (!nsfNames.has(normalizeAgent(agentRaw))) continue;
      if (isInactive(agentRaw)) continue;
      const kw = detectKeywordStatus(r);
      const rawStatus = kw ?? (r[oldStatusCol] ?? "").trim();
      if (!isRetainedStatus(rawStatus)) continue;
      const dateStr = oldDateCol ? (r[oldDateCol] ?? "") : "";
      const d = oldDateCol ? parseDate(dateStr) : null;
      rows.push({ Agent: agentRaw, Status: "Retained", Date: d ? toIsoDate(d) : dateStr });
    }
  }

  for (const r of newSheet.rows) {
    const tsRaw = (r["Timestamp"] ?? "").trim();
    const d = parseEgyptTimestamp(tsRaw);
    if (!d) continue;
    const caDate = toCaliforniaDateStr(d);
    const agentRaw = (r["Agent Name"] ?? "").trim();
    if (!nsfNames.has(normalizeAgent(agentRaw))) continue;
    if (isInactive(agentRaw)) continue;
    const kw = detectKeywordStatus(r);
    const derived = kw ?? deriveNewRetentionStatus(r["Cancel request update"] ?? "");
    if (!isRetainedStatus(derived)) continue;
    rows.push({ Agent: agentRaw, Status: "Retained", Date: caDate });
  }

  return rows;
}

// Pulls Retention-sheet rows for CS/NSF cross-over agents and maps their retained
// submissions to "Retained". Cancelled rows are intentionally dropped.
async function fetchRetentionSheetCSCrossoverRows(
  roster?: RosterIndex,
  opts: { includeInactive?: boolean } = {},
): Promise<Row[]> {
  // Membership preserves history (active + inactive when roster authoritative).
  const csNames = rosterTeamMembers(RETENTION_SHEET_CS_AGENTS, roster, "cs");
  // Current-view hide is gated — past-date callers pass includeInactive=true.
  const hideInactive = !opts.includeInactive;
  const isInactive = (raw: string) => hideInactive && roster?.lookupByAnyName(raw)?.active === false;
  const [oldSheet, newSheet] = await Promise.all([
    fetchHeaderCsv(RETENTION.status),
    fetchHeaderCsv(NEW_RETENTION_URL),
  ]);

  const oldAgentCol = findColumn(oldSheet.headers, ["Agent", "Agent Name", "Rep"]);
  const oldStatusCol = findColumn(oldSheet.headers, ["Status", "Result", "Outcome", "Disposition"]);
  const oldDateCol = findColumn(oldSheet.headers, ["Date", "Day", "Call Date"]);

  const rows: Row[] = [];

  if (oldAgentCol && oldStatusCol) {
    for (const r of oldSheet.rows) {
      const agentRaw = (r[oldAgentCol] ?? "").trim();
      if (!csNames.has(normalizeAgent(agentRaw))) continue;
      if (isInactive(agentRaw)) continue;
      const kw = detectKeywordStatus(r);
      const rawStatus = kw ?? (r[oldStatusCol] ?? "").trim();
      if (!isRetainedStatus(rawStatus)) continue;
      const dateStr = oldDateCol ? (r[oldDateCol] ?? "") : "";
      const d = oldDateCol ? parseDate(dateStr) : null;
      rows.push({ Agent: agentRaw, Status: "Retained", Date: d ? toIsoDate(d) : dateStr });
    }
  }

  for (const r of newSheet.rows) {
    const tsRaw = (r["Timestamp"] ?? "").trim();
    const d = parseEgyptTimestamp(tsRaw);
    if (!d) continue;
    const caDate = toCaliforniaDateStr(d);
    const agentRaw = (r["Agent Name"] ?? "").trim();
    if (!csNames.has(normalizeAgent(agentRaw))) continue;
    if (isInactive(agentRaw)) continue;
    const kw = detectKeywordStatus(r);
    const derived = kw ?? deriveNewRetentionStatus(r["Cancel request update"] ?? "");
    if (!isRetainedStatus(derived)) continue;
    rows.push({ Agent: agentRaw, Status: "Retained", Date: caDate });
  }

  return rows;
}

const NAME_ALIASES: Record<string, string> = {
  "kaite miller": "katie miller",
  // Compound Discord-bot names → canonical English display name
  // Ensures aggregate() merges submissions under one row and sheetToPhoneKey resolves correctly.
  "ahmed gamal-austin white":      "austin white",
  "raneem-renee solomon-3209":     "renee solomon",
  "omar badr-kevin micheal-3140":  "kevin micheal",
  "yousef taher-raymond reed-2977":"raymond reed",
  "engy-ellie moser-2046":         "ellie moser",
  // Retention: Arabic OpenPhone / Discord names → compound display name
  // Needed so submissions using the Arabic name merge into the same agent row as the compound name.
  "ahmed ayman":       "ahmed ayman-levi miller",
  "tuqa hossam":       "talia morgan",
  "abdulrhman isawi":          "jacob stephenson",
  "abdlrhman-adam maxwell":    "jacob stephenson",
  "abdlrhman-jacob stephenson":"jacob stephenson",
  // Youssef Nasser / Youssef-John Marcus → John Marcus
  "youssef nasser":            "john marcus",
  "youssef-john marcus":       "john marcus",
  // Haythem → Dean Lewis
  "haythem":                   "dean lewis",
  "zeiad fouad":       "rick miller",
  "karma farouk":      "katherine adams",
  "muhamed walid":     "ryan henderson",
  "nouralden":         "michael belfort",
  "saif aziz":         "henry hart",
};

// Egypt shift number → label (Egypt local time)
// Shift 4 = 4pm–12am EGY, Shift 5 = 5pm–1am EGY, Shift 6 = 6pm–2am EGY,
// Shift 7 = 7pm–3am EGY, Shift 8 = 8pm–4am EGY
const SHIFT_COLORS: Record<number, string> = {
  4: "bg-blue-700",
  5: "bg-emerald-700",
  6: "bg-orange-700",
  7: "bg-pink-700",
  8: "bg-red-700",
};

const AGENT_SHIFTS: Record<string, { num: number; label: string; color: string }> = {
  // CS
  "ella monroe":       { num: 4, label: "Shift 4 · 4pm EGY", color: SHIFT_COLORS[4]! },
  "chase miller":      { num: 4, label: "Shift 4 · 4pm EGY", color: SHIFT_COLORS[4]! },
  "leo carter":        { num: 5, label: "Shift 5 · 5pm EGY", color: SHIFT_COLORS[5]! },
  "nora adam":         { num: 6, label: "Shift 6 · 6pm EGY", color: SHIFT_COLORS[6]! },
  "jacob xander":      { num: 8, label: "Shift 8 · 8pm EGY", color: SHIFT_COLORS[8]! },
  "carla bennet":      { num: 8, label: "Shift 8 · 8pm EGY", color: SHIFT_COLORS[8]! },
  // Retention
  "levi miller":            { num: 4, label: "Shift 4 · 4pm EGY", color: SHIFT_COLORS[4]! },
  "ahmed ayman":            { num: 4, label: "Shift 4 · 4pm EGY", color: SHIFT_COLORS[4]! },
  "ahmed ayman-levi miller":{ num: 4, label: "Shift 4 · 4pm EGY", color: SHIFT_COLORS[4]! },
  "henry hart":        { num: 4, label: "Shift 4 · 4pm EGY", color: SHIFT_COLORS[4]! },
  "rick miller":       { num: 4, label: "Shift 4 · 4pm EGY", color: SHIFT_COLORS[4]! },
  "zeiad fouad":       { num: 4, label: "Shift 4 · 4pm EGY", color: SHIFT_COLORS[4]! },
  "michael belfort":   { num: 5, label: "Shift 5 · 5pm EGY", color: SHIFT_COLORS[5]! },
  "ryan henderson":    { num: 5, label: "Shift 5 · 5pm EGY", color: SHIFT_COLORS[5]! },
  "katherine adams":   { num: 5, label: "Shift 5 · 5pm EGY", color: SHIFT_COLORS[5]! },
  "talia morgan":      { num: 6, label: "Shift 6 · 6pm EGY", color: SHIFT_COLORS[6]! },
  "jacob stephenson":  { num: 7, label: "Shift 7 · 7pm EGY", color: SHIFT_COLORS[7]! },
  "abdulrhman isawi":  { num: 7, label: "Shift 7 · 7pm EGY", color: SHIFT_COLORS[7]! },
};

function ShiftDot({ agentName }: { agentName: string }) {
  const shift = AGENT_SHIFTS[agentName.toLowerCase().trim()];
  if (!shift) return null;
  return (
    <span
      title={shift.label}
      className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-[11px] font-extrabold text-white leading-none shadow-md ring-2 ring-black/30 ${shift.color}`}
      style={{ verticalAlign: "middle", flexShrink: 0 }}
    >
      {shift.num}
    </span>
  );
}

// Agents who submit files in the Retention sheet but actually belong to the NSF team.
// Their rows are EXCLUDED from Retention stats and counted as "Fixed" in NSF instead.
const RETENTION_SHEET_NSF_AGENTS = new Set([
  "katie miller", "sama farouk",
  "zach carter", "ziad",
  "austin white", "ahmed gamal", "ahmed gamal-austin white",
  "rika hart", "riham samir",
  "jenny morgan", "ayaat",
  "renee solomon", "raneem", "raneem-renee solomon-3209",
  "ellie moser", "engy mahmoud",
  "estella cruz", "eman khamis",
  "kevin micheal", "omar badr", "omar badr-kevin micheal-3140",
  "raymond reed", "yousef taher", "yousef taher-raymond reed-2977",
  // New agents — May 2026
  "kayla navarro", "jana",
  "jana-kayla navarro-2718",
  "alex miller", "seif eslam",
  "tyler grant", "abdelrahman",
  "otto klein", "omar",
]);

// Agents who submit files in the Retention sheet but actually belong to the CS team.
// Their RETAINED submissions are counted as "Fixed" in CS; CANCELLED rows are dropped entirely.
const RETENTION_SHEET_CS_AGENTS = new Set([
  // English display names
  "ella monroe", "chase miller", "leo carter", "nora adam", "jacob xander", "carla bennet",
  // Arabic / alias names
  "hiba kamil", "nour eldin atef", "nour eldin", "fares", "nourhan ame", "nourhan amr", "youssef nady", "bassant emad",
  // Compound old-sheet names
  "youssef nady-jacob xander",
  "nour eldin-chase miller-2787",
  "hiba kamil-ella monroe-2882",
  "nourhan amr-nora adam-2186",
  // New agents — May 2026
  "anna stone", "anisa", "anisa-anna stone-2382",
]);

// NSF agent display names (normalized lowercase) — used to split the shared
// Discord-bot sheet between NSF and CS.
const NSF_AGENT_NAMES = new Set([
  // English display names
  "zach carter", "austin white", "rika hart", "jenny morgan",
  "renee solomon", "ellie moser", "estella cruz", "katie miller",
  "kevin micheal", "raymond reed",
  // Arabic / alias names
  "ziad", "ahmed gamal", "riham samir", "ayaat",
  "raneem", "engy mahmoud", "eman khamis", "sama farouk",
  "omar badr", "yousef taher",
  // Compound Discord-bot names
  "raneem-renee solomon-3209",
  "ahmed gamal-austin white",
  "omar badr-kevin micheal-3140",
  "yousef taher-raymond reed-2977",
  // New agents — May 2026
  "kayla navarro", "jana",
  "jana-kayla navarro-2718",
  "alex miller", "seif eslam",
  "tyler grant", "abdelrahman",
  "otto klein", "omar",
]);
// CS agent display names (normalized lowercase)
const CS_AGENT_NAMES = new Set([
  // English display names
  "ella monroe", "chase miller", "leo carter", "nora adam", "jacob xander", "carla bennet",
  // Arabic / alias names
  "hiba kamil", "nour eldin atef", "nour eldin", "fares", "nourhan amr", "nourhan ame", "youssef nady", "bassant emad",
  // Compound old-sheet names (submitted in retention / IDP sheets)
  "youssef nady-jacob xander",
  "nour eldin-chase miller-2787",
  "hiba kamil-ella monroe-2882",
  "nourhan amr-nora adam-2186",
  // New agents — May 2026
  "anna stone", "anisa", "anisa-anna stone-2382",
]);

type CancelViolation = {
  key: string; agent: string; team: "CS" | "NSF"; date: string; rawStatus: string; fileId: string;
};

// Scans the retention sheets (Sheet 1 old + Sheet 1 new) for CS/NSF agents who submitted
// a Cancelled row. Returns one entry per unique agent+date+fileId combination.
async function fetchCancelViolations(
  roster?: RosterIndex,
  _opts: { includeInactive?: boolean } = {},
): Promise<CancelViolation[]> {
  // Violations always preserve history (membership = active + inactive when roster
  // authoritative). Currently we don't hide inactive here since the violation list
  // surfaces past offences regardless of current employment.
  const csNames = rosterTeamMembers(RETENTION_SHEET_CS_AGENTS, roster, "cs");
  const nsfNames = rosterTeamMembers(RETENTION_SHEET_NSF_AGENTS, roster, "nsf");
  const [oldSheet, newSheet] = await Promise.all([
    fetchHeaderCsv(RETENTION.status).catch(() => ({ headers: [] as string[], rows: [] as Row[] })),
    fetchHeaderCsv(NEW_RETENTION_URL).catch(() => ({ headers: [] as string[], rows: [] as Row[] })),
  ]);
  const violations: CancelViolation[] = [];
  const seen = new Set<string>();

  const oldAgentCol  = findColumn(oldSheet.headers, ["Agent", "Agent Name", "Rep"]);
  const oldStatusCol = findColumn(oldSheet.headers, ["Status", "Result", "Outcome", "Disposition"]);
  const oldDateCol   = findColumn(oldSheet.headers, ["Date", "Day", "Call Date"]);
  const oldFileCol   = findColumn(oldSheet.headers, ["File ID", "File Id", "FileID", "file id"]);
  if (oldAgentCol && oldStatusCol) {
    for (const r of oldSheet.rows) {
      const agentRaw = (r[oldAgentCol] ?? "").trim();
      const agentNorm = normalizeAgent(agentRaw);
      let team: "CS" | "NSF" | null = null;
      if (csNames.has(agentNorm)) team = "CS";
      else if (nsfNames.has(agentNorm)) team = "NSF";
      if (!team) continue;
      const kw = detectKeywordStatus(r);
      if (kw === "Retained") continue; // keyword override says retained → not a violation
      const rawStatus = kw ?? (r[oldStatusCol] ?? "").trim();
      if (!rawStatus || isRetainedStatus(rawStatus)) continue;
      const dateStr = oldDateCol ? (r[oldDateCol] ?? "") : "";
      const d = oldDateCol ? parseDate(dateStr) : null;
      const date = d ? toIsoDate(d) : dateStr;
      const fileId = (oldFileCol ? (r[oldFileCol] ?? "") : "").trim();
      const key = `cancel:old:${agentNorm}:${date}:${fileId}`;
      if (!seen.has(key)) { seen.add(key); violations.push({ key, agent: agentRaw, team, date, rawStatus, fileId }); }
    }
  }

  const newFileCol = findColumn(newSheet.headers, ["File ID", "File Id", "FileID", "file id"]);
  for (const r of newSheet.rows) {
    const tsRaw = (r["Timestamp"] ?? "").trim();
    const d = parseEgyptTimestamp(tsRaw);
    if (!d) continue;
    const caDate = toCaliforniaDateStr(d);
    const agentRaw = (r["Agent Name"] ?? "").trim();
    if (!agentRaw) continue;
    const agentNorm = normalizeAgent(agentRaw);
    let team: "CS" | "NSF" | null = null;
    if (csNames.has(agentNorm)) team = "CS";
    else if (nsfNames.has(agentNorm)) team = "NSF";
    if (!team) continue;
    const kw = detectKeywordStatus(r);
    if (kw === "Retained") continue;
    const updateVal = (r["Cancel request update"] ?? "").trim();
    if (kw !== "Cancelled") {
      if (!updateVal) continue; // blank = still pending, not yet confirmed cancelled
      const derived = deriveNewRetentionStatus(updateVal);
      if (isRetainedStatus(derived)) continue;
    }
    const fileId = (newFileCol ? (r[newFileCol] ?? "") : "").trim();
    const key = `cancel:new:${agentNorm}:${caDate}:${fileId}`;
    if (!seen.has(key)) { seen.add(key); violations.push({ key, agent: agentRaw, team, date: caDate, rawStatus: "Cancelled", fileId }); }
  }

  return violations.sort((a, b) => b.date.localeCompare(a.date));
}

// Shared helper: parses the Discord-bot sheet (gid=0) and returns rows belonging to a team.
// Submissions to the Discord/NSF backend sheet — normally count as "Fixed".
// EXCEPTION: if the "Cancel request update" or "File Status" or "Notes" field
// contains "retain" / "retention", the file was ultimately retained and should
// count as "Retained" instead so it appears in the retention metrics.
async function fetchNewSheetForTeam(teamNames: Set<string>): Promise<Row[]> {
  const newSheet = await fetchHeaderCsv(NEW_NSF_URL);
  const rows: Row[] = [];
  for (const r of newSheet.rows) {
    const tsRaw = (r["Timestamp"] ?? "").trim();
    const d = parseEgyptTimestamp(tsRaw);
    if (!d) continue;
    const caDate = toCaliforniaDateStr(d);
    const agentRaw = (r["Agent Name"] ?? "").trim();
    const agentNorm = normalizeAgent(agentRaw);
    const resolvedKey = NAME_ALIASES[agentNorm] ?? agentNorm;
    const segments = agentNorm.split("-").map(s => s.trim()).filter(Boolean);
    const matches = teamNames.has(agentNorm) || teamNames.has(resolvedKey)
      || segments.some(seg => teamNames.has(seg));
    if (!matches) continue;
    // Keyword override (retain/cancel) across all text fields, including Notes.
    const kw = detectKeywordStatus(r);
    rows.push({ Agent: agentRaw, Status: kw ?? "Fixed", Date: caDate });
  }
  return rows;
}

// Shared helper: parses the IDP-Handled tab (gid=871007220) and returns rows for a team.
// Every submission to this sheet counts as "IDP-Handled".
// Compound agent names like "riham samir-rika hart-1234" are matched by checking each
// dash-separated segment against teamNames so new formats are handled automatically.
async function fetchIDPSheetForTeam(teamNames: Set<string>): Promise<Row[]> {
  const sheet = await fetchHeaderCsv(IDP_RETENTION_URL).catch(() => ({ headers: [] as string[], rows: [] as Row[] }));
  const rows: Row[] = [];
  for (const r of sheet.rows) {
    const tsRaw = (r["Timestamp"] ?? "").trim();
    const d = parseEgyptTimestamp(tsRaw);
    if (!d) continue;
    const caDate = toCaliforniaDateStr(d);
    const agentRaw = (r["Agent Name"] ?? "").trim();
    if (!agentRaw) continue;
    const agentNorm = normalizeAgent(agentRaw);
    const resolvedKey = NAME_ALIASES[agentNorm] ?? agentNorm;
    // Also try each segment of compound names (e.g. "riham samir-rika hart-1234" → ["riham samir", "rika hart", "1234"])
    const segments = agentNorm.split("-").map(s => s.trim()).filter(Boolean);
    const matches = teamNames.has(agentNorm) || teamNames.has(resolvedKey)
      || segments.some(seg => teamNames.has(seg));
    if (!matches) continue;
    // IDP-Handled tab is its own classification; keyword override does NOT apply here
    // (every submission to this sheet is by definition an IDP-Handled action).
    rows.push({ Agent: agentRaw, Status: "IDP-Handled", Date: caDate });
  }
  return rows;
}

// Fetches NSF submissions from the same 3 sources as CS:
//   – Old retention sheet (Sheet 1, gid=837339339) → Retained (via crossover)
//   – Discord-bot gid=0 (Sheet 2)                  → Fixed
//   – IDP-Handled tab (Sheet 3, gid=871007220)      → IDP-Handled
async function fetchNSFCombinedSheet(
  roster?: RosterIndex,
  opts: { includeInactive?: boolean } = {},
): Promise<SheetData> {
  // Membership preserves history (active + inactive when roster authoritative).
  const teamNames = rosterTeamMembers(NSF_AGENT_NAMES, roster, "nsf");
  const hideInactive = !opts.includeInactive;
  // fetchNewSheetForTeam (gid=0) and fetchIDPSheetForTeam (gid=871007220) use the same
  // spreadsheet — serialize to avoid Google dropping the concurrent second request.
  const [newRows, crossoverRows, oldNsfSheet] = await Promise.all([
    fetchNewSheetForTeam(teamNames),
    fetchRetentionSheetNSFCrossoverRows(roster),
    fetchHeaderCsv(NSF.status).catch(() => ({ headers: [] as string[], rows: [] as Row[] })),
  ]);
  const idpRows = await fetchIDPSheetForTeam(teamNames);

  // Pull pre-cutover rows from the old NSF sheet (where agents tracked files before the Discord-bot sheet).
  // All rows map to "Fixed" since every row represents a file the agent submitted/handled.
  const oldNsfRows: Row[] = [];
  const oldAgentCol = findColumn(oldNsfSheet.headers, ["Agent", "Agent Name", "Rep"]);
  const oldDateCol = findColumn(oldNsfSheet.headers, ["Date", "Day", "Call Date"]);
  if (oldAgentCol) {
    for (const r of oldNsfSheet.rows) {
      const agentRaw = (r[oldAgentCol] ?? "").trim();
      if (!agentRaw || /total$/i.test(agentRaw)) continue;
      const agentNorm = normalizeAgent(agentRaw);
      const resolvedKey = NAME_ALIASES[agentNorm] ?? agentNorm;
      const segments = agentNorm.split("-").map(s => s.trim()).filter(Boolean);
      const matches = teamNames.has(agentNorm) || teamNames.has(resolvedKey)
        || segments.some(seg => teamNames.has(seg));
      if (!matches) continue;
      if (hideInactive && roster?.lookupByAnyName(agentRaw)?.active === false) continue;
      const dateStr = oldDateCol ? (r[oldDateCol] ?? "").trim() : "";
      const d = parseDate(dateStr);
      const kw = detectKeywordStatus(r);
      oldNsfRows.push({ Agent: agentRaw, Status: kw ?? "Fixed", Date: d ? toIsoDate(d) : dateStr });
    }
  }

  // Current-view hide is gated by hideInactive. Past-date views (includeInactive=true)
  // keep deactivated agents' rows so historical totals stay intact.
  const keep = (r: Row) => !hideInactive || roster?.lookupByAnyName((r["Agent"] ?? "") as string)?.active !== false;
  const merged = [...newRows, ...crossoverRows, ...idpRows, ...oldNsfRows].filter(keep);
  return { headers: ["Agent", "Status", "Date"], rows: merged };
}

// Fetches CS submissions from all 3 sources:
//   – Discord-bot gid=0 (Sheet 2) → Fixed
//   – Old retention sheet (Sheet 1) → Fixed (retained only)
//   – IDP-Handled tab (Sheet 3)    → IDP-Handled
async function fetchCSCombinedSheet(
  roster?: RosterIndex,
  opts: { includeInactive?: boolean } = {},
): Promise<SheetData> {
  // Membership preserves history (active + inactive when roster authoritative).
  const teamNames = rosterTeamMembers(CS_AGENT_NAMES, roster, "cs");
  const hideInactive = !opts.includeInactive;
  // fetchNewSheetForTeam (gid=0) and fetchIDPSheetForTeam (gid=871007220) use the same
  // spreadsheet — serialize to avoid Google dropping the concurrent second request.
  const [newRows, crossoverRows] = await Promise.all([
    fetchNewSheetForTeam(teamNames),
    fetchRetentionSheetCSCrossoverRows(roster),
  ]);
  const idpRows = await fetchIDPSheetForTeam(teamNames);
  // Current-view hide is gated by hideInactive. Past-date views (includeInactive=true)
  // keep deactivated agents' rows so historical totals stay intact.
  const keep = (r: Row) => !hideInactive || roster?.lookupByAnyName((r["Agent"] ?? "") as string)?.active !== false;
  const merged = [...newRows, ...crossoverRows, ...idpRows].filter(keep);
  return { headers: ["Agent", "Status", "Date"], rows: merged };
}

function findColumn(headers: string[], candidates: string[]): string | null {
  const lower = headers.map((h) => h.toLowerCase().trim());
  for (const c of candidates) {
    const idx = lower.indexOf(c.toLowerCase().trim());
    if (idx >= 0) return headers[idx];
  }
  return null;
}

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
  retention: ["Michael Ross"],
  nsf: [],
  cs: [],
};

// Strict allowlist per team — normalized phone key variants for each real agent.
// Only agents whose phoneData key appears here will be shown in any view.
const TEAM_ALLOWLIST: Record<string, Set<string>> = {
  retention: new Set([
    // Levi Miller / Ahmed Ayman
    "levi miller", "ahmed ayman",
    // Henry Hart / Saif Aziz
    "henry hart", "saif aziz",
    // Ryan Henderson / Muhamed Walid
    "ryan henderson", "muhamed walid",
    // Michael Belfort / Nouralden
    "michael belfort", "nouralden",
    // Jacob Stephenson / Abdlrhman / Adam Maxwell
    "jacob stephenson", "abdulrhman isawi", "adam maxwell",
    // John Marcus / Youssef Nasser / Youssef-John Marcus
    "john marcus", "youssef nasser", "youssef-john marcus",
    // Katherine Adams / Karma Farouk
    "katherine adams", "karma farouk",
    // Rick Miller / Zeiad Fouad
    "rick miller", "zeiad fouad",
    // Talia Morgan / Tuqa Hossam
    "talia morgan", "tuqa hossam",
    // Michael Belfort / Nour (Nour-Michael Belfort-2900 line)
    "michael belfort", "nouralden",
    // Dean Lewis / Haythem (ext 2089)
    "dean lewis", "haythem",
    // Legacy extras kept for historical data
    "max francis", "michael ross",
  ]),
  nsf: new Set([
    // Zach Carter / Ziad
    "zach carter", "ziad",
    // Austin White / Ahmed Gamal
    "austin white", "ahmed gamal",
    // Rika Hart / Riham Samir
    "rika hart", "riham samir",
    // Jenny Morgan / Ayaat
    "jenny morgan", "ayaat",
    // Renee Solomon / Raneem
    "renee solomon", "raneem",
    // Ellie Moser / Engy Mahmoud
    "ellie moser", "engy mahmoud",
    // Estella Cruz / Eman Khamis
    "estella cruz", "eman khamis",
    // Katie Miller / Sama Farouk
    "katie miller", "sama farouk",
    // Kevin Micheal / Omar Badr
    "kevin micheal", "omar badr", "omar badr-kevin micheal-3140",
    // Raymond Reed / Yousef Taher
    "raymond reed", "yousef taher", "yousef taher-raymond reed-2977",
    // Austin White / Ahmed Gamal (compound Discord name)
    "ahmed gamal-austin white",
  ]),
  cs: new Set([
    // Ella Monroe / Hiba Kamil
    "ella monroe", "hiba kamil",
    // Chase Miller / Nour Eldin Atef
    "chase miller", "nour eldin atef",
    // Leo Carter / Fares
    "leo carter", "fares",
    // Nora Adam / Nourhan Ame
    "nora adam", "nourhan ame",
    // Jacob Xander / Youssef Nady
    "jacob xander", "youssef nady",
    // Carla Bennet / Bassant Emad
    "carla bennet", "bassant emad",
    // Anna Stone / Anisa
    "anna stone", "anisa", "anisa-anna stone-2382",
  ]),
};

// Merges duplicate phone accounts that belong to the same real person
const PHONE_ALIASES: Record<string, string> = {
  // Retention: Arabic OpenPhone name → English display name
  "abdulrhman isawi": "jacob stephenson",
  "zeiad fouad": "rick miller",
  "ahmed ayman": "levi miller",
  "ahmed ayman-levi miller": "levi miller",
  "saif aziz": "henry hart",
  "muhamed walid": "ryan henderson",
  "nouralden": "michael belfort",
  "karma farouk": "katherine adams",
  "tuqa hossam": "talia morgan",
  // Internal CS: Arabic OpenPhone name → English display name
  "hiba kamil": "ella monroe",
  "nour eldin atef": "chase miller",
  "fares": "leo carter",
  "nourhan ame": "nora adam",
  "youssef nady": "jacob xander",
  "bassant emad": "carla bennet",
  "anisa-anna stone-2382": "anna stone",
  "anisa": "anna stone",
  // NSF: Arabic OpenPhone name → English display name
  "ziad": "zach carter",
  "ahmed gamal": "austin white",
  "riham samir": "rika hart",
  "ayaat": "jenny morgan",
  "raneem": "renee solomon",
  "engy mahmoud": "ellie moser",
  "eman khamis": "estella cruz",
  "sama farouk": "katie miller",
  "omar badr": "kevin micheal",
  "yousef taher": "raymond reed",
  "jana": "kayla navarro",
  "jana-kayla navarro-2718": "kayla navarro",
  "seif eslam": "alex miller",
  "abdelrahman": "tyler grant",
  "omar": "otto klein",
};

// Maps normalized SHEET agent name → normalized PBX (VoSLogic) agent name
// Format: "QuoName-PBXAlias" sheet entries decode as QuoName=Quo key, PBXAlias=PBX key
// Roster-aware PBX key resolver. Tries the roster first (English or Arabic name,
// active or inactive — historical attribution included), then falls back to the
// legacy SHEET_TO_PBX alias table for any name the roster doesn't know.
function resolvePbxKey(rawAgent: string, roster: RosterIndex | null | undefined): string {
  const norm = normalizeAgent(rawAgent);
  if (roster) {
    const hit = roster.lookupByAnyName(rawAgent);
    if (hit) {
      const enNorm = hit.name.replace(/\s+/g, " ").trim().toLowerCase();
      return SHEET_TO_PBX[enNorm] ?? enNorm;
    }
  }
  return SHEET_TO_PBX[norm] ?? norm;
}

const SHEET_TO_PBX: Record<string, string> = {
  "ahmed ayman-levi miller": "levi miller",       // PBX: Levi Miller = Ahmed Ayman
  "youssef nady-jacob xander": "jacob xander",    // PBX: Jacob Xander = Youssef Nady
  "zeiad fouad-zack ford": "rick miller",          // PBX: Rick Miller = Zeiad Fouad
  "nour-michael belfort-2900": "michael belfort",  // PBX: Michael Belfort = Nour/Michael
  "mohammed ayman-max francis-2268": "max francis",
  "engy-ellie moser-2046": "ellie moser",
  "haythem-dean lewis-2089": "haythem",           // PBX: Haythem = Dean Lewis
  "dean lewis": "haythem",                         // lookup by display name → PBX key
  "muhamed-ryan henderson": "jacob ahmed",         // PBX: Jacob Ahmed = Ryan Henderson
  "abdlrhman-jacob stephenson": "abdulrhman isawi",
  "abdlrhman-adam maxwell": "abdulrhman isawi",
  "adam maxwell": "jacob stephenson",
  "youssef-john marcus": "john marcus",
  "youssef nasser": "john marcus",
};

// Maps normalized SHEET agent name → normalized PHONE (OpenPhone) agent name
const SHEET_TO_PHONE: Record<string, string> = {
  "abdlrhman-jacob stephenson": "abdulrhman isawi",
  "abdlrhman-adam maxwell": "abdulrhman isawi",
  "youssef-john marcus": "john marcus",
  "youssef nasser": "john marcus",
  "muhamed-ryan henderson": "ryan henderson",
  "zeiad fouad-zack ford": "zeiad fouad",
  "youssef nady-jacob xander": "youssef nady",
  "ahmed ayman-levi miller": "levi miller",
  "haythem-dean lewis-2089": "dean lewis",
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

const CA_TZ = "America/Los_Angeles";

/** Returns today's date as "YYYY-MM-DD" in PDT, regardless of device timezone. */
function todayPDT(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CA_TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

/** Returns current year/month(0-indexed)/date components in PDT. */
function nowPDTParts(): { year: number; month: number; date: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CA_TZ,
    year: "numeric", month: "numeric", day: "numeric",
  }).formatToParts(new Date());
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? 0);
  return { year: get("year"), month: get("month") - 1, date: get("day") };
}

/** Formats a timestamp string for display in PDT. */
function formatPDTTime(isoStr: string): string {
  return new Date(isoStr).toLocaleTimeString("en-US", {
    hour: "2-digit", minute: "2-digit", hour12: true, timeZone: CA_TZ,
  });
}

/** Formats a Date for display as a short date in PDT. */
function formatPDTDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: CA_TZ });
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
  todayFixed: number;
  monthFixed: number;
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

  // Build status counts — statuses pass through as-is for all modes
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
    const status = rawStatus;
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
  let todayFixed = 0;
  let monthFixed = 0;
  let todayCount = 0;
  let monthCount = 0;
  if (dateColumn) {
    // Use California time (America/Los_Angeles) — sheet dates are stored in CA time.
    // Do NOT use browser local time here: some browsers may be in non-LA timezones,
    // always derive "today" explicitly in LA time.
    const todayIso = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date()); // "YYYY-MM-DD"
    const thisMonthStr = todayIso.slice(0, 7); // "YYYY-MM"
    for (const r of status.rows) {
      const d = parseDate(r[dateColumn] ?? "");
      if (!d) continue;
      const rawStatus = normalizeStatus((r[statusColumn] ?? "").trim());
      const dateStr = toIsoDate(d); // date-only, same in all TZs
      const isToday = dateStr === todayIso;
      const inThisMonth = dateStr.startsWith(thisMonthStr);
      if (isToday) todayCount += 1;
      if (inThisMonth) monthCount += 1;
      if (isPureRetainedStatus(rawStatus)) {
        if (isToday) todayRetained += 1;
        if (inThisMonth) monthRetained += 1;
      }
      if (/cancel/i.test(rawStatus) && inThisMonth) monthCancelled += 1;
      if (/\bidp\b/i.test(rawStatus)) {
        if (isToday) todayFixed += 1;
        if (inThisMonth) monthFixed += 1;
      }
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
    todayFixed,
    monthFixed,
    todayCount,
    monthCount,
    totalRowCount: status.rows.length,
    filteredRowCount: filteredStatus.length,
    minDate,
    maxDate,
  };
}

// ---------- UI ----------

type TileTone = "violet" | "emerald" | "amber" | "sky" | "rose" | "slate" | "zinc";

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
  zinc: {
    bg: "bg-zinc-900/40",
    ring: "border-zinc-700/40",
    text: "text-zinc-400",
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
                        {d.date.toLocaleDateString("en-US", { timeZone: CA_TZ, month: "short", day: "numeric" })}
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
                      {week.weekStart.toLocaleDateString("en-US", { timeZone: CA_TZ, month: "short", day: "numeric" })} – {weekEnd.toLocaleDateString("en-US", { timeZone: CA_TZ, month: "short", day: "numeric" })}
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

function ByFilesView({ data, hideTeamRow, phoneData, sheetData, fromDate, toDate }: { data: Aggregated; hideTeamRow?: boolean; phoneData?: Map<string, PhoneAgentMetrics>; sheetData?: SheetData; fromDate?: Date | null; toDate?: Date | null }) {
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
    // Collect all agents: sheet agents first, then phone-only agents not in the sheet
    const sheetAgents = visible.map((a) => a.agent);
    const sheetKeys = new Set(sheetAgents.map((a) => sheetToPhoneKey(a)));
    const phoneOnlyAgents: string[] = [];
    if (phoneData) {
      for (const key of phoneData.keys()) {
        if (!sheetKeys.has(key)) {
          phoneOnlyAgents.push(key.replace(/\b\w/g, (c) => c.toUpperCase()));
        }
      }
    }
    const allAgentsForExport = [...sheetAgents, ...phoneOnlyAgents];

    const rows = allAgentsForExport.map((agent) => {
      const sheetEntry = visible.find((a) => a.agent === agent);
      const record: Record<string, string | number> = { Agent: agent };
      // Sheet columns
      for (const s of data.statuses) record[s] = sheetEntry?.byStatus.get(s) ?? 0;
      record["Total Files"] = sheetEntry?.total ?? 0;
      if (showRate) {
        const retained = sheetEntry ? sumRetained(sheetEntry.byStatus, data.retainedStatuses) : 0;
        record["Retention Rate"] = sheetEntry ? retentionRate(retained, sheetEntry.total) : "—";
      }
      // Phone call columns
      const ph = phoneData?.get(sheetToPhoneKey(agent));
      record["Calls"] = ph?.calls ?? 0;
      record["Outbound"] = ph?.outbound ?? 0;
      record["Inbound"] = ph?.inbound ?? 0;
      record["Answered"] = ph?.answered ?? 0;
      record["Missed"] = ph?.missed ?? 0;
      record["VM Brief"] = ph?.vmBrief ?? 0;
      record["Talk Time"] = ph ? formatDuration(ph.seconds) : "—";
      return record;
    });
    const csv = Papa.unparse(rows);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `files_${new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" })}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportRawRows() {
    if (!sheetData) return;
    const agentCol = findColumn(sheetData.headers, ["Agent", "Agent Name", "Rep"]);
    const statusCol = findColumn(sheetData.headers, ["Status", "Result", "Outcome", "Disposition"]);
    const dateCol = findColumn(sheetData.headers, ["Date", "Day", "Call Date"]);
    if (!agentCol || !statusCol) return;

    const rows = sheetData.rows.filter((r) => {
      const agent = (r[agentCol] ?? "").trim();
      if (!agent || /total$/i.test(agent)) return false;
      if (dateCol && (fromDate || toDate)) {
        const d = parseDate(r[dateCol] ?? "");
        if (!d) return false;
        if (fromDate && d < fromDate) return false;
        if (toDate && d > toDate) return false;
      }
      return true;
    });

    const exportRows = rows.map((r) => ({
      Agent: (r[agentCol] ?? "").trim(),
      Status: (r[statusCol] ?? "").trim(),
      Date: dateCol ? (r[dateCol] ?? "") : "",
      "File ID": (r["File ID"] ?? "").trim(),
    }));

    const csv = Papa.unparse(exportRows);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `submissions_${new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" })}.csv`;
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
          {sheetData && (
            <Button variant="outline" size="sm" onClick={exportRawRows} data-testid="button-export-rows">
              <Download className="h-3.5 w-3.5 mr-1.5" />
              Export Rows
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={exportCsv} data-testid="button-export-csv">
            <Download className="h-3.5 w-3.5 mr-1.5" />
            Export Summary
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
            {visible.length > 0 && !hideTeamRow && (
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

// PBX agent name (normalized) → canonical display name used in the phone/sheet tables.
// Only needed for agents whose PBX name differs from their Quo display name.
const PBX_TO_DISPLAY_NAME: Record<string, string> = {
  "jacob ahmed": "ryan henderson",
  "haythem":     "dean lewis",
};

interface LiveCallStatus {
  quo: Set<string>; // normalized names on Quo right now
  pbx: Set<string>; // normalized PBX agent names on PBX right now
  any: Set<string>; // union — PBX names mapped to their display-name equivalent
  quoParticipant: Map<string, string>; // normName → external number they're talking to
}

function formatParticipant(num: string): string {
  const d = num.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1"))
    return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  if (d.length === 10)
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return num;
}

function useLiveCalls(): LiveCallStatus {
  const quoQ = useQuery<{ active: string[]; agentCalls?: { agentName: string; participant: string | null }[] }>({
    queryKey: ["liveCalls"],
    queryFn: async () => {
      const r = await fetch("/api/quo/live");
      if (!r.ok) return { active: [] };
      return r.json() as Promise<{ active: string[]; agentCalls?: { agentName: string; participant: string | null }[] }>;
    },
    refetchInterval: 15 * 1000,
    staleTime: 10 * 1000,
    refetchOnWindowFocus: true,
  });

  const vosQ = useQuery<{ liveCalls: { agentName: string | null }[]; agentStatuses: { name: string; status: string }[] }>({
    queryKey: ["vosLive"],
    queryFn: async () => {
      const r = await fetch("/api/vos/live");
      if (!r.ok) return { liveCalls: [], agentStatuses: [] };
      return r.json();
    },
    refetchInterval: 15 * 1000,
    staleTime: 10 * 1000,
    refetchOnWindowFocus: true,
  });

  return useMemo(() => {
    const quo = new Set<string>();
    const pbx = new Set<string>();
    const any = new Set<string>();
    const quoParticipant = new Map<string, string>();

    for (const name of quoQ.data?.active ?? []) {
      const norm = normalizeAgent(name);
      quo.add(norm);
      any.add(norm);
      // Expand Arabic OpenPhone names to their English display-name equivalents
      // so the retention/CS/NSF panels can match the live dot correctly.
      const alias = PHONE_ALIASES[norm];
      if (alias) { quo.add(alias); any.add(alias); }
    }

    // Populate participant map from agentCalls (DB + poll sources)
    for (const { agentName, participant } of quoQ.data?.agentCalls ?? []) {
      if (!participant) continue;
      const norm = normalizeAgent(agentName);
      quoParticipant.set(norm, participant);
      const alias = PHONE_ALIASES[norm];
      if (alias) quoParticipant.set(alias, participant);
    }

    const addPbx = (name: string) => {
      const norm = name.trim().toLowerCase();
      pbx.add(norm);
      // Map to display name if PBX name differs from the table display name
      any.add(PBX_TO_DISPLAY_NAME[norm] ?? norm);
    };

    for (const c of vosQ.data?.liveCalls ?? []) if (c.agentName) addPbx(c.agentName);
    for (const a of vosQ.data?.agentStatuses ?? []) if (a.status === "on_call") addPbx(a.name);

    return { quo, pbx, any, quoParticipant };
  }, [quoQ.data, vosQ.data]);
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
    staleTime: 30_000,
    refetchInterval: 90_000,
    refetchOnWindowFocus: true,
  });
}

type DailyMissedDay = {
  date: string;
  retention: { quo: number; ghost: number; pbx: number };
  cs: { quo: number; ghost: number; pbx: number };
  nsf: { quo: number; ghost: number; pbx: number };
};

function useMissedDaily(mode: "times" | "numbers" = "times") {
  return useQuery<{ days: DailyMissedDay[] }>({
    queryKey: ["missedDaily", mode],
    queryFn: async () => {
      const r = await fetch(`/api/vos/missed-daily?mode=${mode}`);
      if (!r.ok) return { days: [] };
      return r.json();
    },
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true,
  });
}

type HourlyMissedHour = {
  hour: number;
  retention: { quo: number; ghost: number; pbx: number };
  cs: { quo: number; ghost: number; pbx: number };
  nsf: { quo: number; ghost: number; pbx: number };
};

function useMissedHourly(date: string, mode: "times" | "numbers" = "times") {
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const isToday = date === todayStr;
  return useQuery<{ hours: HourlyMissedHour[] }>({
    queryKey: ["missedHourly", date, mode],
    queryFn: async () => {
      const r = await fetch(`/api/vos/missed-hourly?date=${date}&mode=${mode}`);
      if (!r.ok) return { hours: [] };
      return r.json();
    },
    staleTime: isToday ? 60_000 : Infinity,
    refetchInterval: isToday ? 5 * 60_000 : false,
    refetchOnWindowFocus: isToday,
  });
}

function buildTeamPhoneData(teamMode: string, data: PhoneStatsResponse | null | undefined, roster?: RosterIndex): Map<string, PhoneAgentMetrics> {
  const rosterTeamAllow = roster && (teamMode === "retention" || teamMode === "nsf" || teamMode === "cs") ? roster.allowlist[teamMode as RosterTeam] : undefined;
  const allowlist = unionTeamSet(TEAM_ALLOWLIST[teamMode], rosterTeamAllow);
  const phoneAliases = roster?.phoneAliases ?? {};
  const map = new Map<string, PhoneAgentMetrics>();
  const agentStats = data?.teamStats?.[teamMode] ?? {};
  const lastCallMap = data?.agentLastCall?.[teamMode] ?? {};
  for (const [agentName, days] of Object.entries(agentStats)) {
    const rawKey = normalizeAgent(agentName);
    if (PHONE_BLOCKLIST.has(rawKey)) continue;
    const key = PHONE_ALIASES[rawKey] ?? phoneAliases[rawKey] ?? rawKey;
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

function ByCallStatsView({ agentList, phoneData, directKeys, pbxData, extraMissed, agentDept, hideTeamRow }: { agentList: string[]; phoneData: Map<string, PhoneAgentMetrics>; directKeys?: boolean; pbxData?: PbxCalls; extraMissed?: number; agentDept?: Map<string, "Retention" | "CS">; hideTeamRow?: boolean }) {
  const liveAgents = useLiveCalls();

  // Share the ["vosLive"] query key so React Query deduplicates the request.
  const pbxLiveQ = useQuery<{ liveCalls: VosLiveCall[]; agentStatuses: VosAgentStatus[] }>({
    queryKey: ["vosLive"],
    queryFn: async () => {
      const r = await fetch("/api/vos/live");
      if (!r.ok) return { liveCalls: [], agentStatuses: [] };
      return r.json();
    },
    staleTime: 10_000,
    refetchInterval: 15_000,
  });

  // normalizedPbxName → live call detail (for direction + duration in pills)
  const pbxLiveByName = useMemo(() => {
    const m = new Map<string, VosLiveCall>();
    for (const c of pbxLiveQ.data?.liveCalls ?? []) {
      if (!c.agentName) continue;
      const norm = c.agentName.trim().toLowerCase();
      m.set(norm, c);
      const displayNorm = PBX_TO_DISPLAY_NAME[norm] ?? norm;
      if (displayNorm !== norm) m.set(displayNorm, c);
    }
    return m;
  }, [pbxLiveQ.data]);

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

  const liveInView = agentList.filter((a) => liveAgents.any.has(normalizeAgent(a)));

  return (
    <div className="space-y-4">
      {liveInView.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Live calls right now</p>
          <div className="flex flex-wrap gap-2">
            {liveInView.map((agent) => {
              const norm = normalizeAgent(agent);
              const pbxCall = pbxLiveByName.get(norm);
              return (
                <div key={agent} className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-xs">
                  <span className="relative flex h-2 w-2 shrink-0">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                  </span>
                  <span className="text-emerald-300 font-medium">{agent}</span>
                  <ShiftDot agentName={agent} />
                  {pbxCall && (
                    <>
                      <span className="text-zinc-500">·</span>
                      <span className="text-zinc-400">{pbxCall.direction === "outbound" ? "↑" : "↓"} {formatDuration(pbxCall.duration)}</span>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
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
                <Th id="__unique__" label="CX Reached" tone="text-sky-400" tip="Unique phone numbers the agent spoke with (inbound or outbound). Each number counted once regardless of how many times they interacted." />
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
                const onQuo = liveAgents.quo.has(phoneKey);
                const onPbx = liveAgents.any.has(phoneKey) && !onQuo;
                const onBoth = onQuo && liveAgents.pbx.has(normalizeAgent(agent));
                const isLive = onQuo || onPbx || onBoth;
                const dept = agentDept?.get(normalizeAgent(agent));
                return (
                  <TableRow key={agent} className="hover-elevate">
                    <TableCell className="font-medium whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        {isLive && (
                          onBoth ? (
                            <span className="relative flex h-2.5 w-2.5 shrink-0" title="On a live call — both Quo & PBX">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-violet-400 opacity-75" />
                              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-violet-500" />
                            </span>
                          ) : onPbx ? (
                            <span className="relative flex h-2.5 w-2.5 shrink-0" title="On a live call — PBX">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-blue-500" />
                            </span>
                          ) : (
                            <span className="relative flex h-2.5 w-2.5 shrink-0" title="On a live call — Quo">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
                            </span>
                          )
                        )}
                        {agent}
                        <ShiftDot agentName={agent} />
                        {dept && (
                          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold leading-none ${dept === "Retention" ? "bg-violet-500/20 text-violet-300 border border-violet-500/30" : "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"}`}>
                            {dept}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {isLive ? (() => {
                        const participant = onQuo ? liveAgents.quoParticipant.get(phoneKey) : undefined;
                        const label = `On call ${onBoth ? "(Quo + PBX)" : onPbx ? "(PBX)" : "(Quo)"}`;
                        const cls = `font-medium text-xs ${onBoth ? "text-violet-400" : onPbx ? "text-blue-400" : "text-emerald-400"}`;
                        return participant ? (
                          <Tooltip delayDuration={120}>
                            <TooltipTrigger asChild>
                              <span className={`${cls} cursor-help underline decoration-dotted underline-offset-2`}>{label}</span>
                            </TooltipTrigger>
                            <TooltipContent side="left" className="font-mono text-xs">
                              {formatParticipant(participant)}
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <span className={cls}>{label}</span>
                        );
                      })() : (
                        <TimeSince isoStr={lastCall ?? undefined} />
                      )}
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
            {visible.length > 0 && !hideTeamRow && (
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
            const today = todayPDT();
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
            const { year, month } = nowPDTParts();
            const start = new Date(year, month, 1);
            const end = new Date(year, month + 1, 0);
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
          Sheet covers {minDate.toLocaleDateString("en-US", { timeZone: CA_TZ, month: "short", day: "numeric", year: "numeric" })} – {maxDate.toLocaleDateString("en-US", { timeZone: CA_TZ, month: "short", day: "numeric", year: "numeric" })}
        </span>
      )}
    </div>
  );
}

type Preset = { label: string; from: string; to: string };

function getPresets(): Preset[] {
  const { year, month, date } = nowPDTParts();
  const today = todayPDT();
  const yesterday = toIsoDate(new Date(year, month, date - 1));
  const firstOfMonth = toIsoDate(new Date(year, month, 1));
  const lastOfMonth = toIsoDate(new Date(year, month + 1, 0));
  const firstOfLastMonth = toIsoDate(new Date(year, month - 1, 1));
  const lastOfLastMonth = toIsoDate(new Date(year, month, 0));
  return [
    { label: "Today", from: today, to: today },
    { label: "Yesterday", from: yesterday, to: yesterday },
    { label: "This Month", from: firstOfMonth, to: lastOfMonth },
    { label: "Last Month", from: firstOfLastMonth, to: lastOfLastMonth },
    { label: "All time", from: "2024-01-01", to: today },
  ];
}

function PresetFilter({ from, to, setFrom, setTo }: { from: string; to: string; setFrom: (s: string) => void; setTo: (s: string) => void }) {
  const presets = getPresets();
  const active = presets.find((p) => p.from === from && p.to === to)?.label;
  const todayIso = todayPDT();
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
  statusQueryFn?: (roster: RosterIndex, opts?: { includeInactive?: boolean }) => Promise<SheetData>;
}) {
  const { user: panelUser } = useUser();
  const isRestricted = !!(panelUser.allowedAgents?.length);
  const pbxData = useVosCalls();
  const ringGroupMissed = useVosRingGroupMissed();
  // Retention ring group = 2, Back-end (NSF) ring group = 3 in VoSLogic
  const pbxMissed = mode === "retention" ? (ringGroupMissed.get(2) ?? 0) : mode === "nsf" ? (ringGroupMissed.get(3) ?? 0) : 0;
  const roster = useRoster();

  const todayIso = todayPDT();
  const thisMonthStart = todayIso.slice(0, 7) + "-01";
  const [from, setFrom] = useState(todayIso);
  const [to, setTo] = useState(todayIso);
  // Past-date view: when the selected range ends before today, include inactive
  // agents so historical attribution stays intact even after deactivation.
  const includeInactive = to < todayIso;

  const statusQ = useQuery({
    queryKey: ["status", sheetKey, roster.version, includeInactive],
    queryFn: statusQueryFn ? () => statusQueryFn(roster, { includeInactive }) : (() => fetchHeaderCsv(urls.status)),
    staleTime: 1000 * 10,
    refetchOnWindowFocus: true,
    refetchInterval: 15 * 1000,
  });
  const isLoading = statusQ.isLoading;
  const isFetching = statusQ.isFetching;
  const error = statusQ.error;

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
    const allowlist = unionTeamSet(TEAM_ALLOWLIST[mode], roster.allowlist[mode as RosterTeam] ?? new Set());
    const map = new Map<string, PhoneAgentMetrics>();
    const agentStats = phoneQ.data?.teamStats?.[mode] ?? {};
    const lastCallMap = phoneQ.data?.agentLastCall?.[mode] ?? {};
    for (const [agentName, days] of Object.entries(agentStats)) {
      const rawKey = normalizeAgent(agentName);
      if (PHONE_BLOCKLIST.has(rawKey)) continue;
      const aliased = PHONE_ALIASES[rawKey] ?? roster.phoneAliases[rawKey] ?? rawKey;
      const key = aliased;
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
      const pbxKey = resolvePbxKey(agent, roster);
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
            {!isRestricted && <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatTile label="Agents" value={callAgentList.length} icon={<Users className="h-3.5 w-3.5" />} tone="violet" />
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
            </div>}

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
                <ByCallStatsView agentList={callAgentList} phoneData={phoneData} pbxData={pbxData} extraMissed={pbxMissed} hideTeamRow={isRestricted} />
              </TabsContent>
              {aggregated && !("error" in aggregated) && (
                <>
                  <TabsContent value="files">
                    {aggregated && !("error" in aggregated) && (
                      <ByFilesView data={aggregated} hideTeamRow={isRestricted} phoneData={phoneData} sheetData={statusQ.data} fromDate={fromDate} toDate={toDate} />
                    )}
                  </TabsContent>
                  <TabsContent value="day">
                    {aggregated && !("error" in aggregated) && (
                      <ByDayView data={aggregated} />
                    )}
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

const CS_AGENTS = ["Ella Monroe", "Chase Miller", "Leo Carter", "Nora Adam", "Anna Stone", "Jacob Xander", "Carla Bennet"];
const RETENTION_AGENTS = ["Levi Miller", "Henry Hart", "Rick Miller", "Michael Belfort", "Ryan Henderson", "Katherine Adams", "Talia Morgan", "Jacob Stephenson", "John Marcus", "Dean Lewis"];

function CSPanel() {
  const pbxData = useVosCalls();
  const ringGroupMissed = useVosRingGroupMissed();
  // CS ring group ID = 4 in VoSLogic
  const pbxMissed = ringGroupMissed.get(4) ?? 0;
  const todayIso = todayPDT();
  const thisMonthStart = todayIso.slice(0, 7) + "-01";
  const [from, setFrom] = useState(todayIso);
  const [to, setTo] = useState(todayIso);
  const roster = useRoster();

  const fromDate = from ? parseDate(from) : null;
  const toDate = to ? parseDate(to) : null;
  if (toDate) toDate.setHours(23, 59, 59, 999);

  // Past-date view: when the selected range ends before today, include inactive
  // agents so historical attribution stays intact even after deactivation.
  const includeInactive = to < todayIso;
  const statusQ = useQuery({
    queryKey: ["status", "cs", roster.version, includeInactive],
    queryFn: () => fetchCSCombinedSheet(roster, { includeInactive }),
    staleTime: 1000 * 10,
    refetchOnWindowFocus: true,
    refetchInterval: 15 * 1000,
  });

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

  const aggregated = useMemo(() => {
    if (!statusQ.data) return null;
    return aggregate(statusQ.data, "nsf", fromDate, toDate);
  }, [statusQ.data, from, to]);

  const phoneData = useMemo<Map<string, PhoneAgentMetrics>>(() => {
    const allowlist = unionTeamSet(TEAM_ALLOWLIST["cs"], roster.allowlist.cs);
    const map = new Map<string, PhoneAgentMetrics>();
    const agentStats = phoneQ.data?.teamStats?.["cs"] ?? {};
    const lastCallMap = phoneQ.data?.agentLastCall?.["cs"] ?? {};
    for (const [agentName, days] of Object.entries(agentStats)) {
      const rawKey = normalizeAgent(agentName);
      if (PHONE_BLOCKLIST.has(rawKey)) continue;
      const key = PHONE_ALIASES[rawKey] ?? roster.phoneAliases[rawKey] ?? rawKey;
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
  }, [phoneQ.data]);

  const { user: csUser } = useUser();
  const allAgents = useMemo(() => {
    const result: string[] = [];
    const addedKeys = new Set<string>();
    for (const a of CS_AGENTS) {
      const k = normalizeAgent(a);
      if (!addedKeys.has(k)) { result.push(a); addedKeys.add(k); }
    }
    for (const k of phoneData.keys()) {
      if (!addedKeys.has(k)) { result.push(k.replace(/\b\w/g, (c) => c.toUpperCase())); addedKeys.add(k); }
    }
    if (pbxData) {
      for (const [pbxKey, pbxAgent] of pbxData.entries()) {
        if (pbxAgent.groups.includes("Customer Support") && !addedKeys.has(pbxKey)) {
          result.push(pbxKey.replace(/\b\w/g, (c) => c.toUpperCase()));
          addedKeys.add(pbxKey);
        }
      }
    }
    const aa = csUser.allowedAgents;
    if (!aa || aa.length === 0) return result;
    return result.filter((a) => aa.some((x) => normalizeAgent(x) === normalizeAgent(a)));
  }, [phoneData, pbxData, csUser.allowedAgents]);

  const totals = useMemo(() => {
    let calls = 0, seconds = 0, answered = 0, missed = 0, uniqueContacts = 0;
    for (const v of phoneData.values()) { calls += v.calls; seconds += v.seconds; answered += v.answered; missed += v.missed; uniqueContacts += v.uniqueContacts; }
    return { calls, seconds, answered, missed, uniqueContacts };
  }, [phoneData]);

  const pbxTotals = useMemo(() => {
    if (!pbxData) return { calls: 0, answered: 0, seconds: 0 };
    let calls = 0, answered = 0, seconds = 0;
    for (const agent of allAgents) {
      const pbxKey = resolvePbxKey(agent, roster);
      const px = pbxData.get(pbxKey);
      calls += px?.calls ?? 0; answered += px?.answered ?? 0; seconds += px?.durationSeconds ?? 0;
    }
    return { calls, answered, seconds };
  }, [pbxData, allAgents]);

  function refresh() { statusQ.refetch(); phoneQ.refetch(); }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0 gap-4">
        <div>
          <CardTitle className="text-xl">Internal CS</CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Call activity &amp; files · live from OpenPhone + PBX
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={phoneQ.isFetching || statusQ.isFetching}>
          <RefreshCw className={`h-4 w-4 mr-2 ${(phoneQ.isFetching || statusQ.isFetching) ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-6">
        {(phoneQ.isLoading || statusQ.isLoading) && <TableSkeleton />}

        <PresetFilter from={from} to={to} setFrom={setFrom} setTo={setTo} />

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatTile label="Agents" value={allAgents.length} icon={<Users className="h-3.5 w-3.5" />} tone="violet" />
          <StatTile label="Total calls" value={(totals.calls + pbxTotals.calls).toLocaleString()} icon={<Phone className="h-3.5 w-3.5" />} tone="sky" />
          <StatTile label="Answered" value={(totals.answered + pbxTotals.answered).toLocaleString()} tone="emerald" />
          <StatTile label="Missed" value={(totals.missed + pbxMissed).toLocaleString()} tone="rose" />
          <StatTile label="Time on calls" value={formatHours(totals.seconds + pbxTotals.seconds)} icon={<Clock className="h-3.5 w-3.5" />} tone="amber" />
          <StatTile label="Response rate" value={responseRate(totals.answered + pbxTotals.answered, totals.calls + pbxTotals.calls)} tone="amber" />
          {aggregated && !("error" in aggregated) && (
            <>
              <StatTile label="Today's files" value={aggregated.todayCount.toLocaleString()} tone="emerald" />
              <StatTile label="This month's files" value={aggregated.monthCount.toLocaleString()} tone="emerald" />
              <StatTile label="Total files" value={aggregated.totals.grand.toLocaleString()} tone="violet" />
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
            <ByCallStatsView agentList={allAgents} phoneData={phoneData} pbxData={pbxData} extraMissed={pbxMissed} />
          </TabsContent>
          {aggregated && !("error" in aggregated) && (
            <>
              <TabsContent value="files">
                <ByFilesView data={aggregated} phoneData={phoneData} sheetData={statusQ.data} fromDate={fromDate} toDate={toDate} />
              </TabsContent>
              <TabsContent value="day">
                <ByDayView data={aggregated} />
              </TabsContent>
            </>
          )}
        </Tabs>
      </CardContent>
    </Card>
  );
}

function RetentionPanel() {
  const { user: retUser } = useUser();
  const pbxData = useVosCalls();
  const ringGroupMissed = useVosRingGroupMissed();
  // Retention ring group ID = 2 in VoSLogic
  const pbxMissed = ringGroupMissed.get(2) ?? 0;

  const todayIso = todayPDT();
  const thisMonthStart = todayIso.slice(0, 7) + "-01";
  const [from, setFrom] = useState(todayIso);
  const [to, setTo] = useState(todayIso);
  const roster = useRoster();

  const fromDate = from ? parseDate(from) : null;
  const toDate = to ? parseDate(to) : null;
  if (toDate) toDate.setHours(23, 59, 59, 999);

  // Past-date view: when the selected range ends before today, include inactive
  // agents so historical attribution stays intact even after deactivation.
  const includeInactive = to < todayIso;
  const statusQ = useQuery({
    queryKey: ["status", "retention", roster.version, includeInactive],
    queryFn: () => fetchRetentionCombinedSheet(roster, { includeInactive }),
    staleTime: 1000 * 10,
    refetchOnWindowFocus: true,
    refetchInterval: 15 * 1000,
  });

  const phoneQ = useQuery<PhoneStatsResponse | null>({
    queryKey: ["phoneStats", "retention", from, to],
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

  const phoneData = useMemo(() => buildTeamPhoneData("retention", phoneQ.data, roster), [phoneQ.data, roster]);

  const agentList = useMemo(() => {
    const result: string[] = [];
    const addedKeys = new Set<string>();
    for (const a of RETENTION_AGENTS) {
      const k = normalizeAgent(a);
      if (!addedKeys.has(k)) { result.push(a); addedKeys.add(k); }
    }
    for (const extra of TEAM_PHONE_EXTRAS["retention"] ?? []) {
      const k = normalizeAgent(extra);
      if (!addedKeys.has(k)) { result.push(extra); addedKeys.add(k); }
    }
    for (const k of phoneData.keys()) {
      if (!addedKeys.has(k)) { result.push(k.replace(/\b\w/g, (c) => c.toUpperCase())); addedKeys.add(k); }
    }
    const aa = retUser.allowedAgents;
    if (!aa || aa.length === 0) return result;
    return result.filter((a) => aa.some((x) => normalizeAgent(x) === normalizeAgent(a)));
  }, [phoneData, retUser.allowedAgents]);

  const totals = useMemo(() => {
    let calls = 0, seconds = 0, answered = 0, missed = 0;
    for (const v of phoneData.values()) { calls += v.calls; seconds += v.seconds; answered += v.answered; missed += v.missed; }
    return { calls, seconds, answered, missed };
  }, [phoneData]);

  const pbxTotals = useMemo(() => {
    if (!pbxData) return { calls: 0, answered: 0, seconds: 0 };
    let calls = 0, answered = 0, seconds = 0;
    for (const agent of agentList) {
      const pbxKey = resolvePbxKey(agent, roster);
      const px = pbxData.get(pbxKey);
      calls += px?.calls ?? 0; answered += px?.answered ?? 0; seconds += px?.durationSeconds ?? 0;
    }
    return { calls, answered, seconds };
  }, [pbxData, agentList]);

  function refresh() { statusQ.refetch(); phoneQ.refetch(); }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0 gap-4">
        <div>
          <CardTitle className="text-xl">Retention</CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Calls &amp; retention files · live from OpenPhone + PBX
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

        {!retUser.allowedAgents?.length && (
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
                <StatTile label="Today's fixed" value={aggregated.todayFixed.toLocaleString()} tone="sky" />
                <StatTile label="This month's fixed" value={aggregated.monthFixed.toLocaleString()} tone="sky" />
                <StatTile label="Retention rate" value={retentionRate(aggregated.totals.retained, aggregated.totals.grand)} tone="violet" />
              </>
            )}
          </div>
        )}

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
            <ByCallStatsView agentList={agentList} phoneData={phoneData} pbxData={pbxData} extraMissed={pbxMissed} hideTeamRow={!!(retUser.allowedAgents?.length)} />
          </TabsContent>
          {aggregated && !("error" in aggregated) && (
            <>
              <TabsContent value="files">
                <ByFilesView data={aggregated} hideTeamRow={!!(retUser.allowedAgents?.length)} phoneData={phoneData} sheetData={statusQ.data} fromDate={fromDate} toDate={toDate} />
              </TabsContent>
              <TabsContent value="day">
                <ByDayView data={aggregated} />
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
                    {new Date(c.createdAt).toLocaleString("en-US", { timeZone: CA_TZ, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: true })}
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

  // On mount, refresh user data from DB so permission/teamAccess changes
  // take effect on the next page load without requiring re-login.
  useEffect(() => {
    const token = localStorage.getItem("tracker_token");
    if (!token) return;
    fetch("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => {
        if (!r.ok) { logout(); return; }
        return r.json() as Promise<{ token: string; user: AuthUser }>;
      })
      .then((data) => {
        if (!data) return;
        localStorage.setItem("tracker_token", data.token);
        localStorage.setItem("tracker_user", JSON.stringify(data.user));
        setAuth(data);
      })
      .catch(() => { /* network error — keep existing auth */ });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    const canSeeTab = (tab: string) => {
      if (auth.user.role === "admin") return true;
      const at = auth.user.allowedTabs;
      if (at && at.length > 0) return at.includes(tab);
      // Fallback: teamAccess-based visibility
      const ta = auth.user.teamAccess ?? null;
      const allTeams = ta === null;
      if (tab === "violations" || tab === "callback-review") return allTeams;
      if (tab === "missed-no-cb") return true;
      if (tab === "retention") return allTeams || ta === "retention";
      if (tab === "cs") return allTeams || ta === "cs";
      if (tab === "nsf") return allTeams || ta === "nsf";
      return false;
    };
    return (
      <UserContext.Provider value={{ user: auth.user, token: auth.token, logout, can, canSeeTab }}>
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

interface PortalUser { id: number; username: string; role: string; permissions: Permission[]; teamAccess?: TeamAccess | null; allowedTabs?: string[] | null; allowedAgents?: string[] | null; active: boolean; }

const DEFAULT_PERMS: Record<string, Permission[]> = {
  admin: ["view_metrics", "view_attendance", "edit_attendance", "manage_members", "view_missed_tables"],
  edit:  ["view_metrics", "view_attendance", "edit_attendance", "manage_members", "view_missed_tables"],
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

function TabCheckboxes({ tabs, onChange }: { tabs: string[]; onChange: (t: string[]) => void }) {
  return (
    <div className="grid grid-cols-2 gap-1.5 mt-1">
      {ALL_TABS.map(({ value, label }) => {
        const checked = tabs.includes(value);
        return (
          <label key={value} className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 cursor-pointer transition-colors ${checked ? "bg-sky-500/10 border border-sky-500/20" : "bg-zinc-900/60 border border-white/5 hover:border-white/10"}`}
            onClick={() => onChange(checked ? tabs.filter((t) => t !== value) : [...tabs, value])}>
            <div className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${checked ? "bg-sky-500 border-sky-500" : "border-zinc-600"}`}>
              {checked && <span className="text-white text-[9px] font-bold leading-none">✓</span>}
            </div>
            <span className={`text-xs font-medium ${checked ? "text-sky-200" : "text-zinc-400"}`}>{label}</span>
          </label>
        );
      })}
    </div>
  );
}

type TeamAgent = { id: number; name: string; team: string; active: boolean; arabicName?: string | null; shift?: string | null };

function AgentRosterPanel({ onClose }: { onClose: () => void }) {
  const { token } = useUser();
  const qc = useQueryClient();
  const [agents, setAgents] = useState<TeamAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [newArabic, setNewArabic] = useState("");
  const [newShift, setNewShift] = useState("");
  const [newTeam, setNewTeam] = useState<"retention" | "nsf" | "cs">("retention");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);
  // Local drafts for inline-edited arabic/shift cells so typing is smooth.
  const [drafts, setDrafts] = useState<Record<number, { name?: string; arabicName?: string; shift?: string }>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/team-agents", { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) {
        setAgents(await r.json() as TeamAgent[]);
        setDrafts({});
      }
    } finally { setLoading(false); }
    // Bust the dashboard-wide roster query so all panels rebuild aliases/allowlists.
    void qc.invalidateQueries({ queryKey: ["roster"] });
  }, [token, qc]);

  useEffect(() => { void load(); }, [load]);

  async function addAgent() {
    if (!newName.trim()) return;
    setSaving(true); setError("");
    const r = await fetch("/api/team-agents", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        name: newName.trim(),
        team: newTeam,
        arabicName: newArabic.trim() || null,
        shift: newShift.trim() || null,
      }),
    });
    if (r.ok) {
      setNewName(""); setNewArabic(""); setNewShift("");
      await load();
    } else {
      const d = await r.json() as { error?: string };
      setError(d.error ?? "Failed to add");
    }
    setSaving(false);
  }

  async function patchAgent(id: number, body: Record<string, unknown>) {
    setBusyId(id);
    await fetch(`/api/team-agents/${id}`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify(body),
    });
    setBusyId(null);
    await load();
  }

  async function removeAgent(id: number) {
    await fetch(`/api/team-agents/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    await load();
  }

  function getDraft(a: TeamAgent, field: "name" | "arabicName" | "shift"): string {
    const d = drafts[a.id];
    if (d && field in d) return d[field] ?? "";
    return (a[field] ?? "") as string;
  }
  function setDraft(id: number, field: "name" | "arabicName" | "shift", v: string) {
    setDrafts(prev => ({ ...prev, [id]: { ...prev[id], [field]: v } }));
  }
  async function commitDraft(a: TeamAgent, field: "name" | "arabicName" | "shift") {
    const next = (drafts[a.id]?.[field] ?? "").trim();
    const current = (a[field] ?? "").toString().trim();
    if (next === current) return;
    // English name is required; ignore empty commits and reset draft.
    if (field === "name" && !next) {
      setDrafts(prev => { const cp = { ...prev }; if (cp[a.id]) { const inner = { ...cp[a.id] }; delete inner.name; cp[a.id] = inner; } return cp; });
      return;
    }
    await patchAgent(a.id, { [field]: field === "name" ? next : (next || null) });
  }

  const TEAMS: { key: "retention" | "nsf" | "cs"; label: string }[] = [
    { key: "retention", label: "Retention" },
    { key: "nsf",       label: "NSF" },
    { key: "cs",        label: "CS" },
  ];
  const teamBadge: Record<string, string> = {
    retention: "bg-violet-500/20 text-violet-300 border-violet-500/30",
    nsf: "bg-sky-500/20 text-sky-300 border-sky-500/30",
    cs: "bg-fuchsia-500/20 text-fuchsia-300 border-fuchsia-500/30",
  };

  // Sort: team, then English name.
  const sortedAgents = [...agents].sort((x, y) => {
    if (x.team !== y.team) return x.team.localeCompare(y.team);
    return x.name.localeCompare(y.name);
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="relative w-full max-w-5xl mx-4 rounded-2xl border border-white/10 bg-zinc-950 shadow-2xl">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-white/10">
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-violet-400" />
            <h2 className="text-lg font-semibold text-white">Agent Roster</h2>
            <span className="text-xs text-zinc-500">· canonical identity registry</span>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-white transition-colors"><X className="h-5 w-5" /></button>
        </div>

        <div className="p-6 space-y-5 max-h-[82vh] overflow-y-auto">
          {/* Add agent form */}
          <div className="space-y-3">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Add Agent</p>
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_1fr_140px_auto] gap-2">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void addAgent()}
                placeholder="English name"
                className="rounded-lg border border-white/10 bg-zinc-800/80 px-3 py-2 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500/50"
              />
              <input
                value={newArabic}
                onChange={(e) => setNewArabic(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void addAgent()}
                placeholder="Arabic name (optional)"
                dir="rtl"
                className="rounded-lg border border-white/10 bg-zinc-800/80 px-3 py-2 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500/50"
              />
              <input
                value={newShift}
                onChange={(e) => setNewShift(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void addAgent()}
                placeholder="Shift (e.g. 9–5, Night)"
                className="rounded-lg border border-white/10 bg-zinc-800/80 px-3 py-2 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500/50"
              />
              <select
                value={newTeam}
                onChange={(e) => setNewTeam(e.target.value as "retention" | "nsf" | "cs")}
                className="rounded-lg border border-white/10 bg-zinc-800/80 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-violet-500/50"
              >
                {TEAMS.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
              <button
                onClick={() => void addAgent()}
                disabled={saving || !newName.trim()}
                className="flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-medium transition-colors"
              >
                <Plus className="h-4 w-4" />Add
              </button>
            </div>
            {error && <p className="text-xs text-rose-400">{error}</p>}
          </div>

          {/* Roster table */}
          {loading ? (
            <div className="text-center py-8 text-zinc-500 text-sm">Loading agents…</div>
          ) : agents.length === 0 ? (
            <div className="text-center py-8 text-zinc-500 text-sm">No agents added yet. Use the form above to add team members.</div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-white/8">
              <table className="w-full text-sm">
                <thead className="bg-zinc-900/70 text-zinc-400 text-xs uppercase tracking-wider">
                  <tr>
                    <th className="text-left px-3 py-2 font-semibold">Department</th>
                    <th className="text-left px-3 py-2 font-semibold">English Name</th>
                    <th className="text-left px-3 py-2 font-semibold">Arabic Name</th>
                    <th className="text-left px-3 py-2 font-semibold">Shift</th>
                    <th className="text-center px-3 py-2 font-semibold w-24">Active</th>
                    <th className="text-right px-3 py-2 font-semibold w-20">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedAgents.map(a => (
                    <tr key={a.id} className={`border-t border-white/5 ${a.active ? "" : "opacity-50"}`}>
                      <td className="px-3 py-2">
                        <select
                          value={a.team}
                          disabled={busyId === a.id}
                          onChange={(e) => void patchAgent(a.id, { team: e.target.value })}
                          className={`text-xs rounded-full border px-2 py-1 cursor-pointer focus:outline-none ${teamBadge[a.team] ?? "bg-zinc-700 text-zinc-300 border-zinc-600"}`}
                        >
                          {TEAMS.map(t => <option key={t.key} value={t.key} className="bg-zinc-900 text-white">{t.label}</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <input
                          value={getDraft(a, "name")}
                          onChange={(e) => setDraft(a.id, "name", e.target.value)}
                          onBlur={() => void commitDraft(a, "name")}
                          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                          className={`w-full bg-transparent px-2 py-1 rounded border border-transparent hover:border-white/10 focus:border-violet-500/50 focus:outline-none ${a.active ? "text-zinc-100" : "text-zinc-500 line-through"}`}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          value={getDraft(a, "arabicName")}
                          onChange={(e) => setDraft(a.id, "arabicName", e.target.value)}
                          onBlur={() => void commitDraft(a, "arabicName")}
                          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                          dir="rtl"
                          placeholder="—"
                          className="w-full bg-transparent text-zinc-200 placeholder:text-zinc-600 px-2 py-1 rounded border border-transparent hover:border-white/10 focus:border-violet-500/50 focus:outline-none"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          value={getDraft(a, "shift")}
                          onChange={(e) => setDraft(a.id, "shift", e.target.value)}
                          onBlur={() => void commitDraft(a, "shift")}
                          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                          placeholder="—"
                          className="w-full bg-transparent text-zinc-200 placeholder:text-zinc-600 px-2 py-1 rounded border border-transparent hover:border-white/10 focus:border-violet-500/50 focus:outline-none"
                        />
                      </td>
                      <td className="px-3 py-2 text-center">
                        <button
                          onClick={() => void patchAgent(a.id, { active: !a.active })}
                          title={a.active ? "Deactivate" : "Activate"}
                          className={`inline-flex items-center justify-center rounded-md p-1.5 transition-colors ${a.active ? "text-emerald-400 hover:bg-emerald-500/10" : "text-zinc-500 hover:bg-amber-500/10 hover:text-amber-400"}`}
                        >
                          {a.active ? <UserCheck className="h-4 w-4" /> : <UserX className="h-4 w-4" />}
                        </button>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          onClick={() => { if (confirm(`Remove ${a.name}?`)) void removeAgent(a.id); }}
                          title="Remove agent"
                          className="inline-flex items-center justify-center rounded-md p-1.5 text-zinc-500 hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="text-xs text-zinc-600 leading-relaxed">
            This roster is the canonical identity registry. Agents added here are automatically matched in the Google Sheets data <em>and</em> in OpenPhone/PBX call data — no code change required. Arabic names are matched as aliases for the same agent.
          </p>
        </div>
      </div>
    </div>
  );
}

function UserManagementPanel({ onClose }: { onClose: () => void }) {
  const { token } = useUser();
  const [users, setUsers] = useState<PortalUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<"admin" | "edit" | "view">("view");
  const [newPerms, setNewPerms] = useState<Permission[]>(DEFAULT_PERMS["view"]);
  const [newTeamAccess, setNewTeamAccess] = useState<TeamAccess | "">("");
  const [newAllowedTabs, setNewAllowedTabs] = useState<string[]>([]);
  const [newAllowedAgents, setNewAllowedAgents] = useState("");
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editPw, setEditPw] = useState("");
  const [editRole, setEditRole] = useState<"admin" | "edit" | "view">("view");
  const [editPerms, setEditPerms] = useState<Permission[]>([]);
  const [editTeamAccess, setEditTeamAccess] = useState<TeamAccess | "">("");
  const [editAllowedTabs, setEditAllowedTabs] = useState<string[]>([]);
  const [editAllowedAgents, setEditAllowedAgents] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/users", { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setUsers(await r.json() as PortalUser[]);
    } finally { setLoading(false); }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  function parseAgentInput(raw: string): string[] | null {
    const arr = raw.split(",").map((s) => s.trim()).filter(Boolean);
    return arr.length > 0 ? arr : null;
  }

  async function addUser() {
    if (!newUsername.trim() || !newPassword.trim()) return;
    setSaving(true); setError("");
    const perms = newRole === "admin" ? DEFAULT_PERMS["admin"] : newPerms;
    const body = {
      username: newUsername.trim(),
      password: newPassword.trim(),
      role: newRole,
      permissions: perms,
      teamAccess: newTeamAccess || null,
      allowedTabs: newAllowedTabs.length > 0 ? newAllowedTabs : null,
      allowedAgents: parseAgentInput(newAllowedAgents),
    };
    const r = await fetch("/api/users", { method: "POST", headers: authHeaders(token), body: JSON.stringify(body) });
    if (r.ok) {
      setNewUsername(""); setNewPassword(""); setNewRole("view");
      setNewPerms(DEFAULT_PERMS["view"]); setNewTeamAccess("");
      setNewAllowedTabs([]); setNewAllowedAgents("");
      await load();
    } else { const d = await r.json() as { error?: string }; setError(d.error ?? "Failed to add user"); }
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
    setEditAllowedTabs(u.allowedTabs ?? []);
    setEditAllowedAgents((u.allowedAgents ?? []).join(", "));
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
                <option value="cs">Internal CS</option>
              </select>
            </div>
            {newRole !== "admin" && (
              <div className="space-y-3">
                <div>
                  <p className="text-[11px] font-medium text-zinc-400 mb-1.5">What this user can access:</p>
                  <PermCheckboxes perms={newPerms} onChange={setNewPerms} />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-[11px] font-medium text-zinc-400">Tab visibility <span className="text-zinc-600 font-normal">(leave all unchecked = follow team access rules)</span></p>
                    {newAllowedTabs.length > 0 && <button onClick={() => setNewAllowedTabs([])} className="text-[10px] text-zinc-500 hover:text-zinc-300 underline">Clear all</button>}
                  </div>
                  <TabCheckboxes tabs={newAllowedTabs} onChange={setNewAllowedTabs} />
                </div>
                <div>
                  <p className="text-[11px] font-medium text-zinc-400 mb-1">Agent allowlist <span className="text-zinc-600 font-normal">(blank = all agents)</span></p>
                  <Input placeholder="e.g. Levi Miller, Henry Hart, Ryan Henderson" value={newAllowedAgents} onChange={(e) => setNewAllowedAgents(e.target.value)} className="h-8 text-xs" />
                  <p className="text-[10px] text-zinc-600 mt-1">Comma-separated agent names. Only these agents' stats will be visible.</p>
                </div>
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
                        <option value="cs">Internal CS</option>
                      </select>
                    </div>
                    {editRole !== "admin" && (
                      <div className="space-y-3">
                        <div>
                          <p className="text-[11px] font-medium text-zinc-400 mb-1">Permissions:</p>
                          <PermCheckboxes perms={editPerms} onChange={setEditPerms} />
                        </div>
                        <div>
                          <div className="flex items-center justify-between mb-1">
                            <p className="text-[11px] font-medium text-zinc-400">Tab visibility <span className="text-zinc-600 font-normal">(unchecked all = follow team access)</span></p>
                            {editAllowedTabs.length > 0 && <button onClick={() => setEditAllowedTabs([])} className="text-[10px] text-zinc-500 hover:text-zinc-300 underline">Clear all</button>}
                          </div>
                          <TabCheckboxes tabs={editAllowedTabs} onChange={setEditAllowedTabs} />
                        </div>
                        <div>
                          <p className="text-[11px] font-medium text-zinc-400 mb-1">Agent allowlist <span className="text-zinc-600 font-normal">(blank = all agents)</span></p>
                          <Input placeholder="e.g. Levi Miller, Henry Hart" value={editAllowedAgents} onChange={(e) => setEditAllowedAgents(e.target.value)} className="h-7 text-xs" />
                        </div>
                      </div>
                    )}
                    {editRole === "admin" && <p className="text-[11px] text-zinc-500">Admins always have full access.</p>}
                    <div className="flex gap-2 justify-end">
                      <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditingId(null)}>Cancel</Button>
                      <Button size="sm" className="h-7 text-xs bg-violet-600 hover:bg-violet-700 text-white px-3" onClick={() => patchUser(u.id, {
                        role: editRole,
                        permissions: editRole === "admin" ? DEFAULT_PERMS["admin"] : editPerms,
                        teamAccess: editTeamAccess || null,
                        allowedTabs: editRole === "admin" ? null : (editAllowedTabs.length > 0 ? editAllowedTabs : null),
                        allowedAgents: editRole === "admin" ? null : parseAgentInput(editAllowedAgents),
                        ...(editPw ? { password: editPw } : {}),
                      })}>
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

function BlockedNumbersPanel({ onClose }: { onClose: () => void }) {
  const { token } = useUser();
  const [items, setItems] = useState<{ number: string; note: string | null; createdAt: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [newNumber, setNewNumber] = useState("");
  const [newNote, setNewNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/blocked-numbers", { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setItems((await r.json() as { data: { number: string; note: string | null; createdAt: string }[] }).data);
    } finally { setLoading(false); }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  async function addNumber() {
    const num = newNumber.trim();
    if (!num) return;
    setSaving(true); setError("");
    const r = await fetch("/api/blocked-numbers", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ number: num, note: newNote.trim() || null }),
    });
    if (r.ok) { setNewNumber(""); setNewNote(""); await load(); }
    else { const d = await r.json() as { error?: string }; setError(d.error ?? "Failed to add"); }
    setSaving(false);
  }

  async function removeNumber(num: string) {
    await fetch(`/api/blocked-numbers/${encodeURIComponent(num)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    await load();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="relative w-full max-w-md mx-4 rounded-2xl border border-white/10 bg-zinc-950 shadow-2xl">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-white/10">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-rose-400" />
            <h2 className="text-lg font-semibold text-white">Blocked Numbers</h2>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-white transition-colors"><X className="h-5 w-5" /></button>
        </div>
        <div className="p-6 space-y-5 max-h-[75vh] overflow-y-auto">
          <p className="text-xs text-zinc-500">Numbers added here are excluded from all missed-call lists and stats.</p>
          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Add Number</p>
            <div className="flex gap-2">
              <Input placeholder="+1XXXXXXXXXX" value={newNumber} onChange={(e) => setNewNumber(e.target.value)} className="h-8 text-sm flex-1" />
              <Input placeholder="Note (optional)" value={newNote} onChange={(e) => setNewNote(e.target.value)} className="h-8 text-sm flex-1" />
            </div>
            <Button size="sm" className="bg-rose-600 hover:bg-rose-700 text-white w-full" onClick={addNumber} disabled={saving || !newNumber.trim()}>
              <Plus className="h-3.5 w-3.5 mr-1" />Block Number
            </Button>
            {error && <p className="text-xs text-rose-400">{error}</p>}
          </div>
          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Blocked ({items.length})</p>
            {loading ? <Skeleton className="h-16 w-full" /> : items.length === 0 ? (
              <p className="text-xs text-zinc-600 py-3 text-center">No numbers blocked yet.</p>
            ) : items.map((item) => (
              <div key={item.number} className="flex items-center justify-between gap-2 rounded-lg border border-white/8 bg-zinc-900/60 px-3 py-2">
                <div>
                  <p className="text-sm font-mono text-white">{item.number}</p>
                  {item.note && <p className="text-xs text-zinc-500">{item.note}</p>}
                </div>
                <button onClick={() => removeNumber(item.number)} className="p-1 rounded text-zinc-600 hover:text-rose-400 transition-colors flex-shrink-0">
                  <X className="h-3.5 w-3.5" />
                </button>
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
const LINE_TEAM_LABELS: Record<string, string> = { retention: "Retention", nsf: "NSF", cs: "Internal CS" };

function QuoLinesPanel() {
  const todayIso = todayPDT();
  const thisMonthStart = todayIso.slice(0, 7) + "-01";
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

// ─── ReadyMode Panel ──────────────────────────────────────────────────────────

interface RmAgentStat {
  agentName: string;
  dialed: number;
  connected: number;
  talkTimeSecs: number;
  avgTalkSecs: number;
  connectRate: number;
}

interface RmStatsResponse {
  agents: RmAgentStat[];
  totals: { dialed: number; connected: number; talkTimeSecs: number; connectRate: number };
  updatedAt: string;
  raw?: string;
}

function ReadyModePanel() {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ col: string; dir: "asc" | "desc" }>({ col: "dialed", dir: "desc" });
  const [showRaw, setShowRaw] = useState(false);
  const { token } = useUser();

  const q = useQuery<RmStatsResponse>({
    queryKey: ["readymodeStats"],
    queryFn: async () => {
      const r = await fetch("/api/readymode/stats", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      return r.json() as Promise<RmStatsResponse>;
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    retry: 1,
  });

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
    const agents = q.data?.agents ?? [];
    const q2 = search.trim().toLowerCase();
    let list = q2 ? agents.filter((a) => a.agentName.toLowerCase().includes(q2)) : agents;
    return [...list].sort((a, b) => {
      const dir = sort.dir === "asc" ? 1 : -1;
      if (sort.col === "name") return dir * a.agentName.localeCompare(b.agentName);
      if (sort.col === "dialed") return dir * (a.dialed - b.dialed);
      if (sort.col === "connected") return dir * (a.connected - b.connected);
      if (sort.col === "connectRate") return dir * (a.connectRate - b.connectRate);
      if (sort.col === "talkTime") return dir * (a.talkTimeSecs - b.talkTimeSecs);
      if (sort.col === "avgTalk") return dir * (a.avgTalkSecs - b.avgTalkSecs);
      return 0;
    });
  }, [q.data, search, sort]);

  const totals = q.data?.totals;
  const isFetching = q.isFetching;
  const hasData = (q.data?.agents ?? []).length > 0;
  const hasRaw = !!q.data?.raw;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0 gap-4">
        <div>
          <CardTitle className="text-xl flex items-center gap-2">
            ReadyMode
            <Badge className="text-[10px] px-1.5 py-0.5 bg-orange-500/20 text-orange-300 border-orange-500/30">Dialer</Badge>
          </CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            {q.data?.updatedAt
              ? `Per-agent dialer stats · updated ${new Date(q.data.updatedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: CA_TZ })} PDT`
              : "Per-agent call stats from ReadyMode dialer · refreshes every 60s"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {hasRaw && (
            <Button variant="outline" size="sm" onClick={() => setShowRaw((v) => !v)}>
              {showRaw ? "Hide raw" : "Show raw"}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => q.refetch()} disabled={isFetching}>
            <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {q.isLoading && <Skeleton className="h-40 w-full" />}

        {q.error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm space-y-2">
            <p className="font-medium text-destructive">Could not load ReadyMode data</p>
            <p className="text-muted-foreground">{String(q.error)}</p>
            <p className="text-xs text-muted-foreground">
              The ReadyMode portal uses session-based authentication. If the error persists, the login credentials may
              have changed or the session probe path needs updating.
            </p>
          </div>
        )}

        {showRaw && q.data?.raw && (
          <div className="rounded-lg border bg-muted/30 p-3">
            <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">Raw page preview (first 3000 chars) — use to identify API paths</p>
            <pre className="text-[10px] text-zinc-400 whitespace-pre-wrap break-all overflow-auto max-h-64">{q.data.raw}</pre>
          </div>
        )}

        {totals && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatTile label="Total dialed" value={totals.dialed} icon={<Phone className="h-3.5 w-3.5" />} tone="sky" />
            <StatTile label="Connected" value={totals.connected} icon={<PhoneCall className="h-3.5 w-3.5" />} tone="emerald" />
            <StatTile label="Connect rate" value={`${totals.connectRate}%`} icon={<Activity className="h-3.5 w-3.5" />} tone="violet" />
            <StatTile label="Total talk time" value={formatDuration(totals.talkTimeSecs)} icon={<Clock className="h-3.5 w-3.5" />} tone="amber" />
          </div>
        )}

        {!q.isLoading && !q.error && !hasData && q.data && (
          <div className="rounded-lg border border-orange-500/20 bg-orange-500/5 p-5 text-sm space-y-3">
            <p className="font-medium text-orange-300">Session active — no parseable agent table found yet</p>
            <p className="text-muted-foreground text-xs">
              ReadyMode returned a page but no agent call table could be parsed. This is normal during initial setup.
              Use the "Show raw" button above to inspect the HTML and identify the correct report path.
            </p>
            <p className="text-muted-foreground text-xs">
              You can also call <code className="bg-muted px-1 rounded">/api/readymode/probe?path=/supervisor/</code> from the browser to inspect other paths.
            </p>
          </div>
        )}

        {hasData && (
          <>
            <div className="flex items-center gap-3 flex-wrap">
              <div className="relative w-full sm:max-w-xs">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input placeholder="Search agents…" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
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
                      <SortTh col="dialed" label="Dialed" tone="text-sky-400" />
                      <SortTh col="connected" label="Connected" tone="text-emerald-400" />
                      <SortTh col="connectRate" label="Connect %" tone="text-violet-400" />
                      <SortTh col="talkTime" label="Talk time" />
                      <SortTh col="avgTalk" label="Avg talk" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visible.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center py-12 text-muted-foreground">No agents match the current filters.</TableCell>
                      </TableRow>
                    )}
                    {visible.map((agent) => (
                      <TableRow key={agent.agentName} className="hover-elevate">
                        <TableCell className="font-medium whitespace-nowrap">{agent.agentName}</TableCell>
                        <TableCell className={`text-right tabular-nums font-mono ${agent.dialed ? "text-sky-400" : "text-muted-foreground/40"}`}>{agent.dialed || "—"}</TableCell>
                        <TableCell className={`text-right tabular-nums font-mono ${agent.connected ? "text-emerald-400" : "text-muted-foreground/40"}`}>{agent.connected || "—"}</TableCell>
                        <TableCell className={`text-right tabular-nums font-mono ${agent.connectRate >= 20 ? "text-violet-400" : agent.connectRate > 0 ? "text-zinc-300" : "text-muted-foreground/40"}`}>
                          {agent.connectRate > 0 ? `${agent.connectRate}%` : "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums font-mono text-muted-foreground">{agent.talkTimeSecs ? formatDuration(agent.talkTimeSecs) : "—"}</TableCell>
                        <TableCell className="text-right tabular-nums font-mono text-muted-foreground">{agent.avgTalkSecs ? formatDuration(agent.avgTalkSecs) : "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                  {visible.length > 0 && (
                    <TableHeader className="sticky bottom-0 bg-muted/80 backdrop-blur z-10">
                      <TableRow>
                        <TableCell className="font-bold">Whole team</TableCell>
                        <TableCell className="text-right tabular-nums font-mono font-bold text-sky-400">{totals?.dialed || "—"}</TableCell>
                        <TableCell className="text-right tabular-nums font-mono font-bold text-emerald-400">{totals?.connected || "—"}</TableCell>
                        <TableCell className="text-right tabular-nums font-mono font-bold text-violet-400">{totals?.connectRate ? `${totals.connectRate}%` : "—"}</TableCell>
                        <TableCell className="text-right tabular-nums font-mono font-bold">{totals?.talkTimeSecs ? formatDuration(totals.talkTimeSecs) : "—"}</TableCell>
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

// ─── Phones Panel (sub-tabs: Quo Lines, PBX, ReadyMode) ───────────────────────

function PhonesPanel() {
  const PHONE_SUB_TABS = [
    { value: "quo-lines", label: "Quo Lines" },
    { value: "pbx",       label: "PBX" },
    { value: "readymode", label: "ReadyMode" },
  ];
  const [sub, setSub] = useState("quo-lines");
  return (
    <div className="space-y-4">
      <div className="flex gap-2 border-b border-white/10 pb-0">
        {PHONE_SUB_TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => setSub(t.value)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${
              sub === t.value
                ? "border-violet-500 text-violet-300"
                : "border-transparent text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {sub === "quo-lines"  && <QuoLinesPanel />}
      {sub === "pbx"        && <VoSPanel />}
      {sub === "readymode"  && <ReadyModePanel />}
    </div>
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

const TEAM_LABELS: Record<string, string> = { retention: "Retention", nsf: "NSF", cs: "Internal CS", backend: "Retention & Internal CS", other: "Other" };
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
  const { user } = useUser();
  const canViewMissedTables = user.role === "admin" || user.permissions.includes("view_missed_tables");
  const allItems = q.data?.items ?? [];
  // If the user has a team scope, only ever show their team's items
  const items = lockedTeam ? allItems.filter((it) => it.team === lockedTeam) : allItems;
  const fetchedAt = q.data?.fetchedAt ?? 0;
  const [teamFilter, setTeamFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<"all" | "pbx" | "quo">("all");
  const [lineFilter, setLineFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [missedMode, setMissedMode] = useState<"times" | "numbers">("times");

  const teams = useMemo(() => {
    const s = new Set<string>();
    for (const it of items) if (it.team !== "other") s.add(it.team);
    return Array.from(s).sort();
  }, [items]);

  const lines = useMemo(() => {
    const s = new Set<string>();
    for (const it of items) if (it.toNumber) s.add(it.toNumber);
    return Array.from(s).sort();
  }, [items]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const it of items) {
      c[it.team] = (c[it.team] ?? 0) + 1;
    }
    return c;
  }, [items]);

  const visible = useMemo(() => {
    let list = items;
    if (!lockedTeam && teamFilter !== "all") {
      list = list.filter((it) => it.team === teamFilter);
    }
    if (sourceFilter !== "all") list = list.filter((it) => it.source === sourceFilter);
    if (lineFilter !== "all") list = list.filter((it) => it.toNumber === lineFilter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((it) =>
        it.fromNumber.includes(q) ||
        it.ringGroupName.toLowerCase().includes(q) ||
        (it.toNumber ?? "").toLowerCase().includes(q)
      );
    }
    return [...list].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [items, teamFilter, sourceFilter, lineFilter, lockedTeam, search]);

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
            <Button size="sm" variant="ghost" className="h-7 px-2 gap-1" onClick={async () => {
              await fetch("/api/vos/refresh", { method: "POST" });
              await qc.invalidateQueries({ queryKey: ["missedNoCB"] });
            }}>
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
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatTile label="Total missed / no CB" value={q.isLoading ? "…" : items.length.toLocaleString()} tone="rose" icon={<PhoneOff className="h-3.5 w-3.5" />} />
            <StatTile label="Retention" value={q.isLoading ? "…" : (counts["retention"] ?? 0).toLocaleString()} tone="violet" />
            <StatTile label="Internal CS" value={q.isLoading ? "…" : (counts["cs"] ?? 0).toLocaleString()} tone="emerald" />
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
              {(["all", "retention", "cs", "nsf"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTeamFilter(t)}
                  className={`text-xs px-2.5 py-1 rounded-md border transition-colors ${
                    teamFilter === t
                      ? t === "retention"
                        ? "bg-violet-500/25 text-violet-200 border-violet-500/40"
                        : t === "cs"
                        ? "bg-emerald-500/25 text-emerald-200 border-emerald-500/40"
                        : t === "nsf"
                        ? "bg-sky-500/25 text-sky-200 border-sky-500/40"
                        : "bg-zinc-500/25 text-zinc-200 border-zinc-500/40"
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
          {lines.length > 0 && (
            <>
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">Line:</span>
              </div>
              <select
                value={lineFilter}
                onChange={(e) => setLineFilter(e.target.value)}
                className="h-7 rounded-md border border-zinc-700/50 bg-zinc-800/50 text-xs text-zinc-300 px-2 focus:outline-none focus:border-zinc-500 cursor-pointer"
              >
                <option value="all">All lines</option>
                {lines.map((l) => (
                  <option key={l} value={l}>{l}</option>
                ))}
              </select>
            </>
          )}
          <div className={`${lockedTeam && lines.length === 0 ? "" : "ml-auto"} flex items-center gap-2`}>
            <Search className="h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search number or line…"
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
                  <TableHead className="text-xs">Ring Group</TableHead>
                  <TableHead className="text-xs">Line</TableHead>
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
                    <TableCell className="text-xs text-zinc-300">
                      {it.toNumber || "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Hourly missed breakdown (today) — managers only */}
        {canViewMissedTables && (
          <div className="border-t border-zinc-800 pt-4 flex items-center justify-between">
            <span className="text-xs text-zinc-500">Count by</span>
            <div className="flex gap-1">
              {(["times", "numbers"] as const).map(m => (
                <button key={m} onClick={() => setMissedMode(m)}
                  className={`text-[10px] px-2 py-0.5 rounded ${missedMode === m ? "bg-zinc-700 text-white" : "text-zinc-500 hover:text-zinc-300"}`}>
                  {m === "times" ? "Times" : "Numbers"}
                </button>
              ))}
            </div>
          </div>
        )}
        {canViewMissedTables && <HourlyMissedRecord mode={missedMode} />}

        {/* Daily missed record — managers only */}
        {canViewMissedTables && <DailyMissedRecord mode={missedMode} />}
      </CardContent>
    </Card>
  );
}

function HourlyMissedRecord({ mode = "times" }: { mode?: "times" | "numbers" }) {
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const [date, setDate] = useState(todayStr);
  const isToday = date === todayStr;

  const { data, isLoading } = useMissedHourly(date, mode);
  const hours = data?.hours ?? [];

  const shift = (days: number) => {
    const d = new Date(date + "T12:00:00");
    d.setDate(d.getDate() + days);
    const next = d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    if (next <= todayStr) setDate(next);
  };

  const fmtDate = (d: string) => {
    if (d === todayStr) return "Today";
    const dt = new Date(d + "T12:00:00");
    return dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  };

  const fmt = (h: number) => {
    const ampm = h < 12 ? "am" : "pm";
    const display = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${display}${ampm}`;
  };

  const cellVal = (quo: number, ghost: number, pbx: number) => {
    const total = quo + pbx;
    if (total === 0) return <span className="text-zinc-600">—</span>;
    return (
      <span>
        {total}
        {ghost > 0 && <span className="ml-1 text-[10px] text-zinc-600">({ghost}g)</span>}
        {pbx > 0 && <span className="ml-1 text-[10px] text-zinc-500">(+{pbx} PBX)</span>}
      </span>
    );
  };

  return (
    <div className="pt-4">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-medium text-zinc-400">
          Missed by Hour — {mode === "numbers" ? "unique callers" : "call events"} (Quo + PBX)
        </p>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => shift(-1)}
            className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
            title="Previous day"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <span className="text-xs font-medium text-zinc-300 min-w-[90px] text-center">{fmtDate(date)}</span>
          <button
            type="button"
            onClick={() => shift(1)}
            disabled={isToday}
            className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            title="Next day"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {isLoading ? (
        <div className="space-y-1.5">{Array.from({length:3}).map((_,i)=><Skeleton key={i} className="h-7 w-full"/>)}</div>
      ) : hours.length === 0 ? (
        <p className="text-xs text-zinc-600 py-2">No missed calls recorded for this day.</p>
      ) : (
        <div className="rounded-lg border border-zinc-800 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-zinc-800 bg-zinc-900/60">
                <TableHead className="text-xs w-20">Hour</TableHead>
                <TableHead className="text-xs text-violet-300">Retention</TableHead>
                <TableHead className="text-xs text-emerald-300">CS</TableHead>
                <TableHead className="text-xs text-sky-300">NSF</TableHead>
                <TableHead className="text-xs text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {hours.map((h) => {
                const total = h.retention.quo + h.retention.pbx + h.cs.quo + h.cs.pbx + h.nsf.quo + h.nsf.pbx;
                return (
                  <TableRow key={h.hour} className="border-zinc-800 hover:bg-zinc-800/20">
                    <TableCell className="text-xs text-zinc-400 tabular-nums">{fmt(h.hour)}</TableCell>
                    <TableCell className="text-xs text-violet-300 font-medium">{cellVal(h.retention.quo, h.retention.ghost, h.retention.pbx)}</TableCell>
                    <TableCell className="text-xs text-emerald-300 font-medium">{cellVal(h.cs.quo, h.cs.ghost, h.cs.pbx)}</TableCell>
                    <TableCell className="text-xs text-sky-300 font-medium">{cellVal(h.nsf.quo, h.nsf.ghost, h.nsf.pbx)}</TableCell>
                    <TableCell className="text-xs text-right font-semibold text-zinc-200">{total}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

type NumberBreakdown = {
  fromNumber: string; team: string; source: "quo" | "pbx" | "both";
  missedCount: number; firstMissedAt: string; hasCallback: boolean;
  callbackConnected: boolean; callbackAt: string | null; responseMinutes: number | null;
  ghostCount: number; isGhost: boolean;
};

function fmtResponseTime(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function DailyMissedBreakdown({ date }: { date: string }) {
  const q = useQuery<{ date: string; numbers: NumberBreakdown[]; stats: { total: number; withCallback: number; connected: number; callbackRate: number; connectRate: number } }>({
    queryKey: ["missedBreakdown", date],
    queryFn: async () => {
      const r = await fetch(`/api/vos/missed-breakdown?date=${date}`);
      if (!r.ok) return { date, numbers: [], stats: { total: 0, withCallback: 0, connected: 0, callbackRate: 0, connectRate: 0 } };
      return r.json();
    },
    staleTime: 5 * 60_000,
  });

  if (q.isLoading) return (
    <div className="px-3 py-2 space-y-1">
      {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-6 w-full" />)}
    </div>
  );

  const numbers = q.data?.numbers ?? [];
  if (numbers.length === 0) return <p className="px-3 py-2 text-xs text-zinc-600">No breakdown available.</p>;

  const realNumbers = numbers.filter(n => !n.isGhost);
  const ghostNumbers = numbers.filter(n => n.isGhost);
  const s = q.data?.stats;
  const withCB = s?.withCallback ?? realNumbers.filter(n => n.hasCallback).length;
  const connected = s?.connected ?? realNumbers.filter(n => n.callbackConnected).length;
  const noAnswer = withCB - connected;
  const notCalled = realNumbers.length - withCB;

  return (
    <div className="bg-zinc-950/60 border-t border-zinc-800/60 px-3 py-2">
      <div className="flex items-center gap-3 mb-2 text-[10px] flex-wrap">
        <span className="text-zinc-500">{realNumbers.length} unique callers</span>
        {ghostNumbers.length > 0 && <span className="text-zinc-600">{ghostNumbers.length} ghost</span>}
        <span className="text-emerald-400 font-medium">{connected} talked ({realNumbers.length > 0 ? Math.round(connected / realNumbers.length * 100) : 0}%)</span>
        {noAnswer > 0 && <span className="text-amber-400">{noAnswer} no answer</span>}
        <span className="text-rose-400">{notCalled} not called</span>
        {withCB > 0 && <span className="text-zinc-600">· connect rate: {Math.round(connected / withCB * 100)}%</span>}
      </div>
      <div className="space-y-px max-h-64 overflow-y-auto pr-1">
        {numbers.map((n) => (
          <div key={n.fromNumber + n.firstMissedAt} className={`flex items-center justify-between text-xs py-1 px-2 rounded hover:bg-zinc-800/40 ${n.isGhost ? "opacity-50" : ""}`}>
            <span className="font-mono text-zinc-300 tabular-nums">{n.fromNumber}</span>
            <div className="flex items-center gap-2 shrink-0">
              <span className={`text-[10px] ${n.team === "retention" ? "text-violet-400" : n.team === "cs" ? "text-emerald-400" : "text-sky-400"}`}>
                {TEAM_LABELS[n.team] ?? n.team}
              </span>
              <span className={`text-[10px] px-1 py-0.5 rounded ${n.source === "quo" ? "bg-violet-500/20 text-violet-300" : n.source === "pbx" ? "bg-sky-500/20 text-sky-300" : "bg-zinc-500/20 text-zinc-300"}`}>
                {n.source === "both" ? "Quo+PBX" : n.source === "quo" ? "Quo" : "PBX"}
              </span>
              {n.isGhost && <span className="text-[9px] px-1 py-0.5 rounded border border-zinc-700 bg-zinc-800 text-zinc-500 uppercase font-medium">ghost</span>}
              {n.missedCount > 1 && <span className="text-zinc-600 text-[10px]">×{n.missedCount}</span>}
              {!n.isGhost && (!n.hasCallback
                ? <span className="flex items-center gap-0.5 text-rose-400"><PhoneOff className="h-3 w-3" />—</span>
                : n.callbackConnected
                  ? <span className="flex items-center gap-0.5 text-emerald-400 font-medium"><PhoneCall className="h-3 w-3" />{n.responseMinutes !== null ? fmtResponseTime(n.responseMinutes) : ""}</span>
                  : <span className="flex items-center gap-0.5 text-amber-400"><PhoneCall className="h-3 w-3" />no answer</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DailyMissedRecord({ mode = "times" }: { mode?: "times" | "numbers" }) {
  const { data, isLoading } = useMissedDaily(mode);
  const [expandedDate, setExpandedDate] = useState<string | null>(null);
  const days = data?.days ?? [];

  if (isLoading) return <div className="space-y-1.5">{Array.from({length:3}).map((_,i)=><Skeleton key={i} className="h-8 w-full"/>)}</div>;
  if (days.length === 0) return null;

  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

  const fmt = (d: string) => {
    if (d === todayStr) return "Today";
    const dt = new Date(d + "T12:00:00");
    return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", weekday: "short" });
  };

  return (
    <div className="border-t border-zinc-800 pt-4">
      <p className="text-xs font-medium text-zinc-400 mb-2">
        Daily Missed — {mode === "numbers" ? "unique callers" : "call events"} (PBX + Quo)
      </p>
      <div className="rounded-lg border border-zinc-800 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-zinc-800 bg-zinc-900/60">
              <TableHead className="text-xs w-28">Date</TableHead>
              <TableHead className="text-xs text-violet-300">Retention</TableHead>
              <TableHead className="text-xs text-emerald-300">CS</TableHead>
              <TableHead className="text-xs text-sky-300">NSF</TableHead>
              <TableHead className="text-xs text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {days.map((d) => {
              const ret = d.retention.quo + d.retention.pbx;
              const cs  = d.cs.quo  + d.cs.pbx;
              const nsf = d.nsf.quo + d.nsf.pbx;
              const total = ret + cs + nsf;
              const isToday = d.date === todayStr;
              const isExpanded = expandedDate === d.date;
              return (
                <Fragment key={d.date}>
                  <TableRow className={`border-zinc-800 ${isToday ? "bg-zinc-800/30" : "hover:bg-zinc-800/20"}`}>
                    <TableCell className={`text-xs tabular-nums ${isToday ? "text-white font-medium" : "text-zinc-400"}`}>
                      {fmt(d.date)}
                    </TableCell>
                    <TableCell className="text-xs">
                      <span className="text-violet-300 font-medium">{ret || "—"}</span>
                      {ret > 0 && (
                        <span className="text-zinc-600 ml-1 text-[10px]">
                          {d.retention.quo > 0 && <>{d.retention.quo}q</>}
                          {d.retention.ghost > 0 && <span className="text-zinc-700 ml-0.5">({d.retention.ghost}g)</span>}
                          {d.retention.pbx > 0 && <> {d.retention.pbx}p</>}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      <span className="text-emerald-300 font-medium">{cs || "—"}</span>
                      {cs > 0 && (
                        <span className="text-zinc-600 ml-1 text-[10px]">
                          {d.cs.quo > 0 && <>{d.cs.quo}q</>}
                          {d.cs.ghost > 0 && <span className="text-zinc-700 ml-0.5">({d.cs.ghost}g)</span>}
                          {d.cs.pbx > 0 && <> {d.cs.pbx}p</>}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      <span className="text-sky-300 font-medium">{nsf || "—"}</span>
                      {nsf > 0 && (
                        <span className="text-zinc-600 ml-1 text-[10px]">
                          {d.nsf.quo > 0 && <>{d.nsf.quo}q</>}
                          {d.nsf.ghost > 0 && <span className="text-zinc-700 ml-0.5">({d.nsf.ghost}g)</span>}
                          {d.nsf.pbx > 0 && <> {d.nsf.pbx}p</>}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-right font-semibold text-zinc-200">
                      <button
                        onClick={() => setExpandedDate(isExpanded ? null : d.date)}
                        className="inline-flex items-center gap-1 hover:text-white transition-colors"
                        title={isExpanded ? "Collapse" : "Show per-number breakdown"}
                      >
                        {total}
                        <ChevronRight className={`h-3 w-3 text-zinc-500 transition-transform duration-150 ${isExpanded ? "rotate-90" : ""}`} />
                      </button>
                    </TableCell>
                  </TableRow>
                  {isExpanded && (
                    <TableRow className="border-zinc-800">
                      <TableCell colSpan={5} className="p-0">
                        <DailyMissedBreakdown date={d.date} />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ─── Callback Review Panel ────────────────────────────────────────────────────

type CallbackReviewItem = {
  id: string;
  fromNumber: string;
  team: string;
  source: "quo" | "pbx";
  ringGroupName: string;
  missedAt: string;
  isGhost: boolean;
  hasCallback: boolean;
  callbackConnected: boolean;
  callbackAt: string | null;
  responseMinutes: number | null;
};

type CallbackReviewStats = {
  total: number;
  ghost: number;
  withCallback: number;
  connected: number;
  rate: number;
  connectRate: number;
  avgResponseMinutes: number;
  days: number;
};

function useCallbackReview(from: string, to: string) {
  return useQuery<{ items: CallbackReviewItem[]; stats: CallbackReviewStats }>({
    queryKey: ["callbackReview", from, to],
    queryFn: async () => {
      const r = await fetch(`/api/vos/callback-review?from=${from}&to=${to}`);
      if (!r.ok) return { items: [], stats: { total: 0, withCallback: 0, connected: 0, rate: 0, connectRate: 0, avgResponseMinutes: 0, days: 0 } };
      return r.json();
    },
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
    refetchOnWindowFocus: true,
  });
}

function CallbackReviewPanel() {
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const [preset, setPreset] = useState<"today" | "week" | "month" | "custom">("today");
  const [customFrom, setCustomFrom] = useState(todayStr);
  const [customTo, setCustomTo] = useState(todayStr);
  const [teamFilter, setTeamFilter] = useState("all");

  const { from, to } = useMemo((): { from: string; to: string } => {
    if (preset === "today") return { from: todayStr, to: todayStr };
    if (preset === "week") {
      const laDate = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
      const dow = laDate.getDay();
      const daysToMon = dow === 0 ? 6 : dow - 1;
      laDate.setDate(laDate.getDate() - daysToMon);
      return { from: laDate.toLocaleDateString("en-CA"), to: todayStr };
    }
    if (preset === "month") return { from: todayStr.slice(0, 7) + "-01", to: todayStr };
    return { from: customFrom || todayStr, to: customTo || todayStr };
  }, [preset, customFrom, customTo, todayStr]);

  const { data, isLoading } = useCallbackReview(from, to);
  const items = data?.items ?? [];

  const teamItems = useMemo(
    () => teamFilter === "all" ? items : items.filter(i => i.team === teamFilter),
    [items, teamFilter]
  );

  const stats = useMemo(() => {
    const real = teamItems.filter(i => !i.isGhost);
    const ghost = teamItems.filter(i => i.isGhost).length;
    const total = real.length;
    const withCB = real.filter(i => i.hasCallback).length;
    const connected = real.filter(i => i.callbackConnected).length;
    return { total, ghost, withCB, connected };
  }, [teamItems]);

  const dailyStats = useMemo(() => {
    const map = new Map<string, { missed: number; ghost: number; withCB: number; connected: number }>();
    for (const item of teamItems) {
      const date = new Date(item.missedAt).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
      if (!map.has(date)) map.set(date, { missed: 0, ghost: 0, withCB: 0, connected: 0 });
      const d = map.get(date)!;
      if (item.isGhost) { d.ghost++; continue; }
      d.missed++;
      if (item.hasCallback) d.withCB++;
      if (item.callbackConnected) d.connected++;
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([date, s]) => ({ date, ...s }));
  }, [teamItems]);

  const pct = (n: number, of: number) => of === 0 ? "—" : `${Math.round(n / of * 100)}%`;

  const fmtDay = (d: string) => {
    if (d === todayStr) return "Today";
    const dt = new Date(d + "T12:00:00");
    return dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  };

  const btnCls = (active: boolean, activeColor = "bg-violet-500/25 text-violet-200 border-violet-500/40") =>
    `text-xs px-3 py-1.5 rounded-md border transition-colors ${active ? activeColor : "bg-zinc-800/50 text-zinc-400 border-zinc-700/50 hover:border-zinc-500"}`;

  return (
    <Card className="border-white/5 bg-card/40 backdrop-blur-sm">
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <PhoneCall className="h-4 w-4 text-violet-400" />
          Callback Review
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">

        {/* Date range + team filters */}
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => setPreset("today")} className={btnCls(preset === "today")}>Today</button>
          <button onClick={() => setPreset("week")} className={btnCls(preset === "week")}>This Week</button>
          <button onClick={() => setPreset("month")} className={btnCls(preset === "month")}>This Month</button>
          <div className="w-px h-5 bg-zinc-700" />
          <input
            type="date" value={customFrom} max={todayStr}
            onChange={e => { setCustomFrom(e.target.value); setPreset("custom"); }}
            className="text-xs bg-zinc-800/50 border border-zinc-700/50 rounded-md px-2 py-1 text-zinc-300 focus:outline-none focus:border-zinc-500"
          />
          <span className="text-zinc-600 text-xs">—</span>
          <input
            type="date" value={customTo} max={todayStr}
            onChange={e => { setCustomTo(e.target.value); setPreset("custom"); }}
            className="text-xs bg-zinc-800/50 border border-zinc-700/50 rounded-md px-2 py-1 text-zinc-300 focus:outline-none focus:border-zinc-500"
          />
          <div className="w-px h-5 bg-zinc-700" />
          {(["all", "retention", "cs", "nsf"] as const).map((t) => (
            <button key={t} onClick={() => setTeamFilter(t)}
              className={btnCls(teamFilter === t,
                t === "retention" ? "bg-violet-500/25 text-violet-200 border-violet-500/40"
                : t === "cs" ? "bg-emerald-500/25 text-emerald-200 border-emerald-500/40"
                : t === "nsf" ? "bg-sky-500/25 text-sky-200 border-sky-500/40"
                : "bg-zinc-500/25 text-zinc-200 border-zinc-500/40"
              )}>
              {t === "all" ? "All Teams" : TEAM_LABELS[t] ?? t}
            </button>
          ))}
        </div>

        {/* Stat tiles */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <StatTile label="Total Missed" value={isLoading ? "…" : stats.total.toLocaleString()} tone="rose" icon={<PhoneOff className="h-3.5 w-3.5" />} />
          <StatTile label="Ghost Calls" value={isLoading ? "…" : stats.ghost.toLocaleString()} tone="zinc" icon={<PhoneOff className="h-3.5 w-3.5 opacity-40" />} />
          <StatTile label="Called Back" value={isLoading ? "…" : stats.withCB.toLocaleString()} tone="emerald" icon={<PhoneCall className="h-3.5 w-3.5" />} />
          <StatTile label="Talked" value={isLoading ? "…" : stats.connected.toLocaleString()} tone="sky" />
          <StatTile label="Connect Rate" value={isLoading ? "…" : pct(stats.connected, stats.withCB)} tone="amber" />
        </div>

        {/* Daily breakdown table */}
        {isLoading ? (
          <div className="space-y-1.5">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}</div>
        ) : dailyStats.length === 0 ? (
          <p className="text-sm text-zinc-600 py-8 text-center">No missed calls for this period.</p>
        ) : (
          <div className="rounded-lg border border-zinc-800 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="border-zinc-800 bg-zinc-900/60">
                  <TableHead className="text-xs">Date</TableHead>
                  <TableHead className="text-xs text-right text-rose-400">Missed</TableHead>
                  <TableHead className="text-xs text-right text-zinc-500">Ghost</TableHead>
                  <TableHead className="text-xs text-right text-emerald-400">Called Back</TableHead>
                  <TableHead className="text-xs text-right text-violet-400">CB%</TableHead>
                  <TableHead className="text-xs text-right text-sky-400">Talked</TableHead>
                  <TableHead className="text-xs text-right text-amber-400">Connect%</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dailyStats.map((d) => (
                  <TableRow key={d.date} className={`border-zinc-800 hover:bg-zinc-800/20 ${d.date === todayStr ? "bg-zinc-800/30" : ""}`}>
                    <TableCell className={`text-xs font-medium ${d.date === todayStr ? "text-white" : "text-zinc-400"}`}>
                      {fmtDay(d.date)}
                    </TableCell>
                    <TableCell className="text-xs text-right text-zinc-200 tabular-nums font-medium">{d.missed}</TableCell>
                    <TableCell className="text-xs text-right text-zinc-600 tabular-nums">{d.ghost > 0 ? d.ghost : "—"}</TableCell>
                    <TableCell className="text-xs text-right text-emerald-300 tabular-nums font-medium">{d.withCB}</TableCell>
                    <TableCell className="text-xs text-right tabular-nums">
                      <span className={`font-medium ${d.missed === 0 ? "text-zinc-600" : d.withCB / d.missed >= 0.8 ? "text-emerald-300" : d.withCB / d.missed >= 0.6 ? "text-amber-300" : "text-rose-300"}`}>
                        {pct(d.withCB, d.missed)}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs text-right text-sky-300 tabular-nums font-medium">{d.connected}</TableCell>
                    <TableCell className="text-xs text-right tabular-nums">
                      <span className={`font-medium ${d.withCB === 0 ? "text-zinc-600" : d.connected / d.withCB >= 0.5 ? "text-emerald-300" : d.connected / d.withCB >= 0.3 ? "text-amber-300" : "text-rose-300"}`}>
                        {pct(d.connected, d.withCB)}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Individual phone numbers table */}
        {!isLoading && items.length > 0 && (
          <div className="rounded-lg border border-zinc-800 overflow-hidden">
            <div className="px-3 py-2 bg-zinc-900/60 border-b border-zinc-800 flex flex-wrap items-center gap-2">
              <p className="text-xs font-semibold text-zinc-400 mr-1">Phone Numbers</p>
              {(["all","retention","cs","nsf"] as const).map(t => (
                <button key={t} onClick={() => setTeamFilter(t)}
                  className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                    teamFilter === t
                      ? t === "retention" ? "bg-violet-500/25 text-violet-200 border-violet-500/40"
                        : t === "cs" ? "bg-emerald-500/25 text-emerald-200 border-emerald-500/40"
                        : t === "nsf" ? "bg-sky-500/25 text-sky-200 border-sky-500/40"
                        : "bg-zinc-500/25 text-zinc-200 border-zinc-500/40"
                      : "bg-zinc-800/50 text-zinc-500 border-zinc-700/50 hover:border-zinc-500"
                  }`}>
                  {t === "all" ? "All" : t === "retention" ? "Retention" : t.toUpperCase()}
                </button>
              ))}
              <span className="text-[10px] text-zinc-600 ml-auto">{teamItems.length} numbers</span>
              <div className="flex gap-3 text-[10px] text-zinc-600">
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-zinc-700 inline-block" />No CB</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500/60 inline-block" />No answer</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500/60 inline-block" />Talked</span>
              </div>
            </div>
            <div className="max-h-[420px] overflow-y-auto">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-zinc-950">
                  <TableRow className="border-zinc-800">
                    <TableHead className="text-xs w-36">Phone</TableHead>
                    <TableHead className="text-xs">Team</TableHead>
                    <TableHead className="text-xs">Source</TableHead>
                    <TableHead className="text-xs">Missed At</TableHead>
                    <TableHead className="text-xs">Status</TableHead>
                    <TableHead className="text-xs text-zinc-500">Response</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {teamItems.map((item) => {
                    const num = item.fromNumber.replace(/(\+1)(\d{3})(\d{3})(\d{4})/, "$1 ($2) $3-$4");
                    const dot = !item.hasCallback ? "bg-zinc-700"
                      : item.callbackConnected ? "bg-emerald-500/70" : "bg-amber-500/60";
                    const teamColor = item.team === "retention" ? "text-violet-300 border-violet-500/30 bg-violet-500/10"
                      : item.team === "cs" ? "text-emerald-300 border-emerald-500/30 bg-emerald-500/10"
                      : item.team === "nsf" ? "text-sky-300 border-sky-500/30 bg-sky-500/10"
                      : "text-zinc-400 border-zinc-600 bg-zinc-800";
                    return (
                      <TableRow key={item.id} className={`border-zinc-800/60 hover:bg-zinc-800/20 ${item.isGhost ? "opacity-50" : ""}`}>
                        <TableCell className="text-xs font-mono text-zinc-200 tabular-nums py-2">
                          <div className="flex items-center gap-1.5">
                            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dot}`} />
                            {num}
                          </div>
                        </TableCell>
                        <TableCell className="py-2">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${teamColor}`}>{item.team}</span>
                        </TableCell>
                        <TableCell className="text-[10px] text-zinc-500 py-2">
                          <div className="flex items-center gap-1">
                            <span className="uppercase">{item.source}</span>
                            {item.isGhost && <span className="px-1 py-0.5 rounded border text-[9px] font-medium uppercase text-zinc-400 border-zinc-600 bg-zinc-800">ghost</span>}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs text-zinc-500 tabular-nums py-2 whitespace-nowrap">
                          {new Date(item.missedAt).toLocaleString("en-US", {
                            month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
                            hour12: true, timeZone: "America/Los_Angeles",
                          })}
                        </TableCell>
                        <TableCell className="text-xs py-2">
                          {!item.hasCallback
                            ? <span className="text-zinc-600">No callback</span>
                            : item.callbackConnected
                            ? <span className="text-emerald-400">Talked</span>
                            : <span className="text-amber-400">Called, no answer</span>}
                        </TableCell>
                        <TableCell className="text-[10px] text-zinc-600 tabular-nums py-2">
                          {item.responseMinutes !== null ? `${item.responseMinutes}m` : "—"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Violations Panel ─────────────────────────────────────────────────────────

type LateLoginRow = {
  key: string; member: string; department: string; date: string;
  shiftStart: string; firstCallAt: string; minutesLate: number;
};
type GapEntry = { start: string; end: string; minutes: number };
type AvailGapRow = {
  key: string; member: string; department: string; date: string;
  gapCount: number; gaps: GapEntry[];
};
type MissedCallEntry = {
  key: string; pbxCallId: number | null; source: "pbx" | "quo"; date: string; missedAt: string;
  team: string; fromNumber: string; ringGroupName: string;
  availableAgents: string[]; busyAgents: string[];
};
type VerifiedItem = {
  id: number; key: string; type: string; member: string; department: string;
  date: string; details: string; verifiedBy: string; verifiedAt: string;
};
type ViolationsData = {
  lateLogin: LateLoginRow[]; availabilityGaps: AvailGapRow[];
  missedWhileAvail: MissedCallEntry[]; verifiedKeys: string[];
};

function deptBadge(dept: string): string {
  const d = dept.toLowerCase();
  if (d === "retention") return "bg-violet-500/15 text-violet-300 border-violet-500/30";
  if (d === "cs") return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
  if (d === "nsf") return "bg-sky-500/15 text-sky-300 border-sky-500/30";
  return "bg-zinc-700/40 text-zinc-300 border-zinc-600/30";
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/Los_Angeles",
  });
}
function fmtDate(d: string): string {
  const dt = new Date(d + "T12:00:00");
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", weekday: "short" });
}
function fmtMins(m: number): string {
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function ViolationsPanel() {
  const { token, user } = useUser();
  const todayLA = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const sevenAgo = new Date(Date.now() - 6 * 86400000).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

  const [from, setFrom] = useState(todayLA);
  const [to, setTo]     = useState(todayLA);
  const [sub, setSub]   = useState<"late" | "gaps" | "missed" | "cancels" | "verified">("missed");
  const [deptFilter, setDeptFilter] = useState<string>("all");
  const [sortLate, setSortLate]     = useState<"date" | "mins">("date");
  const [sortGaps, setSortGaps]     = useState<"date" | "count">("count");
  const [sortMissed, setSortMissed] = useState<"date" | "avail">("date");
  const [localVerified, setLocalVerified] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [localDismissed, setLocalDismissed] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("dismissed_violations") ?? "[]") as string[]); }
    catch { return new Set<string>(); }
  });
  const [copied, setCopied] = useState(false);

  const { data, isLoading, isError, refetch } = useQuery<ViolationsData>({
    queryKey: ["violations", from, to, token],
    queryFn: async () => {
      const r = await fetch(`/api/violations?from=${from}&to=${to}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json() as Promise<ViolationsData>;
    },
    staleTime: 2 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
  });

  const { data: verifiedData, refetch: refetchVerified } = useQuery<{ items: VerifiedItem[] }>({
    queryKey: ["violations-verified", token],
    queryFn: async () => {
      const r = await fetch("/api/violations/verified", { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(await r.text());
      return r.json() as Promise<{ items: VerifiedItem[] }>;
    },
    staleTime: 30 * 1000,
  });

  const violationsRoster = useRoster();
  const { data: cancelData, isLoading: cancelLoading } = useQuery<CancelViolation[]>({
    queryKey: ["cancel-violations", violationsRoster.version],
    queryFn: () => fetchCancelViolations(violationsRoster),
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    if (data?.verifiedKeys) setLocalVerified(new Set(data.verifiedKeys));
  }, [data?.verifiedKeys]);

  const toggleVerify = useCallback(async (
    key: string, type: string, member: string, department: string, date: string, details: object,
  ) => {
    const isNowVerified = !localVerified.has(key);
    setLocalVerified(prev => { const s = new Set(prev); isNowVerified ? s.add(key) : s.delete(key); return s; });
    setPending(prev => new Set(prev).add(key));
    try {
      if (isNowVerified) {
        await fetch("/api/violations/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ key, type, member, department, date, details: JSON.stringify(details), verifiedBy: user.username }),
        });
      } else {
        await fetch("/api/violations/verify", {
          method: "DELETE",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ key }),
        });
      }
      void refetchVerified();
    } catch { /* optimistic — keep local state */ }
    finally { setPending(prev => { const s = new Set(prev); s.delete(key); return s; }); }
  }, [localVerified, token, user.username, refetchVerified]);

  const dismissViolation = useCallback((key: string) => {
    setLocalDismissed(prev => {
      const s = new Set(prev);
      s.add(key);
      try { localStorage.setItem("dismissed_violations", JSON.stringify(Array.from(s))); } catch { /* ignore */ }
      return s;
    });
  }, []);

  const depts = useMemo(() => {
    const s = new Set<string>();
    for (const r of data?.lateLogin ?? []) s.add(r.department.toUpperCase());
    for (const r of data?.availabilityGaps ?? []) s.add(r.department.toUpperCase());
    for (const r of data?.missedWhileAvail ?? []) s.add(r.team.toUpperCase());
    for (const r of cancelData ?? []) s.add(r.team.toUpperCase());
    return ["all", ...Array.from(s).sort()];
  }, [data, cancelData]);

  const cancelRows = useMemo(() => {
    return (cancelData ?? []).filter(r =>
      !localDismissed.has(r.key) &&
      (deptFilter === "all" || r.team.toUpperCase() === deptFilter)
    );
  }, [cancelData, deptFilter, localDismissed]);

  const lateRows = useMemo(() => {
    let rows = (data?.lateLogin ?? []).filter(r =>
      !localDismissed.has(r.key) &&
      (deptFilter === "all" || r.department.toUpperCase() === deptFilter)
    );
    if (sortLate === "mins") rows = [...rows].sort((a, b) => b.minutesLate - a.minutesLate);
    else rows = [...rows].sort((a, b) => b.date.localeCompare(a.date) || b.minutesLate - a.minutesLate);
    return rows;
  }, [data, deptFilter, sortLate, localDismissed]);

  const gapRows = useMemo(() => {
    let rows = (data?.availabilityGaps ?? []).filter(r =>
      !localDismissed.has(r.key) &&
      (deptFilter === "all" || r.department.toUpperCase() === deptFilter)
    );
    const longest = (r: AvailGapRow) => Math.max(...r.gaps.map(g => g.minutes));
    if (sortGaps === "count") rows = [...rows].sort((a, b) => b.gapCount - a.gapCount || longest(b) - longest(a));
    else rows = [...rows].sort((a, b) => b.date.localeCompare(a.date) || b.gapCount - a.gapCount);
    return rows;
  }, [data, deptFilter, sortGaps, localDismissed]);

  const missedRows = useMemo(() => {
    let rows = (data?.missedWhileAvail ?? []).filter(r =>
      !localDismissed.has(r.key) &&
      (deptFilter === "all" || r.team.toUpperCase() === deptFilter)
    );
    if (sortMissed === "avail") rows = [...rows].sort((a, b) => b.availableAgents.length - a.availableAgents.length);
    else rows = [...rows].sort((a, b) => b.missedAt.localeCompare(a.missedAt));
    return rows;
  }, [data, deptFilter, sortMissed, localDismissed]);

  const lateMinsColor = (m: number) =>
    m > 60 ? "text-rose-400 font-bold" : m > 30 ? "text-orange-400 font-semibold" : "text-amber-400";

  const verifiedCount = localVerified.size;

  const handleSend = useCallback(() => {
    const items = verifiedData?.items ?? [];
    if (items.length === 0) return;
    const lines: string[] = [
      `VIOLATION REPORT — ${from} to ${to}`,
      `Generated by Backend Tracker | ${new Date().toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "long", day: "numeric", year: "numeric" })}`,
      "",
    ];
    const lateItems   = items.filter(i => i.type === "late_login");
    const gapItems    = items.filter(i => i.type === "availability_gap");
    const missItems   = items.filter(i => i.type === "missed_call");
    const cancelItems = items.filter(i => i.type === "unauthorized_cancel");
    if (lateItems.length > 0) {
      lines.push(`LATE LOGIN (${lateItems.length})`);
      lines.push("─".repeat(30));
      for (const it of lateItems) {
        try {
          const d = JSON.parse(it.details) as LateLoginRow;
          lines.push(`• ${it.member} (${it.department}) — ${fmtDate(it.date)}: ${fmtMins(d.minutesLate)} late (shift ${fmtTime(d.shiftStart)}, first call ${fmtTime(d.firstCallAt)})`);
        } catch { lines.push(`• ${it.member} (${it.department}) — ${fmtDate(it.date)}`); }
      }
      lines.push("");
    }
    if (gapItems.length > 0) {
      lines.push(`AVAILABILITY GAPS (${gapItems.length})`);
      lines.push("─".repeat(30));
      for (const it of gapItems) {
        try {
          const d = JSON.parse(it.details) as AvailGapRow;
          const longest = Math.max(...d.gaps.map(g => g.minutes));
          lines.push(`• ${it.member} (${it.department}) — ${fmtDate(it.date)}: ${d.gapCount} gaps, longest ${fmtMins(longest)}`);
        } catch { lines.push(`• ${it.member} (${it.department}) — ${fmtDate(it.date)}`); }
      }
      lines.push("");
    }
    if (missItems.length > 0) {
      lines.push(`MISSED CALLS (${missItems.length})`);
      lines.push("─".repeat(30));
      for (const it of missItems) {
        try {
          const d = JSON.parse(it.details) as MissedCallEntry;
          lines.push(`• ${fmtDate(it.date)} ${fmtTime(d.missedAt)} — ${d.ringGroupName}: ${d.fromNumber} | Available: ${d.availableAgents.join(", ")}`);
        } catch { lines.push(`• ${it.member} — ${fmtDate(it.date)}`); }
      }
      lines.push("");
    }
    if (cancelItems.length > 0) {
      lines.push(`UNAUTHORIZED CANCELLATIONS (${cancelItems.length})`);
      lines.push("─".repeat(30));
      for (const it of cancelItems) {
        try {
          const d = JSON.parse(it.details) as CancelViolation;
          const fid = d.fileId ? ` [${d.fileId}]` : "";
          lines.push(`• ${d.agent} (${d.team}) — ${fmtDate(d.date)}${fid}: ${d.rawStatus}`);
        } catch { lines.push(`• ${it.member} (${it.department}) — ${fmtDate(it.date)}`); }
      }
      lines.push("");
    }
    void navigator.clipboard.writeText(lines.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }, [verifiedData, from, to]);

  const SUB_TABS = [
    { id: "late"     as const, label: "Late Login",    count: data?.lateLogin.length },
    { id: "gaps"     as const, label: "Availability",  count: data?.availabilityGaps.length },
    { id: "missed"   as const, label: "Missed Calls",  count: data?.missedWhileAvail.length },
    { id: "cancels"  as const, label: "Cancels",       count: cancelData?.length, urgent: (cancelData?.length ?? 0) > 0 },
    { id: "verified" as const, label: "Verified",      count: verifiedCount, accent: true },
  ];

  const Checkbox = ({ vkey, type, member, department, date, details }: {
    vkey: string; type: string; member: string; department: string; date: string; details: object;
  }) => {
    const checked = localVerified.has(vkey);
    const busy    = pending.has(vkey);
    return (
      <button
        onClick={() => void toggleVerify(vkey, type, member, department, date, details)}
        disabled={busy}
        className={`flex-shrink-0 h-4 w-4 rounded border transition-all ${busy ? "opacity-40 cursor-wait" : "cursor-pointer"} ${
          checked ? "bg-emerald-500 border-emerald-500" : "bg-transparent border-zinc-600 hover:border-zinc-400"
        }`}
        title={checked ? "Unmark verified" : "Mark as verified"}
      >
        {checked && <svg viewBox="0 0 10 8" className="w-full h-full p-0.5 text-white fill-none stroke-current stroke-2"><polyline points="1,4 4,7 9,1"/></svg>}
      </button>
    );
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <Calendar className="h-4 w-4" />
          <span>From</span>
          <Input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)}
            className="h-8 w-36 bg-zinc-900/60 border-white/10 text-white text-xs" />
          <span>to</span>
          <Input type="date" value={to} min={from} max={todayLA} onChange={e => setTo(e.target.value)}
            className="h-8 w-36 bg-zinc-900/60 border-white/10 text-white text-xs" />
        </div>
        <button onClick={() => void refetch()}
          className="ml-auto p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-700/60 transition-colors">
          <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* Summary cards */}
      {data && (
        <div className="flex flex-wrap gap-3">
          <div className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5">
            <Clock className="h-4 w-4 text-amber-400" />
            <div><p className="text-xs text-zinc-400">Late Logins</p><p className="text-xl font-bold text-amber-300">{data.lateLogin.length}</p></div>
          </div>
          <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2.5">
            <ShieldAlert className="h-4 w-4 text-rose-400" />
            <div><p className="text-xs text-zinc-400">Availability Violations</p><p className="text-xl font-bold text-rose-300">{data.availabilityGaps.reduce((s, r) => s + r.gapCount, 0)}</p></div>
          </div>
          <div className="flex items-center gap-2 rounded-xl border border-orange-500/30 bg-orange-500/10 px-4 py-2.5">
            <PhoneMissed className="h-4 w-4 text-orange-400" />
            <div><p className="text-xs text-zinc-400">Missed While Available</p><p className="text-xl font-bold text-orange-300">{data.missedWhileAvail.length}</p></div>
          </div>
          <div className="flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2.5">
            <ShieldAlert className="h-4 w-4 text-red-400" />
            <div><p className="text-xs text-zinc-400">Unauthorized Cancels</p><p className="text-xl font-bold text-red-300">{cancelData?.length ?? 0}</p></div>
          </div>
          <div className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5">
            <UserCheck className="h-4 w-4 text-emerald-400" />
            <div><p className="text-xs text-zinc-400">Verified</p><p className="text-xl font-bold text-emerald-300">{verifiedCount}</p></div>
          </div>
        </div>
      )}

      {/* Sub-tab + dept filter */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg border border-white/10 overflow-hidden">
          {SUB_TABS.map(t => (
            <button key={t.id} onClick={() => setSub(t.id)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors flex items-center gap-1.5 ${
                sub === t.id
                  ? t.accent ? "bg-emerald-600 text-white" : t.urgent ? "bg-red-600 text-white" : "bg-violet-600 text-white"
                  : "bg-zinc-900/60 text-zinc-400 hover:text-white"
              }`}>
              {t.label}
              {t.count !== undefined && (
                <span className={`rounded-full px-1.5 py-0 text-[10px] font-bold ${
                  sub === t.id ? "bg-white/20 text-white"
                  : t.urgent && (t.count ?? 0) > 0 ? "bg-red-500 text-white"
                  : "bg-zinc-700 text-zinc-300"
                }`}>
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </div>
        {sub !== "verified" && (
          <div className="flex rounded-lg border border-white/10 overflow-hidden text-xs">
            {depts.map((d) => (
              <button key={d} onClick={() => setDeptFilter(d)}
                className={`px-3 py-1.5 capitalize transition-colors ${deptFilter === d ? "bg-zinc-700 text-white" : "bg-zinc-900/60 text-zinc-400 hover:text-white"}`}>
                {d}
              </button>
            ))}
          </div>
        )}
      </div>

      {isLoading && <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>}
      {isError  && <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-rose-300 text-sm">Failed to load violations.</div>}

      {/* ── Late Login ─────────────────────────────────────────────────── */}
      {!isLoading && !isError && sub === "late" && (
        <div className="rounded-xl border border-white/8 overflow-hidden">
          <div className="px-4 py-2.5 bg-zinc-900/60 border-b border-white/8 flex items-center justify-between">
            <p className="text-xs font-semibold text-amber-300 flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5" />Late Login — first call {">"} 10 min after shift start
            </p>
            <div className="flex gap-1">
              {(["date","mins"] as const).map(s => (
                <button key={s} onClick={() => setSortLate(s)}
                  className={`text-[10px] px-2 py-0.5 rounded ${sortLate === s ? "bg-zinc-700 text-white" : "text-zinc-500 hover:text-zinc-300"}`}>
                  {s === "date" ? "By Date" : "By Delay"}
                </button>
              ))}
            </div>
          </div>
          {lateRows.length === 0
            ? <div className="py-10 text-center text-sm text-zinc-500">No late login violations for this range.</div>
            : <Table>
                <TableHeader>
                  <TableRow className="border-white/8 bg-zinc-900/40">
                    <TableHead className="w-8" />
                    <TableHead className="text-xs w-28">Date</TableHead>
                    <TableHead className="text-xs">Agent</TableHead>
                    <TableHead className="text-xs">Dept</TableHead>
                    <TableHead className="text-xs">Shift Start</TableHead>
                    <TableHead className="text-xs">First Call</TableHead>
                    <TableHead className="text-xs text-right">Late By</TableHead>
                    <TableHead className="w-8" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lateRows.map((r, i) => (
                    <TableRow key={i} className={`border-white/5 transition-colors group ${localVerified.has(r.key) ? "bg-emerald-950/20" : "hover:bg-zinc-800/20"}`}>
                      <TableCell className="pl-3 pr-1">
                        <Checkbox vkey={r.key} type="late_login" member={r.member} department={r.department} date={r.date} details={r} />
                      </TableCell>
                      <TableCell className="text-xs text-zinc-400 tabular-nums">{fmtDate(r.date)}</TableCell>
                      <TableCell className={`text-xs font-medium ${localVerified.has(r.key) ? "text-emerald-300 line-through decoration-emerald-600/50" : "text-white"}`}>{r.member}</TableCell>
                      <TableCell className="text-xs"><Badge className={`text-[10px] px-1.5 py-0 border ${deptBadge(r.department)}`}>{r.department}</Badge></TableCell>
                      <TableCell className="text-xs text-zinc-400 tabular-nums">{fmtTime(r.shiftStart)}</TableCell>
                      <TableCell className="text-xs text-zinc-300 tabular-nums">{fmtTime(r.firstCallAt)}</TableCell>
                      <TableCell className={`text-xs tabular-nums text-right ${lateMinsColor(r.minutesLate)}`}>{fmtMins(r.minutesLate)}</TableCell>
                      <TableCell className="pr-3">
                        <button onClick={() => dismissViolation(r.key)} title="Dismiss" className="p-1 rounded text-zinc-600 hover:text-zinc-300 hover:bg-zinc-700/50 transition-colors">
                          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current"><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/></svg>
                        </button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
          }
        </div>
      )}

      {/* ── Availability Gaps ──────────────────────────────────────────── */}
      {!isLoading && !isError && sub === "gaps" && (
        <div className="rounded-xl border border-white/8 overflow-hidden">
          <div className="px-4 py-2.5 bg-zinc-900/60 border-b border-white/8 flex items-center justify-between">
            <p className="text-xs font-semibold text-rose-300 flex items-center gap-1.5">
              <ShieldAlert className="h-3.5 w-3.5" />Availability — gaps {">"} 5 min between consecutive calls
            </p>
            <div className="flex gap-1">
              {(["count","date"] as const).map(s => (
                <button key={s} onClick={() => setSortGaps(s)}
                  className={`text-[10px] px-2 py-0.5 rounded ${sortGaps === s ? "bg-zinc-700 text-white" : "text-zinc-500 hover:text-zinc-300"}`}>
                  {s === "count" ? "By Count" : "By Date"}
                </button>
              ))}
            </div>
          </div>
          {gapRows.length === 0
            ? <div className="py-10 text-center text-sm text-zinc-500">No availability violations for this range.</div>
            : <Table>
                <TableHeader>
                  <TableRow className="border-white/8 bg-zinc-900/40">
                    <TableHead className="w-8" />
                    <TableHead className="text-xs w-28">Date</TableHead>
                    <TableHead className="text-xs">Agent</TableHead>
                    <TableHead className="text-xs">Dept</TableHead>
                    <TableHead className="text-xs text-center">Gaps</TableHead>
                    <TableHead className="text-xs">Gap Durations (LA time)</TableHead>
                    <TableHead className="w-8" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {gapRows.map((r, i) => (
                    <TableRow key={i} className={`border-white/5 transition-colors group ${localVerified.has(r.key) ? "bg-emerald-950/20" : "hover:bg-zinc-800/20"}`}>
                      <TableCell className="pl-3 pr-1">
                        <Checkbox vkey={r.key} type="availability_gap" member={r.member} department={r.department} date={r.date} details={r} />
                      </TableCell>
                      <TableCell className="text-xs text-zinc-400 tabular-nums">{fmtDate(r.date)}</TableCell>
                      <TableCell className={`text-xs font-medium ${localVerified.has(r.key) ? "text-emerald-300 line-through decoration-emerald-600/50" : "text-white"}`}>{r.member}</TableCell>
                      <TableCell className="text-xs"><Badge className={`text-[10px] px-1.5 py-0 border ${deptBadge(r.department)}`}>{r.department}</Badge></TableCell>
                      <TableCell className="text-xs text-center">
                        <span className={`font-bold ${r.gapCount >= 5 ? "text-rose-400" : r.gapCount >= 3 ? "text-orange-400" : "text-amber-400"}`}>{r.gapCount}</span>
                      </TableCell>
                      <TableCell className="text-xs">
                        <div className="flex flex-wrap gap-1">
                          {r.gaps.map((g, j) => (
                            <Tooltip key={j}>
                              <TooltipTrigger asChild>
                                <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium cursor-default
                                  ${g.minutes > 30 ? "bg-rose-500/20 text-rose-300" : g.minutes > 15 ? "bg-orange-500/20 text-orange-300" : "bg-amber-500/20 text-amber-300"}`}>
                                  {fmtMins(g.minutes)}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent className="text-xs">{fmtTime(g.start)} → {fmtTime(g.end)}</TooltipContent>
                            </Tooltip>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="pr-3">
                        <button onClick={() => dismissViolation(r.key)} title="Dismiss" className="p-1 rounded text-zinc-600 hover:text-zinc-300 hover:bg-zinc-700/50 transition-colors">
                          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current"><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/></svg>
                        </button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
          }
        </div>
      )}

      {/* ── Missed While Available ─────────────────────────────────────── */}
      {!isLoading && !isError && sub === "missed" && (
        <div className="rounded-xl border border-white/8 overflow-hidden">
          <div className="px-4 py-2.5 bg-zinc-900/60 border-b border-white/8 flex items-center justify-between">
            <p className="text-xs font-semibold text-orange-300 flex items-center gap-1.5">
              <PhoneMissed className="h-3.5 w-3.5" />Missed calls — agent was on shift and not on another call
            </p>
            <div className="flex gap-1">
              {(["date","avail"] as const).map(s => (
                <button key={s} onClick={() => setSortMissed(s)}
                  className={`text-[10px] px-2 py-0.5 rounded ${sortMissed === s ? "bg-zinc-700 text-white" : "text-zinc-500 hover:text-zinc-300"}`}>
                  {s === "date" ? "By Date" : "By Available"}
                </button>
              ))}
            </div>
          </div>
          {missedRows.length === 0
            ? <div className="py-10 text-center text-sm text-zinc-500">No missed-while-available violations for this range.</div>
            : <Table>
                <TableHeader>
                  <TableRow className="border-white/8 bg-zinc-900/40">
                    <TableHead className="w-8" />
                    <TableHead className="text-xs w-32">Date / Time</TableHead>
                    <TableHead className="text-xs">Ring Group</TableHead>
                    <TableHead className="text-xs">Source</TableHead>
                    <TableHead className="text-xs">Caller</TableHead>
                    <TableHead className="text-xs">Available (on shift)</TableHead>
                    <TableHead className="text-xs text-zinc-600">Busy</TableHead>
                    <TableHead className="w-8" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {missedRows.map((r, i) => (
                    <TableRow key={i} className={`border-white/5 transition-colors group ${localVerified.has(r.key) ? "bg-emerald-950/20" : "hover:bg-zinc-800/20"}`}>
                      <TableCell className="pl-3 pr-1">
                        <Checkbox vkey={r.key} type="missed_call" member={r.availableAgents[0] ?? ""} department={r.team} date={r.date} details={r} />
                      </TableCell>
                      <TableCell className="text-xs text-zinc-400 tabular-nums whitespace-nowrap">
                        <div>{fmtDate(r.date)}</div>
                        <div className="text-[10px] text-zinc-500">{fmtTime(r.missedAt)}</div>
                      </TableCell>
                      <TableCell className="text-xs">
                        <div className="text-zinc-200 font-medium">{r.ringGroupName}</div>
                        <Badge className={`text-[10px] px-1.5 py-0 mt-0.5 border ${deptBadge(r.team.charAt(0).toUpperCase() + r.team.slice(1))}`}>
                          {r.team}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs">
                        {r.source === "quo"
                          ? <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-violet-500/15 text-violet-300 border border-violet-500/25">OpenPhone</span>
                          : <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-sky-500/15 text-sky-300 border border-sky-500/25">PBX</span>
                        }
                      </TableCell>
                      <TableCell className="text-xs text-zinc-400 tabular-nums font-mono">
                        {r.fromNumber.replace(/(\+1)(\d{3})(\d{3})(\d{4})/, "$1 ($2) $3-$4")}
                      </TableCell>
                      <TableCell className="text-xs">
                        <div className="flex flex-wrap gap-1">
                          {r.availableAgents.map((a, j) => (
                            <span key={j} className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-orange-500/15 text-orange-300 border border-orange-500/25">
                              {a}
                            </span>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs">
                        <div className="flex flex-wrap gap-1">
                          {r.busyAgents.map((a, j) => (
                            <span key={j} className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] text-zinc-600 bg-zinc-800/40">
                              {a}
                            </span>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="pr-3">
                        <button onClick={() => dismissViolation(r.key)} title="Dismiss" className="p-1 rounded text-zinc-600 hover:text-zinc-300 hover:bg-zinc-700/50 transition-colors">
                          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current"><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/></svg>
                        </button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
          }
        </div>
      )}

      {/* ── Unauthorized Cancels ───────────────────────────────────────── */}
      {sub === "cancels" && (
        <div className="rounded-xl border border-red-500/30 overflow-hidden">
          <div className="px-4 py-2.5 bg-zinc-900/60 border-b border-red-500/20 flex items-center justify-between">
            <p className="text-xs font-semibold text-red-300 flex items-center gap-1.5">
              <ShieldAlert className="h-3.5 w-3.5" />Unauthorized cancellations — CS/NSF agents are not allowed to cancel files
            </p>
          </div>
          {cancelLoading
            ? <div className="py-10 text-center text-sm text-zinc-500">Scanning sheets…</div>
            : cancelRows.length === 0
              ? <div className="py-10 text-center text-sm text-zinc-500">No unauthorized cancellations found.</div>
              : <Table>
                  <TableHeader>
                    <TableRow className="border-white/8 bg-zinc-900/40">
                      <TableHead className="w-8" />
                      <TableHead className="text-xs w-28">Date</TableHead>
                      <TableHead className="text-xs">Agent</TableHead>
                      <TableHead className="text-xs">Team</TableHead>
                      <TableHead className="text-xs">File ID</TableHead>
                      <TableHead className="text-xs">Status</TableHead>
                      <TableHead className="w-8" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {cancelRows.map((r, i) => (
                      <TableRow key={i} className={`border-white/5 transition-colors group ${localVerified.has(r.key) ? "bg-emerald-950/20" : "bg-red-950/10 hover:bg-red-950/20"}`}>
                        <TableCell className="pl-3 pr-1">
                          <Checkbox vkey={r.key} type="unauthorized_cancel" member={r.agent} department={r.team} date={r.date} details={r} />
                        </TableCell>
                        <TableCell className="text-xs text-zinc-400 tabular-nums">{fmtDate(r.date)}</TableCell>
                        <TableCell className={`text-xs font-medium ${localVerified.has(r.key) ? "text-emerald-300 line-through decoration-emerald-600/50" : "text-red-200"}`}>{r.agent}</TableCell>
                        <TableCell className="text-xs"><Badge className={`text-[10px] px-1.5 py-0 border ${deptBadge(r.team)}`}>{r.team}</Badge></TableCell>
                        <TableCell className="text-xs font-mono text-zinc-300">{r.fileId || <span className="text-zinc-600">—</span>}</TableCell>
                        <TableCell className="text-xs text-red-400 font-medium">{r.rawStatus}</TableCell>
                        <TableCell className="pr-3">
                          <button onClick={() => dismissViolation(r.key)} title="Dismiss" className="p-1 rounded text-zinc-600 hover:text-zinc-300 hover:bg-zinc-700/50 transition-colors">
                            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current"><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/></svg>
                          </button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
          }
        </div>
      )}

      {/* ── Verified Tab ───────────────────────────────────────────────── */}
      {sub === "verified" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-zinc-400">
              {verifiedData?.items.length ?? 0} verified violation{verifiedData?.items.length !== 1 ? "s" : ""} ready to send
            </p>
            <button
              onClick={handleSend}
              disabled={!verifiedData?.items.length}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all
                ${verifiedData?.items.length
                  ? copied ? "bg-emerald-600 text-white" : "bg-violet-600 hover:bg-violet-500 text-white"
                  : "bg-zinc-800 text-zinc-600 cursor-not-allowed"
                }`}
            >
              {copied ? <><UserCheck className="h-4 w-4" />Copied!</> : <><Send className="h-4 w-4" />Copy Report</>}
            </button>
          </div>
          {!verifiedData?.items.length ? (
            <div className="rounded-xl border border-white/8 bg-zinc-900/40 py-12 text-center">
              <UserCheck className="h-8 w-8 mx-auto text-zinc-600 mb-2" />
              <p className="text-sm text-zinc-500">No verified violations yet.</p>
              <p className="text-xs text-zinc-600 mt-1">Check the box next to any violation to verify it.</p>
            </div>
          ) : (
            <div className="rounded-xl border border-white/8 overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="border-white/8 bg-zinc-900/40">
                    <TableHead className="text-xs">Type</TableHead>
                    <TableHead className="text-xs">Agent / Info</TableHead>
                    <TableHead className="text-xs">Dept</TableHead>
                    <TableHead className="text-xs w-28">Date</TableHead>
                    <TableHead className="text-xs text-right">Verified By</TableHead>
                    <TableHead className="w-8" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {verifiedData.items.map((it, i) => {
                    let detail = "";
                    try {
                      const d = JSON.parse(it.details);
                      if (it.type === "late_login")          detail = `${fmtMins((d as LateLoginRow).minutesLate)} late`;
                      if (it.type === "availability_gap")    detail = `${(d as AvailGapRow).gapCount} gaps`;
                      if (it.type === "missed_call")         detail = `${(d as MissedCallEntry).availableAgents.length} available`;
                      if (it.type === "unauthorized_cancel") { const cd = d as CancelViolation; detail = cd.fileId ? `File ${cd.fileId}` : ""; }
                    } catch { /* ignore */ }
                    const typeBadge =
                      it.type === "late_login"          ? "bg-amber-500/15 text-amber-300 border-amber-500/30" :
                      it.type === "availability_gap"    ? "bg-rose-500/15 text-rose-300 border-rose-500/30" :
                      it.type === "unauthorized_cancel" ? "bg-red-500/15 text-red-300 border-red-500/30" :
                                                          "bg-orange-500/15 text-orange-300 border-orange-500/30";
                    const typeLabel =
                      it.type === "late_login"          ? "Late Login" :
                      it.type === "availability_gap"    ? "Avail Gap" :
                      it.type === "unauthorized_cancel" ? "Cancel" : "Missed Call";
                    return (
                      <TableRow key={i} className="border-white/5 hover:bg-zinc-800/20 group">
                        <TableCell className="text-xs">
                          <Badge className={`text-[10px] px-1.5 py-0 border ${typeBadge}`}>{typeLabel}</Badge>
                          {detail && <span className="ml-1.5 text-zinc-500 text-[10px]">{detail}</span>}
                        </TableCell>
                        <TableCell className="text-xs font-medium text-white">{it.member}</TableCell>
                        <TableCell className="text-xs"><Badge className={`text-[10px] px-1.5 py-0 border ${deptBadge(it.department)}`}>{it.department}</Badge></TableCell>
                        <TableCell className="text-xs text-zinc-400 tabular-nums">{fmtDate(it.date)}</TableCell>
                        <TableCell className="text-xs text-right text-zinc-500">{it.verifiedBy}</TableCell>
                        <TableCell className="pr-3">
                          <button
                            onClick={() => void toggleVerify(it.key, it.type, it.member, it.department, it.date, {})}
                            disabled={pending.has(it.key)}
                            title="Remove flag"
                            className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded text-zinc-600 hover:text-red-400 hover:bg-red-500/10 disabled:cursor-wait"
                          >
                            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current"><path d="M6.5 1h3a.5.5 0 0 1 .5.5v1H6v-1a.5.5 0 0 1 .5-.5M11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3A1.5 1.5 0 0 0 5 1.5v1H1.5a.5.5 0 0 0 0 1h.538l.853 10.66A2 2 0 0 0 4.885 16h6.23a2 2 0 0 0 1.994-1.84l.853-10.66h.538a.5.5 0 0 0 0-1zm1.958 1-.846 10.58a1 1 0 0 1-.997.92h-6.23a1 1 0 0 1-.997-.92L3.042 3.5zm-7.487 1a.5.5 0 0 1 .528.47l.5 8.5a.5.5 0 0 1-1 .06L5 5.03a.5.5 0 0 1 .47-.53Zm5.058 0a.5.5 0 0 1 .47.53l-.5 8.5a.5.5 0 1 1-1-.06l.5-8.5a.5.5 0 0 1 .53-.47M8 4.5a.5.5 0 0 1 .5.5v8.5a.5.5 0 0 1-1 0V5a.5.5 0 0 1 .5-.5"/></svg>
                          </button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type DashView = "metrics" | "attendance" | "phones";

function Dashboard() {
  const { user, logout, can, canSeeTab } = useUser();
  const [showUsers, setShowUsers] = useState(false);
  const [showBlocked, setShowBlocked] = useState(false);
  const [showAgents, setShowAgents] = useState(false);
  const defaultView: DashView = can("view_metrics") ? "metrics" : "attendance";
  const [view, setView] = useState<DashView>(defaultView);

  const ta = user.teamAccess ?? null;
  const metricsTabs = ALL_TABS.filter((t) => canSeeTab(t.value));
  const defaultTab = ta ?? "retention";

  const roleBadgeCls =
    user.role === "admin" ? "bg-fuchsia-500/20 text-fuchsia-300 border-fuchsia-500/30" :
    user.role === "edit"  ? "bg-amber-500/20 text-amber-300 border-amber-500/30" :
                            "bg-zinc-500/20 text-zinc-300 border-zinc-500/30";
  const RoleIcon = user.role === "admin" ? ShieldCheck : user.role === "edit" ? Pencil : Eye;

  return (
    <div className="min-h-screen bg-background relative overflow-hidden">
      {showUsers && <UserManagementPanel onClose={() => setShowUsers(false)} />}
      {showBlocked && <BlockedNumbersPanel onClose={() => setShowBlocked(false)} />}
      {showAgents && <AgentRosterPanel onClose={() => setShowAgents(false)} />}

      <div className="pointer-events-none absolute inset-0 -z-0">
        <div className="absolute -top-32 -left-32 h-[500px] w-[500px] rounded-full bg-violet-600/20 blur-[120px]" />
        <div className="absolute top-20 right-0 h-[400px] w-[400px] rounded-full bg-sky-500/15 blur-[120px]" />
        <div className="absolute bottom-0 left-1/3 h-[400px] w-[400px] rounded-full bg-fuchsia-500/10 blur-[120px]" />
      </div>

      <header className="relative border-b border-white/5 bg-card/60 backdrop-blur-xl">
        <div className="max-w-[1400px] mx-auto px-3 py-3 sm:px-6 sm:py-4 flex items-center gap-3">
          <div className="h-9 w-9 sm:h-10 sm:w-10 shrink-0 rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white flex items-center justify-center shadow-[0_0_24px_-6px_rgba(168,85,247,0.7)]">
            <Rocket className="h-4 w-4 sm:h-5 sm:w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-base sm:text-xl font-bold tracking-tight bg-gradient-to-r from-violet-300 via-fuchsia-300 to-sky-300 bg-clip-text text-transparent truncate">
              Backend Tracker
            </h1>
            <p className="text-xs text-muted-foreground hidden sm:block">Retention, NSF &amp; CS team metrics at a glance</p>
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
                {can("view_metrics") && user.role === "admin" && <option value="phones">📞 Phones</option>}
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
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button onClick={() => setShowBlocked(true)} className="p-2 rounded-lg text-zinc-400 hover:text-rose-300 hover:bg-rose-500/10 transition-colors">
                      <ShieldCheck className="h-4 w-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Blocked numbers</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button onClick={() => setShowAgents(true)} className="p-2 rounded-lg text-zinc-400 hover:text-violet-300 hover:bg-violet-500/10 transition-colors">
                      <Users className="h-4 w-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Manage agents</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button onClick={() => setShowUsers(true)} className="p-2 rounded-lg text-zinc-400 hover:text-fuchsia-300 hover:bg-fuchsia-500/10 transition-colors">
                      <UserCog className="h-4 w-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Manage users</TooltipContent>
                </Tooltip>
              </>
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

      <main className="max-w-[1400px] mx-auto px-3 py-4 sm:px-6 sm:py-8">
        {view === "phones" && user.role === "admin" ? (
          <PhonesPanel />
        ) : view === "metrics" && can("view_metrics") ? (
          <Tabs defaultValue={metricsTabs[0]?.value ?? defaultTab} className="space-y-6">
            <div className="overflow-x-auto pb-1 -mx-1 px-1">
              <TabsList className="flex w-max sm:w-full sm:max-w-3xl">
                {metricsTabs.map((t) => (
                  <TabsTrigger key={t.value} value={t.value} data-testid={`tab-${t.value}`} className="whitespace-nowrap px-3 sm:px-4">{t.label}</TabsTrigger>
                ))}
              </TabsList>
            </div>
            {canSeeTab("retention") && (
              <TabsContent value="retention">
                <RetentionPanel />
              </TabsContent>
            )}
            {canSeeTab("cs") && (
              <TabsContent value="cs">
                <CSPanel />
              </TabsContent>
            )}
            {canSeeTab("nsf") && (
              <TabsContent value="nsf">
                <TeamPanel urls={NSF} sheetKey="nsf" label="NSF Team" mode="nsf" statusQueryFn={fetchNSFCombinedSheet} />
              </TabsContent>
            )}
            {canSeeTab("missed-no-cb") && (
              <TabsContent value="missed-no-cb">
                <MissedNoCBPanel lockedTeam={ta} />
              </TabsContent>
            )}
            {canSeeTab("callback-review") && (
              <TabsContent value="callback-review">
                <CallbackReviewPanel />
              </TabsContent>
            )}
            {canSeeTab("violations") && (
              <TabsContent value="violations">
                <ViolationsPanel />
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
      <SamiaChat />
    </div>
  );
}


// ─── Samia AI Chat ─────────────────────────────────────────────────────────────

interface SamiaMessage { role: "user" | "assistant"; content: string; images?: string[] }

type ChatSize = "normal" | "minimized" | "maximized";

function SamiaChat() {
  const [open, setOpen] = useState(false);
  const [size, setSize] = useState<ChatSize>("normal");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<SamiaMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  // Name gate
  const [chatName, setChatName] = useState<string>(() => localStorage.getItem("samia_display_name") ?? "");
  const [nameInput, setNameInput] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  // Admin "All chats" state
  const [adminView, setAdminView] = useState<"chat" | "users" | "viewUser">("chat");
  const [adminUsers, setAdminUsers] = useState<{ userId: number; username: string }[]>([]);
  const [adminViewUser, setAdminViewUser] = useState<{ userId: number; username: string } | null>(null);
  const [adminMessages, setAdminMessages] = useState<SamiaMessage[]>([]);
  const [adminLoading, setAdminLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { token, user } = useUser();
  const isAdmin = user.role === "admin";

  function submitName() {
    const n = nameInput.trim();
    if (!n) return;
    localStorage.setItem("samia_display_name", n);
    setChatName(n);
  }

  useEffect(() => {
    if (open) {
      setTimeout(() => {
        if (!chatName) { nameRef.current?.focus(); return; }
        inputRef.current?.focus();
      }, 80);
      if (!historyLoaded) {
        setHistoryLoading(true);
        fetch("/api/samia/history", { headers: { Authorization: `Bearer ${token}` } })
          .then((r) => r.ok ? r.json() : [])
          .then((rows: Array<{ role: string; content: string; images?: string[] | null }>) => {
            if (rows.length > 0) {
              setMessages(rows.map((r) => ({ role: r.role as "user" | "assistant", content: r.content, images: r.images ?? undefined })));
            } else {
              const hr = new Date().getHours();
              const timeGreet = hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening";
              setMessages([{ role: "assistant", content: `${timeGreet}. I'm Samia — I know every number in this dashboard cold. What do you need?` }]);
            }
          })
          .catch(() => {
            const hr = new Date().getHours();
            const timeGreet = hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening";
            setMessages([{ role: "assistant", content: `${timeGreet}. I'm Samia — I know every number in this dashboard cold. What do you need?` }]);
          })
          .finally(() => { setHistoryLoading(false); setHistoryLoaded(true); });
      }
    }
  }, [open]);

  function openAdminUsers() {
    setAdminView("users");
    setAdminLoading(true);
    fetch("/api/samia/users", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.ok ? r.json() : [])
      .then((rows: { userId: number; username: string }[]) => setAdminUsers(rows))
      .catch(() => setAdminUsers([]))
      .finally(() => setAdminLoading(false));
  }

  function viewUserChat(u: { userId: number; username: string }) {
    setAdminViewUser(u);
    setAdminView("viewUser");
    setAdminLoading(true);
    fetch(`/api/samia/history/${u.userId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.ok ? r.json() : [])
      .then((rows: Array<{ role: string; content: string; images?: string[] | null }>) =>
        setAdminMessages(rows.map((r) => ({ role: r.role as "user" | "assistant", content: r.content, images: r.images ?? undefined })))
      )
      .catch(() => setAdminMessages([]))
      .finally(() => setAdminLoading(false));
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  function readFileAsDataURL(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function addImages(files: FileList | File[]) {
    const arr = Array.from(files).filter((f) => f.type.startsWith("image/")).slice(0, 4);
    const urls = await Promise.all(arr.map(readFileAsDataURL));
    setPendingImages((prev) => [...prev, ...urls].slice(0, 4));
  }

  function handlePaste(e: React.ClipboardEvent) {
    const items = Array.from(e.clipboardData.items).filter((i) => i.type.startsWith("image/"));
    if (items.length === 0) return;
    e.preventDefault();
    const files = items.map((i) => i.getAsFile()).filter(Boolean) as File[];
    void addImages(files);
  }

  async function send() {
    const text = input.trim();
    if ((!text && pendingImages.length === 0) || loading) return;
    const images = [...pendingImages];
    setInput("");
    setPendingImages([]);
    setMessages((prev) => [...prev, { role: "user", content: text, images: images.length ? images : undefined }]);
    setLoading(true);
    try {
      const res = await fetch("/api/samia/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ message: text || "What do you see in this image?", images, displayName: chatName || undefined }),
      });
      const data = (await res.json()) as { reply?: string; error?: string };
      setMessages((prev) => [...prev, { role: "assistant", content: data.reply ?? "Sorry, something went wrong." }]);
    } catch {
      setMessages((prev) => [...prev, { role: "assistant", content: "Network error — try again." }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {/* Floating bubble */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="fixed bottom-6 right-6 z-50 h-14 w-14 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white shadow-[0_0_32px_-4px_rgba(168,85,247,0.7)] flex items-center justify-center hover:scale-105 transition-transform"
        aria-label="Open Samia"
      >
        {open ? <X className="h-5 w-5" /> : <Sparkles className="h-5 w-5" />}
      </button>

      {/* Chat panel */}
      {open && (
        <div className={`fixed z-50 flex flex-col rounded-2xl border border-white/10 bg-zinc-900/95 backdrop-blur-xl shadow-2xl overflow-hidden transition-all duration-200 ${
          size === "maximized"
            ? "bottom-4 right-4 left-4 top-4 w-auto max-h-none"
            : size === "minimized"
            ? "bottom-24 right-4 sm:right-6 w-[calc(100vw-32px)] sm:w-[360px] max-h-none"
            : "bottom-24 right-4 sm:right-6 w-[calc(100vw-32px)] sm:w-[360px] max-h-[560px]"
        }`}>
          {/* Header */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-white/8 bg-gradient-to-r from-violet-600/20 to-fuchsia-600/20 flex-shrink-0">
            {(adminView === "users" || adminView === "viewUser") ? (
              <button onClick={() => adminView === "viewUser" ? setAdminView("users") : setAdminView("chat")} className="text-zinc-400 hover:text-white transition-colors p-1 -ml-1">
                <ChevronLeft className="h-4 w-4" />
              </button>
            ) : (
              <div className="h-9 w-9 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center text-white font-bold text-sm shadow-md flex-shrink-0">S</div>
            )}
            <div>
              <p className="text-sm font-semibold text-white leading-none">
                {adminView === "users" ? "All Chats" : adminView === "viewUser" ? adminViewUser?.username ?? "User" : "Samia"}
              </p>
              <p className="text-[10px] text-violet-300 mt-0.5 flex items-center gap-1">
                {adminView === "chat" && <><span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />AI Analyst · Live data</>}
                {adminView === "users" && "Select a user to view their chat"}
                {adminView === "viewUser" && "Read-only · Admin view"}
              </p>
            </div>
            <div className="ml-auto flex items-center gap-1">
              {/* Admin all-chats button */}
              {isAdmin && adminView === "chat" && (
                <button onClick={openAdminUsers} title="View all user chats" className="text-zinc-500 hover:text-violet-300 transition-colors p-1">
                  <Users className="h-4 w-4" />
                </button>
              )}
              {/* Minimize */}
              <button
                onClick={() => setSize((s) => s === "minimized" ? "normal" : "minimized")}
                title={size === "minimized" ? "Restore" : "Minimize"}
                className="text-zinc-500 hover:text-white transition-colors p-1"
              >
                <ChevronDown className={`h-4 w-4 transition-transform duration-200 ${size === "minimized" ? "rotate-180" : ""}`} />
              </button>
              {/* Maximize */}
              <button
                onClick={() => setSize((s) => s === "maximized" ? "normal" : "maximized")}
                title={size === "maximized" ? "Restore" : "Maximize"}
                className="text-zinc-500 hover:text-white transition-colors p-1"
              >
                {size === "maximized" ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </button>
              {/* Close */}
              <button onClick={() => { setOpen(false); setSize("normal"); setAdminView("chat"); }} className="text-zinc-500 hover:text-white transition-colors p-1">
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Name gate — shown if user hasn't set their display name yet */}
          {!chatName ? (
            <div className="flex-1 flex flex-col items-center justify-center px-6 py-8 gap-5">
              <div className="h-14 w-14 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center text-white font-bold text-xl shadow-lg">S</div>
              <div className="text-center">
                <p className="text-sm font-semibold text-white mb-1">Hey, before we start —</p>
                <p className="text-xs text-zinc-400">What's your name? Samia will use it to remember you.</p>
              </div>
              <div className="w-full flex gap-2">
                <input
                  ref={nameRef}
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") submitName(); }}
                  placeholder="Your first name…"
                  className="flex-1 text-sm rounded-xl bg-zinc-800 border border-white/10 px-3 py-2.5 text-white placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
                />
                <button
                  onClick={submitName}
                  disabled={!nameInput.trim()}
                  className="px-4 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white text-sm font-medium disabled:opacity-40 hover:opacity-90 transition-opacity"
                >
                  Go
                </button>
              </div>
            </div>
          ) : adminView === "users" ? (
            <div className="flex-1 overflow-y-auto px-3 py-3 space-y-1 min-h-0">
              {adminLoading && (
                <div className="flex items-center justify-center gap-2 text-muted-foreground text-xs py-6">
                  <div className="h-3 w-3 rounded-full border-2 border-violet-400 border-t-transparent animate-spin" />
                  Loading…
                </div>
              )}
              {!adminLoading && adminUsers.length === 0 && (
                <p className="text-center text-xs text-zinc-500 py-6">No chat history yet.</p>
              )}
              {adminUsers.map((u) => (
                <button
                  key={u.userId}
                  onClick={() => viewUserChat(u)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-white/5 transition-colors text-left"
                >
                  <div className="h-8 w-8 rounded-full bg-zinc-700 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                    {u.username.slice(0, 1).toUpperCase()}
                  </div>
                  <span className="text-sm text-white">{u.username}</span>
                  <ChevronRight className="h-4 w-4 text-zinc-600 ml-auto" />
                </button>
              ))}
            </div>
          ) : adminView === "viewUser" ? (
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0">
              {adminLoading && (
                <div className="flex items-center justify-center gap-2 text-muted-foreground text-xs py-4">
                  <div className="h-3 w-3 rounded-full border-2 border-violet-400 border-t-transparent animate-spin" />
                  Loading…
                </div>
              )}
              {!adminLoading && adminMessages.length === 0 && (
                <p className="text-center text-xs text-zinc-500 py-6">No messages yet.</p>
              )}
              {adminMessages.map((m, i) => (
                <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                  {m.role === "assistant" && (
                    <div className="h-6 w-6 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center text-white text-[10px] font-bold mr-2 mt-0.5 flex-shrink-0">S</div>
                  )}
                  <div className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap ${
                    m.role === "user" ? "bg-violet-600/70 text-white rounded-br-sm" : "bg-zinc-800 text-zinc-100 rounded-bl-sm"
                  }`}>{m.content}</div>
                </div>
              ))}
            </div>
          ) : (
            <>
              {/* Normal chat messages */}
              <div className={`flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0 ${size === "minimized" ? "hidden" : ""}`}>
                {historyLoading && (
                  <div className="flex items-center justify-center gap-2 text-muted-foreground text-xs py-4">
                    <div className="h-3 w-3 rounded-full border-2 border-violet-400 border-t-transparent animate-spin" />
                    Loading memory…
                  </div>
                )}
                {messages.map((m, i) => (
                  <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                    {m.role === "assistant" && (
                      <div className="h-6 w-6 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center text-white text-[10px] font-bold mr-2 mt-0.5 flex-shrink-0">S</div>
                    )}
                    <div className={`max-w-[80%] flex flex-col gap-1.5 ${m.role === "user" ? "items-end" : "items-start"}`}>
                      {m.images?.map((src, idx) => (
                        <img key={idx} src={src} alt="attachment" className="max-w-[220px] rounded-xl border border-white/10 object-cover" />
                      ))}
                      {m.content && (
                        <div className={`rounded-2xl px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap ${
                          m.role === "user" ? "bg-violet-600 text-white rounded-br-sm" : "bg-zinc-800 text-zinc-100 rounded-bl-sm"
                        }`}>{m.content}</div>
                      )}
                    </div>
                  </div>
                ))}
                {loading && (
                  <div className="flex justify-start">
                    <div className="h-6 w-6 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center text-white text-[10px] font-bold mr-2 mt-0.5 flex-shrink-0">S</div>
                    <div className="bg-zinc-800 rounded-2xl rounded-bl-sm px-3 py-2">
                      <div className="flex gap-1 items-center h-4">
                        <span className="h-1.5 w-1.5 rounded-full bg-zinc-400 animate-bounce [animation-delay:0ms]" />
                        <span className="h-1.5 w-1.5 rounded-full bg-zinc-400 animate-bounce [animation-delay:150ms]" />
                        <span className="h-1.5 w-1.5 rounded-full bg-zinc-400 animate-bounce [animation-delay:300ms]" />
                      </div>
                    </div>
                  </div>
                )}
                <div ref={bottomRef} />
              </div>

              {/* Input bar */}
              <div className={`px-3 pb-3 pt-2 border-t border-white/8 flex flex-col gap-2 ${size === "minimized" ? "hidden" : ""}`}>
                {pendingImages.length > 0 && (
                  <div className="flex gap-2 flex-wrap">
                    {pendingImages.map((src, idx) => (
                      <div key={idx} className="relative group">
                        <img src={src} alt="pending" className="h-16 w-16 rounded-lg object-cover border border-white/10" />
                        <button
                          onClick={() => setPendingImages((p) => p.filter((_, i) => i !== idx))}
                          className="absolute -top-1 -right-1 h-4 w-4 rounded-full bg-zinc-700 border border-white/20 text-zinc-300 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex gap-2 items-center">
                  <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden"
                    onChange={(e) => { if (e.target.files) { void addImages(e.target.files); e.target.value = ""; } }} />
                  <button onClick={() => fileInputRef.current?.click()} disabled={loading} title="Attach image"
                    className="h-9 w-9 rounded-xl bg-zinc-800 border border-white/10 text-zinc-400 hover:text-violet-400 flex items-center justify-center transition-colors disabled:opacity-40 flex-shrink-0">
                    <Paperclip className="h-4 w-4" />
                  </button>
                  <input ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
                    onPaste={handlePaste} placeholder="Ask Samia anything… or paste a screenshot" disabled={loading}
                    className="flex-1 text-sm rounded-xl bg-zinc-800 border border-white/10 px-3 py-2 text-white placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-violet-500 disabled:opacity-50" />
                  <button onClick={() => void send()} disabled={(!input.trim() && pendingImages.length === 0) || loading}
                    className="h-9 w-9 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white flex items-center justify-center disabled:opacity-40 hover:opacity-90 transition-opacity flex-shrink-0">
                    <Send className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

// ─── Attendance ────────────────────────────────────────────────────────────────

interface AttMember { id: number; name: string; shift: string; shiftHours: string; department: string; active: boolean; }

// Convert an Egypt-local shift hour (e.g. 4 → "4 PM") to a friendly label.
// All shifts are afternoon/evening so values 1–11 are always PM.
function shiftLabel(shift: string): string {
  const n = parseInt(shift);
  if (!n) return shift;
  const h12 = n % 12 === 0 ? 12 : n % 12;
  const ampm = n >= 12 ? "AM" : "PM";
  return `${h12} ${ampm}`;
}
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
  const [newShiftHours, setNewShiftHours] = useState("8");
  const [newDept, setNewDept] = useState("");
  const [importing, setImporting] = useState(false);
  const [autoMarking, setAutoMarking] = useState(false);
  const [autoMarkResult, setAutoMarkResult] = useState<string | null>(null);
  const [editingMember, setEditingMember] = useState<AttMember | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  const monthStart = new Date(today.getFullYear(), today.getMonth() + monthOff, 1);
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + monthOff + 1, 0);
  const fromStr = monthStart.toISOString().slice(0, 10);
  const toStr = monthEnd.toISOString().slice(0, 10);
  const monthLabel = monthStart.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const dateCols = useMemo(() => {
    const cols: string[] = [];
    const d = new Date(monthStart);
    while (d <= monthEnd) {
      cols.push(d.toISOString().slice(0, 10));
      d.setDate(d.getDate() + 1);
    }
    return cols;
  }, [monthOff]);

  const qc = useQueryClient();
  const { data, isLoading } = useQuery<AttData>({
    queryKey: ["attendance", fromStr, toStr, showInactive],
    queryFn: async () => {
      const params = new URLSearchParams({ from: fromStr, to: toStr });
      if (showInactive) params.set("includeInactive", "true");
      const r = await fetch(`/api/attendance?${params}`);
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
      .sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
        return parseFloat(a.shift || "0") - parseFloat(b.shift || "0");
      }),
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
      body: JSON.stringify({ name: newName.trim(), shift: newShift.trim(), shiftHours: newShiftHours.trim() || "8", department: newDept.trim() }),
    });
    setNewName(""); setNewShift(""); setNewShiftHours("8"); setNewDept(""); setShowAdd(false);
    qc.invalidateQueries({ queryKey: ["attendance"] });
  }

  async function saveMember() {
    if (!editingMember) return;
    await fetch(`/api/attendance/members/${editingMember.id}`, {
      method: "PATCH", headers: authHeaders(token),
      body: JSON.stringify({ name: editingMember.name, shift: editingMember.shift, shiftHours: editingMember.shiftHours, department: editingMember.department }),
    });
    setEditingMember(null);
    qc.invalidateQueries({ queryKey: ["attendance"] });
  }

  async function setMemberActive(id: number, active: boolean) {
    await fetch(`/api/attendance/members/${id}`, {
      method: "PATCH", headers: authHeaders(token),
      body: JSON.stringify({ active }),
    });
    qc.invalidateQueries({ queryKey: ["attendance"] });
  }

  async function doImport() {
    setImporting(true);
    await fetch("/api/attendance/import", { method: "POST", headers: authHeaders(token) });
    qc.invalidateQueries({ queryKey: ["attendance"] });
    setImporting(false);
  }

  async function doAutoMark() {
    setAutoMarking(true);
    setAutoMarkResult(null);
    try {
      const r = await fetch("/api/attendance/auto-mark", { method: "POST", headers: authHeaders(token) });
      const data = await r.json() as { success: boolean; results?: { name: string; status: string; note: string; skipped?: string }[] };
      if (data.success && data.results) {
        const marked = data.results.filter((x) => x.status);
        const late = marked.filter((x) => x.status === "late");
        const inTime = marked.filter((x) => x.status === "in");
        setAutoMarkResult(`Marked ${marked.length} agents: ${inTime.length} on time${late.length ? `, ${late.length} late` : ""}`);
      }
      qc.invalidateQueries({ queryKey: ["attendance"] });
    } finally {
      setAutoMarking(false);
    }
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
        <div className="flex items-center gap-2 flex-wrap">
          {canManage && (data?.members.length ?? 0) === 0 && (
            <Button size="sm" variant="outline" onClick={doImport} disabled={importing}>
              {importing ? "Importing…" : "Import from Sheets"}
            </Button>
          )}
          {canEdit && (
            <Button size="sm" variant="outline" onClick={doAutoMark} disabled={autoMarking}
              title="Check each agent's first call today vs their shift start and auto-mark late/on-time">
              {autoMarking ? "Checking…" : "Auto-mark today"}
            </Button>
          )}
          {autoMarkResult && (
            <span className="text-xs text-emerald-400">{autoMarkResult}</span>
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
              <Label className="text-xs text-muted-foreground mb-1 block">Shift start</Label>
              <Input value={newShift} onChange={(e) => setNewShift(e.target.value)} placeholder="e.g. 8 (8 AM)" className="h-8" />
            </div>
            <div className="w-20">
              <Label className="text-xs text-muted-foreground mb-1 block">Hours</Label>
              <Input value={newShiftHours} onChange={(e) => setNewShiftHours(e.target.value)} placeholder="8" className="h-8" />
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
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 sm:gap-3">
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
        <div className="flex gap-1.5 flex-wrap items-center">
          {departments.map((d) => (
            <button
              key={d}
              onClick={() => setDeptFilter(d)}
              className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${deptFilter === d ? "bg-violet-600 text-white" : "text-muted-foreground hover:text-white hover:bg-white/5"}`}
            >
              {d}
            </button>
          ))}
          {canManage && (
            <button
              onClick={() => setShowInactive((v) => !v)}
              className={`px-3 py-1 rounded-md text-sm font-medium transition-colors border ${showInactive ? "border-amber-500/50 bg-amber-500/10 text-amber-300" : "border-white/10 text-zinc-500 hover:text-zinc-300 hover:bg-white/5"}`}
            >
              {showInactive ? "Hide inactive" : "Show inactive"}
            </button>
          )}
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
                <th className="sticky left-[160px] z-20 bg-zinc-950 text-center text-xs text-muted-foreground font-medium px-1 py-2 border-b border-white/10 w-[90px]">Shift / Hrs</th>
                <th className="sticky left-[250px] z-20 bg-zinc-950 text-left text-xs text-muted-foreground font-medium px-2 py-2 border-b border-white/10 w-24">Dept</th>
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
                  <tr key={member.id} className={`${rowBg} hover:bg-white/[0.03] transition-colors ${!member.active ? "opacity-40" : ""}`}>
                    <td className={`sticky left-0 z-10 ${mi % 2 === 0 ? "bg-zinc-950" : "bg-zinc-900"} px-3 py-1.5 text-sm font-medium border-b border-white/5 whitespace-nowrap ${member.active ? "text-white" : "text-zinc-400 line-through"}`}>
                      {member.name}
                      {!member.active && <span className="ml-1.5 no-underline text-[10px] font-normal text-amber-500/70 bg-amber-500/10 px-1 rounded" style={{textDecoration:"none"}}>inactive</span>}
                    </td>
                    <td className={`sticky left-[160px] z-10 ${mi % 2 === 0 ? "bg-zinc-950" : "bg-zinc-900"} text-center text-xs text-zinc-500 px-1 border-b border-white/5`} title={`Shift ${member.shift} (LA time) · ${member.shiftHours || "8"}h shift`}>
                      <div>{shiftLabel(member.shift)}</div>
                      {member.shiftHours && member.shiftHours !== "8" && (
                        <span className="text-[9px] font-semibold text-amber-400 bg-amber-400/10 rounded px-1">{member.shiftHours}h</span>
                      )}
                    </td>
                    <td className={`sticky left-[250px] z-10 ${mi % 2 === 0 ? "bg-zinc-950" : "bg-zinc-900"} px-2 border-b border-white/5`}>
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
                          onClick={() => canEdit && openCell(member, d)}
                          title={rec?.note ? `📝 ${rec.note}` : undefined}
                          className={`text-center border-b border-white/5 w-12 h-8 transition-colors
                            ${isToday ? "bg-violet-950/40" : isTomorrow ? "bg-teal-950/30" : ""}
                            ${!canEdit ? "cursor-default opacity-20" : "cursor-pointer hover:bg-white/5"}`}
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
              <div className="flex gap-2">
                <div className="flex-1">
                  <Label className="text-xs text-muted-foreground mb-1 block">Shift start</Label>
                  <Input value={editingMember.shift} onChange={(e) => setEditingMember({ ...editingMember, shift: e.target.value })} className="h-8" placeholder="e.g. 8 (8 AM)" />
                </div>
                <div className="w-20">
                  <Label className="text-xs text-muted-foreground mb-1 block">Hours</Label>
                  <Input value={editingMember.shiftHours ?? "8"} onChange={(e) => setEditingMember({ ...editingMember, shiftHours: e.target.value })} className="h-8" placeholder="8" />
                </div>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground mb-1 block">Department</Label>
                <Input value={editingMember.department} onChange={(e) => setEditingMember({ ...editingMember, department: e.target.value })} className="h-8" placeholder="e.g. Backend" />
              </div>
            </div>
            <div className="flex gap-2 justify-between pt-1">
              {editingMember.active ? (
                <Button size="sm" variant="destructive" onClick={() => { setMemberActive(editingMember.id, false); setEditingMember(null); }}>
                  Set inactive
                </Button>
              ) : (
                <Button size="sm" className="bg-emerald-700 hover:bg-emerald-600 text-white" onClick={() => { setMemberActive(editingMember.id, true); setEditingMember(null); }}>
                  Reactivate
                </Button>
              )}
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
          <RosterProvider>
            <Dashboard />
          </RosterProvider>
        </LoginGate>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
