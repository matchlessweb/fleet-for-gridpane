-- The one row of data the dashboard needs before anyone uses it: the settings
-- row (id 1) holding the warn and critical thresholds, at their defaults.
-- The Settings page changes this row and never creates it, so without it a
-- new install's thresholds could not be saved. Safe to run more than once;
-- on a database that already has the row it changes nothing.
insert into public.app_settings (id) values (1) on conflict (id) do nothing;
