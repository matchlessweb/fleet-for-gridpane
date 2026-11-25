"use client";

import { Check, Fingerprint, Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { isHostname } from "@/lib/sso/crypto";
import { takeSsoClick } from "@/lib/sso/use-sso";
import { Button, Callout, Panel, buttonClasses } from "@/components/ui";

/**
 * One-click WordPress sign-in: the tab a W button opens.
 *
 * It asks Fleet for a sign-in, waits while the site's server makes the link,
 * then sends this tab straight to it. The link is never shown, copied or put
 * anywhere another program can read it first: a sign-in link works once, and
 * anything that previews it uses it up.
 *
 * The page's address names a server and a hostname, and anyone can type one.
 * So it offers a button or a link only for a site Fleet has on record, or when
 * one of Fleet's own buttons opened it: a made-up address gets no "login" link
 * to somewhere else with Fleet's name over it.
 */

type Phase =
  | { name: "idle" }
  | { name: "asking" }
  | { name: "waiting"; step: "asked" | "collected" }
  | { name: "opening" }
  | { name: "confirm"; message: string }
  | { name: "signedOut" }
  | { name: "failed"; message: string };

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

function SsoOpen() {
  const params = useSearchParams();
  const router = useRouter();
  const serverRaw = params.get("server") ?? "";
  const host = params.get("host") ?? "";
  const server = /^[1-9][0-9]{0,11}$/.test(serverRaw) ? Number(serverRaw) : null;
  const valid = server !== null && isHostname(host);

  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const [slow, setSlow] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // null while Fleet looks the site up; true once it is on record, or a Fleet button opened this tab.
  const [trusted, setTrusted] = useState<boolean | null>(null);
  const run = useRef(0);

  const start = useCallback(async (fromButton = false) => {
    if (!valid) return;
    if (fromButton) setTrusted(true);
    const mine = ++run.current;
    const live = () => run.current === mine;
    const fail = (message: string) => live() && setPhase({ name: "failed", message });
    setSlow(false);
    setPhase({ name: "asking" });

    let res: Response;
    try {
      res = await fetch("/api/sso/requests", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId: server, hostname: host }),
      });
    } catch {
      return fail("Fleet could not be reached. Check your connection and try again.");
    }
    const asked: { state?: string; id?: string; lifeSeconds?: number; message?: string; stepUp?: boolean } = await res.json().catch(() => ({}));
    if (!live()) return;
    if (res.status === 401) return setPhase({ name: "signedOut" });
    if (asked.stepUp) return setPhase({ name: "confirm", message: asked.message || "Confirm with your passkey or code to continue." });
    if (asked.state !== "waiting" || typeof asked.id !== "string") return fail(asked.message || "Fleet refused the sign-in.");

    setPhase({ name: "waiting", step: "asked" });
    const began = Date.now();
    const deadline = began + ((asked.lifeSeconds ?? 60) + 15) * 1000;
    while (live() && Date.now() < deadline) {
      await pause(700);
      if (!live()) return;
      if (Date.now() - began > 6000) setSlow(true);
      let got: { state?: string; step?: string; url?: string; message?: string };
      try {
        const r = await fetch(`/api/sso/requests/${asked.id}`, { method: "POST", cache: "no-store" });
        got = await r.json().catch(() => ({}));
      } catch {
        continue; // one dropped check is not a failure; the deadline still applies
      }
      if (!live()) return;
      if (got.state === "waiting") {
        setPhase({ name: "waiting", step: got.step === "collected" ? "collected" : "asked" });
        continue;
      }
      if (got.state === "ready" && typeof got.url === "string") {
        setPhase({ name: "opening" });
        // replace(), so Back does not return to a page that would ask again.
        window.location.replace(got.url);
        return;
      }
      return fail(got.message || "The sign-in did not complete.");
    }
    fail("The server did not answer in time.");
  }, [valid, server, host]);

  // Start alone only when a Fleet button was clicked seconds ago.
  useEffect(() => {
    // The click was made in the tab that opened this one, and it can only be collected here, in
    // the browser, once. The run is the answer to that click, so it starts in this effect and its
    // first state changes happen here on purpose. Moving it to a timer would let a run begin after
    // the clean-up below had already stopped it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (valid && takeSsoClick(server!, host)) void start(true);
    return () => {
      // Deliberately the live counter: bumping it is what stops a run in flight.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      run.current++;
    };
  }, [valid, server, host, start]);

  // Is this a site Fleet has on that server? A staging copy is filed under its live site's name.
  useEffect(() => {
    if (!valid) return;
    let live = true;
    const names = host.startsWith("staging.") ? [host, host.slice("staging.".length)] : [host];
    void createClient()
      .from("sites")
      .select("url")
      .eq("server_id", server!)
      .in("url", names)
      .limit(2)
      .then(({ data, error }) => {
        if (live) setTrusted((t) => t === true || (!error && (data?.length ?? 0) > 0));
      });
    return () => {
      live = false;
    };
  }, [valid, server, host]);

  const confirmWithPasskey = async () => {
    setConfirming(true);
    try {
      const { data, error } = await createClient().auth.signInWithPasskey();
      if (error || !data?.session) throw error ?? new Error("no session");
      await start();
    } catch {
      setPhase({ name: "confirm", message: "That did not go through. Try your passkey again, or sign out and sign in again." });
    } finally {
      setConfirming(false);
    }
  };

  const signOut = async () => {
    await createClient().auth.signOut().catch(() => null);
    router.replace("/login");
  };

  if (!valid) {
    return (
      <Panel className="p-7 sm:p-9">
        <p className="eyebrow text-faint">One-click sign-in</p>
        <h1 className="mt-2 text-[20px] font-extrabold tracking-[-0.02em] text-balance text-foreground">This link is incomplete</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-pretty text-muted-foreground">
          Open a site in Fleet and use its WordPress{" "}button.
        </p>
        <Link href="/sites" className={cn(buttonClasses({ variant: "solid" }), "touch-hit mt-6 w-full py-2.5")}>
          Go to Sites
        </Link>
      </Panel>
    );
  }

  if (trusted === false) {
    return (
      <Panel className="p-7 sm:p-9">
        <p className="eyebrow text-faint">One-click sign-in</p>
        <h1 className="mt-2 text-[20px] font-extrabold tracking-[-0.02em] text-balance text-foreground">Fleet does not have this{"\u00a0"}site</h1>
        <p data-sso-host className="mt-1.5 font-mono text-[12.5px] break-all text-muted-foreground">{host}</p>
        <p className="mt-4 text-[13px] leading-relaxed text-pretty text-muted-foreground">
          No site by that name is on that server. Open the site in Fleet and use its WordPress{" "}button.
        </p>
        <Link href="/sites" className={cn(buttonClasses({ variant: "solid" }), "touch-hit mt-6 w-full py-2.5")}>
          Go to Sites
        </Link>
      </Panel>
    );
  }

  const plain = `https://${host}/wp-admin/`;
  const busy = phase.name === "asking" || phase.name === "waiting" || phase.name === "opening";
  const reached = phase.name === "asking" ? 0 : phase.name === "waiting" ? (phase.step === "collected" ? 1 : 0) : phase.name === "opening" ? 2 : -1;
  const steps = ["Asking the server", "The server is making the link", "Opening WordPress"];

  return (
    <Panel className="p-7 sm:p-9">
      <p className="eyebrow text-faint">One-click sign-in</p>
      <h1 className="mt-2 text-[20px] font-extrabold tracking-[-0.02em] text-balance text-foreground">
        {busy ? "Signing you in" : "Sign in to WordPress"}
      </h1>
      <p data-sso-host className="mt-1.5 font-mono text-[12.5px] break-all text-muted-foreground">{host}</p>

      {busy && (
        <ol className="mt-6 flex flex-col gap-2.5" aria-live="polite">
          {steps.map((label, i) => (
            <li key={label} data-step={i < reached ? "done" : i === reached ? "now" : "next"} className={cn("flex items-center gap-2.5 text-[13px]", i > reached ? "text-faint" : "text-foreground")}>
              <span className="flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">
                {i < reached ? (
                  <Check size={14} strokeWidth={2} className="text-primary" />
                ) : i === reached ? (
                  <Loader2 size={14} strokeWidth={1.75} className="animate-spin text-muted-foreground" />
                ) : (
                  <span className="h-1.5 w-1.5 rounded-full bg-line-strong" />
                )}
              </span>
              <span>{label}</span>
            </li>
          ))}
        </ol>
      )}
      {busy && slow && (
        <p className="mt-4 text-[12px] leading-relaxed text-pretty text-muted-foreground">
          The first sign-in after a quiet spell can take up to 15{" "}seconds.
        </p>
      )}

      {phase.name === "idle" && trusted === null && (
        <p className="mt-4 text-[13px] leading-relaxed text-muted-foreground" aria-live="polite">
          Looking the site{" "}up…
        </p>
      )}

      {phase.name === "idle" && trusted && (
        <>
          <p className="mt-4 text-[13px] leading-relaxed text-pretty text-muted-foreground">
            Fleet will ask this site&rsquo;s server for a sign-in link and open it in this{" "}tab.
          </p>
          <Button variant="solid" onClick={() => void start()} className="touch-hit mt-6 w-full py-2.5">
            Sign in to WordPress
          </Button>
        </>
      )}

      {phase.name === "confirm" && (
        <>
          <Callout tone="warning" title="Confirm it is you" live className="mt-6">
            {phase.message}
          </Callout>
          <Button variant="solid" onClick={() => void confirmWithPasskey()} disabled={confirming} className="touch-hit mt-4 w-full py-2.5">
            {confirming ? <Loader2 className="animate-spin" size={14} strokeWidth={1.75} /> : <Fingerprint size={14} strokeWidth={1.75} />} Confirm with passkey
          </Button>
          <Button onClick={() => void signOut()} disabled={confirming} className="touch-hit mt-2.5 w-full py-2.5">
            Sign out and sign in again
          </Button>
        </>
      )}

      {phase.name === "signedOut" && (
        <>
          <Callout tone="warning" title="You are signed out of Fleet" live className="mt-6">
            Sign in to Fleet, then use the site&rsquo;s WordPress button again.
          </Callout>
          <Link href="/login" className={cn(buttonClasses({ variant: "solid" }), "touch-hit mt-4 w-full py-2.5")}>
            Sign in to Fleet
          </Link>
        </>
      )}

      {phase.name === "failed" && (
        <>
          <Callout tone="danger" title="No sign-in this time" live="assertive" className="mt-6">
            {phase.message}
          </Callout>
          <Button variant="solid" onClick={() => void start()} className="touch-hit mt-4 w-full py-2.5">
            Try again
          </Button>
        </>
      )}

      {!busy && phase.name !== "signedOut" && trusted && (
        <a href={plain} rel="noopener noreferrer" className={cn(buttonClasses(), "touch-hit mt-2.5 w-full py-2.5")}>
          Open the normal login page
        </a>
      )}
    </Panel>
  );
}

export default function SsoOpenPage() {
  // useSearchParams needs a boundary; nothing shows until the address is read.
  return (
    <Suspense fallback={null}>
      <SsoOpen />
    </Suspense>
  );
}
