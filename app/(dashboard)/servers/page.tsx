"use client";

import { formatRelativeTime } from "@/lib/relative-time";
import { ServerPeek } from "@/components/servers/server-peek";
import { effectiveCores, effectiveRamGb, type ServerHardware } from "@/lib/server-specs";
import { OS_UNKNOWN, formatOsVersion, osFilterKey } from "@/lib/os-version";
import { isUnderLoad } from "@/lib/thresholds";
import { usePersistedState } from "@/lib/use-persisted-state";
import { readSavedSort, writeSavedSort } from "@/lib/saved-sort";
import { useThresholds } from "@/components/providers/settings-provider";
import { useState, useEffect } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Database } from "@/lib/database.types";
import {
  Button,
  Copyable,
  DataTable,
  FilterBar,
  FilterField,
  Meter,
  PageHeader,
  Select,
  StatusPill,
  type Column,
  type TableView,
} from "@/components/ui";

import { CacheFlagPill, useCacheFlags } from "@/components/performance/opcache-status";

type Server = Database["public"]["Tables"]["servers"]["Row"];
type TelemetryRow = Database["public"]["Tables"]["server_telemetry"]["Row"];
type Reading = { cpu: number, ram: number, disk_usage?: number, disk_total_gb?: number, disk_www_mb?: number, disk_mysql_mb?: number, disk_backups_mb?: number, isReal?: boolean, lastUpdated?: string };

export default function ServersPage() {
  const [servers, setServers] = useState<Server[]>([]);
  const [liveStats, setLiveStats] = useState<Record<number, Reading>>({});
  const [peekId, setPeekId] = useState<number | null>(null);
  const [hardware, setHardware] = useState<Record<number, ServerHardware>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [, setTick] = useState(0);
  const [view, setView] = useState<TableView>({ keys: [], start: 0, total: 0 });
  const cacheFlags = useCacheFlags();
  const thresholds = useThresholds();

  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 60000);
    return () => clearInterval(interval);
  }, []);

  // Filters and sort, kept between visits under the keys they have always had.
  const [searchQuery, setSearchQuery] = usePersistedState("servers_search", "");
  const [savedSort, setSavedSort] = usePersistedState("servers_sort", "name-asc");
  const [filterAgent, setFilterAgent] = usePersistedState("servers_agent", "all");
  const [filterCpu, setFilterCpu] = usePersistedState("servers_cpu", "all");
  // _gb suffix: this filter used to persist megabytes, and a stale "4096"
  // would now match nothing. A new key retires those values quietly.
  const [filterRam, setFilterRam] = usePersistedState("servers_ram_gb", "all");
  const [filterOs, setFilterOs] = usePersistedState("servers_os", "all");
  // "agent-live" is what the old sort dropdown saved for live agents first.
  const sort = readSavedSort(savedSort, { id: "name", dir: "asc" }, { "agent-live": { id: "status", dir: "asc" } });

  const supabase = createClient();

  useEffect(() => {
    async function fetchServers() {
      const now = Date.now();
      const fifteenMinsAgo = new Date(now - 15 * 60 * 1000).toISOString();
      const [serversRes, telemetryRes, liveAgentsRes, hardwareRes] = await Promise.all([
        supabase.from("servers").select("*").order("label", { ascending: true }),
        supabase.from("server_telemetry").select("server_id, cpu_usage, ram_usage, disk_usage, disk_total_gb, disk_www_mb, disk_mysql_mb, disk_backups_mb, timestamp").order("timestamp", { ascending: false }).limit(60),
        supabase.from("server_telemetry")
          .select("server_id")
          .ilike("top_processes_b64", "%|AGENT_V1%")
          .gte("timestamp", fifteenMinsAgo),
        // Specs the agent measured on each box; empty until the agent is redeployed.
        supabase.from("server_hardware").select("*")
      ]);

      if (serversRes.error) console.error("Servers fetch failed", serversRes.error);
      if (telemetryRes.error) console.error("Telemetry fetch failed", telemetryRes.error);
      if (liveAgentsRes.error) console.error("Live agents fetch failed", liveAgentsRes.error);
      if (hardwareRes.error) console.error("Hardware fetch failed", hardwareRes.error);

      if (hardwareRes.data) {
        setHardware(Object.fromEntries(hardwareRes.data.map(h => [h.server_id, h])));
      }

      if (serversRes.data) {
        setServers(serversRes.data);
      }

      if (telemetryRes.data) {
        const stats: Record<number, Reading> = {};

        const verifiedLiveAgents = new Set(liveAgentsRes?.data?.map(row => row.server_id) || []);

        telemetryRes.data.forEach(t => {
          if (!stats[t.server_id]) {
             stats[t.server_id] = {
               cpu: t.cpu_usage,
               ram: t.ram_usage,
               disk_usage: t.disk_usage,
               disk_total_gb: t.disk_total_gb || undefined,
               disk_www_mb: t.disk_www_mb || undefined,
               disk_mysql_mb: t.disk_mysql_mb || undefined,
               disk_backups_mb: t.disk_backups_mb || undefined,
               isReal: verifiedLiveAgents.has(t.server_id),
               lastUpdated: t.timestamp
             };
          }
        });

        verifiedLiveAgents.forEach(id => {
          if (stats[id]) stats[id].isReal = true;
        });

        setLiveStats(stats);
      }
      setIsLoading(false);
    }

    fetchServers();

    const channel = supabase.channel("servers-list-telemetry")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "server_telemetry" },
        (payload) => {
          const newRow = payload.new as TelemetryRow;
          const isPayloadReal = newRow.top_processes_b64 === "toast" || (newRow.top_processes_b64?.includes("|AGENT_V1") ?? false);

          setLiveStats(prev => {
            if (prev[newRow.server_id]?.isReal && !isPayloadReal) {
              return prev;
            }

            return {
              ...prev,
              [newRow.server_id]: {
                cpu: newRow.cpu_usage,
                ram: newRow.ram_usage,
                disk_usage: newRow.disk_usage,
                disk_total_gb: newRow.disk_total_gb || undefined,
                disk_www_mb: newRow.disk_www_mb || undefined,
                disk_mysql_mb: newRow.disk_mysql_mb || undefined,
                disk_backups_mb: newRow.disk_backups_mb || undefined,
                isReal: isPayloadReal,
                lastUpdated: newRow.timestamp
              }
            };
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase]);

  const coresOf = (s: Server) => effectiveCores(s, hardware[s.id]);
  const ramGbOf = (s: Server) => effectiveRamGb(s, hardware[s.id]);
  const isLive = (s: Server) => liveStats[s.id]?.isReal || false;
  const isLoaded = (s: Server) => {
    const r = liveStats[s.id];
    return !!r && isUnderLoad({ cpu: r.cpu, memory: r.ram, disk: r.disk_usage }, thresholds);
  };

  const uniqueCpus = Array.from(new Set(servers.map(coresOf).filter((n): n is number => n !== null))).sort((a, b) => a - b);
  const uniqueRams = Array.from(new Set(servers.map(ramGbOf).filter((n): n is number => n !== null))).sort((a, b) => a - b);

  // One option per OS on the fleet, with how many servers run it, so the
  // dropdown itself is the at-a-glance view. Unknown sorts last.
  const osCounts = new Map<string, number>();
  servers.forEach(s => {
    const key = osFilterKey(s.os_version);
    osCounts.set(key, (osCounts.get(key) ?? 0) + 1);
  });
  const osOptions = Array.from(osCounts, ([key, count]) => ({
    key,
    count,
    label: key === OS_UNKNOWN ? "OS unknown" : (formatOsVersion(key) ?? key),
  })).sort((a, b) =>
    a.key === OS_UNKNOWN ? 1 : b.key === OS_UNKNOWN ? -1 : a.label.localeCompare(b.label, undefined, { numeric: true })
  );
  // A saved choice for a version no server runs any more would hide every row.
  const activeOsFilter = filterOs !== "all" && osCounts.has(filterOs) ? filterOs : "all";

  // Everything but the quick filter, so each pill can say how many rows it would show.
  const narrowed = servers.filter(server => {
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      if (!((server.label?.toLowerCase() || "").includes(q) || (server.ip || "").includes(q))) return false;
    }
    if (filterCpu !== "all" && String(coresOf(server) ?? "") !== filterCpu) return false;
    if (filterRam !== "all" && String(ramGbOf(server) ?? "") !== filterRam) return false;
    if (activeOsFilter !== "all" && osFilterKey(server.os_version) !== activeOsFilter) return false;
    return true;
  });
  const quick: Record<string, (s: Server) => boolean> = {
    all: () => true,
    live: isLive,
    simulated: (s) => !isLive(s),
    load: isLoaded,
  };
  const activeQuick = quick[filterAgent] ? filterAgent : "all";
  const filteredServers = narrowed.filter(quick[activeQuick]);
  const count = (id: string) => (isLoading ? null : narrowed.filter(quick[id]).length);
  const moreActive = [filterCpu !== "all", filterRam !== "all", activeOsFilter !== "all"].filter(Boolean).length;

  const clearFilters = () => {
    setSearchQuery("");
    setFilterAgent("all");
    setFilterCpu("all");
    setFilterRam("all");
    setFilterOs("all");
  };

  const percent = (value: number | undefined, metric: "cpu" | "memory" | "disk", where: "table" | "phone") =>
    value === undefined ? (
      <span className="text-faint">–</span>
    ) : (
      <span className="flex items-center justify-end gap-2.5">
        {where === "table" && <Meter value={value} metric={metric} className="w-[56px] shrink-0 max-lg:hidden" />}
        <span className="min-w-[4ch]">{value}%</span>
      </span>
    );

  const columns: Column<Server>[] = [
    {
      id: "name",
      header: "Server",
      phone: "title",
      skeleton: "w-32",
      grow: true,
      sortValue: (s) => s.label,
      cell: (s, where) => (
        <>
          <Link href={`/servers/${s.id}`} className="block truncate text-[13px] font-bold leading-tight transition-colors duration-150 hover:text-primary">
            {s.label}
          </Link>
          {where === "table" && s.ip && (
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              <Copyable value={s.ip} what="IP address" className="[&>button]:-my-1" />
            </div>
          )}
        </>
      ),
    },
    { id: "ip", header: "IP address", phone: "subtitle", className: "hidden", cell: (s) => <span className="font-mono">{s.ip}</span> },
    {
      id: "status",
      header: "Status",
      phone: "trailing",
      skeleton: "w-20",
      sortValue: (s) => (isLive(s) ? 0 : 1),
      cell: (s, where) => (
        <>
          <span className="flex items-center gap-1.5">
            <StatusPill tone={isLive(s) ? "live" : "neutral"}>{isLive(s) ? "Live agent" : (s.status || "not synced yet")}</StatusPill>
            {where === "table" && <CacheFlagPill flag={cacheFlags[s.id]} />}
          </span>
          {where === "table" && <div className="mt-1 whitespace-nowrap font-mono text-[10.5px] text-faint">{`updated ${formatRelativeTime(liveStats[s.id]?.lastUpdated)}`}</div>}
        </>
      ),
    },
    { id: "updated", header: "Updated", className: "hidden", cell: (s) => <span className="font-mono text-[11.5px]">{formatRelativeTime(liveStats[s.id]?.lastUpdated)}</span> },
    {
      id: "cache",
      header: "Code cache",
      className: "hidden",
      cell: (s) => (cacheFlags[s.id] ? <CacheFlagPill flag={cacheFlags[s.id]} /> : <span className="text-faint">–</span>),
    },
    {
      id: "os",
      header: "OS",
      className: "max-lg:hidden",
      skeleton: "w-24",
      sortValue: (s) => formatOsVersion(s.os_version),
      cell: (s) => (
        <span className={formatOsVersion(s.os_version) ? "whitespace-nowrap font-mono text-[11.5px]" : "whitespace-nowrap font-mono text-[11.5px] text-faint"} title={s.os_version || undefined}>
          {formatOsVersion(s.os_version) ?? "unknown"}
        </span>
      ),
    },
    { id: "cpu", header: "CPU", numeric: true, skeleton: "w-10", sortValue: (s) => liveStats[s.id]?.cpu, cell: (s, where) => percent(liveStats[s.id]?.cpu, "cpu", where) },
    { id: "ram", header: "RAM", numeric: true, skeleton: "w-10", sortValue: (s) => liveStats[s.id]?.ram, cell: (s, where) => percent(liveStats[s.id]?.ram, "memory", where) },
    {
      id: "disk",
      header: "Disk",
      numeric: true,
      skeleton: "w-20",
      sortValue: (s) => liveStats[s.id]?.disk_usage,
      cell: (s, where) => {
        const r = liveStats[s.id];
        if (!r) return <span className="text-faint">–</span>;
        return (
          <span className="flex items-center justify-end gap-2.5">
            {where === "table" && <Meter value={r.disk_usage || 0} metric="disk" className="w-[56px] shrink-0 max-xl:hidden" />}
            <span className="whitespace-nowrap">
              {r.disk_usage || 0}% / {r.disk_total_gb ? `${r.disk_total_gb} GB` : "no report yet"}
            </span>
          </span>
        );
      },
    },
  ];

  const at = peekId === null ? -1 : view.keys.indexOf(String(peekId));
  const peeked = peekId === null ? null : (servers.find((s) => s.id === peekId) ?? null);
  const stepTo = (i: number) => () => setPeekId(Number(view.keys[i]));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Servers"
        stamp={isLoading ? undefined : `${servers.length} ${servers.length === 1 ? "node" : "nodes"}`}
      />

      <div className="flex flex-col gap-5">
        <FilterBar
          noun="servers"
          className="border-b border-border pb-4"
          pills={[
            { id: "all", label: "All", count: count("all") },
            { id: "live", label: "Live agent", count: count("live") },
            { id: "simulated", label: "Not reporting", count: count("simulated") },
            { id: "load", label: "High load", count: count("load") },
          ]}
          value={activeQuick}
          onChange={setFilterAgent}
          search={{ value: searchQuery, onChange: setSearchQuery, placeholder: "Search servers" }}
          moreActive={moreActive}
          onClear={clearFilters}
          more={
            <>
              <FilterField label="CPU">
                <Select value={filterCpu} onChange={(e) => setFilterCpu(e.target.value)}>
                  <option value="all">Any CPU</option>
                  {uniqueCpus.map(c => <option key={c} value={c}>{c} cores</option>)}
                </Select>
              </FilterField>
              <FilterField label="RAM">
                <Select value={filterRam} onChange={(e) => setFilterRam(e.target.value)}>
                  <option value="all">Any RAM</option>
                  {uniqueRams.map(r => <option key={r} value={r}>{r} GB RAM</option>)}
                </Select>
              </FilterField>
              <FilterField label="Operating system">
                <Select value={activeOsFilter} onChange={(e) => setFilterOs(e.target.value)}>
                  <option value="all">Any OS</option>
                  {osOptions.map(o => <option key={o.key} value={o.key}>{o.label} ({o.count})</option>)}
                </Select>
              </FilterField>
            </>
          }
        />

        <DataTable
          noun="servers"
          columns={columns}
          rows={filteredServers}
          rowKey={(s) => String(s.id)}
          loading={isLoading}
          skeletonRows={8}
          pageSize={25}
          sort={sort}
          onSortChange={(next) => setSavedSort(writeSavedSort(next))}
          resetKey={`${searchQuery}|${activeQuick}|${filterCpu}|${filterRam}|${activeOsFilter}`}
          onView={setView}
          rowActions={(s) => <Button size="sm" onClick={() => setPeekId(s.id)}>Quick view</Button>}
          empty={
            servers.length === 0
              ? { title: "No servers in the ledger yet", hint: "They appear here after the next sync from GridPane." }
              : {
                  title: "No servers match these filters",
                  hint: "Change the search or the filters to see nodes.",
                  action: <Button size="sm" onClick={clearFilters}>Clear filters</Button>,
                }
          }
        />

        {/* Quick view. Up and Down step through the rows on this page, in the order shown. */}
        <ServerPeek
          server={peeked}
          reading={peeked ? liveStats[peeked.id] : undefined}
          hardware={peeked ? hardware[peeked.id] : undefined}
          cacheFlag={peeked ? cacheFlags[peeked.id] : undefined}
          onClose={() => setPeekId(null)}
          onPrev={at > 0 ? stepTo(at - 1) : undefined}
          onNext={at !== -1 && at < view.keys.length - 1 ? stepTo(at + 1) : undefined}
          position={at === -1 ? undefined : `${view.start + at + 1} of ${view.total}`}
        />
      </div>
    </div>
  );
}
