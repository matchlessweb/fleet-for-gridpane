import { cn } from "@/lib/utils";

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("bg-panel-2 animate-pulse rounded-md", className)} />;
}
