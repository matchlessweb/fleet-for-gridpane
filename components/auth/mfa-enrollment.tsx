"use client";

import { useState, useEffect } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Key, Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  Button,
  Callout,
  CopyButton,
  Input,
  Modal,
  Panel,
  PanelHeader,
  Skeleton,
  StatusPill,
} from "@/components/ui";

export function MFAEnrollment() {
  const [isEnrolled, setIsEnrolled] = useState<boolean | null>(null);
  const [isSettingUp, setIsSettingUp] = useState(false);
  const [factorId, setFactorId] = useState("");
  const [qrCodeUri, setQrCodeUri] = useState("");
  const [secretAuthCode, setSecretAuthCode] = useState("");
  const [verifyCode, setVerifyCode] = useState("");
  const [isVerifying, setIsVerifying] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isDisableModalOpen, setIsDisableModalOpen] = useState(false);
  const [isDisabling, setIsDisabling] = useState(false);

  const supabase = createClient();

  useEffect(() => {
    void supabase.auth.mfa
      .listFactors()
      .then(({ data, error }) => {
        if (error) throw error;

        const totpFactors = data.totp || [];
        const activeFactor = totpFactors.find(f => f.status === 'verified');

        if (activeFactor) {
          setIsEnrolled(true);
          setFactorId(activeFactor.id);
        } else {
          setIsEnrolled(false);
        }
      })
      .catch((error) => {
        console.error("Error checking MFA status:", error);
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [supabase]);

  const startSetup = async () => {
    setIsSettingUp(true);
    try {
      const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp' });
      if (error) throw error;

      setFactorId(data.id);
      setQrCodeUri(data.totp.uri);
      setSecretAuthCode(data.totp.secret);
    } catch (error) {
      toast.error((error as { message?: string }).message || "Failed to initiate MFA setup.");
      setIsSettingUp(false);
    }
  };

  const verifySetup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (verifyCode.length < 6) return;
    setIsVerifying(true);

    try {
      const challenge = await supabase.auth.mfa.challenge({ factorId });
      if (challenge.error) throw challenge.error;

      const verify = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challenge.data.id,
        code: verifyCode
      });

      if (verify.error) throw verify.error;

      toast.success("Two-Factor Authentication successfully enabled!");
      setIsEnrolled(true);
      setIsSettingUp(false);
      setVerifyCode("");
    } catch (error) {
      toast.error((error as { message?: string }).message || "Invalid authentication code.");
    } finally {
      setIsVerifying(false);
    }
  };

  const unenroll = async () => {
    if (!factorId) return;
    setIsDisabling(true);
    try {
      const { error } = await supabase.auth.mfa.unenroll({ factorId });
      if (error) throw error;

      toast.success("Two-Factor Authentication disabled.");
      setIsEnrolled(false);
      setFactorId("");
      setIsDisableModalOpen(false);
    } catch (error) {
      toast.error((error as { message?: string }).message || "Failed to disable MFA.");
    } finally {
      setIsDisabling(false);
    }
  };

  if (isLoading) {
    return (
      <section className="flex flex-col gap-4">
        <PanelHeader title="Two-factor authentication" />
        <Panel className="p-5">
          <div className="flex max-w-2xl flex-col gap-3">
            <Skeleton className="h-4 w-56" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-9 w-48" />
          </div>
        </Panel>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <PanelHeader title="Two-factor authentication" />
      <Panel className="p-5">
        {!isEnrolled && !isSettingUp && (
          <div className="flex max-w-2xl flex-col gap-4">
            <p className="text-[13px] leading-relaxed">
              Two-factor authentication adds a time-based code from an
              authenticator app — 1Password, Google Authenticator, or Authy —
              to every password sign-in. A password alone cannot enter
              the{"\u00a0"}dashboard.
            </p>
            <div>
              <Button variant="solid" onClick={startSetup}>
                <Key size={14} strokeWidth={1.75} /> Set up two-factor auth
              </Button>
            </div>
          </div>
        )}

        {isEnrolled && !isSettingUp && (
          <div className="flex max-w-2xl flex-col gap-4">
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              Sign-in requires a time-based confirmation code from the
              connected authenticator device{"\u00a0"}(AAL2).
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <StatusPill tone="ok" led>
                Two-factor active
              </StatusPill>
              <Button
                variant="danger"
                size="sm"
                onClick={() => setIsDisableModalOpen(true)}
              >
                Disable 2FA
              </Button>
            </div>
          </div>
        )}

        {isSettingUp && !isEnrolled && (
          <div>
            <p className="eyebrow mb-4 text-faint">Authenticator setup</p>
            <div className="grid w-full grid-cols-1 items-start gap-6 md:grid-cols-2">
              {/* Left column: QR code and secret */}
              <div className="flex min-w-0 flex-col gap-4">
                <p className="text-[13px] leading-relaxed text-muted-foreground">
                  1. Scan the code with 1Password, Google Authenticator, or
                  Authy.
                </p>
                {/* Functional exception: the QR tile stays true white in both
                    themes so scanners read it reliably. */}
                <div className="w-max max-w-full rounded-md bg-white p-3">
                  {qrCodeUri ? (
                    <QRCodeSVG
                      value={qrCodeUri}
                      size={150}
                      level="M"
                      includeMargin={false}
                      className="h-auto max-w-full"
                    />
                  ) : (
                    <Skeleton className="h-[150px] w-[150px]" />
                  )}
                </div>

                <div className="min-w-0">
                  <p className="mb-1.5 text-[12px] text-muted-foreground">
                    Cannot scan? Enter the secret manually.
                  </p>
                  <div className="flex w-full min-w-0 max-w-sm items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-panel-2 px-3 py-2 font-mono text-[11px] text-muted-foreground">
                      {secretAuthCode || "Generating secret..."}
                    </code>
                    <CopyButton value={secretAuthCode} what="secret key" />
                  </div>
                </div>
              </div>

              {/* Right column: code input */}
              <div className="flex min-w-0 flex-col gap-4 md:border-l md:border-border md:pl-6">
                <p className="text-[13px] leading-relaxed text-muted-foreground">
                  2. Enter the 6-digit confirmation code generated by the app
                  to verify the connection.
                </p>
                <form onSubmit={verifySetup} className="flex min-w-0 flex-col gap-3">
                  <Input
                    type="text"
                    maxLength={6}
                    value={verifyCode}
                    onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, ''))}
                    placeholder="000 000"
                    className="w-full text-center font-mono text-[18px] font-bold tracking-[0.5em] sm:max-w-[200px]"
                  />
                  <Button
                    type="submit"
                    variant="solid"
                    disabled={verifyCode.length < 6 || isVerifying}
                    className="w-full sm:max-w-[200px]"
                  >
                    {isVerifying ? (
                      <Loader2 className="animate-spin" size={14} strokeWidth={1.75} />
                    ) : (
                      "Verify and enable"
                    )}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setIsSettingUp(false)}
                    className="w-full sm:max-w-[200px]"
                  >
                    Cancel
                  </Button>
                </form>
              </div>
            </div>
          </div>
        )}
      </Panel>

      <Modal
        open={isDisableModalOpen}
        onClose={() => setIsDisableModalOpen(false)}
        title="Disable two-factor"
        meta="AAL2"
      >
        <div className="flex flex-col gap-4">
          <Callout tone="danger" title={"This removes the second factor from\u00a0sign-in."}>
            Every sign-in, a passkey included, will then have to set an
            authenticator app up again before it can{"\u00a0"}enter.
          </Callout>
          <div className="flex flex-col-reverse items-stretch gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-end">
            <Button
              variant="ghost"
              onClick={() => setIsDisableModalOpen(false)}
              disabled={isDisabling}
            >
              Cancel
            </Button>
            <Button variant="danger" onClick={unenroll} disabled={isDisabling}>
              {isDisabling ? (
                <Loader2 size={14} strokeWidth={1.75} className="animate-spin" />
              ) : (
                "Disable 2FA"
              )}
            </Button>
          </div>
        </div>
      </Modal>
    </section>
  );
}
