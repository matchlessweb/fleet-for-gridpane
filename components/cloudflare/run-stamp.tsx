"use client";

import { useEffect, useMemo, useState } from "react";
import { CircleCheck, TriangleAlert } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { Callout, Copyable } from "@/components/ui";
import {
  formatRunDate,
  formatRunTime,
  staleness,
  tie,
  type WafRun,
} from "@/lib/cloudflare-waf";

export type RunState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "empty" }
  | { status: "ready"; run: WafRun };

/** The latest ingested inventory run. Every WAF view reads the same one. */
export function useLatestWafRun(): RunState {
  const supabase = useMemo(() => createClient(), []);
  const [state, setState] = useState<RunState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("cloudflare_waf_runs")
        .select("*")
        .order("generated_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(1);
      if (cancelled) return;
      if (error) setState({ status: "error", message: error.message });
      else if (!data || data.length === 0) setState({ status: "empty" });
      else setState({ status: "ready", run: data[0] as WafRun });
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  return state;
}

/**
 * RunStamp — the date of the inventory run a WAF view is showing.
 *
 * It is a headline, not a footnote: a WAF page that looks authoritative while
 * showing three-week-old rules is the failure this exists to prevent. The date
 * is set as a figure, the age sits beside it in words, and past a week the
 * whole stamp takes the warning tone with an icon and an instruction. Severity
 * never rides on color alone.
 */
export function RunStamp({
  run,
  size = "board",
  className,
}: {
  run: WafRun;
  size?: "board" | "inline";
  className?: string;
}) {
  // A run only ever arrives from a client-side fetch, so this component never
  // renders on the server and the clock read here is the viewer's own.
  const [now] = useState(() => new Date());
  const s = staleness(run.generated_at, now);
  const tone = s.tone;
  const toneText =
    tone === "danger" ? "text-danger" : tone === "warn" ? "text-warning" : "text-foreground";
  const Icon = tone === "ok" ? CircleCheck : TriangleAlert;

  return (
    <div
      data-waf-run-stamp
      data-tone={tone}
      className={cn(
        "rounded-md border px-4 py-3.5",
        tone === "danger" && "border-danger/50 bg-danger/8",
        tone === "warn" && "border-warning/50 bg-warning/8",
        tone === "ok" && "border-line-strong bg-panel-2",
        className
      )}
    >
      <div className="eyebrow text-muted-foreground">Inventory run shown here</div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-3.5 gap-y-1">
        <span
          className={cn(
            "font-bold tabular-nums tracking-[-0.03em]",
            size === "board" ? "text-[34px] leading-none sm:text-[40px]" : "text-[22px] leading-tight",
            toneText
          )}
        >
          {formatRunDate(run.generated_at)}
        </span>
        <span className={cn("inline-flex items-center gap-1.5 text-[13px] font-semibold", toneText)}>
          <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
          {s.age}
        </span>
      </div>
      {s.advice && (
        <p className={cn("text-pretty mt-1.5 text-[13px] font-semibold", toneText)}>{tie(s.advice)}</p>
      )}
      <p className="text-pretty mt-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
        {tie(`Written ${formatRunTime(run.generated_at)} · ${run.zone_count} zones · ${run.rule_count} rules`)}
        {/* The run folder is one long unbreakable value: on its own line it can
            never be the word left stranded at the end of the line above. */}
        <span className="block">{`Run ${run.run_dir}`}</span>
      </p>
    </div>
  );
}

/**
 * The stamp's shape while the run loads: the same box, padding and line boxes as
 * a fresh stamp, so the page below does not move when the date arrives. A stale
 * run adds one line of advice, which cannot be known before the fetch answers.
 */
export function RunStampSkeleton({ className }: { className?: string }) {
  const bar = "block animate-pulse rounded-sm bg-foreground/10";
  return (
    <div
      aria-hidden="true"
      data-waf-run-stamp-loading
      className={cn("rounded-md border border-line-strong bg-panel-2 px-4 py-3.5", className)}
    >
      <div className="flex h-[15px] items-center">
        <span className={cn(bar, "h-[9px] w-40")} />
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3.5 gap-y-1">
        <span className={cn(bar, "h-[34px] w-[207px] max-w-full sm:h-[40px] sm:w-[243px]")} />
        <span className={cn(bar, "h-5 w-24")} />
      </div>
      <div className="mt-1.5 flex h-[36px] flex-col justify-around max-[359px]:h-[54px]">
        <span className={cn(bar, "h-[9px] w-64 max-w-full")} />
        <span className={cn(bar, "h-[9px] w-48 max-w-full")} />
      </div>
    </div>
  );
}

/** What to show when there is no run to stamp. Says so plainly. */
export function RunMissing({ state }: { state: Extract<RunState, { status: "error" | "empty" }> }) {
  return (
    <Callout tone="warning" data-waf-run-missing title="No WAF inventory is loaded">
      This dashboard cannot read Cloudflare itself. It shows the report the WAF inventory
      writes, once that report has been loaded with{" "}
      <Copyable value="npm run waf:ingest" what="command" className="text-[11.5px]">
        npm run waf:ingest
      </Copyable>
      .
      {state.status === "error" && (
        <>
          {" "}
          The database answered:{" "}
          <span className="font-mono text-[11.5px] [overflow-wrap:anywhere]">{state.message}</span>
        </>
      )}
    </Callout>
  );
}
