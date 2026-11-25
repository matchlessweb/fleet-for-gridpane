-- A record of each GridPane sync, so every signed-in screen (and an agent, with
-- npm run sync:status) can see that a sync is running, how far it has got, and how
-- the last one ended. Before this, progress lived only in the browser tab that
-- started the sync, and the command-line sync (npm run sync) recorded nothing.
--
-- One row per sync, written only by the service: the app's sync route and the
-- command-line sync. A browser reads it and cannot change it.
--
--   status        running, then complete (every site read), partial (finished,
--                 some sites not read), failed, or stopped (it stopped reporting:
--                 the tab that ran it closed, or the next sync found it silent).
--   heartbeat_at  moved forward as the sync works. A running row whose heartbeat
--                 is old has stopped; the next sync marks it stopped.
--
-- Only one sync may run at a time: the unique index below admits one running row,
-- so two syncs started together cannot both begin.
--
-- Adds a table only; nothing else is read or rewritten. Safe to run more than once.
-- To undo: supabase/rollbacks/20261124000000_sync_runs.sql

create table if not exists public.sync_runs (
  id            uuid primary key default gen_random_uuid(),
  source        text not null check (source in ('app', 'cli')),
  status        text not null default 'running'
                check (status in ('running', 'complete', 'partial', 'failed', 'stopped')),
  phase         text not null default 'starting',
  started_by    uuid,
  started_at    timestamptz not null default now(),
  heartbeat_at  timestamptz not null default now(),
  finished_at   timestamptz,
  servers_saved integer,
  sites_total   integer,
  sites_done    integer not null default 0,
  sites_read    integer not null default 0,
  schedules     integer not null default 0,
  errors        integer not null default 0,
  message       text
);

comment on table public.sync_runs is
  'One row per GridPane sync: its progress while it runs and how it ended. Written by the service only.';

create unique index if not exists sync_runs_one_running on public.sync_runs ((true)) where status = 'running';
create index if not exists sync_runs_started_at on public.sync_runs (started_at desc);

-- The same access as every other table: the strong-session rule, then read-only
-- for a signed-in account.
alter table public.sync_runs enable row level security;
drop policy if exists "strong session only" on public.sync_runs;
create policy "strong session only" on public.sync_runs as restrictive for all to anon, authenticated
  using ((select public.session_is_strong())) with check ((select public.session_is_strong()));
drop policy if exists "sync_runs authenticated read" on public.sync_runs;
create policy "sync_runs authenticated read" on public.sync_runs for select to authenticated using (true);

revoke all on table public.sync_runs from anon, authenticated;
grant select on table public.sync_runs to authenticated;
