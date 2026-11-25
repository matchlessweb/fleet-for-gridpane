"use client";

import { Terminal } from "lucide-react";
import Link from "next/link";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Database } from "@/lib/database.types";
import { isUnderLoad } from "@/lib/thresholds";
import { usePersistedState } from "@/lib/use-persisted-state";
import { readSavedSort, writeSavedSort } from "@/lib/saved-sort";
import { useThresholds } from "@/components/providers/settings-provider";
import {
  Button,
  Copyable,
  DataTable,
  FilterBar,
  FilterField,
  Meter,
  PageHeader,
  StatusPill,
  Select,
  type Column,
} from "@/components/ui";

type Server = Database["public"]["Tables"]["servers"]["Row"];
type TelemetryRow = Database["public"]["Tables"]["server_telemetry"]["Row"];

function parseSwapUsage(b64?: string | null): number {
  if (!b64 || b64 === "toast") return 0;
  try {
    const decoded = atob(b64);
    const swapMatch = decoded.match(/Swap:.*?$/m);
    if (swapMatch) {
      const swapLine = swapMatch[0];
      const totalMatch = swapLine.match(/([\d.]+)\s*total/i);
      const usedMatch = swapLine.match(/([\d.]+)\s*used/i);
      if (totalMatch && usedMatch) {
        const total = parseFloat(totalMatch[1]);
        const used = parseFloat(usedMatch[1]);
        if (total > 0) return Math.min(100, Math.round((used / total) * 100));
      }
    }
  } catch {}
  return 0;
}

function parseStealUsage(b64?: string | null): number {
  if (!b64 || b64 === "toast") return 0;
  try {
    const decoded = atob(b64);
    const cpuMatch = decoded.match(/([\d.]+)\s*st\b/i);
    if (cpuMatch) {
      return parseFloat(cpuMatch[1]);
    }
  } catch {}
  return 0;
}

export default function MonitoringPage() {
  const [servers, setServers] = useState<Server[]>([]);
  const router = useRouter();
  const [liveStats, setLiveStats] = useState<
    Record<
      number,
      { cpu: number; ram: number; swap: number; steal: number; isReal?: boolean; lastUpdated?: string }
    >
  >({});
  const [isLoading, setIsLoading] = useState(true);
  const thresholds = useThresholds();

  // Filters and sort, kept between visits under the keys they have always had.
  const [searchQuery, setSearchQuery] = usePersistedState("monitoring_search", "");
  const [savedSort, setSavedSort] = usePersistedState("monitoring_sort", "name-asc");
  const [filterCpu, setFilterCpu] = usePersistedState("monitoring_cpu", "all");
  const [filterRam, setFilterRam] = usePersistedState("monitoring_ram", "all");
  const [filterAgent, setFilterAgent] = usePersistedState("monitoring_agent", "all");
  // "agent-live" is what the old sort dropdown saved for live agents first.
  const sort = readSavedSort(savedSort, { id: "name", dir: "asc" }, { "agent-live": { id: "status", dir: "asc" } });

  const supabase = createClient();

  useEffect(() => {
    async function fetchServers() {
      const fifteenMinsAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      const [serversRes, telemetryRes, liveAgentsRes] = await Promise.all([
        supabase
          .from("servers")
          .select("*")
          .order("label", { ascending: true }),
        supabase
          .from("server_telemetry")
          .select("server_id, cpu_usage, ram_usage, top_processes_b64, timestamp")
          .order("timestamp", { ascending: false })
          .limit(60),
        supabase
          .from("server_telemetry")
          .select("server_id")
          .ilike("top_processes_b64", "%|AGENT_V1%")
          .gte("timestamp", fifteenMinsAgo),
      ]);

      if (serversRes.error) console.error("Servers fetch failed", serversRes.error);
      if (telemetryRes.error) console.error("Telemetry fetch failed", telemetryRes.error);
      if (liveAgentsRes.error) console.error("Live agents fetch failed", liveAgentsRes.error);

      if (serversRes.data) {
        setServers(serversRes.data);
      }

      if (telemetryRes.data) {
        const stats: Record<
          number,
          { cpu: number; ram: number; swap: number; steal: number; isReal?: boolean; lastUpdated?: string }
        > = {};

        // Create a fast lookup Set for physical nodes that have checked in recently.
        const verifiedLiveAgents = new Set(
          liveAgentsRes?.data?.map((row) => row.server_id) || [],
        );

        telemetryRes.data.forEach((t) => {
          if (!stats[t.server_id]) {
            stats[t.server_id] = {
              cpu: t.cpu_usage,
              ram: t.ram_usage,
              swap: parseSwapUsage(t.top_processes_b64),
              steal: parseStealUsage(t.top_processes_b64),
              isReal: verifiedLiveAgents.has(t.server_id),
              lastUpdated: t.timestamp,
            };
          }
        });

        // Ensure even nodes without recent general telemetry (due to limit boundaries)
        // strictly retain their active agent glow if they were verified.
        verifiedLiveAgents.forEach((id) => {
          if (stats[id]) stats[id].isReal = true;
        });

        setLiveStats(stats);
      }
      setIsLoading(false);
    }

    fetchServers();

    const channel = supabase
      .channel("monitoring-telemetry")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "server_telemetry" },
        (payload) => {
          const newRow = payload.new as TelemetryRow;
          const isPayloadReal =
            newRow.top_processes_b64 === "toast" ||
            (newRow.top_processes_b64?.includes("|AGENT_V1") ?? false);

          setLiveStats((prev) => {
            // If we know this server is running the physical Live Agent, totally ignore simulated mock payloads.
            if (prev[newRow.server_id]?.isReal && !isPayloadReal) {
              return prev;
            }

            return {
              ...prev,
              [newRow.server_id]: {
                cpu: newRow.cpu_usage,
                ram: newRow.ram_usage,
                swap: parseSwapUsage(newRow.top_processes_b64),
                steal: parseStealUsage(newRow.top_processes_b64),
                isReal: isPayloadReal,
                lastUpdated: newRow.timestamp || new Date().toISOString(),
              },
            };
          });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase]);

  const liveAgentCount = Object.values(liveStats).filter((s) => s.isReal).length;

  const uniqueCpus = Array.from(
    new Set(servers.map((s) => Number(s.cpu)).filter((n) => !isNaN(n))),
  ).sort((a, b) => a - b);
  const uniqueRams = Array.from(
    new Set(servers.map((s) => Number(s.ram)).filter((n) => !isNaN(n))),
  ).sort((a, b) => a - b);

  const isLive = (s: Server) => liveStats[s.id]?.isReal === true;

  // Everything but the quick filter, so each pill can say how many rows it would show.
  const narrowed = servers.filter((server) => {
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      if (
        !(
          (server.label?.toLowerCase() || "").includes(q) ||
          (server.ip || "").includes(q)
        )
      )
        return false;
    }
    if (filterCpu !== "all") {
      if (server.cpu?.toString() !== filterCpu) return false;
    }
    if (filterRam !== "all") {
      if (server.ram?.toString() !== filterRam) return false;
    }
    return true;
  });
  const quick: Record<string, (s: Server) => boolean> = {
    all: () => true,
    live: isLive,
    simulated: (s) => !isLive(s),
    load: (s) => {
      const r = liveStats[s.id];
      return !!r && isUnderLoad({ cpu: r.cpu, memory: r.ram }, thresholds);
    },
    swap: (s) => (liveStats[s.id]?.swap ?? 0) > 0,
  };
  const activeQuick = quick[filterAgent] ? filterAgent : "all";
  const filteredServers = narrowed.filter(quick[activeQuick]);
  const count = (id: string) => (isLoading ? null : narrowed.filter(quick[id]).length);
  const moreActive = [filterCpu !== "all", filterRam !== "all"].filter(Boolean).length;

  const clearFilters = () => {
    setSearchQuery("");
    setFilterCpu("all");
    setFilterRam("all");
    setFilterAgent("all");
  };

  const lastPayload = (server: Server) =>
    liveStats[server.id]?.lastUpdated
      ? new Date(liveStats[server.id]!.lastUpdated!).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })
      : "no report yet";

  const percent = (value: number | undefined, metric: "cpu" | "memory", where: "table" | "phone") =>
    value === undefined ? (
      <span className="text-faint">–</span>
    ) : (
      <span className="flex items-center justify-end gap-2.5">
        {where === "table" && <Meter value={value} metric={metric} className="w-16 shrink-0 max-lg:hidden xl:w-24" />}
        <span className="min-w-[4ch]">{value}%</span>
      </span>
    );

  // Any swap in use, or any CPU time taken by the host, is worth the eye.
  const flagged = (value: number | undefined) =>
    value === undefined ? <span className="text-faint">–</span> : <span className={value > 0 ? "text-warning" : "text-muted-foreground"}>{value}%</span>;

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
          <StatusPill tone={isLive(s) ? "live" : "neutral"}>{isLive(s) ? "Live agent" : "No agent"}</StatusPill>
          {where === "table" && <div className="mt-1 whitespace-nowrap font-mono text-[10.5px] text-faint">{lastPayload(s)}</div>}
        </>
      ),
    },
    { id: "payload", header: "Last payload", className: "hidden", cell: (s) => <span className="font-mono text-[11.5px]">{lastPayload(s)}</span> },
    { id: "cpu", header: "CPU", numeric: true, skeleton: "w-10", sortValue: (s) => liveStats[s.id]?.cpu, cell: (s, where) => percent(liveStats[s.id]?.cpu, "cpu", where) },
    { id: "ram", header: "RAM", numeric: true, skeleton: "w-10", sortValue: (s) => liveStats[s.id]?.ram, cell: (s, where) => percent(liveStats[s.id]?.ram, "memory", where) },
    { id: "swap", header: "Swap", numeric: true, skeleton: "w-8", sortValue: (s) => liveStats[s.id]?.swap, cell: (s) => flagged(liveStats[s.id]?.swap) },
    { id: "steal", header: "Steal", numeric: true, skeleton: "w-8", sortValue: (s) => liveStats[s.id]?.steal, cell: (s) => flagged(liveStats[s.id]?.steal) },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Monitoring">
        {!isLoading && <StatusPill tone="live">{liveAgentCount} live agents</StatusPill>}
      </PageHeader>

      <div className="flex flex-col gap-5">
        <FilterBar
          noun="servers"
          className="border-b border-border pb-4"
          pills={[
            { id: "all", label: "All", count: count("all") },
            { id: "live", label: "Live agent", count: count("live") },
            { id: "simulated", label: "Not reporting", count: count("simulated") },
            { id: "load", label: "High load", count: count("load") },
            { id: "swap", label: "Swapping", count: count("swap") },
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
                  {uniqueCpus.map((c) => (
                    <option key={c} value={c}>
                      {c} cores
                    </option>
                  ))}
                </Select>
              </FilterField>
              <FilterField label="RAM">
                <Select value={filterRam} onChange={(e) => setFilterRam(e.target.value)}>
                  <option value="all">Any RAM</option>
                  {uniqueRams.map((r) => (
                    <option key={r} value={r}>
                      {r / 1024} GB RAM
                    </option>
                  ))}
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
          resetKey={`${searchQuery}|${activeQuick}|${filterCpu}|${filterRam}`}
          rowActions={(s) => (
            <Button size="sm" onClick={() => router.push(`/monitoring/${s.id}`)}>
              <Terminal size={14} strokeWidth={1.75} aria-hidden="true" />
              Snapshot
            </Button>
          )}
          empty={
            servers.length === 0
              ? { title: "No servers in the ledger yet", hint: "They appear here after the next sync from GridPane." }
              : {
                  title: "No servers match these filters",
                  hint: "Change the search or the filters to see the full fleet.",
                  action: <Button size="sm" onClick={clearFilters}>Clear filters</Button>,
                }
          }
        />
      </div>
    </div>
  );
}
