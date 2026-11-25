"use client";

import { useCallback, useSyncExternalStore } from "react";

const listeners = new Map<string, Set<() => void>>();

function subscribe(key: string, onChange: () => void) {
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(onChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key === key) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    set.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

// Choices the browser refused to store (a private window, blocked site data). They hold until the page is left.
const unsaved = new Map<string, string>();

function read(key: string, initial: string) {
  const held = unsaved.get(key);
  if (held !== undefined) return held;
  try {
    return localStorage.getItem(key) ?? initial;
  } catch {
    return initial;
  }
}

/**
 * usePersistedState — a string that outlives the page in localStorage (a
 * saved filter, a sort). The saved value is in the very first frame the
 * browser paints, so a list never shows unfiltered and then filters itself.
 * The server render, which cannot see it, uses `initial`.
 */
export function usePersistedState(key: string, initial: string): [string, (value: string) => void] {
  const value = useSyncExternalStore(
    useCallback((onChange: () => void) => subscribe(key, onChange), [key]),
    () => read(key, initial),
    () => initial
  );
  const set = useCallback(
    (next: string) => {
      try {
        localStorage.setItem(key, next);
        unsaved.delete(key);
      } catch {
        // Private windows and blocked storage: the choice lasts until the page is left.
        unsaved.set(key, next);
      }
      listeners.get(key)?.forEach((fn) => fn());
    },
    [key]
  );
  return [value, set];
}
