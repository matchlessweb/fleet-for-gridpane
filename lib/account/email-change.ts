/**
 * Changing the sign-in email from the profile page.
 *
 * Three promises, each kept here and tested in scripts/test-email-change.ts:
 *
 *   1. Fleet starts a change only for someone who proved a strong factor (a
 *      passkey, or a password plus a code) in the last ten minutes.
 *   2. Starting a change changes nothing. The database mails a link to the new
 *      address, and the account keeps its old address until that link is
 *      confirmed.
 *   3. Opening the link changes nothing either. The page it opens has a button,
 *      and only pressing it confirms. A mail scanner or a link preview that
 *      fetches the address cannot use the link up.
 *
 * What this cannot do: the database (Supabase Auth) is reachable on its own,
 * so someone holding a stolen session could ask it for an email change without
 * coming through Fleet, and skip promise 1. The database setting "Secure email
 * change" covers that case: with it on, the old address has to confirm too.
 *
 * Pure apart from the two calls to the database, which take a fetch.
 */
import { verifyAccessJwt, type KeyFetcher } from "../sso/access-jwt.ts";
import { usesAccess } from "../access-gate.ts";
import { strongFactor, type AalInfo } from "../sso/gate.ts";
import { hasAuthenticator, type FactorInfo } from "../auth-assurance.ts";

/** Ask for the passkey again once the last strong sign-in is older than this. */
export const EMAIL_CHANGE_FACTOR_MAX_AGE_SECONDS = 10 * 60;

export type AccountReply = { status: number; body: Record<string, unknown> };

const refused = (status: number, reason: string, message: string, stepUp = false): AccountReply => ({
  status,
  body: { state: "refused", ok: false, reason, message, stepUp },
});

/** A usable address, trimmed and lowercased, or null. Deliberately strict: one @, a dotted domain, no spaces. */
export function cleanEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length < 6 || email.length > 254) return null;
  const at = email.lastIndexOf("@");
  if (at < 1 || email.indexOf("@") !== at) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || !/^[a-z0-9!#$%&*+/=?^_`{|}~.\x27-]+$/.test(local)) return null;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  const labels = domain.split(".");
  if (labels.length < 2) return null;
  if (!labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return null;
  if (!/^[a-z]{2,}$/.test(labels[labels.length - 1]) && !/^xn--/.test(labels[labels.length - 1])) return null;
  return email;
}

export type AccountEnv = { CF_ACCESS_TEAM_DOMAIN?: string; CF_ACCESS_AUD?: string };

export type EmailChangeCheck =
  | { ok: true; userId: string; current: string; next: string; method: string; factorAgeSeconds: number }
  | { ok: false; reply: AccountReply };

/**
 * May this request start an email change, and to what address?
 *
 * Cloudflare Access is checked when the deployment uses it (either setting is
 * present). A deployment that does not use Access has nothing to check there;
 * one that has only half the settings is refused, never waved through.
 */
export async function checkEmailChange(input: {
  user: { id: string; email?: string | null } | null | undefined;
  aal: AalInfo;
  /** The account's second factors (user.factors), as the sign-in service lists them. */
  factors: readonly FactorInfo[] | null | undefined;
  accessJwt: string | null | undefined;
  env: AccountEnv;
  newEmail: unknown;
  now?: number;
  fetchKeys?: KeyFetcher;
}): Promise<EmailChangeCheck> {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (!input.user?.id) return { ok: false, reply: refused(401, "signed-out", "Sign in to Fleet first.") };

  const next = cleanEmail(input.newEmail);
  if (!next) return { ok: false, reply: refused(400, "bad-address", "That does not look like an email address.") };
  const current = (input.user.email ?? "").trim().toLowerCase();
  if (next === current) return { ok: false, reply: refused(400, "same-address", "That is already your sign-in email.") };

  if (usesAccess(input.env)) {
    const access = await verifyAccessJwt(input.accessJwt, {
      teamDomain: input.env.CF_ACCESS_TEAM_DOMAIN,
      audience: input.env.CF_ACCESS_AUD,
      now,
      fetchKeys: input.fetchKeys,
    });
    if (!access.ok) {
      if (access.reason === "not-configured") return { ok: false, reply: refused(503, "access-not-configured", "The Cloudflare Access settings are incomplete, so Fleet cannot check this request.") };
      if (access.reason === "keys-unavailable") return { ok: false, reply: refused(503, "access-keys-unavailable", "Could not check with Cloudflare Access just now. Try again in a moment.") };
      return { ok: false, reply: refused(403, `access-${access.reason}`, "This request did not come through Cloudflare Access.") };
    }
  }

  // The middleware turns away an account with no authenticator app already; this asks again by itself.
  if (!hasAuthenticator(input.factors)) {
    return { ok: false, reply: refused(403, "no-authenticator", "Changing your sign-in email needs an authenticator app on your account. Sign out and sign in again: the login page sets it up.") };
  }

  const factor = strongFactor(input.aal, now, EMAIL_CHANGE_FACTOR_MAX_AGE_SECONDS);
  if (!factor.ok) {
    return {
      ok: false,
      reply:
        factor.reason === "no-strong-factor"
          ? refused(403, "no-strong-factor", "Changing your sign-in email needs a passkey, or a password with a code. Add one under Settings, then sign in with it.", true)
          : refused(403, "strong-factor-too-old", "Confirm with your passkey to change your sign-in email.", true),
    };
  }

  return { ok: true, userId: input.user.id, current, next, method: factor.method, factorAgeSeconds: factor.ageSeconds };
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
export type AuthServer = { url: string; anonKey: string; fetch: Fetch };

const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const errorCode = (j: Record<string, unknown>) => (typeof j.error_code === "string" ? j.error_code : typeof j.code === "string" ? j.code : "");

/** Domains that never receive mail (RFC 2606, RFC 6761). A first account is often created on one. */
const NEVER_DELIVERED = /(^|\.)(example\.(com|org|net)|example|test|invalid|localhost)$/;
const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1);

/** Does this text name this address, whole, and not as the tail or head of a longer one? */
function names(text: string, email: string): boolean {
  if (!email) return false;
  for (let at = text.indexOf(email); at !== -1; at = text.indexOf(email, at + 1)) {
    const before = text[at - 1] ?? "";
    const after = text[at + email.length] ?? "";
    const afterNext = text[at + email.length + 1] ?? "";
    if (/[a-z0-9._%+-]/.test(before)) continue;
    if (/[a-z0-9-]/.test(after) || (after === "." && /[a-z0-9]/.test(afterNext))) continue;
    return true;
  }
  return false;
}

/**
 * Which address a refusal is about, when that can be told. With "Secure email
 * change" on, the database mails the current address as well, so a refusal to
 * send may be about the address the account already has. `guess` allows one
 * inference when the database names no address: a current address on a domain
 * that never receives mail explains a refusal to send.
 */
export function addressAtFault(json: Record<string, unknown>, current: string, next: string, guess = false): "current" | "new" | null {
  const said = [json.msg, json.message, json.error_description].filter((s): s is string => typeof s === "string").join(" ").toLowerCase();
  if (names(said, next)) return "new";
  if (current && current !== next && names(said, current)) return "current";
  if (guess && current && NEVER_DELIVERED.test(domainOf(current)) && !NEVER_DELIVERED.test(domainOf(next))) return "current";
  return null;
}

/**
 * Ask the database to start the change, as the user. On success the account
 * still has its old address: the database has only mailed the link. `current`
 * is the address the account has now, used only to word a refusal.
 */
export async function startEmailChange(server: AuthServer, accessToken: string, next: string, redirectTo: string, current = ""): Promise<AccountReply> {
  let res: Awaited<ReturnType<Fetch>>;
  let json: Record<string, unknown>;
  try {
    res = await server.fetch(`${server.url}/auth/v1/user?redirect_to=${encodeURIComponent(redirectTo)}`, {
      method: "PUT",
      headers: { apikey: server.anonKey, Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email: next }),
    });
    json = record(await res.json().catch(() => null));
  } catch {
    return { status: 502, body: { state: "failed", ok: false, reason: "unreachable", message: "Fleet could not reach its database. Nothing was changed." } };
  }

  if (res.ok) {
    const now = typeof json.email === "string" ? json.email.toLowerCase() : "";
    // Only an account with no address yet is changed on the spot; everyone else gets the link.
    return { status: 200, body: { state: now === next ? "changed" : "sent", ok: true, email: next } };
  }

  switch (errorCode(json)) {
    case "email_exists":
      return refused(409, "address-taken", "Fleet cannot use that address. It may already belong to another account.");
    case "over_email_send_rate_limit":
    case "over_request_rate_limit":
      return refused(429, "too-many", "A confirmation email was sent a moment ago. Wait a minute, then try again.");
    case "insufficient_aal":
      // The page asks for the code in place, then sends the change again.
      return { status: 409, body: { state: "refused", ok: false, reason: "needs-code", message: "This account has an authenticator app, so the database wants its code before an email change.", stepUp: false, needsCode: true } };
    case "email_address_invalid":
    case "validation_failed": {
      const fault = addressAtFault(json, current, next, errorCode(json) === "email_address_invalid");
      if (fault === "current") return refused(409, "current-address-unusable", `The database cannot send mail to your current address, ${current}, and it has to before it changes it. Whoever runs this Fleet sets the first real address once, from the server side: see docs/sign-in-email.md.`);
      return refused(400, "bad-address", `The database did not accept ${next}. Check the spelling, or use another address.`);
    }
    case "email_address_not_authorized":
      return refused(409, "no-sender", "The database has no email sender set up, so it can only write to its own team. Set up a sender in Supabase, then try again.");
    case "email_provider_disabled":
      return refused(409, "email-off", "Email sign-in is turned off in the database, so the address cannot be changed here.");
    default:
      return { status: res.status === 401 ? 401 : 502, body: { state: "failed", ok: false, reason: res.status === 401 ? "signed-out" : "database", message: res.status === 401 ? "Sign in to Fleet again, then try once more." : "The change could not be started. Nothing was changed." } };
  }
}

/** What an emailed link carries. Checked before it is sent anywhere. */
export const looksLikeLinkToken = (raw: unknown): raw is string => typeof raw === "string" && /^[A-Za-z0-9_-]{16,200}$/.test(raw);

/**
 * Confirm a link, for the signed-in user who pressed the button.
 *
 * The database answers a confirmed link with a brand-new session for the
 * account. Fleet does not want one: the person is already signed in, and a
 * link from an inbox should not be a way to mint sessions. So the session is
 * closed straight away and never reaches the browser.
 */
export async function confirmEmailChange(server: AuthServer, tokenHash: unknown, callerId: string): Promise<AccountReply> {
  if (!looksLikeLinkToken(tokenHash)) return refused(400, "bad-link", "This link is incomplete. Open the link in the email again.");
  let res: Awaited<ReturnType<Fetch>>;
  let json: Record<string, unknown>;
  try {
    res = await server.fetch(`${server.url}/auth/v1/verify`, {
      method: "POST",
      headers: { apikey: server.anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "email_change", token_hash: tokenHash }),
    });
    json = record(await res.json().catch(() => null));
  } catch {
    return { status: 502, body: { state: "failed", ok: false, reason: "unreachable", message: "Fleet could not reach its database. Nothing was changed; the link still works." } };
  }

  if (!res.ok) {
    if (errorCode(json) === "otp_expired" || res.status === 403) return refused(409, "link-used", "This link has expired or was already used. Start the change again from your profile.");
    return { status: 502, body: { state: "failed", ok: false, reason: "database", message: "The link could not be confirmed. Nothing was changed." } };
  }

  const session = typeof json.access_token === "string" ? json.access_token : "";
  if (!session) {
    // "Secure email change" is on: this was the first of the two addresses.
    return { status: 200, body: { state: "half", ok: true, message: "This address is confirmed. One step is left: open the link Fleet sent to the other address." } };
  }

  await server
    .fetch(`${server.url}/auth/v1/logout?scope=local`, { method: "POST", headers: { apikey: server.anonKey, Authorization: `Bearer ${session}` } })
    .catch(() => null);

  const user = record(json.user);
  if (user.id !== callerId) return refused(409, "other-account", "That link was for a different account. Your sign-in email is unchanged.");
  return { status: 200, body: { state: "changed", ok: true, email: typeof user.email === "string" ? user.email.toLowerCase() : "" } };
}
