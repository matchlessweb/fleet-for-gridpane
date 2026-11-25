import { useCallback, useMemo, useSyncExternalStore } from "react";
import { readStored, watchStored, writeStored } from "@/lib/stored-value";

function fromText<T>(text: string | null, fallback: T, parse: (text: string) => T | undefined): T {
  if (text === null) return fallback;
  try {
    return parse(text) ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * State that is kept in the browser's localStorage, such as a view the person chose.
 * The server and the first paint show `fallback`; the saved value follows in the browser.
 *
 * `parse` returns undefined for text it does not accept. `format` returns null to
 * remove the key. Pass `fallback`, `parse` and `format` as values that do not
 * change between renders (constants outside the component).
 */
export function useStoredState<T>(
  key: string,
  fallback: T,
  parse: (text: string) => T | undefined,
  format: (value: T) => string | null,
): [T, (next: T | ((previous: T) => T)) => void] {
  const subscribe = useCallback((listener: () => void) => watchStored(key, listener), [key]);
  const text = useSyncExternalStore(subscribe, () => readStored(key), () => null);
  const value = useMemo(() => fromText(text, fallback, parse), [text, fallback, parse]);
  const set = useCallback(
    (next: T | ((previous: T) => T)) => {
      const previous = fromText(readStored(key), fallback, parse);
      writeStored(key, format(typeof next === "function" ? (next as (previous: T) => T)(previous) : next));
    },
    [key, fallback, parse, format],
  );
  return [value, set];
}
