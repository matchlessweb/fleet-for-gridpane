
import { getPatchstackProtection, screenPatchstackResponse } from "../../../../patchstack.next";
import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { refuseUnlessStrong } from "@/lib/api-guard";

export async function POST(request: Request) {
  // #region patchstack-next-route
  const psProtection = await getPatchstackProtection();
  const psBlocked = psProtection && await psProtection.fetchGuard()(request);
  if (psBlocked) return psBlocked;
  // #endregion

  try {
    const refused = await refuseUnlessStrong(request);
    if (refused) return screenPatchstackResponse((refused), request, psProtection);

    const { resolutions } = await request.json();

    if (!resolutions || !Array.isArray(resolutions)) {
      return screenPatchstackResponse((NextResponse.json({ error: "Invalid payload format. Expected array of resolutions." }, { status: 400 })), request, psProtection);
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const gridpaneToken = process.env.GRIDPANE_API_TOKEN;

    if (!supabaseUrl || !supabaseServiceKey || !gridpaneToken) {
      return screenPatchstackResponse((NextResponse.json({ error: "Missing required backend configuration secrets." }, { status: 500 })), request, psProtection);
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    let successCount = 0;
    let failedCount = 0;
    // Per-schedule outcomes. Previously this route returned 200 with
    // success:true no matter how many GridPane calls were rejected, and the
    // client — which only checked res.ok — announced that every schedule had
    // synced. A run where GridPane refused everything looked identical to a
    // clean one.
    const results: Array<{
      id: number;
      site_id: unknown;
      ok: boolean;
      stage?: "gridpane" | "cache";
      status?: number;
      error?: string;
    }> = [];

    for (const res of resolutions) {
      const payload: { id: number; bup_schedule: unknown; minute: number; hour?: number; day?: number } = {
        id: parseInt(res.id),
        bup_schedule: res.bup_schedule,
        minute: parseInt(res.minute) || 0
      };
      if (res.bup_schedule !== "hourly") {
        payload.hour = parseInt(res.hour) || 0;
      }
      if (res.day !== null && res.day !== undefined) {
        payload.day = parseInt(res.day);
      }

      console.log(`[GridPane Synchronization Payload Debug] Site ${res.site_id}`, JSON.stringify(payload, null, 2));

      // Attempt explicit GridPane API Override
      const gpResponse = await fetch(`https://my.gridpane.com/oauth/api/v1/backups/schedule/site/${res.site_id}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${gridpaneToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!gpResponse.ok) {
         failedCount++;
         const errorText = await gpResponse.text();
         console.warn(`[GridPane Synchronization Failed] Schedule ID ${res.id} on Site ${res.site_id}: ${gpResponse.status} - ${errorText}`);

         results.push({
           id: parseInt(res.id),
           site_id: res.site_id,
           ok: false,
           stage: "gridpane",
           status: gpResponse.status,
           error: errorText.slice(0, 300),
         });

         await supabase.from("system_logs").insert({
            level: "error",
            message: `GridPane synchronization rejected: Failed to modify backup schedule ${res.id} on Site ${res.site_id}. Provider returned ${gpResponse.status}.`,
            site_url: `Site ID: ${res.site_id}`
         });
         continue;
      }

      // Update Supabase Local PostgreSQL Cache to instantaneously resolve overlapping UI bounding visually locally
      const updatePayload: { minute: string; hour?: string } = {
        minute: res.minute.toString().padStart(2, '0')
      };
      if (res.bup_schedule !== "hourly") {
        updatePayload.hour = (res.hour || 0).toString().padStart(2, '0');
      }

      const { error: dbError } = await supabase
        .from('backup_schedules')
        .update(updatePayload)
        .eq('id', res.id);

      if (dbError) {
         // GridPane DID accept this one; only the local cache is stale. Report
         // it as a failure so the caller does not treat the row as settled, but
         // name the stage — the remedy is a re-sync, not a re-schedule.
         console.warn(`[Supabase Mutation Failed] Could not update local Postgres cache for schedule ${res.id}`);
         failedCount++;
         results.push({
           id: parseInt(res.id),
           site_id: res.site_id,
           ok: false,
           stage: "cache",
           error: dbError.message,
         });
      } else {
         successCount++;
         results.push({ id: parseInt(res.id), site_id: res.site_id, ok: true });
      }
    }

    const allFailed = successCount === 0 && failedCount > 0;
    const someFailed = failedCount > 0 && successCount > 0;

    // The HTTP status carries the truth on its own, so a caller that only
    // checks res.ok cannot be misled: 200 all good, 207 mixed, 502 nothing
    // landed. `ok` says the same thing for callers that read the body.
    return screenPatchstackResponse((NextResponse.json(
      {
        ok: failedCount === 0,
        successCount,
        failedCount,
        results,
        message:
          failedCount === 0
            ? `Synced ${successCount} schedule${successCount === 1 ? "" : "s"}.`
            : `Synced ${successCount} of ${successCount + failedCount}. ${failedCount} failed — check System Logs.`,
      },
      { status: allFailed ? 502 : someFailed ? 207 : 200 }
    )), request, psProtection);

  } catch (error) {
    return screenPatchstackResponse((NextResponse.json({ error: (error as { message?: string }).message || "Internal proxy error" }, { status: 500 })), request, psProtection);
  }
}
