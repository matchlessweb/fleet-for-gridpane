"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";

type TickerItem = {
  id: number;
  label: string;
  cpu: number;
};

const staticItems: { label: string; value: string }[] = [
  { label: "Cadence", value: "*/10" },
  { label: "Retention", value: "7d" },
];

/**
 * Ticker ribbon — latest CPU reading per node as a broadsheet stock line.
 * One query on mount + a 60s interval refresh; no realtime channel.
 * The ribbon is there from the first paint with its fixed entries, and the
 * readings fill in: it used to appear when they arrived and push every page
 * down by its own height.
 */
export function TickerRibbon() {
  const [items, setItems] = useState<TickerItem[] | null>(null);
  const supabase = createClient();

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const [serversRes, telemetryRes] = await Promise.all([
        supabase.from("servers").select("id,label").order("label"),
        supabase
          .from("server_telemetry")
          .select("server_id,cpu_usage,timestamp")
          .order("timestamp", { ascending: false })
          .limit(40),
      ]);
      if (cancelled) return;

      const servers = serversRes.data ?? [];
      const telemetry = telemetryRes.data ?? [];

      // Rows are timestamp-desc — the first row per server is its latest.
      const latest = new Map<number, number>();
      for (const row of telemetry) {
        if (!latest.has(row.server_id)) latest.set(row.server_id, row.cpu_usage);
      }

      setItems(
        servers
          .filter((s) => latest.has(s.id))
          .map((s) => ({ id: s.id, label: s.label, cpu: latest.get(s.id)! }))
      );
    }

    load();
    const interval = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [supabase]);

  const hold = <span aria-hidden="true" className="inline-block h-[9px] w-10 animate-pulse self-center rounded-sm bg-foreground/10" />;

  return (
    <div className="shrink-0 border-b border-border bg-panel-2 pr-[var(--sbw,0px)]">
      <div className="hide-scrollbar mx-auto flex w-full max-w-[1360px] items-center gap-6 overflow-x-auto whitespace-nowrap py-[7px] pl-[calc(1.25rem+env(safe-area-inset-left))] pr-[calc(1.25rem+env(safe-area-inset-right))] lg:pl-[calc(2rem+env(safe-area-inset-left))] lg:pr-[calc(2rem+env(safe-area-inset-right))]">
        {/* Date stamp — the masthead eyebrow is hidden under md, so the
            ledger stamp leads the ticker on phones. The date is written
            alongside the data, in the browser: the server does not know the
            reader's time zone. */}
        <span className="eyebrow flex shrink-0 items-baseline gap-1.5 text-muted-foreground md:hidden">
          Ledger
          {items === null ? (
            hold
          ) : (
            <b className="font-mono text-[10.5px] font-semibold text-foreground">
              {new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" })}
            </b>
          )}
        </span>
        {items === null && (
          <span className="flex shrink-0 items-center gap-6" data-ticker-loading="">
            {hold}
            {hold}
            {hold}
          </span>
        )}
        {(items ?? []).map((item) => (
          <span key={item.id} className="eyebrow flex shrink-0 items-baseline gap-1.5 text-muted-foreground">
            {item.label}
            <b
              className={cn(
                "font-mono text-[10.5px] font-semibold tabular-nums",
                item.cpu >= 75 ? "text-warning" : "text-foreground"
              )}
            >
              {item.cpu.toFixed(1)}%
            </b>
          </span>
        ))}
        {staticItems.map((item) => (
          <span key={item.label} className="eyebrow flex shrink-0 items-baseline gap-1.5 text-muted-foreground">
            {item.label}
            <b className="font-mono text-[10.5px] font-semibold text-foreground">{item.value}</b>
          </span>
        ))}
      </div>
    </div>
  );
}
