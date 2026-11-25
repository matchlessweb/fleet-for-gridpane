/**
 * The door for every API route that acts with the service's key. The
 * middleware already turns away an account that may not use the app; this asks again
 * inside the route, so a route never depends on the middleware's path rules
 * alone, and it refuses a change asked for by another site's page. Server-only.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { judgeCaller } from "@/lib/auth-assurance";

/** The refusal to send back, or null when the caller may go on. */
export async function refuseUnlessStrong(request: Request): Promise<NextResponse | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const aal = user ? (await supabase.auth.mfa.getAuthenticatorAssuranceLevel()).data : null;
  const no = judgeCaller({
    method: request.method,
    secFetchSite: request.headers.get("sec-fetch-site"),
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    signedIn: !!user,
    aal,
    factors: user?.factors,
  });
  return no ? NextResponse.json({ error: no.error }, { status: no.status, headers: { "Cache-Control": "no-store" } }) : null;
}
