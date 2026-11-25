"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { claimOverlay, releaseOverlay } from "./overlay-bus";
import { Panel } from "./panel";
import { Sheet } from "./sheet";
import { useIsPhone } from "./use-media";
import { autofocusTarget } from "./use-overlay";

type PopoverSheetProps = {
  open: boolean;
  onClose: () => void;
  /** Wraps the trigger and this panel (`relative`). A press outside it closes the panel. */
  anchorRef: React.RefObject<HTMLElement | null>;
  /** Its accessible name. */
  label: string;
  /** Sizing from `sm` up, e.g. `w-[400px]`. */
  className?: string;
  children: React.ReactNode;
};

/**
 * PopoverSheet — a panel that drops down from its trigger from `sm` up and
 * rises from the bottom on phones. The action logs and the account menu.
 * Anchored right, so it can never run off the right edge.
 */
export function PopoverSheet({ open, onClose, anchorRef, label, className, children }: PopoverSheetProps) {
  const isPhone = useIsPhone();
  if (!open) return null;
  if (isPhone) {
    return (
      <Sheet open onClose={onClose} label={label} contentClassName="flex flex-col overflow-hidden p-0">
        {children}
      </Sheet>
    );
  }
  return (
    <Dropdown onClose={onClose} anchorRef={anchorRef} label={label} className={className}>
      {children}
    </Dropdown>
  );
}

function Dropdown({ onClose, anchorRef, label, className, children }: Omit<PopoverSheetProps, "open">) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const onCloseRef = React.useRef(onClose);
  React.useEffect(() => {
    onCloseRef.current = onClose;
  });

  React.useEffect(() => {
    const close = () => onCloseRef.current();
    const anchor = anchorRef.current;
    const trigger = anchor?.querySelector<HTMLElement>("button");
    claimOverlay(close);
    (autofocusTarget(panelRef.current) ?? panelRef.current)?.focus({ preventScroll: true });

    // While a question is open on top (the page, this panel included, is
    // inert), presses and keys belong to the question.
    const covered = () => !!anchor?.closest("[inert]");
    const onPointerDown = (e: MouseEvent) => {
      if (covered()) return;
      if (anchor && !anchor.contains(e.target as Node)) close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || covered()) return;
      close();
      trigger?.focus({ preventScroll: true });
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      releaseOverlay(close);
    };
  }, [anchorRef]);

  return (
    <Panel
      ref={panelRef}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      className={cn("anim-fade absolute right-0 top-full z-50 mt-2 flex max-h-[min(560px,calc(100dvh-96px))] flex-col overflow-hidden shadow-2xl outline-none", className)}
    >
      {children}
    </Panel>
  );
}
