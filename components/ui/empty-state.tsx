import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { cn, tied } from "@/lib/utils";

export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: React.ReactNode;
  hint?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 py-10 text-center",
        className
      )}
    >
      {Icon != null && (
        <span className="flex h-9 w-9 items-center justify-center bg-panel-2 border border-border rounded-md">
          <Icon size={20} strokeWidth={1.75} className="text-faint" />
        </span>
      )}
      <div className="text-[13px] font-semibold">{title}</div>
      {hint != null && (
        <div className="text-pretty text-[12px] text-muted-foreground">{tied(hint)}</div>
      )}
      {action != null && <div className="mt-2">{action}</div>}
    </div>
  );
}
