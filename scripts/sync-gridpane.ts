import { createClient } from "@supabase/supabase-js";
import * as dotenv from 'dotenv';
import { resolve } from 'path';
import { scheduleField } from "../lib/backup-schedules.ts";
import { cachingColumns, cachingFromRecord } from "../lib/site-caching.ts";
import { ago, closeSyncRun, finishedStatus, openSyncRun, touchSyncRun, type SyncDb, type SyncProgress } from "../lib/sync-runs.ts";

// Load .env.local mapped environment variables
dotenv.config({ path: resolve(process.cwd(), '.env.local') });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GRIDPANE_TOKEN = process.env.GRIDPANE_API_TOKEN;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !GRIDPANE_TOKEN) {
  console.error("Missing critical environment variables. Ensure .env.local has NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and GRIDPANE_API_TOKEN.");
  process.exit(1);
}

// Bypass Row Level Security using the Service Role Key
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const API_BASE = "https://my.gridpane.com/oauth/api/v1";

/**
 * GridPane rate limits (read from its response headers):
 *   x-ratelimit-endpoint-limit: 12  — per ROUTE, per minute. Every /site/{id} call
 *                                     draws from this same bucket regardless of id.
 *   x-ratelimit-total-limit:    60  — across all routes, per minute.
 * The window resets after ~60s.
 *
 * Retrying a 429 refreshes GridPane's cooldown rather than clearing it (see
 * docs/gridpane-api-v1-findings.md §4), so the strategy is to STAY UNDER the
 * limit rather than to recover from hitting it: pace requests just below the
 * endpoint budget, and when the remaining count runs out, wait for the window.
 */
const ENDPOINT_BUDGET_MS = 5500; // ~11 req/min against a 12/min endpoint cap
const WINDOW_RESET_MS = 62000;

/**
 * GridPane honors ?per_page, and the 12/min cap counts REQUESTS, not records — so
 * asking for large pages is the cheapest possible win. At the default 10/page a
 * long list can blow the budget mid-run; at 100/page it arrives in a few requests.
 */
const PER_PAGE = 100;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Last-resort net for when the endpoint budget is genuinely exhausted.
 *
 * Pacing at ENDPOINT_BUDGET_MS already keeps us under the cap, so this should not
 * fire in normal operation. It deliberately triggers at 0 rather than 1: because
 * the pace sits just below the limit, `remaining` dips to 1 routinely, and pausing
 * there added a 62s stall every ~11 requests — roughly doubling the total runtime
 * for no benefit.
 */
async function respectRateLimit(res: Response, label: string) {
  const remaining = Number(res.headers.get("x-ratelimit-endpoint-remaining"));
  if (Number.isFinite(remaining) && remaining <= 0) {
    console.log(`   [rate limit] ${label}: endpoint budget spent — waiting ${WINDOW_RESET_MS / 1000}s for the window to reset...`);
    await sleep(WINDOW_RESET_MS);
  }
}

class RateLimitedError extends Error {}
class SyncWriteError extends Error {}
class SyncBusyError extends Error {}

// The sync's record (public.sync_runs), which the app's top bar, its setup page and
// npm run sync:status read. Null when it could not be started (no table yet).
let runId: string | null = null;
const runs = supabase as unknown as SyncDb;

async function report(progress: SyncProgress) {
  if (!runId) return;
  const err = await touchSyncRun(runs, runId, progress);
  if (err) console.warn(`[!] The sync record was not updated: ${err}`);
}

async function finish(status: "complete" | "partial" | "failed" | "stopped", progress: SyncProgress) {
  if (!runId) return;
  const id = runId;
  runId = null;
  const err = await closeSyncRun(runs, id, status, progress);
  if (err) console.warn(`[!] The sync record was not closed: ${err}`);
}

/**
 * One object from GridPane's API (a server, a site). Nothing checks GridPane's
 * answer against a schema, so a field is whatever GridPane sent: it is copied
 * into the database as it came, and code that needs a type says so where it reads.
 */
type GridPaneRecord = { id: number | string; [field: string]: unknown };

async function fetchAllPages<T = GridPaneRecord>(endpoint: string): Promise<T[]> {
  const allData: T[] = [];
  let currentPage = 1;
  let hasMore = true;

  console.log(`\nStarting extraction of [${endpoint}]...`);

  while (hasMore) {
    const url = `${API_BASE}/${endpoint}?per_page=${PER_PAGE}&page=${currentPage}`;
    console.log(`Fetching page ${currentPage}...`);

    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${GRIDPANE_TOKEN}`,
        'Accept': 'application/json'
      }
    });

    // A 429 body is not a data array. The previous version skipped this check and
    // fed the error body into the array parse below, which produced an empty page
    // and was read as "no more results" — so pagination stopped early and the sync
    // silently persisted a PARTIAL list. Fail loudly instead: a truncated sync that
    // reports success is worse than one that stops.
    if (!res.ok) {
      if (res.status === 429) {
        throw new RateLimitedError(
          `GridPane refused [${endpoint}] page ${currentPage} (HTTP 429: too many requests). Nothing from that list was saved; what earlier steps saved stays saved.`
        );
      }
      throw new Error(`Failed to fetch [${endpoint}] page ${currentPage}: HTTP ${res.status}`);
    }

    const json = await res.json();
    const currentPayload = Array.isArray(json?.data) ? json.data : (json?.data?.data || []);
    const lastPage = json?.meta?.last_page ?? json?.last_page ?? null;

    allData.push(...currentPayload);

    // Prefer the authoritative page count; fall back to the short-page heuristic.
    if (lastPage !== null) {
      hasMore = currentPage < lastPage;
    } else {
      hasMore = currentPayload.length > 0 && json.next_page_url !== null;
    }

    if (hasMore) {
      currentPage++;
      await respectRateLimit(res, endpoint);
      // Pagination draws from the same 12/min endpoint bucket as everything else,
      // so it has to be paced identically. A 1s page delay (60/min) is what blew
      // the budget on the multi-page domain endpoint.
      await sleep(ENDPOINT_BUDGET_MS);
    }
  }

  console.log(`Extracted ${allData.length} record(s) from [${endpoint}].`);
  return allData;
}

async function syncGridPane() {
  console.log("=========================================");
  console.log("Initializing Fleet -> GridPane Sync");
  console.log("=========================================");

  // One sync at a time, whether it was started here, by cron or in the app.
  const opened = await openSyncRun(runs, { source: "cli" });
  if (opened.ok) {
    runId = opened.run.id;
  } else if (opened.busy) {
    const b = opened.busy;
    const from = b.source === "cli" ? "from the command line" : "in the app";
    const progress = b.sites_total ? ` It has read ${b.sites_done} of ${b.sites_total} sites.` : "";
    throw new SyncBusyError(`A sync is already running: started ${from} ${ago(b.started_at, Date.now())}.${progress} Only one runs at a time; nothing was read. Watch it with: npm run sync:status -- --watch`);
  } else {
    console.warn(`[!] This sync is not recorded, so the app cannot show it: ${opened.error}`);
    console.warn("    Apply supabase/migrations/20261124000000_sync_runs.sql (SETUP.md, step 4).");
  }

  // 1. Sync Servers
  const rawServers = await fetchAllPages("server");
  console.log(`\nParsing and pushing ${rawServers.length} Servers into Supabase...`);
  
  if (rawServers.length > 0) {
    // Fetch existing servers to safely preserve any manual hardware overrides the user input for un-mapped nodes (e.g. Hetzner)
    const { data: existingServers } = await supabase.from('servers').select('id, cpu, ram');
    const existingMap = new Map(existingServers?.map((s) => [s.id, s]) || []);

    // Map raw server payloads identically to the PostgreSQL table structure
    const mappedServers = rawServers.map((s) => {
      const existing = existingMap.get(s.id);
      
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

    const { error: sErr } = await supabase.from('servers').upsert(mappedServers, { onConflict: 'id' });
    // A rejected write fails the sync. It used to be logged and the run carried
    // on to "Sync complete", so nobody noticed the table had stopped updating.
    if (sErr) throw new SyncWriteError(`Servers were not saved: ${sErr.message} (${sErr.code})`);
    console.log(`Successfully synced ${mappedServers.length} Servers.`);
  }
  await report({ phase: "sites", servers_saved: rawServers.length });

  // 2. Sync Domains for Cloudflare DNS bindings
  const rawDomains = await fetchAllPages<{ site_id?: number | string | null; dns_api?: { integration_name?: string; provider?: { name?: string } } | null }>("domain");
  console.log(`\nParsing mappings across ${rawDomains.length} Domains...`);
  const domainDnsMap = new Map<string, string>();
  
  rawDomains.forEach((d) => {
    if (d.site_id && d.dns_api && d.dns_api.integration_name) {
      // Only overriding if it specifically belongs to a known Cloudflare configuration payload
      if (d.dns_api.provider?.name?.toLowerCase().includes('cloudflare')) {
        domainDnsMap.set(String(d.site_id), d.dns_api.integration_name);
      }
    }
  });

  // 3. Sync Sites
  const rawSites = await fetchAllPages<GridPaneRecord & { url: string; server?: { id?: number } | null; site_customizer?: { is_php_slowlog?: unknown; php_slowlog_timeout?: unknown; php_slowlog_trace_depth?: unknown } | null }>("site");
  console.log(`\nParsing and pushing ${rawSites.length} Sites into Supabase...`);
  
  if (rawSites.length > 0) {
    const mappedSites = rawSites.map((site) => ({
      id: site.id,
      url: site.url,
      server_id: site.server_id || (site.server && site.server.id) || null,
      user_id: site.user_id,
      system_user_id: site.system_user_id,
      is_wsod: site.is_wsod,
      is_sso: site.is_sso,
      is_ssl: site.is_ssl,
      ssl_status: site.ssl_status,
      resolved_at: site.resolved_at,
      php_version: site.php_version,
      waf: site.waf,
      remote_bup: site.remote_bup,
      local_bup: site.local_bup,
      automatic_updates: site.automatic_updates,
      nginx_caching: site.nginx_caching,
      site_security_settings: site.site_security_settings ? JSON.stringify(site.site_security_settings) : null,
      site_customizer: site.site_customizer ? JSON.stringify(site.site_customizer) : null,
      cloudflare_dns_name: domainDnsMap.get(String(site.id)) || null,
      built_at: site.built_at,
      staging_site_built_at: site.staging_site_built_at,
      max_execution_time: site.max_execution_time || null,
      max_file_uploads: site.max_file_uploads || null,
      max_input_time: site.max_input_time || null,
      max_input_vars: site.max_input_vars || null,
      memory_limit: site.memory_limit || null,
      post_max_size: site.post_max_size || null,
      upload_max_filesize: site.upload_max_filesize || null,
      pm: site.pm || null,
      pm_max_children: site.pm_max_children || null,
      pm_start_servers: site.pm_start_servers || null,
      pm_max_requests: site.pm_max_requests || null,
      pm_process_idle_timeout: site.pm_process_idle_timeout || null,
      is_php_slowlog: site.site_customizer ? site.site_customizer.is_php_slowlog : null,
      php_slowlog_timeout: site.site_customizer ? site.site_customizer.php_slowlog_timeout : null,
      php_slowlog_trace_depth: site.site_customizer ? site.site_customizer.php_slowlog_trace_depth : null
    }));

    // One address can be on two servers. GridPane's site-migration tool gives the moved
    // site a new id on the new server and keeps the old record on the old one
    // as the way back, so the list carries the same url twice. Each record is
    // its own row, keyed by GridPane's id (see supabase/migrations/20261120000000_baseline.sql).
    const urlCount = new Map<string, number>();
    for (const s of mappedSites) urlCount.set(s.url, (urlCount.get(s.url) ?? 0) + 1);
    const doubled = [...urlCount.values()].filter((n) => n > 1).length;

    const { data: before, error: beforeErr } = await supabase.from('sites').select('id, url, site_nickname');
    if (beforeErr) throw new SyncWriteError(`Could not read the stored sites: ${beforeErr.message}`);
    const storedIds = new Set((before ?? []).map((r) => Number(r.id)));

    const payload: Record<string, unknown>[] = mappedSites;

    const { error: err } = await supabase.from('sites').upsert(payload, { onConflict: 'id' });
    if (err) throw new SyncWriteError(`Sites were not saved: ${err.message} (${err.code})`);
    console.log(`Saved ${mappedSites.length} site records: ${urlCount.size} addresses, ${doubled} of them on two servers.`);

    // A new record for an address Fleet already knows (a moved site) starts
    // without the nickname, which is set here, not in GridPane. Carry it over.
    const nickByUrl = new Map<string, string>();
    for (const r of before ?? []) if (r.site_nickname) nickByUrl.set(r.url, r.site_nickname);
    for (const s of mappedSites) {
      const nick = nickByUrl.get(s.url);
      if (!nick || storedIds.has(Number(s.id))) continue;
      const { error: nickErr } = await supabase.from('sites').update({ site_nickname: nick }).eq('id', s.id);
      if (nickErr) console.warn(`[!] Nickname not copied to ${s.url} (${s.id}): ${nickErr.message}`);
      else console.log(`Copied nickname "${nick}" to the new record for ${s.url} (${s.id}).`);
    }

    // Remove rows GridPane no longer lists: a moved site's old copy disappears
    // from the old server once it is deleted in GridPane. Safe to do here because
    // fetchAllPages throws on any refused page, so this list is complete. Deleting
    // a site also deletes its backup schedules, backup history, IP blocks and
    // staging state (ON DELETE CASCADE).
    const liveIds = new Set(mappedSites.map((s) => Number(s.id)));
    const gone = (before ?? []).filter((r) => !liveIds.has(Number(r.id)));
    if (gone.length > 0) {
      // Guard against an upstream answer that is complete-looking but wrong
      // (a token for another account, an API change): never wipe out most of the fleet.
      if (gone.length > (before ?? []).length / 2) {
        throw new SyncWriteError(
          `Refusing to remove ${gone.length} of ${(before ?? []).length} stored sites that GridPane did not list. Check the GridPane token and the API before re-running.`
        );
      }
      const { error: delErr } = await supabase.from('sites').delete().in('id', gone.map((r) => r.id));
      if (delErr) throw new SyncWriteError(`Sites GridPane no longer lists were not removed: ${delErr.message}`);
      console.log(`Removed ${gone.length} site record(s) GridPane no longer lists: ${gone.map((r) => `${r.url} (${r.id})`).join(', ')}`);
    }

    // Read the table back: the count stored is the proof, not the write's lack of an error.
    const { count: storedCount, error: countErr } = await supabase.from('sites').select('id', { count: 'exact', head: true });
    if (countErr) throw new SyncWriteError(`Could not count stored sites: ${countErr.message}`);
    console.log(`Sites table now holds ${storedCount} rows; GridPane lists ${mappedSites.length}.`);
    if (storedCount !== mappedSites.length) {
      throw new SyncWriteError(`Sites table holds ${storedCount} rows but GridPane lists ${mappedSites.length}.`);
    }
  }

  // 4. Sync Backup Schedules natively bound directly to Site objects
  if (rawSites.length > 0) {
    const mappedBackups: Record<string, unknown>[] = [];
    let detailFailures = 0;
    await report({ phase: "details", sites_total: rawSites.length, sites_done: 0 });
    const estMinutes = Math.ceil((rawSites.length * ENDPOINT_BUDGET_MS) / 60000);
    console.log(`\nReading backup schedules + PHP config from ${rawSites.length} site endpoints.`);
    console.log(`GridPane allows 12 requests/min on this route, so this paces at one per ${ENDPOINT_BUDGET_MS / 1000}s — roughly ${estMinutes} minute(s).`);

    for (const [index, site] of rawSites.entries()) {
      if (index > 0 && index % 10 === 0) {
        await report({ sites_done: index, sites_read: index - detailFailures, schedules: mappedBackups.length, errors: detailFailures });
      }
      // Pace just under the 12/min endpoint budget. A short fixed delay (1.5s,
      // ~40/min) is over triple the cap: the run would 429 after ~12 sites and
      // every remaining site would silently fail.
      await sleep(ENDPOINT_BUDGET_MS);

      try {
        const siteUrl = `${API_BASE}/site/${site.id}`;
        const siteRes = await fetch(siteUrl, {
          headers: {
            Authorization: `Bearer ${GRIDPANE_TOKEN}`,
            Accept: "application/json",
          },
        });

        if (!siteRes.ok) {
          detailFailures++;
          console.warn(`[!] Site ${site.id} (${site.url}): HTTP ${siteRes.status}`);
          if (siteRes.status === 429) {
            // Don't burn the rest of the fleet against a closed window — wait it out.
            console.log(`   [rate limit] cooling ${WINDOW_RESET_MS / 1000}s before continuing...`);
            await sleep(WINDOW_RESET_MS);
          }
          continue; // Skip this node rather than recording a false absence.
        }

        await respectRateLimit(siteRes, `site/${site.id}`);

        if ((index + 1) % 10 === 0) {
          console.log(`   ...${index + 1}/${rawSites.length} sites read`);
        }

        const siteJson = await siteRes.json();
        const singleSite = siteJson.data || siteJson;

        // Backfill PHP config from the detail payload. The list endpoint is not
        // reliably complete — a rate-limited page silently leaves sites stale, and
        // some rows come back without INI/FPM values at all. We already pay for this
        // detail request to read backups, so harvest the config from it too: zero
        // extra API calls, and it self-heals anything the list pass missed.
        const cfg: Record<string, unknown> = {};
        const numericFields = [
          'max_execution_time', 'max_file_uploads', 'max_input_time', 'max_input_vars',
          'memory_limit', 'post_max_size', 'upload_max_filesize',
          'pm_max_children', 'pm_start_servers', 'pm_max_requests', 'pm_process_idle_timeout'
        ];
        for (const f of numericFields) {
          const v = singleSite[f];
          if (v !== undefined && v !== null && v !== '') cfg[f] = Number(v);
        }
        if (singleSite.php_version) cfg.php_version = String(singleSite.php_version);
        if (singleSite.pm) cfg.pm = String(singleSite.pm);

        // The caching settings, from the same record. Only alongside real PHP values: a
        // reply in another shape must not write "no page cache" over a site that has one.
        if (Object.keys(cfg).length > 0) Object.assign(cfg, cachingColumns(cachingFromRecord(singleSite)));

        if (Object.keys(cfg).length > 0) {
          const { error: cfgErr } = await supabase.from('sites').update(cfg).eq('id', site.id);
          if (cfgErr) console.warn(`[!] Config backfill failed for site ${site.id}: ${cfgErr.message}`);
        }

        if (singleSite.schedule_backups && Array.isArray(singleSite.schedule_backups)) {
          singleSite.schedule_backups.forEach((bup: GridPaneRecord) => {
            mappedBackups.push({
              id: bup.id,
              site_id: bup.site_id,
              type: bup.type,
              service_id: bup.service_id,
              bup_schedule: bup.bup_schedule,
              hour: scheduleField(bup.hour),
              minute: scheduleField(bup.minute),
              day: scheduleField(bup.day),
              created_at: bup.created_at,
              updated_at: bup.updated_at
            });
          });
        }
      } catch (err) {
        detailFailures++;
        console.error(`[!] Execution error on site ${site.id}:`, err);
        // Safe continuation avoiding false-state overwrites. Counted as a site not
        // read, so the ghost prune below is skipped for this run.
      }
    }

    if (mappedBackups.length > 0) {
      console.log(`\nParsing and pushing ${mappedBackups.length} Backup Schedules into Supabase...`);
      const { error: bErr } = await supabase.from('backup_schedules').upsert(mappedBackups, { onConflict: 'id' });
      if (bErr) throw new SyncWriteError(`Backup schedules were not saved: ${bErr.message} (${bErr.code})`);
      else {
        console.log(`Successfully synced ${mappedBackups.length} Backup Schedules.`);

        // Only prune ghosts when EVERY site was read successfully. The old guard
        // ("more than 50 schedules") could pass on a partially rate-limited run —
        // schedules belonging to the sites we failed to read would look like ghosts
        // and be deleted. Absence of evidence is not evidence of absence.
        if (detailFailures === 0) {
          const liveIds = mappedBackups.map(b => b.id);
          console.log("Pruning schedules that no longer exist upstream...");
          const { error: delErr } = await supabase.from('backup_schedules').delete().not('id', 'in', `(${liveIds.join(',')})`);
          if (delErr) console.error("Error pruning stale schedules:", delErr);
          else console.log("Stale schedule records removed.");
        } else {
          console.log(`Skipping ghost prune — ${detailFailures} site(s) could not be read, so the schedule list is incomplete.`);
        }
      }
    }

    const sitesRead = rawSites.length - detailFailures;
    const status = finishedStatus({ sitesTotal: rawSites.length, sitesRead, errors: 0 });
    await finish(status, {
      sites_total: rawSites.length, sites_done: rawSites.length, sites_read: sitesRead,
      schedules: mappedBackups.length, errors: detailFailures,
      message: status === "complete" ? `Read all ${rawSites.length} sites.` : `Read ${sitesRead} of ${rawSites.length} sites; ${detailFailures} not read.`,
    });
    if (detailFailures > 0) {
      console.log(`\nSync finished, except ${detailFailures} site(s) that could not be read (the [!] lines above). What was read is saved. Run it again in a few minutes to read the rest.`);
      process.exitCode = 2;
      return;
    }
  }

  // NOTE: this script used to delete every backup_history row on each run. That was a
  // one-off cleanup of seeded dummy data, but it stayed in the sync path — so any real
  // execution history would be destroyed the next time anyone synced. Removed
  // deliberately: a sync reads upstream state, it does not erase local history.
  // To clear seeded rows again, do it once by hand rather than on every run.

  await finish("complete", { sites_total: 0, sites_done: 0, message: "GridPane lists no sites." });
  console.log("\nSync complete.");
}

// Ctrl-C: close the record, so the app does not show a sync running for six more minutes.
process.once("SIGINT", () => {
  console.error("\n[STOPPED] Interrupted. What was saved stays saved.");
  void finish("stopped", { message: "Interrupted on the command line." }).finally(() => process.exit(130));
});

syncGridPane().catch((err) => {
  // A rate-limited pagination pass discards partial data rather than persisting a
  // truncated fleet. Surface it as a real failure so a half-finished run can never
  // be mistaken for a successful one.
  if (err instanceof SyncBusyError) {
    console.error(`\n[BUSY] ${err.message}`);
    process.exitCode = 1;
    return;
  }
  void finish("failed", { message: err instanceof Error ? err.message : String(err) });
  if (err instanceof RateLimitedError) {
    console.error(`\n[ABORTED] ${err.message}`);
    console.error("GridPane allows about 12 requests a minute, shared by everything that uses this token (npm run doctor too). Retrying at once extends the wait. Wait a minute or two, then run it again.");
  } else if (err instanceof SyncWriteError) {
    console.error(`\n[FAILED] ${err.message}`);
  } else {
    console.error("\n[FAILED]", err);
  }
  process.exitCode = 1;
});
