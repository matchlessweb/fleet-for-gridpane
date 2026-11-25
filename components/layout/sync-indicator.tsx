"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useSyncRun } from "@/components/providers/sync-run-provider";
import { Led, Meter, PopoverSheet, Tooltip } from "@/components/ui";

/**
 * The top bar's sign that a sync is running somewhere: another tab, another
 * device, or `npm run sync` on someone's machine. The tab that is running the
 * sync itself shows its own "Running" button instead (the task modal), so the
 * masthead renders this only when that one is not showing.
 */
export function SyncIndicator() {
  const { view } = useSyncRun();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  if (view.state !== "running") return null;

  const count = view.title.replace(/^Syncing: /, "");
  return (
    <div ref={anchorRef} className="relative">
      <Tooltip label="A sync is running">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={`${view.title}. Show its progress.`}
          data-sync-indicator
          className="eyebrow touch-hit inline-flex h-[33px] items-center gap-1.5 rounded-md border border-line-strong bg-panel px-2.5 text-primary sm:px-3"
        >
          <Led tone="ok" ping />
          <span className="hidden sm:inline">Syncing</span>
          {view.percent !== null && <span className="hidden tabular-nums lg:inline">{view.percent}%</span>}
        </button>
      </Tooltip>
      <PopoverSheet open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} label="Sync progress" className="w-[340px]">
        <div className="flex flex-col gap-3 p-4" role="status">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[13px] font-semibold text-foreground">Sync in progress</span>
            {view.percent !== null && <span className="eyebrow tabular-nums text-primary">{view.percent}%</span>}
          </div>
          <p className="text-[12.5px] text-foreground">{count.charAt(0).toUpperCase() + count.slice(1)}</p>
          {view.percent !== null && <Meter value={view.percent} />}
          <p className="text-[12px] leading-relaxed text-pretty text-muted-foreground">{view.detail}</p>
          <Link href="/settings/setup" onClick={() => setOpen(false)} className="eyebrow text-primary underline-offset-4 hover:underline">
            Sync and setup
          </Link>
        </div>
      </PopoverSheet>
    </div>
  );
}
