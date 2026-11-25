import * as React from "react";
import { cn } from "@/lib/utils";

/* ComponentPropsWithRef, not HTMLAttributes — floating panels need a ref to
   measure themselves (see useViewportClamp). React 19 passes it as a prop. */
type PanelProps = React.ComponentPropsWithRef<"div">;

/**
 * Panel — the reserved white card (overlays, forms, contained tables).
 * Never nest panels. Advisories are rulehead sections, not cards — severity
 * rides on the figure, the Led and the label, never on an edge stripe.
 */
export function Panel({ className, ...props }: PanelProps) {
  return (
    <div
      className={cn("bg-panel border border-line-strong rounded-lg", className)}
      {...props}
    />
  );
}

/**
 * PanelHeader — the RULEHEAD idiom. The border-b-2 ink rule spans the full
 * row (it lives on the flex container, not the title).
 */
export function PanelHeader({
  title,
  meta,
  children,
  className,
}: {
  title: React.ReactNode;
  meta?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        // The title keeps to one line; on a narrow screen the meta drops under it instead of squeezing it.
        "flex flex-wrap items-baseline gap-x-2.5 gap-y-1 pb-2.5 border-b-2 border-foreground",
        className
      )}
    >
      {/* Rulehead TEXT only — the full-row ink rule lives on the container
          above, so the utility's own pb/rule is zeroed. */}
      <span className="rulehead max-w-full pb-0 border-b-0!">{title}</span>
      {meta != null && <span className="eyebrow text-faint">{meta}</span>}
      {children != null && (
        <div className="ml-auto flex items-center gap-2">{children}</div>
      )}
    </div>
  );
}
