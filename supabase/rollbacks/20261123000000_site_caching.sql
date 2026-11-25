-- Undoes supabase/migrations/20261123000000_site_caching.sql: drops the three
-- caching columns. Run it only after the app that reads them is no longer
-- deployed, or the sync's site writes will fail on the missing columns.
-- Nothing is lost that the next sync could not read again from GridPane.
-- Safe to run more than once.

alter table public.sites drop column if exists nginx_caching_ttl;
alter table public.sites drop column if exists object_caching;
alter table public.sites drop column if exists object_cache_pro;
