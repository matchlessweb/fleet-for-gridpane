"use client";

import { useSyncExternalStore } from "react";

const emptySubscribe = () => () => {};
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

/**
 * True after hydration. SSR-safe replacement for the
 * `useEffect(() => setMounted(true), [])` idiom, without calling
 * setState synchronously inside an effect.
 */
export function useMounted(): boolean {
  return useSyncExternalStore(emptySubscribe, getClientSnapshot, getServerSnapshot);
}
