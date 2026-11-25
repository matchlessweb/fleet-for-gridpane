/**
 * Cloudflare WAF posture — shared types, labels and the zone ↔ site match.
 *
 * The data is the WAF inventory's report.json (written by
 * scripts/waf-inventory.py), loaded into Supabase by
 * scripts/ingest-waf-report.ts. This module never talks to Cloudflare, and no
 * part of the app holds a Cloudflare token.
 *
 * Vocabulary follows the inventory's five-rule standard: the
 * five rules, its three profiles (WordPress, static-site, dev-site),
 * and the inventory's classes, all explained in
 * docs/cloudflare-waf-standard.md. Do not invent labels here.
 *
 * No imports: the ingest script runs this file directly under Node.
 */

// ── shapes ──────────────────────────────────────────────────────────────────

export type WafKlass = "standard" | "standard-reordered" | "variant" | "custom" | "none";
export type WafProfile = "wordpress" | "static" | "dev";

export type WafRule = {
  desc: string;
  action: string;
  enabled: boolean;
  role: string;
  chars: number;
  /** Masked by the generator. Shown as-is; never re-read from Cloudflare. */
  expr: string;
  /** True when masking replaced at least one value in this expression. */
  expr_masked: boolean;
  clauses: string[];
  skip_scope?: { ruleset: string | null; phases: string[]; products: string[] };
  diff?: string[];
};

export type WafGreyRecord = {
  name: string;
  type: string;
  front: boolean;
  cls: string;
  /** A label number, never an address. */
  origin?: number;
};

export type WafReach = {
  reach?: string;
  grey?: WafGreyRecord[];
  grey_front?: number;
  grey_other?: number;
  delegated?: number;
  front_classes?: Record<string, number>;
  /** Hostnames with a proxied A/AAAA/CNAME record. Absent on older inventories. */
  proxied_names?: string[];
};

/** One zone exactly as report.json carries it (keyed by zone name there). */
export type ReportZone = {
  zone_id: string;
  plan: string;
  acct: string;
  paused: boolean;
  nrules: number;
  ratelimit_rules: number;
  version: string | null;
  updated: string;
  profile?: WafProfile | null;
  nearest?: WafProfile;
  klass: WafKlass;
  comparable?: boolean;
  core_fp: string | null;
  order?: string[];
  order_matches: boolean;
  findings: string[];
  reach: WafReach;
  rules: WafRule[];
};

/** A cloudflare_zones row without its rules — what the fleet view selects. */
export type ZoneSummary = {
  zone_id: string;
  name: string;
  run_id: number;
  plan: string | null;
  account: string | null;
  paused: boolean;
  nrules: number;
  ratelimit_rules: number;
  ruleset_version: string | null;
  ruleset_updated: string | null;
  profile: WafProfile | null;
  nearest: WafProfile | null;
  klass: WafKlass;
  comparable: boolean | null;
  core_fp: string | null;
  rule_order: string[];
  order_matches: boolean | null;
  findings: string[];
  reach: WafReach;
};

export type ZoneDetail = ZoneSummary & { rules: WafRule[] };

export type WafRun = {
  id: number;
  report_sha256: string;
  run_dir: string;
  generated_at: string;
  zone_count: number;
  rule_count: number;
  masked_count: number;
  ingested_at: string;
};

export const ZONE_SUMMARY_COLUMNS =
  "zone_id,name,run_id,plan,account,paused,nrules,ratelimit_rules,ruleset_version,ruleset_updated,profile,nearest,klass,comparable,core_fp,rule_order,order_matches,findings,reach";

// ── labels (the inventory's vocabulary) ────────────────────────────────────────────

type Tone = "neutral" | "ok" | "warn" | "danger";

export const KLASS_ORDER: WafKlass[] = ["variant", "custom", "none", "standard-reordered", "standard"];

export const KLASS_META: Record<WafKlass, { label: string; tone: Tone; meaning: string }> = {
  standard: {
    label: "Standard",
    tone: "ok",
    meaning: "Matches its profile clause for clause, in order.",
  },
  "standard-reordered": {
    label: "Standard, reordered",
    tone: "ok",
    meaning: "Every clause matches its profile; the rules sit in a different order.",
  },
  variant: {
    label: "Variant",
    tone: "warn",
    meaning: "Compared against a profile and differs from it. Each difference is listed.",
  },
  custom: {
    label: "Own rules",
    tone: "warn",
    meaning: "Its own rule set. It could not be compared against any profile.",
  },
  none: {
    label: "No custom rules",
    tone: "danger",
    meaning: "The zone has no WAF custom rules at all.",
  },
};

export const PROFILE_LABEL: Record<WafProfile, string> = {
  wordpress: "Five-rule standard",
  static: "Static-site profile",
  dev: "Dev-site profile",
};

export function profileLabel(profile: WafProfile | null | undefined): string {
  return profile ? PROFILE_LABEL[profile] ?? profile : "No profile";
}

/** Rule roles as the inventory names them, in the standard's words. */
export const ROLE_LABEL: Record<string, string> = {
  skip: "Rule 1 skip",
  noindex: "Rule 1 block (dev)",
  providers: "Providers and countries",
  crawlers: "Aggressive crawlers",
  vpn: "VPNs and WP login",
  block: "Block",
  other: "Not part of a profile",
};

export const ACTION_LABEL: Record<string, string> = {
  skip: "Skip",
  managed_challenge: "Managed challenge",
  block: "Block",
};

/**
 * DNS reach: do the zone's rules actually stand in front of its site?
 * (docs/cloudflare-waf-standard.md §4.1 — a zone can carry every rule and be
 * unprotected because its front door is DNS-only.)
 */
export const REACH_META: Record<string, { label: string; tone: Tone; meaning: string } | undefined> = {
  proxied: {
    label: "Proxied",
    tone: "neutral",
    meaning: "The front door is proxied, so the rules apply to it.",
  },
  bypass: {
    label: "Bypassed",
    tone: "danger",
    meaning:
      "The apex or www is DNS-only and points at one of your own servers, so visitors skip these rules entirely.",
  },
  review: {
    label: "Unidentified front door",
    tone: "warn",
    meaning: "The front door is DNS-only and its target was not recognized. It needs a live probe.",
  },
  "platform-front": {
    label: "Third-party front door",
    tone: "neutral",
    meaning:
      "The front door is DNS-only and points at a third-party platform. That is expected to stay DNS-only; proxying it would break the platform's certificate.",
  },
  "no-site": {
    label: "No site records",
    tone: "neutral",
    meaning: "The zone has no apex or www record to protect.",
  },
};

export function reachMeta(reach: WafReach | null | undefined) {
  const key = reach?.reach ?? "";
  return (
    REACH_META[key] ?? {
      label: key || "Reach unknown",
      tone: "warn" as Tone,
      meaning: "The inventory reported a reach value this app does not know.",
    }
  );
}

// ── masking ─────────────────────────────────────────────────────────────────

/** The generator's redaction marker, e.g. `<40-char value redacted>`. */
export const MASK_MARKER = /<\d+-char value redacted>/g;

export function maskedValueCount(expr: string): number {
  return (expr.match(MASK_MARKER) ?? []).length;
}

/**
 * Long opaque tokens that survived masking. Same pattern the generator masks
 * with, so anything this finds is a value the generator should have removed.
 * All-digit runs are not secrets (ASNs never reach 20 digits anyway).
 */
export function unmaskedLongTokens(text: string): string[] {
  const stripped = text.replace(MASK_MARKER, " ");
  return (stripped.match(/(?<![\w.])[A-Za-z0-9_-]{20,}(?![\w.])/g) ?? []).filter(
    (t) => !/^\d+$/.test(t)
  );
}

/**
 * Checks a parsed report.json before it is loaded. Returns problems as text;
 * an empty list means it is safe to ingest. Never includes a token's value in
 * a message — only where it is and how long.
 */
export function validateReport(report: unknown): string[] {
  const problems: string[] = [];
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return ["report.json is not an object keyed by zone name"];
  }
  const entries = Object.entries(report as Record<string, ReportZone>);
  if (entries.length === 0) problems.push("report.json contains no zones");
  const ids = new Set<string>();
  const klasses = new Set<string>(Object.keys(KLASS_META));

  for (const [name, z] of entries) {
    const at = `zone ${name}`;
    if (!z || typeof z !== "object") {
      problems.push(`${at}: not an object`);
      continue;
    }
    if (typeof z.zone_id !== "string" || !/^[0-9a-f]{32}$/.test(z.zone_id)) {
      problems.push(`${at}: zone_id is not a 32-character id`);
    } else if (ids.has(z.zone_id)) {
      problems.push(`${at}: zone_id appears twice in the report`);
    } else {
      ids.add(z.zone_id);
    }
    if (!klasses.has(z.klass)) problems.push(`${at}: unknown klass "${String(z.klass)}"`);
    if (!Array.isArray(z.rules)) {
      problems.push(`${at}: rules is not a list`);
      continue;
    }
    if (!Array.isArray(z.findings)) problems.push(`${at}: findings is not a list`);
    if (z.nrules !== z.rules.length) {
      problems.push(`${at}: nrules says ${z.nrules} but ${z.rules.length} rules are present`);
    }
    z.rules.forEach((r, i) => {
      const where = `${at}, rule ${i + 1}`;
      if (typeof r.expr !== "string" || r.expr.length === 0) {
        problems.push(`${where}: no expression`);
        return;
      }
      if (typeof r.expr_masked !== "boolean") {
        problems.push(`${where}: expr_masked flag is missing`);
      } else if (r.expr_masked !== maskedValueCount(r.expr) > 0) {
        problems.push(
          `${where}: expr_masked is ${r.expr_masked} but the expression holds ${maskedValueCount(r.expr)} redaction marker(s)`
        );
      }
      const text = [r.expr, ...(Array.isArray(r.clauses) ? r.clauses : [])].join("\n");
      const leaked = unmaskedLongTokens(text);
      if (leaked.length > 0) {
        problems.push(
          `${where}: ${leaked.length} unmasked long value(s) (${leaked
            .slice(0, 3)
            .map((t) => `${t.length} chars`)
            .join(", ")}) — refusing to load a possible secret`
        );
      }
    });
    // The DNS sweep must never carry an origin address (the page verifier
    // asserts the same thing).
    if (/(?:^|[^\d.])(\d{1,3}\.){3}\d{1,3}(?:[^\d.]|$)/.test(JSON.stringify(z.reach ?? {}))) {
      problems.push(`${at}: the reach record contains an IPv4 address`);
    }
  }
  return problems;
}

// ── zone ↔ site match ───────────────────────────────────────────────────────

/** Lowercased bare hostname from a URL, a host, or a host with a path. */
export function normalizeHost(input: string | null | undefined): string {
  if (!input) return "";
  return input
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/^[^@]*@/, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
}

/**
 * Is one hostname proxied through Cloudflare? Answered from evidence in the
 * inventory, never from a guess: the hostname is either in the zone's list of
 * proxied records, in its list of DNS-only records, or in neither.
 */
export type HostProxyState = "proxied" | "dns-only" | "no-record" | "not-checked" | "no-zone";
export type HostProxy = { state: HostProxyState; label: string; meaning: string };

export function hostProxy(host: string, zone: { name: string; reach: WafReach | null } | null | undefined): HostProxy {
  const h = normalizeHost(host);
  if (!zone) {
    return {
      state: "no-zone",
      label: "Not on Cloudflare",
      meaning: "No Cloudflare zone in the inventory covers this hostname.",
    };
  }
  const reach = zone.reach ?? {};
  if ((reach.grey ?? []).some((g) => normalizeHost(g.name) === h)) {
    return {
      state: "dns-only",
      label: "DNS only",
      meaning: "Cloudflare answers DNS for this hostname but visitors connect straight to the server, so its WAF rules and edge bans do not apply.",
    };
  }
  if (!Array.isArray(reach.proxied_names)) {
    return {
      state: "not-checked",
      label: "Not checked yet",
      meaning: "The last Cloudflare inventory did not record which hostnames are proxied. The next daily refresh will.",
    };
  }
  if (reach.proxied_names.some((n) => normalizeHost(n) === h)) {
    return {
      state: "proxied",
      label: "Proxied",
      meaning: "Visitors reach this hostname through Cloudflare.",
    };
  }
  return {
    state: "no-record",
    label: "No proxied record",
    meaning: `The ${zone.name} zone has no proxied record with this exact name. It may be covered by a wildcard, point outside the zone, or have no DNS record.`,
  };
}

/**
 * The zone a hostname belongs to: the longest zone name that equals the host
 * or is a dot-bounded suffix of it. Cloudflare zone names are the registrable
 * domains, so this needs no public-suffix list, and it handles www, deeper
 * subdomains and staging hosts the same way.
 *
 * The dot boundary matters: clinic.example.com is NOT a suffix
 * match for clinic-group.example.com, and neither is a prefix trick
 * away from the other.
 *
 * Best effort, not a foreign key: it says the names line up, not that the
 * hostname's DNS record is proxied through that zone.
 */
export function zoneNameForHost(host: string, zoneNames: readonly string[]): string | null {
  const h = normalizeHost(host);
  if (!h) return null;
  let best: string | null = null;
  for (const raw of zoneNames) {
    const z = raw.toLowerCase();
    if (h === z || h.endsWith("." + z)) {
      if (best === null || z.length > best.length) best = z;
    }
  }
  return best;
}

/**
 * A GridPane site record. `server` is the server's label: one address can be on
 * two servers while a moved site's old copy is kept, and the label is what tells
 * the two links apart.
 */
export type SiteRef = { id: number; url: string; server?: string | null };

/** The columns to select from `sites` for siteRefs(). */
export const SITE_REF_COLUMNS = "id,url,servers(label)";

/** Rows selected with SITE_REF_COLUMNS → SiteRef. */
export function siteRefs(rows: readonly unknown[] | null | undefined): SiteRef[] {
  return (rows ?? []).map((raw) => {
    const r = raw as { id: number; url: string; servers?: { label?: string | null } | { label?: string | null }[] | null };
    const srv = Array.isArray(r.servers) ? r.servers[0] : r.servers;
    return { id: r.id, url: r.url, server: srv?.label ?? null };
  });
}

/** The link text for a site in a list: the address, plus its server when the same address is listed twice. */
export function siteRefText(site: SiteRef, list: readonly SiteRef[]): string {
  const twice = list.some((o) => o.id !== site.id && o.url === site.url);
  return twice ? `${site.url} (${site.server ?? "unknown server"})` : site.url;
}

/** zone name → the sites whose hostname falls inside it. */
export function sitesByZone<S extends SiteRef>(
  sites: readonly S[],
  zoneNames: readonly string[]
): { byZone: Map<string, S[]>; unmatchedSites: S[] } {
  const byZone = new Map<string, S[]>();
  const unmatchedSites: S[] = [];
  for (const s of sites) {
    const z = zoneNameForHost(s.url, zoneNames);
    if (!z) {
      unmatchedSites.push(s);
      continue;
    }
    const list = byZone.get(z) ?? [];
    list.push(s);
    byZone.set(z, list);
  }
  for (const list of byZone.values())
    list.sort((a, b) => a.url.localeCompare(b.url) || (a.server ?? "").localeCompare(b.server ?? ""));
  return { byZone, unmatchedSites };
}

// ── staleness ───────────────────────────────────────────────────────────────

export const STALE_WARN_DAYS = 7;
export const STALE_DANGER_DAYS = 14;

export type Staleness = { days: number; tone: Tone; age: string; advice: string | null };

/** How old the inventory run is, in whole days, and what to say about it. */
export function staleness(generatedAt: string, now: Date = new Date()): Staleness {
  const ms = now.getTime() - new Date(generatedAt).getTime();
  const days = Math.max(0, Math.floor(ms / 86_400_000));
  const age = days === 0 ? "less than a day old" : days === 1 ? "1 day old" : `${days} days old`;
  if (days > STALE_DANGER_DAYS) {
    return {
      days,
      tone: "danger",
      age,
      advice: "This is out of date. Re-run the inventory before acting on anything here.",
    };
  }
  if (days > STALE_WARN_DAYS) {
    return {
      days,
      tone: "warn",
      age,
      advice: "Rules may have changed since. Re-run the inventory before acting on this.",
    };
  }
  return { days, tone: "ok", age, advice: null };
}

/** "Nov 11, 2026" — fixed locale and zone so server and client agree. */
export function formatRunDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "America/Chicago",
  });
}

export function formatRunTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Chicago",
    timeZoneName: "short",
  });
}

// ── typography ──────────────────────────────────────────────────────────────

/**
 * Binds the last two words of a sentence with a no-break space so the final
 * word never sits alone on its own line. `text-wrap: pretty` already does this
 * in Chromium and Safari 26; this covers the browsers that do not. Only for
 * prose whose last two words are short: a bound pair wider than its column
 * would push text off screen, which is worse than a stranded word.
 */
export function tie(text: string): string {
  return text.replace(/ (\S+)\s*$/, "\u00a0$1");
}

// ── fleet grouping ──────────────────────────────────────────────────────────

export type FleetSectionKey = "findings" | "custom" | "none" | "standard";

/**
 * Which section of the fleet view a zone belongs in. First match wins, so a
 * zone appears exactly once: zones with findings first, then own-rule zones
 * with nothing listed, then zones with no rules, then everything on standard.
 */
export function fleetSection(z: Pick<ZoneSummary, "klass" | "findings">): FleetSectionKey {
  if (z.findings.length > 0) return "findings";
  if (z.klass === "custom") return "custom";
  if (z.klass === "none") return "none";
  if (z.klass === "variant") return "findings";
  return "standard";
}

// ── unattended runs ─────────────────────────────────────────────────────────
// The generator records a zone whose ruleset could not be read as having no
// rules, so one failed request looks exactly like someone deleting every rule.
// A person running the ingest sees the summary and can judge; the daily job
// cannot. So an unattended run holds (writes nothing) when a zone disappears or
// a zone that had rules now has none, and leaves it for a person to confirm.
export function unattendedHolds(
  previous: { name: string; nrules: number }[],
  next: { name: string; nrules: number }[]
): string[] {
  const now = new Map(next.map((z) => [z.name, z.nrules]));
  const holds: string[] = [];
  for (const z of [...previous].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!now.has(z.name)) holds.push(`${z.name} is no longer in the report`);
    else if (z.nrules > 0 && now.get(z.name) === 0) holds.push(`${z.name} had ${z.nrules} rules and now has none`);
  }
  return holds;
}
