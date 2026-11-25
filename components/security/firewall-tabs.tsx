"use client";

import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Tab, Tabs } from "@/components/ui";
import { FIREWALL_SECTIONS, firewallSectionFor } from "./firewall-sections";
import { useFirewallCounts } from "./use-firewall-counts";

/**
 * The Firewall section's own tab row, under the page title on all three
 * pages. The shared Tabs row; phones get the short labels.
 */
export function FirewallTabs({ className }: { className?: string }) {
  const pathname = usePathname();
  const active = firewallSectionFor(pathname);
  const counts = useFirewallCounts();

  return (
    <Tabs id="firewall" label="Firewall pages" activeKey={active} className={cn("border-b border-border", className)}>
      {FIREWALL_SECTIONS.map((s) => (
        <Tab key={s.key} tabKey={s.key} href={s.href} label={s.name} short={s.short} count={counts?.[s.key] ?? null} />
      ))}
    </Tabs>
  );
}
