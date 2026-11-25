import * as React from "react";

export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="font-mono text-[10px] border border-line-strong rounded-sm px-1.5 py-0.5 text-muted-foreground bg-panel">
      {children}
    </kbd>
  );
}
