/**
 * What Fleet's server code does for one-click sign-in, as plain functions.
 *
 * The API routes under app/api/sso are thin: they run the gate (lib/sso/gate.ts)
 * and hand over to these. Keeping the logic here means the end-to-end test
 * (scripts/test-sso-end-to-end.ts) runs the very same code against the real
 * database functions and the real server service.
 *
 * Every function takes `rpc`: a call to one of the functions in sso_schema.sql
 * with the dashboard's server key. Nothing here is reachable from a browser.
 */
import { isHostname, isUuid, signRequest, SsoKeyError, unsealLink } from "./crypto.ts";

export type Rpc = (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
export type SsoKeys = { SSO_SIGN_PRIVATE_KEY?: string; SSO_BOX_PRIVATE_KEY?: string };
/** The person asking, as the gate established them. */
export type SsoWho = { userId: string; userEmail: string; accessEmail: string; ip: string | null };
export type SsoReply = { status: number; body: Record<string, unknown> };

/** How long a request waits for its server, in seconds. */
export const REQUEST_LIFE_SECONDS = 60;

const reply = (status: number, body: Record<string, unknown>): SsoReply => ({ status, body });
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const serverIdOf = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^[1-9][0-9]{0,11}$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
const DB_DOWN = reply(503, { state: "refused", reason: "database", message: "Fleet could not reach its database. Try again in a moment." });

const REFUSALS: Record<string, [number, string]> = {
  "switched-off": [409, "One-click sign-in is switched off in Fleet."],
  "site-not-enabled": [409, "One-click sign-in is not turned on for this site."],
  "too-many-5m": [429, "That is 10 sign-ins in five minutes. Wait a few minutes and try again."],
  "too-many-day": [429, "That is 60 sign-ins today, which is the daily limit."],
  "bad-request": [400, "That is not a site Fleet can sign in to."],
};

/** Ask a server for a sign-in. Returns the request id to collect it with. */
export async function requestSignIn(
  rpc: Rpc,
  keys: SsoKeys,
  who: SsoWho,
  input: { serverId: unknown; hostname: unknown },
  opts: { now?: number; newId?: () => string } = {}
): Promise<SsoReply> {
  const sid = serverIdOf(input.serverId);
  if (sid === null || !isHostname(input.hostname)) return reply(400, { state: "refused", reason: "bad-request", message: REFUSALS["bad-request"][1] });
  const host = input.hostname;
  const id = (opts.newId ?? (() => crypto.randomUUID()))();
  const now = opts.now ?? Math.floor(Date.now() / 1000);

  let signed: string;
  try {
    signed = await signRequest({ v: 1, id, sid, host, iat: now, exp: now + REQUEST_LIFE_SECONDS }, keys.SSO_SIGN_PRIVATE_KEY);
  } catch (e) {
    if (e instanceof SsoKeyError) return reply(503, { state: "refused", reason: "not-configured", message: "One-click sign-in is not set up: Fleet's signing key is missing." });
    throw e;
  }

  const made = await rpc("sso_request_create", {
    p_id: id,
    p_user: who.userId,
    p_server_id: sid,
    p_hostname: host,
    p_signed_request: signed,
    p_user_email: who.userEmail || null,
    p_access_email: who.accessEmail || null,
    p_ip: who.ip,
    p_ttl_seconds: REQUEST_LIFE_SECONDS,
  });
  if (made.error) return DB_DOWN;
  const r = obj(made.data);
  if (r.ok !== true) {
    const [status, message] = REFUSALS[String(r.reason)] ?? [409, "Fleet refused the sign-in."];
    return reply(status, { state: "refused", reason: String(r.reason ?? "refused"), message });
  }
  // Have the server services poll quickly while this person is signing in. Best effort.
  await Promise.resolve(rpc("sso_arm")).catch(() => null);
  return reply(200, { state: "waiting", id, lifeSeconds: REQUEST_LIFE_SECONDS });
}

/**
 * Collect a request's result for the person who asked. When the server has
 * answered, this opens the sealed link, checks it, and returns it: once.
 */
export async function collectSignIn(rpc: Rpc, keys: SsoKeys, who: SsoWho, id: unknown): Promise<SsoReply> {
  if (!isUuid(id)) return reply(404, { state: "unknown", message: "Fleet has no such sign-in request." });
  const took = await rpc("sso_request_take", { p_request_id: id, p_user: who.userId });
  if (took.error) return DB_DOWN;
  const r = obj(took.data);
  switch (r.status) {
    case "pending":
      return reply(200, { state: "waiting", step: "asked" });
    case "claimed":
      return reply(200, { state: "waiting", step: "collected" });
    case "ready": {
      if (typeof r.sealed_link !== "string" || !isHostname(r.hostname)) return reply(502, { state: "failed", message: "The server's answer was incomplete." });
      let opened;
      try {
        opened = await unsealLink(r.sealed_link, keys.SSO_BOX_PRIVATE_KEY, { id, hostname: r.hostname });
      } catch (e) {
        if (e instanceof SsoKeyError) return reply(503, { state: "failed", reason: "not-configured", message: "One-click sign-in is not set up: Fleet's unsealing key is missing." });
        throw e;
      }
      // The reason says which check failed; the link itself is never put in a reply that failed.
      if (!opened.ok) return reply(502, { state: "failed", reason: opened.reason, message: "The server sent back something Fleet could not use, so nothing was opened." });
      return reply(200, { state: "ready", url: opened.url });
    }
    case "failed":
      return reply(200, { state: "failed", message: sentence(typeof r.error === "string" && r.error ? r.error : "the server could not create a sign-in link") });
    case "expired":
      return reply(200, {
        state: "expired",
        message: r.collected === true ? "The server started on the sign-in and did not finish in time." : "The server did not pick the request up in time. Its sign-in service may be stopped.",
      });
    case "consumed":
      return reply(200, { state: "used", message: "That sign-in link was already opened." });
    default:
      return reply(404, { state: "unknown", message: "Fleet has no such sign-in request." });
  }
}

/** "the site is frozen for a move" -> "The site is frozen for a move." */
function sentence(text: string): string {
  const t = text.trim().slice(0, 200);
  const s = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

/** Whether it is switched on, and which sites have opted in, as "serverId|hostname". */
export async function readSsoState(rpc: Rpc): Promise<{ enabled: boolean; sites: string[] } | null> {
  const got = await rpc("sso_state_read");
  if (got.error) return null;
  const r = obj(got.data);
  const sites = (Array.isArray(r.sites) ? r.sites : [])
    .map(obj)
    .filter((s) => serverIdOf(s.server_id) !== null && isHostname(s.hostname))
    .map((s) => siteKey(serverIdOf(s.server_id)!, s.hostname as string));
  return { enabled: r.enabled === true, sites };
}

export const siteKey = (serverId: number, hostname: string) => `${serverId}|${hostname}`;

/** Turn one-click sign-in on or off for one site on one server. */
export async function setSitePolicy(rpc: Rpc, who: SsoWho, input: { serverId: unknown; hostname: unknown; enabled: unknown }): Promise<SsoReply> {
  const sid = serverIdOf(input.serverId);
  if (sid === null || !isHostname(input.hostname) || typeof input.enabled !== "boolean") return reply(400, { ok: false, reason: "bad-request", message: "That is not a site Fleet knows." });
  const set = await rpc("sso_policy_set", {
    p_user: who.userId,
    p_user_email: who.userEmail || null,
    p_access_email: who.accessEmail || null,
    p_ip: who.ip,
    p_server_id: sid,
    p_hostname: input.hostname,
    p_enabled: input.enabled,
  });
  if (set.error) return reply(503, { ok: false, reason: "database", message: "Fleet could not reach its database. Try again in a moment." });
  const r = obj(set.data);
  if (r.ok !== true) return reply(r.reason === "unknown-site" ? 404 : 400, { ok: false, reason: String(r.reason ?? "refused"), message: r.reason === "unknown-site" ? "Fleet has no such site on that server." : "That is not a site Fleet knows." });
  return reply(200, { ok: true, enabled: r.enabled === true });
}

/** The master switch. Off turns every button back into a plain link. */
export async function setSsoSwitch(rpc: Rpc, who: SsoWho, enabled: unknown): Promise<SsoReply> {
  if (typeof enabled !== "boolean") return reply(400, { ok: false, reason: "bad-request", message: "Say on or off." });
  const set = await rpc("sso_switch_set", { p_user: who.userId, p_user_email: who.userEmail || null, p_access_email: who.accessEmail || null, p_ip: who.ip, p_enabled: enabled });
  if (set.error) return reply(503, { ok: false, reason: "database", message: "Fleet could not reach its database. Try again in a moment." });
  return reply(200, { ok: true, enabled: obj(set.data).enabled === true });
}

/**
 * An answer Fleet's own page is waiting for. A refusal the page is built to
 * show (confirm with your passkey, not turned on for this site, too many
 * sign-ins) is a normal answer, so it goes out as 200 with the reason in the
 * body: the browser does not log it as a failed request. Anything the page did
 * not ask for keeps its status: malformed, cross-site, signed out, not on the
 * list, a database that cannot be reached.
 */
export function forPage(r: SsoReply): SsoReply {
  const handled = r.body.stepUp === true || r.status === 409 || r.status === 429;
  return handled ? { status: 200, body: r.body } : r;
}
