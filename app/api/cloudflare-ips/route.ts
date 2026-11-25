
import { getPatchstackProtection, screenPatchstackResponse } from "../../../patchstack.next";
import { NextResponse } from "next/server";
import { BUILT_IN_RANGES, type CloudflareRanges } from "@/lib/web-lock";

/**
 * Cloudflare's IP ranges as published today, for the "web ports locked to
 * Cloudflare" check. Public data, no key needed.
 *
 * Asked fresh (cached an hour) rather than trusted from the copy built into the
 * app, because the check's whole job is to notice drift: if Cloudflare adds a
 * range, every server locked before that date is missing it, and visitors routed
 * through it get an error page. Falls back to the built-in list, and says so,
 * when Cloudflare cannot be reached or answers with something unexpected.
 */
export async function GET(psRequest: Request) {
  // #region patchstack-next-route
  const psProtection = await getPatchstackProtection();
  const psBlocked = psProtection && await psProtection.fetchGuard()(psRequest);
  if (psBlocked) return psBlocked;
  // #endregion

  let body: CloudflareRanges = BUILT_IN_RANGES;
  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/ips", {
      signal: AbortSignal.timeout(5000),
    });
    const data = (await res.json()) as {
      success?: boolean;
      result?: { ipv4_cidrs?: unknown; ipv6_cidrs?: unknown };
    };
    const v4 = data?.result?.ipv4_cidrs;
    const v6 = data?.result?.ipv6_cidrs;
    const valid = (list: unknown): list is string[] =>
      Array.isArray(list) && list.length > 0 && list.every((x) => typeof x === "string" && x.includes("/"));
    if (res.ok && data?.success && valid(v4) && valid(v6)) {
      body = { ranges: [...v4, ...v6], source: "cloudflare", asOf: new Date().toISOString().slice(0, 10) };
    }
  } catch {
    // Built-in list stands; the UI names which list it used.
  }
  return screenPatchstackResponse((NextResponse.json(body, { headers: { "Cache-Control": "private, max-age=3600" } })), psRequest, psProtection);
}
