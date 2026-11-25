"use client";

import { MFAEnrollment } from "@/components/auth/mfa-enrollment";
import { PasskeyManager } from "@/components/auth/passkey-manager";
import { PasswordReset } from "@/components/auth/password-reset";
import { SsoSwitchPanel } from "@/components/sso/sso-controls";
import { useSsoState } from "@/lib/sso/use-sso";
import { SsoSetupSection, useSetupState } from "@/components/setup/feature-sections";
import { PageHeader } from "@/components/ui";
import { SettingsTabs } from "@/components/settings/settings-tabs";

export default function SecuritySettingsPage() {
  return (
    <div className="flex max-w-4xl flex-col gap-10">
      <div className="flex flex-col gap-4">
        <PageHeader title="Security" />
        <SettingsTabs />
        <p className="text-[13px] leading-relaxed text-pretty text-muted-foreground">
          Credentials and two-factor authentication for this{"\u00a0"}account.
        </p>
      </div>

      <PasswordReset />
      <PasskeyManager />
      <MFAEnrollment />
      <SsoSwitchPanel />
      <SsoNotSetUp />
    </div>
  );
}

/**
 * For an account the switch is not shown to: what one-click sign-in still needs.
 * The switch itself stays behind its gate (SsoSwitchPanel).
 */
function SsoNotSetUp() {
  const sso = useSsoState();
  const { state, error } = useSetupState();
  if (!sso.loaded || sso.mine) return null;
  return <SsoSetupSection state={state} error={error} />;
}
