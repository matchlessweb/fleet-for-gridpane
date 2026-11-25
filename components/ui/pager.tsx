import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./button";

type PagerProps = {
  /** 1-based page. */
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  /** What is being counted, plural: "sites", "bans". Read out with the range. */
  noun?: string;
  className?: string;
};

/**
 * Pager — "1–25 of 312" and two buttons. The range is always there, so the
 * row keeps its height; the buttons only do something when there is more than
 * one page.
 */
export function Pager({ page, pageSize, total, onPage, noun = "rows", className }: PagerProps) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), pages);
  const from = total === 0 ? 0 : (current - 1) * pageSize + 1;
  const to = Math.min(total, current * pageSize);
  return (
    // box-content: the 33px is the row itself, whatever padding the caller adds, so one page and many take the same room.
    <nav aria-label={`Pages of ${noun}`} className={cn("box-content flex min-h-[33px] items-center justify-between gap-3", className)}>
      <span className="font-mono text-[11.5px] tabular-nums text-muted-foreground" aria-live="polite">
        {total === 0 ? (
          <>0 {noun}</>
        ) : (
          <>
            {from}–{to} of {total}
            <span className="sr-only"> {noun}</span>
          </>
        )}
      </span>
      {pages > 1 && (
        <span className="flex items-center gap-2">
          <Button size="sm" onClick={() => onPage(current - 1)} disabled={current <= 1}>
            <ChevronLeft size={13} strokeWidth={1.75} aria-hidden="true" className="-ml-1" />
            Prev
          </Button>
          <Button size="sm" onClick={() => onPage(current + 1)} disabled={current >= pages}>
            Next
            <ChevronRight size={13} strokeWidth={1.75} aria-hidden="true" className="-mr-1" />
          </Button>
        </span>
      )}
    </nav>
  );
}
