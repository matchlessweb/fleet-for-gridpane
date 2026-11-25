/**
 * The record of a GridPane sync (table public.sync_runs, migration
 * 20261124000000_sync_runs.sql): what every signed-in screen, the command-line
 * sync and `npm run sync:status` read to know whether a sync is running, how far
 * it has got and how the last one ended.
 *
 * Imported by the app (as "@/lib/sync-runs") and by scripts run with
 * node --experimental-strip-types (as "../lib/sync-runs.ts"), so it uses no path
 * aliases and nothing TypeScript-only at run time.
 *
 * Only the service writes the table. The helpers that write take its client.
 */

export type SyncRunStatus = "running" | "complete" | "partial" | "failed" | "stopped";
export type SyncRunSource = "app" | "cli";
/** Where a running sync is: servers, then the site list, then each site's own record. */
export type SyncPhase = "starting" | "servers" | "sites" | "details" | "done";

export type SyncRun = {
  id: string;
  source: SyncRunSource;
  status: SyncRunStatus;
  phase: string;
  started_by: string | null;
  started_at: string;
  heartbeat_at: string;
  finished_at: string | null;
  servers_saved: number | null;
  sites_total: number | null;
  sites_done: number;
  sites_read: number;
  schedules: number;
  errors: number;
  message: string | null;
};

/** What a running sync may report as it goes. */
export type SyncProgress = Partial<Pick<SyncRun, "phase" | "servers_saved" | "sites_total" | "sites_done" | "sites_read" | "schedules" | "errors" | "message">>;

/**
 * A running sync that has not reported for this long has stopped. The app's sync
 * reports at least every ten sites and at the end of every pass (a pass is cut
 * off at about four minutes); the command-line sync reports every ten sites, and
 * may wait a minute for GridPane. Six minutes covers both with room to spare.
 */
export const SYNC_STALE_AFTER_MS = 6 * 60_000;

/** GridPane lets a sync read about one site every 11 seconds; the setup page says so. */
export const SECONDS_PER_SITE = 11;

export function isStale(run: Pick<SyncRun, "status" | "heartbeat_at">, now: number): boolean {
  if (run.status !== "running") return false;
  const beat = Date.parse(run.heartbeat_at);
  return !Number.isFinite(beat) || now - beat > SYNC_STALE_AFTER_MS;
}

/** "just now", "4 min ago", "2 h ago", "3 days ago". */
export function ago(iso: string | null | undefined, now: number): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "at an unknown time";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** "about 20 minutes" for a fleet of this many sites, at GridPane's pace. */
export function syncDuration(sites: number): string {
  const minutes = Math.max(1, Math.round((sites * SECONDS_PER_SITE) / 60));
  if (minutes < 2) return "about a minute";
  if (minutes < 90) return `about ${minutes} minutes`;
  const hours = Math.round(minutes / 6) / 10;
  return `about ${hours} hours`;
}

export type SyncView = {
  /** "none" until the first sync starts. "stalled" is running with no word for SYNC_STALE_AFTER_MS. */
  state: "none" | "running" | "stalled" | SyncRunStatus;
  /** One short line: "Syncing: 34 of 101 sites". */
  title: string;
  /** One sentence under it. */
  detail: string;
  /** 0 to 100 while the site count is known, else null. */
  percent: number | null;
};

const PHASE_TEXT: Record<string, string> = {
  starting: "Starting",
  servers: "Reading your servers",
  sites: "Reading the site list",
  details: "Reading each site",
  done: "Finishing",
};

const where = (run: SyncRun) => (run.source === "cli" ? "from the command line" : "in the app");

/** What a screen (or sync:status) says about the newest sync record. */
export function describeSyncRun(run: SyncRun | null, now: number): SyncView {
  if (!run) {
    // Says only what the record knows: servers may be stored from a sync that ran before syncs were recorded.
    return { state: "none", title: "No sync recorded yet", detail: "The next sync, from the app or npm run sync, is recorded here.", percent: null };
  }
  const total = run.sites_total ?? null;
  const percent = total && total > 0 ? Math.min(100, Math.round((run.sites_done / total) * 100)) : null;
  const unread = total !== null ? Math.max(0, total - run.sites_read) : 0;

  if (run.status === "running" && isStale(run, now)) {
    return {
      state: "stalled",
      title: "Sync stopped reporting",
      detail: `The sync started ${where(run)} ${ago(run.started_at, now)} has not reported since ${ago(run.heartbeat_at, now)}. ${run.source === "app" ? "The tab that ran it was probably closed. " : ""}What it saved stays saved: run Sync again to finish.`,
      percent,
    };
  }
  if (run.status === "running") {
    const phase = PHASE_TEXT[run.phase] ?? "Working";
    const title = run.phase === "details" && total ? `Syncing: ${run.sites_done} of ${total} sites` : `Syncing: ${phase.toLowerCase()}`;
    const left = total && run.phase === "details" ? Math.max(0, total - run.sites_done) : null;
    const detail = `Started ${where(run)} ${ago(run.started_at, now)}.${left ? ` ${syncDuration(left).replace(/^about/, "About")} left.` : ""}${run.source === "app" ? " It runs in the tab that started it: keep that tab open." : ""}`;
    return { state: "running", title, detail, percent };
  }
  const when = ago(run.finished_at ?? run.heartbeat_at, now);
  if (run.status === "complete") {
    return {
      state: "complete",
      title: "Last sync complete",
      detail: `Finished ${when}: ${run.sites_read} of ${total ?? run.sites_read} sites read${run.servers_saved !== null ? `, ${run.servers_saved} servers` : ""}.`,
      percent: 100,
    };
  }
  if (run.status === "partial") {
    return {
      state: "partial",
      title: "Last sync finished with gaps",
      detail: `Finished ${when}: ${run.sites_read} of ${total ?? "?"} sites read${unread ? `, ${unread} not read (GridPane refused them or did not answer)` : ""}${run.errors ? `, ${run.errors} error${run.errors === 1 ? "" : "s"}` : ""}. Run it again later to read the rest.`,
      percent,
    };
  }
  if (run.status === "failed") {
    return { state: "failed", title: "Last sync failed", detail: `${when}: ${run.message || "no reason was recorded."}`, percent };
  }
  return { state: "stopped", title: "Last sync stopped", detail: `${when}: ${run.message || "it stopped before the end."} What it saved stays saved.`, percent };
}

/** How a sync that reached the end is recorded: complete only if every site was read without an error. */
export function finishedStatus(c: { sitesTotal: number; sitesRead: number; errors: number }): "complete" | "partial" {
  return c.errors === 0 && c.sitesRead >= c.sitesTotal ? "complete" : "partial";
}

// ── Writing (service client only) ──────────────────────────────────────────

/** The few calls the helpers make, so any Supabase client (typed or not) fits. */
type Reply<T> = PromiseLike<{ data: T | null; error: { message: string; code?: string } | null }>;
type Filter<T> = Reply<T> & {
  eq(column: string, value: unknown): Filter<T>;
  lt(column: string, value: unknown): Filter<T>;
  order(column: string, o: { ascending: boolean }): Filter<T>;
  limit(n: number): Filter<T>;
  select(columns?: string): Filter<T>;
  maybeSingle(): Reply<T>;
  single(): Reply<T>;
};
export type SyncDb = {
  from(table: "sync_runs"): {
    select(columns?: string): Filter<SyncRun[]>;
    insert(row: Record<string, unknown>): Filter<SyncRun[]>;
    update(row: Record<string, unknown>): Filter<SyncRun[]>;
  };
};

export type OpenResult =
  | { ok: true; run: SyncRun }
  | { ok: false; busy: SyncRun; error?: undefined }
  | { ok: false; busy?: undefined; error: string };

/**
 * Starts the record of a new sync. A running record that has gone silent is
 * closed as stopped first. If another sync is running, nothing is started and
 * that sync is returned as busy. Two calls at once cannot both start: the
 * table admits one running row.
 */
export async function openSyncRun(db: SyncDb, opts: { source: SyncRunSource; startedBy?: string | null; now?: number }): Promise<OpenResult> {
  const now = opts.now ?? Date.now();
  const cutoff = new Date(now - SYNC_STALE_AFTER_MS).toISOString();
  const nowIso = new Date(now).toISOString();
  const closed = await db
    .from("sync_runs")
    .update({ status: "stopped", finished_at: nowIso, message: "It stopped reporting, so the next sync closed it." })
    .eq("status", "running")
    .lt("heartbeat_at", cutoff);
  if (closed.error) return { ok: false, error: `The sync record could not be read: ${closed.error.message}` };

  const made = await db
    .from("sync_runs")
    .insert({ source: opts.source, started_by: opts.startedBy ?? null, started_at: nowIso, heartbeat_at: nowIso })
    .select()
    .single();
  if (!made.error && made.data) return { ok: true, run: made.data as unknown as SyncRun };

  if (made.error?.code === "23505") {
    const running = await db.from("sync_runs").select().eq("status", "running").limit(1).maybeSingle();
    if (running.data) return { ok: false, busy: running.data as unknown as SyncRun };
  }
  return { ok: false, error: `The sync record could not be started: ${made.error?.message ?? "no row came back"}` };
}

/** Reports progress and moves the heartbeat. Only a record still running is changed. */
export async function touchSyncRun(db: SyncDb, id: string, progress: SyncProgress, now = Date.now()): Promise<string | null> {
  const r = await db
    .from("sync_runs")
    .update({ ...progress, heartbeat_at: new Date(now).toISOString() })
    .eq("id", id)
    .eq("status", "running");
  return r.error ? r.error.message : null;
}

/** Ends the record. A record already ended (by the next sync, after it went silent) is left as it is. */
export async function closeSyncRun(db: SyncDb, id: string, status: Exclude<SyncRunStatus, "running">, progress: SyncProgress = {}, now = Date.now()): Promise<string | null> {
  const iso = new Date(now).toISOString();
  const r = await db
    .from("sync_runs")
    .update({ ...progress, status, phase: "done", heartbeat_at: iso, finished_at: iso })
    .eq("id", id)
    .eq("status", "running");
  return r.error ? r.error.message : null;
}

/** The newest record, or null when no sync has ever started. */
export async function latestSyncRun(db: SyncDb): Promise<{ run: SyncRun | null; error: string | null }> {
  const r = await db.from("sync_runs").select().order("started_at", { ascending: false }).limit(1).maybeSingle();
  return { run: (r.data as unknown as SyncRun) ?? null, error: r.error ? r.error.message : null };
}
