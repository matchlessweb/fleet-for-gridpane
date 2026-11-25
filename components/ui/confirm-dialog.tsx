"use client";

import * as React from "react";
import { Button } from "./button";
import { Sheet } from "./sheet";

type ConfirmDialogProps = {
  open: boolean;
  onClose: () => void;
  /** The question, with the number in it: "Delete 100 log entries?" */
  title: React.ReactNode;
  /** What happens, who it affects, and whether it can be undone. */
  children: React.ReactNode;
  /** Says what the button does: "Delete 100 entries", never "OK". */
  confirmLabel: React.ReactNode;
  cancelLabel?: React.ReactNode;
  /** "danger" for anything that deletes or changes live systems. */
  tone?: "danger" | "default";
  /** May be async: the dialog stays, busy, until it settles, and shows a failure in place. */
  onConfirm: () => void | Promise<void>;
};

/**
 * ConfirmDialog — the one way to ask before something is deleted or deployed.
 * It states the consequence in numbers, Cancel has the focus, and on phones it
 * is a bottom sheet with full-width buttons. It opens on top of whatever asked,
 * so Cancel goes back to a form with its values intact.
 */
export function ConfirmDialog({
  open,
  onClose,
  title,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "danger",
  onConfirm,
}: ConfirmDialogProps) {
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);
  const bodyId = React.useId();

  const run = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await onConfirm();
      setBusy(false);
      onClose();
    } catch (e) {
      setBusy(false);
      setFailure(e instanceof Error && e.message ? e.message : "That did not work.");
    }
  };

  const dismiss = () => {
    if (busy) return; // let it finish; closing now would hide the result
    setFailure(null);
    onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={dismiss}
      side="center"
      width={400}
      role="alertdialog"
      stack
      label={typeof title === "string" ? title : "Confirm"}
      describedBy={bodyId}
    >
      <div>
        <h2 className="text-balance text-[15px] font-bold leading-snug">
          {title}
        </h2>
        <div id={bodyId} className="mt-2 text-pretty text-[13px] leading-relaxed text-muted-foreground">
          {children}
        </div>
        {failure && (
          <p role="alert" className="mt-3 text-pretty text-[12.5px] font-medium text-danger">
            {failure}
          </p>
        )}
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button data-autofocus="" onClick={dismiss} disabled={busy} className="max-sm:w-full">
            {cancelLabel}
          </Button>
          <Button variant={tone === "danger" ? "danger" : "solid"} onClick={run} disabled={busy} aria-busy={busy} className="max-sm:w-full">
            {busy ? "Working…" : confirmLabel}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
