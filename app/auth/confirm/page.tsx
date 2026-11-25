"use client";

import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { looksLikeLinkToken } from "@/lib/account/email-change";
import { Button, Callout, Panel, buttonClasses } from "@/components/ui";

/**
 * Where the link in a "confirm your new email" message lands.
 *
 * Opening this page changes nothing. The address is confirmed only when the
 * signed-in person presses the button, which sends the link's token to Fleet
 * with a POST. A mail scanner or a link preview that fetches this address
 * gets a page and uses nothing up.
 */

type Phase =
  | { name: "loading" }
  | { name: "ready"; from: string; to: string }
  | { name: "nothing"; current: string }
  | { name: "working"; from: string; to: string }
  | { name: "changed"; email: string }
  | { name: "half"; message: string }
  | { name: "failed"; message: string; from: string; to: string; again: boolean };

const profileLink = (label: string, solid = true) => (
  <Link href="/settings/profile" className={cn(buttonClasses({ variant: solid ? "solid" : "ghost" }), "touch-hit mt-6 w-full py-2.5")}>
    {label}
  </Link>
);

function Confirm() {
  const params = useSearchParams();
  // Read once. The used link is later taken out of the address bar, and the page must not forget it was valid.
  const [{ token, type }] = useState(() => ({ token: params.get("token_hash") ?? "", type: params.get("type") ?? "" }));
  const valid = type === "email_change" && looksLikeLinkToken(token);
  const [phase, setPhase] = useState<Phase>({ name: "loading" });

  useEffect(() => {
    if (!valid) return;
    let live = true;
    void createClient()
      .auth.getUser()
      .then(({ data: { user } }) => {
        if (!live) return;
        const from = user?.email ?? "";
        const to = user?.new_email ?? "";
        setPhase(to ? { name: "ready", from, to } : { name: "nothing", current: from });
      });
    return () => {
      live = false;
    };
  }, [valid]);

  const confirm = async (from: string, to: string) => {
    setPhase({ name: "working", from, to });
    let reply: { state?: string; ok?: boolean; message?: string; email?: string; reason?: string } = {};
    try {
      const res = await fetch("/api/account/email/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
      reply = await res.json().catch(() => ({}));
    } catch {
      reply = { ok: false, message: "Fleet could not be reached. Nothing was changed; the link still works." };
    }
    if (reply.ok && reply.state === "changed") {
      // Drop the used link from the address bar, and pick up a session that carries the new address.
      window.history.replaceState(null, "", "/auth/confirm");
      await createClient().auth.refreshSession().catch(() => null);
      window.dispatchEvent(new Event("user_profile_updated"));
      setPhase({ name: "changed", email: reply.email || to });
      return;
    }
    if (reply.ok && reply.state === "half") {
      window.history.replaceState(null, "", "/auth/confirm");
      setPhase({ name: "half", message: reply.message || "This address is confirmed. One step is left: open the link Fleet sent to the other address." });
      return;
    }
    const again = reply.reason === "unreachable" || !reply.reason;
    setPhase({ name: "failed", message: reply.message || "The link could not be confirmed. Nothing was changed.", from, to, again });
  };

  const eyebrow = <p className="eyebrow text-faint">Sign-in email</p>;
  const heading = (text: React.ReactNode) => <h1 className="mt-2 text-[20px] font-extrabold tracking-[-0.02em] text-balance text-foreground">{text}</h1>;

  if (!valid) {
    return (
      <Panel className="p-7 sm:p-9" data-confirm="bad-link">
        {eyebrow}
        {heading(<>This link is{" "}incomplete</>)}
        <p className="mt-2 text-[13px] leading-relaxed text-pretty text-muted-foreground">
          Open the link in the email again, or start the change again from your{" "}profile.
        </p>
        {profileLink("Go to your profile")}
      </Panel>
    );
  }

  if (phase.name === "loading") {
    return (
      <Panel className="p-7 sm:p-9" data-confirm="loading">
        {eyebrow}
        {heading(<>Confirm your new{"\u00a0"}email</>)}
        <p className="mt-4 text-[13px] leading-relaxed text-muted-foreground" aria-live="polite">
          Looking up your{" "}account…
        </p>
      </Panel>
    );
  }

  if (phase.name === "nothing") {
    return (
      <Panel className="p-7 sm:p-9" data-confirm="nothing">
        {eyebrow}
        {heading(<>Nothing is waiting to be{"\u00a0"}confirmed</>)}
        <p className="mt-2 text-[13px] leading-relaxed text-pretty text-muted-foreground">
          This account has no email change in progress. The link may already have been used, or it may be for a different{" "}account.
        </p>
        {phase.current && (
          <p className="mt-4 text-[12px] text-muted-foreground">
            Signed in as <span data-confirm-current className="font-mono break-all text-foreground">{phase.current}</span>
          </p>
        )}
        {profileLink("Go to your profile")}
      </Panel>
    );
  }

  if (phase.name === "changed") {
    return (
      <Panel className="p-7 sm:p-9" data-confirm="changed">
        {eyebrow}
        {heading(<>Your sign-in email is{"\u00a0"}changed</>)}
        <Callout tone="success" title="Confirmed" live className="mt-6">
          Your sign-in email is now <span data-confirm-new className="font-mono text-[12.5px] break-all text-foreground">{phase.email}</span>.
        </Callout>
        {profileLink("Back to your profile")}
      </Panel>
    );
  }

  if (phase.name === "half") {
    return (
      <Panel className="p-7 sm:p-9" data-confirm="half">
        {eyebrow}
        {heading("One step left")}
        <Callout tone="note" title="This address is confirmed" live className="mt-6">
          {phase.message}
        </Callout>
        {profileLink("Back to your profile")}
      </Panel>
    );
  }

  const { from, to } = phase;
  const working = phase.name === "working";
  return (
    <Panel className="p-7 sm:p-9" data-confirm={phase.name}>
      {eyebrow}
      {heading(<>Confirm your new{"\u00a0"}email</>)}
      <dl className="mt-5 flex flex-col gap-3 text-[13px]">
        <div>
          <dt className="eyebrow text-faint">From</dt>
          <dd data-confirm-from className="mt-1 font-mono text-[12.5px] break-all text-muted-foreground">{from || "None set"}</dd>
        </div>
        <div>
          <dt className="eyebrow text-faint">To</dt>
          <dd data-confirm-to className="mt-1 font-mono text-[12.5px] break-all text-foreground">{to}</dd>
        </div>
      </dl>

      {phase.name === "failed" && (
        <Callout tone="danger" title="Not confirmed" live="assertive" className="mt-6">
          {phase.message}
        </Callout>
      )}

      {(phase.name !== "failed" || phase.again) && (
        <Button variant="solid" onClick={() => void confirm(from, to)} disabled={working} className="touch-hit mt-6 w-full py-2.5">
          {working && <Loader2 className="animate-spin" size={14} strokeWidth={1.75} />} {phase.name === "failed" ? "Try again" : "Confirm new address"}
        </Button>
      )}
      {phase.name === "failed" && !phase.again ? profileLink("Go to your profile") : (
        <Link href="/settings/profile" className={cn(buttonClasses({}), "touch-hit mt-2.5 w-full py-2.5", working && "pointer-events-none opacity-40")} aria-disabled={working}>
          Not now
        </Link>
      )}
    </Panel>
  );
}

export default function ConfirmEmailPage() {
  return (
    <Suspense fallback={null}>
      <Confirm />
    </Suspense>
  );
}
