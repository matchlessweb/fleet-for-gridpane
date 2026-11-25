"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Callout, Figure, Figures, PageHeader, PanelHeader, Select, Skeleton } from "@/components/ui";
import { FirewallTabs } from "@/components/security/firewall-tabs";
import { RunMissing, RunStamp, RunStampSkeleton, useLatestWafRun } from "@/components/cloudflare/run-stamp";
import { FindingsList, ZonePills, zoneHref } from "@/components/cloudflare/zone-posture";
import {
  KLASS_META,
  KLASS_ORDER,
  PROFILE_LABEL,
  ZONE_SUMMARY_COLUMNS,
  fleetSection,
  profileLabel,
  SITE_REF_COLUMNS,
  siteRefs,
  siteRefText,
  sitesByZone,
  tie,
  type FleetSectionKey,
  type SiteRef,
  type WafProfile,
  type ZoneSummary,
} from "@/lib/cloudflare-waf";

const SECTIONS: { key: FleetSectionKey; title: string; lede: string }[] = [
  {
    key: "findings",
    title: "Off standard, with differences\u00a0listed",
    lede: "Each line is one difference between the zone's rules and the profile it was compared against.",
  },
  {
    key: "custom",
    title: "Own rules",
    lede: "Their own rule sets, with nothing listed against a profile.",
  },
  {
    key: "none",
    title: "No custom rules",
    lede: "No WAF custom rules at all. Parked and unused domains belong here; a live site does not.",
  },
  {
    key: "standard",
    title: "On standard",
    lede: "Every clause matches the zone's profile.",
  },
];

const PROFILE_FILTERS: { value: string; label: string }[] = [
  { value: "all", label: "All profiles" },
  { value: "wordpress", label: PROFILE_LABEL.wordpress },
  { value: "static", label: PROFILE_LABEL.static },
  { value: "dev", label: PROFILE_LABEL.dev },
  { value: "none", label: "No profile" },
];

const PROFILE_SORT: Record<string, number> = { wordpress: 0, static: 1, dev: 2, none: 3 };

function ZoneRow({ zone, sites, showFindings }: { zone: ZoneSummary; sites: SiteRef[]; showFindings: boolean }) {
  return (
    <li data-waf-row={zone.name} className="border-b border-border py-3.5 last:border-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Link
          href={zoneHref(zone.name)}
          className="min-w-0 text-[13.5px] font-semibold text-foreground underline decoration-line-strong underline-offset-[3px] transition-colors duration-150 [overflow-wrap:anywhere] hover:decoration-primary"
        >
          {zone.name}
        </Link>
        <ZonePills zone={zone} />
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">
          {`${zone.nrules} ${zone.nrules === 1 ? "rule" : "rules"} · ${zone.ruleset_updated ? `changed ${zone.ruleset_updated}` : "never set"}`}
        </span>
      </div>

      <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
        {sites.length === 0 ? (
          <span data-waf-no-site>No GridPane site</span>
        ) : (
          <>
            {sites.length === 1 ? "Site: " : `${sites.length} sites: `}
            {sites.map((s, i) => (
              <span key={s.id}>
                {i > 0 && ", "}
                <Link
                  href={`/sites/${s.id}`}
                  className="font-medium text-foreground underline decoration-primary decoration-[1.5px] underline-offset-[3px] hover:decoration-2"
                >
                  {siteRefText(s, sites)}
                </Link>
              </span>
            ))}
          </>
        )}
        {zone.account ? ` · ${tie(zone.account)}` : ""}
      </p>

      {showFindings && zone.findings.length > 0 && (
        <div className="mt-2.5">
          <FindingsList findings={zone.findings} limit={3} />
        </div>
      )}
    </li>
  );
}

/**
 * Fleet-wide Cloudflare WAF posture.
 *
 * The question this answers is "which zones are off standard, and how", so the
 * zones with differences come first, then own-rule zones, then zones with no
 * rules; the conforming majority is last.
 *
 * Every zone in the inventory is listed, whether or not it lines up with a
 * GridPane site. Zones with no matching GridPane site, such as Pages sites,
 * parked domains or zones in other accounts, are still listed: a WAF page that
 * dropped those would hide exactly the zones nobody is watching. The counts at the top say how many rows there are,
 * so a missing zone shows up as a wrong number.
 */
export default function CloudflareWafPage() {
  const supabase = useMemo(() => createClient(), []);
  const runState = useLatestWafRun();
  const [zones, setZones] = useState<ZoneSummary[] | null>(null);
  const [sites, setSites] = useState<SiteRef[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState("all");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [zoneRes, siteRes] = await Promise.all([
        supabase.from("cloudflare_zones").select(ZONE_SUMMARY_COLUMNS).order("name"),
        supabase.from("sites").select(SITE_REF_COLUMNS).order("url"),
      ]);
      if (cancelled) return;
      if (zoneRes.error) setError(zoneRes.error.message);
      if (siteRes.error) console.error("Sites fetch failed", siteRes.error);
      setZones((zoneRes.data as unknown as ZoneSummary[] | null) ?? []);
      setSites(siteRefs(siteRes.data));
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  const join = useMemo(
    () => sitesByZone(sites, (zones ?? []).map((z) => z.name)),
    [sites, zones]
  );

  const shown = useMemo(
    () => (zones ?? []).filter((z) => profile === "all" || (z.profile ?? "none") === profile),
    [zones, profile]
  );

  const sections = useMemo(() => {
    const out: Record<FleetSectionKey, ZoneSummary[]> = { findings: [], custom: [], none: [], standard: [] };
    for (const z of shown) out[fleetSection(z)].push(z);
    out.findings.sort(
      (a, b) =>
        KLASS_ORDER.indexOf(a.klass) - KLASS_ORDER.indexOf(b.klass) ||
        b.findings.length - a.findings.length ||
        a.name.localeCompare(b.name)
    );
    out.standard.sort(
      (a, b) =>
        PROFILE_SORT[a.profile ?? "none"] - PROFILE_SORT[b.profile ?? "none"] || a.name.localeCompare(b.name)
    );
    return out;
  }, [shown]);

  if (runState.status === "loading" || zones === null) {
    return (
      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-4">
          <PageHeader title="Cloudflare WAF" stamp="Loading" />
          <FirewallTabs />
        </div>
        <RunStampSkeleton />
        <section aria-busy="true">
          <PanelHeader title="Where the fleet stands" meta="Loading" />
          <Figures cols={5} longLabels className="pt-5">
            {KLASS_ORDER.map((k) => (
              <Figure key={k} label={KLASS_META[k].label} value={null} note={tie(KLASS_META[k].meaning)} />
            ))}
          </Figures>
        </section>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (runState.status !== "ready") {
    return (
      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-4">
          <PageHeader title="Cloudflare WAF" />
          <FirewallTabs />
        </div>
        <RunMissing state={runState} />
      </div>
    );
  }

  const run = runState.run;
  const all = zones;
  const matched = all.filter((z) => (join.byZone.get(z.name)?.length ?? 0) > 0).length;
  const withFindings = all.filter((z) => z.findings.length > 0).length;
  const countMismatch = all.length !== run.zone_count;

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-4">
        <PageHeader title="Cloudflare WAF" stamp={`${all.length} zones`} />
        <FirewallTabs />
      </div>

      <RunStamp run={run} />

      {(error || countMismatch) && (
        <Callout tone="danger" title={error ? "The zone list could not be read" : "The zone list is incomplete"}>
          {error ? (
            <span className="[overflow-wrap:anywhere]">{error}</span>
          ) : (
            `This run recorded ${run.zone_count} zones but ${all.length} are listed here. Load the run again.`
          )}
        </Callout>
      )}

      {/* Class board */}
      <section>
        <PanelHeader title="Where the fleet stands" meta={`${withFindings} zones with differences`} />
        <Figures cols={5} longLabels className="pt-5">
          {KLASS_ORDER.map((k) => {
            const n = all.filter((z) => z.klass === k).length;
            const meta = KLASS_META[k];
            return (
              <Figure
                key={k}
                data-waf-klass={k}
                label={meta.label}
                value={n}
                tone={n > 0 && meta.tone === "warn" ? "warn" : n > 0 && meta.tone === "danger" ? "danger" : "default"}
                note={tie(meta.meaning)}
              />
            );
          })}
        </Figures>
        <p data-waf-join className="text-pretty mt-4 text-[12.5px] leading-relaxed text-muted-foreground">
          {tie(
            `${matched} of ${all.length} zones line up with a GridPane site by hostname. The other ${all.length - matched} are listed all the same: Pages sites, parked domains and client-owned zones have rules too.`
          )}
          {join.unmatchedSites.length > 0 && (
            <>
              {` ${join.unmatchedSites.length === 1 ? "One GridPane site has" : `${join.unmatchedSites.length} GridPane sites have`} no zone in this inventory: `}
              {join.unmatchedSites.map((s, i) => (
                <span key={s.id}>
                  {i > 0 && ", "}
                  <Link
                    href={`/sites/${s.id}`}
                    className="font-medium text-foreground underline decoration-primary decoration-[1.5px] underline-offset-[3px] hover:decoration-2"
                  >
                    {siteRefText(s, join.unmatchedSites)}
                  </Link>
                </span>
              ))}
              .
            </>
          )}
        </p>
      </section>

      {/* Filter */}
      <div className="flex flex-wrap items-center gap-3 border-t border-line-strong pt-6">
        <label htmlFor="waf-profile" className="eyebrow text-muted-foreground">
          Profile
        </label>
        <Select
          id="waf-profile"
          value={profile}
          onChange={(e) => setProfile(e.target.value)}
          className="font-medium"
        >
          {PROFILE_FILTERS.map((p) => {
            const n =
              p.value === "all"
                ? all.length
                : all.filter((z) => (z.profile ?? "none") === p.value).length;
            return (
              <option key={p.value} value={p.value}>
                {`${p.label} (${n})`}
              </option>
            );
          })}
        </Select>
        <span data-waf-shown className="font-mono text-[11px] text-muted-foreground">
          {`Showing ${shown.length} of ${all.length}`}
        </span>
      </div>

      {SECTIONS.map((section) => {
        const rows = sections[section.key];
        let lastProfile: string | undefined;
        return (
          <section key={section.key} data-waf-section={section.key}>
            <PanelHeader title={section.title} meta={`${rows.length} ${rows.length === 1 ? "zone" : "zones"}`} />
            <p className="text-pretty pt-3 text-[12.5px] leading-relaxed text-muted-foreground">
              {tie(section.lede)}
            </p>
            {rows.length === 0 ? (
              <p className="pt-3 text-[12.5px] text-muted-foreground">
                {profile === "all" ? "No zones." : "No zones on this profile."}
              </p>
            ) : (
              <ul className="mt-1">
                {rows.map((z) => {
                  const key = (z.profile ?? "none") as WafProfile | "none";
                  const head = section.key === "standard" && key !== lastProfile;
                  lastProfile = key;
                  return (
                    <Fragment key={z.zone_id}>
                      {head && (
                        <li className="eyebrow border-b border-border pb-2 pt-5 text-muted-foreground">
                          {profileLabel(z.profile)}
                        </li>
                      )}
                      <ZoneRow
                        zone={z}
                        sites={join.byZone.get(z.name) ?? []}
                        showFindings={section.key === "findings"}
                      />
                    </Fragment>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
