
import { getPatchstackProtection, screenPatchstackResponse } from "../../../../patchstack.next";
import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { refuseUnlessStrong } from "@/lib/api-guard";

async function fetchWithRetry(url: string, options: RequestInit, retries = 2): Promise<Response> {
  let lastResponse = null;
  // Use exponential backoff for transient 429s, but limit retries to 2 (2s -> 4s) to avoid extending the exact cooldown penalty box
  for (let i = 0; i < retries; i++) {
    const res = await fetch(url, options);
    if (res.status === 429) {
      const delay = Math.pow(2, i) * 2000;
      console.warn(`[GridPane Rate Limit] 429 Too Many Requests (Attempt ${i + 1}/${retries}). Retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
      lastResponse = res;
      continue;
    }
    return res;
  }
  return lastResponse as Response;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // #region patchstack-next-route
  const psProtection = await getPatchstackProtection();
  const psBlocked = psProtection && await psProtection.fetchGuard()(request);
  if (psBlocked) return psBlocked;
  // #endregion

  try {
    const refused = await refuseUnlessStrong(request);
    if (refused) return screenPatchstackResponse((refused), request, psProtection);

    const resolvedParams = await params;
    const { id } = resolvedParams;
    const body = await request.json();

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      return screenPatchstackResponse((NextResponse.json({ error: "Missing environmental Supabase credentials." }, { status: 500 })), request, psProtection);
    }

    // Bypass RLS using the physical Service Role Key for protected data updates
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Fetch the absolute unhydrated origin site explicitly isolating older FPM metrics locally
    const { data: originSiteData } = await supabase.from("sites").select("*").eq("id", parseInt(id)).single();
    const siteUrl = originSiteData?.url || `Site ID ${id}`;

    // Build absolute mutation payload dynamically bridging optional front-end updates
    const updatePayload: Record<string, unknown> = {};
    const gpProps = [
      'php_version',
      'max_execution_time', 'max_file_uploads', 'max_input_time', 
      'max_input_vars', 'memory_limit', 'post_max_size', 'upload_max_filesize',
      'pm', 'pm_max_children', 'pm_start_servers', 'pm_max_requests', 'pm_process_idle_timeout'
    ];

    // Refuse what cannot reach the server. GridPane answers 422 to every slow
    // log payload (docs/api-php-slowlog.md), and is_ssl / waf were never sent
    // to GridPane at all. Saving them here would change this app's copy only
    // and report a success that did not happen. docs/parked-features.md says
    // how to bring slow log control back if the API ever accepts it.
    const notWritable = ['is_php_slowlog', 'php_slowlog_timeout', 'php_slowlog_trace_depth', 'is_ssl', 'waf']
      .filter(k => body[k] !== undefined);
    if (notWritable.length > 0) {
      return screenPatchstackResponse((NextResponse.json(
        { error: `GridPane's API does not accept changes to ${notWritable.join(", ")}. Set it in GridPane.` },
        { status: 400 }
      )), request, psProtection);
    }

    if (body.site_nickname !== undefined) updatePayload.site_nickname = body.site_nickname;
    if (body.cloudflare_dns_name !== undefined) updatePayload.cloudflare_dns_name = body.cloudflare_dns_name;
    if (body.php_version !== undefined) updatePayload.php_version = body.php_version;

    // Isolate PHP variables explicitly for Supabase
    gpProps.forEach(prop => {
      if (body[prop] !== undefined) updatePayload[prop] = body[prop];
    });

    // Send Bidirectional Two-Way Sync Payload firmly into GridPane API physically
    const gridpanePayload: Record<string, unknown> = {};
    gpProps.forEach(prop => {
      if (body[prop] !== undefined) gridpanePayload[prop] = body[prop];
    });

    if (Object.keys(gridpanePayload).length > 0) {
      if (!process.env.GRIDPANE_API_TOKEN) {
        throw new Error("Missing GRIDPANE_API_TOKEN to perform two-way sync.");
      }

      const externalPayload = { ...gridpanePayload };

      if (Object.keys(externalPayload).length > 0) {
        // CRITICAL: GridPane's Edge WAF gateway triggers a generic '429 Beep Beep' rate limit blockage 
        // if the JSON payload contains ANY raw integers. It requires stringified numbers for all properties.
        // Additionally, we do NOT perform a GET/Merge loop, as GridPane API successfully performs partial updates,
        // and merging the full state back forces unsupported `php_slowlog` arrays to trigger the WAF.
        const safePayload: Record<string, unknown> = { ...externalPayload };
        
        // GridPane strongly enforces pairing the core `pm` setting when updating any FPM metric dynamically
        // Failing to provide `pm` causes the internal validator to crash and throw a 429
        if (Object.keys(safePayload).some(k => k.startsWith('pm_'))) {
             safePayload.pm = safePayload.pm || originSiteData?.pm || 'dynamic';
        }
        
        Object.keys(safePayload).forEach(key => {
          if (typeof safePayload[key] === 'number') {
             safePayload[key] = String(safePayload[key]);
          }
        });

        // 1. Dispatch safe non-destructive update
        const gpResponse = await fetchWithRetry(`https://my.gridpane.com/oauth/api/v1/site/${id}`, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${process.env.GRIDPANE_API_TOKEN}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify(safePayload)
        });
        if (!gpResponse.ok) {
          const errorText = await gpResponse.text();
          console.warn(`GridPane Sync Failed: ${gpResponse.status} - ${errorText}`);

          const changedKeys = Object.keys(gridpanePayload);
          let errorPrefix = "[Configuration Failed]";
          if (changedKeys.includes("php_version")) errorPrefix = "[PHP Version Update Failed]";
          else if (changedKeys.some(k => k.startsWith("pm"))) errorPrefix = "[PHP FPM Update Failed]";
          else if (changedKeys.length > 0) errorPrefix = "[PHP INI Update Failed]";

          if (gpResponse.status === 429) {
            return screenPatchstackResponse((NextResponse.json(
              { error: `GridPane Cooldown Active: Please wait ~60s before modifying server configuration again. Your setting has been reverted.` },
              { status: 502 }
            )), request, psProtection);
          }

          await supabase.from("system_logs").insert({
            level: "error",
            message: `${errorPrefix} GridPane synchronization rejected: Failed to compile Edge overrides (PHP/FPM mappings) on ${siteUrl}. Provider returned ${gpResponse.status} ${gpResponse.statusText}.`,
            site_url: siteUrl
          });

          return screenPatchstackResponse((NextResponse.json(
            { error: `GridPane Edge Sync Failed: ${gpResponse.status} ${gpResponse.statusText}. Site cache frozen.` },
            { status: 502 }
          )), request, psProtection);
        }
      }
    }

    const { data, error } = await supabase
      .from("sites")
      .update(updatePayload)
      .eq("id", parseInt(id))
      .select();

    if (error) {
      return screenPatchstackResponse((NextResponse.json({ error: error.message }, { status: 500 })), request, psProtection);
    }

    // Success Audit Trail bridging successful edge modifications dynamically rendering pre/post diff metrics
    if (Object.keys(gridpanePayload).length > 0) {
       const diffLogs: string[] = [];
       const changedKeys = Object.keys(gridpanePayload);
       
       let prefix = "[Edge Override Deployed]";
       if (changedKeys.includes("php_version")) prefix = "[PHP Version Changed]";
       else if (changedKeys.some(k => k.startsWith("pm"))) prefix = "[PHP FPM Updated]";
       else if (changedKeys.length > 0) prefix = "[PHP INI Updated]";

       changedKeys.forEach(key => {
         const oldVal = originSiteData ? originSiteData[key] : "null";
         const newVal = gridpanePayload[key];
         diffLogs.push(`${key}: ${oldVal} → ${newVal}`);
       });
       
       await supabase.from("system_logs").insert({
         level: "success",
         message: `${prefix} Successfully generated infrastructure overrides on ${siteUrl}.\n\nModifications Applied:\n${diffLogs.join("\n")}`,
         site_url: siteUrl
       });
    }

    return screenPatchstackResponse((NextResponse.json({ data })), request, psProtection);
  } catch (error) {
    return screenPatchstackResponse((NextResponse.json({ error: (error as { message?: string }).message || "Internal server error" }, { status: 500 })), request, psProtection);
  }
}
