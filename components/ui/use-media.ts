"use client";

import { useSyncExternalStore } from "react";

const PHONE = "(max-width: 639.98px)";

function subscribe(onChange: () => void) {
  const mq = window.matchMedia(PHONE);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/**
 * True below `sm` (640px): where a panel becomes a bottom sheet. False on the
 * server, so use it only for things that render after a click, never for
 * anything in the first paint.
 */
export function useIsPhone(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(PHONE).matches, () => false);
}
