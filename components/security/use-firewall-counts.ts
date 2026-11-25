"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { FirewallSectionKey } from "./firewall-sections";

export type FirewallCounts = Partial<Record<FirewallSectionKey, number>>;

/* One read shared by the masthead menu and the tab row, kept for five
   minutes: three head-only counts, no rows. */
const TTL_MS = 5 * 60_000;
let cached: { at: number; counts: FirewallCounts } | null = null;
let inflight: Promise<FirewallCounts> | null = null;

function fresh(): FirewallCounts | null {
  return cached && Date.now() - cached.at < TTL_MS ? cached.counts : null;
}

async function load(): Promise<FirewallCounts> {
  const supabase = createClient();
  const head = { count: "exact" as const, head: true };
  const [servers, zones, sites] = await Promise.all([
    supabase.from("servers").select("id", head),
    supabase.from("cloudflare_zones").select("name", head),
    supabase.from("sites").select("id", head),
  ]);
  // A failed count is left out, not shown as zero.
  const counts: FirewallCounts = {};
  if (!servers.error && servers.count != null) counts.servers = servers.count;
  if (!zones.error && zones.count != null) counts.cloudflare = zones.count;
  if (!sites.error && sites.count != null) counts.waf = sites.count;
  return counts;
}

/** Counts for the Firewall pages. Pass `enabled: false` to wait (the menu reads them on first open). */
export function useFirewallCounts(enabled = true): FirewallCounts | null {
  const [counts, setCounts] = useState<FirewallCounts | null>(fresh);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const hit = fresh();
    const pending = hit
      ? Promise.resolve(hit)
      : (inflight ??= load()
          .then((c) => {
            cached = { at: Date.now(), counts: c };
            return c;
          })
          .catch(() => ({}) as FirewallCounts)
          .finally(() => {
            inflight = null;
          }));
    pending.then((c) => {
      if (live) setCounts(c);
    });
    return () => {
      live = false;
    };
  }, [enabled]);

  return counts;
}
