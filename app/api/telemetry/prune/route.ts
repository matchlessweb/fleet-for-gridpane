
import { getPatchstackProtection, screenPatchstackResponse } from "../../../../patchstack.next";
import { NextResponse, type NextRequest } from "next/server";
import { refuseUnlessStrong } from "@/lib/api-guard";
import { createClient } from "@supabase/supabase-js";

// Telemetry retention policy: 7 days (approved reconciliation of the old 12h window).
const RETENTION_DAYS = 7;
// Deletes run as bounded id-range chunks so we never issue one unbounded timestamp DELETE
// (the table may momentarily lack a timestamp index — PK-range probes are always cheap).
const CHUNK_SIZE = 10000;
const MAX_CHUNKS_PER_INVOCATION = 20;

// Concrete factory so the boundary helper shares the exact inferred client type.
function createAdminClient(supabaseUrl: string, serviceRoleKey: string) {
  return createClient(supabaseUrl, serviceRoleKey);
}
type AdminClient = ReturnType<typeof createAdminClient>;

// Binary search over the PK for the smallest id whose timestamp >= cutoff.
// Every probe is a single-row PK-range read, so this works with no timestamp index at all.
// Any over-estimate is harmless: chunk deletes carry a redundant timestamp filter.
async function findBoundaryByPkProbes(
  admin: AdminClient,
  oldestId: number,
  maxId: number,
  cutoffIso: string
): Promise<number> {
  const cutoffMs = Date.parse(cutoffIso);
  let lo = oldestId;
  let hi = maxId + 1; // boundary may be maxId + 1 when every row is older than the cutoff
  let iterations = 0;

  while (lo < hi && iterations < 80) {
    iterations++;
    const mid = lo + Math.floor((hi - lo) / 2);

    // First existing row at or after mid — id gaps are fine, the PK index resolves this in one row.
    const { data: probe, error } = await admin
      .from("server_telemetry")
      .select("id, timestamp")
      .gte("id", mid)
      .order("id", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (error) {
      // Conservative bail-out: delete only what we have already confirmed is older than the cutoff.
      return lo;
    }

    // Numeric comparison — PostgREST timestamp strings and toISOString() differ in suffix format.
    const probeMs = probe ? Date.parse(probe.timestamp as string) : NaN;
    if (!probe || Number.isNaN(probeMs) || probeMs >= cutoffMs) {
      hi = mid;
    } else {
      lo = (probe.id as number) + 1;
    }
  }

  return lo;
}

export async function GET(request: NextRequest) {
  // #region patchstack-next-route
  const psProtection = await getPatchstackProtection();
  const psBlocked = psProtection && await psProtection.fetchGuard()(request);
  if (psBlocked) return psBlocked;
  // #endregion

  try {
    // A strong session, asked for again here (the middleware asks first), and never a link on another site.
    const refused = await refuseUnlessStrong(request);
    if (refused) return screenPatchstackResponse((refused), request, psProtection);

    // --- Service role is MANDATORY: server_telemetry RLS grants anon no DELETE policy. ---
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceRoleKey) {
      return screenPatchstackResponse((NextResponse.json(
        {
          error:
            "SUPABASE_SERVICE_ROLE_KEY is not configured. Telemetry pruning requires the service role — anon has no DELETE policy on server_telemetry, so there is no fallback. Set the key in the environment and retry.",
        },
        { status: 500 }
      )), request, psProtection);
    }

    const admin = createAdminClient(supabaseUrl, serviceRoleKey);
    const cutoffIso = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

    // --- Locate the id range eligible for pruning (all single-row PK probes) ---
    const { data: oldestRow, error: oldestError } = await admin
      .from("server_telemetry")
      .select("id")
      .order("id", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (oldestError) {
      return screenPatchstackResponse((NextResponse.json({ error: "Failed to read oldest telemetry row", details: oldestError }, { status: 500 })), request, psProtection);
    }

    if (!oldestRow) {
      // Empty table — nothing to prune.
      return screenPatchstackResponse((NextResponse.json({ pruned: 0, chunks: 0, remaining: false })), request, psProtection);
    }

    const { data: newestRow, error: newestError } = await admin
      .from("server_telemetry")
      .select("id")
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (newestError || !newestRow) {
      return screenPatchstackResponse((NextResponse.json({ error: "Failed to read newest telemetry row", details: newestError }, { status: 500 })), request, psProtection);
    }

    const oldestId = oldestRow.id as number;
    const maxId = newestRow.id as number;

    // Preferred boundary lookup: first row at/after the cutoff (index-friendly once
    // the (timestamp) index lands). If it errors mid-migration, fall back to PK probes.
    let boundaryId: number;
    const { data: boundaryRow, error: boundaryError } = await admin
      .from("server_telemetry")
      .select("id")
      .gte("timestamp", cutoffIso)
      .order("timestamp", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (boundaryError) {
      boundaryId = await findBoundaryByPkProbes(admin, oldestId, maxId, cutoffIso);
    } else if (boundaryRow) {
      boundaryId = boundaryRow.id as number;
    } else {
      // Every row predates the cutoff — the whole id range is eligible.
      boundaryId = maxId + 1;
    }

    // --- Chunked deletion: bounded id windows, capped per invocation ---
    let pruned = 0;
    let chunks = 0;
    let lo = oldestId;

    while (lo < boundaryId && chunks < MAX_CHUNKS_PER_INVOCATION) {
      const hi = Math.min(lo + CHUNK_SIZE, boundaryId);

      const { error: deleteError, count } = await admin
        .from("server_telemetry")
        .delete({ count: "exact" })
        .gte("id", lo)
        .lt("id", hi)
        // Redundant safety filter: even a mis-estimated boundary can never delete fresh rows.
        .lt("timestamp", cutoffIso);

      if (deleteError) {
        console.error("Telemetry Prune Chunk Error:", deleteError);
        return screenPatchstackResponse((NextResponse.json(
          { error: "Pruning failed mid-run", details: deleteError, pruned, chunks },
          { status: 500 }
        )), request, psProtection);
      }

      pruned += count ?? 0;
      chunks++;
      lo = hi;
    }

    const remaining = lo < boundaryId;

    if (pruned > 0) {
      await admin.from("system_logs").insert({
        level: "success",
        message: `[Telemetry Prune] Purged ${pruned} telemetry rows older than ${RETENTION_DAYS} days across ${chunks} id-range chunks.${remaining ? " Backlog remains — the next invocation will continue from the current boundary." : ""}`,
        site_url: "Telemetry Retention",
      });
    }

    return screenPatchstackResponse((NextResponse.json({ pruned, chunks, remaining })), request, psProtection);
  } catch (error) {
    return screenPatchstackResponse((NextResponse.json({ error: "Prune Fault", details: (error as { message?: string }).message }, { status: 500 })), request, psProtection);
  }
}
