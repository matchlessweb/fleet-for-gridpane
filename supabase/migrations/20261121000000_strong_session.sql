-- A signed-in session must have passed a second factor before the database
-- answers it.
--
-- Until now every table's rule was "any signed-in account". The app sends a
-- password-only session to the second-factor screen, but the database did not
-- know that: the same session could read every table straight through the
-- database's own API, past the app. This closes that.
--
--   1. public.session_is_strong(): true when the session's token says it is at
--      assurance level 2 (a one-time code was entered), or that the sign-in was
--      made with a passkey. It is the same rule the app applies in
--      lib/auth-assurance.ts; scripts/test-strong-session.mjs holds the two
--      together.
--   2. One RESTRICTIVE rule on every table in `public`: whatever else a table's
--      rules allow, a session that is not strong gets nothing. A restrictive
--      rule narrows; it never grants.
--   3. Least privilege. A signed-out caller keeps no table privilege at all
--      (it had some, with only the row rules standing in the way). A signed-in
--      account keeps SELECT, plus exactly the INSERT, UPDATE or DELETE the app
--      uses from the browser, on the five tables it writes there. Nobody but
--      the service keeps TRUNCATE, which row rules do not govern. Tables,
--      sequences and functions made later start closed.
--   4. The functions the server agents call stay open to a signed-out caller
--      (each checks the server's own token) and close to signed-in accounts,
--      which never call them.
--
--   5. The file checks its own result and stops, changing nothing, if a
--      privilege could not be taken back.
--
-- Safe to run more than once. To undo: supabase/rollbacks/20261121000000_strong_session.sql
-- The service role is not affected: it bypasses row rules, as before.

-- ── 1. the rule ──────────────────────────────────────────────────────────────
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

-- ── 2. one restrictive rule on every table ───────────────────────────────────
do $do$
declare t record;
begin
  for t in select c.relname as name
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r'
            order by c.relname
  loop
    execute format('alter table public.%I enable row level security', t.name);
    execute format('drop policy if exists "strong session only" on public.%I', t.name);
    -- (select ...) lets the planner work the answer out once for the statement, not once a row.
    execute format(
      'create policy "strong session only" on public.%I as restrictive for all to anon, authenticated '
      'using ((select public.session_is_strong())) with check ((select public.session_is_strong()))', t.name);
  end loop;
end $do$;

-- ── 3. least privilege on tables ─────────────────────────────────────────────
do $do$
declare
  t record;
  more text;
  -- What the app does to each table from the browser, as the signed-in account.
  -- A table not named here is read only: the service writes it.
  browser constant jsonb := '{
    "app_settings":       "select, update",
    "ip_allowlist":       "select, insert, update",
    "ip_blocks":          "select, insert, update",
    "site_staging_state": "select, insert, update",
    "system_logs":        "select, insert, update, delete"
  }';
  -- Tables no browser reads: the service and the agents' functions only.
  closed constant text[] := array['server_agent_secrets'];
begin
  for t in select c.relname as name
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r'
            order by c.relname
  loop
    execute format('revoke all on table public.%I from anon, authenticated', t.name);
    if t.name = any (closed) or t.name like 'sso\_%' then
      continue;
    end if;
    execute format('grant %s on table public.%I to authenticated', coalesce(browser ->> t.name, 'select'), t.name);
  end loop;

  -- Look at the result. A REVOKE takes back only what the role running this file
  -- (or the table's owner) granted, and says nothing when it could not: a grant
  -- another role made is still there. So each table must now give the signed-in
  -- account exactly what is named above, on the table or on any column of it,
  -- and nothing else. If not, stop: run as one transaction, that undoes it all.
  select string_agg(format('%s on %s', upper(p.name), c.relname), ', ' order by c.relname, p.name) into more
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) as p(name)
   where n.nspname = 'public' and c.relkind = 'r'
     and (has_table_privilege('authenticated', c.oid, p.name)
          or (p.name in ('select', 'insert', 'update', 'references') and has_any_column_privilege('authenticated', c.oid, p.name)))
     and not (c.relname <> all (closed) and c.relname not like 'sso\_%'
              and p.name = any (string_to_array(coalesce(browser ->> c.relname, 'select'), ', ')));
  if more is not null then
    raise exception 'strong_session: a signed-in account still holds more than the app uses: %. Another role granted it; take it back as that role, then run this again.', more;
  end if;
end $do$;

-- A new row takes its number from the table's sequence. Where the account may
-- add rows it may draw the next number, and that is all it may do to a sequence.
revoke all on all sequences in schema public from anon, authenticated;
do $do$
declare s record;
begin
  for s in select seq.relname as name
             from pg_class seq
             join pg_namespace n on n.oid = seq.relnamespace
             join pg_depend d on d.objid = seq.oid and d.classid = 'pg_class'::regclass
                             and d.refclassid = 'pg_class'::regclass and d.deptype in ('a', 'i')
            where n.nspname = 'public' and seq.relkind = 'S'
              and has_table_privilege('authenticated', d.refobjid, 'insert')
  loop
    execute format('grant usage on sequence public.%I to authenticated', s.name);
  end loop;
end $do$;

-- A table, sequence or function made later starts closed to signed-out and
-- signed-in callers alike, and its migration says who may use it. (Postgres
-- itself still lets everyone run a new function until that migration revokes
-- it; scripts/test-strong-session.mjs fails if any function is left that way.)
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from anon, authenticated;

-- ── 4. the agents' functions ─────────────────────────────────────────────────
do $do$
declare f record;
begin
  for f in select p.oid::regprocedure as sig
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'report\_%'
  loop
    execute format('revoke all on function %s from public, authenticated', f.sig);
    execute format('grant execute on function %s to anon, service_role', f.sig);
  end loop;
end $do$;

-- ── 5. check, or change nothing ──────────────────────────────────────────────
-- A REVOKE takes back only what the role running this file (or the table's
-- owner) granted, and says nothing when it could not. So look at the result,
-- and stop with the reason if any of it did not take: scripts/apply-sql.sh runs
-- the file as one transaction, so stopping here undoes every step above.
do $do$
declare bad text;
begin
  select string_agg(c.relname, ', ' order by c.relname) into bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and (not c.relrowsecurity
          or not exists (select 1 from pg_policy p
                          where p.polrelid = c.oid and p.polname = 'strong session only' and not p.polpermissive));
  if bad is not null then
    raise exception 'strong_session: left without row security or the rule: %', bad;
  end if;

  select string_agg(c.relname, ', ' order by c.relname) into bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and has_table_privilege('anon', c.oid, 'select, insert, update, delete, truncate, references, trigger');
  if bad is not null then
    raise exception 'strong_session: a signed-out caller still holds a privilege on: %. Another role granted it; take it back as that role, then run this again.', bad;
  end if;

  -- What a signed-in account holds was checked in step 3, beside the list of what the app uses.

  select string_agg(p.proname, ', ' order by p.proname) into bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'report\_%'
     and has_function_privilege('authenticated', p.oid, 'execute');
  if bad is not null then
    raise exception 'strong_session: a signed-in account may still run: %', bad;
  end if;
end $do$;
