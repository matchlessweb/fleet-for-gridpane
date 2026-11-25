"use client";

import { useEffect, useState } from "react";
import { Loader2, GitBranch } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button, StatusPill } from "@/components/ui";

/**
 * Whether a site has a live staging environment — recorded here, not read from
 * GridPane.
 *
 * GridPane's OAuth API v1 cannot answer this. Compared on a site that
 * genuinely has staging and one whose staging was destroyed, every
 * staging-related field is identical. `/site?type=staging` returns no sites at
 * all while `type=primary` returns every site, `/oauth/api/v1/staging` is a
 * 404, and the per-site staging route answers 422 because it authenticates on
 * dashboard cookies rather than the OAuth token.
 *
 * `staging_site_built_at` only says staging was built once; GridPane never
 * clears it on destroy. Inferring "active" from it gives false positives, and
 * patching them with a hardcoded array of domains goes stale.
 *
 * So this is an operator ledger, in the same sense as ip_blocks, and it is
 * labelled as such wherever it is shown.
 */
export function StagingLedger({ siteId, siteUrl }: { siteId: number; siteUrl: string }) {
  const supabase = createClient();
  const [isActive, setIsActive] = useState<boolean | null>(null);
  const [notedAt, setNotedAt] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("site_staging_state")
        .select("is_active, noted_at")
        .eq("site_id", siteId)
        .maybeSingle();
      if (cancelled) return;
      setIsActive(data ? (data as { is_active: boolean }).is_active : null);
      setNotedAt(data ? (data as { noted_at: string }).noted_at : null);
      setIsLoading(false);
    })();
    return () => { cancelled = true; };
  }, [supabase, siteId]);

  const record = async (next: boolean) => {
    setIsSaving(true);
    const { error } = await supabase
      .from("site_staging_state")
      .upsert(
        { site_id: siteId, is_active: next, noted_at: new Date().toISOString() },
        { onConflict: "site_id" }
      );
    setIsSaving(false);

    if (error) {
      toast.error(`Could not record staging state: ${error.message}`);
      return;
    }
    setIsActive(next);
    setNotedAt(new Date().toISOString());
    toast.success(
      next
        ? `Recorded: staging.${siteUrl} is live.`
        : `Recorded: ${siteUrl} has no live staging.`
    );
    window.dispatchEvent(new Event("schedules_updated"));
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-[13px] text-faint">
        <Loader2 size={14} className="animate-spin" /> Reading staging ledger...
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <GitBranch size={15} strokeWidth={1.75} className="text-faint" />
        <span className="text-[13px] font-semibold">Staging environment</span>
        {isActive === null ? (
          <StatusPill tone="warn">Not recorded</StatusPill>
        ) : isActive ? (
          <StatusPill tone="ok">Live</StatusPill>
        ) : (
          <StatusPill tone="neutral">None</StatusPill>
        )}
      </div>

      <p className="text-[12.5px] leading-relaxed text-faint">
        Recorded here, not read from GridPane — its API exposes no staging
        environment, so this cannot be synced or verified automatically. Check
        GridPane&rsquo;s Staging page and record what you see.
        {notedAt && (
          <> Last recorded {new Date(notedAt).toLocaleDateString()}.</>
        )}
      </p>

      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => record(true)}
          disabled={isSaving || isActive === true}
          className="flex-1 sm:flex-none"
        >
          {isSaving ? <Loader2 size={14} className="animate-spin" /> : null} Staging is live
        </Button>
        <Button
          onClick={() => record(false)}
          disabled={isSaving || isActive === false}
          className="flex-1 sm:flex-none"
        >
          {isSaving ? <Loader2 size={14} className="animate-spin" /> : null} No staging
        </Button>
      </div>
    </div>
  );
}
