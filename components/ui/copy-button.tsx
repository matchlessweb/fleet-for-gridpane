"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTooltip } from "./tooltip";

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older Safari and pages without clipboard permission.
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.cssText = "position:fixed;top:0;left:0;opacity:0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

type CopyButtonProps = {
  /** What lands on the clipboard. */
  value: string;
  /** What it is, for the hint and for screen readers: "IP address", "node ID". */
  what?: string;
  className?: string;
};

/**
 * useCopy — copies `value` when `copy` is called and says how it went for a
 * moment after. Shared by the icon button and the code block.
 */
export function useCopy(value: string) {
  const [state, setState] = React.useState<"idle" | "copied" | "failed">("idle");
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const copy = async (e?: React.MouseEvent) => {
    e?.stopPropagation(); // it often sits inside a row that opens on a press
    const ok = await writeClipboard(value);
    setState(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1600);
  };
  return { state, copy };
}

/**
 * CopyButton — a small icon beside an IP, an ID or a command. Pressing it
 * copies the value and the icon turns into a check for a moment. Its box never
 * changes size, so the text beside it does not move.
 */
export function CopyButton({ value, what = "value", className }: CopyButtonProps) {
  const { state, copy } = useCopy(value);
  const label = state === "copied" ? "Copied" : state === "failed" ? "Could not copy" : `Copy ${what}`;
  const { triggerProps, tooltip } = useTooltip({ label });

  return (
    <>
      <button
        type="button"
        {...triggerProps}
        onClick={copy}
        aria-label={`Copy ${what}: ${value}`}
        data-copied={state === "copied" || undefined}
        className={cn(
          "touch-hit inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-sm align-middle text-muted-foreground transition-colors duration-150 hover:bg-panel-2 hover:text-foreground",
          state === "copied" && "text-primary hover:text-primary",
          state === "failed" && "text-danger hover:text-danger",
          className
        )}
      >
        {state === "copied" ? <Check size={13} strokeWidth={2.25} aria-hidden="true" /> : <Copy size={12} strokeWidth={1.75} aria-hidden="true" />}
      </button>
      <span role="status" className="sr-only">
        {state === "copied" ? `Copied ${what}` : state === "failed" ? `Could not copy ${what}` : ""}
      </span>
      {tooltip}
    </>
  );
}

/**
 * Copyable — a mono value with its copy button, kept together on one line.
 * The usual way to show an IP, an ID, a hostname or a cron string.
 */
export function Copyable({
  value,
  what,
  children,
  className,
}: {
  value: string;
  what?: string;
  /** Shown instead of the raw value (for a shortened ID, say). The full value is still what gets copied. */
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex max-w-full items-center gap-1 whitespace-nowrap", className)}>
      <span className="min-w-0 truncate font-mono">{children ?? value}</span>
      <CopyButton value={value} what={what} />
    </span>
  );
}
