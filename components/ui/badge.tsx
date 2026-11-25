import * as React from "react";
import { cn } from "@/lib/utils";

type LedTone = "ok" | "warn" | "danger";

/** 6px status dot. ping uses anim-blink — the Ledger blinks, print-style. */
export function Led({
  tone = "ok",
  ping = false,
  className,
}: {
  tone?: LedTone;
  ping?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block h-[6px] w-[6px] shrink-0 rounded-full",
        tone === "ok" && "bg-primary",
        tone === "warn" && "bg-warning",
        tone === "danger" && "bg-danger",
        ping && "anim-blink",
        className
      )}
    />
  );
}

type PillTone = "neutral" | "ok" | "live" | "warn" | "danger";

/** Eyebrow-styled status tag. tone="live" auto-renders a blinking Led. */
export function StatusPill({
  tone = "neutral",
  led = false,
  className,
  children,
}: {
  tone?: PillTone;
  led?: boolean;
  className?: string;
  children?: React.ReactNode;
}) {
  const showLed = led || tone === "live";
  const ledTone: LedTone =
    tone === "warn" ? "warn" : tone === "danger" ? "danger" : "ok";
  return (
    <span
      className={cn(
        "eyebrow inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm px-2 py-[3px]",
        (tone === "live" || tone === "ok") && "text-primary bg-primary/10",
        tone === "warn" && "text-warning bg-warning/10",
        tone === "danger" && "text-danger bg-danger/10",
        tone === "neutral" && "text-muted-foreground bg-panel-2",
        className
      )}
    >
      {showLed && <Led tone={ledTone} ping={tone === "live"} />}
      {children}
    </span>
  );
}
