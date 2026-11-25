"use client";

import { useEffect, useMemo, useState, Suspense } from "react";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Database } from "@/lib/database.types";
import {
  Button,
  Copyable,
  DataTable,
  Figure,
  Figures,
  Led,
  PageHeader,
  PanelHeader,
  Select,
  buttonClasses,
  type Column,
} from "@/components/ui";

type Schedule = Database["public"]["Tables"]["backup_schedules"]["Row"];
type Site = Database["public"]["Tables"]["sites"]["Row"];
type Server = Database["public"]["Tables"]["servers"]["Row"];

let cachedSchedules: Schedule[] = [];
let cachedSites: Record<string, Site> = {};
let cachedServers: Record<string, Server> = {};
let hasCachedData = false;

const monoTagClasses =
  "rounded-sm bg-panel-2 px-1.5 py-[2px] font-mono text-[10.5px] text-muted-foreground whitespace-nowrap";

type ServerAggregate = { server: Server, total: number, local: number, remote: number, hourly: number, daily: number, weekly: number };
// `key` is the grouping key itself: built from the defaulted values, two groups can share a row key.
type CadenceAggregate = { key: string, type: string, frequency: string, service_id: number | null, count: number };

/** `selectedServerId` comes from the `node` query parameter; "all" until the browser has handed it over. */
function BackupsMatrix({ selectedServerId }: { selectedServerId: string }) {
  const [schedules, setSchedules] = useState<Schedule[]>(cachedSchedules);
  const [sites, setSites] = useState<Record<string, Site>>(cachedSites);
  const [servers, setServers] = useState<Record<string, Server>>(cachedServers);

  const router = useRouter();

  const setSelectedServerId = (val: string) => {
    if (val === "all") {
      router.push("/backups");
    } else {
      router.push(`/backups?node=${val}`);
    }
  };
  const [isLoading, setIsLoading] = useState(!hasCachedData);

  const supabase = useMemo(() => createClient(), []);

  useEffect(() => {
    const fetchData = async () => {
      if (!hasCachedData) {
        setIsLoading(true);
      }

      const { data: schedData } = await supabase.from("backup_schedules").select("*");
      const { data: siteData } = await supabase.from("sites").select("*");
      const { data: serverData } = await supabase.from("servers").select("*");

      if (schedData) {
        setSchedules(schedData);
        cachedSchedules = schedData;
      }

      if (siteData) {
        const siteMap: Record<string, Site> = {};
        siteData.forEach(s => { siteMap[s.id.toString()] = s; });
        setSites(siteMap);
        cachedSites = siteMap;
      }

      if (serverData) {
        const srvMap: Record<string, Server> = {};
        serverData.forEach(s => { srvMap[s.id.toString()] = s; });
        setServers(srvMap);
        cachedServers = srvMap;
      }

      hasCachedData = true;
      setIsLoading(false);
    };

    fetchData();
  }, [supabase]);

  const getProviderName = (type: string | null, service_id: number | null) => {
    if (type === "remote") {
      if (service_id === 3) return "Backblaze B2";
      if (service_id === 6) return "Wasabi";
      return `Remote (${service_id || 'Unknown'})`;
    }
    return "Local Storage";
  };

  const enrichedSchedules = schedules.map(s => {
    const site = s.site_id ? sites[s.site_id.toString()] : null;
    const server = site?.server_id ? servers[site.server_id.toString()] : null;
    return { ...s, site, server };
  });

  const filteredSchedules = enrichedSchedules.filter(s => {
    if (selectedServerId === "all") return true;
    return s.server?.id.toString() === selectedServerId;
  });

  // Aggregation for the all-servers view
  const serverAggregates: Record<string, ServerAggregate> = {};
  if (selectedServerId === "all" && !isLoading) {
    Object.values(servers).forEach(srv => {
      serverAggregates[srv.id.toString()] = { server: srv, total: 0, local: 0, remote: 0, hourly: 0, daily: 0, weekly: 0 };
    });
    enrichedSchedules.forEach(s => {
      if (s.server?.id && serverAggregates[s.server.id.toString()]) {
        const ag = serverAggregates[s.server.id.toString()];
        ag.total++;
        if (s.type === 'local') ag.local++; else ag.remote++;
        if (s.bup_schedule === 'hourly') ag.hourly++;
        else if (s.bup_schedule === 'daily') ag.daily++;
        else ag.weekly++;
      }
    });
  }

  // Cadence aggregation for the single-server view
  const cadenceAggregates: Record<string, CadenceAggregate> = {};
  if (selectedServerId !== "all" && !isLoading) {
    filteredSchedules.forEach(s => {
      const key = `${s.type}-${s.bup_schedule}-${s.service_id || 'base'}`;
      if (!cadenceAggregates[key]) {
        cadenceAggregates[key] = { key, type: s.type || 'local', frequency: s.bup_schedule || "daily", service_id: s.service_id, count: 0 };
      }
      cadenceAggregates[key].count++;
    });
  }

  // Calculate potential overlaps (schedules mapped to the same server, same hour, same minute)
  let conflictCount = 0;
  if (!isLoading && enrichedSchedules.length > 0) {
    const timeMap: Record<string, number> = {};
    enrichedSchedules.forEach(s => {
      if (s.server?.id && s.minute !== null) {
        const key = `${s.server.id}-${s.type}-${s.bup_schedule}-${s.hour}-${s.minute}-${s.day || 'n'}`;
        timeMap[key] = (timeMap[key] || 0) + 1;
      }
    });
    Object.values(timeMap).forEach(v => {
      if (v > 1) conflictCount += v;
    });
  }

  const cadenceLink = (ag: { type: string, frequency: string, service_id: number | null }) =>
    `/backups/schedules?server=${selectedServerId}&type=${ag.type === "local" ? "local" : `remote-${ag.service_id}`}&frequency=${ag.frequency}`;

  const cadenceTags = (ag: ServerAggregate) => (
    <span className="inline-flex gap-1.5">
      <span className={monoTagClasses}>Hourly {ag.hourly}</span>
      <span className={monoTagClasses}>Daily {ag.daily}</span>
      <span className={monoTagClasses}>Weekly {ag.weekly}</span>
    </span>
  );

  const serverColumns: Column<ServerAggregate>[] = [
    {
      id: "server",
      header: "Server",
      phone: "title",
      skeleton: "w-32",
      grow: true,
      sortValue: (ag) => ag.server.label,
      cell: (ag, where) => (
        <>
          <span className="block truncate text-[13px] font-bold">{ag.server.label}</span>
          {where === "table" && ag.server.ip && (
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              <Copyable value={ag.server.ip} what="IP address" className="[&>button]:-my-1" />
            </div>
          )}
        </>
      ),
    },
    { id: "ip", header: "IP address", phone: "subtitle", className: "hidden", cell: (ag) => <span className="font-mono">{ag.server.ip}</span> },
    {
      id: "total",
      header: "Schedules",
      numeric: true,
      phone: "trailing",
      skeleton: "w-6",
      sortValue: (ag) => ag.total,
      cell: (ag, where) => (where === "phone" ? <span className="font-mono text-[11.5px] tabular-nums text-muted-foreground">{ag.total} {ag.total === 1 ? "schedule" : "schedules"}</span> : ag.total),
    },
    { id: "local", header: "Local", numeric: true, skeleton: "w-6", sortValue: (ag) => ag.local, cell: (ag) => ag.local },
    { id: "remote", header: "Remote", numeric: true, skeleton: "w-6", sortValue: (ag) => ag.remote, cell: (ag) => ag.remote },
    { id: "cadences", header: "Cadences", className: "max-lg:hidden", skeleton: "w-44", cell: cadenceTags },
  ];

  const cadenceColumns: Column<CadenceAggregate>[] = [
    {
      id: "cadence",
      header: "Cadence",
      phone: "title",
      skeleton: "w-16",
      sortValue: (ag) => ag.frequency,
      cell: (ag) => (
        <span className="inline-flex items-center gap-1.5">
          <Led tone="ok" />
          <span className="eyebrow font-medium text-primary">{ag.frequency}</span>
        </span>
      ),
    },
    {
      id: "destination",
      header: "Destination",
      phone: "subtitle",
      skeleton: "w-28",
      sortValue: (ag) => getProviderName(ag.type, ag.service_id),
      cell: (ag, where) =>
        where === "phone" ? (
          getProviderName(ag.type, ag.service_id)
        ) : (
          <>
            <span className="eyebrow block text-faint">{ag.type}</span>
            <span className="text-[12.5px]">{getProviderName(ag.type, ag.service_id)}</span>
          </>
        ),
    },
    {
      id: "count",
      header: "Mappings",
      numeric: true,
      phone: "trailing",
      skeleton: "w-6",
      sortValue: (ag) => ag.count,
      cell: (ag, where) => (where === "phone" ? <span className="font-mono text-[11.5px] tabular-nums text-muted-foreground">{ag.count} {ag.count === 1 ? "site" : "sites"}</span> : ag.count),
    },
  ];

  return (
    <div className="flex flex-col gap-7">
      <PageHeader title="Backups">
        <Link href="/backups/schedules" className={buttonClasses()}>
          View schedules
        </Link>
      </PageHeader>

      <Figures cols={2} stackDelta>
        <Figure label="Active schedules" value={isLoading ? null : schedules.length} delta={null} note="Across all origin servers." />
        <Link href="/backups/schedules?conflict=true" className="block rounded-sm">
          <Figure
            label="Schedule overlaps"
            value={isLoading ? null : conflictCount}
            tone={!isLoading && conflictCount > 0 ? "warn" : "default"}
            delta={!isLoading && conflictCount > 0 ? { text: "Action required", tone: "warn" } : null}
            note={isLoading ? "" : conflictCount > 0 ? "Concurrent triggers on the same origin." : "No concurrent triggers."}
          />
        </Link>
      </Figures>

      {/* Server aggregation */}
      <section className="flex flex-col gap-4">
        <PanelHeader title="Server aggregation" className="flex-wrap items-center">
          <Select
            value={selectedServerId}
            onChange={(e) => setSelectedServerId(e.target.value)}
            aria-label="Node scope"
            // A set width: left to its options, it widens when the servers arrive and drops under the title on a phone.
            wrapperClassName="w-[240px] max-w-full"
            className="w-full"
          >
            <option value="all">All servers</option>
            {Object.values(servers).map(srv => (
              <option key={srv.id} value={srv.id.toString()}>{srv.label} ({srv.ip})</option>
            ))}
          </Select>
        </PanelHeader>

        {selectedServerId === "all" ? (
          <DataTable
            noun="servers"
            columns={serverColumns}
            rows={Object.values(serverAggregates)}
            rowKey={(ag) => String(ag.server.id)}
            loading={isLoading}
            skeletonRows={4}
            defaultSort={{ id: "server", dir: "asc" }}
            rowActions={(ag) => (
              <Button size="sm" onClick={() => setSelectedServerId(ag.server.id.toString())}>
                Cadences <ArrowRight size={14} strokeWidth={1.75} aria-hidden="true" />
              </Button>
            )}
            empty={{ title: "No servers on record", hint: "Run a sync to read them from GridPane." }}
          />
        ) : (
          <DataTable
            noun="cadences"
            columns={cadenceColumns}
            rows={Object.values(cadenceAggregates)}
            rowKey={(ag) => ag.key}
            loading={isLoading}
            skeletonRows={3}
            defaultSort={{ id: "cadence", dir: "asc" }}
            rowActions={(ag) => (
              <Link href={cadenceLink(ag)} className={buttonClasses({ size: "sm" })}>
                Sites <ArrowRight size={14} strokeWidth={1.75} aria-hidden="true" />
              </Link>
            )}
            empty={{
              title: "No schedules for this server",
              hint: "Pick another server, or view all servers.",
              action: <Button size="sm" onClick={() => setSelectedServerId("all")}>View all servers</Button>,
            }}
          />
        )}
      </section>
    </div>
  );
}

function BackupsFromUrl() {
  return <BackupsMatrix selectedServerId={useSearchParams().get("node") || "all"} />;
}

export default function BackupsPage() {
  // The fallback is the page itself in its loading shape, so nothing moves when the query string arrives.
  return (
    <Suspense fallback={<BackupsMatrix selectedServerId="all" />}>
      <BackupsFromUrl />
    </Suspense>
  );
}
