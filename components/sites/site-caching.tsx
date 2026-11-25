"use client";

import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button, ConfirmDialog, IconButton, Input, PanelHeader, Select, StatusPill } from "@/components/ui";
import { cn } from "@/lib/utils";
import {
  type CachingAction,
  type CachingRouteAnswer,
  type CachingState,
  type PageCache,
  GRIDPANE_DEFAULT_TTL,
  PAGE_CACHE_LABEL,
  TTL_MAX,
  formatTtl,
} from "@/lib/site-caching";

/**
 * The site page's caching panel: page cache, its time to live, the Redis object cache,
 * cache clearing, and Object Cache Pro shown but not changed. Each change goes to GridPane
 * on its own (app/api/sites/[id]/caching/route.ts), which reads GridPane back afterwards;
 * the panel then shows what GridPane reports, not what was asked for.
 */
export function SiteCachingSection({
  siteId,
  siteUrl,
  readOnly,
  state,
  onState,
}: {
  siteId: number;
  siteUrl: string;
  /** Staging copies: GridPane's API cannot change them, and a change would hit the live site. */
  readOnly: boolean;
  state: CachingState;
  onState: (next: CachingState) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<CachingAction | null>(null);
  const [ttlText, setTtlText] = useState<string>(state.ttl == null ? "" : String(state.ttl));

  // A new value from GridPane replaces what is typed.
  const [seenTtl, setSeenTtl] = useState(state.ttl);
  if (!Object.is(seenTtl, state.ttl)) {
    setSeenTtl(state.ttl);
    setTtlText(state.ttl == null ? "" : String(state.ttl));
  }

  /** null when the change went through; otherwise what went wrong, for the dialog to show. */
  const send = async (action: CachingAction): Promise<string | null> => {
    setBusy(action.kind);
    try {
      const res = await fetch(`/api/sites/${siteId}/caching`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          action.kind === "page" ? { page: action.to }
          : action.kind === "ttl" ? { ttl: action.seconds }
          : action.kind === "objectCache" ? { objectCache: action.on }
          : { clear: action.what },
        ),
      });
      const answer: CachingRouteAnswer = await res.json().catch(() => ({}));
      if (answer.state) onState(answer.state);
      window.dispatchEvent(new Event("system_logs_updated"));
      if (!res.ok) {
        const said = answer.error || `GridPane did not make the change (${res.status}).`;
        toast.error(said);
        return said;
      }
      if (answer.confirmed === false) toast.warning(answer.message);
      else toast.success(answer.message || "Done.");
      return null;
    } catch {
      const said = "Network error: the change may not have reached GridPane. Press Sync to see what it reports.";
      toast.error(said);
      return said;
    } finally {
      setBusy(null);
    }
  };

  const ttlNumber = /^\d+$/.test(ttlText) ? Number(ttlText) : null;
  const ttlDirty = ttlText !== (state.ttl == null ? "" : String(state.ttl));
  const ttlValid = ttlNumber !== null && ttlNumber >= 1 && ttlNumber <= TTL_MAX;
  const disabled = readOnly || busy !== null;

  const pageValue = state.page ?? "off";
  const pageOptions: { value: PageCache | "off"; label: string; blocked: boolean }[] = [
    { value: "off", label: "Off", blocked: false },
    { value: "redis", label: "Redis", blocked: state.page === "fastcgi" },
    { value: "fastcgi", label: "FastCGI", blocked: state.page === "redis" },
  ];

  return (
    <section data-caching-panel>
      <PanelHeader title="Caching" meta="gridpane" />

      <div className="flex items-center justify-between gap-3 border-b border-border py-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground" title="Page cache (nginx)">page_cache</span>
        <div className="flex shrink-0 items-center gap-1.5">
          {busy === "page" && <Loader2 size={14} strokeWidth={1.75} className="animate-spin text-muted-foreground" aria-label="Sending to GridPane" />}
          <Select
            value={pageValue}
            disabled={disabled}
            onChange={(e) => {
              const to = e.target.value as PageCache | "off";
              if (to !== pageValue) setConfirm({ kind: "page", to });
            }}
            aria-label="Page cache"
            wrapperClassName="shrink-0"
            className="w-32 py-[5px] font-mono text-[12px]"
          >
            {pageOptions.map((o) => (
              <option key={o.value} value={o.value} disabled={o.blocked}>
                {o.blocked ? `${o.label} (off first)` : o.label}
              </option>
            ))}
          </Select>
        </div>
      </div>
      {state.page !== null && (
        <p className="text-pretty border-b border-border py-2 text-[11.5px] leading-relaxed text-muted-foreground">
          To change to {PAGE_CACHE_LABEL[state.page === "redis" ? "fastcgi" : "redis"]}, turn page caching off first, wait a
          few minutes, then turn it on: GridPane will not switch straight from one to the{" "}other.
        </p>
      )}

      <div className="flex items-center justify-between gap-3 border-b border-border py-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground" title="Page cache time to live, in seconds">cache_ttl</span>
        <div className="flex shrink-0 items-center gap-1.5">
          {(ttlDirty || busy === "ttl") && state.page !== null && (
            <IconButton
              label="Save the time to live"
              disabled={disabled || !ttlValid}
              onClick={() => ttlNumber !== null && send({ kind: "ttl", seconds: ttlNumber })}
              className="anim-fade h-[27px] w-[27px] border-primary/40 text-primary hover:text-primary"
            >
              {busy === "ttl" ? <Loader2 size={14} strokeWidth={1.75} className="animate-spin" /> : <Check size={14} strokeWidth={1.75} />}
            </IconButton>
          )}
          <Input
            type="text"
            inputMode="numeric"
            value={ttlText}
            disabled={disabled || state.page === null}
            onChange={(e) => { if (e.target.value === "" || /^\d+$/.test(e.target.value)) setTtlText(e.target.value); }}
            onKeyDown={(e) => { if (e.key === "Enter" && ttlDirty && ttlValid && ttlNumber !== null && state.page !== null) send({ kind: "ttl", seconds: ttlNumber }); }}
            aria-label="Page cache time to live, in seconds"
            className={cn("w-24 px-2 py-[5px] text-right font-mono text-[12px] tabular-nums", ttlDirty && "border-warning/60")}
          />
          <span className="eyebrow w-3 shrink-0 text-faint">s</span>
        </div>
      </div>
      <p className="text-pretty border-b border-border py-2 text-[11.5px] leading-relaxed text-muted-foreground">
        {state.page === null
          ? "Set while a page cache is on."
          : ttlDirty && ttlNumber !== null
            ? `${formatTtl(ttlNumber)}${ttlValid ? "" : ` (1 s to one year)`}.`
            : `${formatTtl(state.ttl)}. GridPane's guides start ${PAGE_CACHE_LABEL[state.page]} at ${formatTtl(GRIDPANE_DEFAULT_TTL[state.page])}.`}
      </p>

      <div className="flex items-center justify-between gap-3 border-b border-border py-3">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold">Redis object cache</div>
          <div className="text-pretty text-[12px] text-muted-foreground">GridPane&rsquo;s standard object cache</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusPill tone={state.objectCache ? "ok" : "neutral"}>
            {state.objectCache == null ? "Not reported" : state.objectCache ? "On" : "Off"}
          </StatusPill>
          {state.objectCache != null && (
            <Button size="sm" disabled={disabled} onClick={() => setConfirm({ kind: "objectCache", on: !state.objectCache })}>
              {busy === "objectCache" ? <Loader2 size={14} strokeWidth={1.75} className="animate-spin" /> : null}
              {state.objectCache ? "Turn off" : "Turn on"}
            </Button>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 border-b border-border py-3">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold">Object Cache Pro</div>
          <div className="text-pretty text-[12px] text-muted-foreground">Change in GridPane: its API has no setting for it</div>
        </div>
        <StatusPill tone={state.objectCachePro ? "ok" : "neutral"}>
          {state.objectCachePro == null ? "Not reported" : state.objectCachePro ? "On" : "Off"}
        </StatusPill>
      </div>

      <div className="flex flex-col gap-2 py-3">
        <span className="eyebrow text-faint">Clear cache</span>
        <div className="grid grid-cols-3 gap-2">
          {(["page", "object", "all"] as const).map((what) => (
            <Button key={what} size="sm" disabled={disabled} onClick={() => send({ kind: "clear", what })}>
              {busy === "clear" ? <Loader2 size={14} strokeWidth={1.75} className="animate-spin" /> : null}
              {what === "all" ? "All" : what === "page" ? "Page" : "Object"}
            </Button>
          ))}
        </div>
      </div>

      <p className="text-pretty mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
        {readOnly
          ? "Staging is read-only here: GridPane's API has no staging environment, and a change would hit the live site."
          : "Each change goes to GridPane on its own. GridPane limits how often one site's settings change, so leave a few minutes between changes."}
      </p>

      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm ? `${confirmLabel(confirm)} for ${siteUrl}?` : ""}
        confirmLabel={confirm ? confirmLabel(confirm) : ""}
        tone="default"
        onConfirm={async () => {
          if (!confirm) return;
          // The dialog shows this until it is closed; a toast at the corner may be gone by the time anyone looks.
          const failed = await send(confirm);
          if (failed) throw new Error(failed);
        }}
      >
        {confirm?.kind === "page" && confirm.to === "off" && <>GridPane stops serving cached pages for this site and reloads its web server. Every visit then runs WordPress.</>}
        {confirm?.kind === "page" && confirm.to !== "off" && <>GridPane turns on {PAGE_CACHE_LABEL[confirm.to]} page caching and reloads the site&rsquo;s web server. Logged-out visitors get cached pages. If the site runs the Nginx Helper plugin, its caching method should match.</>}
        {confirm?.kind === "objectCache" && confirm.on && <>GridPane installs and turns on the Redis object cache plugin for this site.</>}
        {confirm?.kind === "objectCache" && !confirm.on && <>GridPane turns off the Redis object cache for this site. Database queries are no longer cached between requests.</>}
      </ConfirmDialog>
    </section>
  );
}

/** The confirm button's words, and the dialog title's start: "Turn on FastCGI page caching". */
function confirmLabel(action: CachingAction): string {
  switch (action.kind) {
    case "page": return action.to === "off" ? "Turn off page caching" : `Turn on ${PAGE_CACHE_LABEL[action.to]} page caching`;
    case "objectCache": return `Turn ${action.on ? "on" : "off"} the Redis object cache`;
    case "ttl": return `Set the page cache time to live to ${formatTtl(action.seconds)}`;
    case "clear": return action.what === "all" ? "Clear all caches" : `Clear the ${action.what} cache`;
  }
}
