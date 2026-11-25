"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import {
  Button,
  Callout,
  Copyable,
  DataTable,
  PageHeader,
  PanelHeader,
  StatusPill,
  type Column,
} from "@/components/ui";
import { IpAllowlistManager } from "@/components/security/ip-allowlist-manager";
import { FirewallTabs } from "@/components/security/firewall-tabs";
import { ALLOW_AN_IP_EVENT } from "@/components/security/firewall-sections";
import {
  ALLOW_LAYER_LABELS,
  coverageFor,
  ipFamily,
  verifyAgainstAgent,
  type AllowLayer,
} from "@/lib/ip-allowlist";
import { classifyWebLock, WEB_LOCK_ORDER, type WebLock } from "@/lib/web-lock";
import { OtherAddresses, RangesSource, WebLockPill } from "@/components/security/web-lock";
import { useCloudflareRanges } from "@/components/security/use-cloudflare-ranges";
import type { Database } from "@/lib/database.types";

type AllowRow = Database["public"]["Tables"]["ip_allowlist"]["Row"];
type BlockRow = Database["public"]["Tables"]["ip_blocks"]["Row"];
type FirewallState = Database["public"]["Tables"]["server_firewall_state"]["Row"];
type Server = Database["public"]["Tables"]["servers"]["Row"];

type WebRow = { server: Server; state: FirewallState | undefined; lock: WebLock };
type AllowView = { row: AllowRow; confirmed: number };
type BlockedEntry = { ip: string; server: string; serverId: number; where: string };

/**
 * Fleet-wide firewall view.
 *
 * Operator allowlist entries are cross-cutting by nature — an office range is
 * not a property of one server — so this is where they are managed. Blocks are
 * shown as the agent actually finds them, which is the only view that reveals
 * addresses blocking traffic with no record behind them.
 */
export default function FirewallPage() {
  const supabase = useMemo(() => createClient(), []);
  const [servers, setServers] = useState<Server[]>([]);
  const [allows, setAllows] = useState<AllowRow[]>([]);
  const [blocks, setBlocks] = useState<BlockRow[]>([]);
  const [states, setStates] = useState<Record<number, FirewallState>>({});
  const [loading, setLoading] = useState(true);
  const [allowOpen, setAllowOpen] = useState(false);

  // Set by "Allow my current IP" in the command palette: fill the form with
  // the address this browser is connecting from. Nothing is saved until the
  // form is submitted.
  const [allowMine, setAllowMine] = useState(false);

  // "Allow an IP" from the masthead's Firewall menu or the command palette:
  // an event when this page is already open, or ?allow=1 (?allow=me for
  // "my current IP") when it navigated here.
  useEffect(() => {
    const open = (mine: boolean) => {
      setAllowMine(mine);
      setAllowOpen(true);
    };
    const onEvent = (e: Event) => open((e as CustomEvent<{ mine?: boolean }>).detail?.mine === true);
    window.addEventListener(ALLOW_AN_IP_EVENT, onEvent);
    const url = new URL(window.location.href);
    const allow = url.searchParams.get("allow");
    if (allow === "1" || allow === "me") {
      url.searchParams.delete("allow");
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
      queueMicrotask(() => open(allow === "me"));
    }
    return () => window.removeEventListener(ALLOW_AN_IP_EVENT, onEvent);
  }, []);
  const [refreshKey, setRefreshKey] = useState(0);
  const [myIp, setMyIp] = useState<string | null>(null);
  const [myIpKnown, setMyIpKnown] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [serverRes, allowRes, blockRes, stateRes] = await Promise.all([
        supabase.from("servers").select("*").order("label"),
        supabase.from("ip_allowlist").select("*").is("removed_at", null).order("created_at", { ascending: false }),
        supabase.from("ip_blocks").select("*").is("removed_at", null).order("created_at", { ascending: false }),
        supabase.from("server_firewall_state").select("*"),
      ]);
      if (cancelled) return;
      if (serverRes.error) console.error("Servers fetch failed", serverRes.error);
      if (allowRes.error) console.error("Allowlist fetch failed", allowRes.error);
      if (blockRes.error) console.error("Blocks fetch failed", blockRes.error);
      if (stateRes.error) console.error("Firewall state fetch failed", stateRes.error);

      setServers(serverRes.data ?? []);
      setAllows(allowRes.data ?? []);
      setBlocks(blockRes.data ?? []);
      setStates(
        Object.fromEntries(((stateRes.data ?? []) as FirewallState[]).map((s) => [s.server_id, s]))
      );
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, refreshKey]);

  // Where this browser is connecting from, per Cloudflare. Null in local dev,
  // where there is no edge in front to ask.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/whoami", { cache: "no-store" });
        const data = await res.json();
        if (cancelled) return;
        setMyIp(typeof data?.ip === "string" ? data.ip : null);
      } catch {
        if (!cancelled) setMyIp(null);
      } finally {
        if (!cancelled) setMyIpKnown(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const coverage = coverageFor(
    myIp,
    allows.map((row) => ({ ip: row.ip, label: row.label }))
  );
  const myFamily = myIp ? ipFamily(myIp) : null;
  // Fail2Ban matches ignoreip per address family, so an entry in the other
  // family does nothing for this connection. Naming that is the difference
  // between "add an entry" and "add the RIGHT entry".
  const otherFamilyEntries = allows.filter(
    (row) => myFamily && ipFamily(row.ip) && ipFamily(row.ip) !== myFamily
  );

  const serverName = (id: number | null) =>
    servers.find((s) => s.id === id)?.label ?? (id ? `node ${id}` : "—");

  /** Everything the agents report as blocked, flattened with its origin. */
  const onServer = useMemo(() => {
    const names = new Map(servers.map((s) => [s.id, s.label ?? `node ${s.id}`]));
    const out: BlockedEntry[] = [];
    for (const state of Object.values(states)) {
      const label = names.get(state.server_id) ?? `node ${state.server_id}`;
      for (const ip of state.ufw_denied_ips ?? []) {
        out.push({ ip, server: label, serverId: state.server_id, where: "ufw" });
      }
      for (const [site, ips] of Object.entries(state.nginx_denies ?? {})) {
        for (const ip of ips) out.push({ ip, server: label, serverId: state.server_id, where: `nginx · ${site}` });
      }
    }
    return out;
  }, [states, servers]);

  const recordedIps = useMemo(
    () => new Set(blocks.map((b) => b.ip.trim().toLowerCase())),
    [blocks]
  );

  /** How many servers report allowlist state at all — see the NULL convention. */
  const reportingServers = Object.values(states).filter((s) => s.ufw_allowed_ips !== null).length;

  /** Web ports per server, what needs attention first. */
  const cloudflare = useCloudflareRanges();
  const webLocks = useMemo(
    () =>
      servers
        .map((s) => ({ server: s, state: states[s.id], lock: classifyWebLock(states[s.id], cloudflare.ranges) }))
        .sort(
          (a, b) =>
            WEB_LOCK_ORDER[a.lock.status] - WEB_LOCK_ORDER[b.lock.status] ||
            (a.server.label ?? "").localeCompare(b.server.label ?? "")
        ),
    [servers, states, cloudflare]
  );
  const lockedCount = webLocks.filter((w) => w.lock.status === "cloudflare" || w.lock.status === "cloudflare-plus").length;
  const webReporting = webLocks.filter((w) => w.lock.status !== "unreported").length;

  const allowManager = (
    <IpAllowlistManager
      open={allowOpen}
      onClose={() => setAllowOpen(false)}
      scope="global"
      initialIp={allowMine ? myIp ?? undefined : undefined}
      onRecorded={() => setRefreshKey((k) => k + 1)}
    />
  );

  const nameOf = (s: Server) => s.label ?? `node ${s.id}`;
  const scopeOf = (row: AllowRow) => (row.scope === "global" ? "Fleet-wide" : row.scope === "site" ? "One site" : serverName(row.server_id));

  const webColumns: Column<WebRow>[] = [
    {
      id: "server",
      header: "Server",
      phone: "title",
      grow: true,
      skeleton: "w-36",
      sortValue: (w) => nameOf(w.server),
      cell: (w) => (
        <Link href={`/servers/${w.server.id}`} className="block truncate text-[13px] font-bold leading-tight transition-colors duration-150 hover:text-primary">
          {nameOf(w.server)}
        </Link>
      ),
    },
    {
      id: "lock",
      header: "Web ports",
      phone: "trailing",
      skeleton: "w-24",
      sortValue: (w) => WEB_LOCK_ORDER[w.lock.status],
      sortWords: ["what needs attention first", "locked first"],
      cell: (w) => <WebLockPill lock={w.lock} />,
    },
    {
      id: "others",
      header: "Also open to",
      skeleton: "w-28",
      cell: (w) =>
        w.lock.others.length > 0 ? (
          <OtherAddresses addrs={w.lock.others} allows={allows.filter((a) => a.scope === "global" || a.server_id === w.server.id)} />
        ) : (
          <span className="text-faint">–</span>
        ),
    },
    {
      id: "read",
      header: "Read",
      numeric: true,
      phone: "subtitle",
      skeleton: "w-12",
      sortValue: (w) => w.state?.reported_at ?? null,
      sortWords: ["oldest first", "newest first"],
      cell: (w, where) => {
        const when = w.state?.reported_at ? relativeTime(w.state.reported_at) : "never";
        return where === "phone" ? <>Read {when}</> : <span className="text-[11.5px] text-muted-foreground">{when}</span>;
      },
    },
  ];

  const allowRows: AllowView[] = allows.map((row) => ({
    row,
    confirmed: Object.values(states).filter(
      (s) => verifyAgainstAgent(row.ip, s.fail2ban_ignoreip) === "verified" || verifyAgainstAgent(row.ip, s.ufw_allowed_ips) === "verified"
    ).length,
  }));

  const allowColumns: Column<AllowView>[] = [
    {
      id: "ip",
      header: "Address",
      phone: "title",
      skeleton: "w-28",
      sortValue: (a) => a.row.ip,
      cell: (a, where) =>
        where === "phone" ? (
          <span className="font-mono">{a.row.ip}</span>
        ) : (
          <Copyable value={a.row.ip} what="IP address" className="font-semibold [&>button]:-my-1" />
        ),
    },
    {
      id: "label",
      header: "Label",
      phone: "subtitle",
      grow: true,
      skeleton: "w-32",
      sortValue: (a) => a.row.label,
      cell: (a) => <span className="block truncate">{a.row.label}</span>,
    },
    {
      id: "scope",
      header: "Applies to",
      skeleton: "w-20",
      sortValue: (a) => scopeOf(a.row),
      cell: (a) => <StatusPill tone="neutral">{scopeOf(a.row)}</StatusPill>,
    },
    {
      id: "layers",
      header: "Generated for",
      className: "max-lg:hidden",
      skeleton: "w-28",
      cell: (a) => (
        <span className="flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
          {a.row.layers.map((l) => (
            <span key={l} className="whitespace-nowrap">
              {ALLOW_LAYER_LABELS[l as AllowLayer] ?? l}
            </span>
          ))}
        </span>
      ),
    },
    {
      id: "confirmed",
      header: "Confirmed on",
      end: true,
      phone: "trailing",
      skeleton: "w-16",
      sortValue: (a) => (reportingServers === 0 ? null : a.confirmed),
      sortWords: ["fewest servers first", "most servers first"],
      cell: (a) =>
        reportingServers === 0 ? (
          <span className="whitespace-nowrap font-mono text-[11px] text-faint">agent not reporting yet</span>
        ) : a.confirmed > 0 ? (
          <StatusPill tone="ok">
            {a.confirmed} of {reportingServers}
          </StatusPill>
        ) : (
          <StatusPill tone="warn">Not in force</StatusPill>
        ),
    },
  ];

  const isRecorded = (entry: BlockedEntry) => recordedIps.has(entry.ip.trim().toLowerCase());
  const blockedColumns: Column<BlockedEntry>[] = [
    {
      id: "ip",
      header: "Address",
      phone: "title",
      skeleton: "w-28",
      sortValue: (e) => e.ip,
      cell: (e, where) =>
        where === "phone" ? (
          <span className="font-mono">{e.ip}</span>
        ) : (
          <Copyable value={e.ip} what="IP address" className="font-semibold [&>button]:-my-1" />
        ),
    },
    {
      id: "server",
      header: "Server",
      phone: "subtitle",
      grow: true,
      skeleton: "w-32",
      sortValue: (e) => e.server,
      cell: (e) => (
        <Link href={`/servers/${e.serverId}`} className="block truncate transition-colors duration-150 hover:text-primary">
          {e.server}
        </Link>
      ),
    },
    {
      id: "where",
      header: "Layer",
      skeleton: "w-24",
      sortValue: (e) => e.where,
      cell: (e) => <span className="whitespace-nowrap font-mono text-[11.5px] text-muted-foreground">{e.where}</span>,
    },
    {
      id: "status",
      header: "Status",
      end: true,
      phone: "trailing",
      skeleton: "w-16",
      sortValue: (e) => (isRecorded(e) ? 1 : 0),
      sortWords: ["no record first", "recorded first"],
      cell: (e) => (isRecorded(e) ? <StatusPill tone="ok">Recorded</StatusPill> : <StatusPill tone="neutral">No record</StatusPill>),
    },
  ];

  const openAllow = (mine: boolean) => {
    setAllowMine(mine);
    setAllowOpen(true);
  };

  // Nothing below is swapped out when the data arrives: the title, the tabs,
  // the three headings and their column headings are there from the first
  // frame, and only the rows fill in.
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <PageHeader title="Firewall" stamp={loading ? "Loading" : `${servers.length} nodes`}>
          <Button variant="solid" size="sm" onClick={() => openAllow(false)} className="touch-hit">
            <ShieldCheck size={14} strokeWidth={1.75} />
            Allow an IP
          </Button>
        </PageHeader>
        <FirewallTabs />
      </div>

      {/* Where this browser connects from. Its room is held while the address is
          looked up; with no edge in front (local dev) there is nothing to show. */}
      {(!myIpKnown || myIp) && (
        <Callout
          live
          data-whoami={!myIpKnown || loading ? "loading" : coverage.covered ? "covered" : "uncovered"}
          tone={myIp && !loading && !coverage.covered ? "warning" : "note"}
          title={
            <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
              <span>You are connecting from</span>
              {myIp ? (
                <Copyable value={myIp} what="IP address" className="[&>button]:-my-1" />
              ) : (
                // As tall as the pill that arrives beside the address, so the line holds its height on a phone.
                <span aria-hidden="true" className="flex h-[21px] items-center">
                  <span className="block h-[10px] w-28 animate-pulse rounded-sm bg-line-strong" />
                </span>
              )}
              {myIp && myFamily && <StatusPill tone="neutral">{myFamily === "ipv6" ? "IPv6" : "IPv4"}</StatusPill>}
              {myIp && !loading ? (
                coverage.covered ? (
                  <StatusPill tone="ok">Covered by &ldquo;{coverage.by!.label}&rdquo;</StatusPill>
                ) : (
                  <StatusPill tone="warn">Not on the allowlist</StatusPill>
                )
              ) : (
                <span aria-hidden="true" className="block h-[21px] w-36 animate-pulse rounded-sm bg-line-strong" />
              )}
            </span>
          }
          action={
            myIp && !loading && !coverage.covered ? (
              <Button size="sm" onClick={() => openAllow(true)}>
                <ShieldCheck size={14} strokeWidth={1.75} /> Allow this address
              </Button>
            ) : undefined
          }
        >
          {myIp && !loading && !coverage.covered && allows.length > 0 && (
            <p className="mb-1.5">
              {otherFamilyEntries.length === allows.length ? (
                <>
                  Every recorded entry is {myFamily === "ipv6" ? "IPv4" : "IPv6"}, and you are connected over{" "}
                  {myFamily === "ipv6" ? "IPv6" : "IPv4"}. Fail2Ban matches ignoreip per address family, so those entries do nothing
                  for this connection: a dual-stack link needs one entry per family.
                </>
              ) : (
                <>
                  None of the {allows.length} recorded {allows.length === 1 ? "entry matches" : "entries match"} this address. A
                  residential or mobile address drifts, and an entry that no longer matches protects a stranger rather than you.
                </>
              )}
            </p>
          )}
          <p className="text-[11.5px] text-muted-foreground">
            This is the address this connection used. A dual-stack link has one of each, and only the one in use is visible here.
            Check from the other protocol to see its{"\u00a0"}counterpart.
          </p>
        </Callout>
      )}

      {/* ---------------- Web ports ---------------- */}
      <section>
        <PanelHeader title="Web ports 80 / 443" meta={loading ? "– of – locked to Cloudflare" : `${lockedCount} of ${servers.length} locked to Cloudflare`} />
        <DataTable
          noun="web ports"
          columns={webColumns}
          rows={webLocks}
          rowKey={(w) => String(w.server.id)}
          loading={loading}
          empty={{ title: "No servers yet", hint: "Each server's web ports are listed here once it is in the fleet." }}
        />
        <div className="mt-3 flex flex-col gap-1">
          {/* No text-wrap: pretty here. A sentence joins this note once the fleet has loaded, and pretty
              would re-break the words already on screen; plain wrapping only ever adds after them. */}
          <p className="text-[11.5px] leading-relaxed text-faint">
            Locked means only Cloudflare can reach the sites, so a visitor who knows a server&apos;s IP cannot skip Cloudflare and
            its firewall rules. On a GridPane server, <span className="font-mono text-muted-foreground">gp cloudflare enable</span>{" "}
            locks it and <span className="font-mono text-muted-foreground">gp cloudflare disable</span> undoes{"\u00a0"}it.
            {!loading && webReporting < servers.length && (
              <>
                {" "}
                {servers.length - webReporting} of {servers.length} servers run an agent that predates this check;{" "}
                <span className="font-mono text-muted-foreground">scripts/fix-telemetry-crontabs.sh --update</span> closes the{"\u00a0"}gap.
              </>
            )}
          </p>
          <RangesSource ranges={cloudflare} />
        </div>
      </section>

      {/* ---------------- Allowlist ---------------- */}
      <section>
        <PanelHeader title="Never blocked" meta={loading ? "– entries" : `${allows.length} ${allows.length === 1 ? "entry" : "entries"}`} />
        <DataTable
          noun="allowlist entries"
          columns={allowColumns}
          rows={allowRows}
          rowKey={(a) => String(a.row.id)}
          loading={loading}
          skeletonRows={3}
          empty={{
            title: "No allowlist entries",
            hint: "Record the addresses you work from (an office range, home, a hotspot) so your own security tooling can never lock you out.",
            action: (
              <Button size="sm" onClick={() => openAllow(false)}>
                <ShieldCheck size={14} strokeWidth={1.75} /> Allow an IP
              </Button>
            ),
          }}
        />
        {!loading && allows.length > 0 && reportingServers < servers.length && (
          <p className="mt-3 text-pretty text-[11.5px] leading-relaxed text-faint">
            {servers.length - reportingServers} of {servers.length} servers run an agent that predates allowlist reporting, so their
            state is unknown rather than empty. Run{" "}
            <span className="font-mono text-muted-foreground">scripts/fix-telemetry-crontabs.sh --update</span> to close the gap.
          </p>
        )}
      </section>

      {/* ---------------- Blocks ---------------- */}
      <section>
        <PanelHeader title="Blocked" meta={loading ? "– live on servers · – recorded" : `${onServer.length} live on servers · ${blocks.length} recorded`} />
        <DataTable
          noun="blocked addresses"
          columns={blockedColumns}
          rows={onServer}
          rowKey={(e) => `${e.serverId}-${e.where}-${e.ip}`}
          loading={loading}
          skeletonRows={3}
          pageSize={25}
          empty={
            blocks.length === 0
              ? {
                  title: "Nothing blocked",
                  hint: "Blocks composed on a server or site page appear here, alongside anything the agent finds already in place.",
                }
              : {
                  title: "No server reports a block",
                  hint: `${blocks.length} ${blocks.length === 1 ? "block is" : "blocks are"} recorded, and no agent finds one in place.`,
                }
          }
        />
      </section>

      {allowManager}
    </div>
  );
}

function relativeTime(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
