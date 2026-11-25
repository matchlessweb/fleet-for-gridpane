"use client";

import { Fingerprint, Loader2, Mail, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button, Callout, Input, Panel, PanelHeader, Skeleton } from "@/components/ui";

/**
 * The sign-in email on the profile page, and the way to change it.
 *
 * Sending the form changes nothing: Fleet asks the database to mail a link to
 * the new address, and the account keeps its address until that link is
 * confirmed (see lib/account/email-change.ts). Fleet asks for a passkey first
 * when the last strong sign-in is more than ten minutes old. When the account
 * has an authenticator app and the database wants its code, the panel asks for
 * the code in place and sends the change again.
 */

type Reply = { state?: string; ok?: boolean; reason?: string; message?: string; stepUp?: boolean; needsCode?: boolean; email?: string };
type Mode = { name: "view" } | { name: "edit" } | { name: "confirm"; message: string; canAddPasskey: boolean } | { name: "code"; message: string };

const WANTS_CODE = "This account has an authenticator app, so the database wants its code before an email change.";
const SIGN_IN_WITH_CODE = "Sign out, sign in with your password and code, then try again.";

async function ask(email: string): Promise<Reply> {
  try {
    const res = await fetch("/api/account/email", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
    const json: Reply = await res.json().catch(() => ({}));
    return json && typeof json === "object" ? json : {};
  } catch {
    return { ok: false, message: "Fleet could not be reached. Nothing was changed." };
  }
}

export function EmailPanel() {
  const [current, setCurrent] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ name: "view" });
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [codeTry, setCodeTry] = useState(0);
  const userId = useRef<string | null>(null);

  /** The account as the sign-in service has it now, or null when nobody is signed in. */
  const readUser = useCallback(async () => (await createClient().auth.getUser()).data.user, []);
  const show = useCallback((user: Awaited<ReturnType<typeof readUser>>) => {
    if (!user) return;
    userId.current = user.id;
    setCurrent(user.email ?? "");
    setPending(user.new_email ? user.new_email : null);
  }, []);
  const load = useCallback(async () => show(await readUser()), [readUser, show]);

  useEffect(() => {
    void readUser().then(show);
    // The link is usually confirmed in another tab: look again when this one is back in front.
    const again = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", again);
    window.addEventListener("focus", again);
    return () => {
      document.removeEventListener("visibilitychange", again);
      window.removeEventListener("focus", again);
    };
  }, [load, readUser, show]);

  const send = async (codeGiven = false) => {
    const email = draft.trim();
    if (!email || busy) return;
    setBusy(true);
    setProblem(null);
    const r = await ask(email);
    setBusy(false);
    if (r.ok && r.state === "sent") {
      setMode({ name: "view" });
      setDraft("");
      await load();
      setPending((p) => p ?? r.email ?? email);
      toast.success("Confirmation link sent", { description: "Your sign-in email stays the same until you confirm it." });
      return;
    }
    if (r.ok && r.state === "changed") {
      setMode({ name: "view" });
      setDraft("");
      await load();
      toast.success("Sign-in email changed");
      return;
    }
    if (r.stepUp) {
      setMode({ name: "confirm", message: r.message || "Confirm with your passkey to change your sign-in email.", canAddPasskey: r.reason === "no-strong-factor" });
      return;
    }
    if (r.needsCode || r.reason === "needs-code") {
      if (codeGiven) {
        // The code was accepted and the database still asks for one: do not go round again.
        setProblem(`The database still wants your authenticator code. ${SIGN_IN_WITH_CODE}`);
        return;
      }
      setCode("");
      setMode({ name: "code", message: r.message || WANTS_CODE });
      return;
    }
    setProblem(r.message || "The change could not be started. Nothing was changed.");
  };

  const verifyCode = async () => {
    if (code.length < 6 || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const supabase = createClient();
      const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
      const factor = factors?.totp?.[0];
      if (listError || !factor) {
        setBusy(false);
        setMode({ name: "edit" });
        setProblem(`Fleet found no authenticator app on this account to ask. ${SIGN_IN_WITH_CODE}`);
        return;
      }
      const challenge = await supabase.auth.mfa.challenge({ factorId: factor.id });
      if (challenge.error) throw challenge.error;
      const verify = await supabase.auth.mfa.verify({ factorId: factor.id, challengeId: challenge.data.id, code });
      if (verify.error) {
        setBusy(false);
        setCode("");
        setCodeTry((n) => n + 1);
        setProblem("That code was not accepted. Enter the current code from your authenticator app.");
        return;
      }
      setBusy(false);
      setMode({ name: "edit" });
      await send(true);
    } catch {
      setBusy(false);
      setProblem("The code could not be checked just now. Nothing was changed. Try again.");
    }
  };

  const confirmWithPasskey = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const { data, error } = await createClient().auth.signInWithPasskey();
      if (error || !data?.session) throw error ?? new Error("no session");
      if (userId.current && data.session.user.id !== userId.current) {
        // That passkey signed in a different account. Show that account, not a half-finished form.
        window.location.reload();
        return;
      }
      setBusy(false);
      setMode({ name: "edit" });
      await send();
    } catch {
      setBusy(false);
      setProblem("That did not go through. Try your passkey again.");
    }
  };

  const cancel = () => {
    setMode({ name: "view" });
    setDraft("");
    setCode("");
    setProblem(null);
  };

  return (
    <section data-email-panel className="flex flex-col gap-4">
      <PanelHeader title="Sign-in email" />
      <Panel className="p-5">
        {current === null ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-4 w-56 max-w-full" />
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
              <div className="min-w-0 flex-1 basis-64">
                <p className="eyebrow text-faint">Current address</p>
                <p data-email-current className="mt-1.5 font-mono text-[13px] break-all text-foreground">
                  {current || "None set"}
                </p>
                <p className="mt-1.5 text-[12px] leading-relaxed text-pretty text-muted-foreground">
                  Used for password sign-in and for getting back into your account. Your passkey does not depend on{" "}it.
                </p>
              </div>
              {mode.name === "view" && (
                <Button size="sm" className="touch-hit" data-email-change onClick={() => { setProblem(null); setMode({ name: "edit" }); }}>
                  Change
                </Button>
              )}
            </div>

            {pending && (
              <Callout tone="note" title="Waiting for you to confirm" live data-email-pending>
                Fleet sent a link to <span className="font-mono text-[12.5px] break-all text-foreground">{pending}</span>. Open it where you are signed in to Fleet and press Confirm. Your sign-in email stays the same until you{" "}do. If a link also came to your current address, confirm that one{" "}too.
              </Callout>
            )}

            {mode.name === "edit" && (
              <form
                className="flex flex-col gap-3 border-t border-border pt-5"
                onSubmit={(e) => {
                  e.preventDefault();
                  void send();
                }}
              >
                <label className="eyebrow text-faint" htmlFor="new-email">
                  New address
                </label>
                <Input
                  id="new-email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  className="w-full max-w-sm"
                  placeholder="name@example.com"
                />
                <p className="text-[12px] leading-relaxed text-pretty text-muted-foreground">
                  Fleet will send a confirmation link to this address. Nothing changes until you open it and{" "}confirm.
                </p>
                <div className="flex flex-wrap gap-2.5">
                  <Button type="submit" variant="solid" className="touch-hit" disabled={busy || !draft.trim()}>
                    {busy ? <Loader2 className="animate-spin" size={14} strokeWidth={1.75} /> : <Mail size={14} strokeWidth={1.75} />} Send confirmation link
                  </Button>
                  <Button type="button" className="touch-hit" onClick={cancel} disabled={busy}>
                    Cancel
                  </Button>
                </div>
              </form>
            )}

            {mode.name === "confirm" && (
              <div className="flex flex-col gap-3 border-t border-border pt-5" data-email-stepup>
                <Callout tone="warning" title="Confirm it is you" live>
                  {mode.message}
                </Callout>
                <div className="flex flex-wrap items-center gap-2.5">
                  <Button variant="solid" className="touch-hit" onClick={() => void confirmWithPasskey()} disabled={busy}>
                    {busy ? <Loader2 className="animate-spin" size={14} strokeWidth={1.75} /> : <Fingerprint size={14} strokeWidth={1.75} />} Confirm with passkey
                  </Button>
                  <Button className="touch-hit" onClick={cancel} disabled={busy}>
                    Cancel
                  </Button>
                  {mode.canAddPasskey && (
                    <Link href="/settings/security" className="text-[12.5px] text-foreground underline underline-offset-2">
                      Add a passkey
                    </Link>
                  )}
                </div>
              </div>
            )}

            {mode.name === "code" && (
              <form
                className="flex flex-col gap-3 border-t border-border pt-5"
                data-email-code
                onSubmit={(e) => {
                  e.preventDefault();
                  void verifyCode();
                }}
              >
                <Callout tone="warning" title={"Enter your authenticator\u00a0code"} live>
                  {mode.message}{" "}Fleet then sends the link to{" "}<span className="font-mono text-[12.5px] break-all text-foreground">{draft.trim()}</span>.
                </Callout>
                <label className="eyebrow text-faint" htmlFor="email-totp">
                  Authentication code
                </label>
                <Input
                  key={codeTry}
                  id="email-totp"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                  autoFocus
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  className="w-full max-w-[15rem] text-center font-mono text-[18px] font-bold tracking-[0.5em] placeholder:font-sans placeholder:text-[12.5px] placeholder:font-normal placeholder:tracking-normal"
                  placeholder="6-digit code"
                />
                <div className="flex flex-wrap gap-2.5">
                  <Button type="submit" variant="solid" className="touch-hit" disabled={busy || code.length < 6}>
                    {busy ? <Loader2 className="animate-spin" size={14} strokeWidth={1.75} /> : <ShieldCheck size={14} strokeWidth={1.75} />} Check code and send link
                  </Button>
                  <Button type="button" className="touch-hit" onClick={cancel} disabled={busy}>
                    Cancel
                  </Button>
                </div>
              </form>
            )}

            {problem && (
              <Callout tone="danger" title="Not changed" live="assertive" data-email-problem>
                {problem}
              </Callout>
            )}
          </div>
        )}
      </Panel>
    </section>
  );
}
