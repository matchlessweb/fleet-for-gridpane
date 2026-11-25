"use client";

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ChevronDown, Info, ListFilter, Plus, X, XCircle } from "lucide-react";
import { cn, tie } from "@/lib/utils";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { FirstRunBanner } from "@/components/setup/sync-section";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Database } from "@/lib/database.types";
import { useThresholds } from "@/components/providers/settings-provider";
import { isUnderLoad } from "@/lib/thresholds";
import { useClientValue } from "@/lib/use-client-value";
import { useStoredState } from "@/lib/use-stored-state";
import { detectOverlaps } from "@/lib/backup-schedules";
import { clearDoneLogs, clearQuestion, countClearable, isOpenProblem, isProblem, logBody, logTitle } from "@/lib/action-logs";
import { toast } from "sonner";
import {
  Button,
  Callout,
  EmptyState,
  Figure,
  Led,
  Meter,
  Panel,
  PanelHeader,
  Segmented,
  claimOverlay,
  releaseOverlay,
  useViewportClamp,
  ConfirmDialog,
} from "@/components/ui";

/* The Ledger charts three series, no more — chart tokens only. */
const CHART_SERIES_TOKENS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)"];

/* sm-breakpoint tracker — Recharts margins/labels are props, not CSS, so the
   phone layout (no reserved right margin, no direct end-labels) needs a JS
   viewport signal. Server snapshot assumes desktop; corrects on hydration. */
const SM_MEDIA_QUERY = "(min-width: 640px)";
function subscribeSmUp(onChange: () => void) {
  const mql = window.matchMedia(SM_MEDIA_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}
function getSmUpSnapshot() {
  return window.matchMedia(SM_MEDIA_QUERY).matches;
}
function getSmUpServerSnapshot() {
  return true;
}

const TIME_RANGE_OPTIONS = [
  { value: "10 Minutes", label: "10m" },
  { value: "1 Hour", label: "1h" },
  { value: "6 Hours", label: "6h" },
  { value: "12 Hours", label: "12h" },
];

const HERO_INFO_TEXT =
  "Rolling 60-minute system load across all servers actively reporting telemetry.";
const SERVERS_INFO_TEXT =
  "A node is flagged if its real-time telemetry spikes above 80% CPU or 90% RAM. If an indicator is shown here, administrative action should be taken immediately.";
const CHART_INFO_TEXT =
  "The percentage value tracks the extreme right edge of the graph—what the server is doing at this exact second. It naturally bounces between low baseline numbers while the chart behind it visualizes the intense historical spikes.";

/* What the chart library hands a tooltip: one entry per line under the pointer. */
type TooltipEntry = { dataKey?: string | number; name?: string | number; value?: string | number; stroke?: string; color?: string };
type InkTooltipProps = { active?: boolean; payload?: TooltipEntry[]; label?: string; formatLabel?: (label: string) => string };

/* Ink tooltip — foreground plate, mono numerals. */
const InkTooltip = ({ active, payload, label, formatLabel }: InkTooltipProps) => {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="min-w-[150px] rounded-md bg-foreground px-3 py-2 font-mono text-[11px] text-background shadow-2xl">
      <div className="mb-1 opacity-70">{formatLabel ? formatLabel(label as string) : label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center justify-between gap-4">
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className="h-[7px] w-[7px] shrink-0 rounded-full"
              style={{ backgroundColor: p.stroke || p.color }}
            />
            <span className="truncate">{p.name || p.dataKey}</span>
          </span>
          <span className="tabular-nums">{p.value}%</span>
        </div>
      ))}
    </div>
  );
};

/* Info popover — content preserved, rendered as a small Panel on the overlay bus. */
function InfoPopover({
  text,
  align = "left",
}: {
  text: string;
  align?: "left" | "center";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  /* Anchored to a trigger that can sit anywhere in the row — without this the
     fixed-width panel runs off the edge on phones. */
  const popRef = useViewportClamp<HTMLDivElement>(open);

  useEffect(() => {
    if (!open) return;
    claimOverlay(close);
    function handleClickOutside(event: MouseEvent | TouchEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        close();
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("touchstart", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("touchstart", handleClickOutside);
      releaseOverlay(close);
    };
  }, [open, close]);

  return (
    <div className="relative flex items-center" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          "touch-hit text-faint transition-colors duration-150 hover:text-foreground",
          open && "text-foreground"
        )}
        aria-label="More information"
      >
        <Info size={14} strokeWidth={1.75} />
      </button>
      {open && (
        <Panel
          ref={popRef}
          className={cn(
            "anim-fade absolute top-full z-50 mt-2 w-64 max-w-[calc(100vw-24px)] p-3 shadow-2xl",
            align === "left" && "left-0",
            align === "center" && "left-1/2 -translate-x-1/2"
          )}
        >
          <p className="text-pretty text-[12px] leading-relaxed text-muted-foreground">{text}</p>
        </Panel>
      )}
    </div>
  );
}

function truncateSeriesName(name: string) {
  return name.length > 14 ? `${name.slice(0, 13)}…` : name;
}

/* What the chart library hands a point's label: where the point is, and which point it is. */
type EndLabelProps = { x?: number | string; y?: number | string; index?: number; viewBox?: { x?: number; y?: number } } | null | undefined;

/* Direct label at the line end — series name in its color, inside the reserved right margin. */
function renderEndLabel(
  props: EndLabelProps,
  name: string,
  color: string,
  lastIndex: number,
  dy: number
) {
  const x = Number(props?.x ?? props?.viewBox?.x);
  const y = Number(props?.y ?? props?.viewBox?.y);
  if (props?.index !== lastIndex || !Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  return (
    <text
      x={x + 8}
      y={y + dy + 3.5}
      fill={color}
      fontSize={10.5}
      fontWeight={600}
      style={{ fontFamily: "var(--font-sans)" }}
    >
      {name}
    </text>
  );
}

type ServerRow = Database["public"]["Tables"]["servers"]["Row"];
type SystemLog = Database["public"]["Tables"]["system_logs"]["Row"];
type TelemetryRow = Database["public"]["Tables"]["server_telemetry"]["Row"];
/* One point on the load chart: its time label, then each server's CPU reading under srv_<id>. */
type ChartPoint = { time: string; [series: string]: string | number | null | undefined };

// The views this page remembers in the browser: what it accepts back, and how each is written.
type TimeRange = "10 Minutes" | "30 Minutes" | "1 Hour" | "6 Hours" | "12 Hours";
const TIME_RANGE_VALUES: readonly TimeRange[] = ["10 Minutes", "30 Minutes", "1 Hour", "6 Hours", "12 Hours"];
const parseTimeRange = (text: string) => TIME_RANGE_VALUES.find((value) => value === text);
const parseTimeFormat = (text: string) => (text === "UTC" || text === "Local" ? text : undefined);
const parseChartMode = (text: string) => (text === "hottest" || text === "custom" ? text : undefined);
const parseIds = (text: string) => {
  const value: unknown = JSON.parse(text);
  return Array.isArray(value) && value.every((id) => typeof id === "number") ? (value as number[]) : undefined;
};
const asText = (value: string): string | null => value;
// An empty list removes the key.
const idsAsText = (ids: number[]) => (ids.length > 0 ? JSON.stringify(ids) : null);
const NO_IDS: number[] = [];

export default function Dashboard() {
  const [timeRange, setTimeRange] = useStoredState<TimeRange>("dashboard_time_range", "12 Hours", parseTimeRange, asText);
  const [timeFormat, setTimeFormat] = useStoredState<"UTC" | "Local">("dashboard_time_format", "Local", parseTimeFormat, asText);
  const [liveServers, setLiveServers] = useState<ServerRow[]>([]);
  // Every server Fleet has read from GridPane, reporting or not.
  const [serverTotal, setServerTotal] = useState(0);
  const [siteCount, setSiteCount] = useState<number | null>(null);
  // Addresses that also have a GridPane record on their old server (a moved
  // site whose old copy is kept until it is deleted in GridPane).
  const [siteCopies, setSiteCopies] = useState(0);
  const [telemetryData, setTelemetryData] = useState<ChartPoint[]>([]);
  const [telemetryError, setTelemetryError] = useState(false);
  // False on the server and for the first paint: the chart measures its box, so it is drawn in the browser only.
  const mounted = useClientValue(() => true, false);

  const [recentLogs, setRecentLogs] = useState<SystemLog[]>([]);
  const [logsKnown, setLogsKnown] = useState(false);
  const supabase = createClient();

  const isSmUp = useSyncExternalStore(subscribeSmUp, getSmUpSnapshot, getSmUpServerSnapshot);

  useEffect(() => {
    const fetchRecentLogs = () => {
      supabase.from("system_logs").select("*").order("created_at", { ascending: false }).limit(5)
        .then(({ data }) => { if (data) setRecentLogs(data); setLogsKnown(true); });
    };

    fetchRecentLogs();

    // Listen to Topbar updates to keep dashboard local array securely in sync
    window.addEventListener("system_logs_updated", fetchRecentLogs);
    return () => window.removeEventListener("system_logs_updated", fetchRecentLogs);
  }, [supabase]);

  // Clearing asks first, with the real numbers, and never deletes an open
  // problem or an entry nobody has read. Same rule as the bell's panel.
  const [clearQuestionCounts, setClearQuestionCounts] = useState<{ clearable: number; staying: number } | null>(null);
  const askToClearLogs = async () => {
    try {
      const counts = await countClearable(supabase);
      if (counts.clearable === 0) {
        toast.message("Nothing to clear. Only read and resolved entries are deleted.");
        return;
      }
      setClearQuestionCounts(counts);
    } catch (e) {
      toast.error(`Could not count the entries: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  };
  const clearRecentLogs = async () => {
    await clearDoneLogs(supabase);
    window.dispatchEvent(new Event("system_logs_updated"));
  };
  const clearWording = clearQuestionCounts ? clearQuestion(clearQuestionCounts.clearable, clearQuestionCounts.staying) : null;

  const [globalCpuAvg, setGlobalCpuAvg] = useState<number | null>(null);
  const [nodesUnderLoad, setNodesUnderLoad] = useState(0);

  const [overlappingScheduleCount, setOverlappingScheduleCount] = useState<number>(0);
  // Whether each of the board's three reads has answered yet. Until it has, its
  // figure shows a placeholder: a 0 or "all clear" shown before the answer is a claim nobody checked.
  const [avgKnown, setAvgKnown] = useState(false);
  const [statsKnown, setStatsKnown] = useState(false);
  const [overlapsKnown, setOverlapsKnown] = useState(false);

  useEffect(() => {
    async function checkSchedules() {
      const { data } = await supabase.from("backup_schedules").select("*, sites(server_id)");
      if (data) {
        // Shares lib/backup-schedules with the schedules page. This rule used to
        // be copy-pasted in both files; two copies of "what counts as the same
        // slot" is how the two screens quietly start disagreeing.
        const { schedulesInvolved } = detectOverlaps(
          data.map((sched) => ({ ...sched, server_id: sched.sites?.server_id }))
        );
        setOverlappingScheduleCount(schedulesInvolved);
      }
      setOverlapsKnown(true);
    }
    checkSchedules();
  }, [supabase]);
  const latestStatsMapRef = useRef(new Map<number, { cpu: number, ram: number }>());
  // The same readings as state, for what is drawn from them (the hottest-nodes rail):
  // set wherever the ref is written. The ref is what the fetch and the live handler count from.
  const [latestStats, setLatestStats] = useState<[number, { cpu: number, ram: number }][]>([]);
  // "Under load" used to mean `cpu > 80 || ram > 90` — a third set of numbers
  // that matched neither the meter colours nor the settings page. It now reads
  // the operator's configured critical bands, so the count and the colours
  // finally agree. Held in a ref because the two places that recompute it are a
  // fetch effect and a realtime handler; reading the state value there would
  // either capture a stale closure or force both to re-subscribe whenever the
  // thresholds change.
  const thresholds = useThresholds();
  const thresholdsRef = useRef(thresholds);
  // Declared before the recount below, so the ref already holds the new bands when that effect runs.
  useEffect(() => {
    thresholdsRef.current = thresholds;
  }, [thresholds]);

  const recountUnderLoad = useCallback(() => {
    setNodesUnderLoad(
      Array.from(latestStatsMapRef.current.values()).filter((s) =>
        isUnderLoad({ cpu: s.cpu, memory: s.ram }, thresholdsRef.current)
      ).length
    );
  }, []);

  // Editing a threshold should move this number immediately, not on the next
  // telemetry tick ten minutes later.
  useEffect(() => {
    if (latestStatsMapRef.current.size > 0) recountUnderLoad();
  }, [thresholds, recountUnderLoad]);

  const [chartMode, setChartMode] = useStoredState<"hottest" | "custom">("dashboard_chart_mode", "hottest", parseChartMode, asText);
  const [customServerIds, setCustomServerIds] = useStoredState<number[]>("dashboard_custom_servers", NO_IDS, parseIds, idsAsText);
  const [hiddenHottestIds, setHiddenHottestIds] = useStoredState<number[]>("dashboard_hidden_hottest", NO_IDS, parseIds, idsAsText);
  const [serverPickerOpen, setServerPickerOpen] = useState(false);

  const pickerRef = useRef<HTMLDivElement>(null);
  /* right-0 anchors the panel to the trigger, which wraps to the left of the
     chart header on phones — clamp keeps it on-screen. */
  const pickerPopRef = useViewportClamp<HTMLDivElement>(serverPickerOpen);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) {
        setServerPickerOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // One overlay at a time — the picker registers with the overlay bus while open.
  const closeServerPicker = useCallback(() => setServerPickerOpen(false), []);
  useEffect(() => {
    if (!serverPickerOpen) return;
    claimOverlay(closeServerPicker);
    return () => releaseOverlay(closeServerPicker);
  }, [serverPickerOpen, closeServerPicker]);

  const [activeChartServers, setActiveChartServers] = useState<{id: number, label: string, color: string, dataKey: string}[]>([]);
  const activeChartServersRef = useRef(activeChartServers);

  // Dynamically compute target servers for the chart based on mode or latest CPU readings
  useEffect(() => {
    let targetIds: number[] = [];
    if (chartMode === "hottest") {
      if (latestStatsMapRef.current.size === 0) return;
      targetIds = Array.from(latestStatsMapRef.current.entries())
        .sort((a, b) => b[1].cpu - a[1].cpu)
        .slice(0, 3)
        .map(e => e[0])
        .filter(id => !hiddenHottestIds.includes(id));
    } else {
      targetIds = customServerIds.slice(0, 3);
    }

    setActiveChartServers(current => {
      const targetServers = targetIds.map((id, index) => {
        const srv = liveServers.find(s => s.id === id);
        const existing = current.find(c => c.id === id);
        return {
          id,
          label: srv ? srv.label : (existing && !existing.label.startsWith("Server ") ? existing.label : `Server ${id}`),
          color: CHART_SERIES_TOKENS[index % CHART_SERIES_TOKENS.length],
          dataKey: `srv_${id}`
        };
      });

      if (current.length === targetServers.length &&
          targetServers.every((t, i) => t.id === current[i].id && t.label === current[i].label)) {
        return current;
      }
      return targetServers;
    });
  }, [telemetryData, chartMode, customServerIds, liveServers, hiddenHottestIds]);

  useEffect(() => {
    activeChartServersRef.current = activeChartServers;
  }, [activeChartServers]);

  // Null when no server has reported a load in the timeframe: a new install, or no agents yet.
  const timeframeAvgLoad = useMemo((): number | null => {
    if (!telemetryData.length || !activeChartServers.length) return null;
    let sum = 0;
    let count = 0;
    const allowedKeys = new Set(activeChartServers.map(s => s.dataKey));
    telemetryData.forEach(row => {
      Object.keys(row).forEach(k => {
        if (allowedKeys.has(k) && typeof row[k] === "number") {
          sum += row[k];
          count++;
        }
      });
    });
    return count > 0 ? sum / count : null;
  }, [telemetryData, activeChartServers]);

  // "No reports" rather than a full green ring: with nothing measured there is nothing to call optimal.
  const healthStatus = useMemo(() => {
    if (timeframeAvgLoad === null) return "No reports";
    if (timeframeAvgLoad >= 70) return "Critical";
    if (timeframeAvgLoad >= 40) return "Elevated";
    return "Optimal";
  }, [timeframeAvgLoad]);

  const healthRingValue = timeframeAvgLoad === null ? 0 : 100 - timeframeAvgLoad;

  const currentChartCpuAvg = useMemo(() => {
    if (!telemetryData.length || !activeChartServers.length) return null;
    const latestRow = telemetryData[telemetryData.length - 1];
    let sum = 0;
    let count = 0;
    activeChartServers.forEach(s => {
      if (typeof latestRow[s.dataKey] === "number") {
        sum += latestRow[s.dataKey] as number;
        count++;
      }
    });
    return count > 0 ? parseFloat((sum / count).toFixed(1)) : null;
  }, [telemetryData, activeChartServers]);

  useEffect(() => {
    let active = true;
    async function fetch1HourAvg() {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { data, error } = await supabase.from("server_telemetry").select("cpu_usage").gte("timestamp", oneHourAgo).order("timestamp", { ascending: false }).limit(1000);
      if (!active) return;
      if (error) console.error("[Dashboard] 1hr avg telemetry query failed:", error);
      setAvgKnown(true);
      if (data && data.length > 0) {
        const sum = data.reduce((a, b) => a + Number(b.cpu_usage), 0);
        setGlobalCpuAvg(parseFloat((sum / data.length).toFixed(1)));
      } else {
        setGlobalCpuAvg(null);
      }
    }
    fetch1HourAvg();
    const interval = setInterval(fetch1HourAvg, 60000);
    return () => { active = false; clearInterval(interval); };
  }, [supabase]);

  useEffect(() => {
    let isCancelled = false;

    const isDetailed = timeRange === "10 Minutes" || timeRange === "30 Minutes";
    const maxPoints = timeRange === "10 Minutes" ? 200 : timeRange === "30 Minutes" ? 300 : 720;
    const offsetMs = timeRange === "10 Minutes" ? 10 * 60 * 1000 :
                     timeRange === "30 Minutes" ? 30 * 60 * 1000 :
                     timeRange === "1 Hour" ? 60 * 60 * 1000 :
                     timeRange === "6 Hours" ? 6 * 60 * 60 * 1000 :
                     12 * 60 * 60 * 1000;
    const gteTime = new Date(Date.now() - offsetMs).toISOString();

    async function fetchStats() {
      const [serversRes, sitesRes, telemetryRes] = await Promise.all([
        supabase.from("servers").select("*").order("label"),
        // Count addresses, not records: a moved site is listed on both servers
        // until its old copy is deleted, and that is still one site.
        supabase.from("sites").select("url"),
        supabase.from("server_telemetry").select("id,server_id,cpu_usage,ram_usage,timestamp").gte("timestamp", gteTime).order("timestamp", { ascending: false }).limit(1000)
      ]);

      if (isCancelled) return;
      setStatsKnown(true);

      if (serversRes.error) console.error("[Dashboard] servers query failed:", serversRes.error);
      if (serversRes.data) setServerTotal(serversRes.data.length);
      if (telemetryRes.error) {
        console.error("[Dashboard] telemetry query failed:", telemetryRes.error);
        setTelemetryError(true);
      } else {
        setTelemetryError(false);
      }

      // Rows arrive newest-first (so .limit keeps the freshest window) — reverse to ascending for grouping
      const telemetryRows = telemetryRes.data ? [...telemetryRes.data].reverse() : null;

      if (serversRes.data && telemetryRows) {
        const activeTelemetryIds = new Set(telemetryRows.map(row => row.server_id));
        const verifiedServers = serversRes.data.filter(s => activeTelemetryIds.has(s.id));
        setLiveServers(verifiedServers);
      } else if (serversRes.data) {
        setLiveServers(serversRes.data);
      }
      if (sitesRes.error) {
        console.error("[Dashboard] sites query failed:", sitesRes.error);
      } else if (sitesRes.data) {
        const addresses = new Set(sitesRes.data.map(r => r.url)).size;
        setSiteCount(addresses);
        setSiteCopies(sitesRes.data.length - addresses);
      }

      // Parse the raw Supabase rows into a Recharts-friendly temporal array
      if (telemetryRows && telemetryRows.length > 0) {

        latestStatsMapRef.current.clear();
        // Target Top Hottest Servers
        telemetryRows.forEach(row => {
          latestStatsMapRef.current.set(row.server_id, { cpu: row.cpu_usage, ram: row.ram_usage });
        });
        setLatestStats(Array.from(latestStatsMapRef.current.entries()));

        if (latestStatsMapRef.current.size > 0) {
           recountUnderLoad();
        }

        // Group telemetry by timestamp carrying forward last known values
        const groupedArray: ChartPoint[] = [];
        let lastKnown = {};

        telemetryRows.forEach(row => {
          try {
            const ds = new Date(row.timestamp);
            const timeKey = isDetailed
              ? `${String(ds.getUTCHours()).padStart(2, '0')}:${String(ds.getUTCMinutes()).padStart(2, '0')}:${String(ds.getUTCSeconds()).padStart(2, '0')}`
              : `${String(ds.getUTCHours()).padStart(2, '0')}:${String(ds.getUTCMinutes()).padStart(2, '0')}`;

            lastKnown = { ...lastKnown, [`srv_${row.server_id}`]: row.cpu_usage };

            if (groupedArray.length === 0 || groupedArray[groupedArray.length - 1].time !== timeKey) {
              groupedArray.push({ time: timeKey, ...lastKnown });
            } else {
              groupedArray[groupedArray.length - 1] = { ...groupedArray[groupedArray.length - 1], ...lastKnown };
            }
          } catch {}
        });

        const sortedData = groupedArray.slice(-maxPoints);
        if (isCancelled) return;
        setTelemetryData(sortedData);
      }
    }

    fetchStats();

    // Establish persistent Realtime WebSocket connection securely
    const channel = supabase.channel("dashboard-telemetry")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "server_telemetry" },
        (payload) => {
          const newRow = payload.new as TelemetryRow;
          const ds = new Date(newRow.timestamp);
          const timeKey = isDetailed
            ? `${String(ds.getUTCHours()).padStart(2, '0')}:${String(ds.getUTCMinutes()).padStart(2, '0')}:${String(ds.getUTCSeconds()).padStart(2, '0')}`
            : `${String(ds.getUTCHours()).padStart(2, '0')}:${String(ds.getUTCMinutes()).padStart(2, '0')}`;

          latestStatsMapRef.current.set(newRow.server_id, { cpu: newRow.cpu_usage, ram: newRow.ram_usage });
          setLatestStats(Array.from(latestStatsMapRef.current.entries()));
          if (latestStatsMapRef.current.size > 0) {
             recountUnderLoad();
          }

          setLiveServers((prevServers) => {
            const serverExists = prevServers.some(s => s.id === newRow.server_id);
            if (!serverExists) {
              supabase.from("servers").select("*").eq("id", newRow.server_id).single()
                .then(({ data, error }) => {
                  if (data && !error) {
                    // Two readings can arrive before the first fetch lands: add the server once.
                    setLiveServers(current =>
                      current.some(s => s.id === data.id)
                        ? current
                        : [...current, data].sort((a, b) => a.label.localeCompare(b.label))
                    );
                  }
                });
            }
            return prevServers;
          });

          setTelemetryData((prev) => {
            let updatedData = [...prev];
            const dataKey = `srv_${newRow.server_id}`;

            if (updatedData.length > 0 && updatedData[updatedData.length - 1].time === timeKey) {
              const last = { ...updatedData[updatedData.length - 1] };
              last[dataKey] = newRow.cpu_usage;
              updatedData[updatedData.length - 1] = last;
              return [...updatedData];
            }

            const prevRow = updatedData.length > 0 ? updatedData[updatedData.length - 1] : {};
            const freshEntry: ChartPoint = { ...prevRow, time: timeKey };
            freshEntry[dataKey] = newRow.cpu_usage;

            updatedData.push(freshEntry);
            if (updatedData.length > maxPoints) {
              updatedData = updatedData.slice(-maxPoints);
            }

            return [...updatedData];
          });
        }
      )
      .subscribe();

    return () => {
      isCancelled = true;
      supabase.removeChannel(channel);
    };
  }, [supabase, timeRange, recountUnderLoad]); // Explicitly omitted liveServers to prevent re-fetch loops on array initialization

  const formatTime = (timeStr: string): string => {
    if (typeof timeStr !== 'string') return timeStr;
    if (timeFormat === "UTC") return `${timeStr} UTC`;

    const [hours, minutes] = timeStr.split(':');
    if (!hours || !minutes) return timeStr;

    // Use current day to properly calculate active Daylight Savings Time shifts naturally
    const now = new Date();
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), parseInt(hours), parseInt(minutes)));
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
  };

  // Hottest nodes for the rail — reuses the latest telemetry snapshot per server.
  const hottestNodes = useMemo(() => {
    return [...latestStats]
      .sort((a, b) => b[1].cpu - a[1].cpu)
      .slice(0, 4)
      .map(([id, stats]) => {
        const srv = liveServers.find(s => s.id === id);
        return {
          id,
          label: srv ? srv.label : `Server ${id}`,
          ip: srv?.ip ?? null,
          cpu: Number(stats.cpu),
        };
      });
  }, [latestStats, liveServers]);

  const hottestNode = hottestNodes.length > 0 ? hottestNodes[0] : null;

  // Direct-label collision offsets: last values sorted top-down, nudged 13px apart.
  const endLabelOffsets = useMemo(() => {
    const offsets: Record<string, number> = {};
    if (!telemetryData.length) return offsets;
    const last = telemetryData[telemetryData.length - 1];
    const pxPerPct = 2.6; // ~260px plot height across the 0–100% domain
    let prevY = -Infinity;
    activeChartServers
      .map(s => ({
        key: s.dataKey,
        value: typeof last[s.dataKey] === "number" ? (last[s.dataKey] as number) : null,
      }))
      .filter((e): e is { key: string; value: number } => e.value !== null)
      .sort((a, b) => b.value - a.value)
      .forEach(e => {
        const rawY = (100 - e.value) * pxPerPct;
        const y = Math.max(rawY, prevY + 13);
        offsets[e.key] = y - rawY;
        prevY = y;
      });
    return offsets;
  }, [telemetryData, activeChartServers]);

  const lastPointIndex = telemetryData.length - 1;

  const ringColor =
    healthStatus === "Critical" ? "var(--danger)" :
    healthStatus === "Elevated" ? "var(--warning)" :
    healthStatus === "No reports" ? "var(--muted-foreground)" : "var(--primary)";
  const statusTextClass =
    healthStatus === "Critical" ? "text-danger" :
    healthStatus === "Elevated" ? "text-warning" :
    healthStatus === "No reports" ? "text-muted-foreground" : "text-primary";

  const heroNarrative = hottestNode
    ? `${hottestNode.label} is the busiest node at ${hottestNode.cpu.toFixed(1)}%${currentChartCpuAvg !== null ? ` · charted series read ${currentChartCpuAvg}% now` : ""}.`
    : statsKnown
      ? "No server has reported its load. Each server's agent reports it."
      : "";
  // Said wherever a reading would be when no agent has reported: the sync may be
  // complete, but load comes from the agents (SETUP.md, steps 7 and 8).
  const noReportsLine = `No server has reported its load over the last ${timeRange.toLowerCase()}.`;

  return (
    <div>
      {/* Until Fleet has read GridPane once: a pointer to the setup page and its first sync. */}
      <FirstRunBanner />

      {/* ── THE BOARD ─────────────────────────────────────────────── */}
      <section className="grid grid-cols-1 gap-y-7 border-b border-line-strong pb-8 sm:grid-cols-2 sm:gap-x-8 lg:grid-cols-[1.1fr_1fr_1fr_1fr] lg:gap-x-0">
        {/* Cell 1 — hero */}
        <Figure
          size="lg"
          className="sm:col-span-2 lg:col-span-1 lg:pr-10"
          mark={<Led tone="ok" ping />}
          label="Fleet load · 1 hour mean"
          aside={<InfoPopover text={HERO_INFO_TEXT} />}
          value={globalCpuAvg !== null ? `${globalCpuAvg}%` : avgKnown ? "–" : null}
          // Two lines held from the first paint: the loaded sentence runs to two.
          note={<span className="block min-h-[2lh] max-w-[300px] text-[12.5px] leading-relaxed">{heroNarrative}</span>}
        />

        {/* Cell 2 — active servers */}
        <Figure
          className="lg:border-l lg:border-border lg:pl-7 lg:pr-4"
          label="Active servers"
          aside={<InfoPopover text={SERVERS_INFO_TEXT} />}
          value={liveServers.length > 0 ? liveServers.length : statsKnown ? "–" : null}
          delta={liveServers.length > 0 ? { text: "All synced", tone: "ok" } : null}
          note={
            liveServers.length > 0
              ? `${liveServers.length} live ${liveServers.length === 1 ? "agent" : "agents"} · ${nodesUnderLoad} under load`
              : !statsKnown
                ? ""
                : serverTotal > 0
                  ? `0 of ${serverTotal} servers reporting`
                  : "No servers read from GridPane yet"
          }
        />

        {/* Cell 3 — active sites */}
        <Figure
          className="lg:border-l lg:border-border lg:pl-7 lg:pr-4"
          label="Active sites"
          value={siteCount !== null ? siteCount : statsKnown ? "–" : null}
          delta={siteCount !== null ? { text: "Synced", tone: "ok" } : null}
          note={
            siteCount !== null
              ? `${liveServers.length > 0 ? `across ${liveServers.length} active ${liveServers.length === 1 ? "node" : "nodes"}` : `on ${serverTotal} servers`}${siteCopies > 0 ? ` · ${siteCopies} also on their old server` : ""}`
              : ""
          }
        />

        {/* Cell 4 — backup overlaps */}
        <Figure
          className="lg:border-l lg:border-border lg:pl-7"
          label="Backup overlaps"
          value={overlapsKnown ? overlappingScheduleCount : null}
          tone={overlapsKnown && overlappingScheduleCount > 0 ? "warn" : "default"}
          delta={!overlapsKnown ? null : overlappingScheduleCount > 0 ? { text: "Action required", tone: "warn" } : { text: "Clear", tone: "ok" }}
          note={!overlapsKnown ? "" : overlappingScheduleCount > 0 ? "same-slot backup schedules" : "no schedule collisions"}
        />
      </section>

      {/* ── SPLIT: chart + rail ───────────────────────────────────── */}
      <section className="grid grid-cols-1 pt-7 pb-10 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* Chart section */}
        <div className="min-w-0 lg:border-r lg:border-border lg:pr-8">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-3">
            <div className="flex items-center gap-2">
              <h2 className="text-balance text-[19px] font-bold tracking-[-0.015em]">Live CPU load</h2>
              <InfoPopover text={CHART_INFO_TEXT} align="center" />
            </div>
            <span className="text-[12px] text-faint">
              {chartMode === "hottest" ? "Three busiest nodes · 10-minute samples" : "Custom selection · 10-minute samples"}
            </span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Segmented
                className="[&>button]:touch-hit"
                options={TIME_RANGE_OPTIONS}
                value={timeRange}
                onChange={(v) => setTimeRange(v as typeof timeRange)}
              />
              <Segmented
                className="[&>button]:touch-hit"
                options={[{ value: "UTC", label: "UTC" }, { value: "Local", label: "Local" }]}
                value={timeFormat}
                onChange={(v) => setTimeFormat(v as "UTC" | "Local")}
              />

              {/* Server picker */}
              <div className="relative" ref={pickerRef}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setServerPickerOpen(!serverPickerOpen)}
                >
                  <ListFilter size={14} strokeWidth={1.75} />
                  Filter
                  <ChevronDown
                    size={14}
                    strokeWidth={1.75}
                    className={cn("transition-transform duration-150", serverPickerOpen && "rotate-180")}
                  />
                </Button>

                {serverPickerOpen && (
                  <Panel
                    ref={pickerPopRef}
                    className="anim-fade absolute right-0 top-full z-50 mt-2 w-[264px] max-w-[calc(100vw-24px)] p-3 shadow-2xl"
                  >
                    <div className="mb-2.5 flex items-center justify-between">
                      <span className="eyebrow text-faint">Chart series</span>
                      <span className="eyebrow text-faint">3 series max</span>
                    </div>
                    <Segmented
                      className="w-full [&>button]:flex-1 [&>button]:touch-hit"
                      options={[
                        { value: "hottest", label: "Hottest CPU" },
                        { value: "custom", label: "Custom" },
                      ]}
                      value={chartMode}
                      onChange={(v) => setChartMode(v as "hottest" | "custom")}
                    />

                    {chartMode === "hottest" && (
                      <div className="mt-3">
                        <div className="mb-2 flex items-center justify-between">
                          <span className="eyebrow text-faint">Top 3 active ({activeChartServers.length}/3)</span>
                          {hiddenHottestIds.length > 0 && (
                            <button
                              onClick={() => setHiddenHottestIds([])}
                              className="eyebrow touch-hit text-primary transition-opacity duration-150 hover:opacity-80"
                            >
                              Reset view
                            </button>
                          )}
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {activeChartServers.length === 0 && (
                            <span className="text-[12px] text-muted-foreground">No visible servers.</span>
                          )}
                          {activeChartServers.map(srv => {
                            const isOnlyOne = activeChartServers.length === 1;
                            return (
                              <button
                                key={srv.id}
                                disabled={isOnlyOne}
                                onClick={() => setHiddenHottestIds(prev => [...prev, srv.id])}
                                className={cn(
                                  "touch-hit flex max-w-full items-center gap-1.5 rounded-sm px-2 py-1 text-[11px] font-semibold transition-colors duration-150",
                                  isOnlyOne
                                    ? "cursor-default bg-primary/8 text-primary/70"
                                    : "bg-primary/10 text-primary hover:bg-danger/10 hover:text-danger"
                                )}
                              >
                                <span className="max-w-[120px] truncate" title={srv.label}>{srv.label}</span>
                                {!isOnlyOne && <X size={14} strokeWidth={1.75} className="shrink-0" />}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {chartMode === "custom" && (
                      <div className="mt-3">
                        <div className="mb-2 flex items-center justify-between">
                          <span className="eyebrow text-faint">Selected ({customServerIds.length}/3)</span>
                          {customServerIds.length > 0 && (
                            <button
                              onClick={() => setCustomServerIds([])}
                              className="eyebrow touch-hit whitespace-nowrap text-danger transition-opacity duration-150 hover:opacity-80"
                            >
                              Clear all
                            </button>
                          )}
                        </div>
                        <div className="flex flex-wrap gap-1.5 border-b border-border pb-3">
                          {customServerIds.length === 0 && (
                            <span className="text-[12px] text-muted-foreground">No servers selected.</span>
                          )}
                          {customServerIds.map(selectedId => {
                            const srv = liveServers.find(s => s.id === selectedId);
                            if (!srv) return null;
                            return (
                              <button
                                key={selectedId}
                                onClick={() => setCustomServerIds(prev => prev.filter(id => id !== selectedId))}
                                className="touch-hit flex max-w-full items-center gap-1.5 rounded-sm bg-primary/10 px-2 py-1 text-[11px] font-semibold text-primary transition-colors duration-150 hover:bg-danger/10 hover:text-danger"
                              >
                                <span className="max-w-[120px] truncate" title={srv.label}>{srv.label}</span>
                                <X size={14} strokeWidth={1.75} className="shrink-0" />
                              </button>
                            );
                          })}
                        </div>

                        <div className="mt-2 max-h-[180px] space-y-0.5 overflow-y-auto pr-1">
                          {liveServers.map(server => {
                            const isSelected = customServerIds.includes(server.id);
                            if (isSelected) return null;

                            return (
                              <button
                                key={server.id}
                                onClick={() => {
                                  if (customServerIds.length < 3) {
                                    setCustomServerIds(prev => [...prev, server.id]);
                                  }
                                }}
                                disabled={customServerIds.length >= 3}
                                className="group touch-hit flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-[12px] font-medium transition-colors duration-150 hover:bg-panel-2 disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                <span className="truncate pr-2" title={server.label}>{server.label}</span>
                                <Plus size={14} strokeWidth={1.75} className="shrink-0 text-faint transition-colors duration-150 group-hover:text-primary" />
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </Panel>
                )}
              </div>
            </div>
          </div>

          {/* Chart */}
          <div className="relative mt-5">
            {telemetryError && telemetryData.length === 0 && (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
                <span className="font-mono text-[11px] text-muted-foreground">
                  Telemetry query failed — check console
                </span>
              </div>
            )}
            {statsKnown && !telemetryError && telemetryData.length === 0 && (
              <div className="absolute inset-0 z-10 flex items-center justify-center px-6">
                <p className="max-w-[360px] text-pretty text-center text-[12.5px] leading-relaxed text-muted-foreground">
                  {tie(`${noReportsLine} Each server's agent reports it every 10 minutes.`)}{" "}
                  <Link href="/settings/setup" className="text-primary underline-offset-4 hover:underline">See what is set up</Link>
                </p>
              </div>
            )}
            <div className="w-full min-w-0">
              <div className="h-[300px] w-full">
                {/* A positive first size: recharts' default (-1 × -1) logs a size warning on
                    every load before it measures the box. 1px wide draws nothing for that frame. */}
                {mounted && (
                  <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 1, height: 300 }}>
                    <LineChart data={telemetryData} margin={{ top: 10, right: isSmUp ? 96 : 12, left: 0, bottom: 0 }}>
                      <CartesianGrid vertical={false} stroke="var(--border)" />
                      <Tooltip
                        content={<InkTooltip formatLabel={formatTime} />}
                        cursor={{ stroke: "var(--line-strong)", strokeWidth: 1 }}
                        animationDuration={100}
                      />
                      <XAxis
                        dataKey="time"
                        axisLine={false}
                        tickLine={false}
                        tick={{ fill: "var(--faint)", fontSize: 9, fontFamily: "var(--font-mono)" }}
                        dy={8}
                        tickFormatter={formatTime}
                        minTickGap={28}
                      />
                      <YAxis
                        width={34}
                        axisLine={false}
                        tickLine={false}
                        tick={{ fill: "var(--faint)", fontSize: 9, fontFamily: "var(--font-mono)" }}
                        tickFormatter={(val) => `${val}%`}
                        domain={[0, 100]}
                      />
                      {activeChartServers.map(server => (
                        <Line
                          key={server.id}
                          connectNulls={true}
                          isAnimationActive={false}
                          type="monotone"
                          dataKey={server.dataKey}
                          name={server.label}
                          stroke={server.color}
                          strokeWidth={2}
                          dot={false}
                          activeDot={{ r: 3, strokeWidth: 0, fill: server.color }}
                          label={
                            isSmUp
                              ? (labelProps) =>
                                  renderEndLabel(
                                    labelProps as EndLabelProps,
                                    truncateSeriesName(server.label),
                                    server.color,
                                    lastPointIndex,
                                    endLabelOffsets[server.dataKey] ?? 0
                                  )
                              : false
                          }
                        />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>
          </div>

          {/* Chart foot — legend + source line */}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-3">
            {activeChartServers.map(server => (
              <span key={server.id} className="flex items-center gap-1.5 text-[11.5px] font-medium text-muted-foreground">
                <span
                  className="h-[3px] w-[14px] shrink-0 rounded-sm"
                  style={{ backgroundColor: server.color }}
                />
                <span className="max-w-[140px] truncate" title={server.label}>{server.label}</span>
              </span>
            ))}
            <span className="eyebrow ml-auto inline-flex min-h-[17.25px] items-center text-faint">Source: edge telemetry agents ·{"\u00a0"}AGENT_V1</span>
          </div>
        </div>

        {/* ── RIGHT RAIL ──────────────────────────────────────────── */}
        <div className="mt-10 lg:mt-0 lg:pl-6">
          {/* (1) System health */}
          <section>
            <PanelHeader title="System health">
              <Link href="/servers" className="eyebrow touch-hit text-faint transition-colors duration-150 hover:text-foreground">
                12h detail
              </Link>
            </PanelHeader>
            <div className="mt-4 flex items-center gap-4">
              <svg
                viewBox="0 0 100 100"
                className="h-[116px] w-[116px] shrink-0"
                role="img"
                aria-label={healthStatus === "No reports" ? "System health: no server has reported its load" : `System health ${Math.round(healthRingValue)} percent — ${healthStatus}`}
              >
                {/* Hairline compass ticks */}
                <line x1="50" y1="0" x2="50" y2="4" stroke="var(--line-strong)" strokeWidth="1.5" />
                <line x1="50" y1="96" x2="50" y2="100" stroke="var(--line-strong)" strokeWidth="1.5" />
                <line x1="0" y1="50" x2="4" y2="50" stroke="var(--line-strong)" strokeWidth="1.5" />
                <line x1="96" y1="50" x2="100" y2="50" stroke="var(--line-strong)" strokeWidth="1.5" />
                {/* Full 360° ring — exact strokeDasharray geometry preserved */}
                <g transform="rotate(-90 50 50)">
                  <circle cx="50" cy="50" r="42" fill="none" stroke="var(--border)" strokeWidth="6" />
                  <circle
                    cx="50"
                    cy="50"
                    r="42"
                    fill="none"
                    stroke={ringColor}
                    strokeWidth="6"
                    strokeDasharray="264"
                    strokeDashoffset={264 - (264 * healthRingValue) / 100}
                    strokeLinecap="round"
                    className="transition-all duration-300 ease-in-out"
                  />
                </g>
                <text
                  x="50"
                  y="52"
                  textAnchor="middle"
                  fontSize="15"
                  fontWeight="700"
                  fill="var(--foreground)"
                  style={{ fontFamily: "var(--font-sans)", fontVariantNumeric: "tabular-nums" }}
                >
                  {healthStatus === "No reports" ? "–" : `${Math.round(healthRingValue)}%`}
                </text>
                <text
                  x="50"
                  y="64"
                  textAnchor="middle"
                  fontSize="6"
                  fill={ringColor}
                  style={{ fontFamily: "var(--font-mono)", letterSpacing: "0.18em" }}
                >
                  {healthStatus.toUpperCase()}
                </text>
              </svg>
              <div className="min-w-0">
                <div className="text-[13px] font-bold">
                  Status: <span className={statusTextClass}>{healthStatus}</span>
                </div>
                <p className="mt-1 min-h-[3lh] text-pretty text-[12px] leading-relaxed text-muted-foreground">
                  {healthStatus === "Optimal" && tie(`Average CPU load under 40% over the last ${timeRange.toLowerCase()}.`)}
                  {healthStatus === "Elevated" && tie(`Average CPU load between 40-70% over the last ${timeRange.toLowerCase()}.`)}
                  {healthStatus === "Critical" && tie(`Average CPU load exceeded 70% over the last ${timeRange.toLowerCase()}.`)}
                  {healthStatus === "No reports" && (
                    <>
                      {tie(`${noReportsLine} Each server's agent reports it.`)}{" "}
                      <Link href="/settings/setup" className="text-primary underline-offset-4 hover:underline">See what is set up</Link>
                    </>
                  )}
                </p>
              </div>
            </div>
          </section>

          {/* (2) Hottest nodes */}
          <section className="mt-7">
            <PanelHeader title="Hottest nodes" />
            <div>
              {hottestNodes.length === 0 && !statsKnown ? (
                // The same boxes as a row, so the rail does not grow when the readings arrive.
                Array.from({ length: 4 }, (_, i) => (
                  <div key={i} aria-hidden="true" className="flex items-center gap-3 border-b border-border py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center text-[12.5px] font-semibold">
                        <span className="h-[10px] w-28 animate-pulse rounded-sm bg-panel-2" />&#8203;
                      </div>
                      <div className="flex items-center font-mono text-[10.5px]">
                        <span className="h-[8px] w-20 animate-pulse rounded-sm bg-panel-2" />&#8203;
                      </div>
                    </div>
                    <span className="h-[8px] w-[64px] shrink-0 animate-pulse rounded-sm bg-panel-2" />
                    <span className="w-[44px] shrink-0" />
                  </div>
                ))
              ) : hottestNodes.length === 0 ? (
                <p className="py-3 text-[12px] text-muted-foreground">Nothing to rank: no server has reported its load.</p>
              ) : (
                hottestNodes.map(node => (
                  <Link
                    key={node.id}
                    href={`/servers/${node.id}`}
                    className="group flex items-center gap-3 border-b border-border py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12.5px] font-semibold transition-colors duration-150 group-hover:text-primary">
                        {node.label}
                      </div>
                      <div className="font-mono text-[10.5px] text-faint">
                        {node.ip ?? "not synced yet"}
                      </div>
                    </div>
                    <Meter value={node.cpu} metric="cpu" className="w-[64px] shrink-0" />
                    <span className="w-[44px] shrink-0 text-right font-mono text-[11.5px] tabular-nums">
                      {node.cpu.toFixed(1)}%
                    </span>
                  </Link>
                ))
              )}
            </div>
          </section>

          {/* (3) Advisory — the shared callout under a rulehead. Its height is held,
              so the rail does not jump when the schedules have been read. */}
          <section className="mt-7">
            <PanelHeader title="Advisory" meta="Backups" />
            <Callout
              dense
              live
              data-advisory={!overlapsKnown ? "loading" : overlappingScheduleCount > 0 ? "overlaps" : "clear"}
              className="mt-3.5 min-h-[76px]"
              tone={!overlapsKnown ? "note" : overlappingScheduleCount > 0 ? "warning" : "success"}
              title={
                !overlapsKnown ? (
                  "Reading backup schedules"
                ) : overlappingScheduleCount > 0 ? (
                  <>
                    {overlappingScheduleCount}{" "}
                    {overlappingScheduleCount === 1 ? "backup schedule overlaps" : "backup schedules overlap"}
                  </>
                ) : (
                  "No backup overlaps"
                )
              }
            >
              {!overlapsKnown ? (
                <span aria-hidden="true" className="mt-1.5 block h-[9px] w-40 animate-pulse rounded-sm bg-line-strong" />
              ) : overlappingScheduleCount > 0 ? (
                <>
                  Schedules run in the same slot. Reschedule to spread the load.{" "}
                  <Link href="/backups/schedules?conflict=true" className="touch-hit font-semibold text-foreground underline underline-offset-2">
                    Resolve in Schedules
                  </Link>
                </>
              ) : (
                "No overlapping backup schedules detected across active routines."
              )}
            </Callout>
          </section>

          {/* (4) The wire */}
          <section className="mt-7">
            <PanelHeader title="The wire">
              {recentLogs.length > 0 && (
                <button
                  onClick={askToClearLogs}
                  className="eyebrow touch-hit whitespace-nowrap text-muted-foreground transition-colors duration-150 hover:text-danger"
                >
                  Clear…
                </button>
              )}
              <button
                onClick={() => document.getElementById("global-notif-bell")?.click()}
                className="eyebrow touch-hit whitespace-nowrap text-faint transition-colors duration-150 hover:text-foreground"
              >
                All entries
              </button>
            </PanelHeader>
            <div>
              {recentLogs.length === 0 && !logsKnown ? (
                Array.from({ length: 5 }, (_, i) => (
                  <div key={i} aria-hidden="true" className="grid grid-cols-[44px_1fr] gap-x-2 border-b border-border py-2.5">
                    <span className="pt-[2px] font-mono text-[10.5px]">&#8203;</span>
                    <div className="min-w-0">
                      <div className="flex items-center text-[12.5px] font-bold">
                        <span className="h-[10px] w-36 animate-pulse rounded-sm bg-panel-2" />&#8203;
                      </div>
                      <p className="mt-0.5 flex items-center text-[11.5px]">
                        <span className="h-[8px] w-48 max-w-full animate-pulse rounded-sm bg-panel-2" />&#8203;
                      </p>
                    </div>
                  </div>
                ))
              ) : recentLogs.length === 0 ? (
                <EmptyState className="py-6" title="No entries" hint="System events appear here." />
              ) : (
                recentLogs.map(log => (
                  <div key={log.id} className="grid grid-cols-[44px_1fr] gap-x-2 border-b border-border py-2.5">
                    <span className="pt-[2px] font-mono text-[10.5px] text-faint tabular-nums">
                      {new Date(log.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
                    </span>
                    <div className="min-w-0">
                      <div className={cn("flex items-center gap-1.5 text-[12.5px] font-bold", isOpenProblem(log) && (log.level === "error" ? "text-danger" : "text-warning"))}>
                        {isProblem(log) && <XCircle size={14} strokeWidth={1.75} className="shrink-0" />}
                        <span className="truncate">{logTitle(log)}</span>
                      </div>
                      <p className="mt-0.5 line-clamp-1 text-[11.5px] text-muted-foreground">{logBody(log)}</p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </section>

      <ConfirmDialog
        open={clearQuestionCounts !== null}
        onClose={() => setClearQuestionCounts(null)}
        title={clearWording?.title ?? ""}
        confirmLabel={clearWording?.confirm ?? ""}
        onConfirm={clearRecentLogs}
      >
        {clearWording?.body}
      </ConfirmDialog>
    </div>
  );
}
