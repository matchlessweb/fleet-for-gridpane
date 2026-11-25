-- The database asks for an authenticator app too, the way the app does.
--
-- The app lets an account in only when its session is strong (a one-time code,
-- or a passkey) AND the account has an authenticator app that was set up and
-- confirmed (mayUseApp in lib/auth-assurance.ts says why). Until now the
-- database asked only for the first half. So a session the app turns away could
-- still read and write through the database's own API, past the app: sign in
-- with a password alone, add a passkey (the sign-in service allows that while
-- the account has no authenticator app), sign in again with that passkey, and
-- every table answered.
--
--   1. public.account_has_authenticator(): true when the account the caller's
--      token is for has a confirmed authenticator app. The sign-in service
--      keeps that in auth.mfa_factors, which no browser may read, so this one
--      function runs as its owner. It takes no argument and answers only about
--      the caller's own token: nobody can ask about another account.
--   2. public.session_is_strong(), which every table's restrictive rule already
--      calls, now asks for both halves. The rules themselves do not change.
--   3. The file tries the new rule as a signed-in account before it finishes,
--      and stops, changing nothing, if the rule would turn away an account that
--      has an authenticator app, or let in one that has none.
--
-- What this does not close: the time before an account's first set-up, when its
-- password is all it has. Whoever signs in first sets the authenticator app up
-- (SECURITY.md); `npm run doctor` names any account still in that state.
--
-- Safe to run more than once. To undo: supabase/rollbacks/20261122000000_authenticator_rule.sql
-- The service role is not affected: it bypasses row rules, as before.

-- ── 1. does this account have an authenticator app ───────────────────────────
create or replace function public.account_has_authenticator()
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1
      from auth.mfa_factors f
     where f.user_id = case when (auth.jwt() ->> 'sub') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                            then (auth.jwt() ->> 'sub')::uuid end
       and f.factor_type::text = 'totp'
       and f.status::text = 'verified');
$fn$;
comment on function public.account_has_authenticator() is
  'True when the account the caller''s token is for has a confirmed authenticator app. Runs as its owner because no browser may read auth.mfa_factors; it takes no argument and answers only about the caller''s own token.';
revoke all on function public.account_has_authenticator() from public, anon, authenticated, service_role;
grant execute on function public.account_has_authenticator() to anon, authenticated, service_role;

-- ── 2. the rule every table already carries ──────────────────────────────────
create or replace function public.session_is_strong()
returns boolean
language sql
stable
set search_path = ''
as $fn$
  select coalesce(
    ((auth.jwt() ->> 'aal') = 'aal2'
     or exists (
      select 1
        from jsonb_array_elements(
               case when jsonb_typeof(auth.jwt() -> 'amr') = 'array'
                    then auth.jwt() -> 'amr' else '[]'::jsonb end) as entry
       where case when jsonb_typeof(entry) = 'object'
                  then entry ->> 'method' else entry #>> '{}' end = 'passkey'
     ))
    and public.account_has_authenticator(),
    false);
$fn$;
comment on function public.session_is_strong() is
  'True when the caller may use the database: the session passed a second factor (assurance level 2, or a passkey sign-in) and the account has a confirmed authenticator app. Every table''s restrictive rule calls it.';
revoke all on function public.session_is_strong() from public, anon, authenticated, service_role;
grant execute on function public.session_is_strong() to anon, authenticated, service_role;

-- ── 3. check, or change nothing ──────────────────────────────────────────────
-- A rule that wrongly says no shuts every account out of its own dashboard, and
-- one that wrongly says yes is the gap this file is for. So try it here, as a
-- signed-in account, on this database: scripts/apply-sql.sh runs the file as one
-- transaction, so stopping undoes both steps above.
do $do$
declare
  me constant text := current_user;
  claims_were constant text := current_setting('request.jwt.claims', true);
  someone uuid;
  nobody constant uuid := gen_random_uuid();
begin
  if not has_table_privilege(me, 'auth.mfa_factors', 'select') then
    raise exception 'authenticator_rule: the role running this file (%) may not read auth.mfa_factors, so the rule it owns would say no to every account. Run it as a role that may.', me;
  end if;
  if row_security_active('auth.mfa_factors') then
    raise exception 'authenticator_rule: row security hides auth.mfa_factors from the role running this file (%), so the rule it owns would say no to every account. Run it as a role that row security does not apply to.', me;
  end if;

  select f.user_id into someone
    from auth.mfa_factors f
   where f.factor_type::text = 'totp' and f.status::text = 'verified'
   limit 1;

  set local role authenticated;

  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'aal', 'aal2', 'sub', nobody)::text, true);
  if public.session_is_strong() then
    raise exception 'authenticator_rule: the new rule lets in a session whose account has no authenticator app.';
  end if;

  -- With no account set up yet (a new install) there is nobody to try the yes with.
  if someone is not null then
    perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'aal', 'aal2', 'sub', someone)::text, true);
    if not public.session_is_strong() then
      raise exception 'authenticator_rule: the new rule turns away a session with a one-time code whose account has an authenticator app. Applying it would empty every dashboard.';
    end if;
    perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'aal', 'aal1', 'sub', someone, 'amr', jsonb_build_array(jsonb_build_object('method', 'password')))::text, true);
    if public.session_is_strong() then
      raise exception 'authenticator_rule: the new rule lets in a password-only session.';
    end if;
  end if;

  execute format('set local role %I', me);
  perform set_config('request.jwt.claims', coalesce(claims_were, ''), true);
end $do$;
