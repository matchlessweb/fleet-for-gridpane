
import { getPatchstackProtection, screenPatchstackResponse } from "../../../../patchstack.next";
import { setSitePolicy } from "@/lib/sso/service";
import { fromFleetItself, jsonBody, NO_DATABASE, NOT_FLEET, refuse, sendToPage, ssoContext } from "@/lib/sso/route";

/** Turn one-click sign-in on or off for one site. Body: { serverId, hostname, enabled }. */
export async function POST(request: Request) {
  // #region patchstack-next-route
  const psProtection = await getPatchstackProtection();
  const psBlocked = psProtection && await psProtection.fetchGuard()(request);
  if (psBlocked) return psBlocked;
  // #endregion

  if (!fromFleetItself(request)) return screenPatchstackResponse((NOT_FLEET()), request, psProtection);
  const { caller, who, rpc } = await ssoContext(request);
  if (!caller.ok || !who) return screenPatchstackResponse((refuse(caller as Extract<typeof caller, { ok: false }>)), request, psProtection);
  if (!rpc) return screenPatchstackResponse((NO_DATABASE()), request, psProtection);
  const body = await jsonBody(request);
  return screenPatchstackResponse((sendToPage(await setSitePolicy(rpc, who, { serverId: body.serverId, hostname: body.hostname, enabled: body.enabled }))), request, psProtection);
}
