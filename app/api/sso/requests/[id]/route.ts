
import { getPatchstackProtection, screenPatchstackResponse } from "../../../../../patchstack.next";
import { collectSignIn } from "@/lib/sso/service";
import { fromFleetItself, NO_DATABASE, NOT_FLEET, refuse, sendToPage, ssoContext } from "@/lib/sso/route";

/**
 * Collect the result of a sign-in request. A POST, not a GET: when the link is
 * ready this hands it over and erases it, so it must never run from a link
 * click, a prefetch or a preview.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  // #region patchstack-next-route
  const psProtection = await getPatchstackProtection();
  const psBlocked = psProtection && await psProtection.fetchGuard()(request);
  if (psBlocked) return psBlocked;
  // #endregion

  if (!fromFleetItself(request)) return screenPatchstackResponse((NOT_FLEET()), request, psProtection);
  const { caller, who, rpc, keys } = await ssoContext(request);
  if (!caller.ok || !who) return screenPatchstackResponse((refuse(caller as Extract<typeof caller, { ok: false }>)), request, psProtection);
  if (!rpc) return screenPatchstackResponse((NO_DATABASE()), request, psProtection);
  const { id } = await params;
  return screenPatchstackResponse((sendToPage(await collectSignIn(rpc, keys, who, id))), request, psProtection);
}
