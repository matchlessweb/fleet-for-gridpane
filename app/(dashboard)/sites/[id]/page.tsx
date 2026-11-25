"use client";

import { use, useEffect, useState, useMemo } from "react";
import { notFound } from "next/navigation";
import { Settings, PlaySquare, Loader2, ShieldBan, ShieldCheck, ShieldPlus, Check } from "lucide-react";
import Link from "next/link";
import { cn, getProviderName } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { WafWhitelistGenerator } from "@/components/waf/waf-whitelist-generator";
import { SiteLinkButtons } from "@/components/sites/site-links";
import { SsoSiteRow } from "@/components/sso/sso-controls";
import { StagingLedger } from "@/components/sites/staging-ledger";
import { IpBlockManager } from "@/components/security/ip-block-manager";
import { IpAllowlistManager } from "@/components/security/ip-allowlist-manager";
import { FirewallPanel } from "@/components/security/firewall-panel";
import { SiteFail2BanSection } from "@/components/security/fail2ban-status";
import { SiteWafSection } from "@/components/security/waf-status";
import { SiteOpcacheRow } from "@/components/performance/opcache-status";
import { SiteCachingSection } from "@/components/sites/site-caching";
import { cachingColumns, cachingFromRow } from "@/lib/site-caching";
import { SiteZoneSection } from "@/components/cloudflare/zone-posture";
import { ProxyStatus, useHostProxy } from "@/components/cloudflare/proxy-status";
import { tie } from "@/lib/cloudflare-waf";
import { Database } from "@/lib/database.types";
import { toast } from "sonner";
import {
  Button,
  Callout,
  Copyable,
  DetailHeader,
  IconButton,
  EmptyState,
  Input,
  Modal,
  PanelHeader,
  Select,
  StatusPill,
  buttonClasses,
} from "@/components/ui";
import { phpVersionOptions } from "@/lib/php-versions";
import { readSiteParam } from "@/lib/site-row-id";

// The three caching columns come from a migration after the baseline
// (supabase/migrations/20261123000000_site_caching.sql), so the generated types,
// which follow the baseline snapshot, do not list them.
type Site = Database["public"]["Tables"]["sites"]["Row"] & {
  nginx_caching_ttl?: number | null;
  object_caching?: boolean | null;
  object_cache_pro?: boolean | null;
};
type ServerType = Database["public"]["Tables"]["servers"]["Row"];


// A value this app can show but GridPane's API will not let it change.
function SlowlogValue({ label, value, unit = "" }: { label: string; value: number | null | undefined; unit?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border py-2">
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground" title={label}>{label}</span>
      <span className="shrink-0 font-mono text-[12px]">{value == null ? "—" : `${value}${unit}`}</span>
    </div>
  );
}

function PhpMetricInput({ label, metricKey, value, onUpdate, type = "number", unit = "" }: {
  label: string;
  metricKey: keyof Site;
  value: number | string | null | undefined;
  onUpdate: (key: keyof Site, value: number | string) => Promise<void> | void;
  type?: string;
  unit?: string;
}) {
  const [val, setVal] = useState<string | number>(value || "");
  const [isSaving, setIsSaving] = useState(false);

  // A new value from above (a save, a sync) replaces what is typed. Done while rendering.
  const [seen, setSeen] = useState(value);
  if (!Object.is(seen, value)) {
    setSeen(value);
    setVal(value || "");
  }

  const isDirtyValue = String(val) !== String(value || "");
  const isDirty = isDirtyValue || isSaving;

  const handleSave = async () => {
    if (!isDirty) return;
    setIsSaving(true);
    await onUpdate(metricKey, type === "number" ? Number(val) : val);
    setIsSaving(false);
  };

  const handleIncrement = (amount: number) => {
    if (type !== "number") return;
    const current = Number(val) || 0;
    setVal(current + amount);
  };

  return (
    <div className="flex items-center justify-between gap-3 border-b border-border py-2">
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground" title={label}>{label}</span>
      <div className="flex shrink-0 items-center gap-1.5">
        {isDirty && (
          <IconButton
            label="Save changes"
            disabled={isSaving}
            onClick={handleSave}
            className="anim-fade h-[27px] w-[27px] border-primary/40 text-primary hover:text-primary"
          >
            {isSaving ? <Loader2 size={14} strokeWidth={1.75} className="animate-spin" /> : <Check size={14} strokeWidth={1.75} />}
          </IconButton>
        )}
        <Input
          type={type === "number" ? "text" : type}
          inputMode={type === "number" ? "numeric" : "text"}
          value={val}
          onChange={(e) => {
            if (type === "number" && e.target.value !== "" && !/^-?\d+$/.test(e.target.value)) return;
            setVal(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSave();
            if (e.key === "ArrowUp") { e.preventDefault(); handleIncrement(1); }
            if (e.key === "ArrowDown") { e.preventDefault(); handleIncrement(-1); }
          }}
          aria-label={label}
          className={cn(
            "w-20 px-2 py-[5px] text-right font-mono text-[12px] tabular-nums",
            isDirty && "border-warning/60"
          )}
        />
        <span className="eyebrow w-3 shrink-0 text-faint">{unit}</span>
      </div>
    </div>
  );
}

export default function SiteDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const resolvedParams = use(params);
  // A negative id is the staging copy of that live site; see lib/site-row-id.ts.
  const siteParam = readSiteParam(resolvedParams.id);
  const isStaging = siteParam?.staging ?? false;
  const siteId = siteParam?.siteId ?? null;

  const [siteData, setSiteData] = useState<Site | null>(null);
  const [server, setServer] = useState<ServerType | null>(null);
  const [backupSchedules, setBackupSchedules] = useState<Database["public"]["Tables"]["backup_schedules"]["Row"][]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const [configOpen, setConfigOpen] = useState(false);
  const [nickname, setNickname] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isWafGeneratorOpen, setIsWafGeneratorOpen] = useState(false);
  const [isIpBlockOpen, setIsIpBlockOpen] = useState(false);
  const [isIpAllowOpen, setIsIpAllowOpen] = useState(false);
  /** Bumped when a generator records something, so the panel refetches. */
  const [firewallKey, setFirewallKey] = useState(0);

  const supabase = useMemo(() => createClient(), []);

  useEffect(() => {
    const fetchSiteDetails = async () => {
      setIsLoading(true);
      // Not an id at all: there is nothing to look up.
      if (siteId === null) { setIsLoading(false); return; }

      const { data: site } = await supabase
        .from("sites")
        .select("*")
        .eq("id", siteId)
        .single();

        if (site) {
          if (isStaging && !site.staging_site_built_at) {
             // Abort if attempting to hit staging on a site without one registered
             setIsLoading(false);
             return;
          }
          if (isStaging) {
             site.url = `staging.${site.url}`;
          }
          setSiteData(site);
          setNickname(isStaging ? `${site.site_nickname || "Unassigned Identity"} (Staging)` : site.site_nickname || "");

          if (site.server_id) {
          const { data: srv } = await supabase
            .from("servers")
            .select("*")
            .eq("id", site.server_id)
            .single();
          if (srv) setServer(srv);
        }

        const { data: bSchedules } = await supabase
          .from("backup_schedules")
          .select("*")
          .eq("site_id", siteId);

        if (bSchedules) setBackupSchedules(bSchedules);
      }
      setIsLoading(false);
    };

    fetchSiteDetails();
    // A live site and its staging copy share siteId: going from one to the other must load again.
  }, [siteId, isStaging, supabase]);

  // Proxy status comes from the Cloudflare inventory, not from a typed field.
  const proxy = useHostProxy(siteData?.url);
  const isProxied = proxy?.state === "proxied";

  if (isLoading) return <SiteDetailLoading staging={isStaging} />;

  if (!siteData) {
    notFound();
  }

  // Every save on this page targets siteData.id, which is the PRODUCTION site
  // id even when a staging row is being viewed: the list gives a staging row
  // its live site's id made negative, and this page reads it back. GridPane's
  // OAuth API exposes no staging environment to write to either — /site?type=
  // staging returns nothing, /oauth/api/v1/staging is a 404, and the per-site
  // staging route answers 422 because it authenticates on dashboard cookies.
  // So a save made while looking at staging would silently reconfigure the live
  // site. Refuse it rather than write to the wrong target.
  const STAGING_READ_ONLY =
    "Staging is read-only here. GridPane's API exposes no staging environment to write to, and saving would change the live site instead.";

  const blockedOnStaging = () => {
    if (!isStaging) return false;
    toast.error(STAGING_READ_ONLY);
    return true;
  };

  const handleSaveConfig = async () => {
    if (blockedOnStaging()) return;
    setIsSaving(true);

    try {
      const res = await fetch(`/api/sites/${siteData.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ site_nickname: nickname })
      });

      if (res.ok) {
        setSiteData({ ...siteData, site_nickname: nickname });
        setConfigOpen(false);
        toast.success("Site configuration saved successfully.");
      } else {
        toast.error("Failed to update site configuration.");
      }
    } catch {
      toast.error("Network error while saving configuration.");
    }

    setIsSaving(false);
  };

  const updatePhpSetting = async (key: keyof Site, value: number | string) => {
    if (!siteData) return;
    if (blockedOnStaging()) return;
    const previous = siteData[key];
    setSiteData({ ...siteData, [key]: value });

    try {
      const res = await fetch(`/api/sites/${siteData.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: value })
      });
      if (!res.ok) {
        setSiteData({ ...siteData, [key]: previous });
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || `GridPane node rejected ${key} tuning.`);
        window.dispatchEvent(new Event("system_logs_updated"));
      } else {
        toast.success(`${key} update dispatched.`);
        window.dispatchEvent(new Event("system_logs_updated"));
      }
    } catch {
      setSiteData({ ...siteData, [key]: previous });
      toast.error("Network error while saving the setting.");
    }
  };

  const statusPill = siteData.is_wsod === false
    ? (isStaging
        ? { tone: "neutral" as const, label: "Staging" }
        : { tone: "ok" as const, label: "Active" })
    : { tone: "warn" as const, label: "WSOD" };


  return (
    <div className="flex flex-col gap-10">
      <DetailHeader
        title={siteData.url}
        status={<StatusPill tone={statusPill.tone}>{statusPill.label}</StatusPill>}
        facts={[
          nickname && <span className="font-sans text-[12.5px]">{nickname}</span>,
          server && (
            <Link href={`/servers/${server.id}`} className="underline decoration-line-strong underline-offset-2 transition-colors duration-150 hover:text-foreground">
              {server.label}
            </Link>
          ),
          server?.ip && <Copyable value={server.ip} what="IP address" />,
          siteData.php_version && <>PHP {siteData.php_version}</>,
          <>site {siteData.id}</>,
        ]}
        actions={
          <>
            {!isStaging && (
              <Button onClick={() => setConfigOpen(true)}>
                <Settings size={14} strokeWidth={1.75} /> Configuration
              </Button>
            )}
            <SiteLinkButtons url={siteData.url} serverId={siteData.server_id} />
            <a href={`https://${siteData.url}`} target="_blank" rel="noopener noreferrer" className={buttonClasses({ variant: "solid" })}>
              <PlaySquare size={14} strokeWidth={1.75} /> Open site
            </a>
          </>
        }
      />

      {isStaging && (
        <Callout tone="note" title="Staging is read-only here">
          GridPane&rsquo;s API exposes no staging environment to read or write, so settings on this page belong to the live site and
          are shown for reference only. Use GridPane directly to change staging. The links above do go to the staging host.
        </Callout>
      )}

      {!isStaging && siteData.staging_site_built_at && (
        <div className="rounded-md border border-line-strong px-4 py-4">
          <StagingLedger siteId={siteData.id} siteUrl={siteData.url} />
        </div>
      )}

      <div className="grid grid-cols-1 gap-y-10 md:grid-cols-2 md:gap-x-8">
        {/* Environment */}
        <section>
          <PanelHeader title="Environment" />
          <div data-proxy-row className="border-b border-border py-3">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
              <span className="eyebrow text-faint">Cloudflare</span>
              <ProxyStatus status={proxy} />
            </div>
            {proxy && proxy.state !== "proxied" && (
              <p className="text-pretty mt-1.5 text-[12px] leading-relaxed text-muted-foreground">{tie(proxy.meaning)}</p>
            )}
          </div>

          <SsoSiteRow serverId={siteData.server_id} host={siteData.url} />

          <div className="flex items-center justify-between gap-4 border-b border-border py-3">
            <span className="eyebrow text-faint">PHP version</span>
            <Select
              value={siteData.php_version ?? ""}
              onChange={async (e) => {
                if (blockedOnStaging()) return;
                const val = e.target.value;
                const previous = siteData.php_version;
                setSiteData({ ...siteData, php_version: val });
                try {
                  const res = await fetch(`/api/sites/${siteData.id}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ php_version: val })
                  });
                  if (!res.ok) {
                    setSiteData({ ...siteData, php_version: previous });
                    const errData = await res.json().catch(() => ({}));
                    toast.error(errData.error || "Failed to update PHP version.");
                    window.dispatchEvent(new Event("system_logs_updated"));
                    return;
                  }
                  toast.success("PHP runtime updated successfully.");
                  window.dispatchEvent(new Event("system_logs_updated"));
                } catch {
                  setSiteData({ ...siteData, php_version: previous });
                  toast.error("Network error while updating PHP runtime.");
                }
              }}
              aria-label="PHP version"
              className="py-[5px] font-mono text-[12px]"
            >
              {phpVersionOptions(siteData.php_version).map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </Select>
          </div>

          {/* The cache of compiled PHP this site shares with the others on its PHP version. */}
          <SiteOpcacheRow serverId={server?.id} host={siteData.url} />

          <div className="flex items-center justify-between gap-4 border-b border-border py-3">
            <span className="eyebrow text-faint">IP address</span>
            <span className={cn("font-mono text-[12px]", !server?.ip && "text-faint")}>
              {server?.ip || "not synced yet"}
            </span>
          </div>

          <div className="flex items-center justify-between gap-4 border-b border-border py-3">
            <span className="eyebrow text-faint">Hosted on</span>
            <Link
              href={`/servers/${server?.id}`}
              className="min-w-0 truncate text-right text-[12.5px] font-medium text-primary underline decoration-primary/40 underline-offset-2 transition-colors duration-150 hover:decoration-primary"
            >
              {server ? `${getProviderName(server.provider_id, server.provider)}: ${server.label}` : "not synced yet"}
            </Link>
          </div>
        </section>

        {/* Backup cadence */}
        <section className="md:border-l md:border-border md:pl-8">
          <PanelHeader title="Backup cadence">
            <Link
              href={server?.id ? `/backups?node=${server.id}` : "/backups"}
              className="eyebrow text-primary hover:underline"
            >
              Global view
            </Link>
          </PanelHeader>

          {backupSchedules.length > 0 ? backupSchedules.map((schedule, i) => {

            // Provider label mappings
            let provider = "Local storage";
            if (schedule.type === "remote") {
              if (schedule.service_id === 3) provider = "Backblaze B2";
              else if (schedule.service_id === 6) provider = "Wasabi";
              else if (schedule.service_id) provider = `Remote node ${schedule.service_id}`;
              else provider = "Remote storage";
            }

            // Format execution string logically
            let executeString = "Automatic interval";
            if (schedule.bup_schedule === "hourly") executeString = `Every hour at ··:${schedule.minute?.padStart(2, '0') || "00"}`;
            if (schedule.bup_schedule === "daily") executeString = `Daily at ${schedule.hour?.padStart(2, '0') || "00"}:${schedule.minute?.padStart(2, '0') || "00"} UTC`;
            if (schedule.bup_schedule === "weekly") {
              const dayMap = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
              const dName = schedule.day ? dayMap[parseInt(schedule.day)] : "Sunday";
              executeString = `Weekly on ${dName} at ${schedule.hour?.padStart(2, '0') || "00"}:${schedule.minute?.padStart(2, '0') || "00"} UTC`;
            }

            return (
              <div key={schedule.id || i} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border py-3">
                <span className="text-[13px] font-semibold">{provider}</span>
                <StatusPill tone="neutral">{schedule.type}</StatusPill>
                <span className="eyebrow text-primary">{schedule.bup_schedule}</span>
                <span className="ml-auto font-mono text-[11.5px] text-muted-foreground">{executeString}</span>
              </div>
            );
          }) : (
            <EmptyState title="No backup schedules mapped to this site." />
          )}
        </section>
      </div>

      {/* Settings groups */}
      <div className="grid grid-cols-1 gap-x-8 gap-y-10 border-t border-line-strong pt-8 md:grid-cols-2 xl:grid-cols-4">

        {/* PHP INI */}
        <section>
          <PanelHeader title="PHP INI" meta="php.ini" />
          <PhpMetricInput label="max_execution_time" metricKey="max_execution_time" value={siteData.max_execution_time} onUpdate={updatePhpSetting} unit="s" />
          <PhpMetricInput label="max_input_time" metricKey="max_input_time" value={siteData.max_input_time} onUpdate={updatePhpSetting} unit="s" />
          <PhpMetricInput label="max_input_vars" metricKey="max_input_vars" value={siteData.max_input_vars} onUpdate={updatePhpSetting} />
          <PhpMetricInput label="memory_limit" metricKey="memory_limit" value={siteData.memory_limit} onUpdate={updatePhpSetting} unit="M" />
          <PhpMetricInput label="post_max_size" metricKey="post_max_size" value={siteData.post_max_size} onUpdate={updatePhpSetting} unit="M" />
          <PhpMetricInput label="upload_max_filesize" metricKey="upload_max_filesize" value={siteData.upload_max_filesize} onUpdate={updatePhpSetting} unit="M" />
          <PhpMetricInput label="max_file_uploads" metricKey="max_file_uploads" value={siteData.max_file_uploads} onUpdate={updatePhpSetting} />
        </section>

        {/* PHP-FPM */}
        <section>
          <PanelHeader title="PHP-FPM" meta="pool" />
          <div className="flex items-center justify-between gap-3 border-b border-border py-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground" title="Process manager (pm)">pm</span>
            <Select
              value={siteData.pm || "dynamic"}
              onChange={(e) => updatePhpSetting("pm", e.target.value)}
              aria-label="Process manager (pm)"
              wrapperClassName="shrink-0"
              className="w-32 py-[5px] font-mono text-[12px]"
            >
              <option value="dynamic">dynamic</option>
              <option value="static">static</option>
              <option value="ondemand">ondemand</option>
            </Select>
          </div>
          <PhpMetricInput label="pm_max_children" metricKey="pm_max_children" value={siteData.pm_max_children} onUpdate={updatePhpSetting} />
          <PhpMetricInput label="pm_start_servers" metricKey="pm_start_servers" value={siteData.pm_start_servers} onUpdate={updatePhpSetting} />
          <PhpMetricInput label="pm_max_requests" metricKey="pm_max_requests" value={siteData.pm_max_requests} onUpdate={updatePhpSetting} />
          <PhpMetricInput label="pm_process_idle_t" metricKey="pm_process_idle_timeout" value={siteData.pm_process_idle_timeout} onUpdate={updatePhpSetting} unit="s" />
        </section>

        {/* Caching, and below it the slowlog */}
        <div className="flex flex-col gap-10">
        <SiteCachingSection
          siteId={siteData.id}
          siteUrl={siteData.url}
          readOnly={isStaging}
          state={cachingFromRow(siteData)}
          onState={(next) => setSiteData((prev) => (prev ? { ...prev, ...cachingColumns(next) } : prev))}
        />

        {/* Slowlog: shown, not editable. GridPane's API answers 422 to every
            slow log payload, so a control here could only change this app's own
            copy. See docs/parked-features.md to bring the controls back. */}
        <section data-slowlog-panel>
          <PanelHeader title="Slowlog" meta="read-only" />
          <div className="flex items-center justify-between gap-3 border-b border-border py-3">
            <div className="min-w-0">
              <div className="text-[13px] font-semibold">Slow logging</div>
              <div className="text-pretty text-[12px] text-muted-foreground">Slow request traces</div>
            </div>
            <StatusPill tone={siteData.is_php_slowlog ? "ok" : "neutral"}>
              {siteData.is_php_slowlog == null ? "Not reported" : siteData.is_php_slowlog ? "On" : "Off"}
            </StatusPill>
          </div>
          <SlowlogValue label="slowlog_timeout" value={siteData.php_slowlog_timeout} unit="s" />
          <SlowlogValue label="slowlog_trace_depth" value={siteData.php_slowlog_trace_depth} />

          <p className="text-pretty mt-3 text-[11.5px] leading-relaxed text-muted-foreground">
            Read from GridPane at the last sync. GridPane&rsquo;s API does not accept changes to
            these, so set them in GridPane itself.
          </p>
          {siteData.is_php_slowlog && (
            <p className="mt-2 break-words text-[11.5px] leading-relaxed text-muted-foreground">
              Traces are written on the server to{" "}
              <span className="font-mono">/var/www/{siteData.url}/logs/php-slow.log</span>
            </p>
          )}
        </section>
        </div>

        {/* 7G WAF + per-site IP blocking */}
        <div className="flex flex-col gap-10">
          <section>
            <PanelHeader title="7G firewall" meta="nginx · waf" />
            <div className="flex flex-col gap-3 py-3">
              <p className="text-pretty text-[12.5px] leading-relaxed text-muted-foreground">
                When 7G blocks a service you trust, generate the update-safe
                exception instead of switching a ruleset{"\u00a0"}off.
              </p>
              <Button
                size="sm"
                variant="solid"
                onClick={() => setIsWafGeneratorOpen(true)}
                className="w-full"
              >
                <ShieldPlus size={14} strokeWidth={1.75} />
                Whitelist rule generator
              </Button>
            </div>
          </section>

          <section>
            <PanelHeader
              title="Firewall"
              meta={isProxied ? "cloudflare · nginx" : "nginx · ufw"}
            />
            <p className="text-pretty pt-3 text-[12.5px] leading-relaxed text-muted-foreground">
              {isProxied
                ? "This site is proxied, so a server firewall ban would only ever see Cloudflare's edge IPs. Block at the edge, or with an nginx\u00a0deny."
                : "Block a visitor from this site alone. UFW cannot do it — it filters packets and has no idea which site a request was\u00a0for."}
            </p>
            <FirewallPanel
              scope="site"
              siteId={siteData.id}
              serverId={server?.id}
              siteUrl={siteData.url ?? undefined}
              refreshKey={firewallKey}
            />
            <div className="flex flex-col gap-3 pt-2 sm:flex-row">
              <Button
                size="sm"
                onClick={() => setIsIpBlockOpen(true)}
                className="w-full sm:flex-1"
              >
                <ShieldBan size={14} strokeWidth={1.75} />
                Block an IP
              </Button>
              <Button
                size="sm"
                onClick={() => setIsIpAllowOpen(true)}
                className="w-full sm:flex-1"
              >
                <ShieldCheck size={14} strokeWidth={1.75} />
                Allow an IP
              </Button>
            </div>
          </section>
        </div>
      </div>

      {/* Cloudflare WAF — the zone this hostname sits in, from the WAF inventory.
          siteData.url is already the staging host on a staging row, so a
          DNS-only staging record is reported against the right name. */}
      <SiteZoneSection host={siteData.url} />

      {/* Fail2Ban behind Cloudflare — this site's own three jails, from the
          server's agent. Sits under the zone it bans in. */}
      <SiteFail2BanSection serverId={server?.id} host={siteData.url} />

      {/* The server's own firewall for this site: GridPane's 7G settings, and
          8G where it is installed, with what each did in the last 24 hours. */}
      <SiteWafSection serverId={server?.id} host={siteData.url} />

      {/* Configuration modal */}
      <Modal open={configOpen} onClose={() => setConfigOpen(false)} title="Site configuration">
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="site-nickname" className="eyebrow text-faint">Nickname / client</label>
            <Input
              id="site-nickname"
              type="text"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="e.g. Acme Corp staging"
              className="w-full"
            />
            <p className="text-pretty text-[12px] text-muted-foreground">Identifies the site across the dashboard.</p>
          </div>

          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <Button onClick={() => setConfigOpen(false)} disabled={isSaving}>
              Cancel
            </Button>
            <Button variant="solid" onClick={handleSaveConfig} disabled={isSaving}>
              {isSaving && <Loader2 size={14} strokeWidth={1.75} className="animate-spin" />}
              {isSaving ? "Saving" : "Save configuration"}
            </Button>
          </div>
        </div>
      </Modal>

      <WafWhitelistGenerator
        open={isWafGeneratorOpen}
        onClose={() => setIsWafGeneratorOpen(false)}
        siteUrl={siteData.url}
      />

      <IpAllowlistManager
        open={isIpAllowOpen}
        onClose={() => setIsIpAllowOpen(false)}
        scope="global"
        siteId={siteData.id}
        serverId={server?.id}
        siteUrl={siteData.url ?? undefined}
        onRecorded={() => setFirewallKey((k) => k + 1)}
      />

      <IpBlockManager
        open={isIpBlockOpen}
        onClose={() => setIsIpBlockOpen(false)}
        scope="site"
        siteId={siteData.id}
        siteUrl={siteData.url}
        serverId={server?.id}
        isProxied={isProxied}
      />
    </div>
  );
}


/** A settings line while it loads: the real label, a placeholder where its value goes. */
function LoadingRow({ label, mono = false, tall = false, className }: { label: string; mono?: boolean; tall?: boolean; className?: string }) {
  return (
    <div className={cn("flex items-center justify-between gap-3 border-b border-border", tall ? "min-h-[55px] py-3" : mono ? "min-h-[47px] py-2" : "min-h-[44px] py-3", className)}>
      <span className={mono ? "font-mono text-[11.5px] text-muted-foreground" : "eyebrow text-faint"}>{label}</span>
      <span aria-hidden="true" className="block h-[10px] w-20 animate-pulse rounded-sm bg-panel-2" />
    </div>
  );
}

/** The page while it loads: the same blocks in the same places, so nothing moves when the site arrives. */
function SiteDetailLoading({ staging }: { staging: boolean }) {
  return (
    <div className="flex flex-col gap-10" aria-busy="true">
      <DetailHeader
        title={null}
        status={<span aria-hidden="true" className="block h-[19px] w-16 animate-pulse rounded-sm bg-panel-2" />}
        facts={null}
        actions={
          <>
            {!staging && (
              <Button disabled>
                <Settings size={14} strokeWidth={1.75} /> Configuration
              </Button>
            )}
            <Button disabled>WP Admin</Button>
            <Button variant="solid" disabled>
              <PlaySquare size={14} strokeWidth={1.75} /> Open site
            </Button>
          </>
        }
      />
      <div className="grid grid-cols-1 gap-y-10 md:grid-cols-2 md:gap-x-8">
        <section>
          <PanelHeader title="Environment" />
          <LoadingRow label="Cloudflare" className="min-h-[46px]" />
          <LoadingRow label="PHP version" tall />
          <LoadingRow label="IP address" />
          <LoadingRow label="Hosted on" />
        </section>
        <section className="md:border-l md:border-border md:pl-8">
          <PanelHeader title="Backup cadence" />
          <LoadingRow label="" className="min-h-[46px]" />
          <LoadingRow label="" className="min-h-[46px]" />
        </section>
      </div>
      <div className="grid grid-cols-1 gap-x-8 gap-y-10 border-t border-line-strong pt-8 md:grid-cols-2 xl:grid-cols-4">
        <section>
          <PanelHeader title="PHP INI" meta="php.ini" />
          {["max_execution_time", "max_input_time", "max_input_vars", "memory_limit", "post_max_size", "upload_max_filesize", "max_file_uploads"].map((l) => (
            <LoadingRow key={l} label={l} mono />
          ))}
        </section>
        <section>
          <PanelHeader title="PHP-FPM" meta="pool" />
          {["pm", "pm_max_children", "pm_start_servers", "pm_max_requests", "pm_process_idle_t"].map((l) => (
            <LoadingRow key={l} label={l} mono />
          ))}
        </section>
        <section>
          <PanelHeader title="Slowlog" meta="read-only" />
          <LoadingRow label="Slow logging" tall className="min-h-[63px]" />
          <LoadingRow label="slowlog_timeout" mono className="min-h-[35px]" />
          <LoadingRow label="slowlog_trace_depth" mono className="min-h-[35px]" />
        </section>
        <section>
          <PanelHeader title="7G firewall" meta="nginx · waf" />
          <div className="flex flex-col gap-3 py-3">
            <span aria-hidden="true" className="block h-[10px] w-full animate-pulse rounded-sm bg-panel-2" />
            <span aria-hidden="true" className="block h-[10px] w-2/3 animate-pulse rounded-sm bg-panel-2" />
          </div>
        </section>
      </div>
    </div>
  );
}
