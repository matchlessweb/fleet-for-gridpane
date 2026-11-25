-- Three columns for the caching panel on the site page.
--
-- Fleet already keeps sites.nginx_caching (GridPane's page cache: redis, fastcgi,
-- or null when off). The panel also needs:
--   nginx_caching_ttl  the page cache's time to live in seconds, as GridPane
--                      reports it (site_customizer.nginx_caching_ttl). GridPane
--                      keeps the last value even while caching is off.
--   object_caching     the Redis object cache on or off
--                      (site_customizer.object_caching).
--   object_cache_pro   Object Cache Pro on or off. Shown only: GridPane's API has
--                      no way to change it (docs/gridpane-api-caching.md).
-- All three are filled by the sync from each site's GridPane record and are null
-- until the first sync after this file runs.
--
-- Adds columns only; nothing is read or rewritten. Safe to run more than once.
-- To undo: supabase/rollbacks/20261123000000_site_caching.sql

alter table public.sites add column if not exists nginx_caching_ttl integer;
alter table public.sites add column if not exists object_caching boolean;
alter table public.sites add column if not exists object_cache_pro boolean;
