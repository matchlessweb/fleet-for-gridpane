"use client";

import * as React from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { IconButton } from "./button";
import { Meter } from "./meter";
import { Sheet } from "./sheet";
import type { Metric } from "@/lib/thresholds";

type PeekProps = {
  open: boolean;
  onClose: () => void;
  /** What this is, in the eyebrow: "Server". */
  kind: React.ReactNode;
  /** A second half for the eyebrow ("node 4821"). Dropped on phones, where the row has no room for it. */
  kindDetail?: React.ReactNode;
  title: React.ReactNode;
  /** One mono line under the title: an IP, a server name. */
  subtitle?: React.ReactNode;
  /** A StatusPill. */
  status?: React.ReactNode;
  /** Step to the row above or below without closing. Omit at either end. */
  onPrev?: () => void;
  onNext?: () => void;
  /** "3 of 19", read aloud as the row changes. */
  position?: string;
  /** Pinned at the bottom: at most one solid action, the rest ghost. */
  actions?: React.ReactNode;
  children: React.ReactNode;
};

/**
 * Peek — a quick look at one row of a list without leaving the list. Status
 * and meters on top, facts below, actions pinned at the bottom. A side panel
 * from `sm` up, a bottom sheet on phones. Up and Down step through the rows.
 */
export function Peek({ open, onClose, kind, kindDetail, title, subtitle, status, onPrev, onNext, position, actions, children }: PeekProps) {
  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key === "ArrowUp" && onPrev) {
        e.preventDefault();
        onPrev();
      } else if (e.key === "ArrowDown" && onNext) {
        e.preventDefault();
        onNext();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onPrev, onNext]);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      side="right"
      width={440}
      label={typeof title === "string" ? `Quick view: ${title}` : "Quick view"}
      footer={actions != null ? <div className="flex flex-wrap gap-2">{actions}</div> : undefined}
      contentClassName="py-0"
      header={
        <div className="border-b border-border px-5 pb-3.5 pt-1.5 sm:pt-3.5">
          <div className="flex items-center gap-1.5">
            <span className="eyebrow min-w-0 flex-1 truncate text-muted-foreground">
              {kind}
              {kindDetail != null && <span className="max-sm:hidden"> · {kindDetail}</span>}
            </span>
            {position && (
              <span aria-live="polite" className="mr-1 whitespace-nowrap font-mono text-[10.5px] tabular-nums text-muted-foreground">
                {position}
              </span>
            )}
            <IconButton label="Previous row" keys="↑" aria-keyshortcuts="ArrowUp" onClick={onPrev} disabled={!onPrev}>
              <ChevronUp size={14} strokeWidth={1.75} />
            </IconButton>
            <IconButton label="Next row" keys="↓" aria-keyshortcuts="ArrowDown" onClick={onNext} disabled={!onNext}>
              <ChevronDown size={14} strokeWidth={1.75} />
            </IconButton>
            <IconButton label="Close" keys="Esc" onClick={onClose}>
              <X size={14} strokeWidth={1.75} />
            </IconButton>
          </div>
          <div className="mt-2.5 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="break-words text-[15px] font-bold leading-tight">{title}</div>
              {subtitle != null && <div className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground">{subtitle}</div>}
            </div>
            {status != null && <div className="shrink-0">{status}</div>}
          </div>
        </div>
      }
    >
      {children}
    </Sheet>
  );
}

/** A titled block inside a Peek. Blocks separate with a hairline, not a card. */
export function PeekSection({
  title,
  meta,
  children,
  className,
}: {
  title?: React.ReactNode;
  meta?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("border-b border-border py-3 last:border-0", className)}>
      {title != null && (
        <div className="mb-1 flex items-baseline justify-between gap-3">
          <h3 className="eyebrow text-muted-foreground">{title}</h3>
          {meta != null && <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">{meta}</span>}
        </div>
      )}
      {children}
    </section>
  );
}

/** One reading as a labeled meter. With no reading it says so and draws no bar. */
export function PeekMeter({
  label,
  value,
  metric,
  detail,
}: {
  label: string;
  value: number | null | undefined;
  metric: Metric;
  detail?: React.ReactNode;
}) {
  const has = typeof value === "number";
  return (
    <div className="py-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="eyebrow text-muted-foreground">{label}</span>
        <span className="font-mono text-[11px] tabular-nums">
          {has ? `${value}%` : "No reading"}
          {has && detail != null && <span className="text-muted-foreground"> / {detail}</span>}
        </span>
      </div>
      {has ? <Meter value={value} metric={metric} className="mt-1.5" /> : <div aria-hidden="true" className="mt-1.5 h-[4px] rounded-sm border border-dashed border-border" />}
    </div>
  );
}
