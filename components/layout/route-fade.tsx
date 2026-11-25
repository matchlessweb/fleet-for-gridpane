"use client";

import { useLayoutEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { FIREWALL_TAB_PAGES } from "@/components/security/firewall-sections";
import { SETTINGS_TAB_PAGES } from "@/components/settings/settings-tabs";

/* Pages that share a title and a tab row count as one place: moving between
   them swaps the content under the row without fading the row itself. */
function placeOf(pathname: string) {
  if (FIREWALL_TAB_PAGES.has(pathname)) return "firewall";
  if (SETTINGS_TAB_PAGES.has(pathname)) return "settings";
  return pathname;
}

/**
 * One 150ms fade when the page really changes.
 *
 * It replaces app/(dashboard)/template.tsx, which keyed a framer-motion
 * wrapper on the path and the query string. That rebuilt the whole page (and
 * dropped its state) whenever a filter wrote to the URL, and it faded between
 * sibling tabs, which read as a jump. Here the page is never rebuilt: the
 * fade is a Web Animation on a wrapper that stays put.
 *
 * No fade on the first load, on a query change, between sibling tabs, or for
 * anyone who asked for reduced motion.
 */
export function RouteFade({ children }: { children: React.ReactNode }) {
  const place = placeOf(usePathname() ?? "");
  const ref = useRef<HTMLDivElement>(null);
  const shown = useRef(place);

  useLayoutEffect(() => {
    if (shown.current === place) return;
    shown.current = place;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    ref.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: "ease-out" });
  }, [place]);

  return (
    <div ref={ref} className="w-full">
      {children}
    </div>
  );
}
