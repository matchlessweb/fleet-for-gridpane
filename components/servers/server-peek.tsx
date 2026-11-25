"use client";

import * as React from "react";
import Link from "next/link";
import { getProviderName } from "@/lib/utils";
import { NOT_SYNCED_LABEL, PENDING_LABEL, providerCaption, resolveCores, resolveProvider, resolveRam, type ServerHardware } from "@/lib/server-specs";
import { formatOsVersion } from "@/lib/os-version";
import { formatRelativeTime } from "@/lib/relative-time";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/database.types";
import { Field, Peek, PeekMeter, PeekSection, Skeleton, StatusPill } from "@/components/ui";
import { CacheFlagPill, type CacheFlag } from "@/components/performance/opcache-status";

type Server = Database["public"]["Tables"]["servers"]["Row"];

export type ServerReading = {
  cpu: number;
  ram: number;
  disk_usage?: number;
  disk_total_gb?: number;
  disk_www_mb?: number;
  disk_mysql_mb?: number;
  disk_backups_mb?: number;
  isReal?: boolean;
  lastUpdated?: string;
};

type PeekSite = { id: number; url: string; is_wsod: boolean | null };

const SITES_SHOWN = 6;
const gb = (mb?: number) => (mb ? `${(mb / 1024).toFixed(1)} GB` : PENDING_LABEL);

const ghostLink =
  "touch-hit inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-line-strong bg-panel px-4 py-2 text-[12.5px] font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground";
const solidLink =
  "touch-hit inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-primary px-4 py-2 text-[12.5px] font-semibold text-primary-foreground transition-colors duration-150 hover:opacity-90";

/**
 * ServerPeek — one server at a glance, from the server list. Readings and
 * specs come from the list that is already loaded; the server's sites are
 * read when the panel opens. A reading the fleet never sent says so.
 */
export function ServerPeek({
  server,
  reading,
  hardware,
  cacheFlag,
  onClose,
  onPrev,
  onNext,
  position,
}: {
  server: Server | null;
  reading: ServerReading | undefined;
  hardware: ServerHardware | undefined;
  cacheFlag: CacheFlag | undefined;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  position?: string;
}) {
  const supabase = createClient();
  const serverId = server?.id ?? null;
  const [sites, setSites] = React.useState<{ serverId: number; rows: PeekSite[] | null; failed: boolean } | null>(null);

  React.useEffect(() => {
    if (serverId === null) return;
    let stale = false;
    supabase
      .from("sites")
      .select("id, url, is_wsod")
      .eq("server_id", serverId)
      .order("url", { ascending: true })
      .then(({ data, error }) => {
        if (stale) return;
        setSites({ serverId, rows: error ? null : ((data as PeekSite[] | null) ?? []), failed: !!error });
      });
    return () => {
      stale = true;
    };
  }, [serverId, supabase]);

  if (!server) return <Peek open={false} onClose={onClose} kind="" title="">{null}</Peek>;

  const cores = resolveCores(server, hardware);
  const ram = resolveRam(server, hardware);
  const provider = resolveProvider(getProviderName(server.provider_id, server.provider), hardware);
  const mine = sites && sites.serverId === server.id ? sites : null;
  const rows = mine?.rows ?? null;

  return (
    <Peek
      open
      onClose={onClose}
      kind="Server"
      kindDetail={`node ${server.id}`}
      title={server.label}
      subtitle={server.ip}
      status={<StatusPill tone={server.status === "active" ? "ok" : "danger"}>{server.status || "offline"}</StatusPill>}
      onPrev={onPrev}
      onNext={onNext}
      position={position}
      actions={
        <>
          <Link href={`/monitoring/${server.id}`} className={ghostLink}>
            Live telemetry
          </Link>
          <Link href={`/servers/${server.id}`} className={solidLink}>
            Open server
          </Link>
        </>
      }
    >
      <PeekSection>
        <PeekMeter label="CPU" value={reading ? reading.cpu : null} metric="cpu" />
        <PeekMeter label="RAM" value={reading ? reading.ram : null} metric="memory" />
        <PeekMeter
          label="Disk"
          value={reading && typeof reading.disk_usage === "number" ? reading.disk_usage : null}
          metric="disk"
          detail={reading?.disk_total_gb ? `${reading.disk_total_gb} GB` : undefined}
        />
        <div className="mt-1 flex items-center justify-between gap-3">
          <StatusPill tone={reading?.isReal ? "live" : "neutral"}>{reading?.isReal ? "Live agent" : "No live agent"}</StatusPill>
          <span className="font-mono text-[10.5px] text-muted-foreground">updated {formatRelativeTime(reading?.lastUpdated)}</span>
        </div>
      </PeekSection>

      <PeekSection title="Server">
        <Field label="Cores">
          <span className="font-mono text-[11px] tabular-nums" title={cores.exact}>
            {cores.text ?? PENDING_LABEL}
          </span>
        </Field>
        <Field label="RAM">
          <span className="font-mono text-[11px] tabular-nums" title={ram.exact}>
            {ram.text ?? PENDING_LABEL}
          </span>
        </Field>
        <Field label="OS">
          <span className="font-mono text-[11px]" title={server.os_version || undefined}>
            {formatOsVersion(server.os_version) ?? NOT_SYNCED_LABEL}
          </span>
        </Field>
        <Field label="Region">
          <span className="font-mono text-[11px]">{server.region_label || NOT_SYNCED_LABEL}</span>
        </Field>
        <Field label="Provider">
          <span className="flex items-center gap-1.5" title={providerCaption(provider, hardware)}>
            <span className="font-mono text-[11px]">{provider.label}</span>
            {provider.managedAs && <StatusPill tone="neutral">{provider.managedAs}</StatusPill>}
          </span>
        </Field>
        {cacheFlag && (
          <Field label="Code cache">
            <CacheFlagPill flag={cacheFlag} />
          </Field>
        )}
      </PeekSection>

      <PeekSection title="Disk use">
        <Field label="Sites">
          <span className="font-mono text-[11px] tabular-nums">{gb(reading?.disk_www_mb)}</span>
        </Field>
        <Field label="Databases">
          <span className="font-mono text-[11px] tabular-nums">{gb(reading?.disk_mysql_mb)}</span>
        </Field>
        <Field label="Backups">
          <span className="font-mono text-[11px] tabular-nums">{gb(reading?.disk_backups_mb)}</span>
        </Field>
      </PeekSection>

      <PeekSection title="Sites" meta={rows ? String(rows.length) : undefined}>
        {mine === null ? (
          <div aria-busy="true" className="flex flex-col gap-2 py-1.5">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-3/5" />
          </div>
        ) : mine.failed || rows === null ? (
          <p className="py-1.5 text-[12px] text-muted-foreground">The site list could not be read.</p>
        ) : rows.length === 0 ? (
          <p className="py-1.5 text-[12px] text-muted-foreground">No sites on this server.</p>
        ) : (
          <ul>
            {rows.slice(0, SITES_SHOWN).map((site) => (
              <li key={site.id} className="flex items-center justify-between gap-3 border-b border-border py-1.5 last:border-0">
                <Link href={`/sites/${site.id}`} className="min-w-0 truncate text-[12.5px] font-medium transition-colors duration-150 hover:text-primary">
                  {site.url}
                </Link>
                {site.is_wsod && <StatusPill tone="danger">Error</StatusPill>}
              </li>
            ))}
            {rows.length > SITES_SHOWN && (
              <li className="py-1.5">
                <Link href={`/servers/${server.id}`} className="eyebrow text-muted-foreground transition-colors duration-150 hover:text-foreground">
                  {rows.length - SITES_SHOWN} more on the server page
                </Link>
              </li>
            )}
          </ul>
        )}
      </PeekSection>
    </Peek>
  );
}
