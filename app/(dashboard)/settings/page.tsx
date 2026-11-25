"use client";

import { Save, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { useSettings } from "@/components/providers/settings-provider";
import { CloudflareTokenPanel } from "@/components/cloudflare/token-panel";
import {
  METRIC_LABELS,
  validateThresholds,
  type Metric,
  type Thresholds,
} from "@/lib/thresholds";
import {
  Button,
  Input,
  PageHeader,
  Panel,
  PanelHeader,
  StatusPill,
} from "@/components/ui";
import { SettingsTabs } from "@/components/settings/settings-tabs";

const METRICS: Metric[] = ["cpu", "memory", "disk"];

export default function SettingsPage() {
  const { thresholds, loaded, applyThresholds } = useSettings();
  const [draft, setDraft] = useState<Thresholds>(thresholds);
  const [saving, setSaving] = useState(false);

  // Adopt the saved values once they arrive, and again whenever they change.
  // Without the `loaded` guard the form would show the client-side fallbacks as
  // though they were what is stored, and saving would silently overwrite the
  // real row with them. Done while rendering, so no frame shows the old draft.
  const [adopted, setAdopted] = useState<Thresholds | null>(null);
  if (loaded && adopted !== thresholds) {
    setAdopted(thresholds);
    setDraft(thresholds);
  }

  const dirty = METRICS.some(
    (m) =>
      draft[m].warn !== thresholds[m].warn ||
      draft[m].critical !== thresholds[m].critical
  );

  const setField = (metric: Metric, key: "warn" | "critical", raw: string) => {
    // Keep an empty field empty rather than snapping it to 0 mid-typing; NaN is
    // caught by validation on save.
    const value = raw === "" ? NaN : Number(raw);
    setDraft((d) => ({ ...d, [metric]: { ...d[metric], [key]: value } }));
  };

  const handleSave = async () => {
    const problem = validateThresholds(draft);
    if (problem) {
      toast.error("Thresholds not saved", { description: problem });
      return;
    }

    setSaving(true);
    const supabase = createClient();
    const { error } = await supabase
      .from("app_settings")
      .update({
        cpu_warn: draft.cpu.warn,
        cpu_critical: draft.cpu.critical,
        memory_warn: draft.memory.warn,
        memory_critical: draft.memory.critical,
        disk_warn: draft.disk.warn,
        disk_critical: draft.disk.critical,
        updated_at: new Date().toISOString(),
      })
      .eq("id", 1);
    setSaving(false);

    // The toast reports what the database did. The previous version of this
    // page announced success unconditionally, next to a "Not yet persisted"
    // pill, having written nothing anywhere.
    if (error) {
      toast.error("Could not save thresholds", { description: error.message });
      return;
    }

    applyThresholds(draft);
    toast.success("Thresholds saved", {
      description: "Meters and the under-load count now use these values.",
    });
  };

  return (
    <div className="flex max-w-4xl flex-col gap-10">
      <div className="flex flex-col gap-4">
        <PageHeader title="Settings" />
        <SettingsTabs />
        <p className="text-[13px] leading-relaxed text-pretty text-muted-foreground">
          Fleet-wide configuration. Account credentials live under{"\u00a0"}Security.
        </p>
      </div>

      {/* GridPane integration — read-only by architecture, and now says so. */}
      <section className="flex flex-col gap-4">
        <PanelHeader title="GridPane integration" meta="API TOKEN" />
        <Panel className="p-5">
          <div className="flex max-w-2xl flex-col gap-3">
            <div className="flex items-start gap-2">
              <ShieldCheck
                size={14}
                strokeWidth={1.75}
                className="mt-0.5 shrink-0 text-primary"
              />
              <p className="text-[13px] leading-relaxed text-pretty">
                The token is stored as a Cloudflare Workers secret. It is never
                sent to the browser, so it cannot be shown or changed from this
                page.
              </p>
            </div>
            <p className="text-[12px] leading-relaxed text-pretty text-muted-foreground">
              Every GridPane request is proxied by an API route that reads the
              secret server-side. To rotate or revoke it, run:
            </p>
            <div className="rounded-lg bg-sunken p-4 font-mono">
              <div className="overflow-x-auto">
                <p className="whitespace-pre text-[11.5px] leading-relaxed text-on-sunken">
                  npx wrangler secret put GRIDPANE_API_TOKEN
                </p>
              </div>
            </div>
            <p className="text-[12px] leading-relaxed text-pretty text-muted-foreground">
              Revoking it stops telemetry sync and scheduled backups until a new
              token is{"\u00a0"}authorized.
            </p>
          </div>
        </Panel>
      </section>

      {/* Cloudflare — the token is deliberately NOT in the app; the panel says where it is. */}
      <CloudflareTokenPanel />

      {/* Telemetry thresholds — the real ones. */}
      <section className="flex flex-col gap-4">
        <PanelHeader
          title="Telemetry thresholds"
          meta={loaded ? "SAVED" : "LOADING"}
        />
        <Panel className="p-5">
          <p className="mb-5 max-w-2xl text-[13px] leading-relaxed text-pretty text-muted-foreground">
            Where each utilization meter turns amber and red, and what counts as
            a node &ldquo;under load&rdquo; on the overview. Applies across the
            whole{"\u00a0"}fleet.
          </p>

          <div className="flex flex-col gap-4">
            <div className="hidden grid-cols-[1fr_auto_auto] items-center gap-4 sm:grid">
              <span className="eyebrow text-faint">Metric</span>
              <span className="eyebrow w-[104px] text-faint">Warn at</span>
              <span className="eyebrow w-[104px] text-faint">Critical at</span>
            </div>

            {METRICS.map((metric) => (
              <div
                key={metric}
                className="grid grid-cols-1 items-center gap-2 border-t border-border pt-4 sm:grid-cols-[1fr_auto_auto] sm:gap-4 sm:border-0 sm:pt-0"
              >
                <span className="text-[13px] font-semibold">
                  {METRIC_LABELS[metric]}
                </span>
                <div className="flex items-center gap-2">
                  <span className="eyebrow w-16 shrink-0 text-faint sm:hidden">
                    Warn
                  </span>
                  <Input
                    aria-label={`${METRIC_LABELS[metric]} warning threshold`}
                    type="number"
                    min={0}
                    max={100}
                    value={Number.isFinite(draft[metric].warn) ? draft[metric].warn : ""}
                    onChange={(e) => setField(metric, "warn", e.target.value)}
                    className="w-full font-mono tabular-nums sm:w-[80px]"
                  />
                  <span className="eyebrow shrink-0 text-faint">%</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="eyebrow w-16 shrink-0 text-faint sm:hidden">
                    Critical
                  </span>
                  <Input
                    aria-label={`${METRIC_LABELS[metric]} critical threshold`}
                    type="number"
                    min={0}
                    max={100}
                    value={Number.isFinite(draft[metric].critical) ? draft[metric].critical : ""}
                    onChange={(e) => setField(metric, "critical", e.target.value)}
                    className="w-full font-mono tabular-nums sm:w-[80px]"
                  />
                  <span className="eyebrow shrink-0 text-faint">%</span>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </section>

      <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border pt-5">
        {dirty ? (
          <StatusPill tone="warn">Unsaved changes</StatusPill>
        ) : (
          <StatusPill tone="neutral">Saved</StatusPill>
        )}
        <Button
          variant="solid"
          className="touch-hit"
          onClick={handleSave}
          disabled={saving || !dirty || !loaded}
        >
          <Save size={14} strokeWidth={1.75} />
          {saving ? "Saving…" : "Save thresholds"}
        </Button>
      </div>
    </div>
  );
}
