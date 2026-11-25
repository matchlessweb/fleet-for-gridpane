"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Copy, Loader2, ShieldBan, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button, Callout, CodeBlock, Copyable, Input, Modal, Segmented, StatusPill, useCopy } from "@/components/ui";
import {
  buildCloudflareInstructions,
  buildNginxDeny,
  buildUfwCommands,
  denyFilePath,
  LAYER_LABELS,
  layerCaveat,
  recommendLayer,
  validateIp,
  type BlockScope,
  type Layer,
} from "@/lib/ip-blocking";
import type { Database } from "@/lib/database.types";

type BlockRow = Database["public"]["Tables"]["ip_blocks"]["Row"];

const LAYER_OPTIONS: { value: Layer; label: string }[] = [
  { value: "ufw", label: "UFW" },
  { value: "nginx", label: "nginx" },
  { value: "cloudflare", label: "Cloudflare" },
];

export function IpBlockManager({
  open,
  onClose,
  scope,
  serverId,
  siteId,
  serverLabel,
  siteUrl,
  isProxied = false,
}: {
  open: boolean;
  onClose: () => void;
  scope: BlockScope;
  serverId?: number;
  siteId?: number;
  serverLabel?: string;
  siteUrl?: string;
  isProxied?: boolean;
}) {
  const [ip, setIp] = useState("");
  const [reason, setReason] = useState("");
  const [layer, setLayer] = useState<Layer | null>(null);

  const [rows, setRows] = useState<BlockRow[]>([]);
  /** False until the first fetch resolves; a reopen refreshes in the background. */
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState<number | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);
  /** The row most recently soft-deleted — its un-block command stays on screen. */
  const [justRemoved, setJustRemoved] = useState<BlockRow | null>(null);

  const supabase = useMemo(() => createClient(), []);

  const recommendation = recommendLayer({ isProxied, scope });
  // Until the operator picks a layer, the recommendation IS the selection.
  const activeLayer: Layer = layer ?? recommendation.layer;

  const validation = validateIp(ip);
  const address = validation.ok ? validation.normalized : "";
  const target = scope === "site" ? siteUrl ?? "site" : serverLabel ?? "server";

  /* ---------------- ledger ---------------- */

  // Declared inside the effect and awaited first: nothing sets state
  // synchronously on mount, so opening the modal is a single render.
  useEffect(() => {
    if (!open) return;
    if (scope === "site" ? !siteId : !serverId) return;
    let cancelled = false;

    async function loadRows() {
      let query = supabase.from("ip_blocks").select("*");
      query =
        scope === "site"
          ? query.eq("site_id", siteId!)
          : query.eq("server_id", serverId!).is("site_id", null);
      const { data, error } = await query.order("created_at", { ascending: false });
      if (cancelled) return;
      if (error) {
        toast.error("Could not load the block ledger.");
      } else {
        setRows((data ?? []) as BlockRow[]);
      }
      setLoaded(true);
    }
    loadRows();

    return () => {
      cancelled = true;
    };
  }, [open, supabase, scope, siteId, serverId]);

  const activeRows = rows.filter((r) => !r.removed_at);
  const removedRows = rows.filter((r) => r.removed_at);
  const visibleRows = showRemoved ? rows : activeRows;

  /* ---------------- generated output ---------------- */

  // Every nginx deny still standing for this target goes back into the file:
  // the include is rewritten whole, not appended to.
  const existingNginx = activeRows
    .filter((r) => r.layer === "nginx")
    .map((r) => ({ ip: r.ip, reason: r.reason }));

  const ufw = buildUfwCommands({ ip: address, comment: reason });
  const nginx = buildNginxDeny({
    ip: address,
    siteUrl: siteUrl ?? "",
    scope,
    existingIps: existingNginx,
    comment: reason,
  });
  const cloudflare = buildCloudflareInstructions(address);

  const { state: stepsState, copy: copySteps } = useCopy(cloudflare.steps.join("\n"));

  /* ---------------- actions ---------------- */

  const record = async () => {
    if (!validation.ok) return;
    setSaving(true);
    const { data, error } = await supabase
      .from("ip_blocks")
      .insert({
        ip: address,
        layer: activeLayer,
        scope,
        server_id: serverId ?? null,
        site_id: scope === "site" ? siteId ?? null : null,
        reason: reason.trim() || null,
      })
      .select()
      .single();

    if (error || !data) {
      toast.error(error?.message || "Could not record the block.");
    } else {
      setRows((prev) => [data as BlockRow, ...prev]);
      setIp("");
      setReason("");
      setJustRemoved(null);
      toast.success(`Recorded ${address} — run the command above to apply it.`);
    }
    setSaving(false);
  };

  const remove = async (row: BlockRow) => {
    setRemovingId(row.id);
    const stamp = new Date().toISOString();
    const { error } = await supabase
      .from("ip_blocks")
      .update({ removed_at: stamp })
      .eq("id", row.id);

    if (error) {
      toast.error(error.message || "Could not update the ledger.");
    } else {
      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, removed_at: stamp } : r)));
      setJustRemoved({ ...row, removed_at: stamp });
      toast.success(`${row.ip} marked removed — run the un-block command below.`);
    }
    setRemovingId(null);
  };

  /* ---------------- render ---------------- */

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Block an IP address"
      meta={target}
      className="max-w-2xl"
    >
      <div className="flex flex-col gap-5">
        <p className="text-pretty text-[12.5px] leading-relaxed text-muted-foreground">
          Three layers can stop a visitor, and they are not interchangeable.
          Enter the address and this picks the one that will actually work here,
          then writes the commands to run over SSH.
        </p>

        <Callout tone="note">
          The dashboard cannot read this server&apos;s firewall. Everything
          below is composed here for you to run — nothing is applied, and the
          ledger further down records only what was generated on this screen.
        </Callout>

        {/* ---- input ---- */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-1.5">
            <label className="eyebrow text-faint" htmlFor="ipb-address">
              IP address or CIDR
            </label>
            <Input
              id="ipb-address"
              value={ip}
              onChange={(e) => setIp(e.target.value)}
              placeholder="203.0.113.10"
              spellCheck={false}
              autoComplete="off"
              className="w-full font-mono"
            />
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <label className="eyebrow text-faint" htmlFor="ipb-reason">
              Reason <span className="normal-case tracking-normal">(optional)</span>
            </label>
            <Input
              id="ipb-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="xmlrpc brute force, 12 Aug"
              className="w-full"
            />
          </div>
        </div>

        {validation.error && (
          <p className="text-pretty text-[12.5px] leading-relaxed text-danger">
            {validation.error}
          </p>
        )}
        {validation.warning && (
          <Callout tone="warning" title="Check this">
            {validation.warning}
          </Callout>
        )}

        {/* ---- recommendation + layer choice ---- */}
        <div className="flex flex-col gap-3 border-t border-border pt-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="rulehead pb-0 border-b-0!">Layer</span>
            <StatusPill tone="ok">Recommended: {LAYER_LABELS[recommendation.layer]}</StatusPill>
          </div>
          <p className="text-pretty text-[12.5px] leading-relaxed text-muted-foreground">
            {recommendation.why}
          </p>

          <Segmented
            options={LAYER_OPTIONS}
            value={activeLayer}
            onChange={(v) => setLayer(v as Layer)}
          />

          <p className="text-pretty text-[12px] leading-relaxed text-faint">
            {layerCaveat(activeLayer, isProxied)}
          </p>

          {isProxied && activeLayer === "ufw" && (
            <Callout tone="danger" title="Will not work">
              {siteUrl ?? "This site"}{" "}is proxied through Cloudflare. Packets
              reach the origin from Cloudflare&apos;s edge, so a UFW ban on the
              visitor&apos;s own address never matches a single one of them.
              Use Cloudflare, or nginx deny — GridPane restores the real
              visitor IP for nginx.
            </Callout>
          )}
        </div>

        {/* ---- generated output ---- */}
        {!address ? (
          <p className="text-pretty text-[12px] leading-relaxed text-faint">
            Enter a valid address to generate the commands.
          </p>
        ) : activeLayer === "ufw" ? (
          <CodeBlock
            label="run over SSH"
            kind="command"
            code={ufw.script}
            copyLabel="Copy commands"
            footnote="UFW matches top-down and GridPane already allows 80,443, so an appended deny would sit below those allows and never fire. insert 1 is what makes the rule real."
          />
        ) : activeLayer === "nginx" ? (
          <CodeBlock
            label={nginx.path}
            kind="file"
            code={nginx.config}
            copyValue={nginx.script}
            copyLabel="Copy with commands"
            footnote="An update-safe include — GridPane stack updates will not overwrite it. Copy writes the whole file (every address still in the ledger), then runs nginx -t && gp ngx reload."
          />
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                <span className="font-semibold text-primary">Dashboard: </span>
                Cloudflare → Security → WAF → Tools
              </span>
              <Button size="sm" onClick={copySteps}>
                {stepsState === "copied" ? <Check size={14} strokeWidth={1.75} /> : <Copy size={14} strokeWidth={1.75} />}
                {stepsState === "copied" ? "Copied" : "Copy steps"}
              </Button>
            </div>
            <ol className="flex flex-col gap-1.5 rounded-md bg-sunken p-4">
              {cloudflare.steps.map((step, i) => (
                <li key={i} className="flex gap-2.5 text-pretty text-[12px] leading-relaxed text-on-sunken">
                  <span className="font-mono text-[11px] text-on-sunken-dim">{i + 1}</span>
                  <span className="min-w-0">{step}</span>
                </li>
              ))}
            </ol>
            <p className="text-pretty text-[11.5px] leading-relaxed text-faint">
              {cloudflare.note} No API token is used here — this stays a
              dashboard action on purpose.
            </p>
          </div>
        )}

        <Button
          variant="solid"
          onClick={record}
          disabled={!validation.ok || saving}
          className="w-full"
        >
          {saving ? (
            <Loader2 size={14} strokeWidth={1.75} className="animate-spin" />
          ) : (
            <ShieldBan size={14} strokeWidth={1.75} />
          )}
          {saving ? "Recording" : "Record this block"}
        </Button>

        {/* ---- ledger ---- */}
        <div className="flex flex-col gap-3 border-t border-border pt-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="rulehead pb-0 border-b-0!">Ledger</span>
            <StatusPill tone="neutral">Recorded here — not read from the server</StatusPill>
          </div>
          <p className="text-pretty text-[12px] leading-relaxed text-muted-foreground">
            A record of what was generated on this screen. It does not confirm
            that any rule is live on {target} — check with{" "}
            <Copyable value="sudo ufw status numbered" what="command" className="text-[11.5px]">
              sudo ufw status numbered
            </Copyable>{" "}or the
            include file itself.
          </p>

          {!loaded ? (
            <div className="flex items-center gap-2 py-4">
              <Loader2 size={14} strokeWidth={1.75} className="animate-spin text-primary" />
              <span className="eyebrow text-faint">Loading ledger</span>
            </div>
          ) : visibleRows.length === 0 ? (
            <p className="text-pretty text-[12.5px] leading-relaxed text-faint">
              Nothing recorded for {target} yet.
            </p>
          ) : (
            <ul className="flex flex-col">
              {visibleRows.map((row) => (
                <li
                  key={row.id}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border py-3"
                >
                  <Copyable value={row.ip} what="IP address" className="text-[12.5px] font-semibold">
                    {row.ip}
                  </Copyable>
                  <StatusPill tone={row.removed_at ? "neutral" : "danger"}>
                    {row.removed_at ? "Removed" : LAYER_LABELS[row.layer as Layer] ?? row.layer}
                  </StatusPill>
                  {row.reason && (
                    <span className="min-w-0 basis-full text-pretty text-[12px] leading-relaxed text-muted-foreground sm:basis-auto">
                      {row.reason}
                    </span>
                  )}
                  <span className="ml-auto font-mono text-[10.5px] text-faint">
                    {formatStamp(row.created_at)}
                  </span>
                  {!row.removed_at && (
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
                  )}
                </li>
              ))}
            </ul>
          )}

          {removedRows.length > 0 && (
            <button
              type="button"
              onClick={() => setShowRemoved((v) => !v)}
              className="touch-hit self-start eyebrow text-faint underline underline-offset-2 transition-colors duration-150 hover:text-foreground"
            >
              {showRemoved ? "Hide removed" : `Show removed (${removedRows.length})`}
            </button>
          )}
        </div>

        {/* ---- un-block command for the row just removed ---- */}
        {justRemoved && (
          <div className="flex flex-col gap-2 border-t border-border pt-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="rulehead pb-0 border-b-0!">Un-block {justRemoved.ip}</span>
              <StatusPill tone="warn">Still live on the server</StatusPill>
            </div>
            <p className="text-pretty text-[12px] leading-relaxed text-muted-foreground">
              The ledger entry is closed. The rule itself is not — run this to
              lift it.
            </p>
            <CodeBlock
              label={unblockLabel(justRemoved, scope, siteUrl)}
              kind={justRemoved.layer === "cloudflare" ? "dashboard" : "command"}
              code={unblockCode(justRemoved, scope, siteUrl)}
            />
          </div>
        )}

        <div className="flex justify-end border-t border-border pt-4">
          <Button variant="solid" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

function unblockCode(row: BlockRow, scope: BlockScope, siteUrl?: string): string {
  if (row.layer === "ufw") return buildUfwCommands({ ip: row.ip }).remove;
  if (row.layer === "nginx") {
    return buildNginxDeny({ ip: row.ip, siteUrl: siteUrl ?? "", scope }).removeScript;
  }
  return buildCloudflareInstructions(row.ip).removal;
}

function unblockLabel(row: BlockRow, scope: BlockScope, siteUrl?: string): string {
  if (row.layer === "nginx") return denyFilePath(scope, siteUrl ?? "");
  if (row.layer === "ufw") return "run over SSH";
  return "Cloudflare dashboard";
}

function formatStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d
    .toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
    .replace(",", " ·");
}
