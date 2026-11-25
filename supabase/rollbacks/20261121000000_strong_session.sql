-- Undoes supabase/migrations/20261121000000_strong_session.sql: the tables go back to
-- "any signed-in account", with the privileges they had before it.
--
-- Use it only if the dashboard comes up empty for a session that did pass its second
-- factor, and tell whoever maintains the migration what that session looked like.
-- Written from the structure captured before the migration; safe to run more than once.

do $do$
declare t record;
begin
  for t in select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r'
  loop
    execute format('drop policy if exists "strong session only" on public.%I', t.name);
  end loop;
end $do$;

revoke all on table public."app_settings" from anon, authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public."app_settings" to anon;
grant delete, insert, references, select, trigger, truncate, update on table public."app_settings" to authenticated;
revoke all on table public."backup_history" from anon, authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public."backup_history" to anon;
grant delete, insert, references, select, trigger, truncate, update on table public."backup_history" to authenticated;
revoke all on table public."backup_schedules" from anon, authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public."backup_schedules" to anon;
grant delete, insert, references, select, trigger, truncate, update on table public."backup_schedules" to authenticated;
revoke all on table public."cloudflare_waf_runs" from anon, authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public."cloudflare_waf_runs" to anon;
grant delete, insert, references, select, trigger, truncate, update on table public."cloudflare_waf_runs" to authenticated;
revoke all on table public."cloudflare_zones" from anon, authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public."cloudflare_zones" to anon;
grant delete, insert, references, select, trigger, truncate, update on table public."cloudflare_zones" to authenticated;
revoke all on table public."fail2ban_events" from anon, authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public."fail2ban_events" to authenticated;
revoke all on table public."ip_allowlist" from anon, authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public."ip_allowlist" to anon;
grant delete, insert, references, select, trigger, truncate, update on table public."ip_allowlist" to authenticated;
revoke all on table public."ip_blocks" from anon, authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public."ip_blocks" to anon;
grant delete, insert, references, select, trigger, truncate, update on table public."ip_blocks" to authenticated;
revoke all on table public."php_opcache_state" from anon, authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public."php_opcache_state" to authenticated;
revoke all on table public."server_agent_secrets" from anon, authenticated;
revoke all on table public."server_fail2ban_state" from anon, authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public."server_fail2ban_state" to authenticated;
revoke all on table public."server_firewall_state" from anon, authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public."server_firewall_state" to anon;
grant delete, insert, references, select, trigger, truncate, update on table public."server_firewall_state" to authenticated;
revoke all on table public."server_hardware" from anon, authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public."server_hardware" to anon;
grant delete, insert, references, select, trigger, truncate, update on table public."server_hardware" to authenticated;
revoke all on table public."server_opcache_state" from anon, authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public."server_opcache_state" to authenticated;
revoke all on table public."server_telemetry" from anon, authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public."server_telemetry" to anon;
grant delete, insert, references, select, trigger, truncate, update on table public."server_telemetry" to authenticated;
revoke all on table public."server_waf_state" from anon, authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public."server_waf_state" to authenticated;
revoke all on table public."servers" from anon, authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public."servers" to anon;
grant delete, insert, references, select, trigger, truncate, update on table public."servers" to authenticated;
revoke all on table public."site_fail2ban_state" from anon, authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public."site_fail2ban_state" to authenticated;
revoke all on table public."site_staging_state" from anon, authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public."site_staging_state" to anon;
grant delete, insert, references, select, trigger, truncate, update on table public."site_staging_state" to authenticated;
revoke all on table public."site_waf_state" from anon, authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public."site_waf_state" to authenticated;
revoke all on table public."sites" from anon, authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public."sites" to anon;
grant delete, insert, references, select, trigger, truncate, update on table public."sites" to authenticated;
revoke all on table public."system_logs" from anon, authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public."system_logs" to anon;
grant delete, insert, references, select, trigger, truncate, update on table public."system_logs" to authenticated;

-- Sequences and the defaults for new tables were not in the capture: these are the
-- grants every Supabase project starts with.
grant all on all sequences in schema public to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;

revoke all on function public."report_fail2ban"(p_server_id bigint, p_token text, p_report jsonb) from public, anon, authenticated, service_role;
grant execute on function public."report_fail2ban"(p_server_id bigint, p_token text, p_report jsonb) to anon, authenticated, service_role;
revoke all on function public."report_firewall_state"(p_server_id bigint, p_ufw_enabled boolean, p_ufw_denied_ips text[], p_nginx_denies jsonb, p_ufw_allowed_ips text[], p_fail2ban_ignoreip text[], p_fail2ban_banned jsonb, p_fail2ban_present boolean, p_token text, p_ufw_web_sources text[]) from public, anon, authenticated, service_role;
grant execute on function public."report_firewall_state"(p_server_id bigint, p_ufw_enabled boolean, p_ufw_denied_ips text[], p_nginx_denies jsonb, p_ufw_allowed_ips text[], p_fail2ban_ignoreip text[], p_fail2ban_banned jsonb, p_fail2ban_present boolean, p_token text, p_ufw_web_sources text[]) to public, anon, authenticated, service_role;
revoke all on function public."report_hardware"(p_server_id bigint, p_cpu_cores integer, p_ram_total_mb integer, p_vendor text, p_product text, p_token text) from public, anon, authenticated, service_role;
grant execute on function public."report_hardware"(p_server_id bigint, p_cpu_cores integer, p_ram_total_mb integer, p_vendor text, p_product text, p_token text) to public, anon, authenticated, service_role;
revoke all on function public."report_opcache"(p_server_id bigint, p_token text, p_report jsonb) from public, anon, authenticated, service_role;
grant execute on function public."report_opcache"(p_server_id bigint, p_token text, p_report jsonb) to anon, authenticated, service_role;
revoke all on function public."report_telemetry"(p_server_id bigint, p_cpu_usage numeric, p_ram_usage numeric, p_disk_usage numeric, p_disk_total_gb numeric, p_disk_www_mb numeric, p_disk_mysql_mb numeric, p_disk_backups_mb numeric, p_top_processes_b64 text, p_timestamp timestamp with time zone, p_token text) from public, anon, authenticated, service_role;
grant execute on function public."report_telemetry"(p_server_id bigint, p_cpu_usage numeric, p_ram_usage numeric, p_disk_usage numeric, p_disk_total_gb numeric, p_disk_www_mb numeric, p_disk_mysql_mb numeric, p_disk_backups_mb numeric, p_top_processes_b64 text, p_timestamp timestamp with time zone, p_token text) to public, anon, authenticated, service_role;
revoke all on function public."report_waf"(p_server_id bigint, p_token text, p_report jsonb) from public, anon, authenticated, service_role;
grant execute on function public."report_waf"(p_server_id bigint, p_token text, p_report jsonb) to anon, authenticated, service_role;

drop function if exists public.session_is_strong();
