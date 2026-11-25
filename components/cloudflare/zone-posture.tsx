"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Check, ChevronRight, Copy, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { Button, Callout, Copyable, PanelHeader, Skeleton, StatusPill } from "@/components/ui";
import {
  ACTION_LABEL,
  KLASS_META,
  ROLE_LABEL,
  maskedValueCount,
  normalizeHost,
  profileLabel,
  reachMeta,
  siteRefText,
  tie,
  zoneNameForHost,
  type SiteRef,
  type WafRule,
  type ZoneDetail,
  type ZoneSummary,
} from "@/lib/cloudflare-waf";
import { RunMissing, RunStamp, useLatestWafRun } from "./run-stamp";

export const zoneHref = (name: string) => `/firewall/cloudflare/${encodeURIComponent(name)}`;

/** Class, profile and reach as pills. Shared by the fleet rows and the zone head. */
export function ZonePills({ zone, className }: { zone: ZoneSummary; className?: string }) {
  const klass = KLASS_META[zone.klass];
  const reach = reachMeta(zone.reach);
  const showReach = zone.reach?.reach !== "proxied";
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1.5", className)}>
      <StatusPill tone={klass.tone}>{klass.label}</StatusPill>
      {zone.profile ? (
        <StatusPill tone="neutral">{profileLabel(zone.profile)}</StatusPill>
      ) : zone.nearest ? (
        <StatusPill tone="neutral">Nearest: {profileLabel(zone.nearest)}</StatusPill>
      ) : null}
      {showReach && <StatusPill tone={reach.tone}>{reach.label}</StatusPill>}
      {zone.paused && <StatusPill tone="danger">Paused at Cloudflare</StatusPill>}
    </span>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border py-2.5">
      <span className="eyebrow text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right text-[12.5px] [overflow-wrap:anywhere]">{children}</span>
    </div>
  );
}

/**
 * One rule and its expression.
 *
 * The well is --sunken, which is ink-dark in both themes, so copied text always
 * comes off the same background. The expression wraps instead of scrolling
 * sideways: a 2,000-character line in a fixed-width box is what overflows a
 * phone first.
 *
 * Masking: the inventory replaces any opaque value of 20+ characters with its
 * length before the report is written (a rule on one zone matches on a build
 * key). Such an expression is flagged here, next to the copy control, because
 * it will not paste back into Cloudflare as it stands.
 */
function RuleItem({ rule, index, open }: { rule: WafRule; index: number; open: boolean }) {
  const [copied, setCopied] = useState(false);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const masked = rule.expr_masked;
  const maskedValues = maskedValueCount(rule.expr);

  useEffect(() => {
    if (detailsRef.current) detailsRef.current.open = open;
  }, [open]);

  const copy = async () => {
    const note = masked
      ? "Copied the masked expression. It will not paste back into Cloudflare as-is."
      : "Expression copied.";
    try {
      await navigator.clipboard.writeText(rule.expr);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
      if (masked) toast.warning(note);
      else toast.success(note);
    } catch {
      // A frame or an insecure origin can refuse the clipboard. Open the well
      // and select the text so a manual copy is one keystroke away.
      if (detailsRef.current) detailsRef.current.open = true;
      const pre = preRef.current;
      if (pre) {
        const range = document.createRange();
        range.selectNodeContents(pre);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      toast.message("The browser refused the clipboard. The expression is selected: copy it by hand.");
    }
  };

  return (
    <li data-waf-rule className="border-b border-border py-3.5 last:border-0">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1.5">
        <span className="font-mono text-[11.5px] tabular-nums text-muted-foreground">{index + 1}</span>
        <span className="min-w-0 text-[13px] font-semibold [overflow-wrap:anywhere]">
          {rule.desc || "Untitled rule"}
        </span>
        <StatusPill tone="neutral">{ACTION_LABEL[rule.action] ?? rule.action}</StatusPill>
        {!rule.enabled && <StatusPill tone="danger">Disabled</StatusPill>}
        {masked && (
          <StatusPill tone="warn" className="gap-1">
            <TriangleAlert size={11} strokeWidth={2} aria-hidden="true" />
            Masked
          </StatusPill>
        )}
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">
          {`${ROLE_LABEL[rule.role] ?? rule.role} · ${rule.chars.toLocaleString("en-US")} chars · ${rule.clauses.length} ${rule.clauses.length === 1 ? "clause" : "clauses"}`}
        </span>
      </div>

      {masked && (
        <p data-waf-masked-note className="text-pretty mt-2 text-[12.5px] leading-relaxed text-warning">
          {tie(
            `${maskedValues === 1 ? "One value in this expression was" : `${maskedValues} values in this expression were`} replaced by a length when the inventory was written, because a long opaque value can be a secret. Do not paste this back into Cloudflare: read the live rule there instead.`
          )}
        </p>
      )}

      {rule.skip_scope && (
        <p className="text-pretty mt-2 font-mono text-[11px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
          {tie(
            `Skips: ${rule.skip_scope.ruleset === "current" ? "the rest of this ruleset" : "no ruleset"}${rule.skip_scope.phases.length > 0 ? ` · phases ${rule.skip_scope.phases.join(", ")}` : ""}${rule.skip_scope.products.length > 0 ? ` · products ${rule.skip_scope.products.join(", ")}` : ""}`
          )}
        </p>
      )}

      <div className="mt-2.5 overflow-hidden rounded-md bg-sunken">
        <details ref={detailsRef} className="group">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-on-sunken-dim transition-colors duration-150 hover:text-on-sunken [&::-webkit-details-marker]:hidden">
            <ChevronRight
              size={14}
              strokeWidth={1.75}
              aria-hidden="true"
              className="shrink-0 transition-transform duration-150 group-open:rotate-90"
            />
            <span className="eyebrow">{masked ? "Expression · masked" : "Expression"}</span>
          </summary>
          <pre
            ref={preRef}
            data-waf-expr
            tabIndex={0}
            className="whitespace-pre-wrap border-t border-on-sunken-dim/25 px-3 py-3 font-mono text-[11px] leading-relaxed text-on-sunken [overflow-wrap:anywhere]"
          >
            {rule.expr}
          </pre>
        </details>
        <div className="flex items-center justify-between gap-3 border-t border-on-sunken-dim/25 px-3 py-1.5">
          <span className="eyebrow text-on-sunken-dim">
            {masked ? "Masked copy, not the live rule" : "Exact text"}
          </span>
          <button
            type="button"
            onClick={copy}
            aria-label={`Copy the ${masked ? "masked " : ""}expression of rule ${index + 1}, ${rule.desc}`}
            data-copied={copied || undefined}
            className="touch-hit eyebrow inline-flex items-center gap-1.5 rounded-sm px-2 py-1.5 text-on-sunken transition-colors duration-150 hover:bg-on-sunken-dim/20"
          >
            {/* The words stay put and the icon turns into a check, so the button keeps its width. */}
            {copied ? (
              <Check size={12} strokeWidth={2.25} aria-hidden="true" />
            ) : (
              <Copy size={12} strokeWidth={2} aria-hidden="true" />
            )}
            {masked ? "Copy masked" : "Copy"}
          </button>
          <span role="status" className="sr-only">
            {copied ? "Copied the expression" : ""}
          </span>
        </div>
      </div>
    </li>
  );
}

/**
 * A finding's last two words, kept on one line. `tie()` joins them with a non-breaking space, which
 * is not enough here: findings quote paths and rule text, and a browser still breaks after the
 * hyphen in `acme-challenge` or at a slash, leaving half a word alone on the last line. Only a pair
 * of 22 characters or fewer is made unbreakable, so it always fits its column (about 150px of this
 * type); a longer pair is tied as before and may still break inside a word.
 */
function TiedTail({ text, max = 22 }: { text: string; max?: number }) {
  const m = /^([\s\S]*\s)(\S+) (\S+)\s*$/.exec(text);
  if (!m || m[2].length + m[3].length > max) return <>{tie(text)}</>;
  return (
    <>
      {m[1]}
      <span className="whitespace-nowrap">{`${m[2]}\u00a0${m[3]}`}</span>
    </>
  );
}

export function FindingsList({ findings, limit }: { findings: string[]; limit?: number }) {
  const head = limit ? findings.slice(0, limit) : findings;
  const rest = limit ? findings.slice(limit) : [];
  const item = (f: string, i: number) => (
    <li
      key={i}
      className="border-l-2 border-warning/60 pl-2.5 font-mono text-[11.5px] leading-relaxed text-foreground [overflow-wrap:anywhere]"
    >
      <TiedTail text={f} />
    </li>
  );
  return (
    <div data-waf-findings>
      <ul className="flex flex-col gap-1.5">{head.map(item)}</ul>
      {rest.length > 0 && (
        <details className="group mt-1.5">
          <summary className="touch-hit inline-flex cursor-pointer list-none items-center gap-1 text-[12px] font-medium text-foreground underline decoration-primary decoration-[1.5px] underline-offset-[3px] hover:decoration-2 [&::-webkit-details-marker]:hidden">
            <ChevronRight
              size={12}
              strokeWidth={2}
              aria-hidden="true"
              className="transition-transform duration-150 group-open:rotate-90"
            />
            {`${rest.length} more`}
          </summary>
          <ul className="mt-1.5 flex flex-col gap-1.5">{rest.map((f, i) => item(f, i + head.length))}</ul>
        </details>
      )}
    </div>
  );
}

/**
 * ZonePosture — everything the inventory knows about one zone: where it stands
 * against its profile, each difference, and every rule with its expression.
 *
 * `host` is the site hostname this is being shown for, when there is one. A
 * name match only says the hostname sits inside the zone; if the zone's DNS
 * lists that hostname as DNS-only, the rules do not stand in front of it, and
 * that is said here rather than left for the reader to infer.
 */
export function ZonePosture({
  zone,
  sites,
  host,
}: {
  zone: ZoneDetail;
  sites?: SiteRef[];
  host?: string;
}) {
  const [allOpen, setAllOpen] = useState(false);
  const klass = KLASS_META[zone.klass];
  const reach = reachMeta(zone.reach);
  const grey = zone.reach?.grey ?? [];
  const hostNorm = host ? normalizeHost(host) : "";
  const hostIsGrey = hostNorm !== "" && grey.some((g) => normalizeHost(g.name) === hostNorm);
  const against = zone.profile ?? zone.nearest ?? null;
  const maskedRules = zone.rules.filter((r) => r.expr_masked).length;

  return (
    <div data-waf-zone={zone.name} className="flex flex-col gap-8">
      {hostIsGrey && (
        <Callout tone="danger" title={`These rules do not apply to ${hostNorm}`}>
          {tie("The zone lists this hostname as DNS-only, so its visitors go straight to the server and never meet the rules below.")}
        </Callout>
      )}

      <div className="grid grid-cols-1 gap-x-8 gap-y-8 md:grid-cols-2">
        <section>
          <PanelHeader title="Standing" meta={zone.name} />
          <Fact label="Class">
            <span className="font-semibold">{klass.label}</span>
            <span className="block text-[12px] text-muted-foreground">{tie(klass.meaning)}</span>
          </Fact>
          <Fact label="Profile">
            {zone.profile
              ? profileLabel(zone.profile)
              : zone.nearest
                ? `None assigned. Nearest: ${profileLabel(zone.nearest)}`
                : "None assigned"}
          </Fact>
          <Fact label="Rule order">
            {zone.nrules === 0
              ? "No rules"
              : zone.order_matches
                ? "Matches the profile"
                : zone.comparable
                  ? "Differs from the profile"
                  : "Not compared"}
          </Fact>
          <Fact label="DNS reach">
            <span className={cn("font-semibold", reach.tone === "danger" && "text-danger", reach.tone === "warn" && "text-warning")}>
              {reach.label}
            </span>
            <span className="block text-[12px] text-muted-foreground">{tie(reach.meaning)}</span>
          </Fact>
          {grey.length > 0 && (
            <Fact label="DNS-only records">
              <details className="group">
                <summary className="touch-hit inline-flex cursor-pointer list-none items-center gap-1 font-medium text-foreground underline decoration-primary decoration-[1.5px] underline-offset-[3px] hover:decoration-2 [&::-webkit-details-marker]:hidden">
                  <ChevronRight size={12} strokeWidth={2} aria-hidden="true" className="transition-transform duration-150 group-open:rotate-90" />
                  {`${grey.length} outside the proxy`}
                </summary>
                <ul className="mt-1.5 flex flex-col gap-1 font-mono text-[11px] text-muted-foreground">
                  {grey.map((g) => (
                    <li key={`${g.type}-${g.name}`} className="[overflow-wrap:anywhere]">
                      {`${g.type} ${g.name}`}
                    </li>
                  ))}
                </ul>
              </details>
            </Fact>
          )}
        </section>

        <section className="md:border-l md:border-border md:pl-8">
          <PanelHeader title="Zone" meta="cloudflare" />
          <Fact label="Plan">{zone.plan ?? "Not reported"}</Fact>
          <Fact label="Account">{zone.account ?? "Not reported"}</Fact>
          <Fact label="Custom rules">
            <span className="font-mono tabular-nums">{zone.nrules}</span>
          </Fact>
          <Fact label="Rate-limit rules">
            <span className="font-mono tabular-nums">{zone.ratelimit_rules}</span>
          </Fact>
          <Fact label="Ruleset last changed">
            <span className="font-mono">
              {zone.ruleset_updated ?? "Never"}
              {zone.ruleset_version ? ` · v${zone.ruleset_version}` : ""}
            </span>
          </Fact>
          {sites && (
            <Fact label="GridPane sites">
              {sites.length === 0 ? (
                <span className="text-muted-foreground">None. This zone is not a GridPane site.</span>
              ) : (
                <span className="flex flex-col items-end gap-0.5">
                  {sites.map((s) => (
                    <Link
                      key={s.id}
                      href={`/sites/${s.id}`}
                      className="font-medium text-foreground underline decoration-primary decoration-[1.5px] underline-offset-[3px] hover:decoration-2"
                    >
                      {siteRefText(s, sites)}
                    </Link>
                  ))}
                </span>
              )}
            </Fact>
          )}
        </section>
      </div>

      <section>
        <PanelHeader
          title="Differences"
          meta={against ? `against the ${profileLabel(against).toLowerCase()}` : undefined}
        />
        {zone.findings.length > 0 ? (
          <div className="pt-3">
            <FindingsList findings={zone.findings} />
          </div>
        ) : (
          <p className="text-pretty pt-3 text-[12.5px] leading-relaxed text-muted-foreground">
            {tie(
              zone.klass === "none"
                ? "Nothing to compare: the zone has no custom rules."
                : zone.comparable
                  ? "None. Every clause matches the profile."
                  : "The inventory listed no differences, but it could not compare this zone against a profile clause by clause."
            )}
          </p>
        )}
      </section>

      <section>
        <PanelHeader title="Rules" meta={`${zone.rules.length} in ruleset order`}>
          {zone.rules.length > 0 && (
            <Button size="sm" onClick={() => setAllOpen((v) => !v)}>
              {allOpen ? "Close all" : "Open all"}
            </Button>
          )}
        </PanelHeader>
        {zone.rules.length === 0 ? (
          <p className="text-pretty pt-3 text-[12.5px] leading-relaxed text-muted-foreground">
            {tie("This zone has no WAF custom rules.")}
          </p>
        ) : (
          <>
            {maskedRules > 0 && (
              <p className="text-pretty pt-3 text-[12.5px] leading-relaxed text-muted-foreground">
                {tie(
                  `${maskedRules === 1 ? "One rule here is" : `${maskedRules} rules here are`} masked and marked. Every other expression is the exact text at Cloudflare on the run date.`
                )}
              </p>
            )}
            <ul>
              {zone.rules.map((r, i) => (
                <RuleItem key={i} rule={r} index={i} open={allOpen} />
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

/**
 * SiteZoneSection — the Cloudflare zone for one GridPane site, on that site's
 * own page. The link is a hostname match made here, not a stored relation, so
 * a site with no zone says so in words instead of rendering an empty panel.
 */
export function SiteZoneSection({ host }: { host: string }) {
  const supabase = useMemo(() => createClient(), []);
  const runState = useLatestWafRun();
  const [zone, setZone] = useState<ZoneDetail | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const names = await supabase.from("cloudflare_zones").select("name");
      if (cancelled) return;
      if (names.error) {
        setError(names.error.message);
        setZone(null);
        return;
      }
      const match = zoneNameForHost(host, (names.data ?? []).map((r) => r.name as string));
      if (!match) {
        setZone(null);
        return;
      }
      const detail = await supabase.from("cloudflare_zones").select("*").eq("name", match).limit(1);
      if (cancelled) return;
      if (detail.error) setError(detail.error.message);
      setZone((detail.data?.[0] as ZoneDetail | undefined) ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, host]);

  return (
    <section data-waf-site-section className="flex flex-col gap-5 border-t border-line-strong pt-8">
      <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-2">
        <h2 className="text-balance text-[20px] font-extrabold tracking-[-0.02em]">Cloudflare WAF</h2>
        {zone && <ZonePills zone={zone} />}
        <Link href="/firewall/cloudflare" className="eyebrow ml-auto text-foreground underline decoration-primary decoration-[1.5px] underline-offset-[3px] hover:decoration-2">
          Fleet view
        </Link>
      </div>

      {runState.status === "loading" || zone === undefined ? (
        <Skeleton className="h-24 w-full" />
      ) : runState.status !== "ready" ? (
        <RunMissing state={runState} />
      ) : (
        <>
          <RunStamp run={runState.run} size="inline" />
          {error ? (
            <p className="text-pretty text-[12.5px] leading-relaxed text-danger">
              {"The zone could not be read: "}<span className="font-mono text-[11.5px]">{error}</span>
            </p>
          ) : zone ? (
            <>
              <p className="text-pretty text-[12.5px] leading-relaxed text-muted-foreground">
                {`${normalizeHost(host)} sits in the Cloudflare zone `}
                <Link
                  href={zoneHref(zone.name)}
                  className="font-medium text-foreground underline decoration-primary decoration-[1.5px] underline-offset-[3px] hover:decoration-2"
                >
                  {zone.name}
                </Link>
                {tie(". The match is by hostname.")}
              </p>
              <ZonePosture zone={zone} host={host} />
            </>
          ) : (
            <Callout tone="note" data-waf-no-zone title="No Cloudflare zone for this site">
              {`None of the ${runState.run.zone_count} zones in this inventory run covers `}
              <Copyable value={normalizeHost(host)} what="hostname" className="text-[11.5px]">
                {normalizeHost(host)}
              </Copyable>
              {tie(". Either the domain is not on a Cloudflare account the inventory can read, or it is not on Cloudflare at all. There is no WAF posture to show.")}
            </Callout>
          )}
        </>
      )}
    </section>
  );
}
