/**
 * A site's caching as GridPane reports it, and the one change at a time Fleet may ask
 * GridPane to make. Shared by the caching route, both syncs and the site page; it has
 * no imports, so plain Node can load it (scripts/sync-gridpane.ts does).
 *
 * What GridPane's API accepts was found by trying it on a dev site, not
 * taken from its documentation alone (docs/gridpane-api-caching.md):
 *  - Every change is a PUT to /site/{id} with ONE setting, sent as a real JSON value:
 *    `true`, not "true", and 60, not "60". A quoted value is refused with a 429, the same
 *    answer as being too fast, so it looks like a rate limit when it is not.
 *  - A page cache cannot change straight from Redis to FastCGI or back. GridPane answers
 *    409 "Unable to enable redis, please disable fastcgi first."
 *  - The time to live can only be set while a page cache is on (409 otherwise). GridPane
 *    keeps the last value while caching is off, so the stored number is not proof of a cache.
 *  - Object Cache Pro and Relay have no API at all: shown, never changed, here.
 */

export type PageCache = "redis" | "fastcgi";

export type CachingState = {
  /** The page cache that is on, or null when none is. */
  page: PageCache | null;
  /** Seconds. GridPane keeps the last value even while no page cache is on. */
  ttl: number | null;
  objectCache: boolean | null;
  objectCachePro: boolean | null;
};

export type CachingAction =
  | { kind: "page"; to: PageCache | "off" }
  | { kind: "ttl"; seconds: number }
  | { kind: "objectCache"; on: boolean }
  | { kind: "clear"; what: "page" | "object" | "all" };

/** What POST /api/sites/{id}/caching answers. */
export type CachingRouteAnswer = {
  state?: CachingState;
  /** true: GridPane's record shows the change. false: accepted, not shown yet. null: a clear, which cannot be read back. */
  confirmed?: boolean | null;
  message?: string;
  error?: string;
};

/** One year. GridPane names no ceiling; this one stops a typo of extra zeros. */
export const TTL_MAX = 31_536_000;

export const PAGE_CACHE_LABEL: Record<PageCache, string> = { redis: "Redis", fastcgi: "FastCGI" };

/** What GridPane's own guides give as each page cache's starting time to live, in seconds. */
export const GRIDPANE_DEFAULT_TTL: Record<PageCache, number> = { redis: 2_592_000, fastcgi: 1 };

const isPageCache = (v: unknown): v is PageCache => v === "redis" || v === "fastcgi";
const asBool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const asInt = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
};

/**
 * The caching settings in one site's GridPane record (GET /site/{id}). The object cache
 * is read from site_customizer: the record's top-level object_caching was null on a site
 * whose customizer said false, and stayed null after the API turned it on.
 */
export function cachingFromRecord(gp: Record<string, unknown>): CachingState {
  const custom = (gp.site_customizer ?? null) as Record<string, unknown> | null;
  return {
    page: isPageCache(gp.nginx_caching) ? gp.nginx_caching : null,
    ttl: asInt(custom?.nginx_caching_ttl),
    objectCache: asBool(custom?.object_caching),
    objectCachePro: asBool(gp.object_cache_pro),
  };
}

/** The sites columns for a state. nginx_caching stays null when no page cache is on, as before. */
export function cachingColumns(s: CachingState) {
  return {
    nginx_caching: s.page,
    nginx_caching_ttl: s.ttl,
    object_caching: s.objectCache,
    object_cache_pro: s.objectCachePro,
  };
}

/** The caching state Fleet holds for a site row (null where the sync has not filled it). */
export function cachingFromRow(row: {
  nginx_caching?: string | null;
  nginx_caching_ttl?: number | null;
  object_caching?: boolean | null;
  object_cache_pro?: boolean | null;
}): CachingState {
  return {
    page: isPageCache(row.nginx_caching) ? row.nginx_caching : null,
    ttl: row.nginx_caching_ttl ?? null,
    objectCache: row.object_caching ?? null,
    objectCachePro: row.object_cache_pro ?? null,
  };
}

/** Reads a request body into one action, or says what is wrong with it. */
export function parseAction(body: unknown): CachingAction | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Send one caching change as a JSON object." };
  const b = body as Record<string, unknown>;
  const keys = Object.keys(b).filter((k) => b[k] !== undefined);
  if (keys.length !== 1) return { error: "Send exactly one of page, ttl, objectCache or clear: GridPane takes one caching change at a time." };
  const [key] = keys;
  const v = b[key];
  if (key === "page") return v === "off" || isPageCache(v) ? { kind: "page", to: v } : { error: 'page must be "redis", "fastcgi" or "off".' };
  if (key === "ttl") return typeof v === "number" && Number.isInteger(v) ? { kind: "ttl", seconds: v } : { error: "ttl must be a whole number of seconds." };
  if (key === "objectCache") return typeof v === "boolean" ? { kind: "objectCache", on: v } : { error: "objectCache must be true or false." };
  if (key === "clear") return v === "page" || v === "object" || v === "all" ? { kind: "clear", what: v } : { error: 'clear must be "page", "object" or "all".' };
  return { error: `Unknown caching setting: ${key}.` };
}

/**
 * Whether GridPane would take this change from this state, and the body to send it with.
 * The refusals are GridPane's own rules, checked here first so the answer is plain words
 * rather than a 409 or a 429 from GridPane.
 */
export function planChange(
  state: CachingState,
  action: CachingAction,
): { body: Record<string, string | number | boolean> } | { error: string; status: number } {
  switch (action.kind) {
    case "page": {
      if (action.to === "off") {
        if (state.page === null) return { error: "Page caching is already off.", status: 409 };
        return { body: { nginx_caching: "none" } };
      }
      if (state.page === action.to) return { error: `${PAGE_CACHE_LABEL[action.to]} page caching is already on.`, status: 409 };
      if (state.page !== null) {
        return {
          error: `${PAGE_CACHE_LABEL[state.page]} page caching is on. GridPane cannot switch straight to ${PAGE_CACHE_LABEL[action.to]}: turn page caching off first, wait a few minutes, then turn ${PAGE_CACHE_LABEL[action.to]} on.`,
          status: 409,
        };
      }
      return { body: { nginx_caching: action.to } };
    }
    case "ttl": {
      if (!Number.isInteger(action.seconds) || action.seconds < 1 || action.seconds > TTL_MAX) {
        return { error: `The time to live must be a whole number of seconds from 1 to ${TTL_MAX} (one year).`, status: 400 };
      }
      if (state.page === null) return { error: "Turn a page cache on first: GridPane sets the time to live only while one is on.", status: 409 };
      if (state.ttl === action.seconds) return { error: `The time to live is already ${formatTtl(action.seconds)}.`, status: 409 };
      return { body: { nginx_caching_ttl: action.seconds } };
    }
    case "objectCache": {
      if (state.objectCache === action.on) return { error: `The Redis object cache is already ${action.on ? "on" : "off"}.`, status: 409 };
      return { body: { object_caching: action.on } };
    }
    case "clear":
      return { body: { clear_cache: action.what } };
  }
}

/**
 * Whether GridPane's record, read back after a change, shows it. A cache clear leaves
 * nothing in the record to read, so it is never confirmed this way.
 */
export function changeShows(after: CachingState, action: CachingAction): boolean | null {
  switch (action.kind) {
    case "page": return after.page === (action.to === "off" ? null : action.to);
    case "ttl": return after.ttl === action.seconds;
    case "objectCache": return after.objectCache === action.on;
    case "clear": return null;
  }
}

/** A short description of the change, for the log and the page. */
export function describeAction(action: CachingAction): string {
  switch (action.kind) {
    case "page": return action.to === "off" ? "page caching off" : `${PAGE_CACHE_LABEL[action.to]} page caching on`;
    case "ttl": return `page cache time to live ${formatTtl(action.seconds)} (${action.seconds} s)`;
    case "objectCache": return `Redis object cache ${action.on ? "on" : "off"}`;
    case "clear": return action.what === "all" ? "all caches cleared" : `${action.what} cache cleared`;
  }
}

/** 2592000 -> "30 days", 3600 -> "1 hour", 90 -> "90 seconds". Exact: never rounds. */
export function formatTtl(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "not reported";
  const units: [number, string][] = [[86_400, "day"], [3_600, "hour"], [60, "minute"]];
  for (const [size, name] of units) {
    if (seconds >= size && seconds % size === 0) {
      const n = seconds / size;
      return `${n} ${name}${n === 1 ? "" : "s"}`;
    }
  }
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}
