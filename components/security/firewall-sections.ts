import { Cloud, Layers, ShieldHalf, type LucideIcon } from "lucide-react";

export type FirewallSectionKey = "servers" | "cloudflare" | "waf";

export type FirewallSection = {
  key: FirewallSectionKey;
  href: string;
  name: string;
  /** Phone label: three tabs share a 375px row. */
  short: string;
  description: string;
  icon: LucideIcon;
  /** What the count beside the name counts. */
  unit: [singular: string, plural: string];
};

/** The Firewall section's pages, in the order the menu and the tab row show them. */
export const FIREWALL_SECTIONS: readonly FirewallSection[] = [
  {
    key: "servers",
    href: "/firewall",
    name: "Server firewall",
    short: "Servers",
    description: "UFW, Fail2Ban and who can reach each server",
    icon: ShieldHalf,
    unit: ["server", "servers"],
  },
  {
    key: "cloudflare",
    href: "/firewall/cloudflare",
    name: "Cloudflare WAF",
    short: "Cloudflare",
    description: "Custom rules and what they blocked, per zone",
    icon: Cloud,
    unit: ["zone", "zones"],
  },
  {
    key: "waf",
    href: "/firewall/waf",
    name: "7G and 8G",
    short: "7G · 8G",
    description: "GridPane's 7G and the 8G observer, per site",
    icon: Layers,
    unit: ["site", "sites"],
  },
];

/** The Firewall page a path belongs to (a zone page belongs to Cloudflare WAF), or null outside Firewall. */
export function firewallSectionFor(pathname: string | null): FirewallSectionKey | null {
  if (!pathname) return null;
  const under = (base: string) => pathname === base || pathname.startsWith(`${base}/`);
  if (under("/firewall/cloudflare")) return "cloudflare";
  if (under("/firewall/waf")) return "waf";
  if (under("/firewall")) return "servers";
  return null;
}

/**
 * Pages that carry the tab row, which replaces the breadcrumb there. A single
 * zone's page sits one level deeper and keeps its breadcrumb.
 */
export const FIREWALL_TAB_PAGES: ReadonlySet<string> = new Set(FIREWALL_SECTIONS.map((s) => s.href));

/** Fired when "Allow an IP" is chosen from the menu while Server firewall is already open. */
export const ALLOW_AN_IP_EVENT = "fleet:allow-an-ip";
