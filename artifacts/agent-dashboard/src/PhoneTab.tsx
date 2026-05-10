import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Tabs, TabsList, TabsTrigger, TabsContent,
} from "@/components/ui/tabs";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { RefreshCw, Phone, PhoneIncoming, PhoneMissed, Clock, Users, Database, CheckCircle, Loader2 } from "lucide-react";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

interface AgentDaySlot {
  outbound: number;
  inbound: number;
  answered: number;
  missed: number;
  voicemail: number;
  totalCalls: number;
  talkSeconds: number;
  uniqueContacts: number;
}

interface LineInboundDay {
  lineId: string;
  lineName: string;
  received: number;
  answered: number;
  missed: number;
  voicemail: number;
}

interface StatsResponse {
  teamStats: Record<string, Record<string, Record<string, AgentDaySlot>>>;
  lineInbound: Record<string, Record<string, LineInboundDay>>;
  totalRows: number;
  lastSyncedAt: string | null;
  isSyncing: boolean;
}

function formatDur(secs: number): string {
  if (!secs) return "—";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function pct(a: number, b: number): string {
  if (!b) return "—";
  return `${Math.round((a / b) * 100)}%`;
}

interface AgentRow {
  name: string;
  totalCalls: number;
  outbound: number;
  inbound: number;
  answered: number;
  missed: number;
  voicemail: number;
  talkSeconds: number;
  uniqueContacts: number;
}

function buildAgentRows(agentStats: Record<string, Record<string, AgentDaySlot>>): AgentRow[] {
  const rows: AgentRow[] = [];
  for (const [name, days] of Object.entries(agentStats)) {
    let totalCalls = 0, outbound = 0, inbound = 0, answered = 0, missed = 0, voicemail = 0, talkSeconds = 0, uniqueContacts = 0;
    for (const slot of Object.values(days)) {
      totalCalls += slot.totalCalls;
      outbound += slot.outbound;
      inbound += slot.inbound;
      answered += slot.answered;
      missed += slot.missed;
      voicemail += slot.voicemail;
      talkSeconds += slot.talkSeconds;
      uniqueContacts += slot.uniqueContacts;
    }
    if (totalCalls > 0) {
      rows.push({ name, totalCalls, outbound, inbound, answered, missed, voicemail, talkSeconds, uniqueContacts });
    }
  }
  return rows.sort((a, b) => b.totalCalls - a.totalCalls);
}

interface InboundRow {
  lineId: string;
  lineName: string;
  date: string;
  received: number;
  answered: number;
  missed: number;
  voicemail: number;
}

function buildInboundRows(
  lineInbound: Record<string, Record<string, LineInboundDay>>,
  teamKey: string,
): InboundRow[] {
  const rows: InboundRow[] = [];
  for (const [lineId, days] of Object.entries(lineInbound)) {
    for (const [date, slot] of Object.entries(days)) {
      const n = slot.lineName.toLowerCase();
      let matches = false;
      if (teamKey === "retention") matches = /retention|ob|outbound|maison|tax|jacob|levi|ryan|mike|adam|rick|austin/.test(n);
      if (teamKey === "nsf") matches = /nsf|national settlement|ellie|alex|katie|jenny|estella|talia|rika/.test(n);
      if (teamKey === "cs") matches = /\bcs\b|customer support/.test(n) || slot.lineName === "SCs" || slot.lineName === "CS Team";
      if (matches) {
        rows.push({ lineId, lineName: slot.lineName, date, received: slot.received, answered: slot.answered, missed: slot.missed, voicemail: slot.voicemail });
      }
    }
  }
  return rows.sort((a, b) => b.date.localeCompare(a.date));
}

function StatPill({ label, value, icon: Icon, tone }: { label: string; value: string | number; icon?: React.ElementType; tone: string }) {
  const tones: Record<string, string> = {
    violet: "from-violet-950/60 to-violet-900/40 border-violet-700/40 text-violet-300",
    sky: "from-sky-950/60 to-sky-900/40 border-sky-700/40 text-sky-300",
    emerald: "from-emerald-950/60 to-emerald-900/40 border-emerald-700/40 text-emerald-300",
    rose: "from-rose-950/60 to-rose-900/40 border-rose-700/40 text-rose-300",
    amber: "from-amber-950/60 to-amber-900/40 border-amber-700/40 text-amber-300",
  };
  return (
    <div className={`rounded-xl border bg-gradient-to-br px-4 py-3 flex flex-col gap-1 ${tones[tone] ?? tones.violet}`}>
      <p className="text-xs font-medium uppercase tracking-wide opacity-70 flex items-center gap-1">
        {Icon && <Icon className="h-3 w-3" />}{label}
      </p>
      <p className="text-2xl font-bold tabular-nums">{value}</p>
    </div>
  );
}

function AgentTable({ rows }: { rows: AgentRow[] }) {
  if (rows.length === 0) {
    return <p className="text-center text-muted-foreground py-10 text-sm">No call data in this date range. Data populates as calls sync from Quo.</p>;
  }
  return (
    <div className="rounded-lg border overflow-auto">
      <Table>
        <TableHeader>
          <TableRow className="bg-card/40">
            <TableHead>Agent</TableHead>
            <TableHead className="text-right">Total</TableHead>
            <TableHead className="text-right">Outbound</TableHead>
            <TableHead className="text-right">Inbound</TableHead>
            <TableHead className="text-right text-emerald-400">Answered</TableHead>
            <TableHead className="text-right text-rose-400">Missed</TableHead>
            <TableHead className="text-right text-amber-400">Voicemail</TableHead>
            <TableHead className="text-right">CX Reached</TableHead>
            <TableHead className="text-right">Talk Time</TableHead>
            <TableHead className="text-right">Answer Rate</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.name} className="hover:bg-muted/30">
              <TableCell className="font-medium">{r.name}</TableCell>
              <TableCell className="text-right tabular-nums font-mono text-violet-300">{r.totalCalls}</TableCell>
              <TableCell className="text-right tabular-nums font-mono text-sky-300">{r.outbound}</TableCell>
              <TableCell className="text-right tabular-nums font-mono">{r.inbound}</TableCell>
              <TableCell className="text-right tabular-nums font-mono text-emerald-300">{r.answered}</TableCell>
              <TableCell className="text-right tabular-nums font-mono text-rose-400">{r.missed}</TableCell>
              <TableCell className="text-right tabular-nums font-mono text-amber-300">{r.voicemail}</TableCell>
              <TableCell className="text-right tabular-nums font-mono">{r.uniqueContacts}</TableCell>
              <TableCell className="text-right tabular-nums font-mono">{formatDur(r.talkSeconds)}</TableCell>
              <TableCell className="text-right tabular-nums font-mono text-emerald-300">{pct(r.answered, r.totalCalls)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function InboundTable({ rows }: { rows: InboundRow[] }) {
  const totals = rows.reduce((a, r) => ({
    received: a.received + r.received,
    answered: a.answered + r.answered,
    missed: a.missed + r.missed,
    voicemail: a.voicemail + r.voicemail,
  }), { received: 0, answered: 0, missed: 0, voicemail: 0 });

  if (rows.length === 0) {
    return <p className="text-center text-muted-foreground py-10 text-sm">No inbound data in this date range.</p>;
  }

  return (
    <div className="rounded-lg border overflow-auto">
      <Table>
        <TableHeader>
          <TableRow className="bg-card/40">
            <TableHead>Line</TableHead>
            <TableHead>Date</TableHead>
            <TableHead className="text-right">Received</TableHead>
            <TableHead className="text-right text-emerald-400">Answered</TableHead>
            <TableHead className="text-right text-rose-400">Missed</TableHead>
            <TableHead className="text-right text-amber-400">Voicemail</TableHead>
            <TableHead className="text-right">Answer Rate</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={i} className="hover:bg-muted/30">
              <TableCell className="font-medium">{r.lineName}</TableCell>
              <TableCell className="text-muted-foreground">{r.date}</TableCell>
              <TableCell className="text-right tabular-nums font-mono text-violet-300">{r.received}</TableCell>
              <TableCell className="text-right tabular-nums font-mono text-emerald-300">{r.answered}</TableCell>
              <TableCell className="text-right tabular-nums font-mono text-rose-400">{r.missed}</TableCell>
              <TableCell className="text-right tabular-nums font-mono text-amber-300">{r.voicemail}</TableCell>
              <TableCell className="text-right tabular-nums font-mono text-emerald-300">{pct(r.answered, r.received)}</TableCell>
            </TableRow>
          ))}
          <TableRow className="bg-primary/5 font-semibold">
            <TableCell colSpan={2}>Total</TableCell>
            <TableCell className="text-right tabular-nums font-mono text-violet-300">{totals.received}</TableCell>
            <TableCell className="text-right tabular-nums font-mono text-emerald-300">{totals.answered}</TableCell>
            <TableCell className="text-right tabular-nums font-mono text-rose-400">{totals.missed}</TableCell>
            <TableCell className="text-right tabular-nums font-mono text-amber-300">{totals.voicemail}</TableCell>
            <TableCell className="text-right tabular-nums font-mono text-emerald-300">{pct(totals.answered, totals.received)}</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}

function TeamPhonePanel({
  teamKey,
  data,
}: {
  teamKey: string;
  data: StatsResponse;
}) {
  const agentStats = data.teamStats?.[teamKey] ?? {};
  const agentRows = useMemo(() => buildAgentRows(agentStats), [agentStats]);
  const inboundRows = useMemo(() => buildInboundRows(data.lineInbound ?? {}, teamKey), [data.lineInbound, teamKey]);

  const totals = agentRows.reduce(
    (a, r) => ({ calls: a.calls + r.totalCalls, unique: a.unique + r.uniqueContacts, secs: a.secs + r.talkSeconds }),
    { calls: 0, unique: 0, secs: 0 },
  );
  const inbTotals = inboundRows.reduce(
    (a, r) => ({ recv: a.recv + r.received, ans: a.ans + r.answered, miss: a.miss + r.missed }),
    { recv: 0, ans: 0, miss: 0 },
  );

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatPill label="Total Calls" value={totals.calls} icon={Phone} tone="violet" />
        <StatPill label="CX Reached" value={totals.unique} icon={Users} tone="sky" />
        <StatPill label="Talk Time" value={formatDur(totals.secs)} icon={Clock} tone="amber" />
        <StatPill label="Inbound Recv" value={inbTotals.recv} icon={PhoneIncoming} tone="emerald" />
        <StatPill label="Inbound Ans" value={inbTotals.ans} icon={PhoneIncoming} tone="emerald" />
        <StatPill label="Inbound Missed" value={inbTotals.miss} icon={PhoneMissed} tone="rose" />
      </div>

      <Tabs defaultValue="agents" className="space-y-4">
        <TabsList>
          <TabsTrigger value="agents">By Agent</TabsTrigger>
          <TabsTrigger value="inbound">Inbound Tracking</TabsTrigger>
        </TabsList>
        <TabsContent value="agents">
          <AgentTable rows={agentRows} />
        </TabsContent>
        <TabsContent value="inbound">
          <InboundTable rows={inboundRows} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export function PhoneTab() {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 8) + "01";
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const queryClient = useQueryClient();

  const fromISO = from ? `${from}T00:00:00Z` : "";
  const toISO = to ? `${to}T23:59:59Z` : "";

  const { data, isLoading, isFetching, error, refetch } = useQuery<StatsResponse>({
    queryKey: ["quoStats", fromISO, toISO],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (fromISO) params.set("from", fromISO);
      if (toISO) params.set("to", toISO);
      const res = await fetch(`${BASE}/api/quo/stats?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 2 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchInterval: 60 * 1000,
  });

  const syncMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${BASE}/api/quo/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: fromISO, to: toISO }),
      });
      if (!res.ok) throw new Error(`Sync failed: HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["quoStats"] }), 2000);
    },
  });

  const lastSync = data?.lastSyncedAt
    ? new Date(data.lastSyncedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-white/5 bg-card/60 backdrop-blur p-5 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-lg font-semibold">Phone Analytics</h2>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span>Quo phone system · synced from OpenPhone</span>
              {lastSync && (
                <span className="flex items-center gap-1 text-emerald-400">
                  <CheckCircle className="h-3 w-3" />
                  Last sync: {lastSync}
                </span>
              )}
              {data?.totalRows != null && (
                <span className="flex items-center gap-1">
                  <Database className="h-3 w-3" />
                  {data.totalRows.toLocaleString()} records
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="rounded-md border border-input bg-background px-2 py-1 text-sm"
            />
            <span className="text-muted-foreground text-sm">to</span>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="rounded-md border border-input bg-background px-2 py-1 text-sm"
            />
            <Button size="sm" variant="outline" onClick={() => { setFrom(today); setTo(today); }}>Today</Button>
            <Button size="sm" variant="outline" onClick={() => { setFrom(monthStart); setTo(today); }}>Month</Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => syncMutation.mutate()}
              disabled={syncMutation.isPending}
              title="Force re-sync data from Quo for selected date range"
            >
              {syncMutation.isPending
                ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" />Syncing…</>
                : <><Database className="h-4 w-4 mr-1" />Sync</>
              }
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => refetch()}
              disabled={isFetching}
            >
              <RefreshCw className={`h-4 w-4 mr-1 ${isFetching ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </div>

        {isLoading && (
          <div className="text-center py-12 text-muted-foreground text-sm animate-pulse flex items-center justify-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading call data from database…
          </div>
        )}
        {error && (
          <div className="text-center py-8 text-rose-400 text-sm">
            Error loading data: {String(error)}
          </div>
        )}
        {!isLoading && data && data.totalRows === 0 && (
          <div className="text-center py-6 text-amber-400/80 text-sm">
            No call data yet for this date range. The background sync is populating data from Quo — click Sync to fetch this period now.
          </div>
        )}
      </div>

      {data && data.totalRows > 0 && (
        <Tabs defaultValue="retention" className="space-y-4">
          <TabsList className="grid w-full max-w-md grid-cols-3">
            <TabsTrigger value="retention">Retention</TabsTrigger>
            <TabsTrigger value="nsf">NSF</TabsTrigger>
            <TabsTrigger value="cs">CS Team</TabsTrigger>
          </TabsList>
          <TabsContent value="retention">
            <TeamPhonePanel teamKey="retention" data={data} />
          </TabsContent>
          <TabsContent value="nsf">
            <TeamPhonePanel teamKey="nsf" data={data} />
          </TabsContent>
          <TabsContent value="cs">
            <TeamPhonePanel teamKey="cs" data={data} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
