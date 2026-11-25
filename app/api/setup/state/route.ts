import { getPatchstackProtection, screenPatchstackResponse } from "../../../../patchstack.next";
import { NextResponse } from "next/server";
import { refuseUnlessStrong } from "@/lib/api-guard";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { readSsoState } from "@/lib/sso/service";
import { allowedUserIds } from "@/lib/sso/gate";
export const dynamic = "force-dynamic";

/**
 * What the setup page needs to say which optional parts are set up: yes or no for
 * each, never a value. A setting's presence is reported; its contents are not.
 * The controls for each part stay behind their own gates (one-click sign-in's
 * switch is shown only to someone past its gate, Settings > Security).
 */
export async function GET(request: Request) {
  // #region patchstack-next-route
  const psProtection = await getPatchstackProtection();
  const psBlocked = psProtection && await psProtection.fetchGuard()(request);
  if (psBlocked) return psBlocked;
  // #endregion

  const refused = await refuseUnlessStrong(request);
  if (refused) return screenPatchstackResponse(refused, request, psProtection);

  const env = process.env;
  const set = (v: string | undefined) => typeof v === "string" && v.trim() !== "";

  // The caller's own account id: one-click sign-in's allow-list is made of these
  // (scripts/sso-make-keys.sh --user-ids), so the page shows it to its owner.
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const userId = user?.id ?? null;
  const allowList = allowedUserIds(env.SSO_ALLOWED_USER_IDS);

  // The database part of one-click sign-in (sso_schema.sql): its state function answers once applied.
  const url = env.NEXT_PUBLIC_SUPABASE_URL, key = env.SUPABASE_SERVICE_ROLE_KEY;
  const admin = url && key ? createAdminClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
  const ssoSchema = admin ? (await readSsoState((fn, args) => admin.rpc(fn, args))) !== null : null;

  const accessConfigured = set(env.CF_ACCESS_TEAM_DOMAIN) && set(env.CF_ACCESS_AUD);
  const body = {
    access: {
      configured: accessConfigured,
      // Whether this request carried an Access token. Shown, not trusted: the routes that
      // need Access check the token itself (lib/sso/gate.ts).
      thisVisit: set(request.headers.get("cf-access-jwt-assertion") ?? undefined),
    },
    sso: {
      schema: ssoSchema,
      keys: set(env.SSO_SIGN_PRIVATE_KEY) && set(env.SSO_BOX_PRIVATE_KEY),
      allowList: allowList.size > 0,
      onList: userId !== null && allowList.has(userId.toLowerCase()),
      userId,
    },
    patchstack: {
      rules: set(env.PATCHSTACK_WAF_TOKEN) ? "patchstack" : "bundled",
      mode: env.PATCHSTACK_MODE === "dry-run" ? "dry-run" : "block",
    },
  };
  return screenPatchstackResponse(NextResponse.json(body, { headers: { "Cache-Control": "no-store" } }), request, psProtection);
}
