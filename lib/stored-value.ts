/**
 * One text value per key in the browser's localStorage, with listeners, so a
 * component can read it the way React reads any outside store. No React here:
 * scripts/test-stored-value.ts runs it with a stand-in for the browser.
 *
 * A page reads storage once per key and then holds the value itself, for as long
 * as something on the page is reading that key. So a choice made in another tab
 * does not change this one while it is open; this one picks it up when it next
 * loads the page that reads it. A value storage would not take (full, or refused)
 * is held the same way, so the control still works.
 */
type Listener = () => void;

const listeners = new Map<string, Set<Listener>>();
/** What this page holds for each key it is reading. */
const held = new Map<string, string | null>();

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function fromStorage(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** The text this page holds for the key: what was saved when it first looked, or what it has written since. */
export function readStored(key: string): string | null {
  if (held.has(key)) return held.get(key) ?? null;
  // Outside a browser there is no page to hold anything for.
  if (typeof window === "undefined") return null;
  const text = fromStorage(key);
  held.set(key, text);
  return text;
}

/** Save the text, or remove the key when it is null, and tell everyone on this page reading that key. */
export function writeStored(key: string, text: string | null): void {
  held.set(key, text);
  try {
    const s = storage();
    if (s && text === null) s.removeItem(key);
    else if (s) s.setItem(key, text as string);
  } catch {
    // Not saved; this page keeps the value it holds.
  }
  listeners.get(key)?.forEach((listener) => listener());
}

/** Call `listener` after each write to `key` from this page. Returns the function that stops it. */
export function watchStored(key: string, listener: Listener): () => void {
  let set = listeners.get(key);
  if (!set) {
    listeners.set(key, (set = new Set()));
    // The first reader on the page starts from what is saved now.
    held.set(key, fromStorage(key));
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) {
      listeners.delete(key);
      // Nobody is reading: the next reader looks at storage again.
      held.delete(key);
    }
  };
}
