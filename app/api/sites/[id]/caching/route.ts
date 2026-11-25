
import { getPatchstackProtection, screenPatchstackResponse } from "../../../../../patchstack.next";
import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { refuseUnlessStrong } from "@/lib/api-guard";
import {
  type CachingState,
  cachingColumns,
  cachingFromRecord,
  cachingFromRow,
  changeShows,
  describeAction,
  parseAction,
  planChange,
} from "@/lib/site-caching";

// One caching change to one site, through GridPane's API: a page cache on or off, its
// time to live, the Redis object cache, or a cache clear. What GridPane accepts, and
// why each refusal reads the way it does, is in lib/site-caching.ts and
// docs/gridpane-api-caching.md.
//
// The order: check the change against GridPane's rules using this app's copy of the
// site's caching, send it, then read GridPane's record back and save what GridPane
// says, not what was asked for. Nothing here retries: a GridPane refusal is reported
// as one.
//
// Why no read from GridPane before the change: GridPane allows 2 site changes a minute
// on this endpoint, one change spends both, and a read of the same site a second before
// can leave nothing for the change, which is then refused although the same change sent
// alone is accepted. So the plan uses Fleet's copy, which every
// sync and every change through here refreshes. When that copy is stale, GridPane's own
// 409 says so, and the record is read after the refusal to bring the copy up to date.

const API = "https://my.gridpane.com/oauth/api/v1/site";

// After GridPane accepts a change, its record can take a moment to show it. Read it
// back at these points (ms after the change) and stop at the first that shows it.
// Three reads stay inside GridPane's 12 reads a minute on this endpoint.
const READ_BACK_AT = [3_000, 8_000, 15_000];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readCaching(id: number, token: string): Promise<CachingState | null> {
  const res = await fetch(`${API}/${id}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  const record = json && (json.data || json);
  return record && typeof record === "object" ? cachingFromRecord(record) : null;
}

/** GridPane's own words from a refusal, when it gave any. */
function gridpaneMessage(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const err = (json as { error?: unknown }).error;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") return (err as { message: string }).message;
  return null;
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  // #region patchstack-next-route
  const psProtection = await getPatchstackProtection();
  const psBlocked = psProtection && await psProtection.fetchGuard()(request);
  if (psBlocked) return psBlocked;
  // #endregion

  const refused = await refuseUnlessStrong(request);
  if (refused) return screenPatchstackResponse((refused), request, psProtection);

  const { id: rawId } = await params;
  // A staging copy's page uses its live site's id made negative (lib/site-row-id.ts), and
  // GridPane's API has no staging environment: a change sent for it would hit the live site.
  if (!/^[1-9][0-9]{0,14}$/.test(rawId)) {
    return screenPatchstackResponse((NextResponse.json({ error: "Caching can only be changed on a live site, by its GridPane id." }, { status: 400 })), request, psProtection);
  }
  const id = Number(rawId);

  const action = parseAction(await request.json().catch(() => null));
  if ("error" in action) return screenPatchstackResponse((NextResponse.json({ error: action.error }, { status: 400 })), request, psProtection);

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const token = process.env.GRIDPANE_API_TOKEN;
  if (!supabaseUrl || !serviceKey || !token) {
    return screenPatchstackResponse((NextResponse.json({ error: "The app is missing its Supabase or GridPane settings." }, { status: 500 })), request, psProtection);
  }
  const supabase = createClient(supabaseUrl, serviceKey);

  const { data: site } = await supabase
    .from("sites")
    .select("id, url, nginx_caching, nginx_caching_ttl, object_caching, object_cache_pro")
    .eq("id", id)
    .maybeSingle();
  if (!site) return screenPatchstackResponse((NextResponse.json({ error: `No site ${id} in Fleet.` }, { status: 404 })), request, psProtection);
  const siteUrl = site.url as string;
  const what = describeAction(action);

  const log = (level: "success" | "warning" | "error", message: string) =>
    supabase.from("system_logs").insert({ level, message, site_url: siteUrl });

  // Fleet's copy, not a fresh read: see the note at the top.
  const before = cachingFromRow(site);

  // After GridPane refuses, its record is the truth to show and to keep: read it once,
  // save it, and answer with it. A read after a change does not cost the next change.
  const refreshed = async (): Promise<CachingState> => {
    const now = await readCaching(id, token);
    if (!now) return before;
    await supabase.from("sites").update(cachingColumns(now)).eq("id", id);
    return now;
  };

  const plan = planChange(before, action);
  if ("error" in plan) {
    // Refused from Fleet's copy, so nothing went to GridPane. If the refusal is about what is
    // set now ("already on", "turn it off first"), that copy may be stale: read GridPane, and
    // when it disagrees, show its settings and ask for the change again in a minute, since a
    // change straight after a read would be refused (see the note at the top).
    if (plan.status === 409) {
      const now = await refreshed();
      if (JSON.stringify(now) !== JSON.stringify(before)) {
        return screenPatchstackResponse((NextResponse.json({
          error: "Fleet's copy of this site's caching was out of date, so nothing was sent. The panel now shows what GridPane reports. If the change is still needed, make it again in a minute.",
          state: now,
        }, { status: 409 })), request, psProtection);
      }
    }
    return screenPatchstackResponse((NextResponse.json({ error: plan.error, state: before }, { status: plan.status })), request, psProtection);
  }

  const res = await fetch(`${API}/${id}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(plan.body),
  });
  const json = await res.json().catch(() => null);

  if (!res.ok) {
    if (res.status === 429) {
      // GridPane answers 429 both when one site's settings changed too recently and when the
      // account's API budget is spent (a full sync spends much of it). Its rate-limit headers
      // tell the two apart, so the log keeps them: names and numbers only, nothing secret.
      const limits = [...res.headers.entries()]
        .filter(([name]) => /ratelimit|retry-after/i.test(name))
        .map(([name, value]) => `${name}=${value.slice(0, 40)}`)
        .join(", ");
      await log("warning", `[Caching Not Changed] GridPane refused "${what}" on ${siteUrl} with 429; nothing was changed.${limits ? ` Its limits: ${limits}.` : ""}`);
      return screenPatchstackResponse((NextResponse.json(
        { error: "GridPane did not make this change (429, too many requests). It limits how often one site's settings change, and how many API calls the account makes; a sync uses many. Nothing was changed. Try again in a few minutes.", state: before },
        { status: 429 },
      )), request, psProtection);
    }
    const said = gridpaneMessage(json);
    await log("error", `[Caching Not Changed] GridPane refused "${what}" on ${siteUrl}: ${res.status}${said ? ` ${said}` : ""}.`);
    // A 409 usually means Fleet's copy was out of date (changed in GridPane since the last
    // sync): read GridPane's record so the panel shows what is really set.
    const state = res.status === 409 || res.status === 422 ? await refreshed() : before;
    return screenPatchstackResponse((NextResponse.json(
      { error: `GridPane refused the change${said ? `: ${said}` : ` (${res.status})`}. Nothing was changed. The panel now shows what GridPane reports.`, state },
      { status: res.status === 409 || res.status === 422 ? 409 : 502 },
    )), request, psProtection);
  }

  // A cache clear leaves nothing in the record to read back.
  if (action.kind === "clear") {
    await log("success", `[Cache Cleared] GridPane accepted "${what}" on ${siteUrl}.`);
    return screenPatchstackResponse((NextResponse.json({ state: before, confirmed: null, message: `GridPane accepted the request: ${what}.` })), request, psProtection);
  }

  let after: CachingState | null = null;
  let shows = false;
  let waited = 0;
  for (const at of READ_BACK_AT) {
    await wait(at - waited);
    waited = at;
    after = await readCaching(id, token);
    if (after && changeShows(after, action)) { shows = true; break; }
  }

  if (after) {
    const { error: saveError } = await supabase.from("sites").update(cachingColumns(after)).eq("id", id);
    if (saveError) await log("error", `[Caching] ${siteUrl}: GridPane's record was read back but not saved in Fleet: ${saveError.message}`);
  }

  if (shows) {
    await log("success", `[Caching Changed] ${siteUrl}: ${what}. GridPane's record shows it.`);
    return screenPatchstackResponse((NextResponse.json({ state: after, confirmed: true, message: `Done: ${what}. GridPane's record shows it.` })), request, psProtection);
  }
  await log("warning", `[Caching Accepted, Not Yet Shown] ${siteUrl}: GridPane accepted "${what}" but its record did not show it ${READ_BACK_AT.at(-1)! / 1000} s later.`);
  return screenPatchstackResponse((NextResponse.json({
    state: after ?? before,
    confirmed: false,
    message: `GridPane accepted the change (${what}), but its record did not show it yet. It may still be applying it: press Sync in a few minutes to check.`,
  })), request, psProtection);
}
