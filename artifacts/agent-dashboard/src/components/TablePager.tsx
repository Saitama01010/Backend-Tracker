import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";

export const LARGE_TABLE_PAGE_SIZE = 100;

export function pageRows<T>(rows: readonly T[], page: number, pageSize = LARGE_TABLE_PAGE_SIZE): T[] {
  const safePage = Math.max(0, page);
  return rows.slice(safePage * pageSize, (safePage + 1) * pageSize);
}

export function usePaginatedRows<T>(rows: readonly T[], resetKey: string, pageSize = LARGE_TABLE_PAGE_SIZE) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));

  useEffect(() => setPage(0), [resetKey]);
  useEffect(() => setPage((current) => Math.min(current, pageCount - 1)), [pageCount]);

  const visibleRows = useMemo(() => pageRows(rows, page, pageSize), [page, pageSize, rows]);
  return { page, setPage, pageCount, visibleRows, totalRows: rows.length, pageSize };
}

export function TablePager({ page, pageCount, pageSize, totalRows, onPageChange }: {
  page: number;
  pageCount: number;
  pageSize: number;
  totalRows: number;
  onPageChange: (page: number) => void;
}) {
  if (pageCount <= 1) return null;
  const first = page * pageSize + 1;
  const last = Math.min(totalRows, (page + 1) * pageSize);
  return (
    <nav className="flex items-center justify-between gap-3 border-t border-border px-3 py-2" aria-label="Table pagination">
      <span className="text-xs text-muted-foreground">Showing {first.toLocaleString()}–{last.toLocaleString()} of {totalRows.toLocaleString()}</span>
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => onPageChange(page - 1)} disabled={page === 0} aria-label="Previous table page">
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="min-w-16 text-center text-xs text-muted-foreground">{page + 1} / {pageCount}</span>
        <Button type="button" variant="ghost" size="sm" onClick={() => onPageChange(page + 1)} disabled={page + 1 >= pageCount} aria-label="Next table page">
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </nav>
  );
}
