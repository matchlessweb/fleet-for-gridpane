import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * tie — glue a sentence's last two words with a non-breaking space, so a line never ends as one
 * stranded word. `text-wrap: pretty` does this in Chromium and Safari 26; Firefox and older Safari
 * need the glue. A pair longer than `max` characters is left alone: glued, a pair wider than its
 * column is pushed off screen, which is worse than a stranded word.
 */
export function tie(text: string, max = 22): string {
  return text.replace(/(\S+) (\S+)\s*$/, (whole, a: string, b: string) => (a.length + b.length <= max ? `${a}\u00a0${b}` : whole));
}

/** `tie` for a slot that takes any node: a string is tied, anything else passes through. */
export function tied<T>(node: T, max?: number): T {
  return typeof node === "string" ? (tie(node, max) as T) : node;
}

/**
 * GridPane's own name for a server's provider.
 *
 * The sync stores the provider as `JSON.stringify(s.provider)`, so what comes back
 * out of Supabase is a *string*, not an object — the object branch below never
 * fired, and every node fell through to a hand-written ID map that had id 3 as
 * "Vultr" when GridPane actually uses it for "Custom". That mislabelled every
 * node. Parse the string and GridPane tells us the answer itself.
 *
 * Only IDs confirmed against the live API are mapped; a wrong guess is worse than
 * an honest "Provider 5". The map is a last resort anyway — the sync always
 * stores the provider payload.
 */
export function getProviderName(providerId: number | string | null | undefined, providerObj?: unknown): string {
  // What the sync stores: GridPane's provider object, that object as JSON text, or a bare name.
  let provider = providerObj as string | number | { full_name?: string; name?: string } | null | undefined;

  if (typeof provider === 'string') {
    try {
      provider = JSON.parse(provider);
    } catch {
      // Not JSON — treat a bare string as the name itself.
      const raw = (provider as string).trim();
      if (raw) return raw.charAt(0).toUpperCase() + raw.slice(1);
      provider = null;
    }
  }

  if (provider && typeof provider === 'object') {
    if (provider.full_name) return provider.full_name;
    if (provider.name) return provider.name.charAt(0).toUpperCase() + provider.name.slice(1);
  }

  // Verified against GridPane's API.
  const pmap: Record<string, string> = {
    "3": "Custom",
    "7": "PeakFreq",
  };

  if (!providerId && providerId !== 0) return "Unknown";
  return pmap[String(providerId)] || `Provider ${providerId}`;
}
