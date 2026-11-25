
import { getPatchstackProtection, screenPatchstackResponse } from "../../../../patchstack.next";
import { createClient } from "@supabase/supabase-js";
import { refuseUnlessStrong } from "@/lib/api-guard";
import { cachingColumns, cachingFromRecord } from "@/lib/site-caching";
import { ago, closeSyncRun, finishedStatus, openSyncRun, touchSyncRun, type SyncDb, type SyncProgress } from "@/lib/sync-runs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // Allow up to 5 minutes to ride out GridPane 429 rate limits

// GridPane rate-limits this token to roughly six requests per minute, and the
// budget is SHARED across endpoints rather than per-route: paginating the site
// list spends the allowance the per-site loop needs, so the loop can be refused
// after only a few reads and then settles into about six reads between every
// 55s cooldown.
//
// Sprinting into that wall (a short fixed delay) pays a ~55s penalty each time,
// and a site that gets 429'd twice is skipped outright, which silently leaves
// its schedules stale. Pace ahead of the limit instead: at 11s no seven
// requests can fall inside any 60s window, so the ceiling is never reached.
// Total run time is about the same, because the cooldowns were already setting
// the pace.
//
// 11s is the starting interval, not the answer. Pacing cuts the refusals but
// does not end them, and a fixed number cannot: GridPane's limiter is not a simple
// sliding window, so calls with identical recent history can be accepted or
// refused.
//
// So do not tune a constant. Start here and widen whenever GridPane actually
// refuses, until the run finds a rate it accepts.
const GRIDPANE_MIN_INTERVAL_MS = 10_500;

// How much to widen after each refusal, and the ceiling to stop at. The step is
// deliberately larger than the ~8s retry-after those refusals reported: backing
// off by less than the wait it just cost would keep paying it.
const PACING_STEP_MS = 2_000;
const GRIDPANE_MAX_INTERVAL_MS = 20_000;

// GridPane defaults to 10 records per page but honors per_page: asked for
// /site?per_page=100, it returned a fleet of about fifty sites as one page
// (last_page 1). A larger fleet is paged as before. Asking for one page
// instead of many removes paced requests from every full sync and, more
// importantly, stops the site listing draining the shared rate budget before
// the per-site loop even starts, which would otherwise get the first sites
// refused immediately after pagination.
const GRIDPANE_PAGE_SIZE = 100;

// Cloudflare caps subrequests per Worker invocation — 50 on the Free plan, 1000
// on Paid — and a full sync needs roughly three subrequests per site. The
// runtime cannot read which plan the account is on, so this budget is set for
// the smaller ceiling and the sync resumes across invocations instead of
// assuming headroom it may not have. Raise SUBREQUEST_BUDGET on Paid only a
// step at a time, reading the spend each sync reports.
const SUBREQUEST_BUDGET = 40;

// A GridPane 429 parks the loop for ~55s. Pause on elapsed time as well, so a
// pass that spends its whole window cooling still hands back a usable cursor
// rather than being cut off mid-flight.
const TIME_BUDGET_MS = 210_000;

// Sites per database flush: small enough that a dropped pass loses little work,
// large enough that flushing costs about two subrequests per ten sites.
const FLUSH_EVERY = 10;

// A sync that cannot save the server or site list has failed, whatever else it
// manages afterwards. Reporting those as ordinary log lines would let a Sync
// look successful while Postgres rejected every site. Throwing one of these
// ends the sync with a "failed" message.
class SyncFailure extends Error {}

function wait(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * One object from GridPane's API (a server, a site). Nothing checks GridPane's
 * answer against a schema, so a field is whatever GridPane sent: it is copied
 * into the database as it came, and code that needs a type says so where it reads.
 */
type GridPaneRecord = { id: number | string; [field: string]: unknown };

type ScheduleRow = {
  id: number;
  site_id: number;
  type: string;
  service_id: number | null;
  bup_schedule: string;
  hour: string | null;
  minute: string | null;
  day: string | null;
  created_at: string;
  updated_at: string;
};

// The PHP and caching settings the site page shows. GridPane's site LIST carries only
// memory_limit, pm and pm_max_children (written in stage 2); the rest are in
// each site's own record, which stage 3 reads anyway for its backup schedules.
// If stage 3 kept only the schedules, these would be filled only by
// `npm run sync`, and every site GridPane created after the last such run would
// show empty boxes.
const PHP_NUMBER_FIELDS = [
  "max_execution_time", "max_file_uploads", "max_input_time", "max_input_vars",
  "post_max_size", "upload_max_filesize",
  "pm_start_servers", "pm_max_requests", "pm_process_idle_timeout",
] as const;

type PhpConfigRow = { id: number; url: string } & Record<string, unknown>;

const toNumber = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number(v));

/**
 * The PHP settings in one site's GridPane record, as a sites row. Every row has
 * the same columns, because one upsert of rows with different columns fills the
 * missing ones with null. A field GridPane did not send is null, as stage 2
 * already does. A record with none of them returns null and nothing is written:
 * that is a reply in another shape, not a site with no settings.
 */
function phpConfigRow(site: { id: number; url: string }, gp: Record<string, unknown>): PhpConfigRow | null {
  const row: PhpConfigRow = { id: Number(site.id), url: site.url };
  for (const f of PHP_NUMBER_FIELDS) row[f] = toNumber(gp[f]);
  const custom = (gp.site_customizer ?? null) as Record<string, unknown> | null;
  row.is_php_slowlog = typeof custom?.is_php_slowlog === "boolean" ? custom.is_php_slowlog : null;
  row.php_slowlog_timeout = toNumber(custom?.php_slowlog_timeout);
  row.php_slowlog_trace_depth = toNumber(custom?.php_slowlog_trace_depth);
  const found = Object.entries(row).filter(([k, v]) => k !== "id" && k !== "url" && v !== null).length;
  if (found === 0) return null;
  // The caching settings come from the same record. They are added after the count above:
  // null is a real answer for them (no page cache on), so they prove nothing about its shape.
  return { ...row, ...cachingColumns(cachingFromRecord(gp)) };
}

type SyncRequestBody = {
  cursor?: number | null;
  // The sync's record (public.sync_runs), from the first pass's "run" line.
  runId?: string | null;
  // Sent alone, with runId, when the browser gives up on a sync: closes its record as stopped.
  stop?: string | null;
  // The pacing interval a previous pass settled on, in ms.
  interval?: number | null;
  stats?: {
    recovered?: number;
    pruned?: number;
    errors?: number;
    audited?: number;
    total?: number;
  };
};

export async function POST(req: Request) {
  // #region patchstack-next-route
  const psProtection = await getPatchstackProtection();
  const psBlocked = psProtection && await psProtection.fetchGuard()(req);
  if (psBlocked) return psBlocked;
  // #endregion

  const refused = await refuseUnlessStrong(req);
  if (refused) return screenPatchstackResponse((refused), req, psProtection);

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // Service role required — anon key cannot delete (RLS)
  const gpToken = process.env.GRIDPANE_API_TOKEN;

  if (!supabaseUrl || !supabaseKey || !gpToken) {
    return screenPatchstackResponse((new Response(JSON.stringify({ error: "Missing required environmental credentials (SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL, GRIDPANE_API_TOKEN)." }), { status: 500 })), req, psProtection);
  }

  // A resumed pass carries the id of the last site the previous pass finished,
  // plus the running totals, so the report at the end covers the whole sync and
  // not just the final pass.
  const body: SyncRequestBody = await req.json().catch(() => ({}));
  const cursor: number | null = typeof body?.cursor === "number" ? body.cursor : null;
  const isResume = cursor !== null;

  // A pass that had to widen its pacing hands the learned interval to the next
  // one; otherwise every pass would relearn the same lesson from scratch.
  const carriedInterval = Number(body?.interval);
  const startingInterval =
    Number.isFinite(carriedInterval) &&
    carriedInterval >= GRIDPANE_MIN_INTERVAL_MS &&
    carriedInterval <= GRIDPANE_MAX_INTERVAL_MS
      ? carriedInterval
      : GRIDPANE_MIN_INTERVAL_MS;

  const supabase = createClient(supabaseUrl, supabaseKey);
  const runs = supabase as unknown as SyncDb;
  const answer = (status: number, payload: Record<string, unknown>) =>
    screenPatchstackResponse(new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }), req, psProtection);

  // The sync's record, which every signed-in screen reads (lib/sync-runs.ts). The first pass
  // starts it, and is refused if another sync is running; later passes carry its id.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let runId: string | null = typeof body?.runId === "string" && UUID.test(body.runId) ? body.runId : null;

  if (typeof body?.stop === "string") {
    if (!runId) return answer(400, { error: "Nothing to stop: no sync id was sent." });
    const why = body.stop.replace(/\s+/g, " ").trim().slice(0, 300) || "The browser stopped the sync.";
    const err = await closeSyncRun(runs, runId, "stopped", { message: why });
    return answer(err ? 500 : 200, err ? { error: err } : { ok: true });
  }

  // Subrequests spent before the stream starts, counted with the rest.
  let spentBefore = 0;
  let recordNote: string | null = null;
  if (!isResume) {
    spentBefore += 3;
    const opened = await openSyncRun(runs, { source: "app" });
    if (opened.ok) {
      runId = opened.run.id;
    } else if (opened.busy) {
      const b = opened.busy;
      const from = b.source === "cli" ? "from the command line" : "in the app";
      const progress = b.sites_total ? ` It has read ${b.sites_done} of ${b.sites_total} sites.` : "";
      return answer(409, { error: `A sync is already running: started ${from} ${ago(b.started_at, Date.now())}.${progress} Only one runs at a time. Its progress shows in the top bar.`, run: b });
    } else {
      // The table is missing (the migration has not been applied) or could not be written.
      // Sync anyway, without a record, rather than leave the fleet unsynced.
      recordNote = `This sync is not recorded, so other screens cannot see it: ${opened.error}. Apply supabase/migrations/20261124000000_sync_runs.sql.`;
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const sendState = (targetObj: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(JSON.stringify(targetObj) + "\n"));
      };

      try {
        let recoveredCount = Number(body?.stats?.recovered) || 0;
        let prunedCount = Number(body?.stats?.pruned) || 0;
        let errorCount = Number(body?.stats?.errors) || 0;
        let auditedCount = Number(body?.stats?.audited) || 0;

        // Every outbound call — GridPane or Supabase — is a Cloudflare
        // subrequest. Count them rather than estimating: the ceiling is what
        // ends a pass, and a miscount is what silently truncated the old sync.
        let subrequests = spentBefore;
        const startedAt = Date.now();
        const spend = (n = 1) => { subrequests += n; };

        if (runId) sendState({ type: "run", id: runId });
        if (recordNote) sendState({ type: "log", msg: recordNote });

        // Moves the record forward. A record that cannot be written does not stop the sync.
        const report = async (progress: SyncProgress) => {
          if (!runId) return;
          spend();
          const err = await touchSyncRun(runs, runId, progress);
          if (err) sendState({ type: "log", msg: `The sync record was not updated: ${err}` });
        };
        const finish = async (status: "complete" | "partial" | "failed", progress: SyncProgress) => {
          if (!runId) return;
          spend();
          const err = await closeSyncRun(runs, runId, status, progress);
          if (err) sendState({ type: "log", msg: `The sync record was not closed: ${err}` });
        };

        // One pacer for every GridPane call, because the rate budget is shared
        // across its endpoints. A resumed pass starts the clock as though a
        // call had just been made: the previous pass ended on one, and the
        // round trip between passes is not long enough to have cleared it.
        let lastGridPaneCallAt = isResume ? Date.now() : 0;
        let gridPaneInterval = startingInterval;

        const paceGridPane = async () => {
          if (lastGridPaneCallAt) {
            const since = Date.now() - lastGridPaneCallAt;
            if (since < gridPaneInterval) {
              await wait(gridPaneInterval - since);
            }
          }
          lastGridPaneCallAt = Date.now();
        };

        // Called on every 429, wherever it happens. GridPane refusing is the
        // only reliable signal we have about its own limit, so treat it as the
        // instruction to slow down rather than just something to retry through.
        const widenPacing = (where: string) => {
          if (gridPaneInterval >= GRIDPANE_MAX_INTERVAL_MS) return;
          gridPaneInterval = Math.min(gridPaneInterval + PACING_STEP_MS, GRIDPANE_MAX_INTERVAL_MS);
          sendState({
            type: "log",
            msg: `Pacing widened to ${(gridPaneInterval / 1000).toFixed(1)}s per request after ${where} was refused.`
          });
        };
        const exhausted = (reserve = 0) =>
          subrequests + reserve >= SUBREQUEST_BUDGET ||
          Date.now() - startedAt > TIME_BUDGET_MS;

        const fetchAllPages = async (baseUrl: string, typeName: string) => {
           let allItems: GridPaneRecord[] = [];
           let page = 1;
           let lastPage = 1;
           let retried429 = false;
           do {
              const url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}per_page=${GRIDPANE_PAGE_SIZE}&page=${page}`;
              await paceGridPane();
              spend();
              const res = await fetch(url, {
                 headers: { 'Authorization': `Bearer ${gpToken}`, 'Accept': 'application/json' }
              });
              if (!res.ok) {
                 if (res.status === 429) {
                     if (!retried429) {
                        retried429 = true;
                        const retrySecs = parseInt(res.headers.get("retry-after-endpoint") || "5", 10);
                        widenPacing(`${typeName} pagination`);
                        sendState({ type: "log", msg: `[Rate Limit] Paginator cooling for ${retrySecs}s (single retry)...` });
                        await wait((retrySecs * 1000) + 500);
                        continue;
                     }
                     // Never retry a genuine 429 more than once — retrying refreshes GridPane's cooldown
                     sendState({ type: "error", msg: `[Rate Limit] ${typeName} paginator hit 429 twice — abandoning pagination (retrying would only extend GridPane's wait).` });
                     return null;
                 }
                 sendState({ type: "log", msg: `Failed to fetch ${typeName} (${res.status}).` });
                 return null;
              }
              const json = await res.json().catch(() => ({}));
              const items = Array.isArray(json.data) ? json.data : (Array.isArray(json.data?.data) ? json.data.data : []);
              allItems = allItems.concat(items);

              lastPage = json.meta?.last_page || json.last_page || 1;
              if (lastPage > 1) {
                  sendState({ type: "log", msg: `Fetched ${typeName} page ${page}/${lastPage}...` });
              }
              page++;
           } while (page <= lastPage);
           return allItems;
        };

        // Stages 1 and 2 reconcile the server and site matrices against
        // GridPane. They only need to run once per sync, so a resumed pass
        // skips straight to the audit loop and spends its whole budget there.
        if (!isResume) {

        // Stage 1: The Server Matrix
        sendState({ type: "progress", completed: 0, total: 100, recovered: 0, errors: 0, msg: "Auditing Remote Servers Matrix..." });

        const remoteServers = await fetchAllPages("https://my.gridpane.com/oauth/api/v1/server", "Servers");

        if (remoteServers && Array.isArray(remoteServers)) {
           if (remoteServers.length === 0) {
              sendState({ type: "log", msg: "[Guard] Remote server list came back empty — skipping ghost prune to protect local data." });
           } else {
           const remoteServerIds = remoteServers.map((s) => Number(s.id));
           spend();
           const { data: localServers } = await supabase.from("servers").select("id, cpu, ram");
           if (localServers) {
              const localServerIds = localServers.map(s => Number(s.id));
              const ghostIds = localServerIds.filter(id => !remoteServerIds.includes(id));
              if (ghostIds.length > 1 && ghostIds.length > localServerIds.length * 0.2) {
                 sendState({ type: "error", msg: `[Guard] Refusing to prune ${ghostIds.length}/${localServerIds.length} servers — exceeds the 20% sanity threshold, so no deletions were performed. Verify the GridPane token/API before re-running.` });
              } else if (ghostIds.length > 0) {
                 spend();
                 const { error: srvDelError } = await supabase.from("servers").delete().in("id", ghostIds);
                 if (srvDelError) throw new SyncFailure(`Servers GridPane no longer lists were not removed: ${srvDelError.message}`);
                 prunedCount += ghostIds.length;
                 sendState({ type: "log", msg: `Pruned ${ghostIds.length} ghost server(s).` });
              }

              // Seed entirely new servers (canonical column mapping mirrors scripts/sync-gridpane.ts)
              const existingMap = new Map(localServers.map((ls) => [Number(ls.id), ls]));
              const newServerIds = remoteServerIds.filter((id: number) => !localServerIds.includes(id));
              if (newServerIds.length > 0) {
                  const newServers = remoteServers.filter((s) => newServerIds.includes(Number(s.id))).map((s) => {
                      const existing = existingMap.get(Number(s.id));
                      // Preserve any manual hardware overrides the user input for un-mapped nodes (e.g. Hetzner)
                      const apiCpu = s.cpu ? String(s.cpu) : (s.cpu_cores ? String(s.cpu_cores) : null);
                      const apiRam = s.ram ? String(s.ram) : (s.memory ? String(s.memory) : null);
                      return {
                          id: s.id,
                          label: s.label,
                          ip: s.ip,
                          region: s.region,
                          sub_id: s.sub_id,
                          subdomain: s.subdomain,
                          database: s.database,
                          webserver: s.webserver,
                          os_version: s.os_version,
                          status: s.status,
                          cpu: apiCpu || existing?.cpu || null,
                          ram: apiRam || existing?.ram || null,
                          region_label: s.region_label,
                          user_id: s.user_id,
                          provider_id: s.provider_id,
                          failover_id: s.failover_id,
                          high_availability_sync_interval: s.high_availability_sync_interval,
                          is_wsod: s.is_wsod,
                          record_id: s.record_id,
                          uuid: s.uuid,
                          us_enabled: s.us_enabled,
                          is_health_check_running: s.is_health_check_running,
                          is_paired: s.is_paired,
                          is_preemptive_support_on: s.is_preemptive_support_on,
                          server_key: s.server_key,
                          update_backups: s.update_backups,
                          beta_server: s.beta_server,
                          provider: s.provider ? JSON.stringify(s.provider) : null
                      };
                  });
                  spend();
                  const { error: srvError } = await supabase.from("servers").upsert(newServers, { onConflict: 'id' });
                  if (srvError) throw new SyncFailure(`New servers were not saved: ${srvError.message} (${srvError.code})`);
                  sendState({ type: "log", msg: `Seeded ${newServers.length} new structural server(s).` });
              }
           }
           }
        }

        await report({ phase: "sites", servers_saved: Array.isArray(remoteServers) ? remoteServers.length : null });

        // Stage 2: The Site Matrix
        sendState({ type: "progress", completed: 0, total: 100, recovered: 0, errors: 0, msg: "Auditing Active Web Clusters..." });

        const remoteSites = await fetchAllPages("https://my.gridpane.com/oauth/api/v1/site", "Sites");

        if (!remoteSites) {
           throw new SyncFailure("GridPane's site list could not be read, so no site was updated. Wait a minute and run the sync again.");
        }

        if (Array.isArray(remoteSites)) {
           if (remoteSites.length === 0) {
              sendState({ type: "log", msg: "[Guard] Remote site list came back empty — skipping ghost prune to protect local data." });
           } else {
           const remoteSiteIds = remoteSites.map((s) => Number(s.id));
           spend();
           const { data: localSites, error: localSitesError } = await supabase.from("sites").select("id, url, site_nickname");
           if (localSitesError) throw new SyncFailure(`Could not read the stored sites: ${localSitesError.message}`);
           if (localSites) {
              const localSiteIds = localSites.map(s => Number(s.id));
              const ghostIds = localSiteIds.filter(id => !remoteSiteIds.includes(id));
              // Half, not the 20% used for servers: clearing the old copies after
              // moving a whole server is a routine prune.
              if (ghostIds.length > 1 && ghostIds.length > localSiteIds.length * 0.5) {
                 sendState({ type: "error", msg: `[Guard] Refusing to prune ${ghostIds.length}/${localSiteIds.length} sites — more than half the stored sites, so no deletions were performed. Verify the GridPane token/API before re-running.` });
              } else if (ghostIds.length > 0) {
                 spend();
                 const { error: siteDelError } = await supabase.from("sites").delete().in("id", ghostIds);
                 if (siteDelError) throw new SyncFailure(`Sites GridPane no longer lists were not removed: ${siteDelError.message}`);
                 prunedCount += ghostIds.length;
                 const goneUrls = localSites.filter(ls => ghostIds.includes(Number(ls.id))).map(ls => ls.url);
                 sendState({ type: "log", msg: `Removed ${ghostIds.length} site record(s) GridPane no longer lists: ${goneUrls.join(", ")}.` });
              }

              // One address can be on two servers: GridPane's site-migration tool gives a
              // moved site a new id on the new server and keeps the old record on
              // the old one as the way back. Each record is its own row. The
              // nickname is Fleet's own, so a new record inherits it from the
              // other copy of the same address.
              const nickByUrl = new Map<string, string>();
              for (const ls of localSites) if (ls.site_nickname) nickByUrl.set(ls.url, ls.site_nickname);

              const activeSitesPayload = remoteSites.map((s) => {
                  const existing = localSites.find(ls => ls.id === s.id);
                  return {
                      id: s.id,
                      url: s.url,
                      server_id: s.server_id,
                      user_id: s.user_id,
                      system_user_id: s.system_user_id,
                      // Mirror upstream exactly. These used to fall back to invented
                      // defaults ("8.1"/"256"/"dynamic"/"6") when GridPane omitted a
                      // field, which wrote fiction into the DB and made the UI report
                      // PHP versions the sites were not running. A missing value is
                      // null. Stage 3 fills the other PHP settings from each site's record.
                      php_version: s.php_version ?? null,
                      memory_limit: s.memory_limit ?? null,
                      pm: s.pm ?? null,
                      pm_max_children: s.pm_max_children ?? null,
                      is_ssl: !!s.is_ssl,
                      is_wsod: !!s.is_wsod,
                      built_at: s.built_at || null,
                      staging_site_built_at: s.staging_site_built_at || null,
                      site_nickname: existing ? (existing.site_nickname || null) : (nickByUrl.get(s.url as string) ?? null)
                  };
              });

              if (activeSitesPayload.length > 0) {
                  const payload: Record<string, unknown>[] = activeSitesPayload;
                  spend();
                  const { error: siteUpsertError } = await supabase.from("sites").upsert(payload);
                  if (siteUpsertError) throw new SyncFailure(`Sites were not saved: ${siteUpsertError.message} (${siteUpsertError.code})`);
                  const addresses = new Set(activeSitesPayload.map((p) => String(p.url))).size;
                  const doubled = activeSitesPayload.length - addresses;
                  sendState({ type: "log", msg: `Saved ${activeSitesPayload.length} site records: ${addresses} addresses${doubled > 0 ? `, ${doubled} of them also on a second server` : ""}.` });
              }
           }
           }
        }

        } // end of first-pass-only stages

        // Stage 3: Backup Sync Iteration
        // The whole site list is loaded every pass and sliced by the cursor, so
        // one subrequest yields both the remaining work and the true total for
        // progress reporting across passes.
        spend();
        const { data: activeSites, error: siteError } = await supabase
          .from("sites")
          .select("id, url")
          .order("id", { ascending: true });

        if (siteError || !activeSites || activeSites.length === 0) {
          sendState({ type: "error", msg: "Failed to load active sites matrix from database." });
          await finish("failed", { message: siteError ? `The stored sites could not be read: ${siteError.message}` : "No sites are stored, so there was nothing to read." });
          controller.close();
          return;
        }

        if (!isResume) await report({ phase: "details", sites_total: activeSites.length, sites_done: 0 });

        const progressNow = (done: number): SyncProgress => ({
          phase: "details", sites_total: activeSites.length, sites_done: done,
          sites_read: auditedCount, schedules: recoveredCount, errors: errorCount,
        });
        const closeAtEnd = async () => {
          const status = finishedStatus({ sitesTotal: activeSites.length, sitesRead: auditedCount, errors: errorCount });
          const unread = activeSites.length - auditedCount;
          await finish(status, {
            ...progressNow(activeSites.length),
            message: status === "complete"
              ? `Read all ${activeSites.length} sites.`
              : `Read ${auditedCount} of ${activeSites.length} sites${unread > 0 ? `; ${unread} not read` : ""}${errorCount ? `; ${errorCount} error(s)` : ""}.`,
          });
        };

        const startIndex = cursor === null
          ? 0
          : activeSites.findIndex(s => Number(s.id) > cursor);

        // Rows read since the last flush, and the sites they came from.
        //
        // Nothing is written per site any more. The old code deleted a site's
        // schedules and then inserted the replacements as two separate
        // subrequests with no transaction around them, so a ceiling falling
        // between the two emptied that site permanently — and because the next
        // run died at the same point, it never healed. Upserting first
        // and pruning second means a pass that dies between the two leaves
        // harmless extra rows instead of a hole.
        let batchRows: ScheduleRow[] = [];
        let batchSites: number[] = [];
        let batchSeenIds: number[] = [];
        let batchConfig: PhpConfigRow[] = [];

        const flushBatch = async () => {
           if (batchConfig.length > 0) {
              spend();
              const { error: cfgError } = await supabase
                .from("sites")
                .upsert(batchConfig, { onConflict: "id" });
              if (cfgError) {
                 errorCount++;
                 sendState({ type: "error", msg: `PHP settings were not saved for ${batchConfig.length} site(s): ${cfgError.message}` });
              }
              batchConfig = [];
           }

           if (batchSites.length === 0) return;

           if (batchRows.length > 0) {
              spend();
              const { error: upsertError } = await supabase
                .from("backup_schedules")
                .upsert(batchRows, { onConflict: "id" });

              if (upsertError) {
                 errorCount++;
                 sendState({ type: "error", msg: `Schedule write failed for ${batchSites.length} site(s): ${upsertError.message} — nothing was pruned, existing schedules left untouched.` });
                 batchRows = []; batchSites = []; batchSeenIds = [];
                 return;
              }
              recoveredCount += batchRows.length;
           }

           // Retire only schedules belonging to sites we actually read this
           // pass and that GridPane no longer lists. A site we failed to read
           // is never pruned: the absence of an answer is not an answer.
           spend();
           const seenList = batchSeenIds.length > 0 ? batchSeenIds.join(",") : "0";
           const { error: pruneError, count: retired } = await supabase
             .from("backup_schedules")
             .delete({ count: "exact" })
             .in("site_id", batchSites)
             .not("id", "in", `(${seenList})`);

           if (pruneError) {
              errorCount++;
              sendState({ type: "error", msg: `Stale-schedule prune failed: ${pruneError.message} — current schedules are saved; some retired rows may remain.` });
           } else if (retired && retired > 0) {
              sendState({ type: "log", msg: `Retired ${retired} schedule(s) GridPane no longer lists.` });
           }

           batchRows = []; batchSites = []; batchSeenIds = [];
        };

        if (startIndex === -1) {
           await closeAtEnd();
           sendState({ type: "complete", recovered: recoveredCount, audited: auditedCount, scanned: activeSites.length, pruned: prunedCount, errorCount, subrequests });
           controller.close();
           return;
        }

        const retried429Sites = new Set<number>();
        let lastCompletedId: number | null = cursor;

        for (let i = startIndex; i < activeSites.length; i++) {
          const site = activeSites[i];

          // Reserve room for the flush that must follow the last site read
          // (PHP settings, schedules, prune) and the record's update.
          if (exhausted(5)) {
             await flushBatch();
             await report(progressNow(i));
             sendState({
               type: "paused",
               cursor: lastCompletedId,
               stats: { recovered: recoveredCount, pruned: prunedCount, errors: errorCount, audited: auditedCount, total: activeSites.length },
               interval: gridPaneInterval,
               subrequests,
               msg: `Budget reached after ${auditedCount}/${activeSites.length} sites (${subrequests} subrequests spent) — resuming in a fresh pass...`
             });
             controller.close();
             return;
          }

          try {
            await paceGridPane();
            spend();
            const gpRes = await fetch(`https://my.gridpane.com/oauth/api/v1/site/${site.id}`, {
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${gpToken}`,
                'Accept': 'application/json'
              }
            });

            if (!gpRes.ok) {
              if (gpRes.status === 404) {
                 // Only a true 404 proves the site is gone remotely — safe to prune
                 spend();
                 const { error: deleteFault } = await supabase.from("sites").delete().eq("id", site.id);
                 if (!deleteFault) {
                    prunedCount++;
                    sendState({ type: "progress", completed: i + 1, total: activeSites.length, recovered: recoveredCount, errors: errorCount, msg: `Ghost Node safely pruned: ${site.url}` });
                 } else {
                    errorCount++;
                    sendState({ type: "progress", completed: i + 1, total: activeSites.length, recovered: recoveredCount, errors: errorCount, msg: `Failed to prune ghost explicitly (${deleteFault.message})` });
                 }
              }
              else if (gpRes.status === 403) {
                 errorCount++;
                 sendState({ type: "error", msg: `Fault 403 on ${site.url}: token/permission problem — site kept.` });
                 sendState({ type: "progress", completed: i + 1, total: activeSites.length, recovered: recoveredCount, errors: errorCount, msg: `Skipped ${site.url} (403 — kept)` });
              }
              else if (gpRes.status === 422) {
                 sendState({ type: "log", msg: `Fault 422 on ${site.url}: GridPane rejected the request — site kept.` });
                 sendState({ type: "progress", completed: i + 1, total: activeSites.length, recovered: recoveredCount, errors: errorCount, msg: `Skipped ${site.url} (422 — kept)` });
              }
              else if (gpRes.status === 429) {
                 if (!retried429Sites.has(site.id)) {
                    retried429Sites.add(site.id);
                    const retrySecs = parseInt(gpRes.headers.get("retry-after-endpoint") || "30", 10);
                    const pauseMs = (retrySecs * 1000) + 1000;
                    widenPacing(site.url);
                    sendState({ type: "log", msg: `[Rate Limit] Intercepted on node ${site.url}. Cooling processor for ${retrySecs}s (single retry)...` });
                    await wait(pauseMs);
                    i--; // Retry this site exactly once
                    continue;
                 }
                 // Never retry a genuine 429 more than once — retrying refreshes GridPane's cooldown
                 errorCount++;
                 sendState({ type: "error", msg: `[Rate Limit] ${site.url} rate-limited twice — skipping this site (retrying would only extend GridPane's wait).` });
                 sendState({ type: "progress", completed: i + 1, total: activeSites.length, recovered: recoveredCount, errors: errorCount, msg: `Skipped ${site.url} (429 x2)` });
              }
              else {
                 errorCount++;
                 sendState({ type: "progress", completed: i + 1, total: activeSites.length, recovered: recoveredCount, errors: errorCount, msg: `Fault ${gpRes.status}: ${site.url} (GridPane rejected access)` });
              }
              lastCompletedId = Number(site.id);
              continue;
            }

            const dataObj = await gpRes.json().catch(() => ({}));
            const gpData = dataObj.data || dataObj;

            const cfgRow = phpConfigRow(site, gpData);
            if (cfgRow) batchConfig.push(cfgRow);

            if (Array.isArray(gpData.schedule_backups)) {
              const mappedSchedules: ScheduleRow[] = gpData.schedule_backups.map((remoteSch: GridPaneRecord) => ({
                 id: remoteSch.id,
                 site_id: site.id,
                 type: remoteSch.type || "local",
                 service_id: remoteSch.service_id || null,
                 bup_schedule: remoteSch.bup_schedule || "daily",
                 hour: remoteSch.hour,
                 minute: remoteSch.minute,
                 day: remoteSch.day,
                 created_at: remoteSch.created_at || new Date().toISOString(),
                 updated_at: remoteSch.updated_at || new Date().toISOString()
              }));

              batchRows = batchRows.concat(mappedSchedules);
              batchSites.push(Number(site.id));
              batchSeenIds = batchSeenIds.concat(mappedSchedules.map(m => Number(m.id)));
              auditedCount++;

              sendState({ type: "progress", completed: i + 1, total: activeSites.length, recovered: recoveredCount + batchRows.length, errors: errorCount, msg: mappedSchedules.length > 0 ? `Read ${site.url} -> ${mappedSchedules.length} schedules (queued).` : `Read ${site.url} -> (No Schedules)` });
            } else {
              // A missing schedule_backups array is not the same as an empty
              // one — it could be a shape change upstream. Never prune on it.
              sendState({ type: "progress", completed: i + 1, total: activeSites.length, recovered: recoveredCount, errors: errorCount, msg: `Read ${site.url} -> (no schedule data returned; left as-is)` });
            }

            lastCompletedId = Number(site.id);

            if (batchSites.length >= FLUSH_EVERY || batchConfig.length >= FLUSH_EVERY) {
               await flushBatch();
               await report(progressNow(i + 1));
            }

          } catch (err) {
             errorCount++;
             lastCompletedId = Number(site.id);
             sendState({ type: "progress", completed: i + 1, total: activeSites.length, recovered: recoveredCount, errors: errorCount, msg: `Fault reading ${site.id}: ${(err as { message?: string }).message}` });
          }

        }

        await flushBatch();
        await closeAtEnd();

        // Spend is reported so the real ceiling can be read off a live run
        // (see SUBREQUEST_BUDGET).
        sendState({ type: "complete", recovered: recoveredCount, audited: auditedCount, scanned: activeSites.length, pruned: prunedCount, errorCount, subrequests });
        controller.close();

      } catch (err) {
        // Anything that ends a pass early is a failed sync, not a log line.
        const msg = (err as { message?: string } | null)?.message || "Internal server error";
        if (runId) await closeSyncRun(runs, runId, "failed", { message: msg }).catch(() => null);
        sendState({ type: "failed", msg });
        controller.close();
      }
    }
  });

  return screenPatchstackResponse((new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    }
  })), req, psProtection);
}
