/**
 * Who may ask Fleet for a one-click WordPress sign-in.
 *
 * The rest of the app asks for a strong session, however long ago its second
 * factor was shown (lib/auth-assurance.ts). Handing out a WordPress admin
 * sign-in is a bigger thing than changing a backup time, so this gate is
 * stricter: the list, Cloudflare Access, and a factor shown recently. All five must
 * hold, and anything unset or unreadable counts as "no":
 *
 *   1. a signed-in user,
 *   2. whose id is on the allow-list (SSO_ALLOWED_USER_IDS),
 *   3. on a request that verifiably came through Cloudflare Access,
 *   4. whose account has an authenticator app (the middleware asks this of
 *      every request already; this gate asks again by itself),
 *   5. who proved a strong factor (passkey, or password plus a code) recently.
 *
 * Pure apart from fetching Cloudflare's public keys, so every branch is tested
 * in scripts/test-sso-gate.ts.
 */
import { verifyAccessJwt, type AccessJwtFailure, type KeyFetcher } from "./access-jwt.ts";
import { hasAuthenticator, type FactorInfo } from "../auth-assurance.ts";

/** Ask for the passkey again once the last strong sign-in is older than this. */
export const STRONG_FACTOR_MAX_AGE_SECONDS = 12 * 60 * 60;

/**
 * Sign-in methods that count as a strong factor, as Supabase Auth names them in
 * the session's "amr" list. A password alone, a magic link, and a refreshed
 * token are not here on purpose.
 */
const STRONG_METHODS = new Set(["passkey", "totp", "mfa/totp", "mfa/webauthn"]);

type AmrEntry = { method: string; timestamp: number };
export type AalInfo = {
  currentLevel: string | null;
  nextLevel: string | null;
  currentAuthenticationMethods?: readonly (AmrEntry | string)[] | null;
} | null | undefined;

export type StrongFactor =
  | { ok: true; method: string; ageSeconds: number }
  | { ok: false; reason: "no-strong-factor" | "strong-factor-too-old"; ageSeconds?: number };

export function strongFactor(aal: AalInfo, now: number, maxAgeSeconds = STRONG_FACTOR_MAX_AGE_SECONDS): StrongFactor {
  let newest: AmrEntry | null = null;
  let sawUntimed = false;
  for (const entry of aal?.currentAuthenticationMethods ?? []) {
    const method = typeof entry === "string" ? entry : entry?.method;
    if (!STRONG_METHODS.has(method)) continue;
    if (typeof entry === "string" || typeof entry.timestamp !== "number" || !Number.isFinite(entry.timestamp)) {
      sawUntimed = true; // strong, but we cannot tell when: never good enough
      continue;
    }
    // Supabase reports seconds; be safe if a client library hands back milliseconds.
    const at = entry.timestamp > 1e12 ? Math.floor(entry.timestamp / 1000) : entry.timestamp;
    if (!newest || at > newest.timestamp) newest = { method, timestamp: at };
  }
  if (!newest) return { ok: false, reason: sawUntimed ? "strong-factor-too-old" : "no-strong-factor" };
  const ageSeconds = now - newest.timestamp;
  // A sign-in "from the future" beyond clock drift is not evidence of a recent one.
  if (ageSeconds < -60 || ageSeconds > maxAgeSeconds) return { ok: false, reason: "strong-factor-too-old", ageSeconds };
  return { ok: true, method: newest.method, ageSeconds: Math.max(0, ageSeconds) };
}

/** The ids in SSO_ALLOWED_USER_IDS (commas or spaces between them). Empty means nobody. */
export function allowedUserIds(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(/[\s,]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s))
  );
}

export type SsoGateEnv = {
  SSO_ALLOWED_USER_IDS?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
};

export type SsoGateReason =
  | "signed-out"
  | "not-configured"
  | "not-allowed"
  | `access-${AccessJwtFailure}`
  | "no-authenticator"
  | "no-strong-factor"
  | "strong-factor-too-old";

export type SsoCaller =
  | { ok: true; userId: string; userEmail: string; accessEmail: string; method: string; factorAgeSeconds: number }
  | { ok: false; status: 401 | 403 | 503; reason: SsoGateReason; message: string; stepUp: boolean };

const no = (status: 401 | 403 | 503, reason: SsoGateReason, message: string, stepUp = false): SsoCaller => ({ ok: false, status, reason, message, stepUp });

export async function checkSsoCaller(input: {
  user: { id: string; email?: string | null } | null | undefined;
  aal: AalInfo;
  /** The account's second factors (user.factors), as the sign-in service lists them. */
  factors: readonly FactorInfo[] | null | undefined;
  /** The Cf-Access-Jwt-Assertion request header. */
  accessJwt: string | null | undefined;
  env: SsoGateEnv;
  now?: number;
  fetchKeys?: KeyFetcher;
}): Promise<SsoCaller> {
  const now = input.now ?? Math.floor(Date.now() / 1000);

  if (!input.user?.id) return no(401, "signed-out", "Sign in to Fleet first.");

  const allowed = allowedUserIds(input.env.SSO_ALLOWED_USER_IDS);
  if (allowed.size === 0) return no(503, "not-configured", "One-click sign-in is not set up: no one is on its allow-list.");
  if (!allowed.has(input.user.id.toLowerCase())) return no(403, "not-allowed", "Your account is not on the one-click sign-in list.");

  const access = await verifyAccessJwt(input.accessJwt, {
    teamDomain: input.env.CF_ACCESS_TEAM_DOMAIN,
    audience: input.env.CF_ACCESS_AUD,
    now,
    fetchKeys: input.fetchKeys,
  });
  if (!access.ok) {
    if (access.reason === "not-configured") return no(503, "access-not-configured", "One-click sign-in is not set up: the Cloudflare Access settings are missing.");
    if (access.reason === "keys-unavailable") return no(503, "access-keys-unavailable", "Could not check with Cloudflare Access just now. Try again in a moment.");
    return no(403, `access-${access.reason}`, "This request did not come through Cloudflare Access.");
  }

  if (!hasAuthenticator(input.factors)) {
    return no(403, "no-authenticator", "One-click sign-in needs an authenticator app on your account. Sign out and sign in again: the login page sets it up.");
  }

  const factor = strongFactor(input.aal, now);
  if (!factor.ok) {
    return factor.reason === "no-strong-factor"
      ? no(403, "no-strong-factor", "One-click sign-in needs a passkey, or a password with a code. Add one under Settings, then sign in with it.", true)
      : no(403, "strong-factor-too-old", "Confirm with your passkey or code to continue.", true);
  }

  return {
    ok: true,
    userId: input.user.id,
    userEmail: (input.user.email ?? "").toLowerCase(),
    accessEmail: access.email,
    method: factor.method,
    factorAgeSeconds: factor.ageSeconds,
  };
}
