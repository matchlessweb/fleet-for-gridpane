/**
 * Checks that a request really came through Cloudflare Access.
 *
 * Access puts a signed token on every request it lets through, in the
 * `Cf-Access-Jwt-Assertion` header. Anyone can send a header with that name, so
 * the token only counts once its signature checks out against the team's
 * published keys AND it was issued for this application (the "aud" tag).
 *
 * Nothing here trusts the token's own claims about which key or algorithm to
 * use: the algorithm is fixed to RS256 and the key must be one the team
 * publishes at https://<team domain>/cdn-cgi/access/certs.
 *
 * Works on Workers and in Node (WebCrypto only).
 */

export type AccessJwtResult =
  | { ok: true; email: string; sub: string; expiresAt: number }
  | { ok: false; reason: AccessJwtFailure };

export type AccessJwtFailure =
  | "not-configured"
  | "missing"
  | "malformed"
  | "wrong-algorithm"
  | "unknown-key"
  | "keys-unavailable"
  | "bad-signature"
  | "wrong-issuer"
  | "wrong-audience"
  | "expired"
  | "not-yet-valid"
  | "not-a-person";

type Jwk = { kid?: string; kty?: string; n?: string; e?: string; alg?: string };
export type KeyFetcher = (certsUrl: string) => Promise<Jwk[]>;

export type AccessJwtOptions = {
  /** e.g. "example.cloudflareaccess.com". "https://" in front and a "/" at the end are taken off; a path is refused. */
  teamDomain: string | undefined;
  /** The Access application's audience tag. */
  audience: string | undefined;
  /** Seconds since the epoch; defaults to now. */
  now?: number;
  /** Replaced in tests. */
  fetchKeys?: KeyFetcher;
};

/** Clocks differ a little between Cloudflare and the Worker. */
const LEEWAY_SECONDS = 60;
/** How long fetched keys are used before Cloudflare is asked again. */
const KEY_CACHE_SECONDS = 600;
/** When asking again fails, the keys already held go on being used for this long, counted from when they were fetched. */
const KEY_STALE_SECONDS = 24 * 3600;
/**
 * After a fetch that failed, Cloudflare is not asked again for this long, as long as there are keys to go on with.
 * With no keys to go on with, it is asked again, but for this long at most one fetch is started a second.
 */
const KEY_RETRY_SECONDS = 10;
/** A token naming a key not held may send the app back to Cloudflare at most once in this long. Anyone can send such a token. */
const KEY_LOOK_AGAIN_SECONDS = 60;
/** The fetch gives up after this long: a slow answer must not hold every page. */
const KEY_FETCH_TIMEOUT_MS = 3000;
/** How long a fetch is taken to be still on its way if it never ends: a little longer than its timeout. */
const KEY_ASKING_SECONDS = 5;

type KeyEntry = { keys: Jwk[] | null; at: number; lookedAgainAt: number; failedAt: number; askedAt: number; asking: object | null; startedAt: number };
const keyCache = new Map<string, KeyEntry>();

const defaultFetchKeys: KeyFetcher = async (certsUrl) => {
  const res = await fetch(certsUrl, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(KEY_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`certs answered ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  return Array.isArray(body.keys) ? body.keys : [];
};

/**
 * The team address as the checks use it: lowercase, with "https://" in front and
 * any "/" at the end taken off, since that is how the dashboard shows it and how
 * people paste it. null when what is left is not a bare host name (a path, a
 * port, "http://", spaces), and for an empty value.
 */
export function normalizeTeamDomain(raw: string | null | undefined): string | null {
  const name = (raw ?? "").trim().toLowerCase().replace(/^https:\/\//, "").replace(/\/+$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name) ? name : null;
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
    const out = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function decodeJson(part: string): Record<string, unknown> | null {
  const bytes = b64urlToBytes(part);
  if (!bytes) return null;
  try {
    const v = JSON.parse(new TextDecoder().decode(bytes));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The keys to check with (null: none), and whether Cloudflare was asked for them just now and answered. */
type KeysAnswer = { keys: Jwk[] | null; answered: boolean };

/**
 * The team's published keys. `lookAgain` is the second look for a token that
 * names a key not among those held (Cloudflare rotates its keys).
 *
 * Cloudflare is asked only when the keys held are older than ten minutes, or on
 * a second look, and then only so often: with keys held, a failed fetch is not
 * repeated for KEY_RETRY_SECONDS, and second looks are KEY_LOOK_AGAIN_SECONDS
 * apart, because a signed-out caller can send a token naming any key. When
 * Cloudflare is not asked, or does not answer, the keys already held are used
 * for up to a day from when they were fetched: a short failure at Cloudflare
 * must not take the app down. While one request is asking, the others use the
 * keys held and do not ask as well.
 *
 * With no keys held at all (a Worker that has just started, or keys more than a
 * day old), a request does not wait on another request's fetch (that is not
 * safe on Workers), and while no fetch has failed lately every request asks: on
 * a healthy start, requests that arrive together are all let through. Once a
 * fetch has failed, and for KEY_RETRY_SECONDS after it, at most one fetch is
 * started in any one second (`now` is whole seconds); the other requests of
 * that second are refused without asking. The limit begins only when the first
 * failure is seen. Until then each request has started its own fetch, so a
 * Cloudflare that takes three seconds to fail is sent about three seconds'
 * worth of requests first, and about one a second after that. The first fetch
 * that is answered ends the limit.
 *
 * `answered` is true only when this call asked Cloudflare and got keys back.
 * The caller needs it to tell "Cloudflare does not publish that key" from "the
 * keys held do not have it, and Cloudflare was not asked or did not answer".
 */
async function keysFor(teamDomain: string, fetchKeys: KeyFetcher, now: number, lookAgain: boolean): Promise<KeysAnswer> {
  const entry: KeyEntry = keyCache.get(teamDomain) ?? { keys: null, at: 0, lookedAgainAt: -Infinity, failedAt: -Infinity, askedAt: -Infinity, asking: null, startedAt: -Infinity };
  if (!lookAgain && entry.keys && now - entry.at < KEY_CACHE_SECONDS) return { keys: entry.keys, answered: false };
  const held = entry.keys && now - entry.at < KEY_STALE_SECONDS ? entry.keys : null;
  // A second look is only ever made with keys held (see verifyAccessJwt), so this cannot refuse a Worker that holds none.
  if (lookAgain && now - entry.lookedAgainAt < KEY_LOOK_AGAIN_SECONDS) return { keys: held, answered: false };
  if (held && now - entry.failedAt < KEY_RETRY_SECONDS) return { keys: held, answered: false };
  // With none held and a failure in the last ten seconds, one fetch is started a second. `startedAt` is the second
  // the last fetch began in, and nothing resets it, so the limit holds however slowly the fetches fail.
  if (!held && now - entry.failedAt < KEY_RETRY_SECONDS && entry.startedAt === now) return { keys: null, answered: false };
  if (held && now - entry.askedAt < KEY_ASKING_SECONDS) return { keys: held, answered: false };
  keyCache.set(teamDomain, entry);
  // This call's own mark: when its fetch ends, it must not wipe the mark of a later one that is still on its way.
  const mark = {};
  entry.asking = mark;
  entry.askedAt = now;
  entry.startedAt = now;
  const lookedAgainBefore = entry.lookedAgainAt;
  if (lookAgain) entry.lookedAgainAt = now;
  const keysBefore = entry.keys, fetchedBefore = entry.at;
  try {
    const keys = await fetchKeys(`https://${teamDomain}/cdn-cgi/access/certs`);
    // An answer with no keys in it is no answer: it must not replace keys that work.
    if (!Array.isArray(keys) || keys.length === 0) throw new Error("no keys in the answer");
    // A slow fetch can land after one that began later. Its answer is then the older of
    // the two: the newer keys stay, and this request is checked with them.
    const newer = now < entry.at ? entry.keys : null;
    if (!newer) {
      entry.keys = keys;
      entry.at = now;
    }
    // Cloudflare is answering: a failure from before is no reason to hold back the next fetch.
    entry.failedAt = -Infinity;
    return { keys: newer ?? keys, answered: true };
  } catch {
    // A second look that got no answer has not been had: the next one waits for the retry time, not the full minute.
    if (lookAgain) entry.lookedAgainAt = lookedAgainBefore;
    // Another request may have been answered while this one waited. Its keys are then the
    // ones to use, and no failure is recorded for the next request to wait out.
    if (entry.keys && (entry.keys !== keysBefore || entry.at !== fetchedBefore)) return { keys: entry.keys, answered: false };
    entry.failedAt = now;
    return { keys: held, answered: false };
  } finally {
    // This fetch has ended, one way or the other. A later one that started meanwhile is still on its way.
    if (entry.asking === mark) entry.askedAt = -Infinity;
  }
}

/** For tests: forget fetched keys. */
export function clearAccessKeyCache() {
  keyCache.clear();
}

export async function verifyAccessJwt(token: string | null | undefined, opts: AccessJwtOptions): Promise<AccessJwtResult> {
  const teamDomain = normalizeTeamDomain(opts.teamDomain);
  const audience = (opts.audience ?? "").trim();
  // An unset setting must never read as "no check needed".
  if (!teamDomain || !audience) return { ok: false, reason: "not-configured" };
  if (!token) return { ok: false, reason: "missing" };

  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !p)) return { ok: false, reason: "malformed" };
  const header = decodeJson(parts[0]);
  const claims = decodeJson(parts[1]);
  const signature = b64urlToBytes(parts[2]);
  if (!header || !claims || !signature) return { ok: false, reason: "malformed" };

  if (header.alg !== "RS256") return { ok: false, reason: "wrong-algorithm" };
  const kid = typeof header.kid === "string" ? header.kid : "";
  if (!kid) return { ok: false, reason: "unknown-key" };

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const fetchKeys = opts.fetchKeys ?? defaultFetchKeys;
  const first = await keysFor(teamDomain, fetchKeys, now, false);
  let keys = first.keys;
  if (!keys) return { ok: false, reason: "keys-unavailable" };
  let jwk = keys.find((k) => k.kid === kid);
  // Keys fetched in this very call are Cloudflare's answer already: a key that is not
  // among them is one it does not publish, and asking again would only double the wait.
  if (!jwk && !first.answered) {
    // Cloudflare rotates its keys: look once more before saying no.
    const again = await keysFor(teamDomain, fetchKeys, now, true);
    keys = again.keys ?? keys;
    jwk = keys.find((k) => k.kid === kid);
    // "Cloudflare does not publish that key" is only known when Cloudflare was asked
    // just now and answered. When the look was not made (one was made in the last
    // minute, perhaps for a stranger's forged token) or got no answer, the honest
    // reply is "could not check, try again": the key may be one Cloudflare has just
    // started signing with. Either way the request is refused.
    if (!jwk && !again.answered) return { ok: false, reason: "keys-unavailable" };
  }
  if (!jwk || jwk.kty !== "RSA" || !jwk.n || !jwk.e) return { ok: false, reason: "unknown-key" };

  let valid = false;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "bad-signature" };

  // Only now are the claims worth reading.
  if (claims.iss !== `https://${teamDomain}`) return { ok: false, reason: "wrong-issuer" };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(audience)) return { ok: false, reason: "wrong-audience" };
  const exp = typeof claims.exp === "number" ? claims.exp : 0;
  if (exp + LEEWAY_SECONDS <= now) return { ok: false, reason: "expired" };
  const nbf = typeof claims.nbf === "number" ? claims.nbf : typeof claims.iat === "number" ? claims.iat : 0;
  if (nbf - LEEWAY_SECONDS > now) return { ok: false, reason: "not-yet-valid" };
  // A service token carries no email. Signing in to a site is for people.
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  const sub = typeof claims.sub === "string" ? claims.sub : "";
  if (!email || !sub) return { ok: false, reason: "not-a-person" };

  return { ok: true, email, sub, expiresAt: exp };
}
