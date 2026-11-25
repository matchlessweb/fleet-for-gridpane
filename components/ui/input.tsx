import * as React from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

const fieldClasses =
  "bg-panel border border-line-strong rounded-md px-3 py-[7px] text-[12.5px] text-foreground placeholder:text-faint focus:border-primary/60 disabled:opacity-40";

export function Input({
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { className?: string }) {
  return <input className={cn(fieldClasses, className)} {...props} />;
}

export function SearchInput({
  className,
  wrapperClassName,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  wrapperClassName?: string;
}) {
  return (
    <span className={cn("relative inline-flex", wrapperClassName)}>
      <Search
        size={14}
        strokeWidth={1.75}
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
      />
      <input className={cn(fieldClasses, "w-full pl-9", className)} {...props} />
    </span>
  );
}
