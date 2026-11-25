# Security

Fleet holds the keys to servers: a GridPane API token, a database service key, and scripts that run as root.
Please report a weakness privately before writing about it in public.

## Reporting a problem

Use **Report a vulnerability** under this repository's **Security** tab (GitHub's private reporting). Say what you
found, how to reproduce it, and what an attacker could do with it. Please do not open a public issue for it.

You should hear back within a week. There is no bounty.

## What is in scope

- The app: sign-in, sessions, the API routes, the database access rules in the SQL files.
- The server tools in `scripts/`: anything that lets a tool do more than its header says, or that leaks a token.
- The export and privacy tooling (`scripts/export-public.sh`, `scripts/privacy-gate.mjs`).

## What to know before you deploy it

- **Put it behind an access layer.** The project is built to sit behind Cloudflare Access, with its own sign-in
  (a passkey, or a password plus an authenticator code) behind that. The app's own sign-in is not meant to be the
  only door. Set `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` on the Worker so the app checks every request's
  Access token itself; without them it trusts that Access is in front. Store the two together, with
  `scripts/set-access-check.sh`: with only one of them set the app refuses every request. If Cloudflare's key
  address cannot be reached, the app goes on using the keys it last fetched, for up to a day; a token still has
  to be signed by one of them.
- **Turn off sign-ups** in your Supabase project. Accounts are made by you (`npm run user:create -- <email>`), never by a
  visitor.
- **A session opened with a password alone never enters.** A session must have had a code from an authenticator
  app, or been opened with a passkey, before the app lets it past the login page and before the database answers
  it. Both hold that rule, and both also ask that the account has an authenticator app: the middleware and API
  routes (`lib/auth-assurance.ts`), and one restrictive rule on every table
  (`supabase/migrations/20261121000000_strong_session.sql` and `20261122000000_authenticator_rule.sql`).
- **Until an account has an authenticator app, its password is all it has.** Supabase lets a session opened with a
  password alone add an authenticator app or a passkey, for as long as the account has no confirmed authenticator
  app. Whoever signs in first, with the password or a password-reset email, sets it up and is then let in. Once the
  account has one, Supabase asks for its code before either can be added. So:
  - Set up the authenticator app straight after making an account. Do not leave a new account waiting.
  - Every account needs an authenticator app, passkey users too. The app sends an account without one to set it
    up before it lets it in, and a passkey does not replace it.
  - `npm run doctor` names any account that has none (by the start of its id). Fix or remove each one.
- **The public (anon) key opens no table.** A signed-out caller holds no privilege on any table. The server agents
  use that key only to call their report functions, and each call must carry that server's own token.
- **The service-role key passes every access rule.** It belongs in the Worker's secrets and in `.env.local` on your
  own machine, nowhere else.
- **Deploy with `npm run deploy`, never the build tool's own deploy.** The build copies every line of `.env.local`
  into the Worker's code, where any person, and any API token, that is allowed to read your account's Workers could
  read your keys. `npm run deploy` takes them out between the build and the deploy and stops if a value is still there.
- **The tools in `scripts/` run as root on your servers, at your own risk.** Read a tool's header before you run
  it: it says what the tool changes, how to look without changing anything, and how to undo it.
- **Your own details stay out of anything you publish.** If you fork this privately and publish changes, run
  `npm run export:check` first.
