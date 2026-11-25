"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  Bell,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  DatabaseBackup,
  Globe,
  Info,
  RefreshCw,
  TriangleAlert,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import {
  KIND_LABELS,
  clearDoneLogs,
  clearQuestion,
  countClearable,
  dayGroup,
  isOpenProblem,
  isProblem,
  isUnread,
  logBody,
  logKind,
  logStamp,
  logTitle,
  type DayGroup,
  type LogKind,
  type SystemLog,
} from "@/lib/action-logs";
import { ConfirmDialog, EmptyState, FilterPill, IconButton, PopoverSheet, StatusPill } from "@/components/ui";

type Filter = "all" | "problems" | LogKind;

const KIND_ORDER: LogKind[] = ["sync", "site", "backup", "upkeep", "other"];
const KIND_ICONS: Record<LogKind, LucideIcon> = {
  sync: RefreshCw,
  site: Globe,
  backup: DatabaseBackup,
  upkeep: Wrench,
  other: Info,
};
const GROUPS: DayGroup[] = ["Today", "Yesterday", "Earlier"];

type ActionLogsProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  logs: SystemLog[];
  setLogs: React.Dispatch<React.SetStateAction<SystemLog[]>>;
  sites: { id: number; url: string }[];
  servers: { id: number; label: string | null }[];
  /** An entry to open as the panel opens (the palette hands one over). */
  focusId: string | null;
  onFocusHandled: () => void;
};

/**
 * ActionLogs — the bell and its panel. Entries are grouped by day and filtered
 * by kind, a row opens in place, and "read" and "resolved" are separate: an
 * ordinary entry is read once opened, a problem stays open until someone marks
 * it resolved. A dropdown from `sm` up, a bottom sheet on phones.
 */
export function ActionLogs({ open, onOpenChange, logs, setLogs, sites, servers, focusId, onFocusHandled }: ActionLogsProps) {
  const supabase = createClient();
  const anchorRef = React.useRef<HTMLDivElement>(null);
  const [filter, setFilter] = React.useState<Filter>("all");
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [question, setQuestion] = React.useState<{ clearable: number; staying: number } | null>(null);

  const openProblems = logs.filter(isOpenProblem).length;
  const unread = logs.filter(isUnread).length;
  const attention = openProblems + unread;
  const close = React.useCallback(() => onOpenChange(false), [onOpenChange]);

  const setRead = React.useCallback(
    async (ids: string[], is_read: boolean) => {
      if (ids.length === 0) return;
      const before = logs;
      setLogs((prev) => prev.map((l) => (ids.includes(l.id) ? { ...l, is_read } : l)));
      const { error } = await supabase.from("system_logs").update({ is_read }).in("id", ids);
      if (error) {
        setLogs(before);
        toast.error(`That did not save: ${error.message}`);
      }
    },
    [logs, setLogs, supabase]
  );

  const toggle = (log: SystemLog) => {
    const opening = expanded !== log.id;
    setExpanded(opening ? log.id : null);
    // Opening an ordinary entry reads it. Opening a problem changes nothing.
    if (opening && isUnread(log)) void setRead([log.id], true);
  };

  // An entry handed over by the palette: show everything and open that one. The
  // view changes as the entry arrives, during render, not in an effect afterwards.
  const handed = open && focusId ? focusId : null;
  const [taken, setTaken] = React.useState<string | null>(null);
  if (handed !== taken) {
    setTaken(handed);
    if (handed) {
      setFilter("all");
      setExpanded(handed);
    }
  }
  React.useEffect(() => {
    if (!handed) return;
    onFocusHandled();
    const frame = requestAnimationFrame(() => document.getElementById(`log-${handed}`)?.scrollIntoView({ block: "nearest" }));
    return () => cancelAnimationFrame(frame);
  }, [handed, onFocusHandled]);

  const askToClear = async () => {
    try {
      const counts = await countClearable(supabase);
      if (counts.clearable === 0) {
        toast.message("Nothing to clear. Only read and resolved entries are deleted.");
        return;
      }
      setQuestion(counts);
    } catch (e) {
      toast.error(`Could not count the entries: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  };

  const clear = async () => {
    await clearDoneLogs(supabase);
    setLogs((prev) => prev.filter((l) => !l.is_read));
    window.dispatchEvent(new Event("system_logs_updated"));
    toast.success(`Deleted ${question?.clearable ?? 0} ${question?.clearable === 1 ? "entry" : "entries"}.`);
  };

  const wording = question ? clearQuestion(question.clearable, question.staying) : null;

  return (
    <div className="relative" ref={anchorRef}>
      <IconButton
        id="global-notif-bell"
        label={attention > 0 ? `Action logs, ${attention} need a look` : "Action logs"}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className="relative"
      >
        <Bell size={14} strokeWidth={1.75} />
        {attention > 0 && (
          <span
            aria-hidden="true"
            className={cn("anim-blink absolute right-[7px] top-[7px] h-[6px] w-[6px] rounded-full", openProblems > 0 ? "bg-danger" : "bg-warning")}
          />
        )}
      </IconButton>

      <PopoverSheet open={open} onClose={close} anchorRef={anchorRef} label="Action logs" className="w-[420px]">
        <LogPanel
          logs={logs}
          sites={sites}
          servers={servers}
          filter={filter}
          setFilter={setFilter}
          expanded={expanded}
          toggle={toggle}
          setRead={setRead}
          askToClear={askToClear}
          close={close}
        />
      </PopoverSheet>

      <ConfirmDialog
        open={question !== null}
        onClose={() => setQuestion(null)}
        title={wording?.title ?? ""}
        confirmLabel={wording?.confirm ?? ""}
        onConfirm={clear}
      >
        {wording?.body}
      </ConfirmDialog>
    </div>
  );
}

function LogPanel({
  logs,
  sites,
  servers,
  filter,
  setFilter,
  expanded,
  toggle,
  setRead,
  askToClear,
  close,
}: {
  logs: SystemLog[];
  sites: ActionLogsProps["sites"];
  servers: ActionLogsProps["servers"];
  filter: Filter;
  setFilter: (f: Filter) => void;
  expanded: string | null;
  toggle: (log: SystemLog) => void;
  setRead: (ids: string[], is_read: boolean) => Promise<void>;
  askToClear: () => void;
  close: () => void;
}) {
  const [now] = React.useState(() => new Date());

  const kinds = React.useMemo(() => {
    const counts = new Map<LogKind, number>();
    for (const l of logs) counts.set(logKind(l), (counts.get(logKind(l)) ?? 0) + 1);
    return KIND_ORDER.filter((k) => counts.has(k)).map((k) => ({ kind: k, count: counts.get(k) ?? 0 }));
  }, [logs]);
  const problemCount = logs.filter(isProblem).length;

  // A filter whose last entry was cleared falls back to everything.
  const active: Filter = filter === "all" || filter === "problems" || kinds.some((k) => k.kind === filter) ? filter : "all";
  const shown = logs.filter((l) => (active === "all" ? true : active === "problems" ? isProblem(l) : logKind(l) === active));
  const grouped = GROUPS.map((g) => ({ group: g, items: shown.filter((l) => dayGroup(l.created_at, now) === g) })).filter((g) => g.items.length > 0);

  const unreadShown = shown.filter(isUnread);
  const openShown = shown.filter(isOpenProblem);
  const openTotal = logs.filter(isOpenProblem).length;
  const unreadTotal = logs.filter(isUnread).length;
  const summary = [openTotal > 0 ? `${openTotal} open` : null, unreadTotal > 0 ? `${unreadTotal} new` : null].filter(Boolean).join(" · ");

  const targetFor = (log: SystemLog) => {
    if (!log.site_url) return null;
    const site = sites.find((s) => s.url === log.site_url);
    if (site) return { href: `/sites/${site.id}`, label: "Open site" };
    const server = servers.find((s) => s.label === log.site_url);
    if (server) return { href: `/servers/${server.id}`, label: "Open server" };
    return null;
  };

  const textAction = "eyebrow touch-hit whitespace-nowrap text-muted-foreground transition-colors duration-150 hover:text-foreground";

  return (
    <>
      <div className="shrink-0 px-4 pt-1.5 sm:pt-3.5">
        {/* One row from sm up. On phones the title and Close share a row and
            the counts and the action sit under them: all five do not fit at 320. */}
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b-2 border-foreground pb-2.5">
          <h2 className="rulehead whitespace-nowrap border-b-0! pb-0">Action logs</h2>
          <IconButton label="Close" keys="Esc" onClick={close} className="ml-auto sm:hidden">
            <X size={14} strokeWidth={1.75} />
          </IconButton>
          <div className="flex min-w-0 items-center gap-3 max-sm:basis-full max-sm:justify-between sm:flex-1">
            <span className="eyebrow whitespace-nowrap text-muted-foreground">{summary || "Nothing open or new"}</span>
            {active === "problems" && openShown.length > 0 ? (
              <button type="button" className={cn(textAction, "sm:ml-auto")} onClick={() => void setRead(openShown.map((l) => l.id), true)}>
                Resolve all
              </button>
            ) : (
              unreadShown.length > 0 && (
                <button type="button" className={cn(textAction, "sm:ml-auto")} onClick={() => void setRead(unreadShown.map((l) => l.id), true)}>
                  Mark all read
                </button>
              )
            )}
          </div>
        </div>
      </div>

      {logs.length > 0 && (
        <div role="group" aria-label="Filter by kind" className="hide-scrollbar flex shrink-0 gap-1.5 px-4 py-2.5 max-sm:overflow-x-auto sm:flex-wrap">
          <FilterPill active={active === "all"} count={logs.length} onClick={() => setFilter("all")}>
            All
          </FilterPill>
          <FilterPill active={active === "problems"} count={problemCount} onClick={() => setFilter("problems")}>
            Errors
          </FilterPill>
          {kinds.map(({ kind, count }) => (
            <FilterPill key={kind} active={active === kind} count={count} onClick={() => setFilter(kind)}>
              {KIND_LABELS[kind]}
            </FilterPill>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-border">
        {logs.length === 0 ? (
          <EmptyState icon={Bell} title="No entries" hint="Syncs, site changes and failures are recorded here." className="py-10" />
        ) : shown.length === 0 ? (
          <EmptyState
            title={active === "problems" ? "No errors or warnings" : "Nothing of this kind"}
            hint={active === "problems" ? "Nothing in the log has failed." : undefined}
            className="py-10"
          />
        ) : (
          grouped.map(({ group, items }) => (
            <section key={group} aria-label={group}>
              <h3 className="eyebrow sticky top-0 z-[1] border-b border-border bg-panel-2 px-4 py-1.5 text-muted-foreground">{group}</h3>
              <ul>
                {items.map((log) => {
                  const problem = isProblem(log);
                  const openProblem = isOpenProblem(log);
                  const fresh = isUnread(log);
                  const isOpen = expanded === log.id;
                  const Icon = log.level === "error" ? CircleAlert : log.level === "warning" ? TriangleAlert : log.level === "success" ? CircleCheck : KIND_ICONS[logKind(log)];
                  const target = targetFor(log);
                  return (
                    <li
                      key={log.id}
                      id={`log-${log.id}`}
                      className={cn(
                        "border-b border-border last:border-0",
                        openProblem ? (log.level === "error" ? "bg-danger/8" : "bg-warning/8") : fresh && "bg-primary/8"
                      )}
                    >
                      {/* The whole row is the button: it lies under the text, and
                          the check and the chevron sit on top of it at the right. */}
                      <div className="relative">
                        <button
                          type="button"
                          aria-expanded={isOpen}
                          aria-controls={`log-${log.id}-detail`}
                          aria-labelledby={`log-${log.id}-label`}
                          onClick={() => toggle(log)}
                          className="absolute inset-0 transition-colors duration-150 hover:bg-panel-2/60 focus-visible:-outline-offset-2"
                        />
                        <div className="pointer-events-none relative flex items-start gap-2.5 py-2.5 pl-4 pr-3.5">
                          <Icon
                            size={14}
                            strokeWidth={1.75}
                            aria-hidden="true"
                            className={cn(
                              "mt-[3px] shrink-0",
                              log.level === "error" ? "text-danger" : log.level === "warning" ? "text-warning" : log.level === "success" ? "text-primary" : "text-muted-foreground"
                            )}
                          />
                          <span id={`log-${log.id}-label`} className="min-w-0 flex-1">
                            <span className="flex items-baseline gap-2">
                              {/* Titles stay in ink. The state is the row's tint, the icon
                                  and this tag: red and green type on the tints measured under 4.5:1. */}
                              <span className="min-w-0 truncate text-[12.5px] font-semibold">{logTitle(log)}</span>
                              {openProblem || fresh ? (
                                <span className="eyebrow inline-flex shrink-0 items-center gap-1.5">
                                  <span
                                    aria-hidden="true"
                                    className={cn("h-[5px] w-[5px] rounded-full", openProblem ? (log.level === "error" ? "bg-danger" : "bg-warning") : "bg-primary")}
                                  />
                                  {openProblem ? "Open" : "New"}
                                </span>
                              ) : (
                                problem && <span className="eyebrow shrink-0 text-muted-foreground">Resolved</span>
                              )}
                            </span>
                            <span className="mt-0.5 block truncate font-mono text-[10.5px] text-muted-foreground">
                              {log.site_url ? `${log.site_url} · ` : ""}
                              {logStamp(log.created_at, group)}
                            </span>
                            {!isOpen && <span className="mt-0.5 block truncate text-[12px] text-muted-foreground">{logBody(log)}</span>}
                          </span>
                          {(openProblem || fresh) && (
                            <IconButton
                              label={openProblem ? "Mark resolved" : "Mark as read"}
                              onClick={() => void setRead([log.id], true)}
                              className="pointer-events-auto -my-1.5 shrink-0 border-transparent bg-transparent hover:border-line-strong hover:bg-panel"
                            >
                              <Check size={14} strokeWidth={1.75} />
                            </IconButton>
                          )}
                          <ChevronDown
                            size={14}
                            strokeWidth={1.75}
                            aria-hidden="true"
                            className={cn("mt-[3px] shrink-0 text-muted-foreground transition-transform duration-150", isOpen && "rotate-180")}
                          />
                        </div>
                      </div>
                      {isOpen && (
                        <div id={`log-${log.id}-detail`} className="px-4 pb-3 pl-[42px]">
                          <p className="whitespace-pre-wrap break-words rounded-md bg-panel-2 p-3 font-mono text-[11px] leading-relaxed">{logBody(log)}</p>
                          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
                            <StatusPill tone={log.level === "error" ? "danger" : log.level === "warning" ? "warn" : log.level === "success" ? "ok" : "neutral"}>
                              {log.level}
                            </StatusPill>
                            <span className="font-mono text-[10.5px] text-muted-foreground">{new Date(log.created_at).toLocaleString()}</span>
                            <span className="ml-auto flex items-center gap-3">
                              {target && (
                                <Link href={target.href} onClick={close} className={textAction}>
                                  {target.label}
                                </Link>
                              )}
                              {problem && (
                                <button type="button" className={textAction} onClick={() => void setRead([log.id], !log.is_read)}>
                                  {openProblem ? "Mark resolved" : "Reopen"}
                                </button>
                              )}
                            </span>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </div>

      {logs.length > 0 && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-4 pb-[calc(10px+env(safe-area-inset-bottom))] pt-2.5 sm:pb-2.5">
          <span className="font-mono text-[10.5px] text-muted-foreground">
            {logs.length >= 100 ? "Latest 100 entries" : `${logs.length} ${logs.length === 1 ? "entry" : "entries"}`}
          </span>
          <button type="button" onClick={askToClear} className="eyebrow touch-hit whitespace-nowrap text-muted-foreground transition-colors duration-150 hover:text-danger">
            Clear read and resolved…
          </button>
        </div>
      )}
    </>
  );
}
