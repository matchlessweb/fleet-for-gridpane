"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useSyncRun } from "@/components/providers/sync-run-provider";
import { useTask } from "@/components/providers/task-provider";
import { createClient } from "@/lib/supabase/client";
import { tie } from "@/lib/utils";
import { syncDuration } from "@/lib/sync-runs";
import { Button, buttonClasses, Callout, CodeBlock, Meter, PanelHeader, StatusPill } from "@/components/ui";

/** Starts a sync the way the masthead's Sync button does: in this tab. */
export const startSync = () => window.dispatchEvent(new Event("trigger_global_sync"));

const WATCH = "npm run sync:status -- --watch";

/** How many servers the database holds, or null until it answers. */
export function useServerCount(): number | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    const supabase = createClient();
    let live = true;
    const read = () =>
      supabase.from("servers").select("id", { count: "exact", head: true }).then(({ count: n }) => {
        if (live) setCount(n ?? 0);
      });
    void read();
    window.addEventListener("sync_run_ended", read);
    window.addEventListener("schedules_updated", read);
    return () => {
      live = false;
      window.removeEventListener("sync_run_ended", read);
      window.removeEventListener("schedules_updated", read);
    };
  }, []);
  return count;
}

/**
 * The sync, on the setup page: before the first one, what to expect and the
 * button that starts it (nothing starts on its own); while one runs, its
 * progress; after, how the last one ended.
 */
export function SyncSection() {
  const { view, loaded, available } = useSyncRun();
  const { isTaskRunning, setIsModalOpen } = useTask();
  const servers = useServerCount();
  const first = loaded && view.state === "none" && servers === 0;
  const running = view.state === "running";

  // Only what the pill beside it does not already say.
  const meta =
    !loaded || running || view.state === "complete" ? "" :
    view.state === "none" ? (servers ? "not recorded" : "not run yet") :
    view.state === "partial" ? "finished with gaps" :
    "stopped";
  const tone = running || view.state === "complete" ? "ok" : view.state === "none" ? "neutral" : "warn";

  return (
    <section data-setup-sync>
      <PanelHeader title={first ? "First sync from GridPane" : "Sync from GridPane"} meta={meta || undefined}>
        {loaded && <StatusPill tone={running ? "live" : tone}>{running ? "Syncing" : view.state === "none" ? "Not yet" : view.state === "complete" ? "Done" : "Needs a look"}</StatusPill>}
      </PanelHeader>

      <div className="flex flex-col gap-4 py-4">
        {!available && (
          <Callout tone="warning" title="The sync record is missing">
            The database has no sync_runs table, so a sync&rsquo;s progress cannot be shown here or in the top bar. Syncing
            still works. Apply supabase/migrations/20261124000000_sync_runs.sql (SETUP.md, step 4).
          </Callout>
        )}

        {running ? (
          <div className="flex flex-col gap-2.5" role="status">
            <p className="text-[13px] font-semibold text-foreground">{view.title}</p>
            {view.percent !== null && <Meter value={view.percent} />}
            <p className="max-w-[65ch] text-[12.5px] leading-relaxed text-pretty text-muted-foreground">{view.detail}</p>
            {isTaskRunning && (
              <div>
                <Button size="sm" variant="ghost" onClick={() => setIsModalOpen(true)}>Show this tab&rsquo;s log</Button>
              </div>
            )}
          </div>
        ) : first ? (
          <div className="flex max-w-[65ch] flex-col gap-3 text-[13px] leading-relaxed text-pretty text-foreground">
            <p>{tie("Fleet reads your servers and sites from GridPane, then each site’s own record for its backups, PHP and caching settings. Nothing starts until you press the button.")}</p>
            <p className="text-muted-foreground">
              {tie(`GridPane lets Fleet read about one site every 10 seconds, so 100 sites take ${syncDuration(100)}. It cannot go faster: asking sooner makes GridPane wait longer.`)}
            </p>
            <p className="text-muted-foreground">
              {tie("It runs in this browser tab. Move around Fleet while it runs, but keep this tab open until it finishes: closing the tab stops it. What it has saved stays saved, and the next sync reads the rest.")}
            </p>
            <p className="text-muted-foreground">
              {tie("While it runs, a blinking dot in the top bar shows it on every screen you are signed in on, and this page shows its progress.")}
            </p>
          </div>
        ) : (
          loaded && (
            <div className="flex flex-col gap-1">
              <p className="text-[13px] font-semibold text-foreground">{view.state === "none" ? "No sync recorded yet" : view.title}</p>
              <p className="max-w-[65ch] text-[12.5px] leading-relaxed text-pretty text-muted-foreground">
                {view.state === "none"
                  ? tie(`The database holds ${servers ?? "some"} servers from a sync that ran before syncs were recorded. The next sync is recorded here.`)
                  : view.detail}
              </p>
            </div>
          )
        )}

        {!running && loaded && (
          <div className="flex flex-wrap items-center gap-3">
            <Button variant={first ? "solid" : "ghost"} onClick={startSync} disabled={isTaskRunning} data-setup-start-sync>
              <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" /> {first ? "Start the first sync" : "Sync now"}
            </Button>
            {isTaskRunning && <span className="text-[12px] text-muted-foreground">Another task is running in this tab.</span>}
          </div>
        )}

        <CodeBlock
          kind="command"
          label="Follow a sync from a terminal"
          code={WATCH}
          footnote={tie("Run it in your copy of Fleet, or have your AI agent run it: it only reads. It prints a line as the sync moves and ends when the sync does. npm run sync starts one from the terminal instead; it shows here the same way.")}
        />
        {first && (
          <p className="text-[12px] text-muted-foreground">
            The guide&rsquo;s step for this is SETUP.md, step 6. <Link href="/" className="text-primary underline-offset-4 hover:underline">Back to the overview</Link>
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * The overview's pointer to the setup page, shown only until Fleet has read
 * GridPane once: no server stored and no sync recorded, or the first sync running.
 */
export function FirstRunBanner() {
  const { view, loaded } = useSyncRun();
  const servers = useServerCount();
  if (!loaded || servers === null || servers > 0) return null;
  if (view.state === "running") {
    return (
      <Callout tone="note" live title="The first sync is running" className="mb-6" action={<Link href="/settings/setup" className="eyebrow text-primary underline-offset-4 hover:underline">Progress</Link>}>
        {view.title.replace(/^Syncing: /, "Now: ")}. Keep the tab that started it open until it finishes.
      </Callout>
    );
  }
  return (
    <Callout
      tone="note"
      title="Fleet has not read your GridPane account yet"
      className="mb-6"
      action={
        <Link href="/settings/setup" className={buttonClasses({ variant: "solid" })}>
          Set up Fleet
        </Link>
      }
    >
      The setup page starts the first sync when you are ready, says what to expect, and lists what else can be set up.
    </Callout>
  );
}
