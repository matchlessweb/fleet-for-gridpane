/**
 * Shared by the routes under app/api/account: the signed-in user, their
 * session, and the address of the database's sign-in service. Server-only.
 */
import { createClient } from "@/lib/supabase/server";
import type { AuthServer } from "./email-change";

export async function accountContext() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const aal = user ? (await supabase.auth.mfa.getAuthenticatorAssuranceLevel()).data : null;
  // Read only after getUser has checked the session with the database.
  const accessToken = user ? ((await supabase.auth.getSession()).data.session?.access_token ?? null) : null;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const server: AuthServer | null =
    url && anonKey ? { url: url.replace(/\/+$/, ""), anonKey, fetch: (u, init) => fetch(u, { ...init, cache: "no-store" }) } : null;
  return { user, aal, accessToken, server };
}

export const SIGNED_OUT = { status: 401, body: { state: "refused", ok: false, reason: "signed-out", message: "Sign in to Fleet first.", stepUp: false } };
