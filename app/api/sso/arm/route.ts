
import { getPatchstackProtection, screenPatchstackResponse } from "../../../../patchstack.next";
import { fromFleetItself, NOT_FLEET, send, ssoContext } from "@/lib/sso/route";

/**
 * "Someone is about to click": have the server services check for requests
 * every second for ten minutes instead of every ten seconds. It mints nothing,
 * so it needs the allow-list and Cloudflare Access but not a fresh passkey.
 */
export async function POST(request: Request) {
  // #region patchstack-next-route
  const psProtection = await getPatchstackProtection();
  const psBlocked = psProtection && await psProtection.fetchGuard()(request);
  if (psBlocked) return psBlocked;
  // #endregion

  if (!fromFleetItself(request)) return screenPatchstackResponse((NOT_FLEET()), request, psProtection);
  const { caller, rpc } = await ssoContext(request);
  if (!(caller.ok || caller.stepUp) || !rpc) return screenPatchstackResponse((send({ status: 200, body: { armed: false } })), request, psProtection);
  const armed = await rpc("sso_arm");
  return screenPatchstackResponse((send({ status: 200, body: { armed: !armed.error && armed.data != null } })), request, psProtection);
}
