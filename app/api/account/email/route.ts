
import { getPatchstackProtection, screenPatchstackResponse } from "../../../../patchstack.next";
import { checkEmailChange, startEmailChange, type AccountEnv } from "@/lib/account/email-change";
import { accountContext, SIGNED_OUT } from "@/lib/account/route";
import { fromFleetItself, jsonBody, NO_DATABASE, NOT_FLEET, send, sendToPage } from "@/lib/sso/route";

/**
 * Start a change of sign-in email. Body: { email }.
 * Nothing changes here: the database mails a link to the new address.
 */
export async function POST(request: Request) {
  // #region patchstack-next-route
  const psProtection = await getPatchstackProtection();
  const psBlocked = psProtection && await psProtection.fetchGuard()(request);
  if (psBlocked) return psBlocked;
  // #endregion

  if (!fromFleetItself(request)) return screenPatchstackResponse((NOT_FLEET()), request, psProtection);
  const { user, aal, accessToken, server } = await accountContext();
  const body = await jsonBody(request);
  const check = await checkEmailChange({
    user,
    aal,
    factors: user?.factors,
    accessJwt: request.headers.get("cf-access-jwt-assertion"),
    env: process.env as AccountEnv,
    newEmail: body.email,
  });
  if (!check.ok) return screenPatchstackResponse((sendToPage(check.reply)), request, psProtection);
  if (!server) return screenPatchstackResponse((NO_DATABASE()), request, psProtection);
  if (!accessToken) return screenPatchstackResponse((send(SIGNED_OUT)), request, psProtection);
  // fromFleetItself has already matched this Origin to the request's host.
  const origin = request.headers.get("origin") ?? "";
  return screenPatchstackResponse((sendToPage(await startEmailChange(server, accessToken, check.next, `${origin}/settings/profile`, check.current))), request, psProtection);
}
