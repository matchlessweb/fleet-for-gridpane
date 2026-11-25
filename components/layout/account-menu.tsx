"use client";

import * as React from "react";
import Link from "next/link";
import { CircleUserRound, LogOut, RefreshCw, UserRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { IconButton, PopoverSheet } from "@/components/ui";
import { ThemeGlyph } from "@/components/layout/theme-glyph";

type AccountMenuProps = {
  displayName: string;
  isDark: boolean;
  /** False until the theme is known; the theme row then reads without a state. */
  themeKnown: boolean;
  onToggleTheme: () => void;
  onSync: () => void;
  onSignOut: () => void;
};

const row =
  "flex min-h-[44px] w-full items-center gap-3 px-4 text-left text-[13px] font-medium outline-none transition-colors duration-150 hover:bg-panel-2/60 focus-visible:bg-panel-2 sm:min-h-[38px]";

/**
 * AccountMenu — who is signed in and what they can do from anywhere. Below
 * `md` the masthead keeps only search and the bell, so the theme and the sync
 * live here; from `md` up they have their own buttons and this holds the
 * profile and sign out. A dropdown from `sm` up, a bottom sheet on phones.
 */
export function AccountMenu({ displayName, isDark, themeKnown, onToggleTheme, onSync, onSignOut }: AccountMenuProps) {
  const [open, setOpen] = React.useState(false);
  const anchorRef = React.useRef<HTMLDivElement>(null);
  const close = React.useCallback(() => setOpen(false), []);

  // Up and Down walk the rows that are showing, as a menu does.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]')).filter((el) => el.getClientRects().length > 0);
    if (items.length === 0) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : e.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    items[next].focus();
  };

  return (
    <div className="relative" ref={anchorRef}>
      <IconButton label="Account" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <CircleUserRound size={14} strokeWidth={1.75} />
      </IconButton>

      <PopoverSheet open={open} onClose={close} anchorRef={anchorRef} label="Account" className="w-[260px]">
        <div className="border-b border-border px-4 pb-3 pt-1.5 sm:pt-3.5">
          <div className="eyebrow text-muted-foreground">Signed in</div>
          <div className="mt-1 truncate text-[13px] font-bold">{displayName}</div>
        </div>
        <div role="menu" aria-label="Account" onKeyDown={onKeyDown} className="py-1.5 pb-[calc(6px+env(safe-area-inset-bottom))] sm:pb-1.5">
          {/* Focus starts on the first row that is showing: this one below md, Profile from md up. */}
          <button type="button" role="menuitemcheckbox" data-autofocus="" aria-checked={themeKnown ? isDark : undefined} onClick={onToggleTheme} className={cn(row, "md:hidden")}>
            <ThemeGlyph className="shrink-0 text-muted-foreground" />
            <span className="flex-1">Dark theme</span>
            {themeKnown && <span className="font-mono text-[11px] text-muted-foreground">{isDark ? "On" : "Off"}</span>}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close();
              onSync();
            }}
            className={cn(row, "md:hidden")}
          >
            <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-muted-foreground" />
            <span className="flex-1">Sync from GridPane</span>
          </button>
          <Link href="/settings/profile" role="menuitem" data-autofocus="" onClick={close} className={row}>
            <UserRound size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-muted-foreground" />
            <span className="flex-1">Profile</span>
          </Link>
          <div aria-hidden="true" className="my-1.5 border-t border-border" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close();
              onSignOut();
            }}
            className={row}
          >
            <LogOut size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-muted-foreground" />
            <span className="flex-1">Sign out</span>
          </button>
        </div>
      </PopoverSheet>
    </div>
  );
}
