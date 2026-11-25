"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMounted } from "@/lib/use-mounted";
import { IconButton } from "./button";
import { useIsPhone } from "./use-media";
import { useOverlay } from "./use-overlay";

type SheetProps = {
  open: boolean;
  onClose: () => void;
  /** Its shape from `sm` up. Below `sm` every sheet rises from the bottom. */
  side?: "right" | "center";
  /** Widest it gets from `sm` up, in px. */
  width?: number;
  title?: React.ReactNode;
  meta?: React.ReactNode;
  /** Replaces the title strip. The sheet then needs `label`. */
  header?: React.ReactNode;
  /** Its accessible name when there is no `title`. */
  label?: string;
  /** Id of the text that says what will happen (alert dialogs). */
  describedBy?: string;
  role?: "dialog" | "alertdialog";
  /** Opens on top of another overlay without closing it (a confirm over a form). */
  stack?: boolean;
  footer?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
};

/**
 * Sheet — the one modal surface. A side panel or a centered box from `sm` up;
 * on phones it rises from the bottom, keeps the page visible above it, and
 * drags down by its handle or header to close. Drawer, ConfirmDialog, Peek and
 * the phone menus are all this.
 */
export function Sheet({
  open,
  onClose,
  side = "right",
  width = 440,
  title,
  meta,
  header,
  label,
  describedBy,
  role = "dialog",
  stack = false,
  footer,
  children,
  className,
  contentClassName,
}: SheetProps) {
  const mounted = useMounted();
  const isPhone = useIsPhone();
  const hostRef = React.useRef<HTMLDivElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  const close = useOverlay(open, onClose, hostRef, { stack });

  /* Drag to close, phones only. The handle and the header are the grip; the
     body scrolls, so it is left alone. */
  const drag = React.useRef<{ y: number; t: number; dy: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isPhone || e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, a, input, select, textarea")) return;
    drag.current = { y: e.clientY, t: e.timeStamp, dy: 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const panel = panelRef.current;
    if (!d || !panel) return;
    d.dy = Math.max(0, e.clientY - d.y);
    panel.style.animation = "none"; // the entrance must not fight the finger
    panel.style.transform = `translateY(${d.dy}px)`;
  };
  const onPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const panel = panelRef.current;
    drag.current = null;
    if (!d || !panel) return;
    const speed = d.dy / Math.max(1, e.timeStamp - d.t); // px per ms
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const from = `translateY(${d.dy}px)`;
    if (e.type !== "pointercancel" && (d.dy > 96 || (d.dy > 24 && speed > 0.6))) {
      if (still) return close();
      panel.animate([{ transform: from }, { transform: "translateY(100%)" }], { duration: 140, easing: "ease-in", fill: "forwards" }).finished.then(close, close);
      return;
    }
    panel.style.transform = "";
    if (!still && d.dy > 0) panel.animate([{ transform: from }, { transform: "translateY(0)" }], { duration: 160, easing: "ease-out" });
  };
  const grip = { onPointerDown, onPointerMove, onPointerUp: onPointerEnd, onPointerCancel: onPointerEnd };

  if (!mounted || !open) return null;

  const hasStrip = header == null && (title != null || meta != null);

  return createPortal(
    <div
      ref={hostRef}
      data-overlay-root=""
      className={cn(
        "fixed inset-0 z-[100] flex max-sm:items-end",
        side === "center" ? "sm:items-center sm:justify-center sm:p-5" : "sm:justify-end"
      )}
    >
      <div aria-hidden="true" onClick={close} className="anim-fade absolute inset-0 bg-foreground/25 backdrop-blur-[2px]" />
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-labelledby={hasStrip && title != null ? titleId : undefined}
        aria-label={hasStrip && title != null ? undefined : label}
        aria-describedby={describedBy}
        tabIndex={-1}
        style={{ "--sheet-w": `${width}px` } as React.CSSProperties}
        className={cn(
          "relative flex min-h-0 flex-col border-line-strong bg-panel shadow-2xl outline-none",
          "max-sm:anim-sheet max-sm:max-h-[88dvh] max-sm:w-full max-sm:rounded-t-lg max-sm:border-t",
          side === "center"
            ? "sm:anim-pop sm:max-h-[85dvh] sm:w-full sm:max-w-[var(--sheet-w)] sm:rounded-lg sm:border"
            : "sm:anim-drawer sm:h-dvh sm:w-[min(100vw-3rem,var(--sheet-w))] sm:border-l",
          className
        )}
      >
        <div {...grip} data-sheet-grip="" className="flex shrink-0 touch-none justify-center pb-1 pt-2 sm:hidden">
          <span aria-hidden="true" className="h-1 w-9 rounded-full bg-line-strong" />
        </div>
        {hasStrip && (
          <div {...grip} className="flex shrink-0 items-center gap-2.5 border-b border-border px-5 pb-3 pt-1 max-sm:touch-none sm:py-3">
            <div className="flex min-w-0 flex-1 items-baseline gap-2.5">
              {/* Rulehead TEXT only — the strip's hairline replaces the ink rule. */}
              {title != null && (
                <span id={titleId} className="rulehead border-b-0! pb-0">
                  {title}
                </span>
              )}
              {meta != null && <span className="eyebrow min-w-0 truncate text-muted-foreground">{meta}</span>}
            </div>
            <IconButton label="Close" keys="Esc" onClick={close} className="shrink-0">
              <X size={14} strokeWidth={1.75} />
            </IconButton>
          </div>
        )}
        {header != null && (
          <div {...grip} className="shrink-0 max-sm:touch-none">
            {header}
          </div>
        )}
        <div
          className={cn(
            "min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4",
            // The bottom-most surface pads additively for the home indicator.
            footer == null && "pb-[calc(16px+env(safe-area-inset-bottom))]",
            contentClassName
          )}
        >
          {children}
        </div>
        {footer != null && (
          <div className="shrink-0 border-t border-border px-5 pb-[calc(14px+env(safe-area-inset-bottom))] pt-3.5">{footer}</div>
        )}
      </div>
    </div>,
    document.body
  );
}
