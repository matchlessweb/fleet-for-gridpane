"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutGrid,
  Server,
  Globe,
  DatabaseBackup,
  Activity,
  ShieldHalf,
  Settings,
  Ellipsis,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Sheet } from "@/components/ui";

type TabItem = { name: string; href: string; icon: LucideIcon; hint?: string };

// Four pages get a tab. The other three sit one tap away under More: seven
// across left 53px each at 375 and 8px labels.
const tabs: TabItem[] = [
  { name: "Overview", href: "/", icon: LayoutGrid },
  { name: "Servers", href: "/servers", icon: Server },
  { name: "Sites", href: "/sites", icon: Globe },
  { name: "Firewall", href: "/firewall", icon: ShieldHalf },
];
// The last two words of each hint are bound: the sheet is narrow enough to strand one.
const more: TabItem[] = [
  { name: "Backups", href: "/backups", icon: DatabaseBackup, hint: "Backup coverage by server, and the\u00A0schedules." },
  { name: "Monitoring", href: "/monitoring", icon: Activity, hint: "CPU, memory and disk readings per\u00A0server." },
  { name: "Settings", href: "/settings", icon: Settings, hint: "The GridPane connection, sign-in security and your\u00A0profile." },
];

const isCurrent = (pathname: string | null, href: string) => (href === "/" ? pathname === "/" : !!pathname?.startsWith(href));

const tabClass = (active: boolean) =>
  cn(
    "flex min-h-[56px] flex-col items-center justify-center gap-1 transition-colors duration-150",
    active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
  );

function TabFace({ icon: Icon, name, active }: { icon: LucideIcon; name: string; active: boolean }) {
  return (
    <>
      <span className="relative">
        <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
        {active && <span aria-hidden="true" className="absolute -right-[7px] -top-[2px] h-[5px] w-[5px] rounded-full bg-primary" />}
      </span>
      <span className={cn("font-mono text-[10px] uppercase leading-none tracking-[0.08em]", active && "font-semibold")}>{name}</span>
    </>
  );
}

/**
 * Bottom tab bar — phone navigation (<md). Four tabs and More, which opens a
 * sheet with the rest. More shows as current while one of its pages is open.
 * Sits below overlays and bulk bars (z-40).
 */
export function BottomTabBar() {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = React.useState(false);
  const inMore = more.some((item) => isCurrent(pathname, item.href));

  return (
    <>
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-line-strong bg-panel pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        <div className="grid grid-cols-5">
          {tabs.map((tab) => {
            const active = isCurrent(pathname, tab.href);
            return (
              <Link key={tab.href} href={tab.href} aria-current={active ? "page" : undefined} className={tabClass(active)}>
                <TabFace icon={tab.icon} name={tab.name} active={active} />
              </Link>
            );
          })}
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            aria-label={inMore ? "More pages, current page is here" : "More pages"}
            onClick={() => setMoreOpen(true)}
            className={tabClass(inMore)}
          >
            <TabFace icon={Ellipsis} name="More" active={inMore} />
          </button>
        </div>
      </nav>

      <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} side="center" width={360} title="More" contentClassName="p-0">
        <ul className="py-1.5 pb-[calc(6px+env(safe-area-inset-bottom))] sm:pb-1.5">
          {more.map((item) => {
            const active = isCurrent(pathname, item.href);
            const Icon = item.icon;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  onClick={() => setMoreOpen(false)}
                  className="flex min-h-[56px] items-center gap-3 px-5 py-2.5 outline-none transition-colors duration-150 hover:bg-panel-2/60 focus-visible:bg-panel-2"
                >
                  <Icon size={18} strokeWidth={1.75} aria-hidden="true" className={cn("shrink-0", active ? "text-primary" : "text-muted-foreground")} />
                  <span className="min-w-0 flex-1">
                    <span className={cn("block text-[13px]", active ? "font-bold" : "font-semibold")}>{item.name}</span>
                    <span className="block text-pretty text-[12px] text-muted-foreground">{item.hint}</span>
                  </span>
                  {active && <span className="eyebrow shrink-0 text-muted-foreground">Here</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      </Sheet>
    </>
  );
}
