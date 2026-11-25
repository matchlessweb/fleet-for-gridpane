import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * FilterPill — a one-tap filter that shows how many rows it holds. A row of
 * them filters a list in place; the active one is ink-filled, like Segmented.
 * The count is the real number for that filter, never a placeholder.
 */
export function FilterPill({
  active,
  count,
  children,
  className,
  ...props
}: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  active: boolean;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        "touch-hit inline-flex h-[28px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-[11.5px] font-medium transition-colors duration-150",
        active
          ? "border-foreground bg-foreground font-semibold text-background"
          : "border-line-strong bg-panel text-muted-foreground hover:text-foreground",
        className
      )}
      {...props}
    >
      {children}
      {count != null && <span className={cn("font-mono text-[10.5px] tabular-nums", active ? "text-background/80" : "text-muted-foreground")}>{count}</span>}
    </button>
  );
}
