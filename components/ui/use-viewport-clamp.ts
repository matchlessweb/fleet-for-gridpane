"use client";

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

/** Breathing room kept between a floating panel and the viewport edge. */
const GUTTER = 12;

/**
 * useViewportClamp — keeps an absolutely-positioned floating panel (info
 * popovers, small anchored dropdowns) fully inside the viewport.
 *
 * Anchored panels are positioned relative to their trigger, so a fixed-width
 * panel spills off-screen whenever the trigger sits near an edge — invisible on
 * desktop, guaranteed on phones. This measures the panel when it opens and
 * corrects it horizontally.
 *
 * Returns a ref to put on the panel. The correction is written straight to
 * `style.transform` rather than held in state: the element must be measured at
 * its natural position, and a state round-trip would paint the stale shift
 * first. It writes `transform` only — Tailwind v4's `-translate-x-1/2` drives
 * the separate `translate` property, so centred panels stay centred.
 *
 * A panel that already fits gets no transform, leaving desktop untouched.
 * Sheet-style overlays (notifications, search) don't need this — they switch to
 * `fixed inset-x-4` on phones instead.
 */
export function useViewportClamp<T extends HTMLElement = HTMLDivElement>(
  open: boolean
) {
  const ref = useRef<T>(null);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;

    // Drop any previous correction so the read is the natural position and
    // repeated measurements can't compound.
    el.style.transform = "";
    const rect = el.getBoundingClientRect();

    const overflowRight = rect.right - (window.innerWidth - GUTTER);
    const overflowLeft = GUTTER - rect.left;

    // Right edge first, then left — on a viewport narrower than the panel the
    // left correction wins, so the copy always starts on-screen.
    let shift = 0;
    if (overflowRight > 0) shift = -overflowRight;
    if (overflowLeft > 0) shift = overflowLeft;

    el.style.transform = shift ? `translateX(${Math.round(shift)}px)` : "";
  }, []);

  // Layout effect: correct before the browser paints, so the panel never
  // flashes at the overflowing position.
  useLayoutEffect(() => {
    if (open) measure();
  }, [open, measure]);

  useEffect(() => {
    if (!open) return;
    // Rotation and browser-chrome collapse both resize the viewport under an
    // open panel; visualViewport also fires as the iOS URL bar retracts.
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, [open, measure]);

  return ref;
}
