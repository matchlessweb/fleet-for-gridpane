"use client";

import { usePathname } from "next/navigation";
import { ListChecks, Settings, ShieldCheck, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tab, Tabs } from "@/components/ui";

export const SETTINGS_SECTIONS = [
  { key: "general", href: "/settings", name: "General", icon: Settings },
  { key: "security", href: "/settings/security", name: "Security", icon: ShieldCheck },
  { key: "profile", href: "/settings/profile", name: "Profile", icon: User },
  { key: "setup", href: "/settings/setup", name: "Setup", icon: ListChecks },
] as const;

/** Pages that carry the Settings tab row (it replaces the breadcrumb there). */
export const SETTINGS_TAB_PAGES: ReadonlySet<string> = new Set(SETTINGS_SECTIONS.map((s) => s.href));

/**
 * The Settings section's tab row. It sits under the page title, as the
 * Firewall row does, so every top-level title lands at the same height.
 */
export function SettingsTabs({ className }: { className?: string }) {
  const pathname = usePathname();
  const active = SETTINGS_SECTIONS.find((s) => s.href === pathname)?.key ?? null;

  return (
    <Tabs id="settings" label="Settings sections" activeKey={active} className={cn("border-b border-border", className)}>
      {SETTINGS_SECTIONS.map((s) => {
        const Icon = s.icon;
        return (
          <Tab
            key={s.key}
            tabKey={s.key}
            href={s.href}
            label={s.name}
            icon={<Icon size={14} strokeWidth={1.75} aria-hidden="true" />}
          />
        );
      })}
    </Tabs>
  );
}
