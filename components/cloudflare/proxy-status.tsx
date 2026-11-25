"use client";

import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { hostProxy, zoneNameForHost, type HostProxy, type WafReach } from "@/lib/cloudflare-waf";

/**
 * Whether one hostname is proxied through Cloudflare, read from the daily
 * inventory. `undefined` while loading. The answer is evidence, not a default:
 * see hostProxy().
 */
export function useHostProxy(host: string | null | undefined): HostProxy | undefined {
  const supabase = useMemo(() => createClient(), []);
  const [status, setStatus] = useState<HostProxy | undefined>(undefined);

  useEffect(() => {
    if (!host) return;
    let cancelled = false;
    (async () => {
      const names = await supabase.from("cloudflare_zones").select("name");
      if (cancelled) return;
      const match = names.error ? null : zoneNameForHost(host, (names.data ?? []).map((r) => r.name as string));
      if (names.error) {
        setStatus({ state: "not-checked", label: "Could not check", meaning: "The Cloudflare inventory could not be read." });
        return;
      }
      if (!match) {
        setStatus(hostProxy(host, null));
        return;
      }
      const detail = await supabase.from("cloudflare_zones").select("name,reach").eq("name", match).limit(1);
      if (cancelled) return;
      const zone = detail.data?.[0] as { name: string; reach: WafReach | null } | undefined;
      setStatus(
        detail.error || !zone
          ? { state: "not-checked", label: "Could not check", meaning: "The Cloudflare inventory could not be read." }
          : hostProxy(host, zone)
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, host]);

  return status;
}

/**
 * The cloud Cloudflare's own DNS table uses to say the same thing: filled
 * orange when traffic goes through Cloudflare, grey when it does not, an
 * outline when there is no answer. Decorative; the words beside it carry it.
 */
export function ProxyCloud({ state, className }: { state: HostProxy["state"]; className?: string }) {
  const filled = state === "proxied" || state === "dns-only";
  return (
    <svg
      viewBox="0 0 24 16"
      aria-hidden="true"
      data-proxy-cloud={state}
      className={cn(
        "h-[14px] w-[21px] shrink-0",
        state === "proxied" && "text-[#F38020]",
        state === "dns-only" && "text-[#8A938D]",
        !filled && "text-faint",
        className
      )}
    >
      <path
        d="M6.5 15a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 17.4 5.1 5 5 0 0 1 18.5 15z"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth={filled ? 0 : 1.5}
        strokeDasharray={filled ? undefined : "2.5 2"}
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Cloud and words for one hostname, for a settings row. */
export function ProxyStatus({ status }: { status: HostProxy | undefined }) {
  if (!status) return <span className="text-[12.5px] text-muted-foreground">Checking…</span>;
  return (
    <span data-proxy-status={status.state} className="inline-flex min-w-0 items-center gap-2 text-[12.5px] font-semibold">
      <ProxyCloud state={status.state} />
      <span className="min-w-0">{status.label}</span>
    </span>
  );
}
