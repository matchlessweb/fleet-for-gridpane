import * as React from "react";
import { Clock, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

type SummaryStripProps = React.HTMLAttributes<HTMLDivElement> & {
  /** The report behind these figures is overdue: tint the strip so old figures are never taken for current ones. */
  stale?: boolean;
};

/**
 * SummaryStrip — one line of small figures over a server's report, ending in
 * how old that report is. The same strip heads Fail2Ban, the server firewall
 * and the code cache.
 */
export function SummaryStrip({ stale = false, className, children, ...props }: SummaryStripProps) {
  return (
    <div
      data-stale={stale ? "true" : "false"}
      className={cn(
        "flex flex-wrap items-center gap-x-5 gap-y-2 rounded-md border px-4 py-3.5",
        stale ? "border-warning/35 bg-warning/8" : "border-line-strong bg-panel-2",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

/** A count and what it counts. `of` adds the total: 4/6. */
export function SummaryFigure({ value, of, label }: { value: string; of?: string; label: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="font-mono text-[20px] font-bold leading-none tabular-nums">
        {value}
        {of !== undefined && <span className="text-muted-foreground">{`/${of}`}</span>}
      </span>
      <span className="eyebrow text-muted-foreground">{label}</span>
    </span>
  );
}

/** The report's age. Stale swaps the clock for a warning sign and sets the words in ink. */
export function SummaryAge({ stale = false, children }: { stale?: boolean; children: React.ReactNode }) {
  const Icon = stale ? TriangleAlert : Clock;
  return (
    <span className={cn("flex items-center gap-1.5 text-[12.5px]", stale ? "font-semibold text-foreground" : "text-muted-foreground")}>
      <Icon size={14} strokeWidth={1.75} aria-hidden="true" className={cn("shrink-0", stale && "text-warning")} />
      <span>{children}</span>
    </span>
  );
}
