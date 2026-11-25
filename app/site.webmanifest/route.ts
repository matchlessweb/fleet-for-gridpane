import { fleetConfig } from "@/fleet.config";

/**
 * The web app manifest, served from a route instead of Next's `app/manifest.ts`
 * convention, for one reason: that convention prints its own
 * `<link rel="manifest">` with no credentials, and Fleet sits behind Cloudflare
 * Access. A browser fetches a manifest without cookies unless the link says
 * `crossorigin="use-credentials"`, so Access answered every one with its login
 * page and the console logged a failure on each load. The root layout prints
 * the link itself, with credentials.
 */
const manifest = {
  name: fleetConfig.name,
  short_name: fleetConfig.shortName,
  description: fleetConfig.description,
  start_url: "/",
  display: "standalone",
  background_color: fleetConfig.themeColor.light,
  theme_color: fleetConfig.themeColor.light,
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    { src: "/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
};

export const dynamic = "force-static";

export function GET() {
  return new Response(JSON.stringify(manifest), {
    headers: { "Content-Type": "application/manifest+json; charset=utf-8" },
  });
}
