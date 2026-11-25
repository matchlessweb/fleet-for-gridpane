import * as React from "react";
import { cn } from "@/lib/utils";

/** Field — a label and its value on one line, for a quick-view panel or an opened phone row. */
export function Field({
  label,
  children,
  className,
}: {
  label: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-baseline justify-between gap-3 py-1.5 border-b border-border last:border-0",
        className
      )}
    >
      <span className="eyebrow text-faint">{label}</span>
      <span className="text-right text-[12.5px]">{children}</span>
    </div>
  );
}
