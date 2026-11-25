/**
 * Shared by the routes under app/api/sso: who is calling, and the database
 * call they are allowed to make. Server-only.
 */
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fromOwnPages } from "@/lib/auth-assurance";
import { checkSsoCaller, type SsoCaller, type SsoGateEnv } from "./gate";
import { forPage, type Rpc, type SsoKeys, type SsoReply, type SsoWho } from "./service";

/** Nothing about a sign-in is ever cached, and no address leaks to where the browser goes next. */
const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

export const send = (r: SsoReply) => NextResponse.json(r.body, { status: r.status, headers: HEADERS });

/** See forPage: refusals the page is built to show go out as normal answers. */
export const sendToPage = (r: SsoReply) => send(forPage(r));

export const refuse = (caller: Extract<SsoCaller, { ok: false }>) =>
  sendToPage({ status: caller.status, body: { state: "refused", ok: false, reason: caller.reason, message: caller.message, stepUp: caller.stepUp } });

/**
 * True only for a call made by Fleet's own pages. A page on another site
 * cannot set these headers, so it cannot make a signed-in browser ask for a
 * sign-in on its behalf. The test itself is fromOwnPages (lib/auth-assurance.ts).
 */
export function fromFleetItself(request: Request): boolean {
  return fromOwnPages({
    secFetchSite: request.headers.get("sec-fetch-site"),
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
  });
}

export const NOT_FLEET = () => send({ status: 403, body: { state: "refused", reason: "cross-site", message: "That request did not come from Fleet." } });

export type SsoContext = { caller: SsoCaller; who: SsoWho | null; rpc: Rpc | null; keys: SsoKeys };

export async function ssoContext(request: Request): Promise<SsoContext> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const aal = user ? (await supabase.auth.mfa.getAuthenticatorAssuranceLevel()).data : null;
  const caller = await checkSsoCaller({
    user,
    aal,
    factors: user?.factors,
    accessJwt: request.headers.get("cf-access-jwt-assertion"),
    env: process.env as SsoGateEnv,
  });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const admin = url && key ? createAdminClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
  const rpc: Rpc | null = admin ? (fn, args) => admin.rpc(fn, args) : null;

  return {
    caller,
    who: caller.ok ? { userId: caller.userId, userEmail: caller.userEmail, accessEmail: caller.accessEmail, ip: request.headers.get("cf-connecting-ip") } : null,
    rpc,
    keys: { SSO_SIGN_PRIVATE_KEY: process.env.SSO_SIGN_PRIVATE_KEY, SSO_BOX_PRIVATE_KEY: process.env.SSO_BOX_PRIVATE_KEY },
  };
}

export const NO_DATABASE = () => send({ status: 503, body: { state: "refused", reason: "not-configured", message: "Fleet's database settings are missing." } });

export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
