/**
 * The front door: did this request come through Cloudflare Access?
 *
 * The app is built to sit behind Cloudflare Access (SECURITY.md). Access puts a
 * signed token on every request it lets through. When the two Access settings
 * are set, the middleware asks this file about every request, before anything
 * else runs, so a mistake in the Access setup or a second route to the Worker
 * cannot put the app's own login page in front of a stranger.
 *
 * Three states, and only the first two are safe to run in:
 *   neither setting is set   Access is not in use on this install. Nothing is checked.
 *   both are set             every request must carry a token Access signed for this application.
 *   one of the two is set    a half-finished setup. Every request is refused until it is finished:
 *                            an unset half must never read as "no check needed". The same goes for
 *                            a team address that is not one (a path in it, say): the refusal says so.
 *
 * What counts as "came through Access": the token's signature, issuer, audience
 * and dates all hold (lib/sso/access-jwt.ts). A service token passes here too:
 * it has no person in it, but Access issued it for this application. Who the
 * caller is, and what they may do, is still decided by the app's own sign-in.
 * The two routes that need a PERSON (changing a sign-in email, one-click
 * WordPress sign-in) ask the verifier themselves and refuse a service token.
 */
import { normalizeTeamDomain, verifyAccessJwt, type AccessJwtFailure, type KeyFetcher } from "./sso/access-jwt.ts";

export type AccessGateEnv = { CF_ACCESS_TEAM_DOMAIN?: string; CF_ACCESS_AUD?: string };

export type AccessGateResult =
  /** checked: false means Access is not set up on this install, so nothing was asked. */
  | { allow: true; checked: boolean }
  | { allow: false; status: 403 | 503; reason: `access-${AccessJwtFailure}`; message: string };

/**
 * What a refused caller is told. A deployed app says only that the request did
 * not come through Access. A development run (`npm run dev`) adds the likely
 * cause for a request with no token at all: the two settings are in .env.local,
 * and nothing in front of a local run puts an Access token on a request, so the
 * person would otherwise see every page refused and no reason.
 */
export function refusalMessage(refusal: { reason: string; message: string }, development: boolean): string {
  if (!development || refusal.reason !== "access-missing") return refusal.message;
  return `${refusal.message} This is a development run with CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD set, and nothing in front of it puts a Cloudflare Access token on a request, so every request is refused. If the two are in .env.local (or another .env file, or this shell), take them out and start again: the deployed Worker keeps its own copies (npx wrangler secret list). Copy the two lines to ~/.config/fleet/privacy-extra first, so the privacy list (npm run privacy:denylist) still keeps them out of anything you publish.`;
}

/** The request header Access puts its token in. */
export const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

/** Either setting present means this install uses Access. One alone is a half-finished setup, and is refused. */
export function usesAccess(env: AccessGateEnv): boolean {
  return Boolean(env.CF_ACCESS_TEAM_DOMAIN?.trim() || env.CF_ACCESS_AUD?.trim());
}

export async function checkAccessGate(input: {
  /** The Cf-Access-Jwt-Assertion request header. */
  accessJwt: string | null | undefined;
  env: AccessGateEnv;
  now?: number;
  fetchKeys?: KeyFetcher;
}): Promise<AccessGateResult> {
  if (!usesAccess(input.env)) return { allow: true, checked: false };

  const access = await verifyAccessJwt(input.accessJwt, {
    teamDomain: input.env.CF_ACCESS_TEAM_DOMAIN,
    audience: input.env.CF_ACCESS_AUD,
    now: input.now,
    fetchKeys: input.fetchKeys,
  });
  // "not-a-person" is the verifier's last question, asked only of a token whose
  // signature, issuer, audience and dates already held: a service token.
  if (access.ok || access.reason === "not-a-person") return { allow: true, checked: true };

  if (access.reason === "not-configured") {
    // Which of the two things it is, so the person fixing it is not sent looking for a setting that is there.
    const team = input.env.CF_ACCESS_TEAM_DOMAIN?.trim();
    const wrongFormat = Boolean(team) && normalizeTeamDomain(team) === null;
    return {
      allow: false,
      status: 503,
      reason: "access-not-configured",
      message: wrongFormat
        ? "CF_ACCESS_TEAM_DOMAIN is set, but it is not a team address, so Fleet cannot check this request. It should be the name alone, like yourteam.cloudflareaccess.com, with nothing after it."
        : "The Cloudflare Access settings are incomplete, so Fleet cannot check this request. Set both CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD.",
    };
  }
  if (access.reason === "keys-unavailable") {
    return { allow: false, status: 503, reason: "access-keys-unavailable", message: "Could not check with Cloudflare Access just now. Try again in a moment." };
  }
  return { allow: false, status: 403, reason: `access-${access.reason}`, message: "This request did not come through Cloudflare Access." };
}
