"use client";

import { useState, useEffect } from "react";
import { Lock, Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  Button,
  Input,
  Modal,
  Panel,
  PanelHeader,
  Skeleton,
} from "@/components/ui";

export function PasswordReset() {
  const [isEnrolled, setIsEnrolled] = useState<boolean>(false);
  const [factorId, setFactorId] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isUpdating, setIsUpdating] = useState(false);

  const [isTotpModalOpen, setIsTotpModalOpen] = useState(false);
  const [verifyCode, setVerifyCode] = useState("");
  const [isVerifying, setIsVerifying] = useState(false);

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

  const handleInitialSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (newPassword.length < 8) {
      toast.error("Password must be at least 8 characters long.");
      return;
    }

    if (newPassword !== confirmPassword) {
      toast.error("Passwords do not match.");
      return;
    }

    if (isEnrolled && factorId) {
      // Intercept and require TOTP
      setVerifyCode("");
      setIsTotpModalOpen(true);
    } else {
      // Proceed directly
      executePasswordUpdate();
    }
  };

  const verifyAndExecutePayload = async (e: React.FormEvent) => {
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

      // Verification passed, close modal and execute
      setIsTotpModalOpen(false);
      await executePasswordUpdate();

    } catch (error) {
      toast.error((error as { message?: string }).message || "Invalid authenticator code. Update blocked.");
      setVerifyCode(""); // Reset array
    } finally {
      setIsVerifying(false);
    }
  };

  const executePasswordUpdate = async () => {
    setIsUpdating(true);
    try {
      const { error } = await supabase.auth.updateUser({
        password: newPassword
      });

      if (error) throw error;

      toast.success("Password successfully updated.");
      setNewPassword("");
      setConfirmPassword("");
    } catch (error) {
      toast.error((error as { message?: string }).message || "Failed to update password.");
    } finally {
      setIsUpdating(false);
    }
  };

  if (isLoading) {
    return (
      <section className="flex flex-col gap-4">
        <PanelHeader title="Password" />
        <Panel className="p-5">
          <div className="flex max-w-md flex-col gap-3">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        </Panel>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <PanelHeader title="Password" />
      <Panel className="p-5">
        <p className="mb-4 text-[13px] leading-relaxed text-muted-foreground">
          Update the core sign-in credential.
        </p>

        <form onSubmit={handleInitialSubmit} className="flex max-w-md flex-col gap-4">
          <div className="flex flex-col gap-2">
            <label className="eyebrow text-faint" htmlFor="new-password">
              New password
            </label>
            <span className="relative flex">
              <Lock
                size={14}
                strokeWidth={1.75}
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
              />
              <Input
                id="new-password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full pl-9"
                placeholder="Min. 8 characters"
                required
                minLength={8}
              />
            </span>
          </div>

          <div className="flex flex-col gap-2">
            <label className="eyebrow text-faint" htmlFor="confirm-password">
              Confirm new password
            </label>
            <span className="relative flex">
              <Lock
                size={14}
                strokeWidth={1.75}
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
              />
              <Input
                id="confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full pl-9"
                placeholder="Min. 8 characters"
                required
                minLength={8}
              />
            </span>
          </div>

          <div className="pt-1">
            <Button
              type="submit"
              variant="solid"
              disabled={isUpdating || !newPassword || !confirmPassword}
            >
              {isUpdating ? (
                <Loader2 className="animate-spin" size={14} strokeWidth={1.75} />
              ) : (
                "Update password"
              )}
            </Button>
          </div>
        </form>
      </Panel>

      {/* Intercept modal for MFA */}
      <Modal
        open={isTotpModalOpen}
        onClose={() => {
          if (!isVerifying) setIsTotpModalOpen(false);
        }}
        title="Security challenge"
        meta="TOTP"
      >
        <div className="flex flex-col gap-4">
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            This account requires two-factor authorization. Enter the current
            6-digit code from your authenticator app to confirm the password
            change.
          </p>

          <form onSubmit={verifyAndExecutePayload} className="flex flex-col gap-4">
            <Input
              type="text"
              maxLength={6}
              value={verifyCode}
              onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, ''))}
              placeholder="000 000"
              autoFocus
              className="w-full text-center font-mono text-[18px] font-bold tracking-[0.5em]"
            />

            <div className="flex flex-col-reverse items-stretch gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-end">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setIsTotpModalOpen(false)}
                disabled={isVerifying}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="solid"
                disabled={verifyCode.length < 6 || isVerifying}
              >
                {isVerifying ? (
                  <Loader2 size={14} strokeWidth={1.75} className="animate-spin" />
                ) : (
                  "Verify and save"
                )}
              </Button>
            </div>
          </form>
        </div>
      </Modal>
    </section>
  );
}
