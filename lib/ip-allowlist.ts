/**
 * IP allowlisting — the opposite direction to lib/ip-blocking.ts.
 *
 * These are the addresses that must never be blocked: office ranges, a home
 * connection, a mobile hotspot. Getting locked out of a client's site by your
 * own security tooling is the failure this prevents, and the layers do not
 * cover for each other:
 *
 *   Fail2Ban ignoreip (the primary control)
 *     Stops a ban from ever being CREATED. Nothing then reaches the edge or
 *     local iptables, which makes every downstream precedence question moot.
 *     This is the one to set first.
 *
 *   UFW allow
 *     Packet level, server-wide. Relevant for SSH and anything else not
 *     travelling over 80/443. Cannot see a Cloudflare-proxied visitor, exactly
 *     as on the blocking side.
 *
 *   Cloudflare IP Access Rules → Allow
 *     Beats a Block for the same address and bypasses Cloudflare's MANAGED
 *     security. It does NOT bypass custom WAF or rate-limit rules — those need
 *     their own skip expression, which is the trap most people miss.
 *
 * Nothing here talks to a server. Every function returns text meant to be
 * pasted into an SSH session (or, for Cloudflare, followed by hand).
 */

import { fleetConfig } from "../fleet.config.ts";
import { sanitizeComment, validateIp, type IpValidation } from "./ip-blocking.ts";

export type AllowLayer = "fail2ban" | "ufw" | "cloudflare";
/** Where the exemption applies. Operator IPs are almost always fleet-wide. */
export type AllowScope = "global" | "server" | "site";

export const ALLOW_LAYER_LABELS: Record<AllowLayer, string> = {
  fail2ban: "Fail2Ban ignoreip",
  ufw: "UFW allow",
  cloudflare: "Cloudflare IP Access Rules",
};

/** Re-exported so callers validate allowlist input exactly as they validate blocks. */
export { validateIp };
export type { IpValidation };

/* ------------------------------------------------------------------ *
 * Layer guidance
 * ------------------------------------------------------------------ */

export function allowLayerNote(layer: AllowLayer): string {
  switch (layer) {
    case "fail2ban":
      return "Prevents a ban being created at all, across every jail. Set this one first — it makes the other two unnecessary for Fail2Ban's own bans.";
    case "ufw":
      return "Packet level, whole server. Matters for SSH and non-web ports. It cannot see a visitor behind Cloudflare, because the packets arrive from Cloudflare's edge.";
    case "cloudflare":
      return "Beats a Block for the same address and skips Cloudflare's managed security. It does NOT skip your own custom WAF or rate-limit rules.";
  }
}

/**
 * A single host address on a consumer connection will drift, and a stale
 * allowlist entry protects nothing while looking like it does. Static company
 * ranges are the reliable form. Warning only — the operator may know their IP
 * is pinned.
 */
export function dynamicAddressWarning(validation: IpValidation, label: string): string | null {
  if (!validation.ok || validation.isCidr) return null;
  if (validation.family !== "ipv4") return null;
  if (!/\b(home|house|hotspot|mobile|phone|cell|residential|starlink|wifi)\b/i.test(label)) return null;
  return "Consumer connections usually get a dynamic address. This will stop matching when your ISP rotates it — prefer a static office range, and re-check this entry periodically.";
}

/* ------------------------------------------------------------------ *
 * Fail2Ban — ignoreip
 * ------------------------------------------------------------------ */

/**
 * A drop-in, not an edit to jail.local.
 *
 * Fail2Ban reads jail.conf → jail.d/*.conf → jail.local → jail.d/*.local, so a
 * `.local` drop-in has the last word and survives package updates. Same
 * reasoning as GridPane's update-safe nginx `*-context.conf` includes: never
 * hand-edit a file the vendor regenerates.
 */
export const IGNOREIP_PATH = `/etc/fail2ban/jail.d/${fleetConfig.server.prefix}-allowlist.local`;

/** Always present. See buildFail2banIgnoreip — ignoreip REPLACES, it does not append. */
const LOOPBACK = ["127.0.0.1/8", "::1"];

export type Fail2banIgnore = {
  path: string;
  config: string;
  script: string;
  removeScript: string;
  /** The full effective list, loopback included — handy for the UI. */
  entries: string[];
};

/**
 * The whole ignoreip file, rewritten from the full list.
 *
 * THE TRAP: `ignoreip` in a drop-in REPLACES the inherited value, it does not
 * extend it. Writing `ignoreip = <office>` silently drops Fail2Ban's default
 * `127.0.0.1/8 ::1`, so the server can start banning itself — its own health
 * checks and any loopback-sourced request. Loopback is therefore prepended
 * unconditionally and is not the caller's responsibility to remember.
 *
 * [DEFAULT] applies to every jail, present and future, which is what an
 * operator allowlist wants — a per-jail entry would miss the next jail
 * GridPane adds.
 */
export function buildFail2banIgnoreip({
  ips,
  comment,
}: {
  ips: string[];
  comment?: string;
}): Fail2banIgnore {
  const seen = new Set<string>();
  const extra: string[] = [];
  for (const raw of ips) {
    const addr = raw.trim().toLowerCase();
    if (!addr || LOOPBACK.includes(addr)) continue;
    if (seen.has(addr)) continue;
    seen.add(addr);
    extra.push(addr);
  }
  const entries = [...LOOPBACK, ...extra];
  const note = sanitizeComment(comment);

  const lines = [
    `# Managed by ${fleetConfig.name} — operator allowlist.`,
    "# A .local drop-in wins over jail.local and survives package updates.",
    "# NOTE: ignoreip REPLACES the inherited value rather than extending it, so",
    "# loopback is listed explicitly — without it the server can ban itself.",
  ];
  if (note) lines.push(`# ${note}`);
  lines.push("", "[DEFAULT]", `ignoreip = ${entries.join(" ")}`);
  const config = lines.join("\n");

  const script = [
    `sudo tee ${IGNOREIP_PATH} > /dev/null <<'EOF'`,
    config,
    `EOF`,
    ``,
    `# Apply, then confirm what Fail2Ban actually holds for a jail`,
    `sudo fail2ban-client reload`,
    `sudo fail2ban-client get sshd ignoreip`,
  ].join("\n");

  const removeScript = [
    `# Removes every entry in this file, loopback included — Fail2Ban falls back`,
    `# to whatever jail.local and jail.conf define.`,
    `sudo rm ${IGNOREIP_PATH}`,
    `sudo fail2ban-client reload`,
  ].join("\n");

  return { path: IGNOREIP_PATH, config, script, removeScript, entries };
}

/* ------------------------------------------------------------------ *
 * UFW — allow
 * ------------------------------------------------------------------ */

export type UfwAllow = {
  allow: string;
  script: string;
  remove: string;
};

/**
 * `insert 1` for the same reason the deny path uses it: UFW is first-match-wins.
 *
 * The ordering hazard is real and worth stating in the generated output. Both
 * this and the block generator insert at position 1, so whichever command was
 * run LAST sits on top. Add a deny for a range after allowing an address inside
 * it and the deny shadows the allow — `ufw status numbered` is the only way to
 * see which way round they ended up.
 */
export function buildUfwAllow({ ip, comment }: { ip: string; comment?: string }): UfwAllow {
  const addr = ip.trim();
  const note = sanitizeComment(comment);
  const commentArg = note ? ` comment '${note}'` : "";

  const allow = `sudo ufw insert 1 allow from ${addr} to any${commentArg}`;
  const remove = `sudo ufw delete allow from ${addr} to any`;

  const script = [
    `# Position 1, because UFW matches top-down and stops at the first hit.`,
    allow,
    ``,
    `# Check the order. Anything inserted later sits ABOVE this rule — if a deny`,
    `# for a range containing this address is listed first, it wins.`,
    `sudo ufw status numbered`,
  ].join("\n");

  return { allow, script, remove };
}

/* ------------------------------------------------------------------ *
 * Cloudflare — IP Access Rules
 * ------------------------------------------------------------------ */

export type CloudflareAllow = {
  steps: string[];
  removal: string;
  note: string;
};

/**
 * A dashboard action on purpose. This app holds no zone-scoped Cloudflare
 * token, and adding one to write firewall rules is a larger decision than a
 * rule generator should make on its own.
 */
export function buildCloudflareAllowInstructions(ip: string): CloudflareAllow {
  const addr = ip.trim();
  return {
    steps: [
      "Cloudflare dashboard → pick the zone for this site",
      "Security → WAF → Tools → IP Access Rules",
      `Value: ${addr}`,
      "Action: Allow",
      "Zone: this website (or All websites in the account, for an operator range)",
      "Add — it takes effect at the edge within seconds",
    ],
    removal: `Same screen — find ${addr} in the rules list and delete it.`,
    note: "An Allow beats a Block for the same address and skips Cloudflare's managed security (security level, managed WAF, Bot Fight Mode). It does NOT skip your own custom WAF or rate-limiting rules — each of those needs its own skip expression for this address.",
  };
}

/* ------------------------------------------------------------------ *
 * Coverage
 * ------------------------------------------------------------------ */

export function ipFamily(ip: string): "ipv4" | "ipv6" | null {
  const addr = ip.trim();
  if (!addr) return null;
  if (addr.includes(":")) return "ipv6";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(addr.split("/")[0])) return "ipv4";
  return null;
}

/** IPv4 dotted quad -> unsigned 32-bit, or null. */
function v4ToLong(v4: string): number | null {
  const parts = v4.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = out * 256 + n;
  }
  return out >>> 0;
}

/**
 * IPv6 -> sixteen bytes, expanding "::" and any IPv4-mapped tail.
 * Returns null for anything it cannot parse rather than guessing, because a
 * wrong expansion here would silently claim coverage that does not exist.
 */
function v6ToBytes(input: string): number[] | null {
  let addr = input.trim().toLowerCase();
  if (!addr.includes(":")) return null;
  addr = addr.replace(/%.*$/, ""); // drop any zone id

  // An IPv4-mapped tail (an IPv4 address written after the ::ffff: prefix) becomes two more hex groups.
  const v4Tail = addr.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4Tail) {
    const long = v4ToLong(v4Tail[1]);
    if (long === null) return null;
    const hi = (long >>> 16).toString(16);
    const lo = (long & 0xffff).toString(16);
    addr = addr.slice(0, v4Tail.index) + hi + ":" + lo;
  }

  const halves = addr.split("::");
  if (halves.length > 2) return null;

  const parse = (chunk: string): number[] | null => {
    if (!chunk) return [];
    const out: number[] = [];
    for (const group of chunk.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };

  const head = parse(halves[0] ?? "");
  const tail = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if (head === null || tail === null) return null;

  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...Array(fill).fill(0), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const g of groups) {
    bytes.push((g >> 8) & 0xff, g & 0xff);
  }
  return bytes;
}

/** Do the first `bits` bits of two byte arrays match? */
function bytesMatch(a: number[], b: number[], bits: number): boolean {
  const whole = Math.floor(bits / 8);
  for (let i = 0; i < whole; i++) if (a[i] !== b[i]) return false;
  const rem = bits % 8;
  if (rem === 0) return true;
  const mask = (0xff << (8 - rem)) & 0xff;
  return (a[whole] & mask) === (b[whole] & mask);
}

/**
 * Does `ip` fall inside `entry`, where entry is a bare address or a CIDR?
 *
 * Both families do real prefix maths. IPv6 matters more here than it looks:
 * a home or cellular connection gets a delegated PREFIX (/56, /64) with a
 * rotating suffix, so exact matching would fail on the same connection an hour
 * later — and cellular is IPv6-first, which is how this surfaced. Comparing
 * across families always returns false, because an IPv4 allowlist entry
 * genuinely does not protect an IPv6 connection.
 */
export function ipInRange(ip: string, entry: string): boolean {
  const addr = ip.trim().toLowerCase();
  const target = entry.trim().toLowerCase();
  if (!addr || !target) return false;
  if (addr === target) return true;

  const [net, bitsRaw] = target.split("/");
  const family = ipFamily(addr);
  if (family === null || family !== ipFamily(net)) return false;

  if (family === "ipv4") {
    if (bitsRaw === undefined) return false;
    const bits = Number(bitsRaw);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    const a = v4ToLong(addr);
    const n = v4ToLong(net);
    if (a === null || n === null) return false;
    if (bits === 0) return true;
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    return ((a & mask) >>> 0) === ((n & mask) >>> 0);
  }

  const bits = bitsRaw === undefined ? 128 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 128) return false;
  const a = v6ToBytes(addr);
  const n = v6ToBytes(net);
  if (a === null || n === null) return false;
  return bytesMatch(a, n, bits);
}

export type Coverage = {
  covered: boolean;
  /** The entry that covers it, when one does. */
  by: { ip: string; label: string } | null;
};

/** Is the address you are connecting from protected by any active entry? */
export function coverageFor(
  ip: string | null | undefined,
  entries: { ip: string; label: string }[]
): Coverage {
  if (!ip) return { covered: false, by: null };
  for (const entry of entries) {
    if (ipInRange(ip, entry.ip)) return { covered: true, by: entry };
  }
  return { covered: false, by: null };
}

/** Plain-language summary of where an entry is meant to be in force. */
export function describeScope(scope: AllowScope, target?: string | null): string {
  switch (scope) {
    case "global":
      return "Every server in the fleet";
    case "server":
      return target ? `Server: ${target}` : "One server";
    case "site":
      return target ? `Site: ${target}` : "One site";
  }
}

/**
 * Whether the agent's read-back confirms an entry is genuinely in place.
 *
 * `reported` being null means the agent on that box does not report allowlist
 * state yet — which is NOT the same as reporting an empty list, and must not be
 * shown as "missing". Callers get three states, never two.
 */
export type VerifyState = "verified" | "missing" | "unreported";

export function verifyAgainstAgent(ip: string, reported: string[] | null | undefined): VerifyState {
  if (reported === null || reported === undefined) return "unreported";
  const needle = ip.trim().toLowerCase();
  return reported.some((entry) => entry.trim().toLowerCase() === needle) ? "verified" : "missing";
}
