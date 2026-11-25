"use client";

import { PanelRightOpen } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { SiteLinkActions } from "@/components/sites/site-links";
import { SitePeek } from "@/components/sites/site-peek";
import { usePersistedState } from "@/lib/use-persisted-state";
import { readSavedSort, writeSavedSort } from "@/lib/saved-sort";
import { stagingRowId } from "@/lib/site-row-id";
import { useClientValue } from "@/lib/use-client-value";
import { useState, useMemo, useEffect } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Database } from "@/lib/database.types";
import { useTask } from "@/components/providers/task-provider";
import {
  Button,
  DataTable,
  FilterBar,
  FilterField,
  IconButton,
  Input,
  Select,
  PageHeader,
  Panel,
  StatusPill,
  Modal,
  ConfirmDialog,
  type Column,
  type TableView,
} from "@/components/ui";

// The two extras are embedded relations, not columns, so they are declared here
// rather than coming from the generated row type.
type Site = Database["public"]["Tables"]["sites"]["Row"] & {
  servers: { label: string | null; ip: string | null } | null;
  // Operator-recorded, not read from GridPane — see supabase/migrations/20261120000000_baseline.sql.
  site_staging_state?: { is_active: boolean } | null;
};
type Server = Database["public"]["Tables"]["servers"]["Row"];
// The PHP overrides the bulk form can set. A field left alone is absent.
type BulkPhp = Partial<Pick<Site, "memory_limit" | "max_execution_time" | "php_version" | "pm" | "pm_max_children" | "pm_max_requests" | "pm_start_servers" | "pm_process_idle_timeout">>;

const QUICK = ["all", "production", "active-staging", "errors"];

export default function SitesPage() {
  // The bulk bar is drawn into document.body, which only the browser has.
  const mounted = useClientValue(() => true, false);

  // Filters and sort, kept between visits under the keys they have always had.
  const [searchQuery, setSearchQuery] = usePersistedState("sites_search", "");
  const [phpFilter, setPhpFilter] = usePersistedState("sites_php", "all");
  const [serverFilter, setServerFilter] = usePersistedState("sites_server", "all");
  const [savedEnv, setEnvFilter] = usePersistedState("sites_env", "all");
  const [savedSort, setSavedSort] = usePersistedState("sites_sort", "domain-asc");
  const envFilter = QUICK.includes(savedEnv) ? savedEnv : "all";
  // "A-Z" and "Z-A" are what the old sort dropdown saved.
  const sort = readSavedSort(savedSort, { id: "domain", dir: "asc" }, { "A-Z": { id: "domain", dir: "asc" }, "Z-A": { id: "domain", dir: "desc" } });
  const [view, setView] = useState<TableView>({ keys: [], start: 0, total: 0 });

  const [liveSites, setLiveSites] = useState<Site[]>([]);
  const [liveServers, setLiveServers] = useState<Server[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  // Nicknames are bound globally to postgres
  const [isSaving, setIsSaving] = useState(false);

  // Bulk actions state
  const [selectedSiteIds, setSelectedSiteIds] = useState<number[]>([]);
  const [bulkConfigOpen, setBulkConfigOpen] = useState(false);
  const [bulkPhpPayload, setBulkPhpPayload] = useState<BulkPhp>({});

  // Consume Global Task Provider Hook
  const { startBulkTask, isTaskRunning } = useTask();

  const supabase = createClient();

  useEffect(() => {

    async function fetchSites() {
      setIsLoading(true);
      setLoadError(null);
      // A failed read used to leave the list empty and the page saying "No
      // sites found". Try twice, then say the read failed and why.
      let lastError = "";
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const [_sitesRes, _serversRes] = await Promise.all([
            supabase.from("sites").select("*, servers(label, ip), site_staging_state(is_active)"),
            supabase.from("servers").select("*")
          ]);
          if (_serversRes.data) setLiveServers(_serversRes.data);
          if (_sitesRes.data) {
            setLiveSites(_sitesRes.data as Site[]);
            setIsLoading(false);
            return;
          }
          lastError = _sitesRes.error?.message || "The database sent no rows and no reason.";
        } catch (e) {
          lastError = e instanceof Error ? e.message : "The request did not complete.";
        }
        if (attempt === 1) await new Promise((r) => setTimeout(r, 1200));
      }
      setLoadError(lastError);
      setIsLoading(false);
    }
    fetchSites();
  }, [supabase, loadAttempt]);

  // Apply bulk-task results pushed from the global provider
  useEffect(() => {
    const handleBulkTaskCompletion = (e: Event) => {
      const { ids, payload } = (e as CustomEvent<{ ids: number[]; payload: Partial<Site> }>).detail;
      setLiveSites(prev => prev.map(s => ids.includes(s.id) ? { ...s, ...payload } : s));
    };
    window.addEventListener("bulk_task_completed", handleBulkTaskCompletion);

    return () => {
      window.removeEventListener("bulk_task_completed", handleBulkTaskCompletion);
    };
  }, []);

  // Modal state
  const [configOpen, setConfigOpen] = useState(false);
  const [selectedSite, setSelectedSite] = useState<Site | null>(null);
  const [peekId, setPeekId] = useState<number | null>(null);
  const [deployQuestion, setDeployQuestion] = useState<{ ids: number[]; overrides: Record<string, unknown> } | null>(null);
  const [nickname, setNickname] = useState("");

  // Escape is the Modal's own job (useOverlay): one press closes one layer, so a
  // question open over the bulk form closes alone and the form keeps its values.

  const handleSaveConfig = async () => {
    if (selectedSite) {
      setIsSaving(true);
      try {
        const res = await fetch(`/api/sites/${selectedSite.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ site_nickname: nickname })
        });

        if (res.ok) {
          const updatedSites = liveSites.map(s =>
            s.id === selectedSite.id ? { ...s, site_nickname: nickname } : s
          );
          setLiveSites(updatedSites);
          toast.success("Nickname saved.");
          setConfigOpen(false);
        } else {
          toast.error("Save failed.");
        }
      } catch {
        toast.error("Network error — nickname not saved.");
      }
      setIsSaving(false);
    }
  };

  // Every row the page can show, before the quick filter: the sites that match
  // the search and "More", plus a row for each staging copy.
  const rowsByQuick = useMemo(() => {
    let result = [...liveSites];

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(site => {
        const customName = site.site_nickname || "";
        const serverName = site.servers?.label?.toLowerCase() || "";
        return (
          customName.toLowerCase().includes(q) ||
          site.url.toLowerCase().includes(q) ||
          serverName.includes(q)
        );
      });
    }

    if (phpFilter !== "all") {
      result = result.filter(site => site.php_version === phpFilter);
    }

    if (serverFilter !== "all") {
      result = result.filter(site => site.server_id?.toString() === serverFilter);
    }

    // Which sites genuinely have staging is RECORDED in site_staging_state, not
    // read from GridPane. GridPane's OAuth API exposes no staging environment at
    // all — /site?type=staging returns nothing while type=primary returns every
    // site — and `staging_site_built_at` is a build timestamp it never clears
    // when staging is destroyed. Inferring "active" from that timestamp lists
    // sites whose staging is gone, and a hardcoded array of ghost domains goes
    // stale. See supabase/migrations/20261120000000_baseline.sql.
    const hasLiveStaging = (site: Site) => site.site_staging_state?.is_active === true;
    const toStagingRow = (site: Site) => ({
      ...site,
      url: `staging.${site.url}`,
      built_at: site.staging_site_built_at || null,
      id: stagingRowId(site.id) // an id no real site can have; the site page reads it back
    });

    const staging = result.filter(hasLiveStaging).map(toStagingRow);
    const all = [...result, ...staging];
    return {
      all,
      production: result.filter(site => site.url && !site.url.startsWith("staging.")),
      "active-staging": staging,
      errors: all.filter(site => site.is_wsod),
    } as Record<string, Site[]>;
  }, [searchQuery, phpFilter, serverFilter, liveSites]);
  const filteredSites = rowsByQuick[envFilter];
  const count = (id: string) => (isLoading || loadError ? null : rowsByQuick[id].length);

  const uniquePhpVersions = Array.from(new Set(liveSites.map(s => s.php_version))).filter(v => v !== null && v !== "").sort();
  const moreActive = [phpFilter !== "all", serverFilter !== "all"].filter(Boolean).length;

  const clearFilters = () => {
    setSearchQuery("");
    setPhpFilter("all");
    setServerFilter("all");
    setEnvFilter("all");
  };

  const openSiteConfig = (site: Site) => {
    setSelectedSite(site);
    setNickname(site.site_nickname || "");
    setConfigOpen(true);
  };

  const columns: Column<Site>[] = [
    {
      id: "domain",
      header: "Domain",
      phone: "title",
      skeleton: "w-44",
      grow: true,
      sortValue: (site) => site.url,
      cell: (site, where) => (
        <>
          <Link href={`/sites/${site.id}`} className="block truncate text-[13px] font-bold transition-colors duration-150 hover:text-primary">
            {site.url}
          </Link>
          {/* Tablet widths have no room for a Server column, so the server sits under the domain. */}
          {where === "table" && (
            <p className="mt-0.5 truncate text-[11px] text-faint">
              {site.site_nickname}
              {site.site_nickname && <span className="lg:hidden">{" · "}</span>}
              <span className="lg:hidden">{site.servers?.label || "Unknown server"}</span>
            </p>
          )}
        </>
      ),
    },
    { id: "nickname", header: "Nickname", className: "hidden", cell: (site) => site.site_nickname || <span className="text-faint">–</span> },
    {
      id: "environment",
      header: "Environment",
      skeleton: "w-28",
      sortValue: (site) => site.php_version,
      cell: (site, where) => (
        <span className={cn("flex flex-col gap-1", where === "phone" ? "items-end" : "items-start")}>
          <span className="flex items-center gap-2">
            <span className="whitespace-nowrap font-mono text-[12px] font-semibold">PHP {site.php_version || "–"}</span>
            <StatusPill tone={site.pm === "dynamic" ? "ok" : "neutral"}>{site.pm || "unknown"}</StatusPill>
          </span>
          <span className="whitespace-nowrap font-mono text-[10.5px] text-muted-foreground">
            {site.memory_limit ? `${site.memory_limit} MB` : "memory not set"}
            {" · "}
            {site.pm_max_children ? `${site.pm_max_children} workers` : "workers not set"}
          </span>
        </span>
      ),
    },
    {
      id: "server",
      header: "Server",
      phone: "subtitle",
      skeleton: "w-24",
      className: "max-lg:hidden lg:max-w-[220px]",
      sortValue: (site) => site.servers?.label,
      cell: (site, where) =>
        where === "phone" ? (
          site.servers?.label || "Unknown server"
        ) : (
          <>
            <Link href={`/servers/${site.server_id}`} className="block truncate text-[13px] font-medium transition-colors duration-150 hover:text-primary">
              {site.servers?.label || "Unknown server"}
            </Link>
            <p className="mt-0.5 truncate font-mono text-[11px] text-faint">{site.servers?.ip || "Unknown IP"}</p>
          </>
        ),
    },
    { id: "ip", header: "Server IP", className: "hidden", cell: (site) => <span className="font-mono text-[11.5px]">{site.servers?.ip || "Unknown IP"}</span> },
    {
      id: "status",
      header: "Status",
      phone: "trailing",
      skeleton: "w-14",
      sortValue: (site) => (site.is_wsod ? 0 : 1),
      cell: (site) => <StatusPill tone={site.is_wsod ? "danger" : "ok"}>{site.is_wsod ? "Error" : "Active"}</StatusPill>,
    },
  ];

  const at = peekId === null ? -1 : view.keys.indexOf(String(peekId));
  const peeked = peekId === null ? null : (filteredSites.find((s) => s.id === peekId) ?? null);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Sites"
        stamp={isLoading ? "Loading" : loadError ? "Not loaded" : `${filteredSites.length} total`}
      />

      <FilterBar
        noun="sites"
        className="border-b border-border pb-4"
        pills={[
          { id: "all", label: "All", count: count("all") },
          { id: "production", label: "Production", count: count("production") },
          { id: "active-staging", label: "Active staging", count: count("active-staging") },
          { id: "errors", label: "Errors", count: count("errors") },
        ]}
        value={envFilter}
        onChange={setEnvFilter}
        search={{ value: searchQuery, onChange: setSearchQuery, placeholder: "Search domains or servers" }}
        moreActive={moreActive}
        onClear={clearFilters}
        more={
          <>
            <FilterField label="PHP version">
              <Select value={phpFilter} onChange={(e) => setPhpFilter(e.target.value)}>
                <option value="all">All PHP</option>
                {uniquePhpVersions.map(v => <option key={v} value={v!}>PHP {v}</option>)}
              </Select>
            </FilterField>
            <FilterField label="Server">
              <Select value={serverFilter} onChange={(e) => setServerFilter(e.target.value)}>
                <option value="all">All servers</option>
                {liveServers.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
              </Select>
            </FilterField>
          </>
        }
      />

      {/* A failed read is not an empty fleet: the table says which. */}
      <div data-sites-load-error={loadError ? "" : undefined}>
        <DataTable
          noun="sites"
          columns={columns}
          rows={loadError ? [] : filteredSites}
          rowKey={(site) => String(site.id)}
          loading={isLoading}
          skeletonRows={8}
          pageSize={25}
          sort={sort}
          onSortChange={(next) => setSavedSort(writeSavedSort(next))}
          resetKey={`${searchQuery}|${envFilter}|${phpFilter}|${serverFilter}`}
          onView={setView}
          selection={{
            selected: new Set(selectedSiteIds.map(String)),
            label: (site) => site.url,
            onToggle: (key) => {
              const id = Number(key);
              setSelectedSiteIds(selectedSiteIds.includes(id) ? selectedSiteIds.filter((x) => x !== id) : [...selectedSiteIds, id]);
            },
            onToggleAll: (keys, select) => {
              const ids = keys.map(Number);
              setSelectedSiteIds(select ? Array.from(new Set([...selectedSiteIds, ...ids])) : selectedSiteIds.filter((id) => !ids.includes(id)));
            },
          }}
          rowActions={(site, where) => (
            <>
              <SiteLinkActions url={site.url} serverId={site.server_id} />
              {where === "phone" ? (
                <Button size="sm" onClick={() => setPeekId(site.id)}>Quick view</Button>
              ) : (
                <IconButton label="Quick view" onClick={() => setPeekId(site.id)}>
                  <PanelRightOpen size={14} strokeWidth={1.75} />
                </IconButton>
              )}
            </>
          )}
          empty={
            loadError
              ? {
                  title: "Could not load sites",
                  hint: `The site list did not load, so this is not an empty fleet. ${loadError}`,
                  action: <Button size="sm" onClick={() => setLoadAttempt((n) => n + 1)}>Try again</Button>,
                }
              : liveSites.length === 0
                ? { title: "No sites found", hint: "The database returned no sites. Run a GridPane sync to fill the list." }
                : {
                    title: "No sites match these filters",
                    hint: "Change the search or the filters to see sites.",
                    action: <Button size="sm" onClick={clearFilters}>Clear filters</Button>,
                  }
          }
        />
      </div>

      {/* Deploy overrides: asked before anything is sent */}
      <ConfirmDialog
        open={deployQuestion !== null}
        onClose={() => setDeployQuestion(null)}
        title={`Deploy overrides to ${deployQuestion?.ids.length ?? 0} ${deployQuestion?.ids.length === 1 ? "site" : "sites"}?`}
        confirmLabel={`Deploy to ${deployQuestion?.ids.length ?? 0} ${deployQuestion?.ids.length === 1 ? "site" : "sites"}`}
        onConfirm={() => {
          if (!deployQuestion) return;
          // The provider runs one task at a time and would drop this one silently.
          if (isTaskRunning) throw new Error("Another task is still running. Wait for it to finish, then deploy.");
          // Delegate to the global provider so the task survives page changes
          startBulkTask(deployQuestion.ids, deployQuestion.overrides);
          setBulkConfigOpen(false);
          setSelectedSiteIds([]);
          setBulkPhpPayload({});
        }}
      >
        <p>
          This sends the settings below to GridPane for the selected sites, one site at a time with 35 seconds between them
          {(deployQuestion?.ids.length ?? 0) > 2 ? `, so it takes about ${Math.max(1, Math.round((((deployQuestion?.ids.length ?? 1) - 1) * 35) / 60))} min` : ""}.
          GridPane applies them to the live sites. To undo it, deploy the old values the same way.
        </p>
        <ul className="mt-2.5 rounded-md bg-panel-2 px-3 py-2 font-mono text-[11.5px] text-foreground">
          {Object.entries(deployQuestion?.overrides ?? {}).map(([key, value]) => (
            <li key={key} className="flex justify-between gap-3 py-0.5">
              <span>{key}</span>
              <span className="tabular-nums">{String(value)}</span>
            </li>
          ))}
        </ul>
      </ConfirmDialog>

      {/* Quick view. Up and Down step through the rows on this page, in the order shown. */}
      <SitePeek
        site={peeked}
        onClose={() => setPeekId(null)}
        onPrev={at > 0 ? () => setPeekId(Number(view.keys[at - 1])) : undefined}
        onNext={at !== -1 && at < view.keys.length - 1 ? () => setPeekId(Number(view.keys[at + 1])) : undefined}
        position={at === -1 ? undefined : `${view.start + at + 1} of ${view.total}`}
        onEditNickname={(site) => openSiteConfig(site)}
      />

      {/* Site configuration modal */}
      {selectedSite && (
        <Modal
          open={configOpen}
          onClose={() => setConfigOpen(false)}
          title="Site configuration"
          meta={selectedSite.url}
        >
          <div className="flex flex-col gap-2">
            <label htmlFor="site-nickname" className="eyebrow text-faint">Nickname / client</label>
            <Input
              id="site-nickname"
              type="text"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="e.g. Acme Corp staging"
            />
            <p className="text-pretty text-[12px] text-muted-foreground">Used to identify the site across the dashboard.</p>
          </div>
          <div className="mt-5 flex justify-end gap-2 border-t border-border pt-4">
            <Button onClick={() => setConfigOpen(false)} disabled={isSaving}>
              Cancel
            </Button>
            <Button variant="solid" onClick={handleSaveConfig} disabled={isSaving}>
              {isSaving ? "Saving…" : "Save configuration"}
            </Button>
          </div>
        </Modal>
      )}

      {/* Floating bulk actions bar */}
      {mounted && selectedSiteIds.length > 0 && createPortal(
        <Panel className="fixed bottom-[calc(88px+env(safe-area-inset-bottom))] md:bottom-8 left-1/2 -translate-x-1/2 z-[100] flex w-[92%] sm:w-auto items-center justify-between gap-3 sm:gap-6 px-4 py-3 shadow-2xl anim-pop">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[15px] font-bold tabular-nums">{selectedSiteIds.length}</span>
            <span className="eyebrow text-faint">sites selected</span>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" onClick={() => setSelectedSiteIds([])}>Clear</Button>
            <Button size="sm" variant="solid" onClick={() => { setBulkConfigOpen(true); setBulkPhpPayload({}); }}>
              Configure overrides
            </Button>
          </div>
        </Panel>,
        document.body
      )}

      {/* Bulk overrides modal */}
      {bulkConfigOpen && (() => {
        const selectedSites = liveSites.filter(s => selectedSiteIds.includes(s.id));
        const uniquePmTypes = Array.from(new Set(selectedSites.map(s => s.pm).filter(Boolean)));
        const sharedPmType = uniquePmTypes.length === 1 ? uniquePmTypes[0] : null;
        const activePmType = bulkPhpPayload.pm || sharedPmType;

        return (
          <Modal
            open={bulkConfigOpen}
            onClose={() => setBulkConfigOpen(false)}
            title="Bulk overrides"
            meta={`${selectedSiteIds.length} sites`}
            className="max-w-xl"
          >
            <div className="flex flex-col gap-5">
              <div className="flex flex-col gap-1.5">
                <span className="eyebrow text-faint">Target sites</span>
                <div className="max-h-32 overflow-y-auto rounded-md border border-border bg-panel-2 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {selectedSites.map(s => s.url).join(", ")}
                </div>
              </div>

              <div className="flex flex-col gap-4 border-t border-border pt-4">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="rulehead pb-0 border-b-0!">Tuning variables</span>
                  <span className="eyebrow text-faint">Synced to GridPane + DB</span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="flex flex-col gap-1.5">
                    <label className="eyebrow text-faint">Memory limit (MB)</label>
                    <Input type="number" placeholder="e.g. 256" className="font-mono" onChange={e => setBulkPhpPayload({...bulkPhpPayload, memory_limit: e.target.value ? Number(e.target.value) : undefined})} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="eyebrow text-faint">Max execution time</label>
                    <Input type="number" placeholder="e.g. 300" className="font-mono" onChange={e => setBulkPhpPayload({...bulkPhpPayload, max_execution_time: e.target.value ? Number(e.target.value) : undefined})} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="eyebrow text-faint">PHP version</label>
                    <Select className="font-mono" onChange={e => setBulkPhpPayload({...bulkPhpPayload, php_version: e.target.value || undefined})}>
                      <option value="">Keep existing</option><option value="7.4">7.4</option><option value="8.0">8.0</option><option value="8.1">8.1</option><option value="8.2">8.2</option><option value="8.3">8.3</option>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="eyebrow text-faint flex justify-between gap-2">
                      FPM process manager
                      {uniquePmTypes.length > 1 && !bulkPhpPayload.pm && <span className="text-danger font-bold">(mixed)</span>}
                    </label>
                    <Select
                      className={cn("font-mono", uniquePmTypes.length > 1 && !bulkPhpPayload.pm && "border-danger/40")}
                      onChange={e => setBulkPhpPayload({...bulkPhpPayload, pm: e.target.value || undefined})}
                    >
                      <option value="">{uniquePmTypes.length > 1 ? "Select to align workers…" : `Keep existing (${sharedPmType || "unknown"})`}</option>
                      <option value="dynamic">dynamic</option><option value="static">static</option><option value="ondemand">ondemand</option>
                    </Select>
                  </div>
                </div>

                {/* Worker-level FPM fields only render once the process manager is resolved */}
                {activePmType ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 border-t border-border pt-4">
                    <div className="flex flex-col gap-1.5">
                      <label className="flex items-center gap-1.5 font-mono text-[10.5px] text-muted-foreground">
                        pm.max_children
                        <StatusPill tone="ok" className="px-1.5 py-px">all</StatusPill>
                      </label>
                      <Input type="number" placeholder="e.g. 12" className="font-mono" onChange={e => setBulkPhpPayload({...bulkPhpPayload, pm_max_children: e.target.value ? Number(e.target.value) : undefined})} />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="flex items-center gap-1.5 font-mono text-[10.5px] text-muted-foreground">
                        pm.max_requests
                        <StatusPill tone="ok" className="px-1.5 py-px">all</StatusPill>
                      </label>
                      <Input type="number" placeholder="e.g. 500" className="font-mono" onChange={e => setBulkPhpPayload({...bulkPhpPayload, pm_max_requests: e.target.value ? Number(e.target.value) : undefined})} />
                    </div>

                    {activePmType === "dynamic" && (
                      <div className="flex flex-col gap-1.5">
                        <label className="flex items-center gap-1.5 font-mono text-[10.5px] text-muted-foreground">
                          pm.start_servers
                          <StatusPill tone="neutral" className="px-1.5 py-px">dynamic</StatusPill>
                        </label>
                        <Input type="number" placeholder="e.g. 4" className="font-mono" onChange={e => setBulkPhpPayload({...bulkPhpPayload, pm_start_servers: e.target.value ? Number(e.target.value) : undefined})} />
                      </div>
                    )}

                    {activePmType === "ondemand" && (
                      <div className="flex flex-col gap-1.5">
                        <label className="flex items-center gap-1.5 font-mono text-[10.5px] text-muted-foreground">
                          pm.process_idle_timeout
                          <StatusPill tone="neutral" className="px-1.5 py-px">ondemand</StatusPill>
                        </label>
                        <Input type="number" placeholder="e.g. 10s" className="font-mono" onChange={e => setBulkPhpPayload({...bulkPhpPayload, pm_process_idle_timeout: e.target.value ? Number(e.target.value) : undefined})} />
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="border-t border-border pt-4">
                    <p className="text-pretty text-[12px] leading-relaxed text-muted-foreground">
                      Worker scaling fields (children, idle timeout) are locked: the selected sites use <strong className="font-semibold text-warning">mixed process managers</strong>. Pick one process manager above to unlock them.
                    </p>
                  </div>
                )}

                <p className="text-pretty text-[11px] text-faint text-center">Empty fields are left unchanged.</p>
              </div>

              <div className="flex justify-end gap-2 border-t border-border pt-4">
                <Button onClick={() => setBulkConfigOpen(false)}>Cancel</Button>
                <Button
                  variant="solid"
                  disabled={Object.keys(bulkPhpPayload).length === 0}
                  onClick={() => {
                    // Clean undefined
                    const payloadStr = JSON.stringify(bulkPhpPayload, (k, v) => v === undefined ? undefined : v);
                    const activeKeys = JSON.parse(payloadStr);

                    if (Object.keys(activeKeys).length === 0) {
                      toast.error("No valid overrides entered.");
                      return;
                    }

                    // Ask first: this changes live sites. The form stays open
                    // underneath, so Cancel comes back to it as it was.
                    setDeployQuestion({ ids: [...selectedSiteIds], overrides: activeKeys });
                  }}
                >
                  Deploy overrides
                </Button>
              </div>
            </div>
          </Modal>
        );
      })()}

    </div>
  );
}
