"use client";

import { useEffect, useMemo, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowRight, RefreshCw, ShieldCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Database } from "@/lib/database.types";
import {
  detectOverlaps,
  findPlanConflict,
  generatePlan as buildStaggerPlan,
  keyForSchedule,
  type PlacedSchedule,
  type ScheduleLike,
  type PlanEntry,
} from "@/lib/backup-schedules";
import { usePersistedState } from "@/lib/use-persisted-state";
import { readSavedSort, writeSavedSort } from "@/lib/saved-sort";
import { useTask } from "@/components/providers/task-provider";
import {
  Button,
  Callout,
  Copyable,
  DataTable,
  Drawer,
  FilterBar,
  FilterField,
  Input,
  PageHeader,
  Select,
  StatusPill,
  type Column,
} from "@/components/ui";

type Schedule = Database["public"]["Tables"]["backup_schedules"]["Row"];
type Site = Partial<Database["public"]["Tables"]["sites"]["Row"]>;

type Row = { schedule: Schedule; site: Site | null; isConflicting: boolean; key: string };

/**
 * `params` is the page's query string. It is null in the first paint of a hard
 * load, before the browser has handed it over: the page then shows its loading
 * shape, the same one it shows while the rows are fetched.
 */
function SchedulesContent({ params: searchParams }: { params: URLSearchParams | null }) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [sites, setSites] = useState<Record<string, Site>>({});
  const [servers, setServers] = useState<Record<string, Database["public"]["Tables"]["servers"]["Row"]>>({});
  const [isLoading, setIsLoading] = useState(true);
  // False when the schedules could not be read: "no collisions" is then not something the page knows.
  const [schedulesRead, setSchedulesRead] = useState(false);

  const { runGenericTask } = useTask();

  // Conflict Engine
  const [resolutionKey, setResolutionKey] = useState<string | null>(null);
  const [staggeredPlan, setStaggeredPlan] = useState<PlanEntry[]>([]);

  // Stagger Tuning Options
  const [staggerInterval, setStaggerInterval] = useState<string>("15");
  const [customInterval, setCustomInterval] = useState<string>("");
  const [conflictStatus, setConflictStatus] = useState<'idle' | 'checking' | 'success' | 'error'>('idle');
  const [conflictMessage, setConflictMessage] = useState<string>("");

  // Filters and sort, kept between visits under the keys they have always had.
  const [searchQuery, setSearchQuery] = usePersistedState("backupschedules_search", "");
  const [savedType, saveType] = usePersistedState("backupschedules_type", "all");
  const [savedServer, saveServer] = usePersistedState("backupschedules_server", "all");
  const [savedFrequency, saveFrequency] = usePersistedState("backupschedules_frequency", "all");
  const [savedSort, saveSort] = usePersistedState("backupschedules_sort", "site-asc");
  const [savedConflicts, saveConflicts] = usePersistedState("backupschedules_conflicts", "false");
  // A filter that arrives in the address (a link from Overview or Backups) applies to this visit and is not
  // saved, as before. It gives way, and the choice is saved, as soon as that filter is changed by hand.
  // Worked out while rendering, so the first frame already shows the linked view.
  const address = searchParams?.toString() ?? "";
  const fromAddress = useMemo(() => {
    const next: Record<string, string> = {};
    const q = new URLSearchParams(address);
    if (q.get("conflict") === "true") {
      next.conflicts = "true";
      next.sort = "overlaps";
    }
    const serverParam = q.get("server");
    const typeParam = q.get("type");
    const freqParam = q.get("frequency");
    if (serverParam) next.server = serverParam;
    if (typeParam) next.type = typeParam;
    if (freqParam) next.frequency = freqParam;
    return next;
  }, [address]);
  const [changed, setChanged] = useState<{ address: string; names: string[] }>({ address: "", names: [] });
  const fromUrl: Record<string, string> = {};
  for (const [name, value] of Object.entries(fromAddress)) {
    if (!(changed.address === address && changed.names.includes(name))) fromUrl[name] = value;
  }
  const byHand = (name: string, save: (value: string) => void) => (value: string) => {
    if (name in fromAddress) setChanged((c) => ({ address, names: c.address === address ? [...c.names.filter((n) => n !== name), name] : [name] }));
    save(value);
  };
  const selectedType = fromUrl.type ?? savedType;
  const setSelectedType = byHand("type", saveType);
  const selectedServer = fromUrl.server ?? savedServer;
  const setSelectedServer = byHand("server", saveServer);
  const selectedFrequency = fromUrl.frequency ?? savedFrequency;
  const setSelectedFrequency = byHand("frequency", saveFrequency);
  const sortBy = fromUrl.sort ?? savedSort;
  const setSortBy = byHand("sort", saveSort);
  const showConflicts = (fromUrl.conflicts ?? savedConflicts) === "true";
  const setShowConflicts = (on: boolean) => byHand("conflicts", saveConflicts)(String(on));
  // "overlaps" keeps the rows as grouped below; "az" and "za" are what the old sort dropdown saved.
  const sort = sortBy === "overlaps" ? null : readSavedSort(sortBy, { id: "site", dir: "asc" }, { az: { id: "site", dir: "asc" }, za: { id: "site", dir: "desc" } });

  const supabase = createClient();

  useEffect(() => {
    async function fetchData() {
      setIsLoading(true);
      const [schedRes, siteRes, srvRes] = await Promise.all([
        supabase.from("backup_schedules").select("*").order("created_at", { ascending: false }),
        supabase.from("sites").select("*"),
        supabase.from("servers").select("*")
      ]);

      if (schedRes.data) setSchedules(schedRes.data);
      setSchedulesRead(!!schedRes.data);
      if (siteRes.data) {
        const siteMap: Record<string, Site> = {};
        siteRes.data.forEach(s => { siteMap[s.id.toString()] = s; });
        setSites(siteMap);
      }
      if (srvRes.data) {
        const srvMap: Record<string, (typeof srvRes.data)[number]> = {};
        srvRes.data.forEach(s => { srvMap[s.id.toString()] = s; });
        setServers(srvMap);
      }
      setIsLoading(false);
    }
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

  const getCronFormat = (s: Schedule) => {
    if (s.bup_schedule === "hourly") return `0 * * * *`;
    if (s.bup_schedule === "daily") return `${parseInt(s.minute || '0')} ${parseInt(s.hour || '0')} * * *`;
    if (s.bup_schedule === "weekly") return `${parseInt(s.minute || '0')} ${parseInt(s.hour || '0')} * * ${parseInt(s.day || '0')}`;
    return "0 0 * * *";
  };

  const formatSchedule = (s: Schedule) => {
    if (s.bup_schedule === "hourly") return `Hourly at minute :${s.minute?.padStart(2, '0') || "00"}`;
    if (s.bup_schedule === "daily") return `Daily at ${s.hour?.padStart(2, '0') || "00"}:${s.minute?.padStart(2, '0') || "00"} UTC`;
    if (s.bup_schedule === "weekly") {
      const dayMap = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const dName = s.day ? dayMap[parseInt(s.day)] : "Sunday";
      return `Weekly on ${dName} at ${s.hour?.padStart(2, '0') || "00"}:${s.minute?.padStart(2, '0') || "00"} UTC`;
    }
    return "Automatic";
  };

  // Every schedule paired with the server it runs on — the shape lib/backup-schedules
  // works in. Built once and reused by detection, planning and the conflict check so
  // those three can never disagree about what "same slot" means.
  const placed: PlacedSchedule[] = schedules.map(s => ({
    ...s,
    server_id: s.site_id ? sites[s.site_id.toString()]?.server_id : null,
  }));

  const overlaps = detectOverlaps(placed);
  const overlapCount = overlaps.schedulesInvolved;
  const collisionCount = overlaps.collisionCount;
  const hasOverlaps = collisionCount > 0;

  const uniqueProviders = Array.from(new Set(schedules.map(s => {
    if (s.type === 'remote') return `remote-${s.service_id}`;
    return 'local';
  })));

  // Takes the structural ScheduleLike rather than the full Supabase Row so it
  // accepts the server-annotated `placed` rows as well as raw schedules.
  const handleConflictClick = (key: string, matchingNodes: ScheduleLike[]) => {
    setResolutionKey(key);
    const val = staggerInterval === 'custom' ? parseInt(customInterval || "0") : parseInt(staggerInterval);
    setStaggeredPlan(buildStaggerPlan(val, matchingNodes));
    setConflictStatus('idle');
  };

  // Listen for Global Infrastructure Sync triggers from the masthead
  useEffect(() => {
    const handleGlobalSync = async () => {
      const schedRes = await supabase.from("backup_schedules").select("*").order("created_at", { ascending: false });
      if (schedRes.data) setSchedules(schedRes.data);
    };
    window.addEventListener("schedules_updated", handleGlobalSync);
    return () => window.removeEventListener("schedules_updated", handleGlobalSync);
  }, [supabase]);

  const checkAvailability = () => {
    setConflictStatus('checking');

    setTimeout(() => {
      const serverId = placed.find(s => s.id === staggeredPlan[0]?.id)?.server_id;
      // Only this server's schedules can collide — the key is server-scoped, so
      // an identical time on another box is not a conflict.
      const onServer = placed.filter(
        s => s.server_id?.toString() === serverId?.toString()
      );

      const conflict = findPlanConflict(staggeredPlan, onServer);

      if (conflict) {
        setConflictStatus('error');
        setConflictMessage("Conflict detected! Select a different timing interval.");
      } else {
        setConflictStatus('success');
        setConflictMessage("No future overlaps. Safe to resolve & sync offsets.");
      }
    }, 400);
  };

  // A new interval makes a new plan, which has not been checked yet. An interval
  // that is not a number of minutes leaves the plan as it was.
  const replan = (interval: string, custom: string) => {
    if (!resolutionKey) return;
    const intervalVal = interval === 'custom' ? parseInt(custom || "0") : parseInt(interval);
    if (!intervalVal || intervalVal < 0) return;

    const activeNodes = placed.filter(s => keyForSchedule(s) === resolutionKey);

    setStaggeredPlan(buildStaggerPlan(intervalVal, activeNodes));
    setConflictStatus('idle');
  };

  const executeResolution = async () => {
    if (!resolutionKey || staggeredPlan.length === 0) return;

    const serverId = sites[schedules.find(s=>s.id === staggeredPlan[0]?.id)?.site_id?.toString() || ""]?.server_id;
    const serverName = serverId ? servers[serverId.toString()]?.label : "Unknown Server";

    const keptStrings: string[] = [];
    const changedStrings: string[] = [];

    const fullResolutions = staggeredPlan.map(plan => {
      const original = schedules.find(s => s.id === plan.id);

      const site = original?.site_id ? sites[original.site_id.toString()] : null;
      const url = site?.url || "Unknown Site";

      const origHr = parseInt(original?.hour || "0");
      const origMin = parseInt(original?.minute || "0");
      const planHr = parseInt(plan.hour || "0");
      const planMin = parseInt(plan.minute || "0");

      if (origHr === planHr && origMin === planMin) {
        keptStrings.push(url);
      } else {
        const hourStr = plan.hour ? `${plan.hour.padStart(2,'0')}:` : "Hourly :";
        changedStrings.push(`${url} (to ${hourStr}${plan.minute.padStart(2,'0')} UTC)`);
      }

      return {
        id: plan.id,
        site_id: original?.site_id,
        bup_schedule: original?.bup_schedule,
        hour: plan.hour,
        minute: plan.minute,
        day: plan.day
      };
    }).filter(r => r.site_id && r.bup_schedule);

    const keptPart = keptStrings.length > 0 ? `Kept original schedule for ${keptStrings.join(', ')}.` : '';
    const changedPart = changedStrings.length > 0 ? `Adjusted ${changedStrings.join(' | ')}.` : '';
    const verboseLog = `[${serverName}] ${keptPart} ${changedPart}`.trim();

    // Only the schedules GridPane actually accepted may be written into local
    // state; the old code rewrote every row on any 200, showing times that
    // existed in neither GridPane nor Supabase.
    let syncedIds = new Set<number>();

    await runGenericTask(
      fullResolutions.length,
      ["Initializing algorithmic staggered offset resolution...", "Resolving dependencies across impacted Node matrix..."],
      async (log, updateProgress) => {
        let completed = 0;

        log(`Transmitting dynamic schedules to GridPane API infrastructure...`);

        const res = await fetch("/api/backups/resolve", {
           method: "POST",
           headers: { "Content-Type": "application/json" },
           body: JSON.stringify({ resolutions: fullResolutions })
        });

        const body = await res.json().catch(() => null);
        // Trust the per-schedule outcomes, not the HTTP call completing. This
        // route used to answer 200/success even when GridPane rejected every
        // change, and the line below cheerfully reported a clean sweep.
        const outcomes: Array<{ id: number; ok: boolean; stage?: string; status?: number }> =
          Array.isArray(body?.results) ? body.results : [];
        const okIds = new Set(outcomes.filter(o => o.ok).map(o => o.id));
        const failed = outcomes.filter(o => !o.ok);
        syncedIds = okIds;

        for (let i = 0; i < fullResolutions.length; i++) {
           await new Promise(r => setTimeout(r, 600)); // UI smoothing
           completed++;
           updateProgress(completed, okIds.size, failed.length);
        }

        if (failed.length > 0) {
           for (const f of failed) {
              const site = sites[fullResolutions.find(r => r.id === f.id)?.site_id?.toString() || ""];
              log(`REJECTED: ${site?.url || `schedule ${f.id}`}${f.status ? ` (HTTP ${f.status})` : ""}${f.stage === "cache" ? " — GridPane accepted it, local cache did not update" : ""}`);
           }
        }

        if (!res.ok && okIds.size === 0) {
           log(body?.message || "GridPane API proxy failure detected. Check System Logs.");
           window.dispatchEvent(new Event("system_logs_updated"));
           throw new Error(body?.message || "No schedules were changed. See System Logs.");
        }

        log(body?.message || `Synced ${okIds.size} schedule(s).`);

        await supabase.from("system_logs").insert({
          level: failed.length > 0 ? "warning" : "success",
          message: failed.length > 0 ? `${verboseLog} — ${failed.length} of ${fullResolutions.length} REJECTED by GridPane.` : verboseLog,
          site_url: "Dashboard Auto-Resolver"
        });
        window.dispatchEvent(new Event("system_logs_updated"));
      }
    );

    setResolutionKey(null);
    setStaggeredPlan([]);

    if (syncedIds.size > 0) {
      setSchedules(prev => {
        const next = [...prev];
        fullResolutions.forEach(res => {
           if (!syncedIds.has(res.id)) return;
           const idx = next.findIndex(s => s.id === res.id);
           if (idx > -1) {
              next[idx] = { ...next[idx], hour: res.hour, minute: res.minute, day: res.day ?? next[idx].day };
           }
        });
        return next;
      });
    }
  };

  const clearFilters = () => {
    setSearchQuery("");
    setSelectedType("all");
    setSelectedServer("all");
    setSelectedFrequency("all");
    setShowConflicts(false);
    if (sortBy === "overlaps") setSortBy("site-asc");
  };

  // ── Derived rows ──
  // Everything but the overlaps filter, so each pill can say how many rows it would show.
  const narrowed: Row[] = schedules.filter(schedule => {
    const site = schedule.site_id ? sites[schedule.site_id.toString()] : null;

    if (selectedFrequency !== "all" && schedule.bup_schedule?.toLowerCase() !== selectedFrequency.toLowerCase()) return false;

    if (selectedType !== "all") {
      if (selectedType === "local" && schedule.type !== "local") return false;
      if (selectedType.startsWith("remote-")) {
        const sId = parseInt(selectedType.split('-')[1]);
        if (schedule.type !== "remote" || schedule.service_id !== sId) return false;
      }
    }

    if (selectedServer !== "all" && site?.server_id?.toString() !== selectedServer) return false;

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      const matchesDomain = site?.url?.toLowerCase().includes(query) || false;
      const matchesCron = schedule.bup_schedule?.toLowerCase().includes(query) || false;
      const matchesProvider = schedule.type?.toLowerCase().includes(query) || false;
      return matchesDomain || matchesCron || matchesProvider;
    }
    return true;
  }).map((schedule) => {
    const site = schedule.site_id ? sites[schedule.site_id.toString()] : null;
    // A schedule with no server or no minute cannot overlap anything: its key is its own id.
    const slotted = !!site?.server_id && schedule.minute !== null;
    const key = slotted ? keyForSchedule({ ...schedule, server_id: site!.server_id }) : schedule.id.toString();
    return { schedule, site, key, isConflicting: slotted && overlaps.groups.has(key) };
  });

  const rows = showConflicts ? narrowed.filter((r) => r.isConflicting) : narrowed;
  // Grouped by overlap: rows that share a slot sit together, in site order within the slot.
  if (sortBy === "overlaps") {
    rows.sort((a, b) => {
      const keyA = a.site?.server_id ? `${a.site.server_id}-${a.schedule.type}-${a.schedule.bup_schedule}-${a.schedule.hour}-${a.schedule.minute}-${a.schedule.day || 'n'}` : 'z';
      const keyB = b.site?.server_id ? `${b.site.server_id}-${b.schedule.type}-${b.schedule.bup_schedule}-${b.schedule.hour}-${b.schedule.minute}-${b.schedule.day || 'n'}` : 'z';
      if (keyA === keyB) return (a.site?.url || "").localeCompare(b.site?.url || "");
      return keyA.localeCompare(keyB);
    });
  }
  const moreActive = [selectedServer !== "all", selectedFrequency !== "all", selectedType !== "all"].filter(Boolean).length;

  const openConflict = ({ schedule, site, isConflicting }: Row) => {
    if (!isConflicting) return;
    const key = keyForSchedule({ ...schedule, server_id: site?.server_id });
    // NOT `!s.hour`: hourly schedules carry a null hour, and that guard used to
    // drop every one of them from the group — it only looked fine because an
    // effect on `resolutionKey` (since removed) rebuilt the plan a moment later.
    const matches = placed.filter(s => keyForSchedule(s) === key);
    handleConflictClick(key, matches);
  };

  const closeDrawer = () => { setResolutionKey(null); setStaggeredPlan([]); };

  const originLabel = (site: Site | null) =>
    site?.server_id ? (servers[site.server_id.toString()]?.label || "not synced yet") : "not synced yet";
  const originIp = (site: Site | null) =>
    (site?.server_id ? servers[site.server_id.toString()]?.ip : null) || "—";

  const pad = (v: string | null | undefined) => (v || "0").padStart(2, "0");
  const columns: Column<Row>[] = [
    {
      id: "site",
      header: "Site",
      phone: "title",
      skeleton: "w-40",
      grow: true,
      sortValue: (r) => r.site?.url,
      cell: (r, where) => (
        <>
          <span className="block truncate text-[13px] font-bold">{r.site?.url || "Global override"}</span>
          {/* Tablet widths have no room for a server column, so the server sits under the site. */}
          {where === "table" && (
            <span className="mt-0.5 block truncate text-[11px] text-faint">
              {r.site?.site_nickname || "no site mapping"}
              <span className="lg:hidden">{" · "}{originLabel(r.site)}</span>
            </span>
          )}
        </>
      ),
    },
    {
      id: "origin",
      header: "Origin server",
      phone: "subtitle",
      skeleton: "w-24",
      className: "max-lg:hidden lg:max-w-[180px]",
      sortValue: (r) => originLabel(r.site),
      cell: (r, where) =>
        where === "phone" ? (
          originLabel(r.site)
        ) : (
          <>
            <span className="block truncate text-[12.5px] font-semibold">{originLabel(r.site)}</span>
            <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">{originIp(r.site)}</span>
          </>
        ),
    },
    {
      id: "schedule",
      header: "Schedule",
      skeleton: "w-32",
      // hourly, then daily, then weekly; within each, by day and time
      sortValue: (r) => `${["hourly", "daily", "weekly"].indexOf(r.schedule.bup_schedule || "")}${r.schedule.day || "0"}${pad(r.schedule.hour)}${pad(r.schedule.minute)}`,
      cell: (r) => <span className="whitespace-nowrap text-[12.5px]">{formatSchedule(r.schedule)}</span>,
    },
    {
      id: "cron",
      header: "Cron",
      skeleton: "w-20",
      className: "max-lg:hidden",
      cell: (r) => <Copyable value={getCronFormat(r.schedule)} what="cron schedule" className={r.isConflicting ? "text-[11.5px] text-warning [&>button]:-my-1" : "text-[11.5px] text-muted-foreground [&>button]:-my-1"} />,
    },
    {
      id: "destination",
      header: "Destination",
      skeleton: "w-24",
      className: "max-xl:hidden",
      sortValue: (r) => getProviderName(r.schedule.type, r.schedule.service_id),
      cell: (r, where) =>
        where === "phone" ? (
          getProviderName(r.schedule.type, r.schedule.service_id)
        ) : (
          <>
            <span className="eyebrow block text-faint">{r.schedule.type || "local"}</span>
            <span className="whitespace-nowrap text-[12.5px]">{getProviderName(r.schedule.type, r.schedule.service_id)}</span>
          </>
        ),
    },
    {
      id: "status",
      header: "Status",
      phone: "trailing",
      skeleton: "w-14",
      sortValue: (r) => (r.isConflicting ? 0 : 1),
      cell: (r) => (r.isConflicting ? <StatusPill tone="warn">Overlap</StatusPill> : <StatusPill tone="ok">Active</StatusPill>),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <PageHeader
          title="Backup schedules"
          stampClassName="max-sm:basis-full"
          stamp={
            isLoading ? (
              <span aria-hidden="true" className="block h-[21px] w-36 animate-pulse rounded-sm bg-panel-2" />
            ) : overlapCount > 0 ? (
              <StatusPill tone="warn" led>{overlapCount} in {collisionCount} collision{collisionCount === 1 ? "" : "s"}</StatusPill>
            ) : schedulesRead ? (
              <StatusPill tone="ok" led>No collisions</StatusPill>
            ) : (
              // The read failed: nothing is claimed, and the line keeps its height.
              <span aria-hidden="true" className="block h-[21px]" />
            )
          }
        />
        <p className="text-[12px] text-pretty text-muted-foreground">Manage global and site-specific automated backup{"\u00a0"}routines.</p>
      </div>

      <FilterBar
        noun="schedules"
        className="border-b border-border pb-4"
        pills={[
          { id: "all", label: "All", count: isLoading ? null : narrowed.length },
          { id: "overlaps", label: "Overlaps", count: isLoading ? null : narrowed.filter((r) => r.isConflicting).length },
        ]}
        value={showConflicts ? "overlaps" : "all"}
        onChange={(id) => {
          // Overlapping schedules are shown grouped by the slot they share.
          setShowConflicts(id === "overlaps");
          setSortBy(id === "overlaps" ? "overlaps" : sortBy === "overlaps" ? "site-asc" : sortBy);
        }}
        search={{ value: searchQuery, onChange: setSearchQuery, placeholder: "Search domain, frequency or provider" }}
        moreActive={moreActive}
        onClear={clearFilters}
        more={
          <>
            <FilterField label="Server">
              <Select value={selectedServer} onChange={(e) => setSelectedServer(e.target.value)}>
                <option value="all">Any server</option>
                {Object.values(servers).map(s => <option key={s.id} value={s.id.toString()}>{s.label}</option>)}
              </Select>
            </FilterField>
            <FilterField label="Frequency">
              <Select value={selectedFrequency} onChange={(e) => setSelectedFrequency(e.target.value)}>
                <option value="all">Any schedule</option>
                <option value="hourly">Hourly</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </Select>
            </FilterField>
            <FilterField label="Destination">
              <Select value={selectedType} onChange={(e) => setSelectedType(e.target.value)}>
                <option value="all">Any destination</option>
                {uniqueProviders.includes("local") && <option value="local">Local Server</option>}
                {uniqueProviders
                  .filter(p => p.startsWith("remote-"))
                  .sort()
                  .map(p => {
                    const sId = parseInt(p.split('-')[1]);
                    return <option key={p} value={p}>{getProviderName("remote", sId)}</option>;
                  })
                }
              </Select>
            </FilterField>
          </>
        }
      />

      <DataTable
        noun="schedules"
        columns={columns}
        rows={rows}
        rowKey={(r) => String(r.schedule.id)}
        loading={isLoading || !searchParams}
        skeletonRows={8}
        pageSize={25}
        sort={sort}
        onSortChange={(next) => setSortBy(writeSavedSort(next))}
        resetKey={`${searchQuery}|${showConflicts}|${selectedServer}|${selectedFrequency}|${selectedType}`}
        rowTone={(r) => (r.isConflicting ? "warn" : undefined)}
        breakBefore={sortBy === "overlaps" ? (r, prev) => !!prev && r.isConflicting && r.key !== prev.key : undefined}
        rowActions={hasOverlaps ? (r) => (r.isConflicting ? <Button size="sm" variant="warning" onClick={() => openConflict(r)}>Resolve</Button> : null) : undefined}
        empty={
          schedules.length === 0
            ? { title: "No backup schedules on record", hint: "They appear here after the next sync from GridPane." }
            : {
                title: "No backup schedules match these filters",
                hint: "Change the search or the filters to see every schedule.",
                action: <Button size="sm" onClick={clearFilters}>Clear filters</Button>,
              }
        }
      />

      {/* Conflict resolution drawer */}
      <Drawer
        open={!!resolutionKey}
        onClose={closeDrawer}
        title="Resolve overlap"
        meta="Stagger cron triggers"
        width={600}
        footer={
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="eyebrow text-faint">Stagger interval</span>
              <Select
                value={staggerInterval}
                onChange={(e) => { setStaggerInterval(e.target.value); replan(e.target.value, customInterval); }}
                aria-label="Stagger interval"
              >
                <option value="5">5 min</option>
                <option value="10">10 min</option>
                <option value="15">15 min</option>
                <option value="custom">Custom</option>
              </Select>
              {staggerInterval === 'custom' && (
                <Input
                  type="number"
                  min={1}
                  max={59}
                  value={customInterval}
                  onChange={(e) => { setCustomInterval(e.target.value); replan(staggerInterval, e.target.value); }}
                  placeholder="Min"
                  aria-label="Custom interval in minutes"
                  className="w-20"
                />
              )}
              <Button
                className="touch-hit ml-auto"
                onClick={checkAvailability}
                disabled={conflictStatus === 'checking'}
              >
                <ShieldCheck size={14} strokeWidth={1.75} />
                {conflictStatus === 'checking' ? 'Checking…' : 'Check availability'}
              </Button>
            </div>

            {conflictStatus === 'error' && (
              <Callout tone="danger" dense live>{conflictMessage}</Callout>
            )}
            {conflictStatus === 'success' && (
              <Callout tone="success" dense live>{conflictMessage}</Callout>
            )}

            <Button
              variant="solid"
              className="touch-hit w-full"
              onClick={executeResolution}
              disabled={staggeredPlan.length === 0 || conflictStatus !== 'success'}
            >
              <RefreshCw size={14} strokeWidth={1.75} />
              Resolve &amp; sync offsets
            </Button>
          </div>
        }
      >
        {resolutionKey && (() => {
          const matchingNodes = schedules.filter(s => {
            const site = s.site_id ? sites[s.site_id.toString()] : null;
            if (!site?.server_id || s.minute === null) return false;
            return keyForSchedule({ ...s, server_id: site.server_id }) === resolutionKey;
          });

          if (matchingNodes.length === 0) return null;

          const firstNodeId = matchingNodes[0]?.site_id?.toString() || "";
          const serverId = sites[firstNodeId]?.server_id;
          const sName = serverId ? servers[serverId.toString()]?.label : "not synced yet";
          const cronBase = matchingNodes[0];

          return (
            <>
              <div className="flex flex-col">
                <div className="flex items-baseline justify-between gap-3 border-b border-border py-2">
                  <span className="eyebrow text-faint">Host server</span>
                  <span className="text-[12.5px] font-semibold">{sName}</span>
                </div>
                <div className="flex items-baseline justify-between gap-3 border-b border-border py-2">
                  <span className="eyebrow text-faint">Concurrent jobs</span>
                  <span className="font-mono text-[12px] font-bold text-warning tabular-nums">{matchingNodes.length}</span>
                </div>
                <div className="flex items-baseline justify-between gap-3 border-b border-border py-2">
                  <span className="eyebrow text-faint">Original trigger</span>
                  <span className="font-mono text-[12px] tabular-nums">
                    {cronBase.hour?.padStart(2, '0')}:{cronBase.minute?.padStart(2, '0')} UTC
                  </span>
                </div>
              </div>

              <p className="eyebrow text-faint mb-1 mt-6">Staggered execution plan</p>
              <div className="flex flex-col">
                {matchingNodes.map((node) => {
                  const site = node.site_id ? sites[node.site_id.toString()] : null;
                  const provider = getProviderName(node.type, node.service_id);

                  const suggestedState = staggeredPlan.find(sp => sp.id === node.id);
                  const suggestedHour = suggestedState?.hour ?? node.hour;
                  const suggestedMinute = suggestedState?.minute ?? node.minute;

                  const isRetained = parseInt(suggestedHour || "0") === parseInt(node.hour || "0") && parseInt(suggestedMinute || "0") === parseInt(node.minute || "0");
                  const dispHour = (node.hour || "0").padStart(2, '0');
                  const dispMin = (node.minute || "0").padStart(2, '0');
                  const sugDispHour = (suggestedHour || "0").padStart(2, '0');
                  const sugDispMin = (suggestedMinute || "0").padStart(2, '0');

                  return (
                    <div key={node.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-2.5">
                      <div className="min-w-0">
                        <p className="truncate text-[12.5px] font-semibold">{site?.url || "Unknown site"}</p>
                        <p className="eyebrow text-faint mt-0.5">{provider}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {isRetained ? (
                          <>
                            <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                              {node.bup_schedule === 'hourly' ? `Hourly :${dispMin}` : `${dispHour}:${dispMin}`}
                            </span>
                            <StatusPill tone="ok">Kept</StatusPill>
                          </>
                        ) : (
                          <>
                            <span className="font-mono text-[11px] text-faint line-through tabular-nums">
                              {node.bup_schedule === 'hourly' ? `Hourly :${dispMin}` : `${dispHour}:${dispMin}`}
                            </span>
                            <ArrowRight size={14} strokeWidth={1.75} className="shrink-0 text-faint" />
                            <span className="font-mono text-[12px] font-bold text-primary tabular-nums">
                              {node.bup_schedule === 'hourly' ? `Hourly :${sugDispMin}` : `${sugDispHour}:${sugDispMin}`}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          );
        })()}
      </Drawer>
    </div>
  );
}

function SchedulesFromUrl() {
  return <SchedulesContent params={useSearchParams()} />;
}

export default function SchedulesPage() {
  // The fallback is the page itself in its loading shape, so nothing moves when the query string arrives.
  return (
    <Suspense fallback={<SchedulesContent params={null} />}>
      <SchedulesFromUrl />
    </Suspense>
  );
}
