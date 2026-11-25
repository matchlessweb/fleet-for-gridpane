import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Geist } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { ThemeColorSync } from "@/components/theme-color-sync";
import { Toaster } from "@/components/ui/toaster";
import { fleetConfig } from "@/fleet.config";

const jetBrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

const geist = Geist({
  variable: "--font-geist",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: fleetConfig.name,
    template: `%s · ${fleetConfig.name}`,
  },
  description: fleetConfig.description,
  appleWebApp: {
    capable: true,
    title: fleetConfig.name,
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // cover + safe-area padding on fixed chrome must ship together (see DESIGN.md §Mobile)
  viewportFit: "cover",
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: fleetConfig.themeColor.light },
    { media: "(prefers-color-scheme: dark)", color: fleetConfig.themeColor.dark },
  ],
};

/**
 * Runs before anything paints. Two jobs:
 *
 *  1. `__name`. next-themes sets the theme before paint by printing one of
 *     its functions into a <script>. The Cloudflare build (esbuild, keepNames)
 *     wraps inner functions in `__name(...)`, a helper that only exists inside
 *     the bundle, so on the deployed app that script threw "__name is not
 *     defined" and dark-mode users saw a light flash until hydration. A plain
 *     `next build` does not add the calls, which is why it never showed locally.
 *  2. `--sbw`: how much width this browser holds for a scrollbar (0 where
 *     scrollbars overlay). The page's scroller always holds that space
 *     (`scrollbar-gutter: stable`), and the masthead and ticker pad by the
 *     same amount so they stay lined up with the content. The probe uses
 *     `scrollbar-gutter: stable` too, not `overflow: scroll`: the two can
 *     report different widths, and this has to equal what the scroller
 *     reserves. Measured again on resize, because zooming changes it.
 */
const BOOT_SCRIPT =
  '(function(){var w=window,d=document;w.__name=w.__name||function(f){return f};' +
  'function m(){try{var e=d.createElement("div");' +
  'e.style.cssText="position:absolute;top:-999px;width:99px;height:99px;overflow-y:auto;scrollbar-gutter:stable";' +
  'd.body.appendChild(e);d.documentElement.style.setProperty("--sbw",(e.offsetWidth-e.clientWidth)+"px");d.body.removeChild(e)}catch(_){}}' +
  'm();w.addEventListener("resize",m)})()';

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geist.variable} ${jetBrainsMono.variable} font-sans h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        {/* #region patchstack (managed by patchstack-connect — do not edit) */}
        {process.env.NODE_ENV === 'production' && (
          <script
            data-patchstack-build="true"
            dangerouslySetInnerHTML={{ __html: 'window.__PATCHSTACK_PROD__=true;window.__PATCHSTACK_BUILD__="5b4672489b5f";' }}
          />
        )}
        {/* #endregion patchstack */}
        {/* With credentials, so the fetch carries the Cloudflare Access cookie. See app/site.webmanifest/route.ts. */}
        <link rel="manifest" href="/site.webmanifest" crossOrigin="use-credentials" />
      </head>
      <body className="min-h-full flex flex-col">
        <script dangerouslySetInnerHTML={{ __html: BOOT_SCRIPT }} />
        <ThemeProvider attribute="class" defaultTheme="light" enableSystem disableTransitionOnChange>
          <ThemeColorSync />
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
