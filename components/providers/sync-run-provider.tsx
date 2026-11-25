"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { describeSyncRun, isStale, type SyncRun, type SyncView } from "@/lib/sync-runs";

/** Dispatched on window when this tab starts, continues or ends a sync: read the record now. */
export const SYNC_RUN_CHANGED = "sync_run_changed";
/** Dispatched on window when a sync this screen saw running has ended, in any tab or from the command line. */
export const SYNC_RUN_ENDED = "sync_run_ended";

type SyncRunState = {
  /** The newest sync record, or null when none has ever started. */
  run: SyncRun | null;
  view: SyncView;
  /** False until the first read answers. */
  loaded: boolean;
  /** False when the database has no sync_runs table (the migration is not applied yet). */
  available: boolean;
  refresh: () => void;
};

const SyncRunContext = createContext<SyncRunState | null>(null);

// Every few seconds while a sync runs, so the count in the top bar moves; once a
// minute otherwise, so a sync started elsewhere shows up without a reload.
const RUNNING_EVERY_MS = 4_000;
const IDLE_EVERY_MS = 60_000;

/**
 * Reads the newest sync record (public.sync_runs) for every screen: the top-bar
 * indicator, the setup page and the overview. One read for all of them. Nothing
 * is read while the tab is hidden.
 */
export function SyncRunProvider({ children }: { children: React.ReactNode }) {
  const supabase = useMemo(() => createClient(), []);
  const [run, setRun] = useState<SyncRun | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [available, setAvailable] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasRunning = useRef<string | null>(null);
  const inFlight = useRef(false);

  const read = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const { data, error } = await supabase
        .from("sync_runs")
        .select("*")
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const t = Date.now();
      setNow(t);
      if (error) {
        // PGRST205 / 42P01: no such table. Anything else: keep what we had and try again later.
        if (error.code === "PGRST205" || error.code === "42P01") setAvailable(false);
        setLoaded(true);
        return;
      }
      const next = (data as SyncRun | null) ?? null;
      setAvailable(true);
      setRun(next);
      setLoaded(true);
      const runningId = next && next.status === "running" && !isStale(next, t) ? next.id : null;
      if (wasRunning.current && wasRunning.current !== runningId) {
        window.dispatchEvent(new Event(SYNC_RUN_ENDED));
      }
      wasRunning.current = runningId;
    } finally {
      inFlight.current = false;
    }
  }, [supabase]);

  // One loop: read, then wait (short while a sync runs, long otherwise), then read again.
  // A read asked for from outside (a tab started a sync, the tab came back into view)
  // restarts the wait.
  const refreshRef = useRef<() => void>(() => {});
  useEffect(() => {
    let stopped = false;
    const loop = async () => {
      if (timer.current) clearTimeout(timer.current);
      if (document.visibilityState === "visible") await read();
      if (stopped) return;
      // Two loops can overlap (an outside read while one waits on the database): keep one timer.
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(loop, wasRunning.current ? RUNNING_EVERY_MS : IDLE_EVERY_MS);
    };
    refreshRef.current = () => void loop();
    void loop();
    const onVisible = () => { if (document.visibilityState === "visible") void loop(); };
    const onChanged = () => void loop();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(SYNC_RUN_CHANGED, onChanged);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(SYNC_RUN_CHANGED, onChanged);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [read]);
  const refresh = useCallback(() => refreshRef.current(), []);

  const value = useMemo<SyncRunState>(
    () => ({ run, view: describeSyncRun(run, now), loaded, available, refresh }),
    [run, now, loaded, available, refresh]
  );
  return <SyncRunContext.Provider value={value}>{children}</SyncRunContext.Provider>;
}

export function useSyncRun(): SyncRunState {
  const ctx = useContext(SyncRunContext);
  if (!ctx) throw new Error("useSyncRun must be used inside SyncRunProvider");
  return ctx;
}
