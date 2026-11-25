"use client";

import { Cpu, Globe, HardDrive, MapPin, MemoryStick, Server as ServerIcon, Settings, ShieldBan, ShieldCheck, Terminal, ScrollText, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { cn, getProviderName } from "@/lib/utils";
import {
  PENDING_LABEL,
  effectiveCores,
  effectiveRamGb,
  providerCaption,
  resolveCores,
  resolveProvider,
  resolveRam,
  type ServerHardware,
} from "@/lib/server-specs";
import { formatOsVersion } from "@/lib/os-version";
import { useState, use, useEffect, type ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";
import { LogRetentionGenerator } from "@/components/waf/log-retention-generator";
import { IpBlockManager } from "@/components/security/ip-block-manager";
import { IpAllowlistManager } from "@/components/security/ip-allowlist-manager";
import { FirewallPanel } from "@/components/security/firewall-panel";
import { ServerFail2BanPanel } from "@/components/security/fail2ban-status";
import { ServerWafPanel } from "@/components/security/waf-status";
import { ServerOpcachePanel } from "@/components/performance/opcache-status";
import { Database } from "@/lib/database.types";
import {
  Button,
  Copyable,
  DataTable,
  DetailHeader,
  EmptyState,
  Input,
  Meter,
  Modal,
  PanelHeader,
  StatusPill,
  buttonClasses,
  type Column,
} from "@/components/ui";

type Server = Database["public"]["Tables"]["servers"]["Row"];
type Site = Database["public"]["Tables"]["sites"]["Row"];
type TelemetryRow = Database["public"]["Tables"]["server_telemetry"]["Row"];
// The newest reading on screen, and whether a real agent sent it. A stored reading may hold only some columns.
type LatestTelemetry = Partial<TelemetryRow> & { isReal?: boolean };

export default function ServerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const resolvedParams = use(params);

  const [server, setServer] = useState<Server | null>(null);
  const [serverSites, setServerSites] = useState<Site[]>([]);
  const [latestTelemetry, setLatestTelemetry] = useState<LatestTelemetry | null>(null);
  const [hardware, setHardware] = useState<ServerHardware | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [configOpen, setConfigOpen] = useState(false);
  const [logRetentionOpen, setLogRetentionOpen] = useState(false);
  const [ipBlockOpen, setIpBlockOpen] = useState(false);
  const [ipAllowOpen, setIpAllowOpen] = useState(false);
  /** Bumped when a generator records something, so the panel refetches. */
  const [firewallKey, setFirewallKey] = useState(0);

  const [editedCpu, setEditedCpu] = useState("");
  const [editedRam, setEditedRam] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const supabase = createClient();

  const handleOpenConfig = () => {
    // Show what is actually in effect — a measured reading outranks the record,
    // so an empty box would misrepresent a server the agent has already sized.
    const cores = effectiveCores(server, hardware);
    const ramGb = effectiveRamGb(server, hardware);
    setEditedCpu(cores !== null ? String(cores) : "");
    setEditedRam(ramGb !== null ? String(ramGb) : "");
    setConfigOpen(true);
  };

  const handleSaveConfig = async () => {
    if (!server) return;
    setIsSaving(true);

    const ramInMb = editedRam ? String(parseInt(editedRam) * 1024) : null;
    const cpuStr = editedCpu ? String(editedCpu) : null;

    try {
      const res = await fetch(`/api/servers/${server.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cpu: cpuStr, ram: ramInMb })
      });

      if (res.ok) {
        setServer({ ...server, cpu: cpuStr, ram: ramInMb });
        setConfigOpen(false);
      } else {
        console.error("Failed to update hardware configuration via edge.");
      }
    } catch (e) {
      console.error(e);
    }

    setIsSaving(false);
  };

  useEffect(() => {
    async function fetchServerDetails() {
      const serverId = parseInt(resolvedParams.id);

      const { data: serverData, error: serverError } = await supabase
        .from("servers")
        .select("*")
        .eq("id", serverId)
        .maybeSingle(); // no row is an answer here, not an error: `.single()` logged a 406 in the console for it

      if (serverError && serverError.code !== "PGRST116") console.error("Server fetch failed", serverError);

      if (!serverData) {
        setIsLoading(false);
        return;
      }

      setServer(serverData);

      const { data: sitesData, error: sitesError } = await supabase
        .from("sites")
        .select("*")
        .eq("server_id", serverId)
        .order("url");

      if (sitesError) console.error("Sites fetch failed", sitesError);

      if (sitesData) {
        setServerSites(sitesData);
      }

      // Specs the agent measured on the box. Absent until the agent is
      // redeployed, in which case the GridPane/manual values still render.
      const { data: hardwareData, error: hardwareError } = await supabase
        .from("server_hardware")
        .select("*")
        .eq("server_id", serverId)
        .maybeSingle();

      if (hardwareError) console.error("Hardware fetch failed", hardwareError);
      setHardware(hardwareData ?? null);

      const tenMinsAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const [telemetryRes, liveAgentRes] = await Promise.all([
        supabase
          .from("server_telemetry")
          .select("cpu_usage, ram_usage, disk_usage, disk_total_gb, disk_www_mb, disk_mysql_mb, disk_backups_mb")
          .eq("server_id", serverId)
          .order("timestamp", { ascending: false })
          .limit(1)
          .maybeSingle(), // a server with no reading yet is an answer, not a 406 in the console
        supabase
          .from("server_telemetry")
          .select("id")
          .eq("server_id", serverId)
          .ilike("top_processes_b64", "%|AGENT_V1%")
          .gte("timestamp", tenMinsAgo)
          .limit(1)
      ]);

      if (telemetryRes.error && telemetryRes.error.code !== "PGRST116") console.error("Telemetry fetch failed", telemetryRes.error);
      if (liveAgentRes.error) console.error("Live agent check failed", liveAgentRes.error);

      const isVerifiedReal = !!(liveAgentRes.data && liveAgentRes.data.length > 0);

      if (telemetryRes.data) {
        setLatestTelemetry({ ...telemetryRes.data, isReal: isVerifiedReal });
      } else {
        setLatestTelemetry({ isReal: isVerifiedReal });
      }

      setIsLoading(false);
    }
    fetchServerDetails();

    const channel = supabase.channel(`server-${resolvedParams.id}-telemetry`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "server_telemetry",
          filter: `server_id=eq.${resolvedParams.id}`
        },
        (payload) => {
          const newRow = payload.new as TelemetryRow;
          const isPayloadReal = newRow.top_processes_b64 === "toast" || (newRow.top_processes_b64?.includes("|AGENT_V1") ?? false);

          setLatestTelemetry((prev) => {
             const prevIsReal = prev?.isReal || false;
             if (prevIsReal && !isPayloadReal) {
                return prev;
             }
             return { ...newRow, isReal: isPayloadReal || prevIsReal };
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, resolvedParams.id]);

  if (isLoading) return <ServerDetailLoading />;

  if (!server) {
    return (
      <EmptyState
        icon={ServerIcon}
        title="Server not found"
        hint="The requested server ID is not in the active registry."
        action={
          <Link href="/servers" className={buttonClasses({ className: "touch-hit" })}>
            Return to servers
          </Link>
        }
        className="py-24"
      />
    );
  }

  const cores = resolveCores(server, hardware);
  const ram = resolveRam(server, hardware);
  const provider = resolveProvider(getProviderName(server.provider_id, server.provider), hardware);
  const specsMeasured = cores.source === "measured" && ram.source === "measured";

  // Manual entry is offered whenever the agent hasn't measured the box — that,
  // not the provider, is the condition that makes typing values useful.
  const allowManualSpecs = !specsMeasured;

  return (
    <div className="flex flex-col gap-8">
      <DetailHeader
        title={server.label}
        status={
          <>
            <StatusPill tone={server.status === "active" ? "ok" : "danger"}>{server.status || "offline"}</StatusPill>
            {latestTelemetry?.isReal && <StatusPill tone="live">Live agent</StatusPill>}
          </>
        }
        facts={[
          server.ip && <Copyable value={server.ip} what="IP address" />,
          provider.label,
          <>
            {serverSites.length}{" "}
            {serverSites.length === 1 ? "site" : "sites"}
          </>,
          <>node {server.id}</>,
        ]}
        actions={
          <>
            <Button onClick={handleOpenConfig} className="touch-hit">
              <Settings size={14} strokeWidth={1.75} /> Configure
            </Button>
            <Link href={`/monitoring/${server.id}`} className={buttonClasses({ variant: "solid", className: "touch-hit" })}>
              <Terminal size={14} strokeWidth={1.75} /> Process snapshot
            </Link>
          </>
        }
      />

      {/* Two rule-separated sections */}
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-2 lg:gap-0">
        {/* Left column: hardware, then the sites, stacked so the taller
            firewall column cannot push the sites down the page. */}
        <div className="flex flex-col gap-10 lg:pr-8">
        <section>
          <PanelHeader title="Hardware" meta={latestTelemetry?.isReal ? "live telemetry" : undefined} />

          <div className="flex flex-col">
            <HardwareRow
              icon={Cpu}
              label="CPU"
              title={cores.exact}
              value={
                <>
                  {cores.text ?? PENDING_LABEL}
                  {latestTelemetry?.cpu_usage !== undefined && ` · ${latestTelemetry.cpu_usage}%`}
                </>
              }
            >
              {latestTelemetry?.cpu_usage !== undefined && (
                <Meter value={Math.min(100, Math.max(0, latestTelemetry.cpu_usage))} metric="cpu" className="mt-2.5" />
              )}
            </HardwareRow>

            <HardwareRow
              icon={MemoryStick}
              label="RAM"
              title={ram.exact}
              value={
                <>
                  {ram.text ?? PENDING_LABEL}
                  {latestTelemetry?.ram_usage !== undefined && ` · ${latestTelemetry.ram_usage}%`}
                </>
              }
            >
              {latestTelemetry?.ram_usage !== undefined && (
                <Meter value={Math.min(100, Math.max(0, latestTelemetry.ram_usage))} metric="memory" className="mt-2.5" />
              )}
            </HardwareRow>

            {/* Disk + composition */}
            <HardwareRow
              icon={HardDrive}
              label="Disk"
              value={
                <>
                  {latestTelemetry?.disk_total_gb ? `${latestTelemetry.disk_total_gb} GB NVMe` : "no report yet"}
                  {latestTelemetry?.disk_usage ? ` · ${latestTelemetry.disk_usage}% used` : ""}
                  {/* The amount needs the disk's size: without it the percentage stands alone, not "(0.0 GB)". */}
                  {latestTelemetry?.disk_usage && latestTelemetry.disk_total_gb
                    ? ` (${((latestTelemetry.disk_usage / 100) * latestTelemetry.disk_total_gb).toFixed(1)}\u00a0GB)`
                    : ""}
                </>
              }
            >
              {latestTelemetry?.disk_usage !== undefined && (() => {
                const diskTotalGb = latestTelemetry.disk_total_gb || 0;
                const diskUsedPct = latestTelemetry.disk_usage || 0;
                const totalUsedGb = (diskUsedPct / 100) * diskTotalGb;

                const wwwGb = (latestTelemetry.disk_www_mb || 0) / 1024;
                const mysqlGb = (latestTelemetry.disk_mysql_mb || 0) / 1024;
                const backupsGb = (latestTelemetry.disk_backups_mb || 0) / 1024;
                const systemGb = Math.max(0, totalUsedGb - wwwGb - mysqlGb - backupsGb);

                const wwwPct = diskTotalGb > 0 ? (wwwGb / diskTotalGb) * 100 : 0;
                const mysqlPct = diskTotalGb > 0 ? (mysqlGb / diskTotalGb) * 100 : 0;
                const backupsPct = diskTotalGb > 0 ? (backupsGb / diskTotalGb) * 100 : 0;
                const systemPct = diskTotalGb > 0 ? (systemGb / diskTotalGb) * 100 : 0;

                return (
                  <div className="mt-2.5">
                    <div className="flex h-2 w-full overflow-hidden rounded-sm border border-border bg-panel">
                      {wwwPct > 0 && <div title={`Sites: ${wwwGb.toFixed(1)} GB`} className="h-full transition-all duration-300" style={{ width: `${wwwPct}%`, background: "var(--chart-1)" }} />}
                      {mysqlPct > 0 && <div title={`Databases: ${mysqlGb.toFixed(1)} GB`} className="h-full transition-all duration-300" style={{ width: `${mysqlPct}%`, background: "var(--chart-2)" }} />}
                      {backupsPct > 0 && <div title={`Backups: ${backupsGb.toFixed(1)} GB`} className="h-full transition-all duration-300" style={{ width: `${backupsPct}%`, background: "var(--chart-3)" }} />}
                      {systemPct > 0 && <div title={`System: ${systemGb.toFixed(1)} GB`} className="h-full transition-all duration-300" style={{ width: `${systemPct}%`, background: "var(--muted)" }} />}
                    </div>

                    {diskTotalGb > 0 && (
                      <div className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4">
                        <span className="flex items-center gap-1.5">
                          <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--chart-1)" }} />
                          <span className="eyebrow text-faint">Sites</span>
                          <span className="font-mono text-[10.5px] tabular-nums">{wwwGb.toFixed(1)}G</span>
                        </span>
                        <span className="flex items-center gap-1.5">
                          <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--chart-2)" }} />
                          <span className="eyebrow text-faint">Databases</span>
                          <span className="font-mono text-[10.5px] tabular-nums">{mysqlGb.toFixed(1)}G</span>
                        </span>
                        <span className="flex items-center gap-1.5">
                          <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--chart-3)" }} />
                          <span className="eyebrow text-faint">Backups</span>
                          <span className="font-mono text-[10.5px] tabular-nums">{backupsGb.toFixed(1)}G</span>
                        </span>
                        <span className="flex items-center gap-1.5">
                          <span className="h-1.5 w-1.5 rounded-full border border-border" style={{ background: "var(--muted)" }} />
                          <span className="eyebrow text-faint">System</span>
                          <span className="font-mono text-[10.5px] tabular-nums">{systemGb.toFixed(1)}G</span>
                        </span>
                      </div>
                    )}
                  </div>
                );
              })()}
            </HardwareRow>

            <HardwareRow icon={MapPin} label="Region" value={server.region_label || server.region || "not synced yet"} />
            <HardwareRow icon={Globe} label="Web server" value={server.webserver || "not synced yet"} />
          </div>
        </section>

        <section>
          <PanelHeader
            title="Hosted sites"
            meta={`${serverSites.length} ${serverSites.length === 1 ? "site" : "sites"}`}
          />

          <DataTable
            noun="sites"
            columns={siteColumns}
            rows={serverSites}
            rowKey={(site) => String(site.id)}
            pageSize={25}
            empty={{ title: "No sites deployed on this server", hint: "Deployed sites will appear here." }}
          />
        </section>
        </div>

        <div className="flex flex-col gap-10 lg:border-l lg:border-border lg:pl-8">
          <section>
            <PanelHeader title="Log retention" meta="7g.log" />
            <div className="flex flex-col gap-3 py-3">
              <p className="text-pretty text-[12.5px] leading-relaxed text-muted-foreground">
                GridPane ships no rotation rule for the 7G WAF log, so it grows
                until the disk does. Compose the missing rule for this server.
              </p>
              <Button
                size="sm"
                className="w-full"
                onClick={() => setLogRetentionOpen(true)}
              >
                <ScrollText size={14} strokeWidth={1.75} />
                7G log retention rule
              </Button>
            </div>
          </section>

          {/* Firewall — what is actually in force, then the generators */}
          <section>
            <PanelHeader title="Firewall" meta="ufw · nginx · fail2ban" />
            <FirewallPanel scope="server" serverId={server.id} refreshKey={firewallKey} />
            <div className="flex flex-col gap-3 pt-2 sm:flex-row">
              <Button
                size="sm"
                className="w-full sm:flex-1"
                onClick={() => setIpBlockOpen(true)}
              >
                <ShieldBan size={14} strokeWidth={1.75} />
                Block an IP
              </Button>
              <Button
                size="sm"
                className="w-full sm:flex-1"
                onClick={() => setIpAllowOpen(true)}
              >
                <ShieldCheck size={14} strokeWidth={1.75} />
                Allow an IP
              </Button>
            </div>
          </section>
        </div>
      </div>

      {/* Fail2Ban behind Cloudflare — every site's own jails, as the server's
          agent reports them. Full width: the site list needs the room. */}
      <ServerFail2BanPanel
        serverId={server.id}
        siteIds={Object.fromEntries(serverSites.map((s) => [s.url.toLowerCase(), s.id]))}
      />

      {/* 7G and 8G per site, as the server's agent reports them. */}
      <ServerWafPanel
        serverId={server.id}
        siteIds={Object.fromEntries(serverSites.map((s) => [s.url.toLowerCase(), s.id]))}
      />

      {/* PHP's code cache: one per PHP version, shared by the sites on it. */}
      <ServerOpcachePanel
        serverId={server.id}
        siteIds={Object.fromEntries(serverSites.map((s) => [s.url.toLowerCase(), s.id]))}
      />

      {/* Hardware configuration modal */}
      <Modal
        open={configOpen}
        onClose={() => setConfigOpen(false)}
        title="Hardware configuration"
        meta={server.label ?? undefined}
      >
        <div className="grid grid-cols-2 gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="eyebrow text-faint">CPU cores</span>
            <Input
              type="number"
              value={editedCpu}
              onChange={(e) => setEditedCpu(e.target.value)}
              placeholder="e.g. 8"
              readOnly={!allowManualSpecs}
              className={cn(!allowManualSpecs && "bg-muted opacity-60 cursor-not-allowed")}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="eyebrow text-faint">Memory (GB)</span>
            <Input
              type="number"
              value={editedRam}
              onChange={(e) => setEditedRam(e.target.value)}
              placeholder="e.g. 32"
              readOnly={!allowManualSpecs}
              className={cn(!allowManualSpecs && "bg-muted opacity-60 cursor-not-allowed")}
            />
          </label>
        </div>

        <p className="mt-4 text-pretty text-[12px] leading-relaxed text-muted-foreground">
          {specsMeasured
            ? "The fleet agent measures these on the box every cycle, so they stay right through a resize. The fields are locked to keep a typed value from overriding a reading."
            : "GridPane only reports specs for servers it provisioned; a custom VPS returns nothing. Type the values here, or install the fleet agent and it will measure them."}
        </p>

        <div className="mt-4 flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="eyebrow text-faint">Infrastructure provider</span>
            {provider.managedAs && (
              <StatusPill tone="neutral">via {provider.managedAs}</StatusPill>
            )}
          </div>
          <Input
            type="text"
            readOnly
            key={provider.label}
            defaultValue={provider.label}
            className="bg-muted opacity-60 cursor-not-allowed"
          />
          <span className="text-pretty text-[11.5px] leading-relaxed text-faint">
            {providerCaption(provider, hardware)}
          </span>
        </div>
        <div className="mt-4 flex flex-col gap-1.5">
          <span className="eyebrow text-faint">Operating system</span>
          <Input
            type="text"
            readOnly
            defaultValue={formatOsVersion(server.os_version) ?? ""}
            title={server.os_version || undefined}
            className="bg-muted opacity-60 cursor-not-allowed"
          />
        </div>

        <div className="mt-6 flex justify-end gap-2 border-t border-border pt-4">
          <Button className="touch-hit" onClick={() => setConfigOpen(false)}>
            {allowManualSpecs ? "Cancel" : "Close"}
          </Button>
          {allowManualSpecs && (
            <Button variant="solid" className="touch-hit" onClick={handleSaveConfig} disabled={isSaving}>
              {isSaving ? "Saving…" : "Save configuration"}
            </Button>
          )}
        </div>
      </Modal>

      <LogRetentionGenerator
        open={logRetentionOpen}
        onClose={() => setLogRetentionOpen(false)}
        serverLabel={server.label || server.ip || "server"}
      />

      <IpAllowlistManager
        open={ipAllowOpen}
        onClose={() => setIpAllowOpen(false)}
        scope="global"
        serverId={server.id}
        serverLabel={server.label || server.ip || "server"}
        onRecorded={() => setFirewallKey((k) => k + 1)}
      />

      <IpBlockManager
        open={ipBlockOpen}
        onClose={() => setIpBlockOpen(false)}
        scope="server"
        serverId={server.id}
        serverLabel={server.label || server.ip || "server"}
      />

    </div>
  );
}


const siteColumns: Column<Site>[] = [
  {
    id: "domain",
    header: "Domain",
    phone: "title",
    grow: true,
    skeleton: "w-40",
    sortValue: (site) => site.url,
    cell: (site, where) => (
      <>
        <Link href={`/sites/${site.id}`} className="block truncate text-[13px] font-bold leading-tight transition-colors duration-150 hover:text-primary">
          {site.url}
        </Link>
        {where === "table" && <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">ID {site.id}</div>}
      </>
    ),
  },
  {
    id: "php",
    header: "PHP",
    phone: "subtitle",
    skeleton: "w-10",
    sortValue: (site) => site.php_version,
    cell: (site, where) => (
      <span className="whitespace-nowrap font-mono text-[11.5px]">
        {where === "phone" && site.php_version ? "PHP " : ""}
        {site.php_version || "not synced yet"}
      </span>
    ),
  },
  {
    id: "status",
    header: "Status",
    end: true,
    phone: "trailing",
    skeleton: "w-14",
    sortValue: (site) => (site.is_wsod ? 0 : 1),
    sortWords: ["errors first", "active first"],
    cell: (site) => <StatusPill tone={!site.is_wsod ? "ok" : "danger"}>{!site.is_wsod ? "Active" : "WSOD offline"}</StatusPill>,
  },
];

/** One line of the hardware list: what it is, its reading, and anything drawn under it. */
function HardwareRow({
  icon: Icon,
  label,
  value,
  title,
  children,
}: {
  icon: LucideIcon;
  label: string;
  /** `null` while it loads. */
  value: ReactNode | null;
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div className="border-b border-border py-3.5">
      <div className="flex min-h-[20px] items-baseline justify-between gap-3">
        <span className="eyebrow flex items-center gap-1.5 text-faint">
          <Icon size={14} strokeWidth={1.75} /> {label}
        </span>
        {value === null ? (
          <span aria-hidden="true" className="block h-[10px] w-28 animate-pulse self-center rounded-sm bg-panel-2" />
        ) : (
          <span className="font-mono text-[12px] tabular-nums" title={title}>
            {value}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

/** The page while it loads: the same blocks in the same places, so nothing moves when the server arrives. */
function ServerDetailLoading() {
  const bar = <div aria-hidden="true" className="mt-2.5 h-[4px] w-full animate-pulse rounded-sm bg-panel-2" />;
  return (
    <div className="flex flex-col gap-8" aria-busy="true">
      <DetailHeader
        title={null}
        status={<span aria-hidden="true" className="block h-[19px] w-16 animate-pulse rounded-sm bg-panel-2" />}
        facts={null}
        actions={
          <>
            <Button disabled className="touch-hit">
              <Settings size={14} strokeWidth={1.75} /> Configure
            </Button>
            <Button variant="solid" disabled className="touch-hit">
              <Terminal size={14} strokeWidth={1.75} /> Process snapshot
            </Button>
          </>
        }
      />
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-2 lg:gap-0">
        <div className="flex flex-col gap-10 lg:pr-8">
          <section>
            <PanelHeader title="Hardware" />
            <div className="flex flex-col">
              <HardwareRow icon={Cpu} label="CPU" value={null}>
                {bar}
              </HardwareRow>
              <HardwareRow icon={MemoryStick} label="RAM" value={null}>
                {bar}
              </HardwareRow>
              <HardwareRow icon={HardDrive} label="Disk" value={null}>
                {bar}
                {/* the room the storage breakdown takes under the bar */}
                <div aria-hidden="true" className="mt-2.5 h-5 max-sm:h-[42px]" />
              </HardwareRow>
              <HardwareRow icon={MapPin} label="Region" value={null} />
              <HardwareRow icon={Globe} label="Web server" value={null} />
            </div>
          </section>
          <section>
            <PanelHeader title="Hosted sites" />
            <DataTable noun="sites" columns={siteColumns} rows={[]} rowKey={(site) => String(site.id)} loading pageSize={25} empty={{ title: "" }} />
          </section>
        </div>
        <div className="flex flex-col gap-10 lg:border-l lg:border-border lg:pl-8">
          <section>
            <PanelHeader title="Log retention" meta="7g.log" />
            <div className="flex flex-col gap-3 py-3">
              <p className="text-pretty text-[12.5px] leading-relaxed text-muted-foreground">
                GridPane ships no rotation rule for the 7G WAF log, so it grows until the disk does. Compose the missing rule for this
                server.
              </p>
              <Button size="sm" className="w-full" disabled>
                <ScrollText size={14} strokeWidth={1.75} />
                7G log retention rule
              </Button>
            </div>
          </section>
          <section>
            <PanelHeader title="Firewall" meta="ufw · nginx · fail2ban" />
            <div className="flex flex-col gap-3 py-4">
              <span className="block h-[10px] w-3/4 animate-pulse rounded-sm bg-panel-2" />
              <span className="block h-[10px] w-1/2 animate-pulse rounded-sm bg-panel-2" />
              <span className="block h-[10px] w-2/3 animate-pulse rounded-sm bg-panel-2" />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
