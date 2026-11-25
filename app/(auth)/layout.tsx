"use client";

import { useClientValue } from "@/lib/use-client-value";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  // Nothing is drawn on the server or in the first paint; the page follows in the browser.
  const mounted = useClientValue(() => true, false);

  if (!mounted) return null;

  return (
    <div className="min-h-dvh overflow-hidden bg-background flex items-center justify-center p-4 sm:p-6">
      {/* Single hairline-framed inner area — flat print, no decoration. */}
      <div className="flex w-full max-w-lg justify-center rounded-lg border border-border px-4 py-8 sm:px-8 sm:py-12">
        <div className="w-full max-w-md">{children}</div>
      </div>
    </div>
  );
}
