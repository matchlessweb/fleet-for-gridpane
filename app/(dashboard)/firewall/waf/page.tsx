"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { PageHeader } from "@/components/ui";
import { FleetWaf } from "@/components/security/waf-status";
import { FirewallTabs } from "@/components/security/firewall-tabs";

/**
 * Every site's server firewall in one list: GridPane's 7G settings, the 8G
 * firewall where it is installed, and what each did in the last 24 hours.
 * The data is each server's own report (see supabase/migrations/20261120000000_baseline.sql).
 */
export default function FleetWafPage() {
  const supabase = useMemo(() => createClient(), []);
  const [serverLabels, setServerLabels] = useState<Record<number, string>>({});
  const [siteIdsByServer, setSiteIdsByServer] = useState<Record<number, Record<string, number>>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [servers, sites] = await Promise.all([
        supabase.from("servers").select("id,label"),
        supabase.from("sites").select("id,url,server_id"),
      ]);
      if (cancelled) return;
      setServerLabels(Object.fromEntries((servers.data ?? []).map((s) => [s.id, s.label ?? `Server ${s.id}`])));
      // By server, then hostname: a moved site is on two servers until its old
      // copy is deleted in GridPane, and each server's row must link to its own.
      const byServer: Record<number, Record<string, number>> = {};
      for (const s of sites.data ?? []) {
        if (s.server_id == null) continue;
        (byServer[s.server_id] ??= {})[String(s.url).toLowerCase()] = s.id;
      }
      setSiteIdsByServer(byServer);
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-col gap-4">
        <PageHeader title="7G and 8G" />
        <FirewallTabs />
      </div>
      <p className="text-pretty max-w-[68ch] text-[12.5px] leading-relaxed text-muted-foreground">
        The firewall on each server, per site, as the server itself reports it. 7G is GridPane&apos;s firewall. 8G in
        observer mode checks the same requests and logs what it would block, without blocking&nbsp;anything.
      </p>
      <FleetWaf serverLabels={serverLabels} siteIdsByServer={siteIdsByServer} />
    </div>
  );
}
