type AMREntry = { method: string; timestamp: number };

// supabase-js types the AMR list as string[] | AMREntry[] depending on version
export type AALInfo = {
  currentLevel: string | null;
  nextLevel?: string | null;
  currentAuthenticationMethods?: readonly (AMREntry | string)[] | null;
} | null;

const hasPasskey = (methods: readonly (AMREntry | string)[] | null | undefined): boolean =>
  Array.isArray(methods) &&
  methods.some((entry) => (typeof entry === "string" ? entry : entry && typeof entry === "object" ? entry.method : null) === "passkey");

/**
 * Whether a session is strong: it is at assurance level 2 (a code from an
 * authenticator app was entered), or it was opened with a passkey. A session
 * opened with a password alone is never strong.
 *
 * Strong is not the whole test for using the app: see mayUseApp below, which
 * also asks that the account has an authenticator app, and says why.
 *
 * GoTrue reports first-factor passkey sign-ins as AAL1: its IsAAL2Claim()
 * counts only mfa/totp, mfa/phone and mfa/webauthn, never "passkey"
 * (supabase/auth internal/models/amr.go). A passkey ceremony is device
 * possession plus user verification and is phishing-resistant, at least as
 * strong as a typed code, so this app accepts an AMR "passkey" entry in place
 * of AAL2. Revisit if Supabase starts crediting passkeys toward AAL2.
 *
 * This is the database's own rule too, public.session_is_strong(): every table
 * answers only a session that passes it. scripts/test-strong-session.mjs runs
 * this function and the SQL one over the same sessions and fails if they ever
 * disagree. No answer about the session (null) is a no.
 */
export function sessionIsStrong(aal: AALInfo): boolean {
  if (!aal) return false;
  return aal.currentLevel === "aal2" || hasPasskey(aal.currentAuthenticationMethods);
}

/** One of the account's second factors, as the sign-in service lists it (user.factors). */
export type FactorInfo = { factor_type?: string | null; status?: string | null };

/** True when the account has an authenticator app that was set up and confirmed with a code. */
export function hasAuthenticator(factors: readonly FactorInfo[] | null | undefined): boolean {
  return Array.isArray(factors) && factors.some((f) => !!f && f.factor_type === "totp" && f.status === "verified");
}

/**
 * Whether a signed-in account may use the app now: its session is strong, and
 * the account has an authenticator app.
 *
 * Why the second half. The sign-in service (Supabase Auth) lets a session
 * opened with a password alone add an authenticator app or a passkey for as
 * long as the account has no confirmed authenticator app; once it has one,
 * both ask for a code (supabase/auth internal/api/mfa.go and
 * passkey_manage.go answer insufficient_aal). So an account with a passkey and
 * no authenticator app could be entered by whoever holds its password: sign
 * in, add a second passkey, sign in again with that. Holding every account
 * that uses the app to an authenticator app shuts that door: the login page
 * sends an account without one to set it up, passkey sign-ins included.
 *
 * What this cannot shut is the time before an account's first set-up, when
 * its password is all it has: whoever signs in first sets the authenticator
 * up. So set it up straight after making the account (SECURITY.md), and
 * `npm run doctor` names any account still in that state.
 */
export function mayUseApp(aal: AALInfo, factors: readonly FactorInfo[] | null | undefined): boolean {
  return sessionIsStrong(aal) && hasAuthenticator(factors);
}

/** What a browser says about where a request came from. */
export type RequestSource = {
  /** The browser's own Sec-Fetch-Site header. A page cannot set or change it. */
  secFetchSite: string | null;
  origin: string | null;
  host: string | null;
};

/**
 * True only for a request made by this site's own pages: the one test a
 * request that changes something must pass. A page on another site cannot set
 * these headers, so it cannot make a signed-in browser act on its behalf.
 * judgeCaller below and the sign-on and account routes (fromFleetItself in
 * lib/sso/route.ts) both ask here, so there is one copy to test.
 */
export function fromOwnPages(source: RequestSource): boolean {
  if (source.secFetchSite && source.secFetchSite !== "same-origin") return false;
  if (!source.origin || !source.host) return false;
  try {
    return new URL(source.origin).host === source.host;
  } catch {
    return false;
  }
}

export type CallerFacts = RequestSource & {
  method: string;
  signedIn: boolean;
  aal: AALInfo;
  /** The account's second factors (user.factors). */
  factors: readonly FactorInfo[] | null | undefined;
};

/**
 * What a route that acts with the service's key asks of its caller, on top of
 * the middleware: an account that may use the app, and a request made by this
 * site's own pages. Returns the refusal, or null to let it through. Pure, so
 * scripts/test-session-guard.ts can try every case.
 */
export function judgeCaller(c: CallerFacts): { status: 401 | 403; error: string } | null {
  if (!c.signedIn || !mayUseApp(c.aal, c.factors)) return { status: 401, error: "Authentication required" };
  const elsewhere = { status: 403 as const, error: "That request did not come from this site." };
  const reading = c.method === "GET" || c.method === "HEAD";
  // A read may also come from an address the person typed or bookmarked ("none"). A change never may.
  if (reading) return c.secFetchSite && c.secFetchSite !== "same-origin" && c.secFetchSite !== "none" ? elsewhere : null;
  return fromOwnPages(c) ? null : elsewhere;
}
