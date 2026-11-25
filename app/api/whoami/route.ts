
import { getPatchstackProtection, screenPatchstackResponse } from "../../../patchstack.next";
import { NextResponse } from "next/server";

/**
 * The address the caller is connecting from.
 *
 * Cloudflare puts the real client IP in `cf-connecting-ip` on every request that
 * reaches the Worker, so this needs no external lookup service — nothing leaves
 * the origin, and no third party learns where the operator works from.
 *
 * It exists because allowlist entries silently rot. A residential address gets
 * reassigned and the ignoreip rule that used to protect you starts protecting a
 * stranger; the agent's read-back cannot see this, because the rule IS installed
 * — it just no longer matches where you are. Comparing this against the
 * allowlist is the only way to catch that before it locks you out.
 *
 * Local dev has no Cloudflare in front, so the header is absent and this
 * reports null rather than inventing an answer from x-forwarded-for, which is
 * trivially spoofable and would be a loopback address here anyway.
 */
export async function GET(request: Request) {
  // #region patchstack-next-route
  const psProtection = await getPatchstackProtection();
  const psBlocked = psProtection && await psProtection.fetchGuard()(request);
  if (psBlocked) return psBlocked;
  // #endregion

  const cf = request.headers.get("cf-connecting-ip");
  return screenPatchstackResponse((NextResponse.json(
    {
      ip: cf,
      // Named so the UI can say why it has nothing, instead of implying the
      // operator is uncovered when we simply could not tell.
      source: cf ? "cloudflare" : null,
    },
    { headers: { "Cache-Control": "no-store" } }
  )), request, psProtection);
}
