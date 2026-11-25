"use client";

import { use, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Callout, DetailHeader, Skeleton, buttonClasses } from "@/components/ui";
import { RunMissing, RunStamp, RunStampSkeleton, useLatestWafRun } from "@/components/cloudflare/run-stamp";
import { ZonePills, ZonePosture } from "@/components/cloudflare/zone-posture";
import { normalizeHost, SITE_REF_COLUMNS, siteRefs, sitesByZone, type SiteRef, type ZoneDetail } from "@/lib/cloudflare-waf";

/**
 * One Cloudflare zone. This page exists because most zones have no GridPane
 * site to hang their rules on: a zone is a first-class thing here, reachable
 * by its own name.
 */
export default function CloudflareZonePage({ params }: { params: Promise<{ zone: string }> }) {
  const { zone: rawZone } = use(params);
  const name = normalizeHost(decodeURIComponent(rawZone));
  const supabase = useMemo(() => createClient(), []);
  const runState = useLatestWafRun();
  const [zone, setZone] = useState<ZoneDetail | null | undefined>(undefined);
  const [sites, setSites] = useState<SiteRef[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [zoneRes, namesRes, siteRes] = await Promise.all([
        supabase.from("cloudflare_zones").select("*").eq("name", name).limit(1),
        supabase.from("cloudflare_zones").select("name"),
        supabase.from("sites").select(SITE_REF_COLUMNS).order("url"),
      ]);
      if (cancelled) return;
      if (zoneRes.error) setError(zoneRes.error.message);
      const found = (zoneRes.data?.[0] as ZoneDetail | undefined) ?? null;
      // Match against every zone name, not just this one, so a site that
      // belongs to a longer zone name is not claimed by a shorter one.
      const names = (namesRes.data ?? []).map((r) => r.name as string);
      const { byZone } = sitesByZone(siteRefs(siteRes.data), names);
      setSites(byZone.get(name) ?? []);
      setZone(found);
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, name]);

  return (
    <div className="flex flex-col gap-8">
      <DetailHeader
        title={name}
        phoneFactLines={2}
        status={
          zone === undefined ? (
            <span aria-hidden="true" className="block h-[21px] w-24 animate-pulse rounded-sm bg-panel-2" />
          ) : zone ? (
            <ZonePills zone={zone} />
          ) : undefined
        }
        facts={
          zone === undefined
            ? null
            : zone
              ? [
                  "Cloudflare zone",
                  zone.account,
                  zone.plan,
                  <>
                    {zone.nrules}{" "}
                    {zone.nrules === 1 ? "rule" : "rules"}
                  </>,
                  <>
                    {sites.length}{" "}
                    {sites.length === 1 ? "site" : "sites"}
                  </>,
                ]
              : ["Cloudflare zone", runState.status === "ready" && "not in the inventory"]
        }
      />

      {runState.status === "loading" || zone === undefined ? (
        <>
          <RunStampSkeleton />
          <Skeleton className="h-64 w-full" />
        </>
      ) : runState.status !== "ready" ? (
        <RunMissing state={runState} />
      ) : (
        <>
          <RunStamp run={runState.run} />
          {error ? (
            <Callout tone="danger" title="The zone could not be read">
              <span className="[overflow-wrap:anywhere]">{error}</span>
            </Callout>
          ) : zone ? (
            <ZonePosture zone={zone} sites={sites} />
          ) : (
            <Callout
              data-waf-zone-missing
              title="This zone is not in the inventory"
              action={
                <Link href="/firewall/cloudflare" className={buttonClasses({ size: "sm" })}>
                  See every zone
                </Link>
              }
            >
              {`None of the ${runState.run.zone_count} zones in this run is named ${name}.`}
            </Callout>
          )}
        </>
      )}
    </div>
  );
}
