"use client";

import { useState } from "react";
import { Button, Callout, CodeBlock, Modal, Segmented, StatusPill } from "@/components/ui";
import {
  buildInstallScript,
  buildLogrotateConfig,
  buildReclaimScript,
  CONFIG_PATH,
  describeWindow,
  type Cadence,
  type RetentionPlan,
} from "@/lib/logrotate-7g";

export function LogRetentionGenerator({
  open,
  onClose,
  serverLabel,
}: {
  open: boolean;
  onClose: () => void;
  serverLabel: string;
}) {
  // Daily / keep 30 is the default. Monthly leaves a server's logs sitting
  // uncompressed for up to a month, with no single file large enough to trip the
  // size ceiling. Thirty compressed dailies cost less disk than one un-rotated
  // month and keep enough history to spot a recurring attacker.
  const [cadence, setCadence] = useState<Cadence>("daily");
  const [keep, setKeep] = useState(30);
  const [compress, setCompress] = useState(true);
  const [maxsizeMb, setMaxsizeMb] = useState<number | null>(50);
  const [reclaim, setReclaim] = useState<"rotate" | "truncate">("rotate");

  const plan: RetentionPlan = { cadence, keep, compress, maxsizeMb };
  const config = buildLogrotateConfig(plan);
  const install = buildInstallScript(plan);
  const reclaimScript = buildReclaimScript(reclaim);

  return (
    <Modal open={open} onClose={onClose} title="7G log retention" meta={serverLabel}>
      <div className="flex flex-col gap-5">
        <p className="text-pretty text-[12.5px] leading-relaxed text-muted-foreground">
          GridPane rotates <span className="font-mono">debug.log</span> and{" "}
          <span className="font-mono">gp-cron.log</span> but ships no rule for{" "}
          <span className="font-mono">7g.log</span>, so the WAF log grows until
          the disk does. This writes the missing rule.
        </p>

        <Callout tone="note">
          The dashboard cannot read this server, so it does not know what is
          installed there now — it composes commands for you to run over SSH.
        </Callout>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <span className="eyebrow text-faint">Rotate</span>
            <Segmented
              options={[
                { value: "daily", label: "Daily" },
                { value: "weekly", label: "Weekly" },
                { value: "monthly", label: "Monthly" },
              ]}
              value={cadence}
              onChange={(v) => setCadence(v as Cadence)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <span className="eyebrow text-faint">Compress archives</span>
            <Segmented
              options={[
                { value: "yes", label: "Yes" },
                { value: "no", label: "No" },
              ]}
              value={compress ? "yes" : "no"}
              onChange={(v) => setCompress(v === "yes")}
            />
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <span className="eyebrow text-faint">Rotate early past</span>
          <Segmented
            options={[
              { value: "50", label: "50 MB" },
              { value: "200", label: "200 MB" },
              { value: "off", label: "No ceiling" },
            ]}
            value={maxsizeMb ? String(maxsizeMb) : "off"}
            onChange={(v) => setMaxsizeMb(v === "off" ? null : Number(v))}
          />
          <p className="text-pretty text-[11.5px] leading-relaxed text-faint">
            A safety valve for traffic bursts: rotates as soon as a log passes
            this size, without waiting for the schedule. GridPane pairs its own
            debug.log rule with a 50 MB ceiling for the same reason.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <label className="eyebrow text-faint" htmlFor="keep-range">
              Keep {keep} {cadence === "daily" ? "day" : cadence === "weekly" ? "week" : "month"}
              {keep === 1 ? "" : "s"} of archives
            </label>
            <StatusPill tone="ok">{describeWindow(plan)}</StatusPill>
          </div>
          <input
            id="keep-range"
            type="range"
            min={1}
            max={60}
            value={keep}
            onChange={(e) => setKeep(Number(e.target.value))}
            className="w-full accent-primary"
          />
        </div>

        <div className="flex flex-col gap-2">
          <span className="rulehead pb-0 border-b-0!">Step 1 — install the rule</span>
          <p className="text-pretty text-[12.5px] leading-relaxed text-muted-foreground">
            Run this and you are done: the rule is live and the system&apos;s
            daily logrotate picks it up on schedule. Nothing rotates yet.
          </p>
        </div>
        <CodeBlock
          label={CONFIG_PATH}
          kind="file"
          code={config}
          copyValue={install}
          copyLabel="Copy setup"
        />
        <p className="text-pretty text-[11.5px] leading-relaxed text-faint">
          Copy Setup gives you the write command plus{" "}
          <span className="font-mono text-muted-foreground">logrotate -d</span>,
          a dry run that reports what would happen without touching a file.
          Rotation uses <span className="font-mono text-muted-foreground">copytruncate</span> so
          each site keeps its own log owner — GridPane assigns those per site for
          SFTP access, and recreating the files as root would break it.
        </p>

        <div className="flex flex-col gap-3 border-t border-border pt-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="rulehead pb-0 border-b-0!">Step 2 — reclaim space now</span>
            <StatusPill tone="neutral">Optional</StatusPill>
          </div>
          <p className="text-pretty text-[12.5px] leading-relaxed text-muted-foreground">
            Step 1 governs what happens from here; it does not shrink the log
            that already exists. Because <span className="font-mono">7g.log</span>{" "}
            is one long append-only file, existing history is reclaimed whole,
            not by date.
          </p>
          <Segmented
            options={[
              { value: "rotate", label: "Archive it" },
              { value: "truncate", label: "Discard it" },
            ]}
            value={reclaim}
            onChange={(v) => setReclaim(v as "rotate" | "truncate")}
          />
          <p className="text-pretty text-[12px] leading-relaxed text-muted-foreground">
            {reclaim === "rotate"
              ? "Compresses the current log into the first archive and starts a fresh one. History is kept and ages out on the schedule above. Run step 1 first — this command calls the rule file it writes."
              : "Empties the logs immediately. Fastest reclaim, and every existing 7G record on this server is gone for good. Works with or without step 1."}
          </p>
          <CodeBlock
            label={reclaim === "rotate" ? "force first rotation" : "empty the logs"}
            kind={reclaim === "truncate" ? "destructive" : "command"}
            code={reclaimScript}
            copyLabel="Copy commands"
          />
        </div>

        <div className="flex justify-end border-t border-border pt-4">
          <Button variant="solid" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </Modal>
  );
}
