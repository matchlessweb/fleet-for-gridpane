"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";
import { Mail, Lock, Loader2, Fingerprint } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { mayUseApp } from "@/lib/auth-assurance";
import { useClientValue } from "@/lib/use-client-value";
import { looksLikeLinkToken } from "@/lib/account/email-change";
import { Button, Callout, CopyButton, Input, Panel } from "@/components/ui";
import { fleetConfig } from "@/fleet.config";

/**
 * Where to go once signed in. Someone who opened a "confirm your new email"
 * link while signed out is sent here with the link still in the address: take
 * them on to the confirm page. Anything else goes home. Only ever a fixed path
 * on this site.
 */
function afterSignIn(): string {
  const q = new URLSearchParams(window.location.search);
  const token = q.get("token_hash");
  return q.get("type") === "email_change" && looksLikeLinkToken(token) ? `/auth/confirm?token_hash=${token}&type=email_change` : "/";
}

/** Passkeys are bound to the relying-party domain configured in Supabase. */
const PASSKEY_HOSTNAME: string = fleetConfig.hostname;

/**
 * credentials: nobody is signed in.
 * code: signed in by password; the account has an authenticator app and owes its code.
 * enroll: signed in, by password or passkey; the account has no authenticator app and must set one up.
 * A session opened with a password alone never enters (lib/auth-assurance.ts): the
 * middleware and the database both turn it away. An account with no authenticator
 * app yet sets one up here first; SECURITY.md says what that leaves open.
 */
type Step = "credentials" | "code" | "enroll";

const COPY: Record<Step | "enroll-code", { title: string; lead: string; action: string }> = {
  credentials: { title: "Sign in", lead: "Administrator credentials for the fleet ledger.", action: "Sign in" },
  code: { title: "Two-factor auth", lead: "Enter the 6-digit code from your authenticator app.", action: "Verify" },
  enroll: { title: "Add a second\u00a0factor", lead: "This account has no authenticator app yet. Set one up to continue.", action: "Set up an authenticator app" },
  "enroll-code": { title: "Add a second\u00a0factor", lead: "Scan the code with your authenticator app, then enter the 6-digit code it shows.", action: "Verify and continue" },
};

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [step, setStep] = useState<Step>("credentials");
  const [factorId, setFactorId] = useState<string | null>(null);
  /** The authenticator secret being set up, once the sign-in service has issued one. */
  const [setup, setSetup] = useState<{ uri: string; secret: string } | null>(null);
  const passkeyAvailable = useClientValue(
    () => window.location.hostname === PASSKEY_HOSTNAME && typeof window.PublicKeyCredential !== "undefined",
    false,
  );
  const [isPasskeyLoading, setIsPasskeyLoading] = useState(false);

  const router = useRouter();
  const [supabase] = useState(() => createClient());

  /**
   * Send a signed-in account on if it may use the app; otherwise show what it still owes:
   * a code, or an authenticator app to set up. A passkey sign-in on an account with no
   * authenticator app owes the set-up too (mayUseApp in lib/auth-assurance.ts says why).
   */
  const proceed = useCallback(async () => {
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    const { data: factors, error: factorsError } = await supabase.auth.mfa.listFactors();
    if (factorsError) throw factorsError; // not knowing is not the same as having none
    if (mayUseApp(aal, factors?.all)) {
      router.push(afterSignIn());
      router.refresh();
      return;
    }
    const app = factors?.totp?.[0]; // verified authenticator apps only
    setTotpCode("");
    setSetup(null);
    setFactorId(app ? app.id : null);
    setStep(app ? "code" : "enroll");
  }, [supabase, router]);

  useEffect(() => {
    // Already signed in: go on, or pick up at the step still owed.
    const checkSession = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (session) await proceed();
    };
    checkSession().catch((err: unknown) => setError((err instanceof Error && err.message) || "Could not read this account's sign-in settings. Reload the page to try again."));
  }, [supabase, proceed]);

  const handlePasskeyLogin = async () => {
    if (isPasskeyLoading) return;
    setIsPasskeyLoading(true);
    setError(null);

    try {
      const { data, error: passkeyError } = await supabase.auth.signInWithPasskey();
      if (passkeyError) throw passkeyError;
      if (!data?.session) throw new Error("Passkey sign-in did not return a session.");
      await proceed();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "";
      // Closing the OS passkey prompt is a cancel, not an error.
      if (!/abort|cancel|timed? ?out|not allowed/i.test(message)) {
        setError(message || "Passkey sign-in failed. Use your password instead.");
      }
    } finally {
      setIsPasskeyLoading(false);
    }
  };

  /** Ask the sign-in service for a new authenticator secret to show as a QR code. */
  const startSetup = async () => {
    // A setup abandoned earlier leaves a half-made factor behind that would refuse a new one.
    const { data: factors } = await supabase.auth.mfa.listFactors();
    for (const f of factors?.all ?? []) {
      if (f.factor_type === "totp" && f.status !== "verified") await supabase.auth.mfa.unenroll({ factorId: f.id });
    }
    const { data, error: enrollError } = await supabase.auth.mfa.enroll({ factorType: "totp" });
    if (enrollError) throw enrollError;
    setFactorId(data.id);
    setSetup({ uri: data.totp.uri, secret: data.totp.secret });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading) return;
    setIsLoading(true);
    setError(null);

    try {
      if (step === "credentials") {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
        if (signInError) throw signInError;
        await proceed();
      } else if (step === "enroll" && !setup) {
        await startSetup();
      } else {
        if (!factorId) throw new Error("No authenticator factor found.");
        if (totpCode.length < 6) throw new Error("Please enter a 6-digit code.");

        const challenge = await supabase.auth.mfa.challenge({ factorId });
        if (challenge.error) throw challenge.error;

        const verify = await supabase.auth.mfa.verify({ factorId, challengeId: challenge.data.id, code: totpCode });
        if (verify.error) throw verify.error;
        await proceed();
      }
    } catch (err: unknown) {
      setError((err instanceof Error && err.message) || "An unexpected error occurred during authentication.");
    } finally {
      setIsLoading(false);
    }
  };

  const signOut = async () => {
    setError(null);
    await supabase.auth.signOut();
    setPassword("");
    setTotpCode("");
    setSetup(null);
    setFactorId(null);
    setStep("credentials");
  };

  const view = step === "enroll" && setup ? "enroll-code" : step;
  const wantsCode = view === "code" || view === "enroll-code";
  const copy = COPY[view];

  return (
    <div className="flex w-full items-center justify-center" data-login-step={view}>
      <Panel className="w-full max-w-md p-8 shadow-2xl sm:p-10">
        <div className="mb-7 border-b border-border pb-5">
          <p className="text-[16px] font-extrabold tracking-[0.22em]">
            {fleetConfig.wordmark}<span className="text-brand">.</span>
          </p>
          <p className="eyebrow mt-1.5 text-faint">Fleet ledger access</p>
        </div>

        <div className="mb-6">
          <h1 className="text-[22px] font-extrabold tracking-[-0.02em] text-balance text-foreground">
            {copy.title}
          </h1>
          <p className="mt-1.5 text-[13px] leading-relaxed text-pretty text-muted-foreground">
            {copy.lead}
          </p>
        </div>

        {error && (
          <Callout tone="danger" live="assertive" className="mb-5">
            {error}
          </Callout>
        )}

        {passkeyAvailable && !wantsCode && (
          <div className="mb-5 flex flex-col gap-4">
            <Button
              type="button"
              variant="ghost"
              onClick={handlePasskeyLogin}
              disabled={isPasskeyLoading || isLoading}
              className="touch-hit w-full py-2.5"
            >
              {isPasskeyLoading ? (
                <Loader2 className="animate-spin" size={14} strokeWidth={1.75} />
              ) : (
                <>
                  <Fingerprint size={14} strokeWidth={1.75} /> Sign in with
                  passkey
                </>
              )}
            </Button>
            <div className="flex items-center gap-3">
              <span className="h-px flex-1 bg-border" aria-hidden="true" />
              <span className="eyebrow text-faint">or</span>
              <span className="h-px flex-1 bg-border" aria-hidden="true" />
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          {view === "credentials" && (
            <>
              <div className="flex flex-col gap-2">
                <label className="eyebrow text-faint" htmlFor="login-email">
                  Email address
                </label>
                <span className="relative flex">
                  <Mail
                    size={14}
                    strokeWidth={1.75}
                    aria-hidden="true"
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
                  />
                  <Input
                    id="login-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full pl-9"
                    placeholder="Your email"
                    autoComplete="email"
                  />
                </span>
              </div>

              <div className="flex flex-col gap-2">
                <label className="eyebrow text-faint" htmlFor="login-password">
                  Password
                </label>
                <span className="relative flex">
                  <Lock
                    size={14}
                    strokeWidth={1.75}
                    aria-hidden="true"
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
                  />
                  <Input
                    id="login-password"
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full pl-9"
                    placeholder="Your password"
                    autoComplete="current-password"
                  />
                </span>
              </div>
            </>
          )}

          {view === "enroll-code" && setup && (
            <div className="flex min-w-0 flex-col gap-4" data-login-setup>
              {/* Functional exception: the QR tile stays true white in both
                  themes so scanners read it reliably. */}
              <div className="w-max max-w-full self-center rounded-md bg-white p-3">
                <QRCodeSVG value={setup.uri} size={150} level="M" includeMargin={false} className="h-auto max-w-full" />
              </div>
              <div className="min-w-0">
                <p className="mb-1.5 text-[12px] text-muted-foreground">
                  Cannot scan? Enter the secret{" "}manually.
                </p>
                <div className="flex w-full min-w-0 items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-panel-2 px-3 py-2 font-mono text-[11px] text-muted-foreground">
                    {setup.secret}
                  </code>
                  <CopyButton value={setup.secret} what="secret key" />
                </div>
              </div>
            </div>
          )}

          {wantsCode && (
            <div className="flex flex-col gap-2">
              <label className="eyebrow text-faint" htmlFor="login-totp">
                Authentication code
              </label>
              <Input
                id="login-totp"
                type="text"
                inputMode="numeric"
                required
                maxLength={6}
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                className="w-full text-center font-mono text-[18px] font-bold tracking-[0.5em] placeholder:font-sans placeholder:text-[12.5px] placeholder:font-normal placeholder:tracking-normal"
                placeholder="000000"
                autoComplete="one-time-code"
                autoFocus
              />
            </div>
          )}

          <Button
            type="submit"
            variant="solid"
            disabled={isLoading || (wantsCode && totpCode.length < 6)}
            className="touch-hit mt-1 w-full py-2.5"
          >
            {isLoading ? (
              <Loader2 className="animate-spin" size={14} strokeWidth={1.75} />
            ) : (
              copy.action
            )}
          </Button>

          {view !== "credentials" && (
            <Button type="button" variant="ghost" onClick={signOut} disabled={isLoading} className="touch-hit w-full py-2.5">
              Use a different account
            </Button>
          )}
        </form>
      </Panel>
    </div>
  );
}
