import { useSyncExternalStore } from "react";

const never = () => () => {};

/**
 * A value only the browser knows: its address, what it supports, that it is a browser at all.
 * The server and the first paint get `onServer`; the real value follows without an effect
 * setting state. `read` must return a plain value (a boolean, a string, a number).
 */
export function useClientValue<T extends boolean | string | number | null>(read: () => T, onServer: T): T {
  return useSyncExternalStore(never, read, () => onServer);
}
