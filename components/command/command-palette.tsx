"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Activity,
  Bell,
  Cloud,
  Contrast,
  Copy,
  DatabaseBackup,
  Globe,
  Layers,
  LayoutGrid,
  LogOut,
  RefreshCw,
  ScrollText,
  Search,
  Server as ServerIcon,
  Settings,
  ShieldCheck,
  ShieldHalf,
  User,
  CalendarClock,
  type LucideIcon,
} from "lucide-react";
import { cn, getProviderName } from "@/lib/utils";
import { formatOsVersion } from "@/lib/os-version";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/database.types";
import { logTitle } from "@/lib/action-logs";
import { Button, Kbd, Meter, StatusPill, claimOverlay, releaseOverlay } from "@/components/ui";
import { index, markRuns, search, type Entry, type Kind } from "./engine";

/**
 * The command palette: one box that finds a server, a site, a page or a log
 * entry, and runs the handful of things that used to need a trip to a button.
 *
 * It is the palette from the operator's own sites, rebuilt in
 * React on the Ledger tokens: the same matcher (engine.ts), groups capped at
 * four with a "Show all" row, a gray completion you accept with Tab, and a
 * preview pane from tablet width up. On a phone it is a full-screen sheet.
 *
 * A native <dialog> does the modal work (focus stays inside, Esc closes,
 * focus goes back to what opened it). Its content mounts only while it is
 * open, so every opening starts clean.
 */

type Server = Database["public"]["Tables"]["servers"]["Row"];
type Site = Database["public"]["Tables"]["sites"]["Row"] & {
  servers: { label: string | null; ip: string | null } | null;
};
type SystemLog = Database["public"]["Tables"]["system_logs"]["Row"];

export type PaletteHandlers = {
  sync: () => void;
  allowMyIp: () => void;
  toggleTheme: () => void;
  openLogs: () => void;
  openLog: (log: SystemLog) => void;
  signOut: () => void;
};

type Data =
  | { type: "server"; server: Server }
  | { type: "site"; site: Site }
  | { type: "page"; href: string; icon: LucideIcon; description: string }
  | { type: "action"; icon: LucideIcon; description: string; run: () => void }
  | { type: "copy"; server: Server }
  | { type: "log"; log: SystemLog };

type Item = Entry<Data>;
type Stat = { cpu: number; ram: number; disk: number; live: boolean; at: string };

const CAP = 4;

const PAGES: { title: string; href: string; icon: LucideIcon; description: string; keywords: string[] }[] = [
  { title: "Overview", href: "/", icon: LayoutGrid, description: "Fleet load, active servers and sites, and backup overlaps.", keywords: ["home", "dashboard", "board"] },
  { title: "Servers", href: "/servers", icon: ServerIcon, description: "Every server with its load, specs and provider.", keywords: ["nodes", "machines", "boxes"] },
  { title: "Sites", href: "/sites", icon: Globe, description: "Every site, the server it lives on and its PHP settings.", keywords: ["domains", "websites", "php"] },
  { title: "Backups", href: "/backups", icon: DatabaseBackup, description: "Backup coverage by server.", keywords: ["backup", "restore"] },
  { title: "Backup schedules", href: "/backups/schedules", icon: CalendarClock, description: "Global and per-site backup routines, and where they overlap.", keywords: ["cron", "overlaps", "collisions"] },
  { title: "Monitoring", href: "/monitoring", icon: Activity, description: "CPU, memory and disk readings per server.", keywords: ["telemetry", "cpu", "memory", "disk", "load"] },
  { title: "Server firewall", href: "/firewall", icon: ShieldHalf, description: "UFW, Fail2Ban and who can reach each server.", keywords: ["ufw", "fail2ban", "allowlist", "blocked", "ban"] },
  { title: "Cloudflare WAF", href: "/firewall/cloudflare", icon: Cloud, description: "Custom rules and what they blocked, per zone.", keywords: ["firewall", "rules", "zones"] },
  { title: "7G and 8G", href: "/firewall/waf", icon: Layers, description: "GridPane's 7G and the 8G observer, per site.", keywords: ["firewall", "waf", "nginx"] },
  { title: "Settings", href: "/settings", icon: Settings, description: "The GridPane connection and the telemetry thresholds.", keywords: ["general", "thresholds", "token", "preferences"] },
  { title: "Security settings", href: "/settings/security", icon: ShieldCheck, description: "How this account signs in.", keywords: ["passkey", "password", "2fa", "mfa"] },
  { title: "Profile", href: "/settings/profile", icon: User, description: "Your name and how it is shown.", keywords: ["account", "name", "nickname"] },
];

const GROUP_LABEL: Record<Kind, string> = {
  server: "Servers",
  site: "Sites",
  page: "Pages",
  action: "Actions",
  log: "Action logs",
};
const NOUN: Record<Kind, [string, string]> = {
  server: ["server", "servers"],
  site: ["site", "sites"],
  page: ["page", "pages"],
  action: ["action", "actions"],
  log: ["log entry", "log entries"],
};

const logBody = (n: SystemLog) => n.message.replace(/^\[.*?\]\s*/, "");

function verbFor(d: Data) {
  return d.type === "action" ? "Run" : d.type === "copy" ? "Copy" : d.type === "page" ? "Go" : "Open";
}

function iconFor(d: Data): LucideIcon {
  switch (d.type) {
    case "server":
      return ServerIcon;
    case "site":
      return Globe;
    case "copy":
      return Copy;
    case "log":
      return ScrollText;
    default:
      return d.icon;
  }
}

async function copyIp(server: Server) {
  try {
    await navigator.clipboard.writeText(server.ip);
    toast.success(`Copied ${server.ip}`, { description: `${server.label}’s IP address` });
  } catch {
    toast.error("Could not copy", { description: `${server.label} is ${server.ip}` });
  }
}

export function CommandPalette({
  open,
  onClose,
  ...body
}: {
  open: boolean;
  onClose: () => void;
  servers: Server[];
  sites: Site[];
  logs: SystemLog[];
  isDark: boolean;
  /** "⌘" or "Ctrl", as this machine writes it. */
  modKey: string;
  handlers: PaletteHandlers;
}) {
  const ref = React.useRef<HTMLDialogElement>(null);

  React.useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  // One overlay at a time: opening this closes the action logs or the Firewall menu.
  React.useEffect(() => {
    if (!open) return;
    claimOverlay(onClose);
    return () => releaseOverlay(onClose);
  }, [open, onClose]);

  return (
    <dialog
      ref={ref}
      aria-label="Search and commands"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      // The browser reports a close a moment after it happens. If the palette
      // was reopened in that moment, the report is about the last opening.
      onClose={(e) => {
        if (!e.currentTarget.open) onClose();
      }}
      className="fixed inset-0 m-0 h-full max-h-none w-full max-w-none overflow-hidden border-0 bg-transparent p-0 text-foreground backdrop:bg-transparent open:block"
    >
      {open && <PaletteBody onClose={onClose} {...body} />}
    </dialog>
  );
}

function PaletteBody({
  onClose,
  servers,
  sites,
  logs,
  isDark,
  modKey,
  handlers,
}: {
  onClose: () => void;
  servers: Server[];
  sites: Site[];
  logs: SystemLog[];
  isDark: boolean;
  modKey: string;
  handlers: PaletteHandlers;
}) {
  const router = useRouter();
  const modEnter = modKey === "⌘" ? "⌘↵" : "Ctrl ↵";
  const supabase = React.useMemo(() => createClient(), []);
  const listId = React.useId();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const [query, setQueryState] = React.useState("");
  const [active, setActive] = React.useState(0);
  const [expanded, setExpanded] = React.useState<ReadonlySet<Kind>>(new Set());
  const [stats, setStats] = React.useState<Record<number, Stat> | null>(null);
  const [announce, setAnnounce] = React.useState("");
  const [sheetHeight, setSheetHeight] = React.useState<number | null>(null);
  const byKeyboard = React.useRef(false);

  const setQuery = (q: string) => {
    setQueryState(q);
    setActive(0);
    setExpanded(new Set());
  };

  // The latest reading per server, for the preview pane. Read on every opening.
  React.useEffect(() => {
    let live = true;
    (async () => {
      const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      const [readings, agents] = await Promise.all([
        supabase
          .from("server_telemetry")
          .select("server_id, cpu_usage, ram_usage, disk_usage, timestamp")
          .order("timestamp", { ascending: false })
          .limit(60),
        supabase.from("server_telemetry").select("server_id").ilike("top_processes_b64", "%|AGENT_V1%").gte("timestamp", since),
      ]);
      if (!live || !readings.data) return;
      const liveIds = new Set((agents.data ?? []).map((r) => r.server_id));
      const next: Record<number, Stat> = {};
      for (const t of readings.data) {
        if (next[t.server_id]) continue;
        next[t.server_id] = { cpu: t.cpu_usage, ram: t.ram_usage, disk: t.disk_usage, live: liveIds.has(t.server_id), at: t.timestamp };
      }
      setStats(next);
    })();
    return () => {
      live = false;
    };
  }, [supabase]);

  // On a phone the keyboard covers the bottom of the sheet: size it to what is visible.
  React.useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const fit = () => setSheetHeight(Math.round(vv.height));
    fit();
    vv.addEventListener("resize", fit);
    return () => vv.removeEventListener("resize", fit);
  }, []);

  const siteCount = React.useMemo(() => {
    const n: Record<number, number> = {};
    for (const s of sites) if (s.server_id != null) n[s.server_id] = (n[s.server_id] ?? 0) + 1;
    return n;
  }, [sites]);

  const { baseActions, pool, serverItems, pageItems } = React.useMemo(() => {
    const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    const serverItems: Item[] = [...servers]
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((s) => {
        const provider = getProviderName(s.provider_id, s.provider);
        return {
          id: `server:${s.id}`,
          kind: "server",
          title: s.label,
          sub: [s.ip, provider, plural(siteCount[s.id] ?? 0, "site", "sites")].filter(Boolean).join(" · "),
          meta: [s.ip, provider, s.region_label, s.region].filter(Boolean).join(" "),
          data: { type: "server", server: s },
        };
      });
    const siteItems: Item[] = sites.map((s) => ({
      id: `site:${s.id}`,
      kind: "site",
      title: s.url,
      sub: [s.servers?.label ?? "Unknown server", s.php_version ? `PHP ${s.php_version}` : null].filter(Boolean).join(" · "),
      meta: [s.servers?.label, s.site_nickname].filter(Boolean).join(" "),
      data: { type: "site", site: s },
    }));
    const pageItems: Item[] = PAGES.map((p) => ({
      id: `page:${p.href}`,
      kind: "page",
      title: p.title,
      sub: p.description,
      keywords: p.keywords,
      data: { type: "page", href: p.href, icon: p.icon, description: p.description },
    }));
    const action = (id: string, title: string, description: string, icon: LucideIcon, keywords: string[], run: () => void): Item => ({
      id: `action:${id}`,
      kind: "action",
      title,
      sub: description,
      keywords,
      data: { type: "action", icon, description, run },
    });
    const baseActions: Item[] = [
      action("sync", "Sync from GridPane", "Read every server and site again and re-index the backup schedules.", RefreshCw, ["refresh", "reload", "update", "resync"], handlers.sync),
      action("allow", "Allow my current IP", "Open the allowlist form on Server firewall with this connection’s address filled in.", ShieldCheck, ["allowlist", "whitelist", "unblock", "address", "firewall"], handlers.allowMyIp),
      action("theme", isDark ? "Switch to light theme" : "Switch to dark theme", "Flip between the light and dark ledger.", Contrast, ["theme", "dark", "light", "mode", "appearance"], handlers.toggleTheme),
      action("logs", "Open the action logs", "The list of what the fleet did, newest first.", Bell, ["notifications", "bell", "history", "events"], handlers.openLogs),
      action("signout", "Sign out", "End this session. You will need to sign in again.", LogOut, ["logout", "log", "out", "exit", "leave"], handlers.signOut),
    ];
    const copyItems: Item[] = serverItems.map((e) => {
      const s = (e.data as Extract<Data, { type: "server" }>).server;
      return {
        id: `copy:${s.id}`,
        kind: "action",
        title: `Copy ${s.label}’s IP`,
        sub: s.ip,
        keywords: ["address", "clipboard"],
        data: { type: "copy", server: s },
      };
    });
    const logItems: Item[] = logs.map((n) => ({
      id: `log:${n.id}`,
      kind: "log",
      title: logTitle(n),
      sub: logBody(n),
      meta: [n.site_url, n.level].filter(Boolean).join(" "),
      keywords: ["log", "logs"],
      data: { type: "log", log: n },
    }));
    return {
      baseActions,
      serverItems,
      pageItems,
      pool: index<Data>([...serverItems, ...siteItems, ...pageItems, ...baseActions, ...copyItems, ...logItems]),
    };
  }, [servers, sites, logs, siteCount, isDark, handlers]);

  /* What is on screen: groups, each capped unless opened up, flattened into
     the rows the arrow keys walk (a "Show all" row is one of them). */
  const { groups, rows, toks, total } = React.useMemo(() => {
    type Group = { kind: Kind; label: string; items: Item[]; total: number };
    const groups: Group[] = [];
    let toks: string[] = [];
    if (!query.trim()) {
      const add = (kind: Kind, label: string, items: Item[], cap: number) => {
        if (!items.length) return;
        groups.push({ kind, label, items: expanded.has(kind) ? items : items.slice(0, cap), total: items.length });
      };
      add("server", "Servers", serverItems, CAP);
      add("page", "Go to", pageItems, CAP);
      add("action", "Actions", baseActions, baseActions.length);
    } else {
      const res = search(pool, query);
      toks = res.toks;
      const by = new Map<Kind, Item[]>();
      for (const h of res.hits) {
        const list = by.get(h.entry.kind) ?? [];
        list.push(h.entry);
        by.set(h.entry.kind, list);
      }
      // A Map keeps insertion order, and hits arrive best first: groups are ordered by their best match.
      for (const [kind, items] of by) {
        groups.push({ kind, label: GROUP_LABEL[kind], items: expanded.has(kind) ? items : items.slice(0, CAP), total: items.length });
      }
    }
    type Row = { type: "item"; item: Item } | { type: "more"; kind: Kind; count: number };
    const rows: Row[] = [];
    let total = 0;
    for (const g of groups) {
      total += g.total;
      for (const item of g.items) rows.push({ type: "item", item });
      if (g.total > g.items.length) rows.push({ type: "more", kind: g.kind, count: g.total });
    }
    return { groups, rows, toks, total };
  }, [query, expanded, pool, serverItems, pageItems, baseActions]);

  const activeRow = rows[Math.min(active, rows.length - 1)];
  const activeItem = activeRow?.type === "item" ? activeRow.item : null;

  // The gray completion: the rest of the highlighted title, when what is typed starts it.
  const ghost =
    activeItem && query && query.length < 40 && activeItem.title.length > query.length && activeItem.title.toLowerCase().startsWith(query.toLowerCase())
      ? activeItem.title.slice(query.length)
      : "";

  // Tell a screen reader the count once typing pauses.
  React.useEffect(() => {
    if (!query.trim()) return;
    const t = setTimeout(() => setAnnounce(total === 0 ? "No results" : `${total} ${total === 1 ? "result" : "results"}`), 450);
    return () => clearTimeout(t);
  }, [query, total]);

  // Keep the highlighted row in view when the arrow keys moved it.
  React.useEffect(() => {
    if (!byKeyboard.current) return;
    byKeyboard.current = false;
    listRef.current?.querySelector<HTMLElement>(`[data-row="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const run = (item: Item, alt = false) => {
    const d = item.data;
    onClose();
    if (d.type === "server") {
      if (alt) void copyIp(d.server);
      else router.push(`/servers/${d.server.id}`);
    } else if (d.type === "site") router.push(`/sites/${d.site.id}`);
    else if (d.type === "page") router.push(d.href);
    else if (d.type === "action") d.run();
    else if (d.type === "copy") void copyIp(d.server);
    else handlers.openLog(d.log);
  };

  const showAll = (kind: Kind) => setExpanded((prev) => new Set(prev).add(kind));

  const activate = (i: number, alt = false) => {
    const row = rows[i];
    if (!row) return;
    if (row.type === "more") showAll(row.kind);
    else run(row.item, alt);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const move = (to: number) => {
      e.preventDefault();
      if (!rows.length) return;
      byKeyboard.current = true;
      setActive((to + rows.length) % rows.length);
    };
    const at = Math.min(active, rows.length - 1);
    if (e.key === "ArrowDown") move(at + 1);
    else if (e.key === "ArrowUp") move(at - 1);
    else if (e.key === "Home" && !query) move(0);
    else if (e.key === "End" && !query) move(rows.length - 1);
    else if (e.key === "Enter") {
      e.preventDefault();
      activate(at, e.metaKey || e.ctrlKey);
    } else if (e.key === "Tab" && !e.shiftKey && ghost && activeItem) {
      e.preventDefault();
      setQuery(activeItem.title);
    }
  };

  let n = -1; // running row number, matching `rows`
  const verb = activeItem ? verbFor(activeItem.data) : "Show";

  return (
    <>
      <div aria-hidden="true" onClick={onClose} className="anim-fade absolute inset-0 bg-foreground/25" />
      <div
        style={sheetHeight ? ({ "--sheet-h": `${sheetHeight}px` } as React.CSSProperties) : undefined}
        className="anim-fade absolute inset-x-0 top-0 mx-auto flex h-[var(--sheet-h,100dvh)] w-full flex-col overflow-hidden bg-panel pt-[env(safe-area-inset-top)] md:top-[max(7vh,32px)] md:h-[min(580px,calc(100dvh-max(7vh,32px)-24px))] md:w-[min(880px,calc(100vw-48px))] md:rounded-lg md:border md:border-line-strong md:pt-0 md:shadow-2xl"
      >
        {/* ── The box ── */}
        <div className="flex h-[54px] shrink-0 items-center gap-2.5 border-b border-border pl-4 pr-3">
          <Search size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-faint" />
          <div className="relative min-w-0 flex-1">
            {ghost && (
              <div
                aria-hidden="true"
                data-ghost=""
                className="pointer-events-none absolute inset-0 overflow-hidden text-ellipsis whitespace-pre text-[16px] leading-[40px] text-faint"
              >
                <span className="invisible">{query}</span>
                {ghost}
              </div>
            )}
            <input
              ref={inputRef}
              autoFocus
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={rows.length ? `${listId}-${Math.min(active, rows.length - 1)}` : undefined}
              aria-autocomplete="list"
              aria-label="Search servers, sites, pages, logs and actions"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              enterKeyHint="go"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Search or run a command"
              className="relative block h-[40px] w-full bg-transparent text-[16px] text-foreground outline-none placeholder:text-faint"
            />
          </div>
          <span className="hidden md:block">
            <Kbd>Esc</Kbd>
          </span>
          <Button size="sm" onClick={onClose} className="md:hidden">
            Cancel
          </Button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* ── Results ── */}
          <div ref={listRef} className="min-w-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3">
            {!query.trim() && (
              <div className="flex flex-wrap items-center gap-1.5 px-2 pb-1 pt-3">
                <span className="eyebrow mr-1 text-muted-foreground">Try</span>
                {[serverItems.find((s) => s.title.length <= 16)?.title, "firewall", "sync", "copy ip", "logs"].filter(Boolean).map((t) => (
                  <button
                    key={t}
                    type="button"
                    tabIndex={-1}
                    onClick={() => {
                      setQuery(t as string);
                      inputRef.current?.focus();
                    }}
                    className="touch-hit rounded-sm border border-border bg-panel-2 px-2 py-[3px] font-mono text-[11px] text-muted-foreground transition-colors duration-150 hover:border-line-strong hover:text-foreground"
                  >
                    {t}
                  </button>
                ))}
              </div>
            )}

            {query.trim() && rows.length === 0 && (
              <div className="px-2 py-10 text-center">
                <p className="text-[13px] font-semibold text-foreground">Nothing matches “{query.trim()}”</p>
                <p className="mx-auto mt-1.5 max-w-[320px] text-pretty text-[12px] leading-relaxed text-muted-foreground">
                  Try a server’s name or IP, a site’s address, a page, or an action such as sync.
                </p>
              </div>
            )}

            <div id={listId} role="listbox" aria-label="Results">
              {groups.map((g) => (
                <div key={g.kind} role="group" aria-labelledby={`${listId}-g-${g.kind}`}>
                  <div id={`${listId}-g-${g.kind}`} className="eyebrow flex items-baseline justify-between px-2 pb-1.5 pt-4 text-muted-foreground">
                    <span>{g.label}</span>
                    {query.trim() !== "" && <span className="font-mono tabular-nums">{g.total}</span>}
                  </div>
                  {g.items.map((item) => {
                    n++;
                    const i = n;
                    const on = i === Math.min(active, rows.length - 1);
                    const Icon = iconFor(item.data);
                    return (
                      <div
                        key={item.id}
                        id={`${listId}-${i}`}
                        data-row={i}
                        role="option"
                        aria-selected={on}
                        onPointerMove={() => !on && setActive(i)}
                        onClick={(e) => activate(i, e.metaKey || e.ctrlKey)}
                        className={cn(
                          "grid cursor-pointer grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md px-2 py-[7px]",
                          on ? "bg-panel-2" : ""
                        )}
                      >
                        <Icon size={14} strokeWidth={1.75} aria-hidden="true" className={cn("justify-self-center", on ? "text-primary" : "text-faint")} />
                        <span className="min-w-0">
                          <span className="block truncate text-[13px] font-medium text-foreground">
                            <Marked text={item.title} toks={toks} />
                          </span>
                          <span className={cn("mt-px block truncate text-[11px] text-muted-foreground", (item.kind === "server" || item.data.type === "copy") && "font-mono text-[10.5px]")}>
                            <Marked text={item.sub} toks={toks} />
                          </span>
                        </span>
                        <span aria-hidden="true" className={cn("hidden font-mono text-[10px] text-muted-foreground md:block", !on && "invisible")}>
                          ↵
                        </span>
                      </div>
                    );
                  })}
                  {g.total > g.items.length &&
                    (() => {
                      n++;
                      const i = n;
                      const on = i === Math.min(active, rows.length - 1);
                      return (
                        <div
                          id={`${listId}-${i}`}
                          data-row={i}
                          role="option"
                          aria-selected={on}
                          onPointerMove={() => !on && setActive(i)}
                          onClick={() => activate(i)}
                          className={cn(
                            "grid cursor-pointer grid-cols-[18px_minmax(0,1fr)] items-center gap-2.5 rounded-md px-2 py-[7px] text-[12px] font-medium",
                            on ? "bg-panel-2 text-foreground" : "text-muted-foreground"
                          )}
                        >
                          <span />
                          <span>
                            Show all {g.total} {NOUN[g.kind][1]}
                          </span>
                        </div>
                      );
                    })()}
                </div>
              ))}
            </div>
          </div>

          {/* ── Preview: tablet width and up ── */}
          <aside aria-hidden="true" className="hidden w-[330px] shrink-0 overflow-y-auto border-l border-border bg-panel-2/50 p-5 md:block">
            {activeItem ? (
              <Preview item={activeItem} stats={stats} siteCount={siteCount} modEnter={modEnter} />
            ) : activeRow?.type === "more" ? (
              <p className="text-[12px] text-muted-foreground">
                Press <Kbd>↵</Kbd> to list all {activeRow.count} {NOUN[activeRow.kind][1]}.
              </p>
            ) : null}
          </aside>
        </div>

        {/* ── Keys: only where there is a keyboard to use them ── */}
        <div className="hidden h-[38px] shrink-0 items-center gap-4 border-t border-border px-4 text-[11px] text-muted-foreground md:flex">
          <span className="flex items-center gap-1.5">
            <Kbd>↑↓</Kbd> Move
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>↵</Kbd> {verb}
          </span>
          {activeItem?.data.type === "server" && (
            <span className="flex items-center gap-1.5">
              <Kbd>{modEnter}</Kbd> Copy IP
            </span>
          )}
          {ghost && (
            <span className="flex items-center gap-1.5">
              <Kbd>Tab</Kbd> Complete
            </span>
          )}
          {query.trim() !== "" && (
            <span className="ml-auto font-mono text-[10.5px] tabular-nums text-muted-foreground">
              {total} {total === 1 ? "result" : "results"}
            </span>
          )}
        </div>
      </div>
      <div role="status" aria-live="polite" className="sr-only">
        {query.trim() ? announce : ""}
      </div>
    </>
  );
}

/** Text with the words the query matched set in bold. */
function Marked({ text, toks }: { text: string; toks: string[] }) {
  if (!toks.length) return <>{text}</>;
  return (
    <>
      {markRuns(text, toks).map((r, i) =>
        r.hit ? (
          <mark key={i} className="rounded-[2px] bg-primary/15 text-inherit">
            {r.text}
          </mark>
        ) : (
          <React.Fragment key={i}>{r.text}</React.Fragment>
        )
      )}
    </>
  );
}

function Facts({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="mt-4 border-t border-border">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-baseline justify-between gap-3 border-b border-border py-[7px]">
          <dt className="eyebrow shrink-0 text-muted-foreground">{k}</dt>
          <dd className="min-w-0 truncate text-right text-[12px] text-foreground">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Hint({ keys, children }: { keys: string; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
      <Kbd>{keys}</Kbd> {children}
    </span>
  );
}

function Preview({
  item,
  stats,
  siteCount,
  modEnter,
}: {
  item: Item;
  stats: Record<number, Stat> | null;
  siteCount: Record<number, number>;
  modEnter: string;
}) {
  const d = item.data;
  const head = (kind: string, title: string, mono = false) => (
    <>
      <div className="eyebrow text-muted-foreground">{kind}</div>
      <div className={cn("mt-1.5 break-words text-[19px] font-bold leading-tight tracking-[-0.015em]", mono && "font-mono text-[15px] leading-tight tracking-normal")}>{title}</div>
    </>
  );

  if (d.type === "server" || d.type === "copy") {
    const s = d.server;
    const stat = stats?.[s.id];
    return (
      <div>
        {head(d.type === "copy" ? "Action" : "Server", d.type === "copy" ? item.title : s.label)}
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <StatusPill tone={s.status === "active" ? "ok" : "danger"}>{s.status ?? "unknown"}</StatusPill>
          {stat?.live && <StatusPill tone="live">Live</StatusPill>}
        </div>
        {/* Readings are shown only when the fleet reported one; nothing is filled in. */}
        <div className="mt-4 flex min-h-[78px] flex-col gap-2.5">
          {stat ? (
            (
              [
                ["CPU", stat.cpu, "cpu"],
                ["Memory", stat.ram, "memory"],
                ["Disk", stat.disk, "disk"],
              ] as const
            ).map(([label, value, metric]) => (
              <div key={label} className="grid grid-cols-[52px_minmax(0,1fr)_40px] items-center gap-2">
                <span className="eyebrow text-muted-foreground">{label}</span>
                <Meter value={value} metric={metric} />
                <span className="text-right font-mono text-[10.5px] tabular-nums text-foreground">{Math.round(value)}%</span>
              </div>
            ))
          ) : (
            <p className="text-[12px] text-muted-foreground">{stats ? "No reading on record for this server." : "Reading the latest load…"}</p>
          )}
        </div>
        <Facts
          rows={[
            ["IP", <span key="ip" className="font-mono text-[11.5px]">{s.ip}</span>],
            ["Provider", getProviderName(s.provider_id, s.provider)],
            ["Sites", siteCount[s.id] ?? 0],
            ["OS", formatOsVersion(s.os_version) ?? "Not recorded"],
            ...(stat ? ([["Read", new Date(stat.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })]] as [string, React.ReactNode][]) : []),
          ]}
        />
        <div className="mt-4 flex flex-col gap-1.5">
          {d.type === "copy" ? (
            <Hint keys="↵">Copy the IP</Hint>
          ) : (
            <>
              <Hint keys="↵">Open the server</Hint>
              <Hint keys={modEnter}>Copy its IP</Hint>
            </>
          )}
        </div>
      </div>
    );
  }

  if (d.type === "site") {
    const s = d.site;
    return (
      <div>
        {head("Site", s.url, true)}
        {s.site_nickname && <p className="mt-1.5 text-[12px] text-muted-foreground">{s.site_nickname}</p>}
        <Facts
          rows={[
            ["Server", s.servers?.label ?? "Unknown"],
            ["PHP", s.php_version ?? "Not recorded"],
            ["SSL", s.is_ssl == null ? "Not recorded" : s.is_ssl ? "On" : "Off"],
            ["Page cache", s.nginx_caching ?? "Not recorded"],
          ]}
        />
        <div className="mt-4">
          <Hint keys="↵">Open the site</Hint>
        </div>
      </div>
    );
  }

  if (d.type === "log") {
    const l = d.log;
    return (
      <div>
        {head("Action log", item.title)}
        <div className="mt-2.5">
          <StatusPill tone={l.level === "error" ? "danger" : l.level === "warning" ? "warn" : "ok"} led>
            {l.level}
          </StatusPill>
        </div>
        <p className="mt-4 line-clamp-[9] whitespace-pre-wrap break-words text-[12px] leading-relaxed text-muted-foreground">{logBody(l)}</p>
        <Facts
          rows={[
            ...(l.site_url ? ([["Target", <span key="t" className="font-mono text-[11px]">{l.site_url}</span>]] as [string, React.ReactNode][]) : []),
            ["Logged", new Date(l.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })],
          ]}
        />
        <div className="mt-4">
          <Hint keys="↵">Open the full entry</Hint>
        </div>
      </div>
    );
  }

  return (
    <div>
      {head(d.type === "page" ? "Page" : "Action", item.title)}
      <p className="mt-3 text-pretty text-[12.5px] leading-relaxed text-muted-foreground">{d.description}</p>
      {d.type === "page" && <Facts rows={[["Address", <span key="a" className="font-mono text-[11px]">{d.href}</span>]]} />}
      <div className="mt-4">
        <Hint keys="↵">{d.type === "page" ? "Go there" : "Run it"}</Hint>
      </div>
    </div>
  );
}
