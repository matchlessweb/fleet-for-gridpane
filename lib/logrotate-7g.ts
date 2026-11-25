/**
 * 7G WAF log rotation.
 *
 * GridPane ships per-site logrotate rules for `debug.log` (hourly, keep 24)
 * and `gp-cron.log` (daily, keep 1) — but nothing for `7g.log`, so the WAF log
 * can grow without bound: on a server measured for this, it had no rotated
 * siblings on disk.
 *
 * These helpers compose the missing rule. Nothing here talks to a server —
 * the output is meant to be pasted into an SSH session.
 */

import { fleetConfig } from "../fleet.config.ts";

export type Cadence = "daily" | "weekly" | "monthly";

export type RetentionPlan = {
  cadence: Cadence;
  /** How many rotated generations to keep */
  keep: number;
  compress: boolean;
  /**
   * Size ceiling in MB that rotates early, regardless of the schedule.
   * GridPane pairs its own debug.log rule with `maxsize 50M` for exactly this
   * reason: without it, a traffic burst can balloon one file for a whole
   * cycle. null disables the ceiling.
   */
  maxsizeMb: number | null;
};

/** The include path GridPane's logrotate already scans. */
export const CONFIG_PATH = `/etc/logrotate.d/${fleetConfig.server.prefix}-7g-logs`;
export const LOG_GLOB = "/var/www/*/logs/7g.log";

const CADENCE_DAYS: Record<Cadence, number> = { daily: 1, weekly: 7, monthly: 30 };

/** Plain-language window the plan actually covers, e.g. "about 8 weeks". */
export function describeWindow({ cadence, keep }: RetentionPlan): string {
  const days = CADENCE_DAYS[cadence] * keep;
  if (days < 14) return `about ${days} day${days === 1 ? "" : "s"}`;
  if (days < 60) return `about ${Math.round(days / 7)} weeks`;
  if (days < 365) return `about ${Math.round(days / 30)} months`;
  return `about ${(days / 365).toFixed(1)} years`;
}

/**
 * The logrotate stanza.
 *
 * `copytruncate` is deliberate. GridPane owns each site's log files with that
 * site's own system user so SFTP users can read them; a single globbed rule
 * cannot express per-site ownership with `create`, and recreating the files as
 * root would silently break that access. copytruncate never replaces the file,
 * so owner, group and mode all survive — and because the inode is unchanged,
 * nginx keeps writing without needing a reopen signal. The tradeoff is that a
 * few lines written during the copy can be lost, which is acceptable here.
 */
export function buildLogrotateConfig(plan: RetentionPlan): string {
  const lines = [
    `# Managed by ${fleetConfig.name} — 7G WAF log rotation.`,
    "# GridPane rotates debug.log and gp-cron.log but ships no rule for 7g.log.",
    `${LOG_GLOB} {`,
    `    ${plan.cadence}`,
    `    rotate ${plan.keep}`,
  ];
  // maxsize rotates early when a burst outpaces the schedule; the cadence
  // still governs the normal case.
  if (plan.maxsizeMb) lines.push(`    maxsize ${plan.maxsizeMb}M`);
  if (plan.compress) lines.push("    compress", "    delaycompress");
  lines.push(
    "    missingok",
    "    notifempty",
    "    copytruncate",
    "}"
  );
  return lines.join("\n");
}

/** Write the rule, then dry-run it. Nothing is rotated until the next step. */
export function buildInstallScript(plan: RetentionPlan): string {
  return [
    `# 1 — write the rule`,
    `sudo tee ${CONFIG_PATH} > /dev/null <<'EOF'`,
    buildLogrotateConfig(plan),
    `EOF`,
    ``,
    `# 2 — dry run: prints what WOULD happen, changes nothing`,
    `sudo logrotate -d ${CONFIG_PATH}`,
  ].join("\n");
}

/**
 * One-time reclaim. Two honest choices, because 7g.log is a single
 * append-only file: there is no "delete entries older than X" without
 * rewriting the file line by line.
 */
export function buildReclaimScript(mode: "rotate" | "truncate"): string {
  if (mode === "rotate") {
    return [
      `# Current footprint`,
      `du -ch ${LOG_GLOB}* | tail -1`,
      ``,
      `# Archive today's log and start fresh (history kept, compressed)`,
      `sudo logrotate -f ${CONFIG_PATH}`,
      ``,
      `# Footprint after`,
      `du -ch ${LOG_GLOB}* | tail -1`,
    ].join("\n");
  }
  return [
    `# Discards all current 7G history on this server, immediately.`,
    `# Ownership and permissions are preserved (the file is emptied, not deleted).`,
    `du -ch ${LOG_GLOB}* | tail -1`,
    `sudo truncate -s 0 ${LOG_GLOB}`,
    `du -ch ${LOG_GLOB}* | tail -1`,
  ].join("\n");
}
