import { ipFamily, ipInRange } from "./ip-allowlist.ts";

/**
 * Are a server's web ports (80 and 443) locked to Cloudflare?
 *
 * Every site here is expected to be proxied, so a visitor should only ever reach the origin
 * through Cloudflare. While 80/443 stay open to everyone, anyone who learns the
 * server's IP (an old DNS record, a certificate log, a leaked mail header) can
 * skip Cloudflare and every WAF rule in front of it. GridPane's
 * `gp cloudflare enable` closes that: it replaces the open rules with one UFW
 * rule per Cloudflare range.
 *
 * The agent reports `ufw_web_sources`: every source a UFW rule lets reach 80 or
 * 443, with "Anywhere" as 0.0.0.0/0 or ::/0 (scripts/telemetry-agent.sh,
 * ufw_web_sources). NULL means the agent predates the check.
 */

/**
 * Cloudflare's published ranges as of the date below, from
 * https://api.cloudflare.com/client/v4/ips. The dashboard asks Cloudflare for
 * today's list (/api/cloudflare-ips) and uses this only when that fails, so a
 * range Cloudflare adds later shows up as missing on every locked server.
 */
export const CLOUDFLARE_RANGES_BUILT_IN = {
  asOf: "2026-11-19",
  v4: [
    "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18",
    "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17",
    "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  ],
  v6: [
    "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32",
    "2a06:98c0::/29", "2c0f:f248::/32",
  ],
} as const;

export type CloudflareRanges = {
  ranges: string[];
  /** "cloudflare" when fetched today, "built-in" when the fetch failed. */
  source: "cloudflare" | "built-in";
  asOf: string;
};

export const BUILT_IN_RANGES: CloudflareRanges = {
  ranges: [...CLOUDFLARE_RANGES_BUILT_IN.v4, ...CLOUDFLARE_RANGES_BUILT_IN.v6],
  source: "built-in",
  asOf: CLOUDFLARE_RANGES_BUILT_IN.asOf,
};

function prefixOf(entry: string): number | null {
  const [net, bits] = entry.trim().split("/");
  const family = ipFamily(net);
  if (family === null) return null;
  if (bits === undefined) return family === "ipv4" ? 32 : 128;
  const n = Number(bits);
  const max = family === "ipv4" ? 32 : 128;
  return Number.isInteger(n) && n >= 0 && n <= max ? n : null;
}

/** Is every address in `inner` (address or CIDR) also inside `outer`? */
export function cidrWithin(inner: string, outer: string): boolean {
  const innerBits = prefixOf(inner);
  const outerBits = prefixOf(outer);
  if (innerBits === null || outerBits === null) return false;
  const innerNet = inner.trim().split("/")[0];
  if (ipFamily(innerNet) !== ipFamily(outer.split("/")[0])) return false;
  if (innerBits < outerBits) return false;
  return ipInRange(innerNet, outer.includes("/") ? outer : `${outer}/${outerBits}`);
}

function isEveryone(entry: string): boolean {
  return prefixOf(entry) === 0;
}

export type WebLockStatus =
  | "unreported"
  | "ufw-off"
  | "open"
  | "cloudflare"
  | "cloudflare-plus"
  | "cloudflare-partial"
  | "restricted"
  | "closed";

export type WebLock = {
  status: WebLockStatus;
  /** Sources outside every Cloudflare range (an operator address, say). "Everyone" is not listed here. */
  others: string[];
  /** Cloudflare ranges that no rule lets in. */
  missing: string[];
  /** How many reported sources sit inside a Cloudflare range. */
  cloudflareSources: number;
};

type StateLike = {
  ufw_enabled?: boolean | null;
  ufw_web_sources?: string[] | null;
} | null | undefined;

export function classifyWebLock(state: StateLike, cloudflare: readonly string[]): WebLock {
  const empty = { others: [], missing: [], cloudflareSources: 0 };
  if (!state || state.ufw_web_sources === null || state.ufw_web_sources === undefined) {
    return { status: "unreported", ...empty };
  }
  if (state.ufw_enabled === false) return { status: "ufw-off", ...empty };

  const sources = state.ufw_web_sources.map((s) => s.trim()).filter(Boolean);
  if (sources.length === 0) return { status: "closed", ...empty };

  const insideCf = (s: string) => cloudflare.some((range) => cidrWithin(s, range));
  const cfSources = sources.filter(insideCf);
  const others = sources.filter((s) => !insideCf(s) && !isEveryone(s));
  const missing = cloudflare.filter((range) => !sources.some((s) => cidrWithin(range, s)));
  const base = { others, missing, cloudflareSources: cfSources.length };

  if (sources.some(isEveryone)) return { status: "open", ...base, missing: [] };
  if (cfSources.length === 0) return { status: "restricted", ...base };
  if (missing.length > 0) return { status: "cloudflare-partial", ...base };
  return { status: others.length > 0 ? "cloudflare-plus" : "cloudflare", ...base };
}

export type WebLockTone = "ok" | "warn" | "danger" | "neutral";

/** Pill text, tone and a one-line explanation for each status. */
export function describeWebLock(lock: WebLock): { label: string; tone: WebLockTone; note: string } {
  switch (lock.status) {
    case "unreported":
      return {
        label: "Not reported",
        tone: "neutral",
        note: "This server's agent predates the check. Run scripts/fix-telemetry-crontabs.sh --update.",
      };
    case "ufw-off":
      return {
        label: "Firewall off",
        tone: "danger",
        note: "UFW is not running, so ports 80 and 443 answer any address.",
      };
    case "open":
      return {
        label: "Open to everyone",
        tone: "warn",
        note: "Anyone who knows this server's IP can reach its sites directly, skipping Cloudflare and its firewall rules. `gp cloudflare enable` on the server locks the web ports to Cloudflare.",
      };
    case "cloudflare":
      return {
        label: "Cloudflare only",
        tone: "ok",
        note: "Only Cloudflare can reach ports 80 and 443. A request straight to the server's IP gets no answer.",
      };
    case "cloudflare-plus":
      return {
        label: `Cloudflare + ${lock.others.length}`,
        tone: "ok",
        note: `Locked to Cloudflare, and also open to ${lock.others.length === 1 ? "one other address" : `${lock.others.length} other addresses`} (usually an operator allowlist entry).`,
      };
    case "cloudflare-partial":
      return {
        label: `${lock.missing.length} Cloudflare ${lock.missing.length === 1 ? "range" : "ranges"} missing`,
        tone: "warn",
        note: "Visitors Cloudflare routes through a missing range get an error page. Run `gp cloudflare enable` on the server again; it adds the new ranges and keeps the rest.",
      };
    case "restricted":
      return {
        label: "No Cloudflare ranges",
        tone: "danger",
        note: "Only the addresses below may reach ports 80 and 443, and none is Cloudflare, so proxied sites cannot load.",
      };
    case "closed":
      return {
        label: "Closed",
        tone: "danger",
        note: "No rule lets anything reach ports 80 and 443, so the sites on this server cannot load.",
      };
  }
}

/** Order for a fleet table: what needs attention first. */
export const WEB_LOCK_ORDER: Record<WebLockStatus, number> = {
  "ufw-off": 0,
  closed: 1,
  restricted: 2,
  "cloudflare-partial": 3,
  open: 4,
  unreported: 5,
  "cloudflare-plus": 6,
  cloudflare: 7,
};

/**
 * The allowlist label for an address that can reach the web ports, so "Also open
 * to" reads "Home" instead of a bare number. Undefined means no allowlist entry
 * covers it, which is worth a second look: nobody recorded why it is there.
 */
export function allowlistLabel(
  addr: string,
  allows: readonly { ip: string; label: string | null }[]
): string | undefined {
  const hit = allows.find((row) => cidrWithin(addr, row.ip));
  return hit ? hit.label ?? hit.ip : undefined;
}
