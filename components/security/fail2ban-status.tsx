"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Check, ChevronDown, Clock, Minus, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { Callout, Copyable, Skeleton, StatusPill, SummaryAge, SummaryFigure, SummaryStrip } from "@/components/ui";
import {
  KIND_META,
  KIND_ORDER,
  REPORT_INTERVAL_MINUTES,
  SITE_LIST_COLUMNS,
  ageText,
  banEnds,
  gridpaneJails,
  kindOfJail,
  otherServerJails,
  plural,
  serverSummary,
  siteStatus,
  tie,
  untilText,
  type CheckState,
  type F2bBan,
  type F2bLogLine,
  type F2bServerJail,
  type ServerF2bRow,
  type SiteF2bRow,
  type SiteStatus,
  type ZoneRef,
} from "@/lib/fail2ban";

/* ------------------------------------------------------------------ */
/* Data                                                               */
/* ------------------------------------------------------------------ */

type Loaded =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; server: ServerF2bRow | null; sites: SiteF2bRow[]; zones: ZoneRef[] };

/**
 * One server's Fail2Ban report: the server row, its sites, and the Cloudflare
 * zones to join against. Refetches when the server's row changes, which is the
 * same realtime pattern the live telemetry uses; the report function writes
 * that row last, so the site rows are already in when the change arrives.
 */
function useFail2Ban(serverId: number | undefined): Loaded {
  const supabase = useMemo(() => createClient(), []);
  const [state, setState] = useState<Loaded>({ status: "loading" });

  useEffect(() => {
    if (!serverId) return;
    let cancelled = false;

    async function load() {
      const [serverRes, sitesRes, zonesRes] = await Promise.all([
        supabase.from("server_fail2ban_state").select("*").eq("server_id", serverId).maybeSingle(),
        supabase.from("site_fail2ban_state").select(SITE_LIST_COLUMNS).eq("server_id", serverId).order("site"),
        supabase.from("cloudflare_zones").select("zone_id,name"),
      ]);
      if (cancelled) return;
      const error = serverRes.error ?? sitesRes.error ?? zonesRes.error;
      if (error) {
        setState({ status: "error", message: error.message });
        return;
      }
      setState({
        status: "ready",
        server: (serverRes.data as ServerF2bRow | null) ?? null,
        sites: ((sitesRes.data ?? []) as unknown as Omit<SiteF2bRow, "log_lines">[]).map((r) => ({
          ...r,
          log_lines: [],
        })),
        zones: (zonesRes.data ?? []) as ZoneRef[],
      });
    }

    load();
    const channel = supabase
      .channel(`server-${serverId}-fail2ban`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "server_fail2ban_state", filter: `server_id=eq.${serverId}` },
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

/**
 * The viewer's clock, ticking. A status is only as good as its report is
 * recent, and a server that goes silent sends no event to react to: without
 * this, a page left open would stay green forever.
 */
function useNow(everyMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), everyMs);
    return () => window.clearInterval(id);
  }, [everyMs]);
  return now;
}

/** The newest log lines one site wrote. Fetched only where they are shown. */
function useLogLines(serverId: number, site: string, reportedAt: string) {
  const supabase = useMemo(() => createClient(), []);
  const [lines, setLines] = useState<F2bLogLine[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("site_fail2ban_state")
        .select("log_lines")
        .eq("server_id", serverId)
        .eq("site", site)
        .maybeSingle();
      if (cancelled) return;
      if (error) console.error("Log lines fetch failed", error);
      setLines(((data?.log_lines as F2bLogLine[] | undefined) ?? []).filter((l) => l && typeof l.m === "string"));
    })();
    return () => {
      cancelled = true;
    };
    // reportedAt: refetch when a new report lands.
  }, [supabase, serverId, site, reportedAt]);
  return lines;
}

/* ------------------------------------------------------------------ */
/* Server view                                                        */
/* ------------------------------------------------------------------ */

/**
 * ServerFail2BanPanel — every site on one server with its status.
 *
 * Sites with active blocks come first, then anything not working, then the
 * rest. GridPane's own jails are listed apart: they are the server's, and a ban
 * of theirs is never counted as a site's.
 */
export function ServerFail2BanPanel({
  serverId,
  siteIds,
}: {
  serverId: number;
  /** hostname → sites.id, for the folders that are GridPane sites. */
  siteIds: Record<string, number>;
}) {
  const data = useFail2Ban(serverId);
  const now = useNow();
  const [open, setOpen] = useState<string | null>(null);

  return (
    <section data-f2b-server-panel className="flex flex-col gap-5 border-t border-line-strong pt-8">
      <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-2">
        <h2 className="text-balance text-[20px] font-extrabold tracking-[-0.02em]">Fail2Ban behind Cloudflare</h2>
        <span className="eyebrow text-muted-foreground">each site&apos;s own jails</span>
      </div>

      {data.status === "loading" ? (
        <Skeleton className="h-24 w-full" />
      ) : data.status === "error" ? (
        <Callout tone="danger" live>
          {"The Fail2Ban report could not be read: "}
          <span className="font-mono text-[11.5px]">{data.message}</span>
        </Callout>
      ) : (
        <ServerBody data={data} now={now} open={open} setOpen={setOpen} siteIds={siteIds} />
      )}
    </section>
  );
}

function ServerBody({
  data,
  now,
  open,
  setOpen,
  siteIds,
}: {
  data: Extract<Loaded, { status: "ready" }>;
  now: Date;
  open: string | null;
  setOpen: (site: string | null) => void;
  siteIds: Record<string, number>;
}) {
  const { server, sites, zones } = data;
  const summary = useMemo(() => serverSummary(sites, server, zones, now), [sites, server, zones, now]);

  if (!server) {
    return (
      <Callout tone="warning" live title="Not reported">
        This server&apos;s agent has not sent a Fail2Ban report. Reports come from the telemetry agent every{" "}
        {REPORT_INTERVAL_MINUTES} minutes, once the current agent is on the server.
      </Callout>
    );
  }

  const stale = summary.stale;
  const gp = gridpaneJails(server);
  const others = otherServerJails(server);

  return (
    <>
      {/* The one-line summary. */}
      <SummaryStrip data-f2b-summary stale={stale}>
        <SummaryFigure
          value={stale ? "0" : String(summary.working)}
          of={String(summary.total)}
          label={summary.total === 1 ? "site working" : "sites working"}
        />
        <SummaryFigure value={String(summary.activeBlocks)} label={summary.activeBlocks === 1 ? "active block" : "active blocks"} />
        <SummaryAge stale={stale}>{tie(`${stale ? "Not reported: last report" : "Last report"} ${ageText(server.reported_at, now)}`)}</SummaryAge>
      </SummaryStrip>

      {stale && (
        <Callout tone="warning" live title="This server has stopped reporting">
          Reports are due every {REPORT_INTERVAL_MINUTES} minutes and the last one is {ageText(server.reported_at, now)}.
          Every status below is what the server last said, not what is true now.
        </Callout>
      )}
      {!stale && !server.fail2ban_running && (
        <Callout tone="danger" live title="Fail2Ban is not running on this server">
          {server.fail2ban_present ? "It is installed but not answering." : "It is not installed."} Nothing is being
          banned here, at Cloudflare or locally.
        </Callout>
      )}
      {!stale && server.fail2ban_running && !server.token_file_present && (
        <Callout tone="danger" live title="The Cloudflare token file is missing">
          {"Without it no ban from this server can reach Cloudflare. Local firewall bans still\u00a0work."}
        </Callout>
      )}

      {/* Sites */}
      {summary.entries.length === 0 ? (
        <Note>The server&apos;s report lists no WordPress sites.</Note>
      ) : (
        <ul data-f2b-site-list className="flex flex-col border-t-2 border-foreground">
          {summary.entries.map(({ row, status, bans }) => {
            const isOpen = open === row.site;
            const id = `f2b-${row.site.replace(/[^a-z0-9]/gi, "-")}`;
            return (
              <li key={row.site} data-f2b-site={row.site} data-status={status.key} className="border-b border-border">
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={id}
                  onClick={() => setOpen(isOpen ? null : row.site)}
                  className="flex min-h-11 w-full flex-col gap-1.5 py-3 text-left transition-colors duration-150 hover:bg-panel-2/60 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary"
                >
                  <span className="flex w-full flex-wrap items-center gap-x-3 gap-y-1.5">
                    <span className="min-w-0 break-words text-[13px] font-bold leading-tight [overflow-wrap:anywhere]">
                      {row.site}
                    </span>
                    <span className="ml-auto flex shrink-0 items-center gap-2">
                      <StatusPill tone={status.tone} led>
                        {status.label}
                      </StatusPill>
                      <ChevronDown
                        size={14}
                        strokeWidth={1.75}
                        aria-hidden="true"
                        className={cn("text-muted-foreground transition-transform duration-150", isOpen && "rotate-180")}
                      />
                    </span>
                  </span>
                  <span className="flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-[10.5px] text-muted-foreground">
                    <span className={cn(bans > 0 && "font-semibold text-foreground")}>
                      {status.key === "not-reported" ? "blocks unknown" : `${bans} blocked now`}
                    </span>
                    <span>{plural(row.log_24h, "failure", "failures")} in 24 hours</span>
                  </span>
                  {status.key !== "working" && (
                    <span className="text-pretty text-[12px] leading-relaxed text-muted-foreground">{tie(status.reason)}</span>
                  )}
                </button>
                {isOpen && (
                  <div id={id} className="pb-5 pt-1">
                    <SiteDetail row={row} status={status} now={now} siteId={siteIds[row.site.toLowerCase()]} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {summary.skipped.map((s) => (
        <Note key={s.site}>
          <span className="font-mono text-muted-foreground">{s.site}</span>
          {` is not counted. ${s.why}`}
        </Note>
      ))}
      {server.orphan_jails.length > 0 && (
        <Note>
          <span className="font-mono text-muted-foreground">{server.orphan_jails.map((j) => j.name).join(", ")}</span>
          {server.orphan_jails.length === 1 ? " belongs" : " belong"} to a site whose folder is no longer on
          the{"\u00a0"}server.
        </Note>
      )}

      {/* GridPane's own jails — the server's, never a site's. */}
      <div data-f2b-gridpane className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-1.5">
          <span className="eyebrow">GridPane&apos;s own jails</span>
          <span className="font-mono text-[10.5px] text-muted-foreground">server-wide · not counted as any site&apos;s</span>
        </div>
        {gp.length === 0 ? (
          <Note>None of GridPane&apos;s WordPress jails is running on this server.</Note>
        ) : (
          <ul className="flex flex-col">
            {gp.map((j) => (
              <ServerJailRow key={j.name} jail={j} now={now} stale={stale} />
            ))}
          </ul>
        )}
        <Note>
          {server.gpcloudflare_conf
            ? "GridPane's old gpcloudflare.conf is still on this server. A jail above that lists gpcloudflare bans across the whole Cloudflare account through the old Global API Key, not in one site's zone."
            : "No old gpcloudflare.conf on this server. These jails ban in the local firewall only, which does not stop visitors who come through Cloudflare."}
        </Note>
        {others.length > 0 && (
          <Note>
            Other jails on this server:{" "}
            <span className="font-mono text-muted-foreground">
              {others.map((j) => `${j.name} (${stale ? "?" : (j.banned_now ?? 0)} blocked)`).join(", ")}
            </span>
            .
          </Note>
        )}
      </div>
    </>
  );
}

function ServerJailRow({ jail, now, stale }: { jail: F2bServerJail; now: Date; stale: boolean }) {
  const accountWide = jail.actions.includes("gpcloudflare");
  return (
    <li className="flex flex-col gap-1.5 border-b border-border py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-[12.5px] font-semibold">{jail.name}</span>
        <span className="font-mono text-[10.5px] text-muted-foreground"><Counters j={jail} /></span>
        <span className="ml-auto">
          {accountWide ? (
            <StatusPill tone="warn">Account-wide, old key</StatusPill>
          ) : (
            <StatusPill tone="neutral">Local firewall only</StatusPill>
          )}
        </span>
      </div>
      {!stale && jail.bans.length > 0 && <BanList bans={jail.bans} now={now} />}
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* Site view                                                          */
/* ------------------------------------------------------------------ */

/**
 * SiteFail2BanSection — one site's status on that site's own page: every
 * check, the three jails, who is blocked right now, and the newest log lines.
 */
export function SiteFail2BanSection({ serverId, host }: { serverId: number | undefined; host: string }) {
  const data = useFail2Ban(serverId);
  const now = useNow();
  const name = host.trim().toLowerCase().replace(/^www\./, "");

  const body = (() => {
    if (!serverId) return <Note>This site is not attached to a server, so there is no report to read.</Note>;
    if (data.status === "loading") return <Skeleton className="h-24 w-full" />;
    if (data.status === "error") {
      return (
        <Callout tone="danger" live>
          {"The Fail2Ban report could not be read: "}
          <span className="font-mono text-[11.5px]">{data.message}</span>
        </Callout>
      );
    }
    const row = data.sites.find((s) => s.site.toLowerCase() === name) ?? null;
    const status = siteStatus(row, data.server, data.zones, now);
    return (
      <>
        <StatusLine status={status} />
        {row && <SiteDetail row={row} status={status} now={now} />}
      </>
    );
  })();

  return (
    <section data-f2b-site-section className="flex flex-col gap-5 border-t border-line-strong pt-8">
      <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-2">
        <h2 className="text-balance text-[20px] font-extrabold tracking-[-0.02em]">Fail2Ban behind Cloudflare</h2>
        {serverId && (
          <Link
            href={`/servers/${serverId}`}
            className="eyebrow ml-auto text-foreground underline decoration-primary decoration-[1.5px] underline-offset-[3px] hover:decoration-2"
          >
            Server view
          </Link>
        )}
      </div>
      {body}
    </section>
  );
}

const calloutTone = { danger: "danger", warn: "warning", ok: "success", neutral: "note" } as const;

function StatusLine({ status }: { status: SiteStatus }) {
  return (
    <Callout data-f2b-status={status.key} tone={calloutTone[status.tone]} title={status.label}>
      {tie(status.reason)}
    </Callout>
  );
}

/* ------------------------------------------------------------------ */
/* Shared detail                                                      */
/* ------------------------------------------------------------------ */

function SiteDetail({
  row,
  status,
  now,
  siteId,
}: {
  row: SiteF2bRow;
  status: SiteStatus;
  now: Date;
  siteId?: number;
}) {
  const stale = status.key === "not-reported";
  const lines = useLogLines(row.server_id, row.site, row.reported_at);

  return (
    <div data-f2b-detail className="flex flex-col gap-6">
      {/* Checks */}
      <Group title="Checks" meta={`reported ${ageText(row.reported_at, now)}`}>
        <ul className="flex flex-col">
          {status.checks.map((c) => (
            <li key={c.key} data-check={c.key} data-state={c.state} className="flex gap-2.5 border-b border-border py-2.5">
              <CheckIcon state={c.state} />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[12.5px] font-semibold leading-tight">
                  {c.label}
                  <span className="sr-only">{`: ${CHECK_WORD[c.state]}`}</span>
                </span>
                <span className="text-pretty text-[12px] leading-relaxed text-muted-foreground">{tie(c.detail)}</span>
              </span>
            </li>
          ))}
        </ul>
        {stale && (
          <Note>
            {"Only the first check is judged while the report is out of date. The figures below are what the server last\u00a0said."}
          </Note>
        )}
      </Group>

      {/* Jails */}
      <Group title="Jails" meta={row.jails.length ? undefined : "none of its own"}>
        {row.jails.length === 0 ? (
          <Note>This site has no jails of its own on the server.</Note>
        ) : (
          <ul className="flex flex-col">
            {KIND_ORDER.map((k) => {
              const j = row.jails.find((x) => x.kind === k);
              const meta = KIND_META[k];
              return (
                <li key={k} data-jail={k} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border py-2.5">
                  <span className="text-[12.5px] font-semibold">{meta.label}</span>
                  <span className="text-[11.5px] text-muted-foreground">{`${meta.rule}, banned for ${meta.banText}`}</span>
                  <span className="ml-auto">
                    {!j ? (
                      <StatusPill tone="danger">Missing</StatusPill>
                    ) : j.running ? (
                      <StatusPill tone="ok">Running</StatusPill>
                    ) : (
                      <StatusPill tone="danger">Not running</StatusPill>
                    )}
                  </span>
                  {j && (
                    <span className="flex w-full flex-wrap gap-x-4 gap-y-0.5 font-mono text-[10.5px] text-muted-foreground">
                      <span className="break-all">{j.name}</span>
                      <Counters j={j} />
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Group>

      {/* Bans */}
      <Group
        title="Blocked right now"
        meta={stale ? "unknown: report out of date" : plural(row.bans.length, "address", "addresses")}
      >
        {stale ? (
          <Note>
            Fail2Ban bans expire on their own, so a list from {ageText(row.reported_at, now)} would not describe who is
            blocked now.
          </Note>
        ) : row.bans.length === 0 ? (
          <Note>{"Nobody is blocked by this site's jails at the last\u00a0report."}</Note>
        ) : (
          <BanList bans={row.bans} now={now} />
        )}
      </Group>

      {/* Log */}
      <Group title="Recent log lines" meta={`${plural(row.log_24h, "failure", "failures")} in 24 hours`}>
        {lines === null ? (
          <Skeleton className="h-16 w-full" />
        ) : lines.length === 0 ? (
          <Note>
            {row.plugin === "off"
              ? "Nothing in the log: the plugin is off, so this site writes no lines."
              : "Nothing in the log for this site. With the plugin on, that is normal for a quiet site."}
          </Note>
        ) : (
          <>
            <ol
              data-f2b-log
              tabIndex={0}
              aria-label={`Newest log lines for ${row.site}`}
              className="flex max-h-72 flex-col overflow-y-auto rounded-md border border-border bg-panel-2 px-3 py-1 focus-visible:outline-2 focus-visible:outline-primary"
            >
              {lines.map((l, i) => (
                <li key={i} className="flex flex-col gap-0.5 border-b border-border py-1.5 last:border-0 sm:flex-row sm:gap-3">
                  <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground sm:w-32">{l.t ? clock(l.t, now) : "time unknown"}</span>
                  <span className="min-w-0 font-mono text-[11.5px] leading-relaxed [overflow-wrap:anywhere]">{l.m}</span>
                </li>
              ))}
            </ol>
            <Note>
              {tie(`The newest ${lines.length === 1 ? "line" : `${lines.length} lines`} this site wrote to /var/log/auth.log, newest first. The 24-hour count leaves out sign-ins that worked.`)}
            </Note>
          </>
        )}
      </Group>

      {siteId !== undefined && (
        <Link
          href={`/sites/${siteId}`}
          className="eyebrow self-start py-2 text-foreground underline decoration-primary decoration-[1.5px] underline-offset-[3px] hover:decoration-2"
        >
          Open this site
        </Link>
      )}
    </div>
  );
}

function BanList({ bans, now }: { bans: F2bBan[]; now: Date }) {
  return (
    <ul data-f2b-bans className="flex flex-col">
      {bans.map((b) => {
        const kind = kindOfJail(b.jail);
        const ends = banEnds(b);
        return (
          <li key={`${b.jail}-${b.ip}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border py-2.5">
            <Copyable value={b.ip} what="IP address" className="text-[12.5px] font-semibold">
              {b.ip}
            </Copyable>
            <span className="font-mono text-[10.5px] text-muted-foreground">{kind ? `${KIND_META[kind].label.toLowerCase()} jail` : b.jail}</span>
            <span className="ml-auto text-right text-[11.5px] text-muted-foreground">
              {b.at ? `since ${clock(b.at, now)}` : "start time not reported"}
              {" · "}
              {ends.iso ? `ends ${untilText(ends.iso, now)}` : "end time not reported"}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/* ------------------------------------------------------------------ */
/* Small parts                                                        */
/* ------------------------------------------------------------------ */

const CHECK_WORD: Record<CheckState, string> = {
  pass: "passed",
  fail: "failed",
  waiting: "waiting",
  na: "does not apply",
};

function CheckIcon({ state }: { state: CheckState }) {
  const Icon = state === "pass" ? Check : state === "fail" ? X : state === "waiting" ? Clock : Minus;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm",
        state === "pass" && "bg-primary/10 text-primary",
        state === "fail" && "bg-danger/10 text-danger",
        state === "waiting" && "bg-warning/10 text-warning",
        state === "na" && "bg-panel-2 text-muted-foreground"
      )}
    >
      <Icon size={12} strokeWidth={2.25} />
    </span>
  );
}

function Counters({ j }: { j: { failed_now: number | null; failed_total: number | null; banned_now: number | null; banned_total: number | null } }) {
  const n = (v: number | null) => (v === null ? "?" : String(v));
  return (
    <span className="flex flex-wrap gap-x-4 gap-y-0.5">
      <span className="whitespace-nowrap">{`failed ${n(j.failed_now)} now, ${n(j.failed_total)} total`}</span>
      <span className="whitespace-nowrap">{`blocked ${n(j.banned_now)} now, ${n(j.banned_total)} total`}</span>
    </span>
  );
}

/** "2:07 PM" today, "Nov 12, 2:07 PM" otherwise, in the viewer's own time zone. */
function clock(iso: string, now: Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "time unknown";
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
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
