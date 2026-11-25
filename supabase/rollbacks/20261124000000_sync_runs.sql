-- Undoes supabase/migrations/20261124000000_sync_runs.sql: drops the table of
-- sync records. Run it only after the app that writes it is no longer deployed,
-- or every sync will fail to start. What is lost is the history of past syncs;
-- the servers, sites and schedules they saved are untouched. Safe to run more
-- than once.

drop table if exists public.sync_runs;
