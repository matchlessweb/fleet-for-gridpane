"use client";

import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { Panel, PanelHeader } from "@/components/ui";
import { formatRunDate, formatRunTime, staleness, tie } from "@/lib/cloudflare-waf";
import { useLatestWafRun } from "@/components/cloudflare/run-stamp";

/**
 * Settings panel: where the Cloudflare token lives, and why it is not here.
 *
 * The sibling of the GridPane panel above it, with the opposite answer. The
 * GridPane token is a Workers secret because the app calls GridPane. The app
 * never calls Cloudflare: a daily job on the operator's machine runs the WAF inventory and
 * loads the result (scripts/waf-refresh.sh), so the token that can read every
 * account stays on that machine and nowhere else. The three places listed in
 * the panel are the ones scripts/lib-fleet-token.sh looks in, in that order.
 */
export function CloudflareTokenPanel() {
  const state = useLatestWafRun();

  let last: string;
  if (state.status === "ready") {
    const at = state.run.generated_at;
    last = tie(`Last checked ${formatRunDate(at)} at ${formatRunTime(at)}, ${staleness(at).age}.`);
  } else if (state.status === "loading") {
    last = "Reading the last check.";
  } else if (state.status === "empty") {
    last = tie("No inventory has been loaded yet.");
  } else {
    last = tie("The last check could not be read.");
  }

  return (
    <section className="flex flex-col gap-4" data-cloudflare-token-panel>
      <PanelHeader title="Cloudflare WAF inventory" meta="READ-ONLY TOKEN" />
      <Panel className="p-5">
        <div className="flex max-w-2xl flex-col gap-3">
          <div className="flex items-start gap-2">
            <ShieldCheck size={14} strokeWidth={1.75} className="mt-0.5 shrink-0 text-primary" />
            <p className="text-[13px] leading-relaxed text-pretty">
              {tie(
                "The Cloudflare token is kept on the operator's own machine. It is not in this app, its database or its hosting, so it cannot be shown or changed from this page."
              )}
            </p>
          </div>
          <p className="text-[12px] leading-relaxed text-pretty text-muted-foreground">
            {tie(
              "Once a day a job on that Mac reads every zone's rules and loads them here. The token can read; it cannot change a rule. To replace it, change the first of these that is set:"
            )}
          </p>
          <div className="rounded-lg bg-sunken p-4 font-mono">
            <div className="overflow-x-auto">
              <p className="whitespace-pre text-[11.5px] leading-relaxed text-on-sunken">
                {"FLEET_CF_TOKEN_ALL_READ (a variable)\nthen, in ~/.config/fleet:\n  cloudflare-token-command\n  tokens/cloudflare-all-read.token"}
              </p>
            </div>
          </div>
          <p className="text-[12px] leading-relaxed text-pretty text-muted-foreground">
            {tie(
              "While that Mac is off nothing refreshes, and the date on every Cloudflare WAF view gets older until it runs again."
            )}
          </p>
          <p className="text-[12px] leading-relaxed text-pretty" data-cloudflare-last-check>
            {last}
          </p>
          <Link
            href="/firewall/cloudflare"
            className="self-start text-[12px] text-foreground underline decoration-primary decoration-[1.5px] underline-offset-[3px] hover:decoration-2"
          >
            {"Open Cloudflare WAF"}
          </Link>
        </div>
      </Panel>
    </section>
  );
}
