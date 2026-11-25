/**
 * Server-side WAF status: which firewall each site runs (GridPane's 7G, the 8G
 * firewall, or both), and what each did in the last 24 hours.
 *
 * Everything here is worked out from what the server's agent reports
 * (scripts/telemetry-agent.sh, "WAF status"; stored as defined in supabase/migrations/20261120000000_baseline.sql). The
 * agent reports facts; the words and the judgments are made here so they can
 * be tested (scripts/test-waf-status.ts).
 */
// Self-contained on purpose: the test runs this file with node's type stripping,
// which resolves no path aliases.
const REPORT_INTERVAL_MINUTES = 10;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

type Tone = "neutral" | "ok" | "warn" | "danger";

// ── shapes (as the agent reports them) ──────────────────────────────────────

export type G7Day = { total: number; complete: boolean; rules: { rule: string; n: number }[] };
export type G8Sample = { s: string; n: number };
export type G8Rule = { rule: string; n: number; already: number; samples: G8Sample[] };
export type G8Day = { total: number; already: number; complete: boolean; rules: G8Rule[] };
export type G8Mode = "none" | "installed" | "observe" | "enforce";

export type SiteWafRow = {
  server_id: number;
  site: string;
  reported_at: string;
  /** GridPane's own setting: "7G", "off", ... */
  waf: string | null;
  rulesets: Record<string, string>;
  g8_mode: G8Mode | string;
  g8_loaded: boolean;
  g8_version: string | null;
  g8_log_bytes: number | null;
  g8_log_at: string | null;
  g7_day: G7Day | null;
  g8_day: G8Day | null;
};

export type ServerWafRow = { server_id: number; reported_at: string; agent_format: number };

// ── 7G ──────────────────────────────────────────────────────────────────────

/**
 * GridPane ships bad-remote-host switched off, so that one being off is the
 * default, not a decision.
 */
export const DEFAULT_OFF_RULESETS = ["bad-remote-host"];

export const RULESET_LABEL: Record<string, string> = {
  "bad-bots": "Bad bots",
  "bad-methods": "Bad methods",
  "bad-query-string": "Bad query string",
  "bad-referer": "Bad referrer",
  "bad-remote-host": "Bad remote host",
  "bad-request": "Bad request",
};

export function rulesetLabel(key: string): string {
  return RULESET_LABEL[key] ?? key;
}

export function sevenGOn(row: Pick<SiteWafRow, "waf">): boolean {
  return (row.waf ?? "").toUpperCase() === "7G";
}

/** Rulesets a person switched off: off, and not off by GridPane's default. */
export function rulesetsSwitchedOff(row: Pick<SiteWafRow, "waf" | "rulesets">): string[] {
  if (!sevenGOn(row)) return [];
  return Object.entries(row.rulesets ?? {})
    .filter(([key, value]) => value !== "on" && !DEFAULT_OFF_RULESETS.includes(key))
    .map(([key]) => key)
    .sort();
}

export function sevenGMeta(row: Pick<SiteWafRow, "waf" | "rulesets">): { label: string; tone: Tone; detail: string } {
  if (!sevenGOn(row)) {
    const value = row.waf && row.waf.toLowerCase() !== "off" ? row.waf : null;
    return value
      ? { label: value, tone: "warn", detail: `GridPane's firewall setting for this site is ${value}, not 7G.` }
      : { label: "Off", tone: "danger", detail: "GridPane's firewall is switched off for this site." };
  }
  const off = rulesetsSwitchedOff(row);
  return off.length
    ? {
        label: "On, weakened",
        tone: "warn",
        detail: `${off.map(rulesetLabel).join(" and ")} ${off.length === 1 ? "is" : "are"} switched off. Prefer a scoped exception to a ruleset switched off.`,
      }
    : { label: "On", tone: "ok", detail: "Every ruleset GridPane ships switched on is on." };
}

// ── 8G ──────────────────────────────────────────────────────────────────────

export const G8_META: Record<G8Mode, { label: string; tone: Tone; meaning: string }> = {
  none: { label: "Not installed", tone: "neutral", meaning: "This site has no 8G files." },
  installed: {
    label: "Installed, idle",
    tone: "warn",
    meaning: "The 8G files are in the site's folder, but nothing is watching with them or blocking with them.",
  },
  observe: {
    label: "Observing",
    tone: "ok",
    meaning: "8G checks every request and logs what it would block. It blocks nothing.",
  },
  enforce: { label: "Blocking", tone: "ok", meaning: "8G is refusing the requests its rules match." },
};

export function eightGMeta(row: Pick<SiteWafRow, "g8_mode" | "g8_loaded">): { mode: G8Mode | null; label: string; tone: Tone; meaning: string } {
  const mode = (Object.keys(G8_META) as G8Mode[]).find((m) => m === row.g8_mode) ?? null;
  if (!mode) {
    return { mode: null, label: "Unknown mode", tone: "warn", meaning: `The server reported an 8G mode this app does not know: ${row.g8_mode}.` };
  }
  // Watching or blocking with rules that were never loaded cannot match anything.
  if ((mode === "observe" || mode === "enforce") && !row.g8_loaded) {
    return {
      mode,
      label: "Rules not loaded",
      tone: "danger",
      meaning: "The site is set to use 8G, but the file that loads the 8G rules is not included, so nothing can match.",
    };
  }
  return { mode, ...G8_META[mode] };
}

/** What stands between a visitor and the site, in one phrase. */
export function posture(row: Pick<SiteWafRow, "waf" | "rulesets" | "g8_mode" | "g8_loaded">): { key: string; label: string; tone: Tone } {
  const seven = sevenGOn(row);
  const mode = eightGMeta(row).mode;
  const eightBlocks = mode === "enforce" && row.g8_loaded;
  if (seven && eightBlocks) return { key: "both", label: "7G and 8G both blocking", tone: "warn" };
  if (!seven && eightBlocks) return { key: "8g-only", label: "8G only", tone: "ok" };
  if (!seven) return { key: "none", label: "No server firewall", tone: "danger" };
  if (mode === "observe") return { key: "7g-8g-observing", label: "7G, with 8G observing", tone: "ok" };
  return { key: "7g", label: "7G", tone: "ok" };
}

// ── rule names ──────────────────────────────────────────────────────────────

const RULE_FAMILY: Record<string, string> = {
  bad_bot: "Bad bot",
  bad_request: "Bad request",
  bad_querystring: "Bad query string",
  bad_query_string: "Bad query string",
  bad_referer: "Bad referrer",
  bad_cookie: "Bad cookie",
  bad_method: "Method not allowed",
  not_allowed_method: "Method not allowed",
  bad_remote_host: "Bad remote host",
};

/** "bad_bot_7" → { family: "Bad bot", id: "7" }. The raw name is kept for the unknown. */
export function ruleName(rule: string): { family: string; id: string | null } {
  const m = rule.match(/^(.*)_([A-Za-z0-9]+)$/);
  if (m && RULE_FAMILY[m[1]]) return { family: RULE_FAMILY[m[1]], id: m[2] };
  return { family: RULE_FAMILY[rule] ?? rule, id: null };
}

/** What a sample under an 8G rule is, so the list can say so. */
export function sampleKind(rule: string): string | null {
  if (rule.startsWith("bad_bot")) return "User agents";
  if (rule.startsWith("bad_request") || rule.startsWith("bad_querystring")) return "Paths";
  if (rule.startsWith("not_allowed_method")) return "Methods";
  return null;
}

// ── the last 24 hours ───────────────────────────────────────────────────────

const count = (n: number) => n.toLocaleString("en-US");

/** "12" or, when the log was too long to read whole, "at least 12". */
export function dayCount(day: { total: number; complete: boolean }): string {
  return day.complete ? count(day.total) : `at least ${count(day.total)}`;
}

export function sevenDayText(day: G7Day | null): string {
  if (!day) return "No 7G log on the server for this site.";
  if (day.total === 0) return day.complete ? "7G blocked nothing in the last 24 hours." : "7G blocked nothing in the part of the log that was read.";
  return `7G blocked ${dayCount(day)} ${day.total === 1 ? "request" : "requests"} in the last 24 hours.`;
}

export function eightDayText(day: G8Day | null, mode: G8Mode | null): string {
  if (!day) return mode === "observe" ? "8G is observing, but it has not written a log yet." : "No 8G log on the server for this site.";
  const verb = mode === "enforce" ? "matched" : "would have blocked";
  if (day.total === 0) return `8G ${verb} nothing in the last 24 hours.`;
  return `8G ${verb} ${dayCount(day)} ${day.total === 1 ? "request" : "requests"} in the last 24 hours.`;
}

/**
 * Of the requests 8G flagged, how many got through today. In observe mode this
 * is what switching to 8G would add: 7G (or the site) let these through.
 */
export function eightGapText(day: G8Day | null): string | null {
  if (!day || day.total === 0) return null;
  const through = day.total - day.already;
  if (day.already === 0) {
    return day.total === 1 ? "It got through: 7G did not refuse it." : `All ${count(day.total)} got through: 7G refused none of them.`;
  }
  if (through === 0) {
    return day.total === 1 ? "It was refused anyway, by 7G or the site." : `All ${count(day.total)} were refused anyway, by 7G or the site.`;
  }
  return `${count(through)} got through; ${count(day.already)} ${day.already === 1 ? "was" : "were"} refused anyway, by 7G or the site.`;
}

// ── a server, and the fleet ─────────────────────────────────────────────────

export type WafSummary = {
  sites: number;
  sevenOn: number;
  weakened: number;
  noFirewall: number;
  observing: number;
  enforcing: number;
  idle: number;
  wouldBlock: number;
  wouldBlockComplete: boolean;
  blocked7: number;
};

export function wafSummary(rows: readonly SiteWafRow[]): WafSummary {
  const s: WafSummary = { sites: rows.length, sevenOn: 0, weakened: 0, noFirewall: 0, observing: 0, enforcing: 0, idle: 0, wouldBlock: 0, wouldBlockComplete: true, blocked7: 0 };
  for (const row of rows) {
    const mode = eightGMeta(row).mode;
    if (sevenGOn(row)) s.sevenOn++;
    if (rulesetsSwitchedOff(row).length) s.weakened++;
    if (posture(row).key === "none") s.noFirewall++;
    if (mode === "observe") s.observing++;
    if (mode === "enforce") s.enforcing++;
    if (mode === "installed") s.idle++;
    if (mode === "observe" && row.g8_day) {
      s.wouldBlock += row.g8_day.total;
      if (!row.g8_day.complete) s.wouldBlockComplete = false;
    }
    s.blocked7 += row.g7_day?.total ?? 0;
  }
  return s;
}

export type WafFilter = "all" | "observing" | "weakened" | "attention";

export function matchesFilter(row: SiteWafRow, filter: WafFilter): boolean {
  if (filter === "observing") return eightGMeta(row).mode === "observe";
  if (filter === "weakened") return rulesetsSwitchedOff(row).length > 0;
  if (filter === "attention") return needsAttention(row);
  return true;
}

/** Anything a person should look at: no firewall, a weakened one, or 8G in a state that is not doing what it says. */
export function needsAttention(row: SiteWafRow): boolean {
  const eight = eightGMeta(row);
  return posture(row).tone !== "ok" || rulesetsSwitchedOff(row).length > 0 || eight.tone === "warn" || eight.tone === "danger";
}

/** Sites in the order a person wants them: attention first, then most 8G activity, then by name. */
export function sortForList(rows: readonly SiteWafRow[]): SiteWafRow[] {
  return [...rows].sort((a, b) => {
    const att = Number(needsAttention(b)) - Number(needsAttention(a));
    if (att) return att;
    const act = (b.g8_day?.total ?? -1) - (a.g8_day?.total ?? -1);
    if (act) return act;
    return a.site.localeCompare(b.site);
  });
}

export function summaryText(s: WafSummary): string {
  if (s.sites === 0) return "No sites reported.";
  const parts = [`${s.sevenOn} of ${plural(s.sites, "site", "sites")} on 7G`];
  if (s.observing) parts.push(`${s.observing} with 8G observing`);
  if (s.enforcing) parts.push(`${s.enforcing} with 8G blocking`);
  if (s.idle) parts.push(`${s.idle} with 8G installed but idle`);
  return parts.join(", ") + ".";
}

/** A report is only as good as it is recent; the agent reports every ten minutes. */
export function reportStale(reportedAt: string | null | undefined, now: Date): boolean {
  if (!reportedAt) return true;
  const minutes = (now.getTime() - new Date(reportedAt).getTime()) / 60_000;
  return !Number.isFinite(minutes) || minutes > REPORT_INTERVAL_MINUTES * 2;
}
