"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { readSiteParam } from "@/lib/site-row-id";
import { FIREWALL_TAB_PAGES } from "@/components/security/firewall-sections";
import { SETTINGS_TAB_PAGES } from "@/components/settings/settings-tabs";

const routeMap: Record<string, string> = {
  "servers": "Servers",
  "sites": "Sites",
  "backups": "Backups",
  "schedules": "Schedules",
  "monitoring": "Monitoring",
  "settings": "Settings",
  "firewall": "Firewall",
  "cloudflare": "Cloudflare WAF",
  "waf": "7G and 8G"
};

/**
 * The trail back up, on pages below the top level only (a server, a site, a
 * zone, Backup schedules).
 *
 * A top-level page has none: the masthead tab already says where you are, and
 * a line that some pages had and others did not put their titles at three
 * different heights. Pages with a tab row (Firewall, Settings) have none
 * either.
 *
 * The row has a fixed height and renders with the page, on the server too, so
 * it never arrives late and pushes the title down. It used to wait for the
 * browser, which moved everything 36px on a hard load.
 */
export function showsBreadcrumbs(pathname: string | null): boolean {
  if (!pathname) return false;
  if (FIREWALL_TAB_PAGES.has(pathname) || SETTINGS_TAB_PAGES.has(pathname)) return false;
  return pathname.split("/").filter(Boolean).length > 1;
}

export function RouteBreadcrumbs() {
  const pathname = usePathname();
  const [dynamicLabels, setDynamicLabels] = useState<Record<string, string>>({});

  useEffect(() => {
    let live = true;
    async function resolveDynamicLabels() {
      if (!showsBreadcrumbs(pathname)) return;
      const segments = pathname.split("/").filter(Boolean);
      const supabase = createClient();
      const newLabels: Record<string, string> = {};

      // The id after /servers and /monitoring is a server; after /sites, a site.
      for (const [parent, table, column] of [
        ["servers", "servers", "label"],
        ["monitoring", "servers", "label"],
        ["sites", "sites", "url"],
      ] as const) {
        const at = segments.indexOf(parent);
        const id = at === -1 ? undefined : segments[at + 1];
        if (!id || isNaN(Number(id))) continue;
        // A staging copy is listed under its live site's id made negative (lib/site-row-id.ts), so look up the live site and name the copy.
        const site = parent === "sites" ? readSiteParam(id) : null;
        if (parent === "sites" && !site) continue;
        const staging = site?.staging ?? false;
        const { data } = await supabase.from(table).select(column).eq("id", site ? site.siteId : Number(id)).maybeSingle();
        const value = (data as Record<string, string> | null)?.[column];
        if (value) newLabels[id] = staging ? `staging.${value}` : value;
      }

      if (live && Object.keys(newLabels).length > 0) {
        setDynamicLabels((prev) => ({ ...prev, ...newLabels }));
      }
    }

    resolveDynamicLabels();
    return () => {
      live = false;
    };
  }, [pathname]);

  if (!showsBreadcrumbs(pathname)) return null;

  const segments = pathname.split("/").filter(Boolean);

  return (
    <nav
      aria-label="Breadcrumb"
      className="hide-scrollbar mb-5 flex h-4 items-center overflow-x-auto whitespace-nowrap font-mono text-[10.5px] text-faint"
    >
      <Link href="/" className="transition-colors duration-150 hover:text-foreground">
        Overview
      </Link>

      {segments.map((segment, index) => {
        const isCurrent = index === segments.length - 1;
        const href = `/${segments.slice(0, index + 1).join("/")}`;
        // A segment with a dot is a hostname (a Cloudflare zone): show it as
        // written rather than capitalizing it like a section name.
        const title = routeMap[segment] || dynamicLabels[segment] || (segment.includes(".") ? decodeURIComponent(segment) : segment.charAt(0).toUpperCase() + segment.slice(1));

        return (
          <span key={href} className="flex items-center">
            <ChevronRight size={12} strokeWidth={1.75} aria-hidden="true" className="mx-1.5 shrink-0" />
            <Link
              href={href}
              aria-current={isCurrent ? "page" : undefined}
              className={cn("transition-colors duration-150 hover:text-foreground", isCurrent && "text-foreground")}
            >
              {title}
            </Link>
          </span>
        );
      })}
    </nav>
  );
}
