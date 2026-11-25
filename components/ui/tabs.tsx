"use client";

import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * Tabs: the one underlined tab row (masthead rail, Firewall, Settings).
 *
 * Two things it guarantees:
 *  - Labels never move. The active tab is bold, and bold text is wider, so
 *    each label reserves its bold width up front (`tab-label` in globals.css).
 *    Before this, every label after the active one shifted 3 to 4px on each
 *    switch.
 *  - One underline that slides to the active tab in 150ms. A row that is
 *    rebuilt with its page (Firewall, Settings) starts its underline where
 *    that row's last one stood, so it still slides.
 *
 * These are navigation links, not ARIA tabs: a <nav> of links with
 * aria-current. Left, Right, Home and End move focus along the row.
 */

type Rect = { left: number; width: number };
/* Where each row's underline last stood, by row id. Survives a remount. */
const lastRect = new Map<string, Rect>();

const TabsContext = React.createContext<{ activeKey: string | null; size: "rail" | "row" }>({
  activeKey: null,
  size: "row",
});

export function Tabs({
  id,
  label,
  activeKey,
  size = "row",
  className,
  indicatorClassName,
  children,
}: {
  /** Stable name for this row; the underline's last position is kept under it. */
  id: string;
  /** Accessible name of the <nav>. */
  label: string;
  activeKey: string | null;
  /** "rail" is the masthead's row; "row" sits under a page title. */
  size?: "rail" | "row";
  className?: string;
  indicatorClassName?: string;
  children: React.ReactNode;
}) {
  const navRef = React.useRef<HTMLElement>(null);
  const [rect, setRect] = React.useState<Rect | null>(() => lastRect.get(id) ?? null);
  // No slide for the first placement of a row that has no earlier position.
  const [animate, setAnimate] = React.useState(() => lastRect.has(id));

  const measure = React.useCallback(() => {
    const nav = navRef.current;
    if (!nav) return;
    const el = activeKey
      ? nav.querySelector<HTMLElement>(`[data-tab-key="${CSS.escape(activeKey)}"]`)
      : null;
    if (!el) {
      setRect(null);
      return;
    }
    const n = nav.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const next = { left: Math.round((r.left - n.left + nav.scrollLeft) * 10) / 10, width: Math.round(r.width * 10) / 10 };
    lastRect.set(id, next);
    setRect((prev) => (prev && prev.left === next.left && prev.width === next.width ? prev : next));
  }, [activeKey, id]);

  React.useLayoutEffect(() => {
    measure();
    const raf = requestAnimationFrame(() => setAnimate(true));
    return () => cancelAnimationFrame(raf);
  }, [measure]);

  React.useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const ro = new ResizeObserver(measure);
    ro.observe(nav);
    nav.querySelectorAll("[data-tab-key]").forEach((el) => ro.observe(el));
    let live = true;
    document.fonts?.ready.then(() => live && measure());
    return () => {
      live = false;
      ro.disconnect();
    };
  }, [measure]);

  // Keep the active tab in view when the row scrolls sideways (narrow screens).
  React.useEffect(() => {
    const nav = navRef.current;
    if (!nav || !activeKey || nav.scrollWidth <= nav.clientWidth) return;
    nav.querySelector<HTMLElement>(`[data-tab-key="${CSS.escape(activeKey)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeKey]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.altKey || e.metaKey || e.ctrlKey) return;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    const at = (e.target as HTMLElement).closest?.("[data-tab-key]");
    if (!at) return; // a control beside a tab (the Firewall chevron) keeps its own keys
    const tabs = Array.from(navRef.current?.querySelectorAll<HTMLElement>("[data-tab-key]") ?? []);
    const i = tabs.indexOf(at as HTMLElement);
    if (i < 0) return;
    e.preventDefault();
    const next =
      e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next]?.focus();
  };

  const ctx = React.useMemo(() => ({ activeKey, size }), [activeKey, size]);

  return (
    <nav
      ref={navRef}
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn("hide-scrollbar relative flex items-center gap-6 overflow-x-auto whitespace-nowrap", className)}
    >
      <TabsContext.Provider value={ctx}>{children}</TabsContext.Provider>
      <span
        aria-hidden="true"
        data-tab-indicator=""
        style={rect ? { width: rect.width, transform: `translateX(${rect.left}px)` } : undefined}
        className={cn(
          "pointer-events-none absolute bottom-0 left-0 h-[2.5px] bg-primary",
          animate && "transition-[transform,width] duration-150 ease-out",
          !rect && "opacity-0",
          indicatorClassName
        )}
      />
    </nav>
  );
}

/** Text that holds its bold width, so going bold moves nothing beside it. */
export function TabLabel({ children, className }: { children: string; className?: string }) {
  return (
    <span data-label={children} className={cn("tab-label", className)}>
      {children}
    </span>
  );
}

export function tabClasses(active: boolean, size: "rail" | "row" = "row") {
  return cn(
    "relative flex shrink-0 items-baseline gap-2 whitespace-nowrap text-[13.5px] transition-colors duration-150",
    size === "rail" ? "py-[9px]" : "pb-2.5 pt-1",
    active ? "font-bold text-foreground" : "font-medium text-muted-foreground hover:text-foreground"
  );
}

/**
 * One tab: a link. `short` replaces the label below `sm`; `count` shows from
 * `sm` up. Pass `count={null}` while a count is loading: its place is held, so
 * the tabs after it do not step sideways when the number arrives.
 */
export function Tab({
  tabKey,
  href,
  label,
  short,
  count,
  icon,
  className,
  ...rest
}: {
  tabKey: string;
  href: string;
  label: string;
  short?: string;
  count?: number | null;
  icon?: React.ReactNode;
  className?: string;
} & Omit<React.ComponentProps<typeof Link>, "href" | "children" | "className">) {
  const { activeKey, size } = React.useContext(TabsContext);
  const active = tabKey === activeKey;
  return (
    <Link
      href={href}
      data-tab-key={tabKey}
      aria-current={active ? "page" : undefined}
      className={cn(tabClasses(active, size), icon != null && "items-center gap-1.5", className)}
      {...rest}
    >
      {icon}
      {short ? (
        <>
          <TabLabel className="sm:hidden">{short}</TabLabel>
          <TabLabel className="hidden sm:inline-flex">{label}</TabLabel>
        </>
      ) : (
        <TabLabel>{label}</TabLabel>
      )}
      {count !== undefined && (
        <span className="hidden min-w-[2ch] font-mono text-[10.5px] font-normal tabular-nums text-faint sm:inline-block">
          {count}
        </span>
      )}
    </Link>
  );
}
