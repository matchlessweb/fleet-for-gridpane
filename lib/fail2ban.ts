/**
 * Fail2Ban behind Cloudflare — shapes, the status of one site, and the server
 * summary.
 *
 * The data is what each server's agent reports every 10 minutes
 * (scripts/telemetry-agent.sh, through report_fail2ban in supabase/migrations/20261120000000_baseline.sql).
 * The server is the source of truth for its own jails and bans. This module
 * never talks to a server or to Cloudflare; it only reads those facts and says
 * whether they add up to "working", and if not, which check failed.
 *
 * The checks are the ones scripts/fleet-fail2ban-audit.remote.sh and
 * scripts/fleet-fail2ban-apply.remote.sh make, so the app and a fresh audit
 * agree by construction.
 *
 * No imports: scripts/test-fail2ban.ts runs this file directly under Node.
 */

import { fleetConfig } from "../fleet.config.ts";

// ── shapes (as the agent reports them) ──────────────────────────────────────

export type JailKind = "h" | "s" | "x";

export type F2bBan = {
  ip: string;
  jail: string;
  /** When the ban started, UTC. Null when the server's Fail2Ban could not say. */
  at: string | null;
  until: string | null;
};

export type F2bJail = {
  name: string;
  kind: JailKind;
  /** Present in the server's jail file. */
  configured: boolean;
  running: boolean;
  /** The Cloudflare zone this jail bans in, from the jail file. */
  cfzone: string | null;
  actions: string[];
  reads_auth_log: boolean;
  failed_now: number | null;
  failed_total: number | null;
  banned_now: number | null;
  banned_total: number | null;
};

export type F2bServerJail = Omit<F2bJail, "kind" | "configured" | "cfzone"> & { bans: F2bBan[] };

export type F2bLogLine = { t: string | null; m: string };

export type PluginState = "mu" | "plugin" | "off" | "broken";

export type SiteF2bRow = {
  server_id: number;
  site: string;
  reported_at: string;
  plugin: PluginState;
  mu_plugin: string | null;
  plugin_dir: boolean | null;
  configs: boolean | null;
  included: boolean | null;
  jails: F2bJail[];
  bans: F2bBan[];
  log_lines: F2bLogLine[];
  log_24h: number;
};

export type ServerF2bRow = {
  server_id: number;
  reported_at: string;
  fail2ban_present: boolean;
  fail2ban_running: boolean;
  fail2ban_version: string | null;
  token_file_present: boolean;
  gpcloudflare_conf: boolean;
  auth_log_readable: boolean;
  server_jails: F2bServerJail[];
  orphan_jails: { name: string; running: boolean; site: string | null }[];
};

export type ZoneRef = { zone_id: string; name: string };

/** Everything but the log lines: what a list of sites needs. */
export const SITE_LIST_COLUMNS =
  "server_id,site,reported_at,plugin,mu_plugin,plugin_dir,configs,included,jails,bans,log_24h";

// ── constants ───────────────────────────────────────────────────────────────

/** The agent's cron interval. */
export const REPORT_INTERVAL_MINUTES = 10;
/** A report older than two intervals is not trusted to describe the server now. */
export const STALE_AFTER_MINUTES = REPORT_INTERVAL_MINUTES * 2;

export const KIND_ORDER: JailKind[] = ["h", "s", "x"];

/** Same thresholds the setup gives each jail (fleet-fail2ban-apply.remote.sh). */
export const KIND_META: Record<JailKind, { label: string; banSeconds: number; banText: string; rule: string }> = {
  h: { label: "Hard", banSeconds: 600, banText: "10 minutes", rule: "1 strike" },
  s: { label: "Soft", banSeconds: 3600, banText: "1 hour", rule: "3 strikes" },
  x: { label: "Extra", banSeconds: 86400, banText: "24 hours", rule: "3 strikes" },
};

/** The Fail2Ban action that bans at Cloudflare. The server scripts install it under the same name. */
export const CLOUDFLARE_ACTION = `${fleetConfig.server.prefix}-cloudflare`;
export const LOCAL_ACTION = "iptables-allports";

/**
 * Folders on a server that are deliberately not counted. Listed by name, with
 * the reason, so nothing is hidden by a rule nobody can see.
 */
export const SKIPPED_FOLDERS: Record<string, string> = Object.fromEntries(
  fleetConfig.server.skippedFolders.map((f) => [f.site.toLowerCase(), f.reason]),
);

// ── status ──────────────────────────────────────────────────────────────────

export type StatusKey = "working" | "plugin-off" | "local-only" | "broken" | "not-reported";
type Tone = "neutral" | "ok" | "warn" | "danger";

export const STATUS_META: Record<StatusKey, { label: string; tone: Tone }> = {
  working: { label: "Working", tone: "ok" },
  "plugin-off": { label: "Plugin off", tone: "warn" },
  "local-only": { label: "Local firewall only", tone: "neutral" },
  broken: { label: "Broken", tone: "danger" },
  "not-reported": { label: "Not reported", tone: "warn" },
};

/** Sort order for a server's list once active blocks are placed first. */
const STATUS_RANK: Record<StatusKey, number> = {
  broken: 0,
  "not-reported": 1,
  "plugin-off": 2,
  "local-only": 3,
  working: 4,
};

export type CheckState = "pass" | "fail" | "waiting" | "na";
export type Check = { key: string; label: string; state: CheckState; detail: string };

export type SiteStatus = {
  key: StatusKey;
  label: string;
  tone: Tone;
  /** One sentence: why it has this status. For "broken" it names the first failed check. */
  reason: string;
  checks: Check[];
  /** The zone this site's jails ban in, when the inventory knows it. */
  zone: ZoneRef | null;
};

export function minutesSince(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const ms = now.getTime() - new Date(iso).getTime();
  return Number.isFinite(ms) ? ms / 60_000 : null;
}

export function isStale(iso: string | null | undefined, now: Date): boolean {
  const m = minutesSince(iso, now);
  return m === null || m > STALE_AFTER_MINUTES;
}

function host(input: string): string {
  return input.trim().toLowerCase().replace(/^www\./, "");
}

/** The longest zone name that equals the host or is a dot-bounded suffix of it. */
export function zoneForHost(site: string, zones: readonly ZoneRef[]): ZoneRef | null {
  const h = host(site);
  let best: ZoneRef | null = null;
  for (const z of zones) {
    const n = z.name.toLowerCase();
    if ((h === n || h.endsWith("." + n)) && (best === null || n.length > best.name.length)) best = z;
  }
  return best;
}

function list(names: string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function jailWord(j: F2bJail): string {
  return KIND_META[j.kind]?.label.toLowerCase() ?? j.name;
}

/**
 * The status of one site, with every check named.
 *
 * `site` is the server's own report for that folder (null when the server has
 * never reported it). `zones` is the Cloudflare inventory (cloudflare_zones).
 *
 * A site is in a zone, for this purpose, when the server's jail file gives its
 * jails one. That is the mapping bans really follow; a hostname that merely
 * looks like it belongs to a zone proves nothing about where a ban would land.
 */
export function siteStatus(
  site: SiteF2bRow | null,
  server: ServerF2bRow | null,
  zones: readonly ZoneRef[],
  now: Date
): SiteStatus {
  const done = (key: StatusKey, reason: string, checks: Check[], zone: ZoneRef | null): SiteStatus => ({
    key,
    label: STATUS_META[key].label,
    tone: STATUS_META[key].tone,
    reason,
    checks,
    zone,
  });

  // 1. Is there a report recent enough to describe the server now?
  const age = minutesSince(site?.reported_at ?? server?.reported_at, now);
  if (!site || !server || age === null) {
    return done(
      "not-reported",
      server
        ? "The server's last report does not list this site."
        : "This server's agent has not sent a Fail2Ban report yet.",
      [{ key: "reported", label: "Recent report", state: "fail", detail: "No report on record." }],
      null
    );
  }
  if (isStale(site.reported_at, now)) {
    return done(
      "not-reported",
      `Last report ${ageText(site.reported_at, now)}. Reports are due every ${REPORT_INTERVAL_MINUTES} minutes, so nothing below it is trusted.`,
      [
        {
          key: "reported",
          label: "Recent report",
          state: "fail",
          detail: `Last report ${ageText(site.reported_at, now)}; more than ${STALE_AFTER_MINUTES} minutes is out of date.`,
        },
      ],
      null
    );
  }

  const checks: Check[] = [
    { key: "reported", label: "Recent report", state: "pass", detail: `Reported ${ageText(site.reported_at, now)}.` },
  ];

  // 2. Fail2Ban itself.
  const f2bUp = server.fail2ban_present && server.fail2ban_running;
  checks.push({
    key: "fail2ban",
    label: "Fail2Ban running",
    state: f2bUp ? "pass" : "fail",
    detail: !server.fail2ban_present
      ? "Fail2Ban is not installed on the server."
      : f2bUp
        ? `Fail2Ban ${server.fail2ban_version ?? ""} answers on the server.`.replace("  ", " ")
        : "Fail2Ban is installed but not answering.",
  });

  // 3. The plugin that writes the log lines.
  const pluginOn = site.plugin === "mu" || site.plugin === "plugin";
  checks.push({
    key: "plugin",
    label: "WP fail2ban plugin on",
    state: pluginOn ? "pass" : site.plugin === "off" ? "waiting" : "fail",
    detail:
      site.plugin === "mu"
        ? "Installed as a must-use plugin."
        : site.plugin === "plugin"
          ? "Installed as an ordinary plugin (no must-use link)."
          : site.plugin === "off"
            ? "Off: no plugin link and no settings file. The site writes nothing to the log."
            : site.mu_plugin === "dangling"
              ? "The must-use link points at a plugin file that is not there."
              : "A settings file exists but the plugin folder does not.",
  });

  // 4. Its settings, included from wp-config.php.
  const includeLive = Boolean(site.configs && site.included);
  checks.push({
    key: "include",
    label: "Settings included in wp-config.php",
    state: !pluginOn && site.plugin === "off" ? "na" : includeLive ? "pass" : "fail",
    detail:
      site.plugin === "off"
        ? "Not applicable while the plugin is off."
        : includeLive
          ? "wp-config.php includes wp-fail2ban-configs.php, and the file exists."
          : !site.configs
            ? "wp-fail2ban-configs.php is missing."
            : "wp-config.php does not include wp-fail2ban-configs.php (or the line is commented out).",
  });

  // 5–8. The site's own jails.
  const jails = KIND_ORDER.map((k) => site.jails.find((j) => j.kind === k)).filter(
    (j): j is F2bJail => Boolean(j)
  );
  const hasJails = site.jails.length > 0;
  const naJail = "This site has no jails of its own.";

  const missingKinds = KIND_ORDER.filter((k) => !site.jails.some((j) => j.kind === k));
  const stopped = jails.filter((j) => !j.running);
  const jailsOk = hasJails && missingKinds.length === 0 && stopped.length === 0;
  checks.push({
    key: "jails",
    label: "All three jails running",
    state: !hasJails ? "na" : jailsOk ? "pass" : "fail",
    detail: !hasJails
      ? naJail
      : jailsOk
        ? "Hard, soft and extra are all running."
        : [
            missingKinds.length ? `Missing: ${list(missingKinds.map((k) => KIND_META[k].label.toLowerCase()))}.` : "",
            stopped.length ? `Not running: ${list(stopped.map(jailWord))}.` : "",
          ]
            .filter(Boolean)
            .join(" "),
  });

  const running = jails.filter((j) => j.running);
  const noEdge = running.filter((j) => !j.actions.includes(CLOUDFLARE_ACTION));
  const noLocal = running.filter((j) => !j.actions.includes(LOCAL_ACTION));
  const actionsOk = running.length > 0 && noEdge.length === 0 && noLocal.length === 0;
  checks.push({
    key: "actions",
    label: "Bans in Cloudflare and in the local firewall",
    state: !hasJails ? "na" : running.length === 0 ? "fail" : actionsOk ? "pass" : "fail",
    detail: !hasJails
      ? naJail
      : running.length === 0
        ? "No jail is running, so no action can be read."
        : actionsOk
          ? `Every jail has both actions: ${CLOUDFLARE_ACTION} and ${LOCAL_ACTION}.`
          : [
              noEdge.length ? `No Cloudflare action on: ${list(noEdge.map(jailWord))}.` : "",
              noLocal.length ? `No local firewall action on: ${list(noLocal.map(jailWord))}.` : "",
            ]
              .filter(Boolean)
              .join(" "),
  });

  const notReading = running.filter((j) => !j.reads_auth_log);
  const logOk = running.length > 0 && notReading.length === 0 && server.auth_log_readable;
  checks.push({
    key: "logpath",
    label: "Jails read /var/log/auth.log",
    state: !hasJails ? "na" : logOk ? "pass" : "fail",
    detail: !hasJails
      ? naJail
      : running.length === 0
        ? "No jail is running."
        : !server.auth_log_readable
          ? "/var/log/auth.log could not be read on the server."
          : logOk
            ? "Every jail is reading the file the plugin writes to."
            : `Not reading the file: ${list(notReading.map(jailWord))}.`,
  });

  // The zone the jails ban in, joined to the Cloudflare inventory by id.
  const zoneIds = [...new Set(jails.map((j) => j.cfzone).filter((z): z is string => Boolean(z)))];
  const zone = zoneIds.length === 1 ? (zones.find((z) => z.zone_id === zoneIds[0]) ?? null) : null;
  const covers = zone ? zoneForHost(site.site, [zone]) !== null : false;
  const zoneOk = hasJails && zoneIds.length === 1 && jails.every((j) => j.cfzone) && zone !== null && covers;
  const nameMatch = zoneForHost(site.site, zones);
  checks.push({
    key: "zone",
    label: "Site maps to a Cloudflare zone",
    state: !hasJails ? "na" : zoneOk ? "pass" : "fail",
    detail: !hasJails
      ? nameMatch
        ? `The server has no zone mapped for this site. Its name falls inside the zone ${nameMatch.name}, but no jail bans there.`
        : "No Cloudflare zone in the inventory covers this hostname."
      : zoneOk
        ? `${zone!.name} is the zone its bans land in.`
        : zoneIds.length === 0 || jails.some((j) => !j.cfzone)
          ? "A jail has no zone set in the server's jail file."
          : zoneIds.length > 1
            ? "The three jails do not all ban in the same zone."
            : zone === null
              ? "The jails ban in a zone the Cloudflare inventory does not list."
              : `The jails ban in the zone ${zone.name}, which does not cover this hostname.`,
  });

  checks.push({
    key: "token",
    label: "Server's Cloudflare token file exists",
    state: !hasJails ? "na" : server.token_file_present ? "pass" : "fail",
    detail: !hasJails
      ? naJail
      : server.token_file_present
        ? "The token file is on the server. Its contents are never read."
        : "The token file is missing or empty, so no ban can reach Cloudflare.",
  });

  // ── the verdict ──
  if (!f2bUp) return done("broken", checks[1].detail, checks, zone);

  if (!hasJails) {
    const gp = server.server_jails.filter((j) => /^wordpress-(hard|soft|extra)$/.test(j.name) && j.running);
    const cover =
      gp.length > 0
        ? "GridPane's own jails cover it in the server's local firewall, which does not stop visitors who come through Cloudflare."
        : "GridPane's own WordPress jails are not running either, so nothing bans for it.";
    const pluginNote = site.plugin === "broken" ? " The plugin is also broken on this site." : "";
    return done("local-only", `No Cloudflare zone is mapped for this site. ${cover}${pluginNote}`, checks, null);
  }

  const failed = checks.filter((c) => c.state === "fail");
  if (failed.length > 0) {
    const more = failed.length > 1 ? ` (${failed.length} checks failed)` : "";
    return done("broken", `${failed[0].label}: ${failed[0].detail}${more}`, checks, zone);
  }

  if (site.plugin === "off") {
    return done(
      "plugin-off",
      "The jails are in place and waiting. They start working when the WP fail2ban integration is switched on for this site in GridPane.",
      checks,
      zone
    );
  }

  return done("working", "Bans land in this site's own Cloudflare zone and in the server's local firewall.", checks, zone);
}

// ── bans ────────────────────────────────────────────────────────────────────

/** A jail Fleet made: <jail prefix>-<site>-<four hex>-<kind>. */
const JAIL_NAME = new RegExp(`^${fleetConfig.server.jailPrefix}-[a-z0-9]*-[0-9a-f]{4}-([hsx])$`);

export function kindOfJail(name: string): JailKind | null {
  const m = JAIL_NAME.exec(name);
  return m ? (m[1] as JailKind) : null;
}

/**
 * When a ban ends. The server's own figure when it gave one; otherwise the
 * start plus the jail's ban length; otherwise unknown.
 */
export function banEnds(ban: F2bBan): { iso: string | null; source: "server" | "computed" | "unknown" } {
  if (ban.until) return { iso: ban.until, source: "server" };
  const kind = kindOfJail(ban.jail);
  if (ban.at && kind) {
    return {
      iso: new Date(new Date(ban.at).getTime() + KIND_META[kind].banSeconds * 1000).toISOString(),
      source: "computed",
    };
  }
  return { iso: null, source: "unknown" };
}

// ── server summary ──────────────────────────────────────────────────────────

export type SiteEntry = { row: SiteF2bRow; status: SiteStatus; bans: number };

export type ServerSummary = {
  /** Counted sites, active blocks first. */
  entries: SiteEntry[];
  skipped: { site: string; why: string }[];
  total: number;
  working: number;
  counts: Record<StatusKey, number>;
  /** Addresses blocked right now by sites' own jails. */
  activeBlocks: number;
  /** Addresses blocked right now by the server's other jails (GridPane's, sshd). */
  serverBlocks: number;
  stale: boolean;
};

export function serverSummary(
  rows: readonly SiteF2bRow[],
  server: ServerF2bRow | null,
  zones: readonly ZoneRef[],
  now: Date
): ServerSummary {
  const skipped: ServerSummary["skipped"] = [];
  const entries: SiteEntry[] = [];
  for (const row of rows) {
    const why = SKIPPED_FOLDERS[row.site.toLowerCase()];
    if (why) {
      skipped.push({ site: row.site, why });
      continue;
    }
    const status = siteStatus(row, server, zones, now);
    // A stale report's bans are history, not state: Fail2Ban bans expire.
    entries.push({ row, status, bans: status.key === "not-reported" ? 0 : row.bans.length });
  }
  entries.sort(
    (a, b) =>
      Number(b.bans > 0) - Number(a.bans > 0) ||
      b.bans - a.bans ||
      STATUS_RANK[a.status.key] - STATUS_RANK[b.status.key] ||
      a.row.site.localeCompare(b.row.site)
  );
  const counts: Record<StatusKey, number> = {
    working: 0,
    "plugin-off": 0,
    "local-only": 0,
    broken: 0,
    "not-reported": 0,
  };
  for (const e of entries) counts[e.status.key]++;
  const stale = !server || isStale(server.reported_at, now);
  return {
    entries,
    skipped,
    total: entries.length,
    working: counts.working,
    counts,
    activeBlocks: entries.reduce((n, e) => n + e.bans, 0),
    serverBlocks: stale ? 0 : (server?.server_jails ?? []).reduce((n, j) => n + (j.bans?.length ?? 0), 0),
    stale,
  };
}

/** GridPane's own WordPress jails, which are the server's and never a site's. */
export function gridpaneJails(server: ServerF2bRow | null): F2bServerJail[] {
  return (server?.server_jails ?? []).filter((j) => j.name.startsWith("wordpress-"));
}

export function otherServerJails(server: ServerF2bRow | null): F2bServerJail[] {
  return (server?.server_jails ?? []).filter((j) => !j.name.startsWith("wordpress-"));
}

// ── words ───────────────────────────────────────────────────────────────────

/** "just now", "4 minutes ago", "3 hours ago", "2 days ago". */
export function ageText(iso: string, now: Date): string {
  const m = Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(m)) return "at an unknown time";
  if (m < 1) return "just now";
  if (m < 60) return `${m} ${m === 1 ? "minute" : "minutes"} ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} ${h === 1 ? "hour" : "hours"} ago`;
  const d = Math.floor(h / 24);
  return `${d} days ago`;
}

/** "in 6 minutes", "in 2 hours", "any moment" (the ban's end has passed). */
export function untilText(iso: string, now: Date): string {
  const m = Math.ceil((new Date(iso).getTime() - now.getTime()) / 60_000);
  if (!Number.isFinite(m)) return "at an unknown time";
  if (m <= 0) return "any moment";
  if (m < 60) return `in ${m} ${m === 1 ? "minute" : "minutes"}`;
  const h = Math.round(m / 60);
  return `in ${h} ${h === 1 ? "hour" : "hours"}`;
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Binds the last two words with a no-break space so the final word never sits
 * alone on its own line (`text-wrap: pretty` does this only in some browsers).
 * Only when the pair is short: a long bound pair, such as one ending in a
 * hostname, would be pushed off a narrow screen, which is worse than a
 * stranded word.
 */
export function tie(text: string): string {
  return text.replace(/(\S+) (\S+)\s*$/, (whole, a: string, b: string) =>
    a.length + b.length <= 22 ? `${a}\u00a0${b}` : whole
  );
}
