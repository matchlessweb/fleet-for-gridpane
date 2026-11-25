"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { Search, RefreshCw } from "lucide-react";
import { useMounted } from "@/lib/use-mounted";
import { createClient } from "@/lib/supabase/client";
import { Database } from "@/lib/database.types";
import { useTask } from "@/components/providers/task-provider";
import { FirewallMenu } from "@/components/layout/firewall-menu";
import { ActionLogs } from "@/components/layout/action-logs";
import { AccountMenu } from "@/components/layout/account-menu";
import { ThemeGlyph } from "@/components/layout/theme-glyph";
import { CommandPalette, type PaletteHandlers } from "@/components/command/command-palette";
import { ALLOW_AN_IP_EVENT } from "@/components/security/firewall-sections";
import { Button, ConfirmDialog, IconButton, Kbd, Led, Tab, Tabs, Tooltip } from "@/components/ui";
import { fleetConfig } from "@/fleet.config";
import { SYNC_RUN_CHANGED } from "@/components/providers/sync-run-provider";
import { SyncIndicator } from "@/components/layout/sync-indicator";
import { useSyncRun } from "@/components/providers/sync-run-provider";

type Server = Database["public"]["Tables"]["servers"]["Row"];
type Site = Database["public"]["Tables"]["sites"]["Row"] & {
  servers: { label: string | null; ip: string | null } | null;
};
type SystemLog = Database["public"]["Tables"]["system_logs"]["Row"];

const navItems = [
  { name: "Overview", href: "/" },
  { name: "Servers", href: "/servers" },
  { name: "Sites", href: "/sites" },
  { name: "Backups", href: "/backups" },
  { name: "Monitoring", href: "/monitoring" },
  { name: "Firewall", href: "/firewall" },
  { name: "Settings", href: "/settings" },
];

export function Masthead() {
  const [isPaletteOpen, setIsPaletteOpen] = useState(false);
  const [isNotifOpen, setIsNotifOpen] = useState(false);
  const [logFocusId, setLogFocusId] = useState<string | null>(null);
  const mounted = useMounted();
  const [now, setNow] = useState<Date | null>(null);

  const [servers, setServers] = useState<Server[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [notifications, setNotifications] = useState<SystemLog[]>([]);
  const [displayName, setDisplayName] = useState("System Admin");
  const [isSignOutOpen, setIsSignOutOpen] = useState(false);

  const supabase = createClient();
  const { resolvedTheme, setTheme } = useTheme();
  const pathname = usePathname();

  // Consume Global Top-Level Contexts
  const { isTaskRunning, setIsModalOpen, runGenericTask } = useTask();
  // A sync started in another tab, on another device or by npm run sync: its
  // indicator takes the Sync button's place, so the bar never offers a second one.
  const syncElsewhere = useSyncRun().view.state === "running" && !isTaskRunning;

  useEffect(() => {
    async function fetchSearchData() {
      const [_servers, _sites, _logs] = await Promise.all([
        supabase.from("servers").select("*"),
        supabase.from("sites").select("*, server_id, servers(label, ip)"),
        supabase.from("system_logs").select("*").order("created_at", { ascending: false }).limit(100)
      ]);

      if (_servers.data) setServers(_servers.data);
      if (_sites.data) setSites(_sites.data as Site[]);
      if (_logs.data) setNotifications(_logs.data);
    }
    fetchSearchData();
  }, [supabase]);

  // Masthead clock — minute resolution, no seconds.
  useEffect(() => {
    const tick = () => setNow(new Date());
    const initial = setTimeout(tick, 0);
    const timer = setInterval(tick, 60_000);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, []);

  // Profile display name (migrated from the retired sidebar).
  useEffect(() => {
    async function fetchProfile() {
      const { data: { user } } = await supabase.auth.getUser();
      if (user?.user_metadata) {
        const { first_name, last_name, nickname, display_preference } = user.user_metadata;
        if (display_preference === "nickname" && nickname) {
          setDisplayName(nickname);
        } else if (display_preference === "full_name" && first_name && last_name) {
          setDisplayName(`${first_name} ${last_name}`);
        } else if (first_name) {
          setDisplayName(first_name);
        }
      }
    }

    fetchProfile();
    window.addEventListener("user_profile_updated", fetchProfile);
    return () => window.removeEventListener("user_profile_updated", fetchProfile);
  }, [supabase]);

  const router = useRouter();

  type SyncSummary = { recovered: number; audited: number; scanned: number; pruned: number; errorCount: number; subrequests?: number };
  type SyncPause = { cursor: number | null; subrequests?: number; interval?: number; stats: { recovered: number; pruned: number; errors: number; audited: number; total: number } };

  const handleSyncRemote = useCallback(async () => {
    await runGenericTask(
      1,
      ["Establishing secured streaming connection to GridPane Edge API..."],
      async (log, updateProgress) => {
        log(`Starting sequential streaming site crawler...`);

        // A Worker invocation can only spend so many Cloudflare subrequests, so
        // a full sync runs as a series of passes: the route hands back the id of
        // the last site it finished plus the running totals, and we post those
        // straight back to continue. Each pass is a fresh invocation with a
        // fresh budget.
        let cursor: number | null = null;
        let stats = { recovered: 0, pruned: 0, errors: 0, audited: 0, total: 0 };
        // Carried between passes so a pass that had to slow down does not make
        // the next one rediscover GridPane's limit from scratch.
        let interval: number | null = null;
        let finalSummary: SyncSummary | null = null;
        // Set when the route says the sync failed (a server or site write was
        // rejected, the site list could not be read). That ends the sync.
        let failure: string | null = null;
        let passes = 0;
        let drops = 0;
        // The sync's record (public.sync_runs), named by the first pass. Every
        // signed-in screen reads it to show this sync in the top bar.
        let runId: string | null = null;
        // Closes the record when this tab gives up, so other screens do not wait
        // six minutes to learn the sync stopped.
        const giveUp = (why: string) => {
          if (!runId) return;
          void fetch("/api/backups/sync-remote", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ runId, stop: why }),
          }).catch(() => null).finally(() => window.dispatchEvent(new Event(SYNC_RUN_CHANGED)));
        };

        while (finalSummary === null) {
          passes++;
          if (passes > 25) {
            log("ERROR: Sync still unfinished after 25 passes — stopping rather than looping.");
            giveUp("Still unfinished after 25 passes, so the browser stopped it.");
            break;
          }
          if (passes > 1) log(`Continuing — pass ${passes}...`);

          // A pass holds one connection open for up to four minutes. A phone
          // that locks or changes network drops it, which used to end the whole
          // sync. Everything a pass has saved stays saved, so run the same pass
          // again from the same cursor, three times at most.
          let res: Response;
          try {
            res = await fetch("/api/backups/sync-remote", {
               method: "POST",
               headers: { "Content-Type": "application/json" },
               body: JSON.stringify({ cursor, stats, interval, runId })
            });
          } catch {
            drops++;
            if (drops > 3) {
              giveUp("The connection dropped four times.");
              throw new Error("The connection dropped four times. Sync stopped; run it again to continue.");
            }
            log(`Connection dropped. Trying this pass again (${drops} of 3)...`);
            await new Promise((r) => setTimeout(r, 3000));
            passes--;
            continue;
          }

          if (res.status === 409) {
             // Another sync is running (this tab, another tab, another device, or
             // npm run sync). Nothing was started; the top bar shows the other one.
             const busy = await res.json().catch(() => ({})) as { error?: string };
             log(busy.error || "A sync is already running. Only one runs at a time.");
             window.dispatchEvent(new Event(SYNC_RUN_CHANGED));
             throw new Error("Another sync is already running.");
          }

          if (!res.ok) {
             giveUp(`The server answered ${res.status}.`);
             // statusText is empty over HTTP/2, so say what the code means.
             log(res.status === 401
               ? "Sync refused (401): your sign-in has expired. Sign in again, then run the sync."
               : `Sync refused: the server answered ${res.status}${res.statusText ? ` ${res.statusText}` : ""}.`);
             updateProgress(1, 0, 1);
             window.dispatchEvent(new Event("system_logs_updated"));
             throw new Error("Terminal authentication fault or Edge failure.");
          }

          if (!res.body) throw new Error("ReadableStream not supported or empty body.");

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let partialChunk = "";
          let paused: SyncPause | null = null;

          let dropped = false;
          while (true) {
             let chunk: ReadableStreamReadResult<Uint8Array>;
             try {
               chunk = await reader.read();
             } catch {
               dropped = true;
               break;
             }
             const { done, value } = chunk;
             if (done) break;

             const chunkStr = partialChunk + decoder.decode(value, { stream: true });
             const lines = chunkStr.split('\n');
             partialChunk = lines.pop() || "";

             for (const line of lines) {
               if (!line.trim()) continue;
               try {
                  const step = JSON.parse(line);

                  if (step.type === "run") {
                     runId = typeof step.id === "string" ? step.id : null;
                     window.dispatchEvent(new Event(SYNC_RUN_CHANGED));
                  } else if (step.type === "log") {
                     log(step.msg);
                  } else if (step.type === "error") {
                     log(`ERROR: ${step.msg}`);
                  } else if (step.type === "progress") {
                     updateProgress(step.completed, step.recovered, step.errors, step.total);
                     log(`-> ${step.msg}`);
                  } else if (step.type === "paused") {
                     paused = step;
                     log(step.msg);
                  } else if (step.type === "complete") {
                     finalSummary = step;
                  } else if (step.type === "failed") {
                     failure = String(step.msg || "The sync failed.");
                     log(`FAILED: ${failure}`);
                  }
               } catch (e) {
                  console.error("Stream parsing fault:", e);
               }
             }
          }

          if (finalSummary || failure) break;

          if (dropped && !paused) {
            drops++;
            if (drops > 3) {
              giveUp("The connection dropped four times.");
              throw new Error("The connection dropped four times. Sync stopped; run it again to continue.");
            }
            log(`Connection dropped mid-pass. Trying this pass again (${drops} of 3)...`);
            await new Promise((r) => setTimeout(r, 3000));
            passes--;
            continue;
          }

          // Only continue when the cursor actually moved. A pass that ends
          // where it began would otherwise spin forever.
          if (paused && typeof paused.cursor === "number" && paused.cursor !== cursor) {
             cursor = paused.cursor;
             stats = paused.stats;
             if (typeof paused.interval === "number") interval = paused.interval;
             continue;
          }

          log("ERROR: Sync stopped early without completing — the cursor did not advance.");
          giveUp("It stopped early: the cursor did not advance.");
          break;
        }

        if (failure) {
          await supabase.from("system_logs").insert({
            level: "error",
            message: `[Remote Backup Synchronization] Sync failed: ${failure}`,
            site_url: "Edge Sync Controller"
          });
          window.dispatchEvent(new Event("system_logs_updated"));
          throw new Error(`Sync failed: ${failure}`);
        }

        if (finalSummary) {
          const { recovered, audited, scanned, pruned, errorCount } = finalSummary;
          const unread = scanned - audited;

          if (pruned > 0) log(`Removed ${pruned} orphaned domain(s) no longer present in GridPane.`);
          log(`Re-indexed ${recovered} schedules across ${audited} of ${scanned} sites.`);
          if (typeof finalSummary.subrequests === "number") log(`Final pass spent ${finalSummary.subrequests} subrequests.`);
          if (unread > 0) log(`WARNING: ${unread} site(s) were not read this run.`);
          if (errorCount > 0) log(`Finished with ${errorCount} error(s).`);
          updateProgress(scanned, recovered, errorCount, scanned);

          // Report what actually happened. This log used to claim success at
          // level "success" no matter how many sites went unread.
          const clean = errorCount === 0 && unread === 0;
          await supabase.from("system_logs").insert({
            level: clean ? "success" : "warning",
            message: clean
              ? `[Remote Backup Synchronization] Sync complete. Indexed ${recovered} GridPane schedules across all ${scanned} sites and removed ${pruned} orphaned entries.`
              : `[Remote Backup Synchronization] Sync finished with gaps: ${audited} of ${scanned} sites read, ${recovered} schedules indexed, ${unread} site(s) unread, ${errorCount} error(s), ${pruned} orphaned entries removed.`,
            site_url: "Edge Sync Controller"
          });
        } else {
          await supabase.from("system_logs").insert({
            level: "error",
            message: `[Remote Backup Synchronization] Sync did not complete. ${stats.audited} of ${stats.total || "unknown"} sites were read before it stopped.`,
            site_url: "Edge Sync Controller"
          });
        }

        window.dispatchEvent(new Event("system_logs_updated"));
        window.dispatchEvent(new Event("schedules_updated"));
        window.dispatchEvent(new Event(SYNC_RUN_CHANGED));
      },
      { total: "Sites read", success: "Schedules found", failed: "Errors", showCompleted: true }
    );
  }, [runGenericTask, supabase]);

  // ⌘K or Ctrl K opens the palette from anywhere, at every width; so does "/"
  // when the cursor is not in a field. The palette closes itself on Esc.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      // A question is open (ConfirmDialog): it gets an answer before anything else opens.
      if (document.querySelector('[role="alertdialog"]')) return;
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setIsPaletteOpen((open) => !open);
        return;
      }
      if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const t = event.target as HTMLElement | null;
        const typing = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
        if (!typing && !document.querySelector("dialog[open]")) {
          event.preventDefault();
          setIsPaletteOpen(true);
        }
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Dynamic Telemetry Sync: Refresh logs implicitly when user clicks the notification bell
  useEffect(() => {
    if (isNotifOpen) {
      supabase.from("system_logs").select("*").order("created_at", { ascending: false }).limit(100)
        .then(({ data }) => { if (data) setNotifications(data); });
    }
  }, [isNotifOpen, supabase]);

  // Global Cross-Component Event Trigger: Re-hydrate logs universally upon generic updates internally
  useEffect(() => {
    const reloadLogs = () => {
      supabase.from("system_logs").select("*").order("created_at", { ascending: false }).limit(100)
        .then(({ data }) => { if (data) setNotifications(data); });
    };
    window.addEventListener("system_logs_updated", reloadLogs);
    return () => window.removeEventListener("system_logs_updated", reloadLogs);
  }, [supabase]);

  // Hook global listeners for cross-component task execution (e.g. from page-level dispatchers)
  useEffect(() => {
    window.addEventListener("trigger_global_sync", handleSyncRemote);
    return () => window.removeEventListener("trigger_global_sync", handleSyncRemote);
  }, [handleSyncRemote]);

  const closePalette = useCallback(() => setIsPaletteOpen(false), []);

  // The half-circle turns half a rotation as the theme flips. A Web Animation,
  // because next-themes switches every CSS transition off for the change.
  const toggleTheme = useCallback(() => {
    const toDark = resolvedTheme !== "dark";
    setTheme(toDark ? "dark" : "light");
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // Every mark turns, not one held by a ref: the masthead's is hidden on phones, where the
    // one in the account menu is the mark being pressed.
    document.querySelectorAll<SVGSVGElement>("svg[data-theme-glyph]").forEach((mark) => {
      mark.getAnimations().forEach((a) => a.cancel()); // a second press mid-turn starts over
      mark.animate(
        [{ rotate: toDark ? "180deg" : "0deg" }, { rotate: toDark ? "0deg" : "180deg" }],
        { duration: 500, easing: "cubic-bezier(0.65, 0, 0.35, 1)" }
      );
    });
  }, [resolvedTheme, setTheme]);

  const paletteHandlers = useMemo<PaletteHandlers>(
    () => ({
      sync: () => void handleSyncRemote(),
      allowMyIp: () => {
        // Already on Server firewall: open its form in place.
        if (window.location.pathname === "/firewall") {
          window.dispatchEvent(new CustomEvent(ALLOW_AN_IP_EVENT, { detail: { mine: true } }));
        } else {
          router.push("/firewall?allow=me");
        }
      },
      toggleTheme,
      openLogs: () => setIsNotifOpen(true),
      // A log entry opens in place, in the panel, not in a panel of its own.
      openLog: (log) => {
        setLogFocusId(log.id);
        setIsNotifOpen(true);
      },
      signOut: () => setIsSignOutOpen(true),
    }),
    [handleSyncRemote, router, toggleTheme]
  );

  const clearLogFocus = useCallback(() => setLogFocusId(null), []);

  const dateStamp = now
    ? `${now.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" }).replace(/,/g, "")} · ${now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })}`
    : null;

  const activeNav =
    navItems.find((item) => pathname === item.href || (item.href !== "/" && pathname?.startsWith(item.href)))?.href ?? null;

  // The shortcut as this machine writes it. Apple's until the browser says otherwise.
  const modKey = mounted && !/Mac|iPhone|iPad/.test(navigator.userAgent) ? "Ctrl" : "⌘";

  return (
    <>
      {/* STICKY ON PURPOSE, though nothing here scrolls under it (the page scrolls
          inside #main-scroll-container, so sticky moves nothing). From iOS 26, a
          Home Screen web app gets a system blur and fade over the top of the page,
          under the status bar, and it made this row look fuzzy. WebKit hides that
          effect only when the element at the middle of the top edge sits inside a
          fixed or sticky box that spans the viewport and has a solid background
          (LocalFrameView::fixedContainerEdges; WKWebView _shouldHideTopScrollPocket).
          So: keep it sticky at top 0, keep the solid background, and never put a
          backdrop-filter on it.
          Z-50 COMES WITH IT. A sticky box is its own stacking layer, so without
          a level the panels that open inside this header (Action logs, Account)
          are drawn under page content that comes later. 50 is the level those
          panels already use, so they sit exactly where they did; sheets and
          dialogs (100) and tooltips (400) still open over the header. */}
      <header className="sticky top-0 z-50 shrink-0 bg-background">
        {/* ── Top strip ─────────────────────────────────────────── */}
        <div className="border-b border-foreground pr-[var(--sbw,0px)]">
          <div className="mx-auto flex w-full max-w-[1360px] items-center gap-3 py-3 pl-[calc(1.25rem+env(safe-area-inset-left))] pr-[calc(1.25rem+env(safe-area-inset-right))] lg:pl-[calc(2rem+env(safe-area-inset-left))] lg:pr-[calc(2rem+env(safe-area-inset-right))]">
            {/* A size container: it takes what the buttons leave, and the
                dateline shows only when that is enough for it (see below). */}
            <div className="@container flex min-w-0 flex-1 items-baseline gap-4">
              {/* The wordmark is the masthead's home link — every size.
                  Full lockup from sm up; scaled-down lockup on phones. */}
              <Link
                href="/"
                aria-label={`${fleetConfig.name} — overview`}
                className="touch-hit shrink-0 transition-opacity duration-150 hover:opacity-70"
              >
                <span className="hidden whitespace-nowrap text-[19px] font-extrabold leading-none tracking-[0.22em] sm:block">
                  {fleetConfig.wordmark}<span className="text-brand">.</span>
                </span>
                {/* Phones: search, the bell and the account menu sit beside
                    it, so the full word fits at every width from 320 up, with
                    a task running too. WORDMARK_PHONE */}
                <span className="block whitespace-nowrap text-[15px] font-extrabold leading-none tracking-[0.16em] max-[339px]:text-[14px] max-[339px]:tracking-[0.12em] sm:hidden">
                  {fleetConfig.wordmark}<span className="text-brand">.</span>
                </span>
              </Link>
              {/* Shown when the room beside the wordmark holds it, whatever the
                  width and whatever is in the cluster (a running task adds a
                  control). A breakpoint could not know that: it ran under the
                  buttons at 768–784 and 1024–1032, and wider with a task running. */}
              <span className="eyebrow hidden min-w-0 truncate text-faint @min-[480px]:block">
                {fleetConfig.footerLabel}{dateStamp ? ` · ${dateStamp}` : ""}
              </span>
            </div>

            <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
              {/* The command palette's two doors: a box-shaped button from lg
                  up, an icon below. ⌘K and "/" open it at every width. */}
              <button
                type="button"
                onClick={() => setIsPaletteOpen(true)}
                aria-haspopup="dialog"
                aria-keyshortcuts="Meta+K Control+K"
                className="hidden h-[33px] min-w-[260px] items-center gap-2 rounded-md border border-line-strong bg-panel px-3 text-left transition-colors duration-150 hover:border-primary/60 lg:flex"
              >
                <Search size={14} strokeWidth={1.75} className="shrink-0 text-faint" aria-hidden="true" />
                <span className="flex-1 text-[12.5px] text-faint">Search or run a command</span>
                <Kbd>{modKey === "⌘" ? "⌘K" : "Ctrl K"}</Kbd>
              </button>
              <IconButton label="Search" keys={modKey === "⌘" ? "⌘K" : "Ctrl K"} aria-haspopup="dialog" className="lg:hidden" onClick={() => setIsPaletteOpen(true)}>
                <Search size={14} strokeWidth={1.75} />
              </IconButton>

              {/* Sync and the theme have their own buttons from md up. Below
                  that they live in the account menu, so the phone masthead
                  carries search, the bell and the menu, and nothing else. */}
              {!syncElsewhere && (
                <Tooltip label="Sync with GridPane" describes>
                  <Button variant="solid" onClick={handleSyncRemote} className="hidden md:inline-flex">
                    <RefreshCw size={14} strokeWidth={1.75} /> Sync
                  </Button>
                </Tooltip>
              )}

              {/* A sync running elsewhere (another tab, another device, npm run sync).
                  This tab's own task shows the button below instead. LED only on phones. */}
              {!isTaskRunning && <SyncIndicator />}

              {/* Persistent global task indicator — LED only on phones */}
              {isTaskRunning && (
                <Tooltip label="View the running task">
                  <button
                    type="button"
                    onClick={() => setIsModalOpen(true)}
                    aria-label="View the running task"
                    className="eyebrow touch-hit inline-flex h-[33px] items-center gap-1.5 rounded-md border border-line-strong bg-panel px-2.5 text-primary sm:px-3"
                  >
                    <Led tone="ok" ping /> <span className="hidden sm:inline">Running</span>
                  </button>
                </Tooltip>
              )}

              <IconButton
                label={!mounted ? "Switch theme" : resolvedTheme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
                onClick={toggleTheme}
                className="hidden md:inline-flex"
              >
                <ThemeGlyph />
              </IconButton>

              <ActionLogs
                open={isNotifOpen}
                onOpenChange={setIsNotifOpen}
                logs={notifications}
                setLogs={setNotifications}
                sites={sites}
                servers={servers}
                focusId={logFocusId}
                onFocusHandled={clearLogFocus}
              />

              <AccountMenu
                displayName={displayName}
                isDark={resolvedTheme === "dark"}
                themeKnown={mounted}
                onToggleTheme={toggleTheme}
                onSync={handleSyncRemote}
                onSignOut={() => setIsSignOutOpen(true)}
              />
            </div>
          </div>
        </div>

        {/* ── Nav rail — md+ only; phones use the bottom tab bar ── */}
        <div className="hidden border-b border-border pr-[var(--sbw,0px)] md:block">
          <Tabs
            id="masthead"
            label="Primary"
            size="rail"
            activeKey={activeNav}
            className="mx-auto w-full max-w-[1360px] px-5 lg:overflow-visible lg:px-8"
          >
            {navItems.map((item) =>
              item.href === "/firewall" ? (
                <FirewallMenu key={item.href} isActive={activeNav === item.href} />
              ) : (
                <Tab key={item.href} tabKey={item.href} href={item.href} label={item.name} />
              )
            )}
          </Tabs>
        </div>
      </header>

      {/* ── Command palette ────────────────────────────────────── */}
      <CommandPalette
        open={isPaletteOpen}
        onClose={closePalette}
        servers={servers}
        sites={sites}
        logs={notifications}
        isDark={resolvedTheme === "dark"}
        modKey={modKey}
        handlers={paletteHandlers}
      />

      {/* ── Sign out ───────────────────────────────────────────── */}
      <ConfirmDialog
        open={isSignOutOpen}
        onClose={() => setIsSignOutOpen(false)}
        title={`Sign out of ${fleetConfig.name}?`}
        confirmLabel="Sign out"
        tone="default"
        onConfirm={async () => {
          const { error } = await supabase.auth.signOut();
          if (error) throw new Error(`Could not sign out: ${error.message}`);
          router.push("/login");
        }}
      >
        {displayName} will need to sign in again on this device.
        {isTaskRunning ? " A task is running and will stop." : ""}
      </ConfirmDialog>
    </>
  );
}
