"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { useTooltip } from "./tooltip";

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "ghost" | "solid" | "danger" | "warning";
  size?: "sm" | "md";
};

/* The Ledger has ONE strong button — the solid filled emerald. */
const variantClasses: Record<NonNullable<ButtonProps["variant"]>, string> = {
  solid: "bg-primary text-primary-foreground font-semibold hover:opacity-90",
  ghost:
    "bg-panel border border-line-strong text-muted-foreground hover:text-foreground",
  danger: "bg-panel border border-danger/40 text-danger hover:border-danger/70",
  warning:
    "bg-panel border border-warning/40 text-warning hover:border-warning/70",
};

const sizeClasses: Record<NonNullable<ButtonProps["size"]>, string> = {
  sm: "px-3 py-[5px] text-[11.5px] touch-hit",
  md: "px-4 py-2 text-[12.5px] touch-hit",
};

/**
 * The button's classes, for a link that should look like one (`<Link>` or
 * `<a>`). A real action is always a `Button`; this is only for navigation.
 */
export function buttonClasses({ variant = "ghost", size = "md", className }: Pick<ButtonProps, "variant" | "size" | "className"> = {}) {
  return cn(
    "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none",
    variantClasses[variant],
    sizeClasses[size],
    className
  );
}

export function Button({
  variant = "ghost",
  size = "md",
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      type="button"
      className={buttonClasses({ variant, size, className })}
      {...props}
    />
  );
}

/**
 * IconButton — a 33px square control that is only an icon. `label` names it for
 * screen readers and is the hint a mouse, the keyboard or a long press shows;
 * `keys` adds its shortcut to that hint. Never give it a `title`.
 */
export function IconButton({
  label,
  keys,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; keys?: string }) {
  const { triggerProps, tooltip } = useTooltip({ label, keys, disabled: props.disabled });
  const { ref, ...handlers } = triggerProps;
  type Handler = (e: never) => void;
  const merged = Object.fromEntries(
    Object.entries(handlers).map(([name, ours]) => {
      const theirs = (props as Record<string, unknown>)[name];
      return [
        name,
        typeof ours === "function" && typeof theirs === "function"
          ? (e: never) => {
              (theirs as Handler)(e);
              (ours as Handler)(e);
            }
          : ours,
      ];
    })
  );
  return (
    <>
      <button
        type="button"
        aria-label={label}
        className={cn(
          "touch-hit inline-flex h-[33px] w-[33px] items-center justify-center bg-panel border border-line-strong rounded-md text-muted-foreground hover:text-foreground transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none",
          className
        )}
        {...props}
        {...merged}
        ref={ref as React.Ref<HTMLButtonElement>}
      />
      {tooltip}
    </>
  );
}
