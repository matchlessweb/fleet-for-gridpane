
import { getPatchstackProtection, screenPatchstackResponse } from "../../../../../patchstack.next";
import { confirmEmailChange } from "@/lib/account/email-change";
import { accountContext, SIGNED_OUT } from "@/lib/account/route";
import { fromFleetItself, jsonBody, NO_DATABASE, NOT_FLEET, send, sendToPage } from "@/lib/sso/route";

/**
 * Confirm an emailed link. Body: { token }.
 * POST only, and only from Fleet's own page: opening or previewing the link in
 * the email can never confirm it.
 */
export async function POST(request: Request) {
  // #region patchstack-next-route
  const psProtection = await getPatchstackProtection();
  const psBlocked = psProtection && await psProtection.fetchGuard()(request);
  if (psBlocked) return psBlocked;
  // #endregion

  if (!fromFleetItself(request)) return screenPatchstackResponse((NOT_FLEET()), request, psProtection);
  const { user, server } = await accountContext();
  if (!user) return screenPatchstackResponse((send(SIGNED_OUT)), request, psProtection);
  if (!server) return screenPatchstackResponse((NO_DATABASE()), request, psProtection);
  const body = await jsonBody(request);
  return screenPatchstackResponse((sendToPage(await confirmEmailChange(server, body.token, user.id))), request, psProtection);
}
