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
import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, RefreshCw, Rocket, Search, Calendar } from "lucide-react";

const queryClient = new QueryClient();

const RETENTION_URL =
  "https://docs.google.com/spreadsheets/d/1qF5Dc5quGrAywf5Rtx4q7DrX91VlNIFOfKr-REoSkII/export?format=csv&gid=0";
const NSF_URL =
  "https://docs.google.com/spreadsheets/d/16qoZESE0gGQPdOXQUSh2JsadWDmUE7OyCajRwBy0E38/export?format=csv&gid=0";

type Row = Record<string, string>;
type SheetData = { headers: string[]; rows: Row[] };

async function fetchCsv(url: string): Promise<SheetData> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to load sheet (HTTP ${res.status}). Make sure the link is shared as "Anyone with the link".`);
  }
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

function useSheet(url: string, key: string) {
  return useQuery({
    queryKey: ["sheet", key],
    queryFn: () => fetchCsv(url),
    staleTime: 1000 * 60 * 30,
    refetchOnWindowFocus: false,
  });
}

// Find a column by trying several possible names (case-insensitive, trimmed)
function findColumn(headers: string[], candidates: string[]): string | null {
  const lower = headers.map((h) => h.toLowerCase().trim());
  for (const c of candidates) {
    const idx = lower.indexOf(c.toLowerCase().trim());
    if (idx >= 0) return headers[idx];
  }
  return null;
}

// Parse dates like "4/1/2026", "04/01/2026", "2026-04-01"
function parseDate(s: string): Date | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  // ISO-style
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(trimmed);
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return isNaN(d.getTime()) ? null : d;
  }
  // M/D/YYYY or D/M/YYYY — assume US M/D/YYYY (matches what we saw)
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

type Pivot = {
  agentColumn: string;
  statusColumn: string;
  dateColumn: string | null;
  statuses: string[]; // column order
  agents: string[]; // row order
  counts: Map<string, Map<string, number>>; // agent -> status -> count
  totalsByAgent: Map<string, number>;
  totalsByStatus: Map<string, number>;
  grandTotal: number;
  filteredRowCount: number;
  totalRowCount: number;
  minDate: Date | null;
  maxDate: Date | null;
};

function buildPivot(
  data: SheetData,
  fromDate: Date | null,
  toDate: Date | null,
): Pivot | { error: string } {
  const agentColumn = findColumn(data.headers, ["Agent", "Agent Name", "Rep"]);
  const statusColumn = findColumn(data.headers, ["Status", "Result", "Outcome", "Disposition"]);
  const dateColumn = findColumn(data.headers, ["Date", "Day", "Call Date"]);

  if (!agentColumn) {
    return { error: `Couldn't find an "Agent" column. Found: ${data.headers.join(", ")}` };
  }
  if (!statusColumn) {
    return { error: `Couldn't find a "Status" column. Found: ${data.headers.join(", ")}` };
  }

  // Determine global date range from data (for the filter UI)
  let minDate: Date | null = null;
  let maxDate: Date | null = null;
  if (dateColumn) {
    for (const r of data.rows) {
      const d = parseDate(r[dateColumn] ?? "");
      if (!d) continue;
      if (!minDate || d < minDate) minDate = d;
      if (!maxDate || d > maxDate) maxDate = d;
    }
  }

  const filtered = data.rows.filter((r) => {
    const agent = (r[agentColumn] ?? "").trim();
    if (!agent) return false;
    // Skip pivot/summary rows that often appear at the bottom of sheets
    if (/total$/i.test(agent)) return false;
    if (/^grand total/i.test(agent)) return false;
    if (dateColumn && (fromDate || toDate)) {
      const d = parseDate(r[dateColumn] ?? "");
      if (!d) return false;
      if (fromDate && d < fromDate) return false;
      if (toDate && d > toDate) return false;
    }
    return true;
  });

  const counts = new Map<string, Map<string, number>>();
  const statusSet = new Set<string>();
  const totalsByAgent = new Map<string, number>();
  const totalsByStatus = new Map<string, number>();
  let grandTotal = 0;

  for (const r of filtered) {
    const agent = (r[agentColumn] ?? "").trim();
    const status = (r[statusColumn] ?? "").trim() || "(blank)";
    statusSet.add(status);
    if (!counts.has(agent)) counts.set(agent, new Map());
    const m = counts.get(agent)!;
    m.set(status, (m.get(status) ?? 0) + 1);
    totalsByAgent.set(agent, (totalsByAgent.get(agent) ?? 0) + 1);
    totalsByStatus.set(status, (totalsByStatus.get(status) ?? 0) + 1);
    grandTotal++;
  }

  const statuses = Array.from(statusSet).sort((a, b) => {
    // Sort by total desc, then name
    const ta = totalsByStatus.get(a) ?? 0;
    const tb = totalsByStatus.get(b) ?? 0;
    if (ta !== tb) return tb - ta;
    return a.localeCompare(b);
  });
  const agents = Array.from(counts.keys()).sort((a, b) => a.localeCompare(b));

  return {
    agentColumn,
    statusColumn,
    dateColumn,
    statuses,
    agents,
    counts,
    totalsByAgent,
    totalsByStatus,
    grandTotal,
    filteredRowCount: filtered.length,
    totalRowCount: data.rows.length,
    minDate,
    maxDate,
  };
}

type SortState = { column: string; dir: "asc" | "desc" } | null;

function PivotTable({ pivot }: { pivot: Pivot }) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortState>({ column: "__total__", dir: "desc" });

  const visibleAgents = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = pivot.agents;
    if (q) list = list.filter((a) => a.toLowerCase().includes(q));
    if (sort) {
      list = [...list].sort((a, b) => {
        let av: number | string;
        let bv: number | string;
        if (sort.column === "__agent__") {
          av = a;
          bv = b;
        } else if (sort.column === "__total__") {
          av = pivot.totalsByAgent.get(a) ?? 0;
          bv = pivot.totalsByAgent.get(b) ?? 0;
        } else {
          av = pivot.counts.get(a)?.get(sort.column) ?? 0;
          bv = pivot.counts.get(b)?.get(sort.column) ?? 0;
        }
        if (typeof av === "number" && typeof bv === "number") {
          return sort.dir === "asc" ? av - bv : bv - av;
        }
        const cmp = String(av).localeCompare(String(bv));
        return sort.dir === "asc" ? cmp : -cmp;
      });
    }
    return list;
  }, [pivot, search, sort]);

  function toggleSort(column: string) {
    setSort((prev) => {
      if (!prev || prev.column !== column) {
        return { column, dir: column === "__agent__" ? "asc" : "desc" };
      }
      if (prev.dir === "desc") return { column, dir: "asc" };
      return null;
    });
  }

  function SortHeader({ id, label, align = "left" }: { id: string; label: string; align?: "left" | "right" }) {
    const active = sort?.column === id;
    return (
      <button
        type="button"
        onClick={() => toggleSort(id)}
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
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="secondary" className="font-mono">
            {visibleAgents.length} agents
          </Badge>
          <Badge variant="secondary" className="font-mono">
            {pivot.filteredRowCount} of {pivot.totalRowCount} rows
          </Badge>
        </div>
      </div>

      <div className="rounded-lg border bg-card overflow-hidden">
        <div className="overflow-x-auto max-h-[65vh]">
          <Table>
            <TableHeader className="sticky top-0 bg-muted/80 backdrop-blur z-10">
              <TableRow>
                <TableHead className="whitespace-nowrap min-w-[200px]">
                  <SortHeader id="__agent__" label="Agent" />
                </TableHead>
                {pivot.statuses.map((s) => (
                  <TableHead key={s} className="whitespace-nowrap text-right">
                    <SortHeader id={s} label={s} align="right" />
                  </TableHead>
                ))}
                <TableHead className="whitespace-nowrap text-right bg-primary/5">
                  <SortHeader id="__total__" label="Total" align="right" />
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleAgents.length === 0 && (
                <TableRow>
                  <TableCell colSpan={pivot.statuses.length + 2} className="text-center py-12 text-muted-foreground">
                    No agents match the current filters.
                  </TableCell>
                </TableRow>
              )}
              {visibleAgents.map((agent) => {
                const row = pivot.counts.get(agent);
                const total = pivot.totalsByAgent.get(agent) ?? 0;
                return (
                  <TableRow key={agent} className="hover-elevate">
                    <TableCell className="font-medium whitespace-nowrap">{agent}</TableCell>
                    {pivot.statuses.map((s) => {
                      const v = row?.get(s) ?? 0;
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
                      {total}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
            {visibleAgents.length > 0 && (
              <TableHeader className="sticky bottom-0 bg-muted/80 backdrop-blur z-10">
                <TableRow>
                  <TableCell className="font-bold whitespace-nowrap">Whole team</TableCell>
                  {pivot.statuses.map((s) => (
                    <TableCell key={s} className="text-right tabular-nums font-mono font-bold">
                      {pivot.totalsByStatus.get(s) ?? 0}
                    </TableCell>
                  ))}
                  <TableCell className="text-right tabular-nums font-mono font-bold bg-primary/10">
                    {pivot.grandTotal}
                  </TableCell>
                </TableRow>
              </TableHeader>
            )}
          </Table>
        </div>
      </div>
    </div>
  );
}

function StatTile({ label, value, accent }: { label: string; value: number | string; accent?: boolean }) {
  return (
    <div className={`rounded-lg border p-4 ${accent ? "bg-primary/5 border-primary/20" : "bg-card"}`}>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums font-mono">{value}</div>
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
      <div className="flex gap-2">
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

function TeamPanel({ url, sheetKey, label }: { url: string; sheetKey: string; label: string }) {
  const query = useSheet(url, sheetKey);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const fromDate = from ? parseDate(from) : null;
  const toDate = to ? parseDate(to) : null;
  // Make "to" inclusive of the whole day
  if (toDate) toDate.setHours(23, 59, 59, 999);

  const pivot = useMemo(() => {
    if (!query.data) return null;
    return buildPivot(query.data, fromDate, toDate);
  }, [query.data, from, to]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0 gap-4">
        <div>
          <CardTitle className="text-xl">{label}</CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Per-agent status counts · live from Google Sheets · cached for 30 min
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => query.refetch()}
          disabled={query.isFetching}
          data-testid="button-refresh"
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${query.isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-6">
        {query.isLoading && <TableSkeleton />}
        {query.isError && (
          <ErrorState
            message={query.error instanceof Error ? query.error.message : "Failed to load data."}
            onRetry={() => query.refetch()}
          />
        )}
        {pivot && "error" in pivot && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {pivot.error}
          </div>
        )}
        {pivot && !("error" in pivot) && (
          <>
            <DateFilters
              minDate={pivot.minDate}
              maxDate={pivot.maxDate}
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
              <StatTile label="Agents" value={pivot.agents.length} />
              <StatTile label="Total records" value={pivot.grandTotal} accent />
              {pivot.statuses.slice(0, 2).map((s) => (
                <StatTile key={s} label={s} value={pivot.totalsByStatus.get(s) ?? 0} />
              ))}
            </div>

            <PivotTable pivot={pivot} />
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
            <TeamPanel url={RETENTION_URL} sheetKey="retention" label="Retention Team" />
          </TabsContent>
          <TabsContent value="nsf">
            <TeamPanel url={NSF_URL} sheetKey="nsf" label="NSF Team" />
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
