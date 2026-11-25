"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Copyable, EmptyState, StatusPill } from "@/components/ui";
import { LAYER_LABELS, type Layer } from "@/lib/ip-blocking";
import { ALLOW_LAYER_LABELS, verifyAgainstAgent, type AllowLayer } from "@/lib/ip-allowlist";
import { classifyWebLock } from "@/lib/web-lock";
import { tied } from "@/lib/utils";
import { WebLockDetail } from "@/components/security/web-lock";
import { useCloudflareRanges } from "@/components/security/use-cloudflare-ranges";
import type { Database, Json } from "@/lib/database.types";

type BlockRow = Database["public"]["Tables"]["ip_blocks"]["Row"];
type AllowRow = Database["public"]["Tables"]["ip_allowlist"]["Row"];
type FirewallState = Database["public"]["Tables"]["server_firewall_state"]["Row"];

/**
 * `server_firewall_state.nginx_denies` is a jsonb column, so its generated type
 * is the whole Json union and cannot be indexed by site URL.
 *
 * The fleet agent writes it as `{ "<site url>": ["203.0.113.4", "10.0.0.0/8"] }`
 * (scripts/telemetry-agent.sh, via report_firewall_state) and every row holds
 * that shape today. Narrow it here rather than asserting the shape at each use:
 * an unexpected payload reports as no denies instead of crashing the panel, and
 * a non-string entry is dropped rather than rendered as an IP. This panel is
 * labelled as what the agent actually found on the box, so it must never invent
 * an entry — the same rule that governs the recorded-versus-applied split.
 */
function readNginxDenies(value: Json | null | undefined): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string[]> = {};
  for (const [site, addrs] of Object.entries(value)) {
    if (Array.isArray(addrs)) {
      out[site] = addrs.filter((addr): addr is string => typeof addr === "string");
    }
  }
  return out;
}

/**
 * Everything the app knows about one target's firewall, rendered without a modal.
 *
 * This exists because the block ledger is otherwise visible only inside the
 * generator dialog, and the agent's read-back would be collected and displayed
 * nowhere. Both halves are here, side by side,
 * so the interesting question is answerable at a glance: does what we intended
 * match what is actually on the box?
 *
 * Three states, never two. An address can be recorded-but-unconfirmed, confirmed,
 * or present on the server with no record at all — that last group is the one
 * nobody ever sees otherwise, and it can be the largest.
 */
export function FirewallPanel({
  scope,
  serverId,
  siteId,
  siteUrl,
  refreshKey = 0,
}: {
  scope: "server" | "site";
  serverId?: number;
  siteId?: number;
  /** Site domain — the key nginx denies are stored under. */
  siteUrl?: string;
  /** Bump to refetch after the generator modals record something. */
  refreshKey?: number;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [blocks, setBlocks] = useState<BlockRow[]>([]);
  const [allows, setAllows] = useState<AllowRow[]>([]);
  const [state, setState] = useState<FirewallState | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      // Guard inside the async body rather than the effect: a synchronous
      // setState in an effect triggers a cascading render, and lint is right
      // to object.
      if (!((scope === "site" && siteId) || (scope === "server" && serverId))) {
        if (!cancelled) setLoading(false);
        return;
      }

      const blockQuery = supabase.from("ip_blocks").select("*").is("removed_at", null);
      const scoped =
        scope === "site"
          ? blockQuery.eq("site_id", siteId!)
          : blockQuery.eq("server_id", serverId!).is("site_id", null);

      // A global allowlist entry applies here by definition, so it is fetched
      // alongside the scoped ones rather than being a separate list to reconcile.
      const allowQuery = supabase.from("ip_allowlist").select("*").is("removed_at", null);
      const allowScoped =
        scope === "site"
          ? allowQuery.or(`scope.eq.global,site_id.eq.${siteId}`)
          : allowQuery.or(`scope.eq.global,server_id.eq.${serverId}`);

      const [blockRes, allowRes, stateRes] = await Promise.all([
        scoped.order("created_at", { ascending: false }),
        allowScoped.order("created_at", { ascending: false }),
        serverId
          ? supabase.from("server_firewall_state").select("*").eq("server_id", serverId).maybeSingle()
          : Promise.resolve({ data: null, error: null }),
      ]);

      if (cancelled) return;
      if (blockRes.error) console.error("Block ledger fetch failed", blockRes.error);
      if (allowRes.error) console.error("Allowlist fetch failed", allowRes.error);
      if (stateRes.error) console.error("Firewall state fetch failed", stateRes.error);

      const blockRows = blockRes.data ?? [];
      const fwState = (stateRes.data as FirewallState | null) ?? null;

      setBlocks(blockRows);
      setAllows(allowRes.data ?? []);
      setState(fwState);
      setLoading(false);

      // Stamp applied_at the first time the agent's read-back confirms a
      // recorded block is genuinely on the box. The column existed from the
      // start and nothing ever set it, which left the ledger unable to
      // distinguish "asked for" from "in force" — the same measured-beats-
      // recorded rule the hardware specs use.
      if (fwState) {
        const live = new Set<string>();
        for (const addr of fwState.ufw_denied_ips ?? []) live.add(addr.trim().toLowerCase());
        for (const addrs of Object.values(fwState.nginx_denies ?? {})) {
          for (const addr of addrs) live.add(addr.trim().toLowerCase());
        }
        const newlyApplied = blockRows.filter(
          (row) => !row.applied_at && live.has(row.ip.trim().toLowerCase())
        );
        if (newlyApplied.length > 0) {
          const stampedAt = new Date().toISOString();
          const { error } = await supabase
            .from("ip_blocks")
            .update({ applied_at: stampedAt })
            .in("id", newlyApplied.map((row) => row.id));
          if (error) console.error("Could not stamp applied_at", error);
          else if (!cancelled) {
            setBlocks((prev) =>
              prev.map((row) =>
                newlyApplied.some((n) => n.id === row.id) ? { ...row, applied_at: stampedAt } : row
              )
            );
          }
        }
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [supabase, scope, serverId, siteId, refreshKey]);

  /** Everything the agent reports as genuinely blocked for this target. */
  const onServer = useMemo(() => {
    if (!state) return [] as { ip: string; where: string }[];
    const out: { ip: string; where: string }[] = [];
    const nginxDenies = readNginxDenies(state.nginx_denies);
    if (scope === "site") {
      for (const addr of nginxDenies[siteUrl ?? ""] ?? []) out.push({ ip: addr, where: "nginx" });
    } else {
      for (const addr of state.ufw_denied_ips ?? []) out.push({ ip: addr, where: "ufw" });
      for (const [site, addrs] of Object.entries(nginxDenies)) {
        for (const addr of addrs) out.push({ ip: addr, where: `nginx · ${site}` });
      }
    }
    return out;
  }, [state, scope, siteUrl]);

  const recordedIps = useMemo(
    () => new Set(blocks.map((b) => b.ip.trim().toLowerCase())),
    [blocks]
  );
  const onServerIps = useMemo(
    () => new Set(onServer.map((entry) => entry.ip.trim().toLowerCase())),
    [onServer]
  );
  const unrecorded = onServer.filter((entry) => !recordedIps.has(entry.ip.trim().toLowerCase()));

  const stamp = state?.reported_at ? relativeTime(state.reported_at) : null;
  const reportsAllowlist = state?.ufw_allowed_ips !== null && state?.ufw_allowed_ips !== undefined;
  const cloudflare = useCloudflareRanges();
  const webLock = useMemo(() => classifyWebLock(state, cloudflare.ranges), [state, cloudflare]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-6 text-muted-foreground">
        <Loader2 size={14} strokeWidth={1.75} className="animate-spin" />
        <span className="text-[12px]">Reading firewall state</span>
      </div>
    );
  }

  const nothingAtAll =
    blocks.length === 0 && allows.length === 0 && onServer.length === 0 && !state;

  if (nothingAtAll) {
    return (
      <EmptyState
        icon={ShieldCheck}
        title="No firewall rules recorded"
        hint="Blocks and allowlist entries composed here will appear in this panel, alongside anything the fleet agent finds on the server."
        className="py-8"
      />
    );
  }

  return (
    <div className="flex flex-col gap-6 py-3">
      {/* ---------------- Web ports ---------------- */}
      {state && (
        <Group
          title="Web ports 80 / 443"
          meta={[scope === "site" ? "server-wide" : null, stamp ? `read ${stamp}` : null].filter(Boolean).join(" · ") || undefined}
        >
          <WebLockDetail lock={webLock} ranges={cloudflare} allows={allows} />
        </Group>
      )}

      {/* ---------------- Allowlist ---------------- */}
      <Group
        title="Never blocked"
        meta={allows.length ? `${allows.length} ${allows.length === 1 ? "entry" : "entries"}` : undefined}
      >
        {allows.length === 0 ? (
          <Note>
            No allowlist entries. An operator range recorded here generates the
            Fail2Ban, UFW and Cloudflare rules that keep you from being locked out
            by your own security.
          </Note>
        ) : (
          <ul className="flex flex-col">
            {allows.map((row) => {
              const f2b = verifyAgainstAgent(row.ip, state?.fail2ban_ignoreip);
              const ufw = verifyAgainstAgent(row.ip, state?.ufw_allowed_ips);
              return (
                <Row
                  key={row.id}
                  ip={row.ip}
                  label={row.label}
                  sub={row.scope === "global" ? "fleet-wide" : row.scope === "site" ? "this site" : "this server"}
                  pills={
                    <>
                      {row.layers.map((layer) => (
                        <StatusPill key={layer} tone="neutral">
                          {ALLOW_LAYER_LABELS[layer as AllowLayer] ?? layer}
                        </StatusPill>
                      ))}
                      <VerifyPill state={f2b} layer="Fail2Ban" />
                      <VerifyPill state={ufw} layer="UFW" />
                    </>
                  }
                />
              );
            })}
          </ul>
        )}
      </Group>

      {/* ---------------- Blocks ---------------- */}
      <Group
        title="Blocked"
        meta={
          stamp
            ? `${onServer.length} on the server · read ${stamp}`
            : "no agent report"
        }
      >
        {blocks.length === 0 && onServer.length === 0 ? (
          <Note>Nothing blocked here, and the agent found no rules on the server.</Note>
        ) : (
          <ul className="flex flex-col">
            {blocks.map((row) => {
              const confirmed = onServerIps.has(row.ip.trim().toLowerCase());
              return (
                <Row
                  key={`b-${row.id}`}
                  ip={row.ip}
                  label={row.reason ?? undefined}
                  sub={LAYER_LABELS[row.layer as Layer] ?? row.layer}
                  pills={
                    confirmed ? (
                      <StatusPill tone="ok">
                        {row.applied_at ? `In force since ${shortDate(row.applied_at)}` : "On the server"}
                      </StatusPill>
                    ) : (
                      <StatusPill tone="warn">Recorded only</StatusPill>
                    )
                  }
                />
              );
            })}
            {unrecorded.map((entry) => (
              <Row
                key={`u-${entry.where}-${entry.ip}`}
                ip={entry.ip}
                sub={entry.where}
                pills={<StatusPill tone="neutral">Found on the server</StatusPill>}
              />
            ))}
          </ul>
        )}
        {unrecorded.length > 0 && (
          <Note>
            {unrecorded.length} {unrecorded.length === 1 ? "address is" : "addresses are"} blocking
            traffic on the server with no matching record here — added by hand over SSH,
            most likely, and shown so the two views cannot silently drift apart.
          </Note>
        )}
      </Group>

      {/* ---------------- Fail2Ban ---------------- */}
      {scope === "server" && (
        <Group
          title="Fail2Ban"
          meta={
            state?.fail2ban_present === false
              ? "not installed"
              : stamp
                ? `as of ${stamp}`
                : undefined
          }
        >
          {!reportsAllowlist ? (
            <Note>
              This server&apos;s agent predates Fail2Ban reporting. Run{" "}
              <Copyable value="scripts/fix-telemetry-crontabs.sh --update" what="command" className="text-muted-foreground">
                scripts/fix-telemetry-crontabs.sh --update
              </Copyable>{" "}
              and it will start reporting on the next cycle.
            </Note>
          ) : state?.fail2ban_present === false ? (
            <Note>Fail2Ban is not installed on this server, so nothing is banned by it.</Note>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <span className="eyebrow text-faint">ignoreip — never banned</span>
                {(state?.fail2ban_ignoreip ?? []).length === 0 ? (
                  <Note>Empty. Only Fail2Ban&apos;s built-in defaults apply.</Note>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {state!.fail2ban_ignoreip!.map((addr) => (
                      <Copyable key={addr} value={addr} what="IP address" className="text-[11.5px] text-muted-foreground">
                        {addr}
                      </Copyable>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="eyebrow text-faint">Banned right now</span>
                {Object.keys(state?.fail2ban_banned ?? {}).length === 0 ? (
                  <Note>No active bans at the last read.</Note>
                ) : (
                  <ul className="flex flex-col">
                    {Object.entries(state!.fail2ban_banned!).map(([jail, addrs]) => (
                      <li key={jail} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border py-2">
                        <span className="font-mono text-[12px] font-semibold">{jail}</span>
                        <span className="min-w-0 font-mono text-[11.5px] text-muted-foreground">
                          {addrs.join("  ")}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <Note>
                  Fail2Ban bans expire on their own and are lost when it restarts. This is a
                  snapshot from the last agent run, not a live view — for a permanent block,
                  record one{"\u00a0"}above.
                </Note>
              </div>
            </div>
          )}
        </Group>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Group({ title, meta, children }: { title: string; meta?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-1.5">
        <span className="eyebrow">{title}</span>
        {meta && <span className="font-mono text-[10.5px] text-faint">{meta}</span>}
      </div>
      {children}
    </section>
  );
}

function Row({
  ip,
  label,
  sub,
  pills,
}: {
  ip: string;
  label?: string;
  sub?: string;
  pills?: React.ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border py-2.5">
      <Copyable value={ip} what="IP address" className="text-[12.5px] font-semibold">
        {ip}
      </Copyable>
      {label && <span className="text-[12px] text-muted-foreground">{label}</span>}
      {sub && <span className="font-mono text-[10.5px] text-faint">{sub}</span>}
      <span className="ml-auto flex flex-wrap items-center gap-1.5">{pills}</span>
    </li>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-pretty text-[11.5px] leading-relaxed text-faint">{tied(children)}</p>
  );
}

/**
 * Three outcomes, not two. "Unreported" means the agent on that box does not
 * send allowlist state yet — showing it as missing would blame the allowlist for
 * a stale agent.
 */
function VerifyPill({ state, layer }: { state: ReturnType<typeof verifyAgainstAgent>; layer: string }) {
  if (state === "unreported") return null;
  return state === "verified" ? (
    <StatusPill tone="ok">{layer} ✓</StatusPill>
  ) : (
    <StatusPill tone="warn">{layer} not set</StatusPill>
  );
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
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
