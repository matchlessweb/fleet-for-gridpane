"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { Callout, Skeleton, StatusPill, SummaryAge, SummaryFigure, SummaryStrip } from "@/components/ui";
import { REPORT_INTERVAL_MINUTES, ageText, tie } from "@/lib/fail2ban";
import {
  FULL_PCT,
  KEYS_FULL_PCT,
  KEYS_WARN_PCT,
  NEARLY_FULL_PCT,
  findings,
  flagLabel,
  healthyText,
  lifetimeHitRate,
  mbText,
  pctText,
  recentHitRate,
  reportStale,
  serverSummary,
  siteCache,
  siteShares,
  sortVersions,
  usage,
  versionMeta,
  type Finding,
  type PhpOpcacheRow,
  type ServerOpcacheRow,
  type Tone,
} from "@/lib/opcache-status";

/* ------------------------------------------------------------------ */
/* Data                                                               */
/* ------------------------------------------------------------------ */

type Loaded =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; servers: ServerOpcacheRow[]; versions: PhpOpcacheRow[] };

/**
 * The code cache report for one server, or for every server when serverId is
 * "all". Refetches when a server's row changes: the report function writes that
 * row last, so the version rows are already in when the change arrives.
 */
function useOpcache(serverId: number | "all" | undefined): Loaded {
  const supabase = useMemo(() => createClient(), []);
  const [state, setState] = useState<Loaded>({ status: "loading" });

  useEffect(() => {
    if (!serverId) return;
    let cancelled = false;

    async function load() {
      let serverQ = supabase.from("server_opcache_state").select("*");
      let versionQ = supabase.from("php_opcache_state").select("*").order("php_version");
      if (serverId !== "all") {
        serverQ = serverQ.eq("server_id", serverId);
        versionQ = versionQ.eq("server_id", serverId);
      }
      const [serverRes, versionRes] = await Promise.all([serverQ, versionQ]);
      if (cancelled) return;
      const error = serverRes.error ?? versionRes.error;
      if (error) {
        setState({ status: "error", message: error.message });
        return;
      }
      setState({
        status: "ready",
        servers: (serverRes.data ?? []) as ServerOpcacheRow[],
        versions: (versionRes.data ?? []) as PhpOpcacheRow[],
      });
    }

    load();
    const channel = supabase
      .channel(`opcache-${serverId}`)
      .on(
        "postgres_changes",
        serverId === "all"
          ? { event: "*", schema: "public", table: "server_opcache_state" }
          : { event: "*", schema: "public", table: "server_opcache_state", filter: `server_id=eq.${serverId}` },
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

const TITLE = "PHP code cache";
const count = (n: number) => n.toLocaleString("en-US");

/* ------------------------------------------------------------------ */
/* Server page                                                        */
/* ------------------------------------------------------------------ */

export function ServerOpcachePanel({
  serverId,
  siteIds,
}: {
  serverId: number;
  /** hostname → sites.id, for the folders that are GridPane sites. */
  siteIds: Record<string, number>;
}) {
  const data = useOpcache(serverId);
  const now = useNow();

  const body = (() => {
    if (data.status === "loading") return <Skeleton className="h-24 w-full" />;
    if (data.status === "error") return <ReadError message={data.message} />;
    const server = data.servers[0] ?? null;
    if (!server) return <NotReported />;
    const stale = reportStale(server.reported_at, now);
    const summary = serverSummary(data.versions, now);
    return (
      <>
        <div className="flex flex-col gap-2">
          <SummaryStrip data-opc-summary stale={stale}>
            <SummaryFigure value={String(summary.inUse)} label={summary.inUse === 1 ? "PHP version in use" : "PHP versions in use"} />
            <SummaryFigure value={String(summary.danger + summary.warn)} label={summary.danger + summary.warn === 1 ? "needs a look" : "need a look"} />
            <ReportAge stale={stale} reportedAt={server.reported_at} now={now} />
          </SummaryStrip>
          <Note>
            {tie(
              `${summary.text} Each PHP version has one cache of compiled code, and every site on that version shares it. When it fills, those sites compile PHP again on every request.`
            )}
          </Note>
        </div>
        {stale && <StaleProblem reportedAt={server.reported_at} now={now} />}
        {data.versions.length === 0 ? (
          <Note>The server&apos;s report lists no PHP version.</Note>
        ) : (
          <ul data-opc-version-list className="flex flex-col border-t-2 border-foreground">
            {sortVersions(data.versions, now).map((row) => (
              <VersionItem key={row.php_version} row={row} stale={stale} now={now} siteIds={siteIds} />
            ))}
          </ul>
        )}
      </>
    );
  })();

  return (
    <section data-opc-server className="flex flex-col gap-5 border-t border-line-strong pt-8">
      <h2 className="text-balance text-[20px] font-extrabold tracking-[-0.02em]">{TITLE}</h2>
      {body}
    </section>
  );
}

function VersionItem({
  row,
  stale,
  now,
  siteIds,
}: {
  row: PhpOpcacheRow;
  stale: boolean;
  now: Date;
  siteIds: Record<string, number>;
}) {
  const meta = versionMeta(row, now);
  const found = stale ? [] : findings(row, now);
  const live = row.live;
  const u = live ? usage(live) : null;
  const life = live ? lifetimeHitRate(live) : null;
  const recent = recentHitRate(row);
  const sitesText = row.sites.length === 0 ? "no sites" : row.sites.length === 1 ? "1 site" : `${row.sites.length} sites`;
  const started = live ? [live.start, live.last_restart].filter((t): t is string => Boolean(t)).sort().at(-1) : undefined;

  return (
    <li data-opc-version={row.php_version} data-tone={stale ? "stale" : meta.tone} className="flex flex-col gap-3.5 border-b border-border py-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-[15px] font-extrabold tracking-[-0.01em]">{`PHP ${row.php_version}`}</span>
        <StatusPill tone={stale ? "neutral" : meta.tone}>{stale ? "Not reported" : meta.label}</StatusPill>
        <span className="ml-auto font-mono text-[10.5px] text-muted-foreground">{sitesText}</span>
      </div>

      {live && u ? (
        <>
          <div className="grid grid-cols-1 gap-x-8 gap-y-3.5 md:grid-cols-3">
            <Bar
              label="Memory"
              value={`${mbText(live.mem.used + live.mem.wasted)} of ${mbText(u.totalBytes)}`}
              percent={u.takenPct}
              wastedPercent={u.wastedPct}
              tone={barTone(u.takenPct, NEARLY_FULL_PCT, FULL_PCT, live.full)}
            />
            <Bar
              label="Files"
              value={`${count(live.keys)} of ${count(live.max_keys)}`}
              percent={u.keysPct}
              tone={barTone(u.keysPct, KEYS_WARN_PCT, KEYS_FULL_PCT)}
            />
            <Bar
              label="Text buffer"
              value={`${mbText(live.str.used)} of ${mbText(live.str.size)}`}
              percent={u.internedPct}
              tone={barTone(u.internedPct, NEARLY_FULL_PCT, FULL_PCT)}
            />
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-[10.5px] text-muted-foreground">
            <span>{life === null ? "no requests yet" : `hit rate ${rateText(life)} since start`}</span>
            {recent && <span>{`${rateText(recent.rate)} in the last ${recent.minutes} min`}</span>}
            {u.wastedBytes > 0 && <span>{`${mbText(u.wastedBytes)} wasted`}</span>}
            {started && <span>{`started ${ageText(started, now)}`}</span>}
            {live.oom + live.hash > 0 && <span className="font-semibold text-foreground">{`emptied ${count(live.oom + live.hash)} times for lack of room`}</span>}
            <span>{`PHP ${live.php}`}</span>
          </div>
        </>
      ) : (
        row.ini && (
          <div className="flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-[10.5px] text-muted-foreground">
            <span>settings file:</span>
            {row.ini.memory_mb !== null && <span>{`memory ${row.ini.memory_mb} MB`}</span>}
            {row.ini.max_files !== null && <span>{`file limit ${count(row.ini.max_files)}`}</span>}
            {row.ini.interned_mb !== null && <span>{`text buffer ${row.ini.interned_mb} MB`}</span>}
          </div>
        )
      )}

      {!stale && found.map((f) => <FindingBox key={f.key} finding={f} />)}
      {!stale && found.length === 0 && healthyText(row, now) && <Note>{tie(healthyText(row, now) ?? "")}</Note>}

      {(row.sites.length > 0 || (live?.by_site.length ?? 0) > 0) && <SharingList row={row} siteIds={siteIds} />}
    </li>
  );
}

const SITES_SHOWN = 6;

function SharingList({ row, siteIds }: { row: PhpOpcacheRow; siteIds: Record<string, number> }) {
  const [all, setAll] = useState(false);
  const shares = siteShares(row);
  const shown = all ? shares : shares.slice(0, SITES_SHOWN);
  const hasLive = Boolean(row.live);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-1.5">
        <span className="eyebrow">Sharing this cache</span>
        <span className="font-mono text-[10.5px] text-muted-foreground">{hasLive ? "cached code, largest first" : "from the pool files"}</span>
      </div>
      <ul data-opc-sites className="flex flex-col">
        {shown.map((s) => {
          const id = siteIds[s.site.toLowerCase()];
          const label = s.site === "other" ? "Outside the site folders" : s.site;
          return (
            <li key={s.site} className="flex flex-col gap-1 border-b border-border py-2">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                {id ? (
                  <Link
                    href={`/sites/${id}`}
                    className="min-w-0 text-[12.5px] font-semibold underline decoration-border decoration-[1.5px] underline-offset-[3px] [overflow-wrap:anywhere] hover:decoration-primary"
                  >
                    {label}
                  </Link>
                ) : (
                  <span className="min-w-0 text-[12.5px] font-semibold [overflow-wrap:anywhere]">{label}</span>
                )}
                {hasLive && (
                  <span className="font-mono shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {s.bytes > 0 ? `${mbText(s.bytes)} · ${pctText(s.sharePct)} · ${count(s.scripts)} files` : "nothing cached"}
                  </span>
                )}
              </div>
              {hasLive && s.bytes > 0 && (
                <div aria-hidden="true" className="h-[3px] w-full overflow-hidden rounded-sm bg-panel-2">
                  <div className={cn("h-full", s.staging ? "bg-warning" : "bg-primary")} style={{ width: `${Math.max(1, s.sharePct)}%` }} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {shares.length > SITES_SHOWN && (
        <button
          type="button"
          data-opc-more
          aria-expanded={all}
          onClick={() => setAll(!all)}
          className="touch-hit self-start text-[12px] font-semibold text-foreground underline decoration-primary decoration-[1.5px] underline-offset-[3px] hover:decoration-2"
        >
          {all ? "Show fewer sites" : `Show all ${shares.length} sites`}
        </button>
      )}
      {row.live?.sites_cut && <Note>{tie("The server cut its list short, so smaller sites are not shown.")}</Note>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Site page: one row in the Environment list                         */
/* ------------------------------------------------------------------ */

export function SiteOpcacheRow({ serverId, host }: { serverId: number | undefined; host: string }) {
  const data = useOpcache(serverId);
  const now = useNow();
  if (!serverId || data.status !== "ready") return null;
  const server = data.servers[0] ?? null;
  if (!server) return null; // the server's agent has not sent this report yet
  const stale = reportStale(server.reported_at, now);
  const cache = siteCache(data.versions, host);
  if (!cache) return null;
  const meta = versionMeta(cache.row, now);
  const worst = stale ? null : findings(cache.row, now)[0] ?? null;

  return (
    <div data-opc-site-row data-tone={stale ? "stale" : meta.tone} className="border-b border-border py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <span className="eyebrow text-faint">PHP code cache</span>
        <StatusPill tone={stale ? "neutral" : meta.tone}>{stale ? "Not reported" : meta.label}</StatusPill>
      </div>
      <p className="text-pretty mt-1.5 text-[12.5px] leading-relaxed">{tie(`${cache.headline}.`)}</p>
      <p className="text-pretty mt-1 text-[12px] leading-relaxed text-muted-foreground">
        {tie(
          stale
            ? `The server last reported ${ageText(server.reported_at, now)}, so this may no longer be true.`
            : worst
              ? `${worst.title}. ${cache.detail} Details are on the server's page.`
              : cache.detail
        )}
      </p>
      <Link
        href={`/servers/${serverId}`}
        className="eyebrow mt-1.5 inline-block text-foreground underline decoration-primary decoration-[1.5px] underline-offset-[3px] hover:decoration-2"
      >
        Server view
      </Link>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Servers list: a flag for a server whose cache needs a change       */
/* ------------------------------------------------------------------ */

export type CacheFlag = { tone: "warn" | "danger"; label: string; title: string };

/** servers.id → flag, only for servers that reported recently and need a look. */
export function useCacheFlags(): Record<number, CacheFlag> {
  const data = useOpcache("all");
  const now = useNow(60_000);
  return useMemo(() => {
    const flags: Record<number, CacheFlag> = {};
    if (data.status !== "ready") return flags;
    for (const server of data.servers) {
      if (reportStale(server.reported_at, now)) continue;
      const rows = sortVersions(data.versions.filter((v) => v.server_id === server.server_id), now);
      const s = serverSummary(rows, now);
      if (s.tone !== "danger" && s.tone !== "warn") continue;
      const first = rows[0];
      flags[server.server_id] = {
        tone: s.tone,
        label: flagLabel(versionMeta(first, now)),
        title: `PHP ${first.php_version}: ${versionMeta(first, now).label.toLowerCase()}`,
      };
    }
    return flags;
  }, [data, now]);
}

export function CacheFlagPill({ flag }: { flag: CacheFlag | undefined }) {
  if (!flag) return null;
  return (
    <span data-opc-flag title={flag.title}>
      <StatusPill tone={flag.tone}>{flag.label}</StatusPill>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Shared pieces                                                      */
/* ------------------------------------------------------------------ */

/** 99.94 → "99.9%"; a rate just under 100 is never shown as 100. */
function rateText(rate: number): string {
  if (rate >= 99.95 && rate < 100) return "99.9%";
  return `${rate.toFixed(1)}%`;
}

function barTone(percent: number, warnAt: number, fullAt: number, full = false): Tone {
  return full || percent >= fullAt ? "danger" : percent >= warnAt ? "warn" : "ok";
}

function Bar({
  label,
  value,
  percent,
  wastedPercent = 0,
  tone,
}: {
  label: string;
  value: string;
  percent: number;
  wastedPercent?: number;
  tone: Tone;
}) {
  const p = Math.max(0, Math.min(100, percent));
  const wasted = Math.max(0, Math.min(p, wastedPercent));
  return (
    <div data-opc-bar={label} className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="eyebrow text-muted-foreground">{label}</span>
        <span className="font-mono text-[11px] tabular-nums">{`${value} · ${pctText(p)}`}</span>
      </div>
      <div
        role="meter"
        aria-label={`${label} in use`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(p)}
        className="flex h-[6px] w-full overflow-hidden rounded-sm border border-border bg-panel-2"
      >
        <div
          className={cn("h-full", tone === "danger" ? "bg-danger" : tone === "warn" ? "bg-warning" : "bg-primary")}
          style={{ width: `${p - wasted}%` }}
        />
        {wasted > 0 && <div className="h-full bg-muted-foreground/50" style={{ width: `${wasted}%` }} />}
      </div>
    </div>
  );
}

function FindingBox({ finding }: { finding: Finding }) {
  return (
    <Callout tone={finding.tone === "danger" ? "danger" : "warning"} live data-opc-finding={finding.key} title={tie(finding.title)}>
      {tie(finding.detail)}
      {finding.commands && finding.commands.length > 0 && (
        <div className="mt-2.5 flex flex-col gap-1.5">
          <span className="eyebrow text-muted-foreground">Run as root on the server</span>
          {finding.commands.map((c) => (
            <code
              key={c}
              className="font-mono block whitespace-pre-wrap rounded-sm border border-border bg-panel px-2.5 py-1.5 text-[11px] leading-relaxed [overflow-wrap:anywhere]"
            >
              {c}
            </code>
          ))}
        </div>
      )}
    </Callout>
  );
}

function ReportAge({ stale, reportedAt, now }: { stale: boolean; reportedAt: string; now: Date }) {
  return <SummaryAge stale={stale}>{tie(`${stale ? "Not reported: last report" : "Last report"} ${ageText(reportedAt, now)}`)}</SummaryAge>;
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

function NotReported() {
  return (
    <Callout tone="warning" live title="Not reported">
      {tie(
        `This server's agent has not sent a code cache report yet. Reports come from the telemetry agent every ${REPORT_INTERVAL_MINUTES} minutes, once the current agent is on the server.`
      )}
    </Callout>
  );
}

function ReadError({ message }: { message: string }) {
  return (
    <Callout tone="danger" live>
      {"The code cache report could not be read: "}
      <span className="font-mono text-[11.5px]">{message}</span>
    </Callout>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="text-pretty text-[11.5px] leading-relaxed text-muted-foreground">{children}</p>;
}
