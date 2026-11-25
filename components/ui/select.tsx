import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & {
  wrapperClassName?: string;
};

export function Select({
  className,
  wrapperClassName,
  children,
  ...props
}: SelectProps) {
  return (
    <span className={cn("relative inline-flex", wrapperClassName)}>
      <select
        className={cn(
          "w-full appearance-none bg-panel border border-line-strong rounded-md px-3 py-[7px] pr-9 text-[12.5px] text-foreground focus:border-primary/60 disabled:opacity-40",
          className
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        size={14}
        strokeWidth={1.75}
        aria-hidden="true"
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-faint"
      />
    </span>
  );
}
