/**
 * PHP's code cache (OPcache): one cache per PHP version on a server, shared by
 * every site on that version.
 *
 * Everything here is worked out from what the server's agent reports
 * (scripts/telemetry-agent.sh, "PHP code cache"; stored as defined in supabase/migrations/20261120000000_baseline.sql).
 * The agent reports facts; the words, the thresholds and the recommendations
 * are made here so they can be tested (scripts/test-opcache-status.ts).
 *
 * The dashboard never changes a server. A recommendation is the command for a
 * person to run, nothing more.
 */
// Self-contained on purpose: the test runs this file with node's type stripping,
// which resolves no path aliases.
const REPORT_INTERVAL_MINUTES = 10;
const MB = 1024 * 1024;

export type Tone = "neutral" | "ok" | "warn" | "danger";

// ── shapes (as the agent reports them) ──────────────────────────────────────

export type OpcIni = {
  enable: number | null;
  memory_mb: number | null;
  interned_mb: number | null;
  max_files: number | null;
  validate: number | null;
  reval: number | null;
};

export type OpcSite = { site: string; scripts: number; bytes: number };

export type OpcLive = {
  enabled: boolean;
  full: boolean;
  mem: { used: number; free: number; wasted: number };
  str: { size: number; used: number; free: number; n: number };
  scripts: number;
  keys: number;
  max_keys: number;
  hits: number;
  misses: number;
  oom: number;
  hash: number;
  manual: number;
  cfg: { memory_mb: number; interned_mb: number; max_files: number; validate: number; reval: number; max_wasted: number; jit: string };
  php: string;
  start: string | null;
  last_restart: string | null;
  by_site: OpcSite[];
  sites_cut: boolean;
};

export type PhpOpcacheRow = {
  server_id: number;
  php_version: string;
  reported_at: string;
  pools: number;
  sites: string[];
  ini: OpcIni | null;
  live: OpcLive | null;
  live_error: string | null;
  prev: { hits: number; misses: number; at: string } | null;
};

export type ServerOpcacheRow = { server_id: number; reported_at: string; agent_format: number };

// ── thresholds ──────────────────────────────────────────────────────────────

export const NEARLY_FULL_PCT = 85;
export const FULL_PCT = 95;
export const KEYS_WARN_PCT = 75;
export const KEYS_FULL_PCT = 90;
export const WASTED_WARN_PCT = 15;
export const HIT_RATE_WARN_PCT = 90;
export const STAGING_SHARE_PCT = 25;
export const SETTLING_MINUTES = 30;
/** Fewer requests than this in the window and a hit rate means nothing. */
export const RECENT_MIN_REQUESTS = 500;

const MEMORY_STEPS = [128, 256, 384, 512, 768, 1024, 1536, 2048];
const FILE_STEPS = [10000, 20000, 40000, 60000, 100000];
const INTERNED_STEPS = [16, 32, 64, 128];

// ── small helpers ───────────────────────────────────────────────────────────

const pct = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);
const whole = (n: number) => Math.round(n).toLocaleString("en-US");

/** 133,169,152 → "127 MB"; small sizes keep one decimal so 0.4 MB is not "0 MB". */
export function mbText(bytes: number): string {
  const mb = bytes / MB;
  return `${mb >= 10 || mb === 0 ? whole(mb) : mb.toFixed(1)} MB`;
}

export function pctText(value: number): string {
  if (value > 0 && value < 1) return "under 1%";
  if (value > 99 && value < 100) return "over 99%";
  return `${Math.round(value)}%`;
}

function nextStep(steps: number[], current: number, atLeast = 0): number {
  const floor = Math.max(current + 1, atLeast);
  return steps.find((s) => s >= floor) ?? Math.ceil(floor / steps[0]) * steps[0];
}

/** A report is only as good as it is recent; the agent reports every ten minutes. */
export function reportStale(reportedAt: string | null | undefined, now: Date): boolean {
  if (!reportedAt) return true;
  const minutes = (now.getTime() - new Date(reportedAt).getTime()) / 60_000;
  return !Number.isFinite(minutes) || minutes > REPORT_INTERVAL_MINUTES * 2;
}

// ── measurements ────────────────────────────────────────────────────────────

export type Usage = {
  totalBytes: number;
  usedBytes: number;
  wastedBytes: number;
  freeBytes: number;
  /** Used plus wasted: wasted space cannot take new code either. */
  takenPct: number;
  wastedPct: number;
  keysPct: number;
  internedPct: number;
};

export function usage(live: OpcLive): Usage {
  const total = live.mem.used + live.mem.free + live.mem.wasted;
  return {
    totalBytes: total,
    usedBytes: live.mem.used,
    wastedBytes: live.mem.wasted,
    freeBytes: live.mem.free,
    takenPct: pct(live.mem.used + live.mem.wasted, total),
    wastedPct: pct(live.mem.wasted, total),
    keysPct: pct(live.keys, live.max_keys),
    internedPct: pct(live.str.used, live.str.size),
  };
}

/** Share of requests served from the cache since PHP last started; null before any request. */
export function lifetimeHitRate(live: OpcLive): number | null {
  const total = live.hits + live.misses;
  return total > 0 ? pct(live.hits, total) : null;
}

/** The same, for the time between the last two reports. Null when there is no earlier report from this PHP run, or too few requests to mean anything. */
export function recentHitRate(row: PhpOpcacheRow): { rate: number; requests: number; minutes: number } | null {
  if (!row.live || !row.prev) return null;
  const hits = row.live.hits - row.prev.hits;
  const misses = row.live.misses - row.prev.misses;
  const requests = hits + misses;
  if (hits < 0 || misses < 0 || requests < RECENT_MIN_REQUESTS) return null;
  const minutes = Math.max(1, Math.round((new Date(row.reported_at).getTime() - new Date(row.prev.at).getTime()) / 60_000));
  return { rate: pct(hits, requests), requests, minutes };
}

/** Minutes since PHP last started or emptied its cache, whichever is later. */
export function minutesRunning(live: OpcLive, now: Date): number | null {
  const times = [live.start, live.last_restart].filter((t): t is string => Boolean(t)).map((t) => new Date(t).getTime());
  if (times.length === 0) return null;
  const minutes = (now.getTime() - Math.max(...times)) / 60_000;
  return Number.isFinite(minutes) ? Math.max(0, minutes) : null;
}

export function settling(live: OpcLive, now: Date): boolean {
  const m = minutesRunning(live, now);
  return m !== null && m < SETTLING_MINUTES;
}

export type SiteShare = OpcSite & { sharePct: number; staging: boolean; hasPool: boolean };

const isStaging = (site: string) => site.startsWith("staging.");

/**
 * Each site's part of the cached code, largest first. A site with a pool on
 * this PHP version and nothing cached is listed with zero: it has had no
 * visitors since PHP started, or its code was pushed out.
 */
export function siteShares(row: PhpOpcacheRow): SiteShare[] {
  const cached = row.live?.by_site ?? [];
  const total = cached.reduce((sum, s) => sum + s.bytes, 0);
  const pools = new Set(row.sites);
  const out: SiteShare[] = cached.map((s) => ({ ...s, sharePct: pct(s.bytes, total), staging: isStaging(s.site), hasPool: pools.has(s.site) }));
  const seen = new Set(cached.map((s) => s.site));
  for (const site of row.sites) {
    if (!seen.has(site)) out.push({ site, scripts: 0, bytes: 0, sharePct: 0, staging: isStaging(site), hasPool: true });
  }
  return out.sort((a, b) => b.bytes - a.bytes || a.site.localeCompare(b.site));
}

/**
 * No site runs on this PHP version. GridPane keeps every installed PHP version
 * running with two stock pools of its own, and its tools (phpMyAdmin, on the
 * server's own *.gridpanevps.com address) use one of them, so a version can
 * answer with a nearly empty cache and still be nobody's concern.
 */
export function unused(row: PhpOpcacheRow): boolean {
  if (row.sites.length > 0) return false;
  if (!row.live) return row.live_error === "no_pool" || row.pools <= 2;
  return !row.live.by_site.some((s) => s.site !== "other" && !s.site.endsWith(".gridpanevps.com"));
}

/** Sites with a pool here whose code is in the cache in any real amount. */
const CACHED_MIN_BYTES = 5 * MB;
export function sitesCached(row: PhpOpcacheRow): number {
  const pools = new Set(row.sites);
  return (row.live?.by_site ?? []).filter((s) => pools.has(s.site) && s.bytes >= CACHED_MIN_BYTES).length;
}

// ── why the live numbers are missing ────────────────────────────────────────

export function liveErrorText(error: string | null): string {
  const e = error ?? "";
  if (e === "no_pool") return "No site runs on this PHP version, so there is no running PHP to ask. Only the settings are shown.";
  if (e === "off") return "The code cache is switched off for this PHP version (opcache.enable is 0), so every request compiles its PHP from scratch.";
  if (e === "not_loaded") return "This PHP version runs without the OPcache extension, so nothing is cached.";
  if (e === "refused") return "PHP refused to give its cache numbers (opcache.restrict_api or a disabled function).";
  if (e === "probe_not_written") return "The agent could not write its small read-only PHP file on the server, so it could not ask.";
  if (e === "out_of_time") return "The agent ran out of time before it could ask this PHP version.";
  if (e.startsWith("no_answer")) return "PHP did not answer on its socket. It may be stopped, or restarting.";
  if (e.startsWith("blocked")) return `PHP would not run the agent's read-only file: ${e.slice(8).trim() || "no reason given"}.`;
  return "The live numbers could not be read.";
}

// ── findings and recommendations ────────────────────────────────────────────

export type Finding = {
  key: "off" | "unseen" | "memory" | "oom" | "files" | "hash" | "interned" | "wasted" | "staging" | "hit-rate" | "not-reloaded";
  tone: "warn" | "danger";
  title: string;
  detail: string;
  /** Commands for a person to run as root on the server. Never run from here. */
  commands?: string[];
};

const RAM_NOTE = "The cache is taken from the server's RAM, so check free memory first.";

function memoryCommand(version: string, mbValue: number) {
  return `gp stack php ${version} -opcache-memory ${mbValue}`;
}

/** What is wrong with this PHP version's cache, most serious first. Empty means nothing found, which only counts when the live numbers were read. */
export function findings(row: PhpOpcacheRow, now: Date): Finding[] {
  const v = row.php_version;
  const out: Finding[] = [];
  const live = row.live;

  if (unused(row)) return out; // nothing runs on it: nothing to fix
  if (!live) {
    const off = row.live_error === "off" || row.live_error === "not_loaded";
    out.push({
      key: off ? "off" : "unseen",
      tone: off ? "danger" : "warn",
      title: off ? "The code cache is off" : "Cannot see the live numbers",
      detail: liveErrorText(row.live_error),
    });
    return out;
  }
  if (!live.enabled) {
    out.push({ key: "off", tone: "danger", title: "The code cache is off", detail: liveErrorText("off") });
    return out;
  }

  const u = usage(live);
  const sharing = `${row.sites.length === 1 ? "The one site" : `All ${row.sites.length} sites`} on PHP ${v}`;

  // Memory
  if (live.full || u.takenPct >= FULL_PCT) {
    // What is cached now is only what fitted. When some sites have little or no
    // code in the cache, scale up by the sites left out; it is a guess, and says so.
    const cached = sitesCached(row);
    const leftOut = row.sites.length - cached;
    const usedMb = live.mem.used / MB;
    const need = leftOut > 0 && cached > 0 ? usedMb * (row.sites.length / cached) : usedMb / 0.6;
    const target = nextStep(MEMORY_STEPS, live.cfg.memory_mb, Math.ceil(need));
    out.push({
      key: "memory",
      tone: "danger",
      title: "The cache is full",
      detail: `${mbText(live.mem.used + live.mem.wasted)} of ${mbText(u.totalBytes)} is taken, so new PHP files are not cached and are compiled again on every request. ${sharing} ${row.sites.length === 1 ? "is" : "are"} affected.${
        live.oom > 0 ? ` PHP has emptied the cache ${live.oom === 1 ? "once" : `${live.oom} times`} for lack of room since it started.` : ""
      }${
        leftOut > 0 && row.sites.length > 1
          ? ` Only ${cached} of the ${row.sites.length} sites ${cached === 1 ? "has" : "have"} code in the cache; the rest did not fit. Raise it to ${target} MB, a guess scaled from the sites that did fit, and look again a day later.`
          : ` Raise it to ${target} MB.`
      } ${RAM_NOTE}`,
      commands: [memoryCommand(v, target)],
    });
  } else if (u.takenPct >= NEARLY_FULL_PCT) {
    const target = nextStep(MEMORY_STEPS, live.cfg.memory_mb);
    out.push({
      key: "memory",
      tone: "warn",
      title: "The cache is nearly full",
      detail: `${pctText(u.takenPct)} of ${mbText(u.totalBytes)} is taken. One more plugin update or a new site on PHP ${v} could fill it. Raising it to ${target} MB gives room. ${RAM_NOTE}`,
      commands: [memoryCommand(v, target)],
    });
  } else if (live.oom > 0) {
    const target = nextStep(MEMORY_STEPS, live.cfg.memory_mb);
    out.push({
      key: "oom",
      tone: "warn",
      title: "The cache has run out of room before",
      detail: `It has space now, but PHP has emptied it ${live.oom === 1 ? "once" : `${live.oom} times`} for lack of room since it started. Each time, every site on PHP ${v} was slow until the cache refilled. Raising it to ${target} MB should stop that. ${RAM_NOTE}`,
      commands: [memoryCommand(v, target)],
    });
  }

  // File limit
  const fileTarget = nextStep(FILE_STEPS, live.cfg.max_files, Math.ceil(live.keys * 1.5));
  const fileCommand = `gp stack php ${v} -opcache-max-accel-files ${fileTarget}`;
  if (u.keysPct >= KEYS_FULL_PCT) {
    out.push({
      key: "files",
      tone: "danger",
      title: "The file limit is reached",
      detail: `${whole(live.keys)} of ${whole(live.max_keys)} file slots are in use (the setting is ${whole(live.cfg.max_files)}; PHP rounds it up). Past the limit, files are not cached even when there is memory free. Raise it to ${whole(fileTarget)}.`,
      commands: [fileCommand],
    });
  } else if (u.keysPct >= KEYS_WARN_PCT || live.hash > 0) {
    out.push({
      key: live.hash > 0 && u.keysPct < KEYS_WARN_PCT ? "hash" : "files",
      tone: "warn",
      title: live.hash > 0 && u.keysPct < KEYS_WARN_PCT ? "The file limit has been hit before" : "The file limit is close",
      detail:
        live.hash > 0 && u.keysPct < KEYS_WARN_PCT
          ? `PHP has emptied the cache ${live.hash === 1 ? "once" : `${live.hash} times`} since it started because the file slots ran out. Raising the limit to ${whole(fileTarget)} should stop that.`
          : `${whole(live.keys)} of ${whole(live.max_keys)} file slots are in use. Raising the limit to ${whole(fileTarget)} gives room.`,
      commands: [fileCommand],
    });
  }

  // Text buffer (interned strings)
  if (u.internedPct >= NEARLY_FULL_PCT) {
    const target = nextStep(INTERNED_STEPS, live.cfg.interned_mb);
    const ini = `/etc/php/${v}/fpm/php.ini`;
    out.push({
      key: "interned",
      tone: u.internedPct >= FULL_PCT ? "danger" : "warn",
      title: u.internedPct >= FULL_PCT ? "The text buffer is full" : "The text buffer is nearly full",
      detail: `${mbText(live.str.used)} of ${mbText(live.str.size)} is used. This buffer holds the names and text that PHP files share; when it is full each PHP worker keeps its own copies, which costs memory and speed. GridPane has no command for it, so it is a hand edit to ${target} MB. Two lines in the file match and the commented one is not the live one. The buffer comes out of the cache's own memory.`,
      commands: [
        `grep -n "interned_strings_buffer" ${ini}`,
        `sed -i 's/^opcache.interned_strings_buffer=.*/opcache.interned_strings_buffer=${target}/' ${ini}`,
        // PHP has to reload to pick the edit up. A memory change above does that; otherwise re-set the current value.
        out.find((f) => f.key === "memory" || f.key === "oom")?.commands?.[0]
          ? `${out.find((f) => f.key === "memory" || f.key === "oom")!.commands![0]}   # the memory change above: it also reloads PHP ${v}`
          : `${memoryCommand(v, live.cfg.memory_mb)}   # same value as now: this reloads PHP ${v}`,
      ],
    });
  }

  // Wasted space
  if (u.wastedPct >= WASTED_WARN_PCT && !out.some((f) => f.key === "memory" && f.tone === "danger")) {
    out.push({
      key: "wasted",
      tone: "warn",
      title: "Old copies of files are taking room",
      detail: `${mbText(live.mem.wasted)} (${pctText(u.wastedPct)}) is held by earlier versions of files that have since changed, usually after plugin updates or a staging build. PHP only clears it when the cache fills or PHP reloads.`,
    });
  }

  // Staging crowding live
  const shares = siteShares(row);
  const stagingPct = shares.filter((s) => s.staging).reduce((sum, s) => sum + s.sharePct, 0);
  if (stagingPct >= STAGING_SHARE_PCT && u.takenPct >= 70) {
    const names = shares.filter((s) => s.staging && s.bytes > 0).map((s) => s.site);
    out.push({
      key: "staging",
      tone: "warn",
      title: "Staging is crowding the live sites",
      detail: `${names.join(", ")} ${names.length === 1 ? "holds" : "hold"} ${pctText(stagingPct)} of the cached code on PHP ${v}, in the same cache the live sites use. Moving staging to a PHP version of its own, or removing it when the work is done, frees that room.`,
    });
  }

  // Settings changed on disk but not in the running PHP
  if (row.ini) {
    const diffs: string[] = [];
    if (row.ini.memory_mb !== null && row.ini.memory_mb !== live.cfg.memory_mb) diffs.push(`memory ${row.ini.memory_mb} MB in the file, ${live.cfg.memory_mb} MB running`);
    if (row.ini.interned_mb !== null && row.ini.interned_mb !== live.cfg.interned_mb) diffs.push(`text buffer ${row.ini.interned_mb} MB in the file, ${live.cfg.interned_mb} MB running`);
    if (row.ini.max_files !== null && row.ini.max_files !== live.cfg.max_files) diffs.push(`file limit ${whole(row.ini.max_files)} in the file, ${whole(live.cfg.max_files)} running`);
    if (diffs.length > 0) {
      out.push({
        key: "not-reloaded",
        tone: "warn",
        title: "The settings file and the running PHP disagree",
        detail: `${diffs.join("; ")}. PHP has not reloaded since the file changed, or another settings file overrides it.`,
      });
    }
  }

  // Hit rate, once PHP has been up long enough for it to mean something
  if (!settling(live, now)) {
    const recent = recentHitRate(row);
    const life = lifetimeHitRate(live);
    if (recent && recent.rate < HIT_RATE_WARN_PCT) {
      out.push({
        key: "hit-rate",
        tone: "warn",
        title: "Many requests are missing the cache",
        detail: `In the last ${recent.minutes} minutes ${pctText(recent.rate)} of PHP file loads came from the cache; a healthy cache is above 99%. ${
          out.some((f) => f.key === "memory" || f.key === "files") ? "The full cache above is the likely cause." : "Code that changes on every request, or a cache that was just emptied, can cause this."
        }`,
      });
    } else if (!recent && life !== null && life < HIT_RATE_WARN_PCT && live.hits + live.misses >= 10_000) {
      out.push({
        key: "hit-rate",
        tone: "warn",
        title: "Many requests are missing the cache",
        detail: `Since PHP started, ${pctText(life)} of PHP file loads came from the cache; a healthy cache is above 99%.`,
      });
    }
  }

  const rank = { danger: 0, warn: 1 };
  return out.sort((a, b) => rank[a.tone] - rank[b.tone]);
}

// ── one-word state ──────────────────────────────────────────────────────────

export type VersionMeta = { tone: Tone; label: string };

export function versionMeta(row: PhpOpcacheRow, now: Date): VersionMeta {
  if (unused(row)) return { tone: "neutral", label: "Not in use" };
  if (!row.live) {
    if (row.live_error === "off" || row.live_error === "not_loaded") return { tone: "danger", label: "Off" };
    return { tone: "warn", label: "Cannot see" };
  }
  const f = findings(row, now);
  if (f.some((x) => x.key === "off")) return { tone: "danger", label: "Off" };
  if (f.some((x) => x.tone === "danger")) return { tone: "danger", label: f[0].key === "memory" ? "Full" : "Needs a change" };
  if (f.length > 0) return { tone: "warn", label: f.some((x) => x.key === "memory") ? "Nearly full" : "Worth a look" };
  if (settling(row.live, now)) return { tone: "neutral", label: "Settling" };
  return { tone: "ok", label: "Healthy" };
}

/** Three words at most, for a narrow table cell: a longer pill wraps and strands a word. */
export function flagLabel(meta: VersionMeta): string {
  switch (meta.label) {
    case "Full": return "Cache full";
    case "Nearly full": return "Cache nearly full";
    case "Off": return "Cache off";
    case "Cannot see": return "Cache not readable";
    case "Needs a change": return "Cache limit reached";
    default: return "Check code cache";
  }
}

/** A sentence for a PHP version nothing is wrong with. */
export function healthyText(row: PhpOpcacheRow, now: Date): string | null {
  if (unused(row)) return "No site runs on this PHP version. GridPane keeps it running for its own tools.";
  if (!row.live) return null;
  const u = usage(row.live);
  if (settling(row.live, now)) {
    const m = Math.round(minutesRunning(row.live, now) ?? 0);
    return `PHP ${row.php_version} reloaded ${m <= 1 ? "a minute" : `${m} minutes`} ago, so the cache is still filling and the hit rate means little yet.`;
  }
  return `Room to spare: ${pctText(100 - u.takenPct)} of the memory and ${pctText(100 - u.keysPct)} of the file slots are free.`;
}

// ── a site's place in its cache ─────────────────────────────────────────────

/** The row for the PHP version a site folder runs on, by its pool; by cached code as a fallback. */
export function rowForSite(rows: PhpOpcacheRow[], site: string): PhpOpcacheRow | null {
  const name = site.trim().toLowerCase();
  return (
    rows.find((r) => r.sites.some((s) => s.toLowerCase() === name)) ??
    rows.find((r) => (r.live?.by_site ?? []).some((s) => s.site.toLowerCase() === name)) ??
    null
  );
}

export type SiteCache = {
  row: PhpOpcacheRow;
  /** Other site folders on the same PHP version. */
  others: string[];
  share: SiteShare | null;
  headline: string;
  detail: string;
};

export function siteCache(rows: PhpOpcacheRow[], site: string): SiteCache | null {
  const row = rowForSite(rows, site);
  if (!row) return null;
  const name = site.trim().toLowerCase();
  const others = row.sites.filter((s) => s.toLowerCase() !== name);
  const share = siteShares(row).find((s) => s.site.toLowerCase() === name) ?? null;
  const withText = others.length === 0 ? "with no other site" : others.length === 1 ? "with 1 other site" : `with ${others.length} other sites`;
  if (!row.live) {
    const size = row.ini?.memory_mb ? `a ${row.ini.memory_mb} MB cache` : "a cache";
    return { row, others, share, headline: `Shares ${size} ${withText} on PHP ${row.php_version}`, detail: liveErrorText(row.live_error) };
  }
  const u = usage(row.live);
  const headline = `Shares a ${row.live.cfg.memory_mb} MB cache ${withText} on PHP ${row.php_version}, ${pctText(u.takenPct)} full`;
  const detail =
    share && share.bytes > 0
      ? `This site's code holds ${mbText(share.bytes)} of it (${pctText(share.sharePct)} of the cached code, ${whole(share.scripts)} files).`
      : row.live.full || u.takenPct >= FULL_PCT
        ? "The cache is full and none of this site's code is in it, so its PHP is compiled again on every request."
        : "None of this site's code is in the cache right now: it has had no PHP requests since PHP last started.";
  return { row, others, share, headline, detail };
}

// ── a server at a glance ────────────────────────────────────────────────────

export type ServerCacheSummary = { versions: number; inUse: number; danger: number; warn: number; tone: Tone; text: string };

export function serverSummary(rows: PhpOpcacheRow[], now: Date): ServerCacheSummary {
  const metas = rows.map((r) => ({ r, m: versionMeta(r, now) }));
  const danger = metas.filter((x) => x.m.tone === "danger");
  const warn = metas.filter((x) => x.m.tone === "warn");
  const inUse = rows.filter((r) => !unused(r)).length;
  const words = (label: string) => (label === "Cannot see" ? "not readable" : label.toLowerCase());
  const list = (xs: typeof metas) => xs.map((x) => `PHP ${x.r.php_version} ${words(x.m.label)}`).join(", ");
  const tone: Tone = danger.length ? "danger" : warn.length ? "warn" : rows.length === 0 ? "neutral" : "ok";
  const text =
    rows.length === 0
      ? "No PHP version reported."
      : danger.length || warn.length
        ? `${list([...danger, ...warn])}.`
        : `${inUse === 1 ? "The one PHP version in use has" : `All ${inUse} PHP versions in use have`} room in the code cache.`;
  return { versions: rows.length, inUse, danger: danger.length, warn: warn.length, tone, text };
}

/** Most in need of attention first, then newest PHP first; versions nothing runs on last. */
export function sortVersions(rows: PhpOpcacheRow[], now: Date): PhpOpcacheRow[] {
  const rank = (r: PhpOpcacheRow) => {
    if (unused(r)) return 4;
    const t = versionMeta(r, now).tone;
    return t === "danger" ? 0 : t === "warn" ? 1 : 2;
  };
  const num = (v: string) => v.split(".").map(Number).reduce((a, n) => a * 100 + (Number.isFinite(n) ? n : 0), 0);
  return [...rows].sort((a, b) => rank(a) - rank(b) || num(b.php_version) - num(a.php_version));
}
