-- Undoes supabase/migrations/20261122000000_authenticator_rule.sql: the database goes
-- back to asking only for a strong session (a one-time code, or a passkey), whether or
-- not the account has an authenticator app. The app still asks for both.
--
-- Use it only if the dashboard comes up empty for an account that does have an
-- authenticator app and did pass its second factor, and tell whoever maintains the
-- migration what that session looked like. Safe to run more than once.
-- (To undo the migration before it as well, run its own rollback after this one.)

create or replace function public.session_is_strong()
returns boolean
language sql
stable
set search_path = ''
as $fn$
  select coalesce(
    (auth.jwt() ->> 'aal') = 'aal2'
    or exists (
      select 1
        from jsonb_array_elements(
               case when jsonb_typeof(auth.jwt() -> 'amr') = 'array'
                    then auth.jwt() -> 'amr' else '[]'::jsonb end) as entry
       where case when jsonb_typeof(entry) = 'object'
                  then entry ->> 'method' else entry #>> '{}' end = 'passkey'
    ),
    false);
$fn$;
comment on function public.session_is_strong() is
  'True when the caller''s session passed a second factor: assurance level 2, or a passkey sign-in. Every table''s restrictive rule calls it.';
revoke all on function public.session_is_strong() from public, anon, authenticated, service_role;
grant execute on function public.session_is_strong() to anon, authenticated, service_role;

drop function if exists public.account_has_authenticator();
