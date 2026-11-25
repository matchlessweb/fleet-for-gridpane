import type { Metadata } from "next";

// The page this frames sends the browser on to a WordPress site. No address
// from Fleet goes with it.
export const metadata: Metadata = { title: "Sign in to WordPress", referrer: "no-referrer", robots: { index: false, follow: false } };

export default function SsoLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-4 sm:p-6">
      <div className="w-full max-w-md">{children}</div>
    </div>
  );
}
