"use client";

import { PageHeader } from "@/components/ui";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import { SyncSection } from "@/components/setup/sync-section";
import { AccessSection, AgentsSection, PatchstackSection, SsoSetupSection, WafSection, useSetupState } from "@/components/setup/feature-sections";

/**
 * Setup: the first sync (started only by its button), then each optional part,
 * set up or not, with what it needs. Nothing here changes a server or a setting;
 * the commands shown are for a person to run in their copy of Fleet.
 */
export default function SetupPage() {
  const { state, error } = useSetupState();
  return (
    <div className="flex max-w-4xl flex-col gap-10">
      <div className="flex flex-col gap-4">
        <PageHeader title="Setup" />
        <SettingsTabs />
        <p className="max-w-[65ch] text-[13px] leading-relaxed text-pretty text-muted-foreground">
          What Fleet has read from GridPane, and what else is set{" "}up. A part that is not says what it needs and where
          the steps are in SETUP.md. The commands are for you to run in your copy of Fleet: apart from the Start button for the first sync, this page changes{" "}nothing.
        </p>
      </div>

      <SyncSection />
      <AgentsSection />
      <AccessSection state={state} />
      <SsoSetupSection state={state} error={error} />
      <WafSection />
      <PatchstackSection state={state} />
    </div>
  );
}
