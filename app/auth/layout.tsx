import type { Metadata } from "next";

// The address of the page this frames carries a one-time link from an email.
// It is never sent on to another site, and never indexed.
export const metadata: Metadata = { title: "Confirm your email", referrer: "no-referrer", robots: { index: false, follow: false } };

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-4 sm:p-6">
      <div className="w-full max-w-md">{children}</div>
    </div>
  );
}
