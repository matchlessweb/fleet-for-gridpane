import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server'
import { mayUseApp } from '@/lib/auth-assurance'
import { ACCESS_JWT_HEADER, checkAccessGate, refusalMessage } from '@/lib/access-gate'
import { inAppScope } from '@/lib/middleware-scope'
import { getPatchstackProtection } from './patchstack.next'

// Deliberately the DEPRECATED middleware.ts convention, not Next 16's proxy.ts,
// so the build's "middleware is deprecated" warning is expected. proxy.ts runs on
// the Node.js runtime only. @opennextjs/cloudflare can bundle Node middleware now,
// but prints at build that it is "experimental in cloudflare, and not officially
// maintained by OpenNext maintainers. Use at your own risk" (read in 1.20.18,
// 2026-11-21; earlier: cloudflare/workers-sdk#13755, #13937). This file is the
// front door, the Access check and the session check for every request, so it
// stays on the Edge runtime, which the Workers deploy supports, and everything
// here is fetch-based @supabase/ssr, which is Edge-safe.
// Move to proxy.ts once the adapter supports Node middleware officially.
export async function middleware(request: NextRequest, event: NextFetchEvent) {
  // #region patchstack-next-composed (Patchstack's request guard, first: it can only refuse a request, never let one in)
  // `event` carries the request's waitUntil: it keeps the guard's build and its background rule
  // refresh running past a cancelled request or a finished response (patchstack.next.ts says why).
  const psProtection = await getPatchstackProtection((promise) => event.waitUntil(promise), "middleware");
  const psBlocked = psProtection && await psProtection.fetchGuard()(request, event);
  if (psBlocked) return psBlocked;
  // #endregion
  // Outside the app's scope (static files, icons, the manifest): screened above, nothing more to do.
  // lib/middleware-scope.ts says which paths those are.
  if (!inAppScope(request.nextUrl.pathname)) return

  // The front door for the app: when the two Cloudflare Access settings
  // are set, a request without a token Access signed for this application goes no
  // further, not even to the login page. lib/access-gate.ts says what counts.
  const gate = await checkAccessGate({
    accessJwt: request.headers.get(ACCESS_JWT_HEADER),
    env: { CF_ACCESS_TEAM_DOMAIN: process.env.CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD: process.env.CF_ACCESS_AUD },
  })
  if (!gate.allow) {
    console.warn(`access gate: refused ${request.nextUrl.pathname} (${gate.reason})`)
    const headers = { 'cache-control': 'no-store' }
    // In a development run only, a request with no token is also told the likely cause.
    const message = refusalMessage(gate, process.env.NODE_ENV === 'development')
    return request.nextUrl.pathname.startsWith('/api')
      ? NextResponse.json({ error: message }, { status: gate.status, headers })
      : new NextResponse(`${message}\n`, { status: gate.status, headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' } })
  }
  // Says on every answer whether the check ran, so a person signed in through
  // Access can see in the browser's network panel that it is on.
  const stamp = <T extends NextResponse>(response: T): T => {
    response.headers.set('x-fleet-access-check', gate.checked ? 'on' : 'off')
    return response
  }

  let supabaseResponse = NextResponse.next({
    request,
  })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          // If the cookies are updated, ensure the incoming request gets them
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          // Create a new response with the cookies populated explicitly
          supabaseResponse = NextResponse.next({
            request,
          })
          // Stamp the refreshed cookies onto the outgoing response
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const {
    data: { user },
  } = await supabase.auth.getUser()

  // Past /login the session must be strong (a code from an authenticator app, or a
  // passkey) and the account must have an authenticator app: lib/auth-assurance.ts
  // says why both. An account without one sets it up on /login. The database holds
  // every table to the strong-session rule, and no answer about the session is a no.
  let mayEnter = false
  if (user) {
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    mayEnter = mayUseApp(aal, user.factors)
  }
  const isFullyAuthenticated = !!user && mayEnter

  const url = request.nextUrl.clone()

  // Routing Permissions
  const isAuthRoute = url.pathname.startsWith('/login')
  const isApiRoute = url.pathname.startsWith('/api')

  // Everything except /login, /api/*, and the auth callback requires a fully authenticated session
  const isProtectedPath = !isAuthRoute && !isApiRoute && !url.pathname.startsWith('/auth/callback')

  if (isApiRoute && !isFullyAuthenticated) {
    return stamp(NextResponse.json({ error: 'Authentication required' }, { status: 401 }))
  }

  if (!isFullyAuthenticated && isProtectedPath) {
    url.pathname = '/login'
    return stamp(NextResponse.redirect(url))
  }

  // Only bounce off /login once the account may use the app: a session that still
  // owes a code, or an account with no authenticator app yet, has to stay here
  if (isFullyAuthenticated && isAuthRoute) {
    url.pathname = '/'
    return stamp(NextResponse.redirect(url))
  }

  return stamp(supabaseResponse)
}

export const config = {
  // Every request, so Patchstack's guard screens all of them. The Access check and
  // the session check keep their old, narrower scope: lib/middleware-scope.ts.
  matcher: "/:path*",
}
