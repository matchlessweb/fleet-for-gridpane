/**
 * IP blocking — rule authoring for the three layers that can actually stop a
 * visitor on a GridPane fleet.
 *
 * The three layers are not interchangeable, and the differences are the whole
 * reason this file exists:
 *
 *   UFW (server firewall)
 *     Filters IP packets at the kernel. It has no idea which vhost an HTTP
 *     request was aimed at, so there is no such thing as a per-site UFW rule —
 *     a UFW ban covers every site on the box. Two further traps below
 *     (rule order, and Cloudflare) make it the wrong default more often than
 *     operators expect.
 *
 *   nginx deny (per site, or server-wide include)
 *     Runs after the request is parsed, so it can be scoped to one site. On a
 *     Cloudflare-proxied site this is the layer that works: GridPane restores
 *     the real visitor IP, so nginx's $remote_addr is the true client rather
 *     than a Cloudflare edge address.
 *
 *   Cloudflare IP Access Rules
 *     Stops the request at the edge, before it ever costs the origin
 *     bandwidth. Only available when the site is actually proxied, and it is
 *     a dashboard action — not something to generate a shell command for.
 *
 * Nothing here talks to a server. Every function returns text meant to be
 * pasted into an SSH session (or, for Cloudflare, followed by hand).
 */

import { fleetConfig } from "../fleet.config.ts";

export type Layer = "ufw" | "nginx" | "cloudflare";
export type BlockScope = "server" | "site";

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

export type IpValidation = {
  ok: boolean;
  /** Trimmed, lowercased address (CIDR suffix preserved) — "" when invalid. */
  normalized: string;
  /** Hard failure. Nothing is generated while this is set. */
  error: string | null;
  /**
   * Soft failure: the address parses, but blocking it is probably a mistake.
   * Rules still generate — the operator may know better than we do.
   */
  warning: string | null;
  family: "ipv4" | "ipv6" | null;
  isCidr: boolean;
};

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
// Permissive IPv6: full, compressed (::), and IPv4-mapped tails.
const IPV6_RE =
  /^(([0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|([0-9a-f]{1,4}:){1,7}:|([0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}|([0-9a-f]{1,4}:){1,5}(:[0-9a-f]{1,4}){1,2}|([0-9a-f]{1,4}:){1,4}(:[0-9a-f]{1,4}){1,3}|([0-9a-f]{1,4}:){1,3}(:[0-9a-f]{1,4}){1,4}|([0-9a-f]{1,4}:){1,2}(:[0-9a-f]{1,4}){1,5}|[0-9a-f]{1,4}:((:[0-9a-f]{1,4}){1,6})|:((:[0-9a-f]{1,4}){1,7}|:)|::(ffff(:0{1,4})?:)?((25[0-5]|(2[0-4]|1?\d)?\d)\.){3}(25[0-5]|(2[0-4]|1?\d)?\d))$/i;

const empty: IpValidation = {
  ok: false,
  normalized: "",
  error: null,
  warning: null,
  family: null,
  isCidr: false,
};

/**
 * Ranges where a block is almost always a misfire: RFC1918 LAN space,
 * loopback, link-local, and CGNAT. Behind a proxy or a misread log these turn
 * up looking like a real attacker; banning them can lock out the operator,
 * the load balancer, or the server's own health checks.
 */
function privateRangeNote(v4: number[]): string | null {
  const [a, b] = v4;
  if (a === 127) return "Loopback. Blocking it cuts the server off from itself.";
  if (a === 10) return "Private LAN range (10.0.0.0/8) — not a public visitor.";
  if (a === 192 && b === 168) return "Private LAN range (192.168.0.0/16) — not a public visitor.";
  if (a === 172 && b >= 16 && b <= 31) return "Private LAN range (172.16.0.0/12) — not a public visitor.";
  if (a === 169 && b === 254) return "Link-local (169.254.0.0/16) — not a routable visitor address.";
  if (a === 100 && b >= 64 && b <= 127) return "Carrier-grade NAT (100.64.0.0/10) — shared by many subscribers.";
  if (a === 0) return "Unspecified range (0.0.0.0/8) — not a usable source address.";
  return null;
}

/**
 * Accepts a single IPv4/IPv6 address or a CIDR block.
 *
 * Two classes of problem, kept apart on purpose:
 *   error   — cannot generate anything (octet > 255, junk text, a range)
 *   warning — generates fine, but read this first (private/loopback, a wide
 *             prefix that would sweep up thousands of innocent addresses)
 */
export function validateIp(input: string): IpValidation {
  const raw = input.trim().toLowerCase();
  if (!raw) return empty;

  // Common paste mistakes worth naming rather than failing generically.
  if (/\s/.test(raw)) {
    return { ...empty, error: "One address at a time — that looks like several." };
  }
  // Only call it a range when it actually looks like one (203.0.113.4-203.0.113.9);
  // any other hyphenated text falls through to the generic message.
  if (/^[\da-f.:]+-[\da-f.:]+$/i.test(raw)) {
    return { ...empty, error: "Ranges are not supported. Use CIDR notation, e.g. 203.0.113.0/24." };
  }

  const slash = raw.indexOf("/");
  const isCidr = slash !== -1;
  const addr = isCidr ? raw.slice(0, slash) : raw;
  const prefixText = isCidr ? raw.slice(slash + 1) : null;

  const v4match = addr.match(IPV4_RE);
  const isV6 = !v4match && IPV6_RE.test(addr);

  if (!v4match && !isV6) {
    return { ...empty, error: "Not a recognizable IPv4 or IPv6 address." };
  }

  const family: "ipv4" | "ipv6" = v4match ? "ipv4" : "ipv6";

  // Octet bounds: the single most common typo, and one that iptables and
  // nginx both reject with far less helpful messages than this.
  if (v4match) {
    const octets = v4match.slice(1, 5).map(Number);
    const bad = octets.find((n) => n > 255);
    if (bad !== undefined) {
      return { ...empty, error: `${bad} is not a valid octet — each must be 0–255.` };
    }
  }

  let prefix: number | null = null;
  if (isCidr) {
    if (!/^\d{1,3}$/.test(prefixText ?? "")) {
      return { ...empty, error: "CIDR prefix must be a number, e.g. /24." };
    }
    prefix = Number(prefixText);
    const max = family === "ipv4" ? 32 : 128;
    if (prefix > max) {
      return { ...empty, error: `Prefix /${prefix} is out of range — the maximum for ${family === "ipv4" ? "IPv4" : "IPv6"} is /${max}.` };
    }
  }

  // Warnings — everything below this point still generates rules.
  let warning: string | null = null;

  if (v4match) {
    warning = privateRangeNote(v4match.slice(1, 5).map(Number));
  } else if (addr === "::1") {
    warning = "Loopback. Blocking it cuts the server off from itself.";
  } else if (/^f[cd]/.test(addr)) {
    warning = "Unique local IPv6 (fc00::/7) — not a public visitor.";
  }

  if (!warning && prefix !== null) {
    // /16 on v4 is 65,536 addresses; /32 on v6 is an entire ISP allocation.
    if (family === "ipv4" && prefix < 16) {
      warning = `A /${prefix} covers over ${(2 ** (32 - prefix)).toLocaleString()} addresses. Confirm you mean to block that many.`;
    } else if (family === "ipv6" && prefix < 32) {
      warning = `A /${prefix} covers an enormous slice of IPv6. Confirm you mean to block that much.`;
    }
  }

  return { ok: true, normalized: raw, error: null, warning, family, isCidr };
}

/* ------------------------------------------------------------------ *
 * Layer recommendation
 * ------------------------------------------------------------------ */

export type Recommendation = {
  layer: Layer;
  /** One sentence: why this layer, for this site or server. */
  why: string;
};

export const LAYER_LABELS: Record<Layer, string> = {
  ufw: "UFW (server firewall)",
  nginx: "nginx deny",
  cloudflare: "Cloudflare IP Access Rules",
};

/**
 * One-line caveat per layer, shown next to every option so the tradeoff is on
 * screen even when the operator overrides the recommendation.
 */
export function layerCaveat(layer: Layer, isProxied: boolean): string {
  switch (layer) {
    case "ufw":
      return isProxied
        ? "Will not stop this traffic: behind Cloudflare, packets arrive from Cloudflare's edge, not the visitor."
        : "Server-wide only — it drops packets before nginx sees them, so it cannot be limited to one site.";
    case "nginx":
      return "Works behind Cloudflare (GridPane restores the real visitor IP), and can be scoped to a single site — but the request still reaches the origin.";
    case "cloudflare":
      return isProxied
        ? "Stops the request at the edge, so it never costs the origin anything. Applies to every hostname in the zone."
        : "Only applies once the site is actually proxied through Cloudflare.";
  }
}

/**
 * Which layer to reach for.
 *
 * The logic is short, but each branch encodes a fact that is easy to get
 * wrong in the moment:
 *   proxied            → UFW cannot see the visitor's IP at all
 *   per-site, direct   → UFW has no vhost awareness, so nginx it is
 *   whole server, direct → UFW is the cheapest place to drop the packet
 */
export function recommendLayer({
  isProxied,
  scope,
}: {
  isProxied: boolean;
  scope: BlockScope;
}): Recommendation {
  if (isProxied) {
    return {
      layer: "cloudflare",
      why: "This site is proxied through Cloudflare, so the block belongs at the edge — a server firewall rule would only ever see Cloudflare's own IPs, never the visitor's.",
    };
  }
  if (scope === "site") {
    return {
      layer: "nginx",
      why: "UFW filters packets and has no idea which site a request was for, so a per-site block has to be an nginx deny.",
    };
  }
  return {
    layer: "ufw",
    why: "Nothing here is site-specific, so drop the packets at the firewall before they reach nginx at all.",
  };
}

/* ------------------------------------------------------------------ *
 * UFW
 * ------------------------------------------------------------------ */

export type UfwCommands = {
  /** The insert command that actually blocks. */
  block: string;
  /** Block + verification, ready to paste as one chunk. */
  script: string;
  /** How to undo it later. */
  remove: string;
};

/**
 * UFW rules are evaluated top-down, first match wins — and GridPane's default
 * profile already contains `allow 80,443`. A plain `ufw deny from <ip>` is
 * APPENDED, lands after those allows, and therefore never matches a single
 * web request. It looks installed (`ufw status` lists it) and does nothing.
 *
 * `ufw insert 1` puts the deny at position 1, ahead of the allows, which is
 * the only form that works. Everything this function emits is built on that.
 */
export function buildUfwCommands({
  ip,
  comment,
}: {
  ip: string;
  comment?: string;
}): UfwCommands {
  const addr = ip.trim();
  // ufw's own comment flag: it survives reboots and shows in `status numbered`,
  // which is the difference between an auditable rule and a mystery in a year.
  const note = sanitizeComment(comment);
  const commentArg = note ? ` comment '${note}'` : "";

  const block = `sudo ufw insert 1 deny from ${addr} to any${commentArg}`;
  const remove = `sudo ufw delete deny from ${addr} to any`;

  const script = [
    `# Position 1 matters: GridPane's UFW already allows 80,443, and rules are`,
    `# matched top-down. An appended deny would sit AFTER those allows and`,
    `# never fire. 'insert 1' puts it in front of them.`,
    block,
    ``,
    `# Confirm it landed at #1, above the 80/443 allows`,
    `sudo ufw status numbered`,
  ].join("\n");

  return { block, script, remove };
}

/* ------------------------------------------------------------------ *
 * nginx deny
 * ------------------------------------------------------------------ */

export type NginxDeny = {
  /** Update-safe include path. */
  path: string;
  /** Full file contents (all IPs, not just the new one). */
  config: string;
  /** Write the file, test the config, reload. */
  script: string;
  /** How to take one address back out. */
  removeScript: string;
};

/**
 * Update-safe include paths. GridPane globs these into every site (or every
 * server block) and they survive stack updates — unlike the shipped configs,
 * which are regenerated and will silently lose hand edits.
 */
export function denyFilePath(scope: BlockScope, siteUrl: string, name = "ip-blocks"): string {
  return scope === "site"
    ? `/var/www/${siteUrl}/nginx/${name}-context.conf`
    : `/etc/nginx/extra.d/${name}-context.conf`;
}

/**
 * Strip anything that would break out of a single-quoted shell string or an
 * nginx comment. Exported so lib/ip-allowlist.ts shares one definition rather
 * than growing a second, subtly different one.
 */
export function sanitizeComment(comment?: string): string {
  return (comment ?? "").replace(/['"\n\r\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

export type DenyEntry = { ip: string; reason?: string | null };

/**
 * The whole deny file, rewritten from the full list.
 *
 * Rewriting rather than appending is deliberate: it is the only way removal
 * can work from a UI, and it keeps the file's contents equal to the ledger
 * the operator is looking at. `deny` inside an include applies to the server
 * block it is pulled into — one address per line, comments carry the reason.
 */
export function buildNginxDeny({
  ip,
  siteUrl,
  scope = "site",
  existingIps = [],
  comment,
}: {
  ip: string;
  siteUrl: string;
  scope?: BlockScope;
  existingIps?: DenyEntry[];
  comment?: string;
}): NginxDeny {
  const addr = ip.trim();
  const path = denyFilePath(scope, siteUrl);

  // De-dupe: nginx tolerates a repeated deny, but a duplicated line in a
  // generated file is how ledgers drift out of sync with reality.
  const seen = new Set<string>();
  const entries: DenyEntry[] = [];
  for (const e of [...existingIps, ...(addr ? [{ ip: addr, reason: comment ?? null }] : [])]) {
    const key = e.ip.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    entries.push({ ip: e.ip.trim(), reason: e.reason ?? null });
  }

  const header = [
    `# Managed by ${fleetConfig.name} — IP blocks.`,
    scope === "site"
      ? `# Applies to ${siteUrl} only. Update-safe include: GridPane stack`
      : "# Applies to every site on this server. Update-safe include: GridPane",
    scope === "site"
      ? "# updates will not overwrite this file."
      : "# stack updates will not overwrite this file.",
    "# nginx sees the real visitor IP here — GridPane restores it behind Cloudflare.",
  ];

  const body = entries.length
    ? entries.map((e) => {
        const note = sanitizeComment(e.reason ?? undefined);
        return note ? `deny ${e.ip};  # ${note}` : `deny ${e.ip};`;
      })
    : ["# No addresses blocked."];

  const config = [...header, "", ...body].join("\n");

  const script = [
    `sudo tee ${path} > /dev/null <<'EOF'`,
    config,
    `EOF`,
    ``,
    `# Validate before reloading — a bad include takes every site down`,
    `nginx -t && gp ngx reload`,
  ].join("\n");

  const removeScript = [
    `# Drop this one address, keep the rest of the file`,
    `sudo sed -i '/^deny ${addr.replace(/[.*[\]\/]/g, "\\$&")};/d' ${path}`,
    ``,
    `nginx -t && gp ngx reload`,
  ].join("\n");

  return { path, config, script, removeScript };
}

/* ------------------------------------------------------------------ *
 * Cloudflare
 * ------------------------------------------------------------------ */

export type CloudflareInstructions = {
  steps: string[];
  removal: string;
  note: string;
};

/**
 * Cloudflare blocking is a dashboard action, and it stays one here.
 *
 * There is a REST endpoint for IP Access Rules, but using it means holding a
 * zone-scoped API token in this app to spend on a job that takes fifteen
 * seconds by hand. This app does not hold that token, so it does not pretend
 * to — the operator gets steps, not a curl with a placeholder secret in it.
 */
export function buildCloudflareInstructions(ip: string): CloudflareInstructions {
  const addr = ip.trim() || "the address";
  return {
    steps: [
      "Open the Cloudflare dashboard and pick the zone for this site.",
      "Go to Security → WAF → Tools.",
      "Under IP Access Rules, paste " + addr + " into the value field.",
      "Set the action to Block.",
      "Choose the scope — this website, or all websites in the account.",
      "Add a note with the reason, then click Add.",
    ],
    removal: "Security → WAF → Tools → IP Access Rules, find the entry for " + addr + ", then Delete.",
    note: "Blocks at Cloudflare's edge, so the request never reaches the origin. No server restart, and nothing to reload.",
  };
}
