"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { Save, Info } from "lucide-react";
import { useTask } from "@/components/providers/task-provider";
import {
  Button,
  Input,
  PageHeader,
  Panel,
  PanelHeader,
  Select,
  Skeleton,
} from "@/components/ui";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import { EmailPanel } from "@/components/account/email-panel";

export default function ProfileSettingsPage() {
  const supabase = createClient();
  const { runGenericTask } = useTask();

  const [isLoading, setIsLoading] = useState(true);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [nickname, setNickname] = useState("");
  const [displayPreference, setDisplayPreference] = useState("first_name");

  useEffect(() => {
    async function loadProfile() {
      setIsLoading(true);
      const { data: { user } } = await supabase.auth.getUser();
      if (user?.user_metadata) {
        if (user.user_metadata.first_name) setFirstName(user.user_metadata.first_name);
        if (user.user_metadata.last_name) setLastName(user.user_metadata.last_name);
        if (user.user_metadata.nickname) setNickname(user.user_metadata.nickname);
        if (user.user_metadata.display_preference) setDisplayPreference(user.user_metadata.display_preference);
      }
      setIsLoading(false);
    }
    loadProfile();
  }, [supabase]);

  const handleSave = async () => {
    const payload = {
      first_name: firstName,
      last_name: lastName,
      nickname: nickname,
      display_preference: displayPreference
    };

    await runGenericTask(
      2,
      ["Encrypting profile data...", "Updating authentication provider defaults..."],
      async (log, updateProgress) => {
        log("Uploading metadata payload to Supabase Auth...");
        updateProgress(1, 2, 50);

        const { error } = await supabase.auth.updateUser({
          data: payload
        });

        if (error) {
          log("Supabase error: " + error.message);
          throw new Error(error.message);
        }

        log("Profile metadata successfully updated.");
        updateProgress(2, 2, 100);

        // Dispatch global event so sidebar picks it up
        window.dispatchEvent(new Event("user_profile_updated"));
      }
    );
  };

  if (isLoading) {
    return (
      <div className="flex max-w-4xl flex-col gap-8">
        <div className="flex flex-col gap-4">
          <PageHeader title="Profile" />
          <SettingsTabs />
        </div>
        <div className="flex flex-col gap-3">
          <Skeleton className="h-4 w-44" />
          <Skeleton className="h-44 w-full rounded-lg" />
        </div>
        <p className="text-[12px] text-muted-foreground">Loading profile…</p>
      </div>
    );
  }

  return (
    <div className="flex max-w-4xl flex-col gap-8">
      <div className="flex flex-col gap-4">
        <PageHeader title="Profile" />
        <SettingsTabs />
        <p className="text-[13px] leading-relaxed text-pretty text-muted-foreground">
          Your name as Fleet shows it, and the email you sign in{"\u00a0"}with.
        </p>
      </div>

      <section className="flex flex-col gap-4">
        <PanelHeader title="Identity" />
        <Panel className="p-5">
          <div className="flex flex-col gap-5">
            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              <div className="flex flex-col gap-2">
                <label className="eyebrow text-faint" htmlFor="first-name">
                  First name
                </label>
                <Input
                  id="first-name"
                  type="text"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  className="w-full"
                  placeholder="Enter first name"
                />
              </div>
              <div className="flex flex-col gap-2">
                <label className="eyebrow text-faint" htmlFor="last-name">
                  Last name
                </label>
                <Input
                  id="last-name"
                  type="text"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  className="w-full"
                  placeholder="Enter last name"
                />
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <label className="eyebrow text-faint" htmlFor="nickname">
                Nickname
              </label>
              <Input
                id="nickname"
                type="text"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                className="w-full"
                placeholder="Enter a shorthand alias"
              />
              <p className="flex items-center gap-1.5 text-[12px] text-pretty text-muted-foreground">
                <Info size={14} strokeWidth={1.75} /> Used in memos and compact{"\u00a0"}navigation.
              </p>
            </div>

            <div className="flex flex-col gap-2 border-t border-border pt-5">
              <label className="eyebrow text-faint" htmlFor="display-preference">
                Interface display preference
              </label>
              <Select
                id="display-preference"
                value={displayPreference}
                onChange={(e) => setDisplayPreference(e.target.value)}
                wrapperClassName="w-full max-w-sm"
              >
                <option value="first_name">First name only</option>
                <option value="full_name">Full name (first + last)</option>
                <option value="nickname">Nickname only</option>
              </Select>
            </div>
          </div>
        </Panel>

        <div className="flex justify-end">
          <Button variant="solid" className="touch-hit" onClick={handleSave}>
            <Save size={14} strokeWidth={1.75} /> Save profile
          </Button>
        </div>
      </section>

      <EmailPanel />
    </div>
  );
}
