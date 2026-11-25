
import { getPatchstackProtection, screenPatchstackResponse } from "../../../../patchstack.next";
import { readSsoState } from "@/lib/sso/service";
import { send, ssoContext } from "@/lib/sso/route";

/**
 * What the site buttons need to know: is one-click sign-in on, is it open to
 * this person, and which sites have opted in.
 *
 * "mine" is true for someone on the allow-list who came through Cloudflare
 * Access, even if their passkey sign-in is too old: the sign-in page asks them
 * to confirm. Anyone else gets an empty answer and plain links.
 */
export async function GET(request: Request) {
  // #region patchstack-next-route
  const psProtection = await getPatchstackProtection();
  const psBlocked = psProtection && await psProtection.fetchGuard()(request);
  if (psBlocked) return psBlocked;
  // #endregion

  const { caller, rpc } = await ssoContext(request);
  const mine = caller.ok || caller.stepUp;
  if (!mine || !rpc) return screenPatchstackResponse((send({ status: 200, body: { enabled: false, mine: false, sites: [] } })), request, psProtection);
  const state = await readSsoState(rpc);
  if (!state) return screenPatchstackResponse((send({ status: 200, body: { enabled: false, mine: true, sites: [], unavailable: true } })), request, psProtection);
  return screenPatchstackResponse((send({ status: 200, body: { enabled: state.enabled, mine: true, sites: state.sites } })), request, psProtection);
}
