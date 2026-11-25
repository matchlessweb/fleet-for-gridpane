import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The theme mark: a half-filled circle, lit side left in light and right in
 * dark. Drawn from the theme class, not from state, so it is right on the
 * first paint and never pops in after the page loads.
 */
export function ThemeGlyph({ className, ...props }: React.ComponentPropsWithRef<"svg">) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-theme-glyph=""
      className={cn("rotate-180 dark:rotate-0", className)}
      {...props}
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" />
    </svg>
  );
}
