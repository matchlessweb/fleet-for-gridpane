import * as React from "react";
import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  stamp,
  stampClassName,
  children,
  className,
}: {
  title: React.ReactNode;
  stamp?: React.ReactNode;
  /** For a stamp wide enough to wrap on phones: `max-sm:basis-full` gives it its own line in every state. */
  stampClassName?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-baseline gap-3.5 gap-y-2", className)}>
      <h1 className="text-balance text-[26px] font-extrabold tracking-[-0.02em]">
        {title}
      </h1>
      {stamp != null && <span className={cn("eyebrow text-faint", stampClassName)}>{stamp}</span>}
      {children != null && (
        <div className="ml-auto flex items-center gap-2">{children}</div>
      )}
    </div>
  );
}
