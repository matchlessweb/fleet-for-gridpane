"use client";

import * as React from "react";
import { claimOverlay, releaseOverlay } from "./overlay-bus";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/* How many open overlays want each element out of reach. Counted, because one
   overlay can open over another and the first to close must not hand the page
   back while the second is still up. */
const held = new Map<HTMLElement, number>();

function hold(host: HTMLElement): HTMLElement[] {
  const mine: HTMLElement[] = [];
  for (const el of Array.from(document.body.children) as HTMLElement[]) {
    if (el === host || el.contains(host)) continue;
    if (el.tagName === "SCRIPT" || el.tagName === "NEXT-ROUTE-ANNOUNCER") continue;
    // Toasts stay live: a modal often is what raises one.
    if (el.matches("[aria-live], [data-sonner-toaster]") || el.querySelector("[data-sonner-toaster]")) continue;
    held.set(el, (held.get(el) ?? 0) + 1);
    el.inert = true;
    mine.push(el);
  }
  return mine;
}

/* The page's scroll lock, counted for the same reason: two overlays that close
   in one commit clean up in tree order, not in the order they opened, and a
   saved-and-restored value would leave the page locked. */
let locks = 0;
let overflowBefore = "";
function lock() {
  if (locks++ === 0) {
    overflowBefore = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
  }
}
function unlock() {
  if (--locks === 0) document.documentElement.style.overflow = overflowBefore;
}

function release(mine: HTMLElement[]) {
  for (const el of mine) {
    const n = (held.get(el) ?? 1) - 1;
    if (n > 0) held.set(el, n);
    else {
      held.delete(el);
      el.inert = false;
    }
  }
}

/** The first element marked `data-autofocus` that is showing. A menu marks one row per breakpoint. */
export function autofocusTarget(root: HTMLElement | null | undefined): HTMLElement | null {
  if (!root) return null;
  return Array.from(root.querySelectorAll<HTMLElement>("[data-autofocus]")).find((el) => el.getClientRects().length > 0) ?? null;
}

/**
 * useOverlay — what every modal surface shares. While `open`: it is the one
 * overlay (overlay-bus), Escape closes it, the rest of the page cannot be
 * focused, clicked or read aloud, Tab stays inside, and focus goes back to
 * where it came from on close.
 *
 * `hostRef` is the overlay's outermost element, a direct child of `<body>`.
 * Focus lands on the first showing element marked `data-autofocus`, or on the dialog itself.
 *
 * `stack` is for a question asked on top of another overlay (a confirm over a
 * form): it does not close what is under it. The one underneath goes inert
 * with the rest of the page and ignores keys until the question is answered.
 */
export function useOverlay(
  open: boolean,
  onClose: () => void,
  hostRef: React.RefObject<HTMLElement | null>,
  { stack = false }: { stack?: boolean } = {}
): () => void {
  const onCloseRef = React.useRef(onClose);
  React.useEffect(() => {
    onCloseRef.current = onClose;
  });
  const close = React.useCallback(() => onCloseRef.current(), []);

  React.useEffect(() => {
    if (!open) return;
    const host = hostRef.current;
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    if (!stack) claimOverlay(close);
    const mine = host ? hold(host) : [];

    const dialog = host?.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]') ?? host;
    (autofocusTarget(host) ?? dialog)?.focus({ preventScroll: true });

    const onKeyDown = (e: KeyboardEvent) => {
      if (host?.closest("[inert]")) return; // a question is open on top of this one
      if (e.key === "Escape") {
        e.stopImmediatePropagation(); // one Escape closes one layer
        close();
        return;
      }
      if (e.key !== "Tab" || !host) return;
      const items = Array.from(host.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.getClientRects().length > 0
      );
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === dialog || !host.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !host.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);

    lock();

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      unlock();
      release(mine);
      if (!stack) releaseOverlay(close);
      if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
    };
  }, [open, close, hostRef, stack]);

  return close;
}
