"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { Callout, Segmented, Skeleton, StatusPill, SummaryAge, SummaryFigure, SummaryStrip } from "@/components/ui";
import { REPORT_INTERVAL_MINUTES, ageText, tie } from "@/lib/fail2ban";
import {
  DEFAULT_OFF_RULESETS,
  dayCount,
  eightDayText,
  eightGapText,
  eightGMeta,
  matchesFilter,
  needsAttention,
  reportStale,
  ruleName,
  rulesetLabel,
  rulesetsSwitchedOff,
  sampleKind,
  sevenDayText,
  sevenGMeta,
  sevenGOn,
  sortForList,
  summaryText,
  wafSummary,
  type G8Rule,
  type ServerWafRow,
  type SiteWafRow,
  type WafFilter,
} from "@/lib/waf-status";

/* ------------------------------------------------------------------ */
/* Data                                                               */
/* ------------------------------------------------------------------ */

type Loaded =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; servers: ServerWafRow[]; sites: SiteWafRow[] };

/**
 * The WAF report for one server, or for every server when serverId is "all".
 * Refetches when a server's row changes: the report function writes that row
 * last, so the site rows are already in when the change arrives.
 */
function useWaf(serverId: number | "all" | undefined): Loaded {
  const supabase = useMemo(() => createClient(), []);
  const [state, setState] = useState<Loaded>({ status: "loading" });

  useEffect(() => {
    if (!serverId) return;
    let cancelled = false;

    async function load() {
      let serverQ = supabase.from("server_waf_state").select("*");
      let siteQ = supabase.from("site_waf_state").select("*").order("site");
      if (serverId !== "all") {
        serverQ = serverQ.eq("server_id", serverId);
        siteQ = siteQ.eq("server_id", serverId);
      }
      const [serverRes, sitesRes] = await Promise.all([serverQ, siteQ]);
      if (cancelled) return;
      const error = serverRes.error ?? sitesRes.error;
      if (error) {
        setState({ status: "error", message: error.message });
        return;
      }
      setState({
        status: "ready",
        servers: (serverRes.data ?? []) as ServerWafRow[],
        sites: (sitesRes.data ?? []) as SiteWafRow[],
      });
    }

    load();
    const channel = supabase
      .channel(`waf-${serverId}`)
      .on(
        "postgres_changes",
        serverId === "all"
          ? { event: "*", schema: "public", table: "server_waf_state" }
          : { event: "*", schema: "public", table: "server_waf_state", filter: `server_id=eq.${serverId}` },
        () => load()
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [supabase, serverId]);

  return state;
}

/** The viewer's clock, ticking, so a silent server turns stale on an open page. */
function useNow(everyMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), everyMs);
    return () => window.clearInterval(id);
  }, [everyMs]);
  return now;
}

const TITLE = "Server firewall: 7G and 8G";
const count = (n: number) => n.toLocaleString("en-US");

/* ------------------------------------------------------------------ */
/* Site page                                                          */
/* ------------------------------------------------------------------ */

export function SiteWafSection({ serverId, host }: { serverId: number | undefined; host: string }) {
  const data = useWaf(serverId);
  const now = useNow();
  const name = host.trim().toLowerCase();

  const body = (() => {
    if (!serverId) return <Note>This site is not attached to a server, so there is no report to read.</Note>;
    if (data.status === "loading") return <Skeleton className="h-24 w-full" />;
    if (data.status === "error") return <ReadError message={data.message} />;
    const server = data.servers[0] ?? null;
    if (!server) return <NotReported />;
    const row = data.sites.find((s) => s.site.toLowerCase() === name) ?? null;
    if (!row) {
      return (
        <Callout tone="warning" live title="Not in the server's report">
          {tie(`The server reported ${ageText(server.reported_at, now)}, but its report does not list a folder named ${name}.`)}
        </Callout>
      );
    }
    return <SiteDetail row={row} stale={reportStale(server.reported_at, now)} reportedAt={server.reported_at} now={now} />;
  })();

  return (
    <section data-waf-status-site className="flex flex-col gap-5 border-t border-line-strong pt-8">
      <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-2">
        <h2 className="text-balance text-[20px] font-extrabold tracking-[-0.02em]">{TITLE}</h2>
        <Link
          href="/firewall/waf"
          className="eyebrow ml-auto text-foreground underline decoration-primary decoration-[1.5px] underline-offset-[3px] hover:decoration-2"
        >
          Fleet view
        </Link>
      </div>
      {body}
    </section>
  );
}

function SiteDetail({ row, stale, reportedAt, now }: { row: SiteWafRow; stale: boolean; reportedAt: string; now: Date }) {
  const seven = sevenGMeta(row);
  const eight = eightGMeta(row);
  const rulesets = Object.entries(row.rulesets ?? {}).sort(([a], [b]) => a.localeCompare(b));

  return (
    <>
      <SummaryStrip data-waf-status-line stale={stale} className="gap-y-2.5">
        <Labeled label="7G">
          <StatusPill tone={stale ? "neutral" : seven.tone}>{seven.label}</StatusPill>
        </Labeled>
        <Labeled label="8G">
          <StatusPill tone={stale ? "neutral" : eight.tone}>{eight.label}</StatusPill>
        </Labeled>
        <ReportAge stale={stale} reportedAt={reportedAt} now={now} />
      </SummaryStrip>

      {stale && <StaleProblem reportedAt={reportedAt} now={now} />}
      {!stale && seven.tone !== "ok" && (
        <Callout tone={seven.tone === "danger" ? "danger" : "warning"} live title={`7G: ${seven.label}`}>
          {tie(seven.detail)}
        </Callout>
      )}
      {!stale && (eight.tone === "warn" || eight.tone === "danger") && (
        <Callout tone={eight.tone === "danger" ? "danger" : "warning"} live title={`8G: ${eight.label}`}>
          {tie(eight.meaning)}
        </Callout>
      )}

      <div className="grid grid-cols-1 gap-x-8 gap-y-8 md:grid-cols-2">
        <div className="flex flex-col gap-8">
          <Group title="7G rulesets" meta={sevenGOn(row) ? "GridPane settings" : "7G is off"}>
            {rulesets.length === 0 ? (
              <Note>The site&apos;s settings file lists no 7G rulesets.</Note>
            ) : (
              <ul data-waf-rulesets className="flex flex-col">
                {rulesets.map(([key, value]) => {
                  const on = value === "on";
                  const byDefault = !on && DEFAULT_OFF_RULESETS.includes(key);
                  return (
                    <li key={key} className="flex items-center justify-between gap-3 border-b border-border py-2">
                      <span className="min-w-0 text-[12.5px]">{rulesetLabel(key)}</span>
                      <span
                        className={cn(
                          "shrink-0 text-right text-[12px]",
                          on ? "text-muted-foreground" : byDefault ? "text-muted-foreground" : "font-semibold text-foreground"
                        )}
                      >
                        {on ? "On" : byDefault ? "Off by default" : "Switched off"}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Group>

          <Group title="7G, last 24 hours" meta={row.g7_day ? `${dayCount(row.g7_day)} blocked` : undefined}>
            <p className="text-pretty text-[12.5px] leading-relaxed">{tie(sevenDayText(row.g7_day))}</p>
            {row.g7_day && row.g7_day.rules.length > 0 && (
              <RuleList rules={row.g7_day.rules.map((r) => ({ ...r, already: 0, samples: [] }))} />
            )}
            {row.g7_day && !row.g7_day.complete && <CutShort />}
          </Group>
        </div>

        <Group
          title="8G, last 24 hours"
          meta={[row.g8_version ? `v${row.g8_version}` : null, eight.mode === "observe" ? "observer mode" : null].filter(Boolean).join(" · ") || undefined}
        >
          {eight.mode === "none" ? (
            <Note>{tie("8G is not installed for this site, so there is nothing to compare 7G against.")}</Note>
          ) : (
            <>
              <p className="text-pretty text-[12.5px] leading-relaxed">{tie(eightDayText(row.g8_day, eight.mode))}</p>
              {eight.mode === "observe" && eightGapText(row.g8_day) && (
                <p data-waf-gap className="text-pretty text-[12.5px] leading-relaxed text-muted-foreground">
                  {tie(eightGapText(row.g8_day) as string)}
                </p>
              )}
              {row.g8_day && row.g8_day.rules.length > 0 && <RuleList rules={row.g8_day.rules} withSamples />}
              {row.g8_day && !row.g8_day.complete && <CutShort />}
              {row.g8_log_at && <Note>{tie(`The 8G log was last written ${ageText(row.g8_log_at, now)}.`)}</Note>}
            </>
          )}
        </Group>
      </div>
    </>
  );
}

const RULES_SHOWN = 6;

function RuleList({ rules, withSamples = false }: { rules: G8Rule[]; withSamples?: boolean }) {
  const [all, setAll] = useState(false);
  const shown = all ? rules : rules.slice(0, RULES_SHOWN);
  return (
    <>
      <ul data-waf-rules className="flex flex-col border-t border-border">
        {shown.map((r) => {
          const name = ruleName(r.rule);
          const kind = withSamples ? sampleKind(r.rule) : null;
          return (
            <li key={r.rule} className="flex flex-col gap-1.5 border-b border-border py-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 text-[12.5px] font-semibold">
                  {name.family}
                  {name.id && <span className="font-normal text-muted-foreground">{`, rule ${name.id}`}</span>}
                </span>
                <span className="shrink-0 font-mono text-[12px] tabular-nums">{count(r.n)}</span>
              </div>
              {kind && r.samples.length > 0 && (
                <div className="flex flex-col gap-0.5">
                  <span className="eyebrow text-muted-foreground">{kind}</span>
                  {r.samples.map((s) => (
                    <span key={s.s} className="flex items-baseline justify-between gap-3 font-mono text-[10.5px] text-muted-foreground">
                      <span className="font-mono min-w-0 [overflow-wrap:anywhere]">{s.s}</span>
                      <span className="shrink-0 tabular-nums">{count(s.n)}</span>
                    </span>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {rules.length > RULES_SHOWN && (
        <button
          type="button"
          data-waf-more
          aria-expanded={all}
          onClick={() => setAll(!all)}
          className="touch-hit self-start text-[12px] font-semibold text-foreground underline decoration-primary decoration-[1.5px] underline-offset-[3px] hover:decoration-2"
        >
          {all ? "Show fewer rules" : `Show all ${rules.length} rules`}
        </button>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Server page                                                        */
/* ------------------------------------------------------------------ */

export function ServerWafPanel({
  serverId,
  siteIds,
}: {
  serverId: number;
  /** hostname → sites.id, for the folders that are GridPane sites. */
  siteIds: Record<string, number>;
}) {
  const data = useWaf(serverId);
  const now = useNow();

  const body = (() => {
    if (data.status === "loading") return <Skeleton className="h-24 w-full" />;
    if (data.status === "error") return <ReadError message={data.message} />;
    const server = data.servers[0] ?? null;
    if (!server) return <NotReported />;
    const stale = reportStale(server.reported_at, now);
    return (
      <>
        <SummaryBox rows={data.sites} stale={stale} reportedAt={server.reported_at} now={now} />
        {stale && <StaleProblem reportedAt={server.reported_at} now={now} />}
        {data.sites.length === 0 ? (
          <Note>The server&apos;s report lists no sites.</Note>
        ) : (
          <SiteList rows={sortForList(data.sites)} stale={() => stale} href={(r) => siteHref(siteIds, r.site)} />
        )}
      </>
    );
  })();

  return (
    <section data-waf-status-server className="flex flex-col gap-5 border-t border-line-strong pt-8">
      <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-2">
        <h2 className="text-balance text-[20px] font-extrabold tracking-[-0.02em]">{TITLE}</h2>
        <Link
          href="/firewall/waf"
          className="eyebrow ml-auto text-foreground underline decoration-primary decoration-[1.5px] underline-offset-[3px] hover:decoration-2"
        >
          Fleet view
        </Link>
      </div>
      {body}
    </section>
  );
}

function siteHref(siteIds: Record<string, number>, site: string): string | null {
  const id = siteIds[site.toLowerCase()];
  return id ? `/sites/${id}` : null;
}

/* ------------------------------------------------------------------ */
/* Fleet                                                              */
/* ------------------------------------------------------------------ */

const FILTERS: { value: WafFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "observing", label: "8G observing" },
  { value: "weakened", label: "Ruleset off" },
  { value: "attention", label: "Needs a look" },
];

export function FleetWaf({
  serverLabels,
  siteIdsByServer,
}: {
  /** servers.id → label */
  serverLabels: Record<number, string>;
  /**
   * servers.id → hostname → sites.id. Keyed by server because one address can
   * be on two servers while a moved site's old copy is kept.
   */
  siteIdsByServer: Record<number, Record<string, number>>;
}) {
  const data = useWaf("all");
  const now = useNow();
  const [filter, setFilter] = useState<WafFilter>("all");

  if (data.status === "loading") return <Skeleton className="h-40 w-full" />;
  if (data.status === "error") return <ReadError message={data.message} />;
  if (data.servers.length === 0) return <NotReported fleet />;

  const reported = new Map(data.servers.map((s) => [s.server_id, s.reported_at]));
  const staleServers = data.servers.filter((s) => reportStale(s.reported_at, now));
  const isStale = (r: SiteWafRow) => reportStale(reported.get(r.server_id), now);
  const fresh = data.sites.filter((r) => !isStale(r));
  const rows = sortForList(data.sites.filter((r) => matchesFilter(r, filter)));
  const newest = data.servers.map((s) => s.reported_at).sort().at(-1) as string;

  return (
    <div data-waf-status-fleet className="flex flex-col gap-5">
      <SummaryBox rows={fresh} stale={false} reportedAt={newest} now={now} servers={data.servers.length} />
      {staleServers.length > 0 && (
        <Callout tone="warning" live title={staleServers.length === 1 ? "One server has stopped reporting" : `${staleServers.length} servers have stopped reporting`}>
          {tie(
            `${staleServers.map((s) => serverLabels[s.server_id] ?? `Server ${s.server_id}`).join(", ")}: reports are due every ${REPORT_INTERVAL_MINUTES} minutes. Their sites are left out of the counts above and marked below.`
          )}
        </Callout>
      )}
      <Segmented options={FILTERS} value={filter} onChange={(v) => setFilter(v as WafFilter)} />
      {rows.length === 0 ? (
        <Note>No site matches this filter.</Note>
      ) : (
        <SiteList
          rows={rows}
          stale={isStale}
          href={(r) => siteHref(siteIdsByServer[r.server_id] ?? {}, r.site)}
          serverLabel={(r) => serverLabels[r.server_id] ?? `Server ${r.server_id}`}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shared pieces                                                      */
/* ------------------------------------------------------------------ */

function SummaryBox({
  rows,
  stale,
  reportedAt,
  now,
  servers,
}: {
  rows: SiteWafRow[];
  stale: boolean;
  reportedAt: string;
  now: Date;
  servers?: number;
}) {
  const s = wafSummary(rows);
  return (
    <div className="flex flex-col gap-2">
      <SummaryStrip data-waf-summary stale={stale}>
        <SummaryFigure value={String(s.sevenOn)} of={String(s.sites)} label={s.sites === 1 ? "site on 7G" : "sites on 7G"} />
        <SummaryFigure value={String(s.observing)} label="8G observing" />
        <SummaryFigure
          value={`${s.wouldBlockComplete ? "" : "≥"}${count(s.wouldBlock)}`}
          label={s.wouldBlock === 1 ? "would-be block, 24h" : "would-be blocks, 24h"}
        />
        <ReportAge stale={stale} reportedAt={reportedAt} now={now} prefix={servers ? "Newest report" : undefined} />
      </SummaryStrip>
      <Note>
        {tie(
          `${summaryText(s)}${s.weakened ? ` ${s.weakened === 1 ? "One site has" : `${s.weakened} sites have`} a 7G ruleset switched off.` : ""}${
            s.noFirewall ? ` ${s.noFirewall === 1 ? "One site has" : `${s.noFirewall} sites have`} no server firewall.` : ""
          }${servers ? ` Across ${servers} ${servers === 1 ? "server" : "servers"}.` : ""}`
        )}
      </Note>
    </div>
  );
}

function SiteList({
  rows,
  stale,
  href,
  serverLabel,
}: {
  rows: SiteWafRow[];
  stale: (row: SiteWafRow) => boolean;
  href: (row: SiteWafRow) => string | null;
  serverLabel?: (row: SiteWafRow) => string;
}) {
  return (
    <ul data-waf-site-list className="flex flex-col border-t-2 border-foreground">
      {rows.map((row) => {
        const isStale = stale(row);
        const seven = sevenGMeta(row);
        const eight = eightGMeta(row);
        const off = rulesetsSwitchedOff(row);
        const link = href(row);
        const reasons = isStale
          ? []
          : [
              seven.tone !== "ok" ? seven.detail : null,
              eight.tone === "warn" || eight.tone === "danger" ? eight.meaning : null,
            ].filter((x): x is string => Boolean(x));
        return (
          <li
            key={`${row.server_id}:${row.site}`}
            data-waf-site={row.site}
            data-attention={!isStale && needsAttention(row) ? "true" : "false"}
            className="flex flex-col gap-1.5 border-b border-border py-3"
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              {link ? (
                <Link
                  href={link}
                  className="min-w-0 break-words text-[13px] font-bold leading-tight underline decoration-border decoration-[1.5px] underline-offset-[3px] [overflow-wrap:anywhere] hover:decoration-primary"
                >
                  {row.site}
                </Link>
              ) : (
                <span className="min-w-0 break-words text-[13px] font-bold leading-tight [overflow-wrap:anywhere]">{row.site}</span>
              )}
              <span className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
                {isStale ? (
                  <StatusPill tone="warn">Not reported</StatusPill>
                ) : (
                  <>
                    <StatusPill tone={seven.tone}>{`7G ${seven.label}`}</StatusPill>
                    {eight.mode !== "none" && <StatusPill tone={eight.tone}>{`8G ${eight.label}`}</StatusPill>}
                  </>
                )}
              </span>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-[10.5px] text-muted-foreground">
              {serverLabel && <span>{serverLabel(row)}</span>}
              <span>{row.g7_day ? `7G blocked ${dayCount(row.g7_day)}` : "no 7G log"}</span>
              {eight.mode !== "none" && (
                <span className={cn(!isStale && (row.g8_day?.total ?? 0) > 0 && "font-semibold text-foreground")}>
                  {row.g8_day
                    ? `8G ${eight.mode === "enforce" ? "matched" : "would block"} ${dayCount(row.g8_day)}`
                    : "no 8G log yet"}
                </span>
              )}
              {off.length > 0 && <span className="font-semibold text-foreground">{`${off.map(rulesetLabel).join(", ")} off`}</span>}
            </div>
            {reasons.map((text) => (
              <p key={text} className="text-pretty text-[12px] leading-relaxed text-muted-foreground">
                {tie(text)}
              </p>
            ))}
          </li>
        );
      })}
    </ul>
  );
}

function ReportAge({ stale, reportedAt, now, prefix }: { stale: boolean; reportedAt: string; now: Date; prefix?: string }) {
  return <SummaryAge stale={stale}>{tie(`${stale ? "Not reported: last report" : prefix ?? "Last report"} ${ageText(reportedAt, now)}`)}</SummaryAge>;
}

function StaleProblem({ reportedAt, now }: { reportedAt: string; now: Date }) {
  return (
    <Callout tone="warning" live title="This server has stopped reporting">
      {tie(
        `Reports are due every ${REPORT_INTERVAL_MINUTES} minutes and the last one is ${ageText(reportedAt, now)}. Everything below is what the server last said, not what is true now.`
      )}
    </Callout>
  );
}

function NotReported({ fleet = false }: { fleet?: boolean }) {
  return (
    <Callout tone="warning" live title="Not reported">
      {tie(
        `${fleet ? "No server has" : "This server's agent has not"} sent a firewall report yet. Reports come from the telemetry agent every ${REPORT_INTERVAL_MINUTES} minutes, once the current agent is on the server.`
      )}
    </Callout>
  );
}

function ReadError({ message }: { message: string }) {
  return (
    <Callout tone="danger" live>
      {"The firewall report could not be read: "}
      <span className="font-mono text-[11.5px]">{message}</span>
    </Callout>
  );
}

function CutShort() {
  return <Note>{tie("The log was too long to read whole, so the true count for the day is higher.")}</Note>;
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-2">
      <span className="eyebrow text-muted-foreground">{label}</span>
      {children}
    </span>
  );
}

function Group({ title, meta, children }: { title: string; meta?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-1.5">
        <span className="eyebrow">{title}</span>
        {meta && <span className="font-mono text-[10.5px] text-muted-foreground">{meta}</span>}
      </div>
      {children}
    </section>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="text-pretty text-[11.5px] leading-relaxed text-muted-foreground">{children}</p>;
}
