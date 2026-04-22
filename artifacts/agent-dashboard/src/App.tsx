import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { ArrowDown, ArrowUp, ArrowUpDown, RefreshCw, Rocket, Search } from "lucide-react";

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

function isNumericValue(v: string): boolean {
  if (v === "" || v == null) return false;
  const cleaned = v.replace(/[$,%\s]/g, "");
  return cleaned !== "" && !isNaN(Number(cleaned));
}

function toNumber(v: string): number {
  return Number(v.replace(/[$,%\s]/g, ""));
}

function compareValues(a: string, b: string): number {
  const aEmpty = !a || a.trim() === "";
  const bEmpty = !b || b.trim() === "";
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  if (isNumericValue(a) && isNumericValue(b)) {
    return toNumber(a) - toNumber(b);
  }
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function SheetTable({ data }: { data: SheetData }) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ column: string; dir: "asc" | "desc" } | null>(null);

  const filteredSorted = useMemo(() => {
    const q = search.trim().toLowerCase();
    let out = data.rows;
    if (q) {
      out = out.filter((row) =>
        data.headers.some((h) => (row[h] ?? "").toLowerCase().includes(q)),
      );
    }
    if (sort) {
      out = [...out].sort((a, b) => {
        const cmp = compareValues(a[sort.column] ?? "", b[sort.column] ?? "");
        return sort.dir === "asc" ? cmp : -cmp;
      });
    }
    return out;
  }, [data, search, sort]);

  function toggleSort(column: string) {
    setSort((prev) => {
      if (!prev || prev.column !== column) return { column, dir: "asc" };
      if (prev.dir === "asc") return { column, dir: "desc" };
      return null;
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="relative w-full sm:max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search any column…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
            data-testid="input-search"
          />
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="font-mono">
            {filteredSorted.length} of {data.rows.length} rows
          </Badge>
        </div>
      </div>

      <div className="rounded-lg border bg-card overflow-hidden">
        <div className="overflow-x-auto max-h-[65vh]">
          <Table>
            <TableHeader className="sticky top-0 bg-muted/80 backdrop-blur z-10">
              <TableRow>
                {data.headers.map((h) => {
                  const active = sort?.column === h;
                  return (
                    <TableHead key={h} className="whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => toggleSort(h)}
                        className="inline-flex items-center gap-1.5 font-semibold text-foreground hover-elevate active-elevate-2 px-2 py-1 -mx-2 rounded-md"
                        data-testid={`button-sort-${h}`}
                      >
                        <span>{h}</span>
                        {!active && <ArrowUpDown className="h-3.5 w-3.5 opacity-50" />}
                        {active && sort?.dir === "asc" && <ArrowUp className="h-3.5 w-3.5" />}
                        {active && sort?.dir === "desc" && <ArrowDown className="h-3.5 w-3.5" />}
                      </button>
                    </TableHead>
                  );
                })}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredSorted.length === 0 && (
                <TableRow>
                  <TableCell colSpan={data.headers.length} className="text-center py-12 text-muted-foreground">
                    No matching rows.
                  </TableCell>
                </TableRow>
              )}
              {filteredSorted.map((row, i) => (
                <TableRow key={i} className="hover-elevate">
                  {data.headers.map((h) => {
                    const v = row[h] ?? "";
                    const isNum = isNumericValue(v);
                    return (
                      <TableCell
                        key={h}
                        className={`whitespace-nowrap ${isNum ? "text-right tabular-nums font-mono" : ""}`}
                      >
                        {v}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
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

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-xl">{label}</CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Live from Google Sheets · cached for 30 min
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
      <CardContent>
        {query.isLoading && <TableSkeleton />}
        {query.isError && (
          <ErrorState
            message={query.error instanceof Error ? query.error.message : "Failed to load data."}
            onRetry={() => query.refetch()}
          />
        )}
        {query.data && <SheetTable data={query.data} />}
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
