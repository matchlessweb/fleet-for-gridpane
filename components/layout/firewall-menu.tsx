"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { Panel, TabLabel, tabClasses, claimOverlay, releaseOverlay } from "@/components/ui";
import { ALLOW_AN_IP_EVENT, FIREWALL_SECTIONS, firewallSectionFor } from "@/components/security/firewall-sections";
import { useFirewallCounts } from "@/components/security/use-firewall-counts";

const OPEN_DELAY_MS = 120; // a pointer crossing the nav doesn't open it
const CLOSE_DELAY_MS = 220; // room to travel from the trigger to the panel
const PANEL_WIDTH = 360;

/**
 * Firewall in the masthead nav. The word is still a link to Server firewall;
 * hovering it, or the chevron (click, Enter, Space or Arrow Down), opens a
 * menu of the section's three pages with a count for each. The panel renders
 * in a portal at a fixed position: below lg the nav row scrolls sideways and
 * would clip an absolutely placed panel.
 */
export function FirewallMenu({ isActive }: { isActive: boolean }) {
  const pathname = usePathname();
  const current = firewallSectionFor(pathname);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const chevronRef = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuId = useId();
  const counts = useFirewallCounts(open);

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const hide = useCallback(() => {
    clearTimer();
    setOpen(false);
  }, []);

  const show = useCallback((focusFirst = false) => {
    clearTimer();
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.max(12, Math.min(r.left - 12, window.innerWidth - PANEL_WIDTH - 12));
    setPos({ left, top: r.bottom + 6 });
    setOpen(true);
    if (focusFirst) {
      requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus());
    }
  }, []);

  // One overlay at a time: opening this closes search or the action log, and the reverse.
  useEffect(() => {
    if (!open) return;
    claimOverlay(hide);
    return () => releaseOverlay(hide);
  }, [open, hide]);

  // Outside press, Esc, and any scroll or resize close it (closing beats chasing the trigger).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!wrapRef.current?.contains(t) && !panelRef.current?.contains(t)) hide();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      hide();
      chevronRef.current?.focus();
    };
    const scroller = document.getElementById("main-scroll-container");
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", hide);
    scroller?.addEventListener("scroll", hide, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", hide);
      scroller?.removeEventListener("scroll", hide);
    };
  }, [open, hide]);

  useEffect(() => clearTimer, []);

  const onPointerEnter = (e: React.PointerEvent) => {
    if (e.pointerType !== "mouse") return; // touch uses the chevron
    clearTimer();
    if (!open) timer.current = setTimeout(() => show(), OPEN_DELAY_MS);
  };
  const onPointerLeave = (e: React.PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    clearTimer();
    timer.current = setTimeout(hide, CLOSE_DELAY_MS);
  };

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    const items = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    if (items.length === 0) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => {
      e.preventDefault();
      items[(n + items.length) % items.length]?.focus();
    };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(items.length - 1);
    else if (e.key === "Tab") hide();
  };

  const onAllow = (e: React.MouseEvent) => {
    hide();
    // Already on Server firewall: open its dialog in place instead of navigating to the same page.
    if (pathname === "/firewall") {
      e.preventDefault();
      window.dispatchEvent(new Event(ALLOW_AN_IP_EVENT));
    }
  };

  return (
    <div ref={wrapRef} className="relative flex items-center" onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>
      {/* A tab like its neighbors: the rail's shared underline finds it by data-tab-key. */}
      <Link
        href="/firewall"
        data-tab-key="/firewall"
        aria-current={pathname === "/firewall" ? "page" : undefined}
        className={tabClasses(isActive, "rail")}
      >
        <TabLabel>Firewall</TabLabel>
      </Link>
      <button
        ref={chevronRef}
        type="button"
        aria-label="Firewall pages"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? hide() : show())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            show(true);
          }
        }}
        className="ml-0.5 flex h-[26px] w-[18px] items-center justify-center rounded-sm text-muted-foreground transition-colors duration-150 hover:text-foreground"
      >
        <ChevronDown
          size={13}
          strokeWidth={1.75}
          aria-hidden="true"
          className={cn("transition-transform duration-150 motion-reduce:transition-none", open && "rotate-180")}
        />
      </button>

      {open &&
        pos &&
        createPortal(
          <Panel
            ref={panelRef}
            id={menuId}
            role="menu"
            aria-label="Firewall pages"
            onPointerEnter={onPointerEnter}
            onPointerLeave={onPointerLeave}
            onKeyDown={onMenuKeyDown}
            style={{ left: pos.left, top: pos.top, width: PANEL_WIDTH }}
            className="anim-fade fixed z-50 max-w-[calc(100vw-24px)] p-1.5 shadow-2xl"
          >
            {FIREWALL_SECTIONS.map((s) => {
              const here = s.key === current;
              const n = counts?.[s.key];
              const Icon = s.icon;
              return (
                <Link
                  key={s.key}
                  href={s.href}
                  role="menuitem"
                  aria-current={here ? "page" : undefined}
                  onClick={hide}
                  className="grid grid-cols-[32px_minmax(0,1fr)_auto] items-start gap-2.5 rounded-md px-2.5 py-2 outline-none transition-colors duration-150 hover:bg-panel-2 focus-visible:bg-panel-2"
                >
                  <span
                    className={cn(
                      "flex h-8 w-8 items-center justify-center rounded-md border bg-background",
                      here ? "border-primary/40 text-primary" : "border-border text-muted-foreground"
                    )}
                  >
                    <Icon size={15} strokeWidth={1.75} aria-hidden="true" />
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
                      {s.name}
                      {here && <span aria-hidden="true" className="h-[5px] w-[5px] rounded-full bg-primary" />}
                    </span>
                    <span className="mt-px block text-pretty text-[12px] leading-snug text-muted-foreground">
                      {s.description}
                    </span>
                  </span>
                  <span className="whitespace-nowrap pt-0.5 font-mono text-[10.5px] tabular-nums text-faint">
                    {n != null ? `${n} ${n === 1 ? s.unit[0] : s.unit[1]}` : ""}
                  </span>
                </Link>
              );
            })}
            <div className="mt-1 flex items-center justify-between gap-3 border-t border-border px-2.5 pb-1 pt-2">
              <Link
                href="/firewall?allow=1"
                role="menuitem"
                onClick={onAllow}
                className="inline-flex items-center gap-1.5 rounded-sm text-[12.5px] font-semibold text-primary outline-none hover:underline focus-visible:underline"
              >
                <ShieldCheck size={14} strokeWidth={1.75} aria-hidden="true" />
                Allow an IP
              </Link>
              <span className="eyebrow text-faint">Esc to close</span>
            </div>
          </Panel>,
          document.body
        )}
    </div>
  );
}
