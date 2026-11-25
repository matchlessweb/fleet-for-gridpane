"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { tie } from "@/lib/utils";
import { CodeBlock, Led, PanelHeader, StatusPill } from "@/components/ui";
import { useServerCount } from "@/components/setup/sync-section";

/** /api/setup/state: yes or no for each optional part, never a value. */
export type SetupState = {
  access: { configured: boolean; thisVisit: boolean };
  sso: { schema: boolean | null; keys: boolean; allowList: boolean; onList: boolean; userId: string | null };
  patchstack: { rules: "patchstack" | "bundled"; mode: "block" | "dry-run" };
};

export function useSetupState(): { state: SetupState | null; error: string | null } {
  const [state, setState] = useState<SetupState | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/api/setup/state", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as SetupState;
      })
      .then((s) => { if (live) setState(s); })
      .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, []);
  return { state, error };
}

type Mark = "ok" | "missing" | "unknown";

/** One requirement: a dot, what it is, and what to do when it is missing. */
function Requirement({ mark, title, children }: { mark: Mark; title: string; children?: React.ReactNode }) {
  return (
    <li className="flex gap-3 border-b border-border py-3 last:border-b-0">
      <span className="flex h-[1.5em] w-[6px] shrink-0 items-center text-[13px]">
        {mark === "ok" ? <Led tone="ok" /> : mark === "missing" ? <Led tone="warn" /> : <span aria-hidden="true" className="inline-block h-[6px] w-[6px] rounded-full border border-line-strong" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-foreground">
          {tie(title)}
          <span className="sr-only">{mark === "ok" ? " (done)" : mark === "missing" ? " (not done)" : " (cannot be checked from here)"}</span>
        </p>
        {children != null && <div className="mt-1 flex flex-col gap-2 text-[12px] leading-relaxed text-pretty text-muted-foreground">{children}</div>}
      </div>
    </li>
  );
}

function Section({ title, done, meta, intro, pill, children, ...rest }: { title: string; done: boolean | null; meta?: string; intro: string; pill?: React.ReactNode; children: React.ReactNode } & React.HTMLAttributes<HTMLElement>) {
  return (
    <section {...rest}>
      <PanelHeader title={title} meta={meta}>
        {pill ?? (done !== null && <StatusPill tone={done ? "ok" : "neutral"}>{done ? "Set up" : "Not set up"}</StatusPill>)}
      </PanelHeader>
      <p className="max-w-[65ch] pt-3 text-[12.5px] leading-relaxed text-pretty text-muted-foreground">{tie(intro)}</p>
      <ul className="mt-1">{children}</ul>
    </section>
  );
}

const mark = (v: boolean | null | undefined): Mark => (v === true ? "ok" : v === false ? "missing" : "unknown");

/** The telemetry agents: how many servers have reported in the last hour. */
export function AgentsSection() {
  const servers = useServerCount();
  const [reporting, setReporting] = useState<number | null>(null);
  useEffect(() => {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    createClient()
      .from("server_telemetry")
      .select("server_id")
      .gte("timestamp", since)
      .limit(1000)
      .then(({ data }) => setReporting(new Set((data ?? []).map((r) => r.server_id)).size));
  }, []);
  const known = servers !== null && reporting !== null;
  const all = known && servers > 0 && reporting >= servers;
  return (
    <Section
      data-setup-agents
      title="Server agents"
      done={known ? servers > 0 && reporting > 0 : null}
      // "Set up" at 1 of 19 read as finished; some but not all is its own state.
      pill={known && reporting > 0 && !all ? <StatusPill tone="warn">Partly set up</StatusPill> : undefined}
      meta={known && servers > 0 ? `${reporting} of ${servers} reporting` : undefined}
      intro="A small script on each server reports its load, memory, disk, firewall and PHP code cache every 10 minutes. Without it the Monitoring page and those panels stay empty; everything from GridPane still works."
    >
      <Requirement mark={!known ? "unknown" : servers === 0 ? "missing" : "ok"} title="Servers synced from GridPane">
        {known && servers === 0 && <p>Run the first sync above first.</p>}
      </Requirement>
      <Requirement mark={!known ? "unknown" : all ? "ok" : "missing"} title={known && servers > 0 ? `Agents reporting: ${reporting} of ${servers} servers in the last hour` : "Agents reporting"}>
        {known && !all && (
          <>
            <p>{tie("Each server needs the agent first, then its own token. The order matters: SETUP.md, step 8, proves it on one server first. These two only look, and change nothing:")}</p>
            <CodeBlock kind="command" label="Look at each server's agent" code={"bash scripts/fix-telemetry-crontabs.sh\nbash scripts/provision-agent-tokens.sh"} />
          </>
        )}
      </Requirement>
    </Section>
  );
}

/** Cloudflare Access in front of the app: every account's second gate on the internet. */
export function AccessSection({ state }: { state: SetupState | null }) {
  return (
    <Section
      data-setup-access
      title="Cloudflare Access"
      done={state ? state.access.configured : null}
      intro="Before the app is on the internet, Cloudflare Access sits in front of it, so a stranger never reaches the sign-in page. Not needed for a trial on your own machine."
    >
      <Requirement mark={mark(state?.access.configured)} title="The app knows your Access team and application">
        {state && !state.access.configured && <p>{tie("CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD are not set on the app. SETUP.md, step 10, makes the Access application and sets both.")}</p>}
      </Requirement>
      <Requirement mark={!state ? "unknown" : state.access.thisVisit ? "ok" : "missing"} title="This visit came through Access">
        {state && !state.access.thisVisit && <p>{tie(state.access.configured ? "This request carried no Access token: open the app at its own address, not a preview address Cloudflare made for it." : "Expected on your own machine. Once deployed behind Access, this turns on by itself.")}</p>}
      </Requirement>
    </Section>
  );
}

/**
 * One-click WordPress sign-in, not set up: what it needs, in order. Its switch
 * stays behind its own gate (Settings > Security shows it only to an account
 * on the allow-list that came through Access with a passkey or a code).
 */
export function SsoSetupSection({ state, error }: { state: SetupState | null; error?: string | null }) {
  const s = state?.sso;
  const done = s ? !!(state?.access.configured && s.schema && s.keys && s.onList) : null;
  const keysLine = s?.userId ? `bash scripts/sso-make-keys.sh                     # look only\nbash scripts/sso-make-keys.sh --apply --user-ids ${s.userId}` : null;
  return (
    <Section
      data-sso-setup
      title="One-click WordPress sign-in"
      done={done}
      intro="A site's WordPress button signs you in to its WordPress admin without the login form. It is off until every part below is in place, and its switch shows only to an account allowed to use it."
    >
      {error && <li className="py-3 text-[12px] text-muted-foreground">{tie(`What is set up could not be read (${error}). Reload to try again.`)}</li>}
      <Requirement mark={mark(state?.access.configured)} title="Cloudflare Access in front of the app">
        {state && !state.access.configured && <p>SETUP.md, step 10. Every one-click route refuses a request without a valid Access token.</p>}
      </Requirement>
      <Requirement mark={mark(s?.schema)} title="Its database part, sso_schema.sql">
        {s && s.schema !== true && (
          <>
            <p>{tie("A person applies it, not an agent: it is tried first, then applied. SETUP.md, step 11c.")}</p>
            <CodeBlock kind="command" label="Apply the database part" code={"bash scripts/apply-sql.sh sso_schema.sql --dry-run\nbash scripts/apply-sql.sh sso_schema.sql"} />
          </>
        )}
      </Requirement>
      <Requirement mark={mark(s?.keys)} title="Its signing keys, on the app">
        {s && !s.keys && <p>{tie("Made and set by sso-make-keys.sh, the same command that allows your account (next line).")}</p>}
      </Requirement>
      <Requirement mark={!s ? "unknown" : s.onList ? "ok" : "missing"} title="Your account on its allow-list">
        {s && !s.onList && (
          <>
            <p>{tie(s.allowList ? "The allow-list is set, and your account is not on it." : "No account is on the allow-list yet.")} The line below has your own account id in it.</p>
            {keysLine && <CodeBlock kind="command" label="Make keys and allow-list" code={keysLine} />}
          </>
        )}
      </Requirement>
      <Requirement mark="unknown" title="The small service on each server">
        <p>{tie("Not something the app can see. This audits every server and changes nothing. To install, run it again with --apply and the label of the one server you choose, as SETUP.md, step 11c, shows.")}</p>
        <CodeBlock kind="command" label="Audit every server" code="bash scripts/install-fleet-sso-agent.sh" />
      </Requirement>
      {done && (
        <li className="py-3 text-[12px] text-muted-foreground">
          Everything the app can see is in place. The switch is under <Link href="/settings/security" className="text-primary underline-offset-4 hover:underline">Settings, Security</Link>, once you sign in through Access with a passkey or a code.
        </li>
      )}
    </Section>
  );
}

/** The Cloudflare WAF board: filled by a job on your own machine, never by the app. */
export function WafSection() {
  const [runs, setRuns] = useState<number | null>(null);
  useEffect(() => {
    createClient()
      .from("cloudflare_waf_runs")
      .select("id", { count: "exact", head: true })
      .then(({ count }) => setRuns(count ?? 0));
  }, []);
  return (
    <Section
      data-setup-waf
      title="Cloudflare WAF board"
      done={runs === null ? null : runs > 0}
      intro="The firewall page's Cloudflare view. A job on your own machine reads Cloudflare once a day, with a token that can only read, and loads the result: the app never holds a Cloudflare token."
    >
      <Requirement mark={runs === null ? "unknown" : runs > 0 ? "ok" : "missing"} title={runs ? `Loaded ${runs} time${runs === 1 ? "" : "s"}` : "Loaded at least once"}>
        {runs === 0 && <p>{tie("SETUP.md, step 11a: the token, then npm run waf:refresh, then the daily job.")}</p>}
      </Requirement>
    </Section>
  );
}

/** Patchstack: the request screen in front of every route. On from the start, with starter rules. */
export function PatchstackSection({ state }: { state: SetupState | null }) {
  const p = state?.patchstack;
  return (
    <Section
      data-setup-patchstack
      title="Patchstack"
      done={p ? p.rules === "patchstack" : null}
      pill={p && p.rules !== "patchstack" ? <StatusPill tone="ok">Starter rules</StatusPill> : undefined}
      meta={p ? (p.mode === "block" ? "blocking" : "dry run: logs, blocks nothing") : undefined}
      intro="Screens each request before it reaches Fleet's routes. It runs from the start on the starter rules bundled with Fleet; with a Patchstack site, its rules come from Patchstack and stay current."
    >
      <Requirement mark={!p ? "unknown" : p.rules === "patchstack" ? "ok" : "missing"} title={p?.rules === "patchstack" ? "Rules from Patchstack" : "Rules from Patchstack (now: the bundled starter rules)"}>
        {p && p.rules !== "patchstack" && <p>SETUP.md, step 11e.</p>}
      </Requirement>
    </Section>
  );
}
