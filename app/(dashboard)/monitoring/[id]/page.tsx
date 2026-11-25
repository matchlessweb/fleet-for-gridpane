"use client";

import { use, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/database.types";
import { Server as ServerIcon } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { Copyable, DetailHeader, StatusPill, buttonClasses } from "@/components/ui";

type TelemetryRow = Database["public"]["Tables"]["server_telemetry"]["Row"];

export default function MonitoringPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params);
  const serverId = parseInt(resolvedParams.id);

  const [topOutput, setTopOutput] = useState<string | null>(null);
  const [serverTimestamp, setServerTimestamp] = useState<string | null>(null);
  // Loading until the newest snapshot for THIS server has been read.
  const [loadedFor, setLoadedFor] = useState<number | null>(null);
  const isLoading = !Object.is(loadedFor, serverId);
  const [isLiveAgent, setIsLiveAgent] = useState(false);
  const [isFlashing, setIsFlashing] = useState(false);
  const [serverInfo, setServerInfo] = useState<{ label: string, ip: string } | null>(null);

  const supabase = createClient();

  const renderHighlightedOutput = (text: string | null) => {
    if (!text) return null;
    const lines = text.split('\n');
    let inProcessList = false;

    return lines.map((line, i) => {
      if (line.includes("PID USER") && line.includes("%CPU")) {
        inProcessList = true;
        const match = line.match(/^(.*?\bS\s+)(%CPU)(.*)$/);
        if (match) {
          return (
            <div key={i} className="whitespace-pre text-on-sunken-dim">
              {match[1]}<span className="font-bold text-primary">{match[2]}</span>{match[3]}
            </div>
          );
        }
      }
      if (inProcessList && line.trim().match(/^\d+/)) {
        const match = line.match(/^(\s*\d+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+)(\S+)(.*)$/);
        if (match && parseFloat(match[2]) >= 0) {
          const isHigh = parseFloat(match[2]) >= 2.0;
          return (
            <div key={i} className="whitespace-pre">
              {match[1]}<span className={cn("font-bold tracking-tight", isHigh ? "text-warning" : "text-primary")}>{match[2]}</span>{match[3]}
            </div>
          );
        }
      }
      return <div key={i} className="whitespace-pre">{line || " "}</div>;
    });
  };

  useEffect(() => {
    supabase.from("servers").select("label, ip").eq("id", serverId).single().then(({ data, error }) => {
      if (error && error.code !== "PGRST116") console.error("Server info fetch failed", error);
      if (data) setServerInfo(data);
    });

    // The newest snapshot. Nothing is set before the database answers.
    void (async () => {
      const { data, error } = await supabase
        .from("server_telemetry")
        .select("top_processes_b64, timestamp")
        .eq("server_id", serverId)
        .order("timestamp", { ascending: false })
        .limit(1)
        .single();

      if (error && error.code !== "PGRST116") console.error("Telemetry fetch failed", error);

      if (data?.top_processes_b64) {
        try {
          const isLiveStr = data.top_processes_b64.includes("|AGENT_V1");
          const cleanB64 = data.top_processes_b64.replace(/\|AGENT_V1$/, "");
          const decoded = atob(cleanB64);
          setTopOutput(decoded);

          if (data.timestamp) {
            const ageInSeconds = (Date.now() - new Date(data.timestamp).getTime()) / 1000;
            setIsLiveAgent(isLiveStr && ageInSeconds < 900);
          }
        } catch {
          setTopOutput("Error: Failed to decode UTF-8 terminal snapshot.");
        }
      } else {
        setTopOutput("No active process snapshots found for this node. Ensure the telemetry agent is running.");
      }

      if (data?.timestamp) {
        const formatted = new Intl.DateTimeFormat('en-US', {
          month: 'numeric', day: 'numeric', year: '2-digit',
          hour: 'numeric', minute: '2-digit', second: '2-digit'
        }).format(new Date(data.timestamp));
        setServerTimestamp(formatted);
      }

      setLoadedFor(serverId);
    })();

    const channel = supabase.channel(`htop-telemetry-${serverId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "server_telemetry",
          filter: `server_id=eq.${serverId}`
        },
        (payload) => {
          const newRow = payload.new as TelemetryRow;
          if (newRow.top_processes_b64) {
            try {
              const isLiveStr = newRow.top_processes_b64.includes("|AGENT_V1");
              const cleanB64 = newRow.top_processes_b64.replace(/\|AGENT_V1$/, "");
              setTopOutput(atob(cleanB64));
              setIsLiveAgent(isLiveStr);
            } catch {
              // Ignore silent parsing faults on active streams
            }
          }
          if (newRow.timestamp) {
            const formatted = new Intl.DateTimeFormat('en-US', {
              month: 'numeric', day: 'numeric', year: '2-digit',
              hour: 'numeric', minute: '2-digit', second: '2-digit'
            }).format(new Date(newRow.timestamp));
            setServerTimestamp(formatted);
            setIsFlashing(true);
            setTimeout(() => setIsFlashing(false), 2000);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [serverId, supabase]);

  const hostSlug = serverInfo?.label?.toLowerCase().replace(/\s+/g, '-') || serverId;

  return (
    <div className="flex h-[calc(100dvh-10rem)] max-h-[800px] flex-col">
      <DetailHeader
        className="mb-6"
        phoneFactLines={2}
        // The name is held until the server is known; a server that is not on record falls back to its number.
        title={serverInfo?.label || (isLoading ? null : `Node ${serverId}`)}
        status={isLiveAgent ? <StatusPill tone="live">Live agent</StatusPill> : undefined}
        // Held as one block until the server is known: its IP adds a line on a phone.
        facts={isLoading && !serverInfo ? null : [
          "Process snapshot",
          serverInfo?.ip && <Copyable value={serverInfo.ip} what="IP address" />,
          <>
            Captured{" "}
            <span className={cn("transition-colors duration-500", isFlashing && "text-primary")}>{serverTimestamp || "no report yet"}</span>
          </>,
        ]}
        actions={
          <Link href={`/servers/${serverId}`} className={buttonClasses({ className: "touch-hit" })}>
            <ServerIcon size={14} strokeWidth={1.75} /> Server details
          </Link>
        }
      />

      {/* Terminal well — ink-dark in both themes */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg bg-sunken font-mono">
        <div className="flex shrink-0 flex-wrap items-baseline justify-between gap-2 px-5 pb-2 pt-4">
          <span className="eyebrow text-faint">
            root@{hostSlug} — top
          </span>
          <span className="text-[10.5px] text-on-sunken-dim">
            snapshot, not live — taken with the CPU reading every 10 min
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 pb-5">
          {isLoading ? (
            <div className="flex h-full items-center justify-center">
              <span className="font-mono text-[12px] text-on-sunken-dim">
                Loading last snapshot…
              </span>
            </div>
          ) : (
            <pre className="max-w-none font-mono text-xs leading-relaxed text-on-sunken sm:text-[13px]">
              {renderHighlightedOutput(topOutput)}
            </pre>
          )}
        </div>
      </div>

      <p className="mt-4 text-pretty text-center text-[12px] text-muted-foreground">
        Snapshot from the last agent payload — refresh to request a new{"\u00a0"}one.
      </p>
    </div>
  );
}
