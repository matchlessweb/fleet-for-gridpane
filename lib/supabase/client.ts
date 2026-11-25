import { createBrowserClient } from '@supabase/ssr'

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: {
        // Passkeys (WebAuthn) are a Supabase beta: signInWithPasskey /
        // registerPasskey / auth.passkey.* all throw without this opt-in.
        experimental: { passkey: true },
      },
    }
  )
}
