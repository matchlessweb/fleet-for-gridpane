"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { createClient } from "@/lib/supabase/client";
import {
  DEFAULT_THRESHOLDS,
  thresholdsFromRow,
  type Thresholds,
} from "@/lib/thresholds";

type SettingsContextValue = {
  thresholds: Thresholds;
  /** False until the row has been fetched once — lets a form avoid rendering
   *  the fallback values as if they were the saved ones. */
  loaded: boolean;
  /** Push a saved set into context so every meter recolours without a reload. */
  applyThresholds: (next: Thresholds) => void;
  refresh: () => Promise<void>;
};

const SettingsContext = createContext<SettingsContextValue | undefined>(undefined);

/**
 * Loads the single `app_settings` row once for the whole dashboard.
 *
 * Deliberately non-blocking: children render immediately against
 * DEFAULT_THRESHOLDS and recolour when the row arrives. Gating the dashboard on
 * a settings fetch would put a spinner in front of the fleet view to answer a
 * question nobody asked — and if the fetch fails, the old hardcoded rule is a
 * perfectly good answer, which is exactly what the defaults encode.
 */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const [thresholds, setThresholds] = useState<Thresholds>(DEFAULT_THRESHOLDS);
  const [loaded, setLoaded] = useState(false);

  /** The saved thresholds, or null when the row could not be read. */
  const read = useCallback(async (): Promise<Thresholds | null> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("app_settings")
      .select("cpu_warn, cpu_critical, memory_warn, memory_critical, disk_warn, disk_critical")
      .eq("id", 1)
      .maybeSingle();

    // No toast on failure. This runs on every dashboard mount, and a settings
    // read that fails is invisible to the operator's actual task — the meters
    // simply keep the default rule. Errors that matter surface on save.
    return !error && data ? thresholdsFromRow(data) : null;
  }, []);

  const show = useCallback((saved: Thresholds | null) => {
    if (saved) setThresholds(saved);
    setLoaded(true);
  }, []);

  const refresh = useCallback(async () => show(await read()), [read, show]);

  useEffect(() => {
    void read().then(show);
  }, [read, show]);

  const applyThresholds = useCallback((next: Thresholds) => setThresholds(next), []);

  return (
    <SettingsContext.Provider value={{ thresholds, loaded, applyThresholds, refresh }}>
      {children}
    </SettingsContext.Provider>
  );
}

/**
 * Thresholds for the current fleet.
 *
 * Falls back to the defaults rather than throwing when used outside the
 * provider: `Meter` is a leaf primitive that also renders in places the
 * dashboard layout does not wrap, and a missing provider should mean "use the
 * standard rule", never a crashed page.
 */
export function useThresholds(): Thresholds {
  return useContext(SettingsContext)?.thresholds ?? DEFAULT_THRESHOLDS;
}

/** Full context for the settings form. Throws, because a form that cannot
 *  publish its save back to the tree is a bug, not a fallback case. */
export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used inside <SettingsProvider>");
  return ctx;
}
