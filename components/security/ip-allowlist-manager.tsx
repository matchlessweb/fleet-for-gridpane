"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button, Callout, CodeBlock, Copyable, Input, Modal, Segmented, StatusPill } from "@/components/ui";
import {
  allowLayerNote,
  buildCloudflareAllowInstructions,
  buildFail2banIgnoreip,
  buildUfwAllow,
  dynamicAddressWarning,
  IGNOREIP_PATH,
  validateIp,
  type AllowLayer,
  type AllowScope,
} from "@/lib/ip-allowlist";
import type { Database } from "@/lib/database.types";
import { fleetConfig } from "@/fleet.config";

type AllowRow = Database["public"]["Tables"]["ip_allowlist"]["Row"];

const LAYER_OPTIONS: { value: AllowLayer; label: string }[] = [
  { value: "fail2ban", label: "Fail2Ban" },
  { value: "ufw", label: "UFW" },
  { value: "cloudflare", label: "Cloudflare" },
];

/**
 * Generates the never-block rules for an operator address and records them.
 *
 * Deliberately the mirror of IpBlockManager: same honesty box, same
 * generate-and-copy stance, same soft-delete ledger. Nothing is applied to a
 * server from here — the app has no channel to the boxes, by design.
 */
export function IpAllowlistManager({
  open,
  onClose,
  scope: defaultScope = "global",
  serverId,
  siteId,
  serverLabel,
  siteUrl,
  initialIp,
  onRecorded,
}: {
  open: boolean;
  onClose: () => void;
  scope?: AllowScope;
  serverId?: number;
  siteId?: number;
  serverLabel?: string;
  siteUrl?: string;
  /** Fills the address field when the form opens empty ("Allow my current IP"). */
  initialIp?: string;
  /** Lets the parent refresh the visible panel once something is recorded. */
  onRecorded?: () => void;
}) {
  const [ip, setIp] = useState("");
  const [label, setLabel] = useState("");
  const [scope, setScope] = useState<AllowScope>(defaultScope);
  const [layer, setLayer] = useState<AllowLayer>("fail2ban");

  // Seed the address once per opening, and only into an empty field. The
  // address can arrive a moment after the form opens (it is looked up).
  const [seeded, setSeeded] = useState<string | null>(null);
  if (!open && seeded !== null) setSeeded(null);
  if (open && initialIp && seeded !== initialIp) {
    setSeeded(initialIp);
    if (ip === "") setIp(initialIp);
  }

  const [rows, setRows] = useState<AllowRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState<number | null>(null);

  const supabase = useMemo(() => createClient(), []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("ip_allowlist")
        .select("*")
        .is("removed_at", null)
        .order("created_at", { ascending: false });
      if (cancelled) return;
      if (error) {
        console.error("Allowlist fetch failed", error);
        toast.error("Could not load the allowlist.");
      }
      setRows(data ?? []);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, supabase]);

  const validation = validateIp(ip);
  const drift = dynamicAddressWarning(validation, label);
  const addr = validation.ok ? validation.normalized : "";

  // Every still-active entry goes into the generated file — the whole point of a
  // rewrite-in-full config is that what you paste equals what you see.
  const activeIps = useMemo(() => {
    const all = rows.map((r) => r.ip);
    return addr ? [...all, addr] : all;
  }, [rows, addr]);

  const fail2ban = buildFail2banIgnoreip({ ips: activeIps, comment: "operator allowlist" });
  const ufw = addr ? buildUfwAllow({ ip: addr, comment: label }) : null;
  const cloudflare = addr ? buildCloudflareAllowInstructions(addr) : null;

  const record = async () => {
    if (!validation.ok || !label.trim()) return;
    setSaving(true);
    const { data, error } = await supabase
      .from("ip_allowlist")
      .insert({
        ip: validation.normalized,
        label: label.trim(),
        scope,
        server_id: scope === "server" ? serverId ?? null : null,
        site_id: scope === "site" ? siteId ?? null : null,
        layers: [layer],
      })
      .select()
      .single();
    setSaving(false);

    if (error) {
      console.error("Allowlist insert failed", error);
      toast.error("Could not record that entry.");
      return;
    }
    setRows((prev) => [data as AllowRow, ...prev]);
    setIp("");
    setLabel("");
    onRecorded?.();
    toast.success(`Recorded ${validation.normalized} — run the commands above to apply it.`);
  };

  const remove = async (row: AllowRow) => {
    setRemovingId(row.id);
    const { error } = await supabase
      .from("ip_allowlist")
      .update({ removed_at: new Date().toISOString() })
      .eq("id", row.id);
    setRemovingId(null);
    if (error) {
      console.error("Allowlist remove failed", error);
      toast.error("Could not remove that entry.");
      return;
    }
    setRows((prev) => prev.filter((r) => r.id !== row.id));
    onRecorded?.();
    toast.success(`${row.ip} removed from the ledger — re-run the Fail2Ban file to apply it.`);
  };

  const scopeOptions = [
    { value: "global", label: "Whole fleet" },
    ...(serverId ? [{ value: "server", label: "This server" }] : []),
    ...(siteId ? [{ value: "site", label: "This site" }] : []),
  ];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Never block this address"
      meta={serverLabel ?? siteUrl}
      className="max-w-2xl"
    >
      <div className="flex flex-col gap-5">
        <p className="text-pretty text-[12.5px] leading-relaxed text-muted-foreground">
          Addresses you work from — an office range, home, a hotspot — that must
          survive every layer of blocking. Fail2Ban is the one that matters most:
          it stops a ban being created at all, so nothing ever reaches the edge.
        </p>

        <Callout tone="note">
          Nothing here is applied. The dashboard composes the rules and records
          what you intended; the fleet agent then reports back whether they are
          genuinely in force, and the Firewall panel shows both.
        </Callout>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="eyebrow text-faint">IP or CIDR</span>
            <Input
              value={ip}
              onChange={(e) => setIp(e.target.value)}
              placeholder="198.51.100.0/24"
              spellCheck={false}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="eyebrow text-faint">Label</span>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={fleetConfig.placeholders.allowlistLabel}
            />
          </label>
        </div>

        {validation.error && (
          <p className="text-[12px] leading-relaxed text-danger">{validation.error}</p>
        )}
        {validation.warning && (
          <p className="text-[12px] leading-relaxed text-warning">{validation.warning}</p>
        )}
        {drift && <p className="text-[12px] leading-relaxed text-warning">{drift}</p>}

        {scopeOptions.length > 1 && (
          <div className="flex flex-col gap-2">
            <span className="eyebrow text-faint">Applies to</span>
            <Segmented
              options={scopeOptions}
              value={scope}
              onChange={(v) => setScope(v as AllowScope)}
            />
            <p className="text-pretty text-[11.5px] leading-relaxed text-faint">
              An address you actually work from should stay fleet-wide — narrowing it
              means the next server you add will not know about it.
            </p>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <span className="eyebrow text-faint">Layer</span>
          <Segmented
            options={LAYER_OPTIONS}
            value={layer}
            onChange={(v) => setLayer(v as AllowLayer)}
          />
          <p className="text-pretty text-[12px] leading-relaxed text-muted-foreground">
            {allowLayerNote(layer)}
          </p>
        </div>

        {layer === "fail2ban" && (
          <>
            <CodeBlock
              label={IGNOREIP_PATH}
              kind="file"
              code={fail2ban.config}
              copyValue={fail2ban.script}
              copyLabel="Copy setup"
              footnote="A .local drop-in wins over jail.local and survives package updates. ignoreip REPLACES the inherited value rather than extending it, so loopback is written in explicitly — without it the server can ban itself."
            />
            <p className="text-pretty text-[11.5px] leading-relaxed text-faint">
              The file is rewritten in full from every active entry, so what you paste
              always equals the ledger below. Copy Setup adds the reload and a{" "}
              <Copyable value="fail2ban-client get sshd ignoreip" what="command" className="text-[11px] text-muted-foreground">
                fail2ban-client get sshd ignoreip
              </Copyable>{" "}
              to confirm what actually took effect.
            </p>
          </>
        )}

        {layer === "ufw" && ufw && (
          <CodeBlock
            label="ufw allow"
            kind="command"
            code={ufw.script}
            copyLabel="Copy commands"
            footnote="Both this and the block generator insert at position 1, so whichever ran last sits on top. If a deny covering this address was added afterwards, it wins — ufw status numbered is the only way to see the real order."
          />
        )}

        {layer === "cloudflare" && cloudflare && (
          <div className="flex flex-col gap-2">
            <span className="font-mono text-[11px] text-muted-foreground">
              <span className="font-semibold text-primary">Dashboard: </span>
              Security → WAF → Tools → IP Access Rules
            </span>
            <ol className="flex flex-col gap-1.5 rounded-md bg-sunken p-4">
              {cloudflare.steps.map((step, i) => (
                <li key={i} className="flex gap-2.5 font-mono text-[11px] leading-relaxed text-on-sunken">
                  <span className="text-on-sunken-dim">{i + 1}.</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
            <p className="text-pretty text-[11.5px] leading-relaxed text-faint">{cloudflare.note}</p>
          </div>
        )}

        <div className="flex justify-end">
          <Button
            variant="solid"
            onClick={record}
            disabled={!validation.ok || !label.trim() || saving}
            className="touch-hit"
          >
            {saving ? <Loader2 size={14} strokeWidth={1.75} className="animate-spin" /> : <ShieldCheck size={14} strokeWidth={1.75} />}
            Record this entry
          </Button>
        </div>

        {/* ---------------- Ledger ---------------- */}
        <div className="flex flex-col gap-2 border-t border-border pt-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="rulehead pb-0 border-b-0!">Allowlist</span>
            <StatusPill tone="neutral">Recorded here — verified by the agent</StatusPill>
          </div>
          <p className="text-pretty text-[12px] leading-relaxed text-muted-foreground">
            Every entry across the fleet, because the Fail2Ban file is written from all
            of them at once. The Firewall panel on each server shows which are confirmed
            in force there.
          </p>

          {!loaded ? (
            <div className="flex items-center gap-2 py-3 text-muted-foreground">
              <Loader2 size={14} strokeWidth={1.75} className="animate-spin" />
              <span className="text-[12px]">Loading allowlist</span>
            </div>
          ) : rows.length === 0 ? (
            <p className="py-3 text-[12px] text-faint">Nothing recorded yet.</p>
          ) : (
            <ul className="flex flex-col">
              {rows.map((row) => (
                <li
                  key={row.id}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border py-3"
                >
                  <Copyable value={row.ip} what="IP address" className="text-[12.5px] font-semibold">
                    {row.ip}
                  </Copyable>
                  <span className="text-[12px] text-muted-foreground">{row.label}</span>
                  <StatusPill tone="neutral">
                    {row.scope === "global" ? "Fleet-wide" : row.scope === "site" ? "Site" : "Server"}
                  </StatusPill>
                  <span className="ml-auto font-mono text-[10.5px] text-faint">
                    {formatStamp(row.created_at)}
                  </span>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={removingId === row.id}
                    onClick={() => remove(row)}
                  >
                    {removingId === row.id ? (
                      <Loader2 size={14} strokeWidth={1.75} className="animate-spin" />
                    ) : (
                      <Trash2 size={14} strokeWidth={1.75} />
                    )}
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
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

function formatStamp(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
