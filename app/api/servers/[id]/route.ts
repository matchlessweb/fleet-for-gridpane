
import { getPatchstackProtection, screenPatchstackResponse } from "../../../../patchstack.next";
import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { refuseUnlessStrong } from "@/lib/api-guard";

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

    const { data, error } = await supabase
      .from("servers")
      .update({ cpu: body.cpu, ram: body.ram })
      .eq("id", parseInt(id))
      .select();

    if (error) {
      return screenPatchstackResponse((NextResponse.json({ error: error.message }, { status: 500 })), request, psProtection);
    }

    return screenPatchstackResponse((NextResponse.json({ data })), request, psProtection);
  } catch (error) {
    return screenPatchstackResponse((NextResponse.json({ error: (error as { message?: string }).message || "Internal server error" }, { status: 500 })), request, psProtection);
  }
}
