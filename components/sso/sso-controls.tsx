"use client";

import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Button, PanelHeader, StatusPill } from "@/components/ui";
import { refreshSsoState, ssoSiteKey, useSsoState } from "@/lib/sso/use-sso";

/**
 * The two places one-click WordPress sign-in is turned on: a row on a site's
 * page, and the master switch under Settings. Both show nothing to someone who
 * is not on the sign-in list.
 */

async function post(path: string, body: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(path, { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j: { ok?: boolean; message?: string } = await res.json().catch(() => ({}));
    return { ok: res.ok && j.ok === true, message: j.message || "Fleet did not accept the change." };
  } catch {
    return { ok: false, message: "Fleet could not be reached. Check your connection and try again." };
  }
}

/** A row for the site page's Environment list. */
export function SsoSiteRow({ serverId, host }: { serverId: number | null | undefined; host: string }) {
  const state = useSsoState();
  const [saving, setSaving] = useState(false);
  if (!state.loaded || !state.mine || typeof serverId !== "number") return null;
  const on = state.sites.has(ssoSiteKey(serverId, host));

  const change = async () => {
    setSaving(true);
    const r = await post("/api/sso/policy", { serverId, hostname: host, enabled: !on });
    if (r.ok) {
      await refreshSsoState();
      toast.success(on ? `One-click sign-in is off for ${host}.` : `One-click sign-in is on for ${host}.`);
    } else {
      toast.error("Not changed", { description: r.message });
    }
    setSaving(false);
  };

  return (
    <div data-sso-row className="border-b border-border py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span className="eyebrow text-faint">One-click sign-in</span>
        <span className="flex items-center gap-2.5">
          <StatusPill tone={on && state.enabled ? "ok" : "neutral"}>{on ? (state.enabled ? "On" : "On, paused") : "Off"}</StatusPill>
          <Button size="sm" onClick={() => void change()} disabled={saving}>
            {on ? "Turn off" : "Turn on"}
          </Button>
        </span>
      </div>
      {!state.enabled && (
        <p className="mt-1.5 text-[12px] leading-relaxed text-pretty text-muted-foreground">
          One-click sign-in is switched off for all sites.{" "}
          <Link href="/settings/security" className="underline underline-offset-2 hover:text-foreground">
            Open Security{" "}settings
          </Link>
        </p>
      )}
    </div>
  );
}

/** The master switch, for Settings → Security. */
export function SsoSwitchPanel() {
  const state = useSsoState();
  const [saving, setSaving] = useState(false);
  if (!state.loaded || !state.mine) return null;

  const change = async () => {
    setSaving(true);
    const r = await post("/api/sso/switch", { enabled: !state.enabled });
    if (r.ok) {
      await refreshSsoState();
      toast.success(state.enabled ? "One-click sign-in is off. Every WordPress button is a plain link again." : "One-click sign-in is on for the sites you have turned it on for.");
    } else {
      toast.error("Not changed", { description: r.message });
    }
    setSaving(false);
  };

  const count = state.sites.size;
  return (
    <section data-sso-switch>
      <PanelHeader title="One-click WordPress sign-in" meta={state.enabled ? "on" : "off"} />
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-border py-4">
        <div className="min-w-0 flex-1 basis-64">
          <p className="text-[13px] leading-relaxed text-pretty text-foreground">
            A site&rsquo;s WordPress button signs you in to wp-admin without the login{" "}form.
          </p>
          <p className="mt-1 text-[12px] leading-relaxed text-pretty text-muted-foreground">
            {count === 0
              ? "No site has it turned on yet. Turn it on from a site’s own page."
              : `Turned on for ${count} ${count === 1 ? "site" : "sites"}. Each site is turned on from its own page.`}
          </p>
        </div>
        <span className="flex items-center gap-2.5">
          <StatusPill tone={state.enabled ? "ok" : "neutral"}>{state.enabled ? "On" : "Off"}</StatusPill>
          <Button size="sm" onClick={() => void change()} disabled={saving}>
            {state.enabled ? "Switch off" : "Switch on"}
          </Button>
        </span>
      </div>
    </section>
  );
}
