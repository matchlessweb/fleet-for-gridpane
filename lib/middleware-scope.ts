// Which paths middleware.ts's Access check and session check apply to.
//
// This was middleware.ts's config.matcher until Patchstack's request guard went in
// front. The guard screens EVERY request, so the matcher is now the
// catch-all "/:path*", and this pattern keeps the old scope for everything after the
// guard. It is the same pattern the old matcher held:
//
//   '/((?!_next/static|_next/image|[^/]*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|webmanifest)$).*)'
//
// Manifest + icons must stay public: the browser fetches the manifest without auth
// cookies during add-to-home-screen, and a /login redirect breaks install. Only a
// name at the top level is let past (/icon-192.png, /site.webmanifest), and every
// real file is one. A path with a folder in it is checked whatever it ends in:
// /api/servers/5.png must not skip the Access check and the session check.
//
// scripts/test-middleware-scope.ts holds this to the old matcher's answers, as Next
// compiled them, so a change here cannot quietly widen what skips the checks.

export const APP_SCOPE = /^\/(?!_next\/static|_next\/image|[^/]*\.(?:svg|png|jpg|jpeg|gif|webp|ico|webmanifest)$).*$/

export function inAppScope(pathname: string): boolean {
  return APP_SCOPE.test(pathname)
}
