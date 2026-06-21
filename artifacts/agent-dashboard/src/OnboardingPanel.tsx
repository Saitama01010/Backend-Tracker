import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, Cell,
} from "recharts";
import {
  RefreshCw, Phone, PhoneIncoming, PhoneMissed, Clock, Users, CheckCircle, Loader2,
  FileSpreadsheet, Download, Sparkles, Receipt, TrendingUp, Award, Lightbulb, Trophy, Timer,
} from "lucide-react";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

// ─── Types (mirror /api/ob-analytics) ─────────────────────────────────────────
interface AnalyticsAgent {
  name: string;
  totalCalls: number;
  inbound: number;
  outbound: number;
  answered: number;
  missed: number;
  voicemail: number;
  talkSeconds: number;
  uniqueContacts: number;
  responseRate: number;
  missedRatio: number;
  avgGapMin: number;
  onboarded: number;
  connection: number;
  onboardedRate: number;
  ranked: boolean;
  overflow: boolean;
}
interface Analytics {
  meta: {
    line: string;
    from: string | null;
    to: string | null;
    generatedAt: string;
    dataFirst: string | null;
    dataLast: string | null;
    totalAgents: number;
  };
  kpis: {
    totalCalls: number;
    inbound: number;
    outbound: number;
    answered: number;
    missed: number;
    voicemail: number;
    talkSeconds: number;
    inboundReceived: number;
    inboundAnswered: number;
    inboundMissed: number;
    responseRate: number;
    missedRatio: number;
    avgTalkSec: number;
    avgGapMin: number;
  };
  agents: AnalyticsAgent[];
  hourly: { hour: number; calls: number; inbound: number; missed: number; idleMinutes: number }[];
  peaks: { mostMissedHour: number | null; mostAvailableHour: number | null; busiestHour: number | null };
  cassie: {
    found: boolean;
    name: string;
    totalCalls: number;
    inbound: number;
    answered: number;
    responseRate: number;
    missedRatio: number;
    talkSeconds: number;
    avgGapMin: number;
    uniqueContacts: number;
    onboarded: number;
    connection: number;
    onboardedRate: number;
    taxMentions: number;
    vsTeam: { responseRate: number; onboardedRate: number; avgGapMin: number };
  } | null;
  insights: string[];
}

interface ObStatus {
  running: boolean;
  totalCalls: number;
  lastRunAt: string | null;
  progressDone: number;
  progressTotal: number;
  typeCounts?: { onboarded?: number; connection?: number };
  taxYes?: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmtDur(secs: number): string {
  if (!secs) return "—";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
function hr(h: number | null): string {
  return h === null ? "—" : `${String(h).padStart(2, "0")}:00`;
}
function lastDayOfMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y!, m!, 0).getDate();
  return `${ym}-${String(d).padStart(2, "0")}`;
}

type ToneKey = "blue" | "emerald" | "sky" | "amber" | "rose" | "cyan";
const TONES: Record<ToneKey, string> = {
  blue: "from-card to-muted/50 border-border metric-info",
  emerald: "from-card to-muted/50 border-border metric-good",
  sky: "from-card to-muted/50 border-border metric-info",
  amber: "from-card to-muted/50 border-border metric-warn",
  rose: "from-card to-muted/50 border-border metric-bad",
  cyan: "from-card to-muted/50 border-border metric-info",
};

function StatPill({
  label, value, sub, icon: Icon, tone,
}: {
  label: string; value: string; sub?: string; icon: typeof Phone; tone: ToneKey;
}) {
  return (
    <div className={`rounded-xl border bg-gradient-to-br p-3.5 ${TONES[tone]}`}>
      <div className="flex items-center gap-1.5 text-xs opacity-80">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-white">{value}</div>
      {sub && <div className="text-xs opacity-70 mt-0.5">{sub}</div>}
    </div>
  );
}

// ─── Raw report card (Connection vs Onboarded) ────────────────────────────────
function OnboardingReportCard() {
  const today = laToday();
  const thisMonth = today.slice(0, 7);
  const [gran, setGran] = useState<Granularity>("all");
  const [month, setMonth] = useState(thisMonth);
  const [day, setDay] = useState(today);
  const [downloading, setDownloading] = useState(false);

  const { from, to } = useMemo(() => {
    if (gran === "month") return { from: `${month}-01`, to: lastDayOfMonth(month) };
    if (gran === "day") return { from: day, to: day };
    return { from: "", to: "" };
  }, [gran, month, day]);
  const qs = from && to ? `?from=${from}&to=${to}` : "";

  const { data: status, refetch } = useQuery<ObStatus>({
    queryKey: ["obReportStatus", from, to],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/ob-report/status${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: (q) => (q.state.data?.running ? 3000 : false),
    refetchOnWindowFocus: false,
  });

  const refreshMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${BASE}/api/ob-report/refresh`, { method: "POST" });
      if (!res.ok && res.status !== 409) throw new Error(`HTTP ${res.status}`);
      return res.json().catch(() => ({}));
    },
    onSuccess: () => setTimeout(() => refetch(), 800),
  });

  const download = async () => {
    setDownloading(true);
    try {
      const res = await fetch(`${BASE}/api/ob-report/download${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const tag = gran === "all" ? "AllTime" : gran === "month" ? month : day;
      const a = document.createElement("a");
      a.href = url;
      a.download = `Onboarding_Line_Report_${tag}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  };

  const running = status?.running ?? refreshMutation.isPending;
  const onboarded = status?.typeCounts?.onboarded ?? 0;
  const connection = status?.typeCounts?.connection ?? 0;
  const lastRun = status?.lastRunAt
    ? new Date(status.lastRunAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : null;
  const progressPct =
    running && status && status.progressTotal > 0
      ? Math.round((status.progressDone / status.progressTotal) * 100)
      : 0;
  const rangeLabel =
    gran === "all"
      ? "All time"
      : gran === "month"
        ? new Date(`${month}-01`).toLocaleDateString([], { month: "long", year: "numeric" })
        : new Date(`${day}T00:00`).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });

  return (
    <div className="rounded-xl border border-border bg-card backdrop-blur p-5 space-y-4">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5 metric-info" />
            Onboarding Line Report
          </h2>
          <div className="flex items-center gap-2 text-sm text-muted-foreground flex-wrap">
            <span>(949) 315-7441 · {rangeLabel} · Connection vs Onboarded + tax mentions</span>
            <span className="flex items-center gap-1 metric-info">
              <Sparkles className="h-3 w-3" />
              AI-classified from call transcripts
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="inline-flex rounded-lg border border-white/10 overflow-hidden">
            {(["all", "month", "day"] as Granularity[]).map((g) => (
              <button
                key={g}
                onClick={() => setGran(g)}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${gran === g ? "bg-primary text-primary-foreground" : "bg-transparent text-muted-foreground hover:bg-white/5"}`}
              >
                {g === "all" ? "All Time" : g === "month" ? "Monthly" : "Per Day"}
              </button>
            ))}
          </div>
          {gran === "month" && (
            <input type="month" value={month} max={thisMonth} onChange={(e) => setMonth(e.target.value)}
              className="rounded-md border border-white/10 bg-background px-2 py-1.5 text-xs" />
          )}
          {gran === "day" && (
            <input type="date" value={day} max={today} onChange={(e) => setDay(e.target.value)}
              className="rounded-md border border-white/10 bg-background px-2 py-1.5 text-xs" />
          )}
          <Button size="sm" variant="outline" onClick={() => refreshMutation.mutate()} disabled={running}>
            {running
              ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" />Refreshing…</>
              : <><RefreshCw className="h-4 w-4 mr-1" />Refresh</>}
          </Button>
          <Button size="sm" onClick={download} disabled={downloading || !status || status.totalCalls === 0}>
            {downloading
              ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" />Preparing…</>
              : <><Download className="h-4 w-4 mr-1" />Download Excel</>}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatPill label="Total Calls" value={status?.totalCalls?.toLocaleString() ?? "—"} icon={Phone} tone="blue" />
        <StatPill label="Onboarded" value={onboarded.toLocaleString()} icon={CheckCircle} tone="emerald" />
        <StatPill label="Connection" value={connection.toLocaleString()} icon={PhoneIncoming} tone="sky" />
        <StatPill label="Mention Tax" value={(status?.taxYes ?? 0).toLocaleString()} icon={Receipt} tone="amber" />
      </div>

      {running && status && status.progressTotal > 0 && (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Classifying new transcripts…</span>
            <span className="tabular-nums">{status.progressDone}/{status.progressTotal} ({progressPct}%)</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
            <div className="h-full bg-primary transition-all" style={{ width: `${progressPct}%` }} />
          </div>
        </div>
      )}
      {lastRun && !running && (
        <div className="text-xs metric-good flex items-center gap-1">
          <CheckCircle className="h-3 w-3" />
          Last refreshed {lastRun}
        </div>
      )}
    </div>
  );
}

// ─── Analytics ────────────────────────────────────────────────────────────────
type Granularity = "all" | "month" | "day";

// Today's calendar date in America/Los_Angeles (the timezone the backend uses to
// bucket calls). Using UTC here would push the default day/month forward near
// midnight LA time and could request an empty future range.
function laToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function OnboardingPanel() {
  const today = laToday();
  const thisMonth = today.slice(0, 7);
  const [gran, setGran] = useState<Granularity>("all");
  const [month, setMonth] = useState(thisMonth);
  const [day, setDay] = useState(today);
  const [downloading, setDownloading] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<AnalyticsAgent | null>(null);

  const { from, to } = useMemo(() => {
    if (gran === "month") return { from: `${month}-01`, to: lastDayOfMonth(month) };
    if (gran === "day") return { from: day, to: day };
    return { from: "", to: "" };
  }, [gran, month, day]);

  const qs = from && to ? `?from=${from}&to=${to}` : "";

  const { data, isLoading, isError, refetch, isFetching } = useQuery<Analytics>({
    queryKey: ["obAnalytics", from, to],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/ob-analytics${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchOnWindowFocus: false,
  });

  const downloadExcel = async () => {
    setDownloading(true);
    try {
      const res = await fetch(`${BASE}/api/ob-analytics/download${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      const tag = gran === "all" ? "AllTime" : gran === "month" ? month : day;
      a.href = url;
      a.download = `Onboarding_Team_Analysis_${tag}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  };

  const k = data?.kpis;
  const rangeLabel =
    gran === "all" ? "All time" : gran === "month" ? new Date(`${month}-01`).toLocaleDateString([], { month: "long", year: "numeric" }) : new Date(`${day}T00:00`).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });

  return (
    <div className="space-y-6">
      <OnboardingReportCard />

      {/* Controls */}
      <div className="rounded-xl border border-border bg-card backdrop-blur p-5 space-y-4">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <TrendingUp className="h-5 w-5 metric-info" />
              Onboarding Team Analytics
            </h2>
            <p className="text-sm text-muted-foreground">
              {data?.meta.line ?? "(949) 315-7441"} · {rangeLabel} · {data?.meta.totalAgents ?? 0} agents
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="inline-flex rounded-lg border border-white/10 overflow-hidden">
              {(["all", "month", "day"] as Granularity[]).map((g) => (
                <button
                  key={g}
                  onClick={() => setGran(g)}
                  className={`px-3 py-1.5 text-xs font-medium transition-colors ${gran === g ? "bg-primary text-primary-foreground" : "bg-transparent text-muted-foreground hover:bg-white/5"}`}
                >
                  {g === "all" ? "All Time" : g === "month" ? "Monthly" : "Per Day"}
                </button>
              ))}
            </div>
            {gran === "month" && (
              <input type="month" value={month} max={thisMonth} onChange={(e) => setMonth(e.target.value)}
                className="rounded-md border border-white/10 bg-background px-2 py-1.5 text-xs" />
            )}
            {gran === "day" && (
              <input type="date" value={day} max={today} onChange={(e) => setDay(e.target.value)}
                className="rounded-md border border-white/10 bg-background px-2 py-1.5 text-xs" />
            )}
            <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={`h-4 w-4 mr-1 ${isFetching ? "animate-spin" : ""}`} />Refresh
            </Button>
            <Button size="sm" onClick={downloadExcel} disabled={downloading || !data || data.kpis.totalCalls === 0}>
              {downloading
                ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" />Preparing…</>
                : <><Download className="h-4 w-4 mr-1" />Download Analysis</>}
            </Button>
          </div>
        </div>

        {isLoading ? (
          <div className="py-16 flex items-center justify-center text-muted-foreground gap-2">
            <Loader2 className="h-5 w-5 animate-spin" /> Crunching the numbers…
          </div>
        ) : isError ? (
          <div className="py-16 text-center metric-bad text-sm">Failed to load analytics.</div>
        ) : !data || data.kpis.totalCalls === 0 ? (
          <div className="py-16 text-center text-muted-foreground text-sm">No onboarding calls in this range.</div>
        ) : (
          <>
            {/* KPIs */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              <StatPill label="Total Calls" value={k!.totalCalls.toLocaleString()} sub={`${k!.inbound} in · ${k!.outbound} out`} icon={Phone} tone="blue" />
              <StatPill label="Response Rate" value={`${k!.responseRate}%`} sub={`${k!.inboundAnswered}/${k!.inboundReceived} inbound`} icon={PhoneIncoming} tone="emerald" />
              <StatPill label="Missed Ratio" value={`${k!.missedRatio}%`} sub={`${k!.inboundMissed} missed`} icon={PhoneMissed} tone="rose" />
              <StatPill label="Talk Time" value={fmtDur(k!.talkSeconds)} sub={`avg ${fmtDur(k!.avgTalkSec)}/call`} icon={Clock} tone="sky" />
              <StatPill label="Avg Gap" value={`${k!.avgGapMin}m`} sub="between calls" icon={Timer} tone="amber" />
              <StatPill label="Peak Avail." value={hr(data.peaks.mostAvailableHour)} sub="most free hour" icon={Users} tone="cyan" />
            </div>

            {/* Charts */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="rounded-xl border border-white/10 bg-black/20 p-4">
                <h3 className="text-sm font-medium flex items-center gap-1.5 mb-3">
                  <PhoneMissed className="h-4 w-4 metric-bad" /> Missed Calls by Hour of Day
                </h3>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={data.hourly} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#ffffff12" vertical={false} />
                    <XAxis dataKey="hour" tickFormatter={(h) => String(h).padStart(2, "0")} tick={{ fontSize: 10, fill: "#a1a1aa" }} interval={1} />
                    <YAxis tick={{ fontSize: 10, fill: "#a1a1aa" }} allowDecimals={false} />
                    <RTooltip
                      contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", borderRadius: 8, fontSize: 12 }}
                      labelFormatter={(h) => `${hr(Number(h))}`}
                      formatter={(v: number, n) => [v, n === "missed" ? "Missed" : n]}
                    />
                    <Bar dataKey="missed" radius={[3, 3, 0, 0]}>
                      {data.hourly.map((h) => (
                        <Cell key={h.hour} fill={data.peaks.mostMissedHour === h.hour ? "#fb7185" : "#9f1239"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="rounded-xl border border-white/10 bg-black/20 p-4">
                <h3 className="text-sm font-medium flex items-center gap-1.5 mb-3">
                  <Timer className="h-4 w-4 metric-info" /> Availability by Hour (avg idle min between calls)
                </h3>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={data.hourly} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#ffffff12" vertical={false} />
                    <XAxis dataKey="hour" tickFormatter={(h) => String(h).padStart(2, "0")} tick={{ fontSize: 10, fill: "#a1a1aa" }} interval={1} />
                    <YAxis tick={{ fontSize: 10, fill: "#a1a1aa" }} allowDecimals={false} />
                    <RTooltip
                      contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", borderRadius: 8, fontSize: 12 }}
                      labelFormatter={(h) => `${hr(Number(h))}`}
                      formatter={(v: number) => [`${v} min`, "Idle"]}
                    />
                    <Bar dataKey="idleMinutes" radius={[3, 3, 0, 0]}>
                      {data.hourly.map((h) => (
                        <Cell key={h.hour} fill={data.peaks.mostAvailableHour === h.hour ? "#22d3ee" : "#155e75"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Insights */}
            <div className="rounded-xl border border-border bg-muted/30 p-4">
              <h3 className="text-sm font-medium flex items-center gap-1.5 mb-2 metric-warn">
                <Lightbulb className="h-4 w-4" /> Recommendations & What Can Be Improved
              </h3>
              <ul className="space-y-1.5 text-sm text-muted-foreground">
                {data.insights.map((ins, i) => (
                  <li key={i} className="flex gap-2"><span className="metric-warn">•</span><span>{ins}</span></li>
                ))}
              </ul>
            </div>

            {/* Cassie spotlight */}
            {data.cassie && (
              <CassieSpotlight c={data.cassie} />
            )}

            {/* Agent ranking */}
            <div className="rounded-xl border border-white/10 bg-black/20 overflow-hidden">
              <h3 className="text-sm font-medium flex items-center gap-1.5 p-4 pb-2">
                <Award className="h-4 w-4 metric-info" /> Agent Ranking — most responsive & productive (best → worst)
              </h3>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-12">#</TableHead>
                      <TableHead>Agent Name-Alias Name</TableHead>
                      <TableHead className="text-right">Calls</TableHead>
                      <TableHead className="text-right">Inbound</TableHead>
                      <TableHead className="text-right">Answered</TableHead>
                      <TableHead className="text-right">Response</TableHead>
                      <TableHead className="text-right">Missed %</TableHead>
                      <TableHead className="text-right">Avg Gap</TableHead>
                      <TableHead className="text-right">Talk</TableHead>
                      <TableHead className="text-right">Onboarded %</TableHead>
                      <TableHead className="text-center">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(() => {
                      let rank = 0;
                      return data.agents.map((a) => {
                        if (a.ranked) rank++;
                        const rrColor = a.responseRate >= 85 ? "metric-good" : a.responseRate >= 70 ? "metric-warn" : "metric-bad";
                        return (
                          <TableRow key={a.name} className={a.ranked ? "" : "opacity-50"}>
                            <TableCell className="tabular-nums">{a.ranked ? rank : "—"}</TableCell>
                            <TableCell className="font-medium whitespace-nowrap">
                              {a.name}
                              {a.overflow && (
                                <span className="ml-2 text-[10px] uppercase tracking-wide metric-bad/80 font-normal">
                                  unanswered overflow
                                </span>
                              )}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">{a.totalCalls}</TableCell>
                            <TableCell className="text-right tabular-nums">{a.inbound}</TableCell>
                            <TableCell className="text-right tabular-nums">{a.answered}</TableCell>
                            <TableCell className={`text-right tabular-nums font-semibold ${rrColor}`}>{a.responseRate}%</TableCell>
                            <TableCell className="text-right tabular-nums">{a.missedRatio}%</TableCell>
                            <TableCell className="text-right tabular-nums">{a.avgGapMin}m</TableCell>
                            <TableCell className="text-right tabular-nums">{fmtDur(a.talkSeconds)}</TableCell>
                            <TableCell className="text-right tabular-nums">{a.onboardedRate}%</TableCell>
                            <TableCell className="text-center">
                              <Button size="sm" variant="outline" className="h-8" onClick={() => setSelectedAgent(a)}>
                                View Details
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      });
                    })()}
                  </TableBody>
                </Table>
              </div>
              <p className="text-xs text-muted-foreground p-3 pt-2">
                This is a shared ring-group line: inbound calls ring every agent, so a missed call can't be pinned on
                one person — per-agent response rate stays ~100% for everyone who answers. Agents are ranked by workload
                (answered volume) and onboarding conversion. Faded rows have fewer than 10 inbound calls (not ranked).
                The <span className="metric-bad/80">unanswered overflow</span> row is the line's catch-all where
                missed inbound calls land, not a working agent.
              </p>
            </div>
            {selectedAgent && (
              <Dialog open={!!selectedAgent} onOpenChange={(open) => !open && setSelectedAgent(null)}>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Agent Details</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-3 text-sm">
                    <div>
                      <div className="text-xs text-muted-foreground">Agent Name-Alias Name</div>
                      <div className="font-semibold">{selectedAgent.name}</div>
                    </div>
                    <Badge variant="outline" className={selectedAgent.ranked ? "metric-good border-border" : "metric-warn border-border"}>
                      {selectedAgent.ranked ? "Ranked" : "Low inbound volume"}
                    </Badge>
                    <div className="grid grid-cols-2 gap-2">
                      <div>Calls: <span className="font-semibold tabular-nums">{selectedAgent.totalCalls}</span></div>
                      <div>Answered: <span className="font-semibold tabular-nums metric-good">{selectedAgent.answered}</span></div>
                      <div>Missed: <span className="font-semibold tabular-nums metric-bad">{selectedAgent.missed}</span></div>
                      <div>Onboarded: <span className="font-semibold tabular-nums metric-info">{selectedAgent.onboarded}</span></div>
                      <div>Response: <span className="font-semibold tabular-nums">{selectedAgent.responseRate}%</span></div>
                      <div>Talk: <span className="font-semibold tabular-nums">{fmtDur(selectedAgent.talkSeconds)}</span></div>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function CassieSpotlight({ c }: { c: NonNullable<Analytics["cassie"]> }) {
  const delta = (v: number, unit: string) => (
    <span className={v >= 0 ? "metric-good" : "metric-bad"}>
      {v >= 0 ? "+" : ""}{v}{unit} vs team
    </span>
  );
  return (
    <div className="rounded-xl border border-border bg-card p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Trophy className="h-5 w-5 metric-info" />
        <h3 className="text-base font-semibold">Cassie Lynn — Spotlight</h3>
        <span className="text-xs text-muted-foreground">Productivity & problem-solving</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatPill label="Calls Handled" value={c.totalCalls.toLocaleString()} sub={`${c.uniqueContacts} customers`} icon={Phone} tone="blue" />
        <StatPill label="Response Rate" value={`${c.responseRate}%`} sub="" icon={PhoneIncoming} tone="emerald" />
        <StatPill label="Talk Time" value={fmtDur(c.talkSeconds)} sub="total" icon={Clock} tone="sky" />
        <StatPill label="Avg Gap" value={`${c.avgGapMin}m`} sub="between calls" icon={Timer} tone="amber" />
        <StatPill label="Onboarded" value={c.onboarded.toLocaleString()} sub={`${c.connection} connection`} icon={CheckCircle} tone="cyan" />
        <StatPill label="Onboarded %" value={`${c.onboardedRate}%`} sub="conversion" icon={Award} tone="rose" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
        <div className="rounded-lg border border-white/10 bg-black/20 p-3">
          <div className="text-xs text-muted-foreground">Responsiveness</div>
          <div className="font-medium">{c.responseRate}% answered · {delta(c.vsTeam.responseRate, " pts")}</div>
        </div>
        <div className="rounded-lg border border-white/10 bg-black/20 p-3">
          <div className="text-xs text-muted-foreground">Problem-solving (onboarding conversion)</div>
          <div className="font-medium">{c.onboardedRate}% onboarded · {delta(c.vsTeam.onboardedRate, " pts")}</div>
        </div>
        <div className="rounded-lg border border-white/10 bg-black/20 p-3">
          <div className="text-xs text-muted-foreground">Availability</div>
          <div className="font-medium">{c.avgGapMin}m gap · {delta(c.vsTeam.avgGapMin, "m")}</div>
        </div>
      </div>
      {c.taxMentions > 0 && (
        <p className="text-xs text-muted-foreground flex items-center gap-1">
          <Receipt className="h-3 w-3" /> Handled {c.taxMentions} call{c.taxMentions === 1 ? "" : "s"} mentioning tax.
        </p>
      )}
    </div>
  );
}


