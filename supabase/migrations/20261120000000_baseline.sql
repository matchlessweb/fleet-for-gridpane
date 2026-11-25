-- The baseline: everything the dashboard's database holds, on an empty Supabase project.
--
-- Written by scripts/schema-to-migration.mjs from a capture of a working database's
-- structure. Do not edit it by hand: change the database, capture it again, and
-- write it again. scripts/test-baseline-migration.mjs proves this file builds the
-- structure in supabase/schema.snapshot.json.
--
-- It expects what every Supabase project has: the roles anon, authenticated and
-- service_role, and the schema `extensions`. Run it once, on a project with no
-- tables of its own.

-- ── extensions ──────────────────────────────────────────────────────────────
create extension if not exists pgcrypto with schema extensions;
-- pg_cron runs the two clean-up jobs at the end of this file. Where it is not offered, they are skipped.
do $do$ begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
  end if;
end $do$;

-- ── sequences ───────────────────────────────────────────────────────────────
create sequence public."cloudflare_waf_runs_id_seq";
create sequence public."fail2ban_events_id_seq";
create sequence public."ip_allowlist_id_seq";
create sequence public."ip_blocks_id_seq";

-- ── tables ──────────────────────────────────────────────────────────────────
create table public."app_settings" (
  "id" bigint default 1 not null,
  "cpu_warn" numeric default 75 not null,
  "cpu_critical" numeric default 90 not null,
  "memory_warn" numeric default 75 not null,
  "memory_critical" numeric default 90 not null,
  "disk_warn" numeric default 75 not null,
  "disk_critical" numeric default 90 not null,
  "updated_at" timestamp with time zone default now() not null
);
comment on table public."app_settings" is 'Single-row (id = 1) fleet configuration. Currently telemetry warn/critical thresholds, read by lib/thresholds.ts.';

create table public."backup_history" (
  "id" uuid default gen_random_uuid() not null,
  "schedule_id" bigint,
  "site_id" bigint,
  "server_id" bigint,
  "started_at" timestamp with time zone default now(),
  "completed_at" timestamp with time zone,
  "status" text not null,
  "size_bytes" bigint default 0,
  "storage_path" text,
  "job_id" text
);

create table public."backup_schedules" (
  "id" bigint not null,
  "site_id" bigint,
  "type" text,
  "service_id" bigint,
  "bup_schedule" text,
  "hour" text,
  "minute" text,
  "day" text,
  "created_at" timestamp with time zone,
  "updated_at" timestamp with time zone
);

create table public."cloudflare_waf_runs" (
  "id" bigint default nextval('cloudflare_waf_runs_id_seq'::regclass) not null,
  "report_sha256" text not null,
  "run_dir" text not null,
  "generated_at" timestamp with time zone not null,
  "zone_count" integer not null,
  "rule_count" integer not null,
  "masked_count" integer not null,
  "ingested_at" timestamp with time zone default now() not null
);

create table public."cloudflare_zones" (
  "zone_id" text not null,
  "name" text not null,
  "run_id" bigint not null,
  "plan" text,
  "account" text,
  "paused" boolean default false not null,
  "nrules" integer default 0 not null,
  "ratelimit_rules" integer default 0 not null,
  "ruleset_version" text,
  "ruleset_updated" date,
  "profile" text,
  "nearest" text,
  "klass" text not null,
  "comparable" boolean,
  "core_fp" text,
  "rule_order" jsonb default '[]'::jsonb not null,
  "order_matches" boolean,
  "findings" jsonb default '[]'::jsonb not null,
  "reach" jsonb default '{}'::jsonb not null,
  "rules" jsonb default '[]'::jsonb not null
);

create table public."fail2ban_events" (
  "id" bigint default nextval('fail2ban_events_id_seq'::regclass) not null,
  "server_id" bigint not null,
  "site" text,
  "jail" text not null,
  "ip" text not null,
  "event" text not null,
  "at" timestamp with time zone default now() not null
);

create table public."ip_allowlist" (
  "id" bigint default nextval('ip_allowlist_id_seq'::regclass) not null,
  "ip" text not null,
  "label" text not null,
  "scope" text default 'global'::text not null,
  "server_id" bigint,
  "site_id" bigint,
  "layers" text[] default '{}'::text[] not null,
  "note" text,
  "created_at" timestamp with time zone default now() not null,
  "removed_at" timestamp with time zone
);

create table public."ip_blocks" (
  "id" bigint default nextval('ip_blocks_id_seq'::regclass) not null,
  "ip" text not null,
  "layer" text not null,
  "scope" text not null,
  "server_id" bigint,
  "site_id" bigint,
  "reason" text,
  "created_at" timestamp with time zone default now() not null,
  "applied_at" timestamp with time zone,
  "removed_at" timestamp with time zone
);

create table public."php_opcache_state" (
  "server_id" bigint not null,
  "php_version" text not null,
  "reported_at" timestamp with time zone default now() not null,
  "pools" integer default 0 not null,
  "sites" jsonb default '[]'::jsonb not null,
  "ini" jsonb,
  "live" jsonb,
  "live_error" text,
  "prev" jsonb
);

create table public."server_agent_secrets" (
  "server_id" bigint not null,
  "token_hash" text not null,
  "created_at" timestamp with time zone default now() not null,
  "last_used_at" timestamp with time zone,
  "rotated_at" timestamp with time zone
);
comment on table public."server_agent_secrets" is 'SHA-256 hashes of per-server agent tokens. Never readable by anon or authenticated — RLS is on with no policies by design.';

create table public."server_fail2ban_state" (
  "server_id" bigint not null,
  "reported_at" timestamp with time zone default now() not null,
  "agent_format" integer default 1 not null,
  "fail2ban_present" boolean not null,
  "fail2ban_running" boolean not null,
  "fail2ban_version" text,
  "token_file_present" boolean not null,
  "gpcloudflare_conf" boolean not null,
  "auth_log_readable" boolean not null,
  "server_jails" jsonb default '[]'::jsonb not null,
  "orphan_jails" jsonb default '[]'::jsonb not null
);

create table public."server_firewall_state" (
  "server_id" bigint not null,
  "reported_at" timestamp with time zone default now() not null,
  "ufw_enabled" boolean,
  "ufw_denied_ips" text[] default '{}'::text[] not null,
  "nginx_denies" jsonb default '{}'::jsonb not null,
  "ufw_allowed_ips" text[],
  "fail2ban_ignoreip" text[],
  "fail2ban_banned" jsonb,
  "fail2ban_present" boolean,
  "ufw_web_sources" text[]
);

create table public."server_hardware" (
  "server_id" bigint not null,
  "cpu_cores" integer,
  "ram_total_mb" integer,
  "vendor" text,
  "product" text,
  "reported_at" timestamp with time zone default now() not null
);

create table public."server_opcache_state" (
  "server_id" bigint not null,
  "reported_at" timestamp with time zone default now() not null,
  "agent_format" integer default 1 not null
);

create table public."server_telemetry" (
  "id" bigint generated by default as identity not null,
  "server_id" bigint not null,
  "cpu_usage" numeric(5,2) not null,
  "ram_usage" numeric(5,2) not null,
  "disk_usage" numeric(5,2) not null,
  "timestamp" timestamp with time zone default now() not null,
  "disk_total_gb" numeric,
  "disk_www_mb" numeric,
  "disk_mysql_mb" numeric,
  "disk_backups_mb" numeric,
  "top_processes_b64" text
);

create table public."server_waf_state" (
  "server_id" bigint not null,
  "reported_at" timestamp with time zone default now() not null,
  "agent_format" integer default 1 not null
);

create table public."servers" (
  "id" bigint not null,
  "label" text not null,
  "ip" text not null,
  "region" text,
  "sub_id" text,
  "subdomain" text,
  "database" text,
  "webserver" text,
  "os_version" text,
  "status" text,
  "cpu" text,
  "ram" text,
  "region_label" text,
  "user_id" bigint,
  "provider_id" bigint,
  "failover_id" bigint,
  "high_availability_sync_interval" integer,
  "is_wsod" boolean,
  "record_id" text,
  "uuid" uuid,
  "us_enabled" boolean,
  "is_health_check_running" boolean,
  "is_paired" boolean,
  "is_preemptive_support_on" integer,
  "server_key" text,
  "update_backups" boolean,
  "beta_server" integer,
  "provider" jsonb
);

create table public."site_fail2ban_state" (
  "server_id" bigint not null,
  "site" text not null,
  "reported_at" timestamp with time zone default now() not null,
  "plugin" text not null,
  "mu_plugin" text,
  "plugin_dir" boolean,
  "configs" boolean,
  "included" boolean,
  "jails" jsonb default '[]'::jsonb not null,
  "bans" jsonb default '[]'::jsonb not null,
  "log_lines" jsonb default '[]'::jsonb not null,
  "log_24h" integer default 0 not null
);

create table public."site_staging_state" (
  "site_id" bigint not null,
  "is_active" boolean default false not null,
  "note" text,
  "noted_at" timestamp with time zone default now() not null
);

create table public."site_waf_state" (
  "server_id" bigint not null,
  "site" text not null,
  "reported_at" timestamp with time zone default now() not null,
  "waf" text,
  "rulesets" jsonb default '{}'::jsonb not null,
  "g8_mode" text default 'none'::text not null,
  "g8_loaded" boolean default false not null,
  "g8_version" text,
  "g8_log_bytes" bigint,
  "g8_log_at" timestamp with time zone,
  "g7_day" jsonb,
  "g8_day" jsonb
);

create table public."sites" (
  "id" bigint not null,
  "url" text not null,
  "server_id" bigint,
  "user_id" bigint,
  "system_user_id" bigint,
  "is_wsod" boolean,
  "is_sso" boolean,
  "is_ssl" boolean,
  "ssl_status" text,
  "resolved_at" timestamp with time zone,
  "php_version" text,
  "waf" text,
  "remote_bup" boolean,
  "local_bup" boolean,
  "automatic_updates" boolean,
  "nginx_caching" text,
  "site_security_settings" jsonb,
  "site_customizer" jsonb,
  "built_at" timestamp with time zone,
  "staging_site_built_at" text,
  "site_nickname" text,
  "cloudflare_dns_name" text,
  "max_execution_time" integer,
  "max_file_uploads" integer,
  "max_input_time" integer,
  "max_input_vars" integer,
  "memory_limit" integer,
  "post_max_size" integer,
  "upload_max_filesize" integer,
  "pm" text,
  "pm_max_children" integer,
  "pm_start_servers" integer,
  "pm_max_requests" integer,
  "pm_process_idle_timeout" integer,
  "is_php_slowlog" boolean,
  "php_slowlog_timeout" integer,
  "php_slowlog_trace_depth" integer
);

create table public."system_logs" (
  "id" uuid default gen_random_uuid() not null,
  "created_at" timestamp with time zone default timezone('utc'::text, now()) not null,
  "level" text not null,
  "message" text not null,
  "site_url" text,
  "is_read" boolean default false not null
);

alter sequence public."cloudflare_waf_runs_id_seq" owned by public."cloudflare_waf_runs"."id";
alter sequence public."fail2ban_events_id_seq" owned by public."fail2ban_events"."id";
alter sequence public."ip_allowlist_id_seq" owned by public."ip_allowlist"."id";
alter sequence public."ip_blocks_id_seq" owned by public."ip_blocks"."id";

-- ── keys, checks and links between tables ───────────────────────────────────
alter table public."app_settings" add constraint "app_settings_pkey" PRIMARY KEY (id);
alter table public."backup_history" add constraint "backup_history_pkey" PRIMARY KEY (id);
alter table public."backup_schedules" add constraint "backup_schedules_pkey" PRIMARY KEY (id);
alter table public."cloudflare_waf_runs" add constraint "cloudflare_waf_runs_pkey" PRIMARY KEY (id);
alter table public."cloudflare_zones" add constraint "cloudflare_zones_pkey" PRIMARY KEY (zone_id);
alter table public."fail2ban_events" add constraint "fail2ban_events_pkey" PRIMARY KEY (id);
alter table public."ip_allowlist" add constraint "ip_allowlist_pkey" PRIMARY KEY (id);
alter table public."ip_blocks" add constraint "ip_blocks_pkey" PRIMARY KEY (id);
alter table public."php_opcache_state" add constraint "php_opcache_state_pkey" PRIMARY KEY (server_id, php_version);
alter table public."server_agent_secrets" add constraint "server_agent_secrets_pkey" PRIMARY KEY (server_id);
alter table public."server_fail2ban_state" add constraint "server_fail2ban_state_pkey" PRIMARY KEY (server_id);
alter table public."server_firewall_state" add constraint "server_firewall_state_pkey" PRIMARY KEY (server_id);
alter table public."server_hardware" add constraint "server_hardware_pkey" PRIMARY KEY (server_id);
alter table public."server_opcache_state" add constraint "server_opcache_state_pkey" PRIMARY KEY (server_id);
alter table public."server_telemetry" add constraint "server_telemetry_pkey" PRIMARY KEY (id);
alter table public."server_waf_state" add constraint "server_waf_state_pkey" PRIMARY KEY (server_id);
alter table public."servers" add constraint "servers_pkey" PRIMARY KEY (id);
alter table public."site_fail2ban_state" add constraint "site_fail2ban_state_pkey" PRIMARY KEY (server_id, site);
alter table public."site_staging_state" add constraint "site_staging_state_pkey" PRIMARY KEY (site_id);
alter table public."site_waf_state" add constraint "site_waf_state_pkey" PRIMARY KEY (server_id, site);
alter table public."sites" add constraint "sites_pkey" PRIMARY KEY (id);
alter table public."system_logs" add constraint "system_logs_pkey" PRIMARY KEY (id);
alter table public."cloudflare_waf_runs" add constraint "cloudflare_waf_runs_report_sha256_key" UNIQUE (report_sha256);
alter table public."cloudflare_zones" add constraint "cloudflare_zones_name_key" UNIQUE (name);
alter table public."servers" add constraint "servers_ip_key" UNIQUE (ip);
alter table public."app_settings" add constraint "app_settings_cpu_critical_check" CHECK (((cpu_critical >= (0)::numeric) AND (cpu_critical <= (100)::numeric)));
alter table public."app_settings" add constraint "app_settings_cpu_warn_check" CHECK (((cpu_warn >= (0)::numeric) AND (cpu_warn <= (100)::numeric)));
alter table public."app_settings" add constraint "app_settings_disk_critical_check" CHECK (((disk_critical >= (0)::numeric) AND (disk_critical <= (100)::numeric)));
alter table public."app_settings" add constraint "app_settings_disk_warn_check" CHECK (((disk_warn >= (0)::numeric) AND (disk_warn <= (100)::numeric)));
alter table public."app_settings" add constraint "app_settings_id_check" CHECK ((id = 1));
alter table public."app_settings" add constraint "app_settings_memory_critical_check" CHECK (((memory_critical >= (0)::numeric) AND (memory_critical <= (100)::numeric)));
alter table public."app_settings" add constraint "app_settings_memory_warn_check" CHECK (((memory_warn >= (0)::numeric) AND (memory_warn <= (100)::numeric)));
alter table public."app_settings" add constraint "cpu_band" CHECK ((cpu_warn < cpu_critical));
alter table public."app_settings" add constraint "disk_band" CHECK ((disk_warn < disk_critical));
alter table public."app_settings" add constraint "memory_band" CHECK ((memory_warn < memory_critical));
alter table public."backup_history" add constraint "backup_history_status_check" CHECK ((status = ANY (ARRAY['success'::text, 'failed'::text, 'in_progress'::text])));
alter table public."ip_blocks" add constraint "ip_blocks_layer_check" CHECK ((layer = ANY (ARRAY['ufw'::text, 'nginx'::text, 'cloudflare'::text])));
alter table public."ip_blocks" add constraint "ip_blocks_scope_check" CHECK ((scope = ANY (ARRAY['server'::text, 'site'::text])));
alter table public."ip_blocks" add constraint "ip_blocks_target_ck" CHECK ((((scope = 'server'::text) AND (server_id IS NOT NULL)) OR ((scope = 'site'::text) AND (site_id IS NOT NULL))));
alter table public."backup_history" add constraint "backup_history_schedule_id_fkey" FOREIGN KEY (schedule_id) REFERENCES backup_schedules(id) ON DELETE SET NULL;
alter table public."backup_history" add constraint "backup_history_server_id_fkey" FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE;
alter table public."backup_history" add constraint "backup_history_site_id_fkey" FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE;
alter table public."backup_schedules" add constraint "backup_schedules_site_id_fkey" FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE;
alter table public."cloudflare_zones" add constraint "cloudflare_zones_run_id_fkey" FOREIGN KEY (run_id) REFERENCES cloudflare_waf_runs(id);
alter table public."ip_blocks" add constraint "ip_blocks_server_id_fkey" FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE;
alter table public."ip_blocks" add constraint "ip_blocks_site_id_fkey" FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE;
alter table public."server_firewall_state" add constraint "server_firewall_state_server_id_fkey" FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE;
alter table public."server_telemetry" add constraint "server_telemetry_server_id_fkey" FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE;
alter table public."site_staging_state" add constraint "site_staging_state_site_id_fkey" FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE;
alter table public."sites" add constraint "sites_server_id_fkey" FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE;

-- ── indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX cloudflare_zones_klass_idx ON public.cloudflare_zones USING btree (klass);
CREATE INDEX fail2ban_events_server_at_idx ON public.fail2ban_events USING btree (server_id, at DESC);
CREATE INDEX fail2ban_events_site_idx ON public.fail2ban_events USING btree (server_id, site, at DESC);
CREATE INDEX ip_allowlist_scope_idx ON public.ip_allowlist USING btree (scope) WHERE (removed_at IS NULL);
CREATE INDEX ip_allowlist_server_idx ON public.ip_allowlist USING btree (server_id) WHERE (removed_at IS NULL);
CREATE INDEX ip_allowlist_site_idx ON public.ip_allowlist USING btree (site_id) WHERE (removed_at IS NULL);
CREATE INDEX idx_ip_blocks_created ON public.ip_blocks USING btree (created_at DESC);
CREATE INDEX idx_ip_blocks_server ON public.ip_blocks USING btree (server_id) WHERE (removed_at IS NULL);
CREATE INDEX idx_ip_blocks_site ON public.ip_blocks USING btree (site_id) WHERE (removed_at IS NULL);
CREATE INDEX idx_server_telemetry_server_ts ON public.server_telemetry USING btree (server_id, "timestamp" DESC);
CREATE INDEX idx_server_telemetry_ts ON public.server_telemetry USING btree ("timestamp");
CREATE INDEX site_staging_state_active_idx ON public.site_staging_state USING btree (site_id) WHERE is_active;
CREATE INDEX sites_url_idx ON public.sites USING btree (url);

-- ── functions ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ingest_cloudflare_waf(p_report_sha256 text, p_run_dir text, p_generated_at timestamp with time zone, p_zones jsonb, p_allow_older boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
    v_latest  public.cloudflare_waf_runs%rowtype;
    v_run_id  bigint;
    v_removed text[];
    v_rules   integer;
    v_masked  integer;
begin
    if jsonb_typeof(p_zones) <> 'array' or jsonb_array_length(p_zones) = 0 then
        raise exception 'p_zones must be a non-empty array';
    end if;

    select * into v_latest from public.cloudflare_waf_runs
     order by generated_at desc, id desc limit 1;

    if found and v_latest.report_sha256 = p_report_sha256 then
        -- The same rules, read again later (the daily refresh on a quiet day).
        -- No zone is touched, but the run's date moves forward: it means "the
        -- fleet was last confirmed to look like this at", and without this a
        -- fleet nobody changed for two weeks would be shown as out of date.
        if p_generated_at > v_latest.generated_at then
            update public.cloudflare_waf_runs
               set generated_at = p_generated_at, run_dir = p_run_dir, ingested_at = now()
             where id = v_latest.id;
            return jsonb_build_object('changed', false, 'confirmed', true, 'run_id', v_latest.id);
        end if;
        return jsonb_build_object('changed', false, 'confirmed', false, 'run_id', v_latest.id);
    end if;

    if found and p_generated_at < v_latest.generated_at and not p_allow_older then
        raise exception 'report (%) is older than the latest ingested run (%)',
            p_generated_at, v_latest.generated_at;
    end if;

    select coalesce(sum(jsonb_array_length(z->'rules')), 0),
           coalesce(sum((select count(*) from jsonb_array_elements(z->'rules') r
                          where (r->>'expr_masked')::boolean)), 0)
      into v_rules, v_masked
      from jsonb_array_elements(p_zones) z;

    insert into public.cloudflare_waf_runs
        (report_sha256, run_dir, generated_at, zone_count, rule_count, masked_count)
    values
        (p_report_sha256, p_run_dir, p_generated_at, jsonb_array_length(p_zones), v_rules, v_masked)
    on conflict (report_sha256) do update
        set run_dir = excluded.run_dir, generated_at = excluded.generated_at, ingested_at = now()
    returning id into v_run_id;

    select coalesce(array_agg(name order by name), '{}') into v_removed
      from public.cloudflare_zones
     where zone_id not in (select z->>'zone_id' from jsonb_array_elements(p_zones) z);

    delete from public.cloudflare_zones
     where zone_id not in (select z->>'zone_id' from jsonb_array_elements(p_zones) z);

    -- A zone renamed onto a name another row still holds would trip the unique
    -- name constraint mid-upsert; clear any such stale holder first.
    delete from public.cloudflare_zones c
     using jsonb_array_elements(p_zones) z
     where c.name = z->>'name' and c.zone_id <> z->>'zone_id';

    insert into public.cloudflare_zones (
        zone_id, name, run_id, plan, account, paused, nrules, ratelimit_rules,
        ruleset_version, ruleset_updated, profile, nearest, klass, comparable,
        core_fp, rule_order, order_matches, findings, reach, rules
    )
    select z->>'zone_id', z->>'name', v_run_id, z->>'plan', z->>'acct',
           coalesce((z->>'paused')::boolean, false),
           coalesce((z->>'nrules')::integer, 0),
           coalesce((z->>'ratelimit_rules')::integer, 0),
           z->>'version', nullif(z->>'updated', '')::date,
           z->>'profile', z->>'nearest', z->>'klass', (z->>'comparable')::boolean,
           z->>'core_fp', coalesce(z->'order', '[]'::jsonb), (z->>'order_matches')::boolean,
           coalesce(z->'findings', '[]'::jsonb), coalesce(z->'reach', '{}'::jsonb),
           coalesce(z->'rules', '[]'::jsonb)
      from jsonb_array_elements(p_zones) z
    on conflict (zone_id) do update set
        name = excluded.name, run_id = excluded.run_id, plan = excluded.plan,
        account = excluded.account, paused = excluded.paused, nrules = excluded.nrules,
        ratelimit_rules = excluded.ratelimit_rules, ruleset_version = excluded.ruleset_version,
        ruleset_updated = excluded.ruleset_updated, profile = excluded.profile,
        nearest = excluded.nearest, klass = excluded.klass, comparable = excluded.comparable,
        core_fp = excluded.core_fp, rule_order = excluded.rule_order,
        order_matches = excluded.order_matches, findings = excluded.findings,
        reach = excluded.reach, rules = excluded.rules;

    return jsonb_build_object('changed', true, 'run_id', v_run_id,
        'zones', jsonb_array_length(p_zones), 'rules', v_rules, 'masked', v_masked,
        'removed', to_jsonb(v_removed));
end;
$function$;
revoke all on function public."ingest_cloudflare_waf"(p_report_sha256 text, p_run_dir text, p_generated_at timestamp with time zone, p_zones jsonb, p_allow_older boolean) from public, anon, authenticated, service_role;
grant execute on function public."ingest_cloudflare_waf"(p_report_sha256 text, p_run_dir text, p_generated_at timestamp with time zone, p_zones jsonb, p_allow_older boolean) to service_role;

CREATE OR REPLACE FUNCTION public.report_fail2ban(p_server_id bigint, p_token text, p_report jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
    v_now timestamptz := now();
begin
    if not public.verify_agent(p_server_id, p_token) then
        raise exception 'agent token required and must match for server %', p_server_id
            using errcode = '42501';
    end if;

    if jsonb_typeof(p_report) is distinct from 'object'
       or jsonb_typeof(p_report->'sites') is distinct from 'array'
       or jsonb_typeof(p_report->'server_jails') is distinct from 'array' then
        raise exception 'report must be an object with sites and server_jails arrays'
            using errcode = '22023';
    end if;

    -- Bans as they were at the last report, compared with the bans in this one.
    -- A ban is keyed by its jail and address; a server jail's bans carry no site.
    -- No event on a server's very first report: with nothing to compare against,
    -- every standing ban would be logged as new at once.
    if exists (select 1 from public.server_fail2ban_state where server_id = p_server_id) then
        with old_bans as (
            select s.site, b->>'jail' as jail, b->>'ip' as ip
              from public.site_fail2ban_state s, jsonb_array_elements(s.bans) b
             where s.server_id = p_server_id
            union all
            select null, j->>'name', b->>'ip'
              from public.server_fail2ban_state s,
                   jsonb_array_elements(s.server_jails) j,
                   jsonb_array_elements(coalesce(j->'bans', '[]'::jsonb)) b
             where s.server_id = p_server_id
        ), new_bans as (
            select x->>'site' as site, b->>'jail' as jail, b->>'ip' as ip,
                   nullif(b->>'at', '')::timestamptz as at
              from jsonb_array_elements(p_report->'sites') x,
                   jsonb_array_elements(coalesce(x->'bans', '[]'::jsonb)) b
            union all
            select null, j->>'name', b->>'ip', nullif(b->>'at', '')::timestamptz
              from jsonb_array_elements(p_report->'server_jails') j,
                   jsonb_array_elements(coalesce(j->'bans', '[]'::jsonb)) b
        )
        insert into public.fail2ban_events (server_id, site, jail, ip, event, at)
        select p_server_id, n.site, n.jail, n.ip, 'ban', coalesce(n.at, v_now)
          from new_bans n
         where n.jail is not null and n.ip is not null
           and not exists (select 1 from old_bans p where p.jail = n.jail and p.ip = n.ip)
        union all
        select p_server_id, p.site, p.jail, p.ip, 'unban', v_now
          from old_bans p
         where p.jail is not null and p.ip is not null
           and not exists (select 1 from new_bans n where n.jail = p.jail and n.ip = p.ip);
    end if;

    delete from public.fail2ban_events
     where server_id = p_server_id and at < v_now - interval '30 days';

    -- Replace this server's sites wholesale: a folder that is gone must not go on
    -- showing its last status.
    delete from public.site_fail2ban_state
     where server_id = p_server_id
       and site not in (select x->>'site' from jsonb_array_elements(p_report->'sites') x
                         where x->>'site' is not null);

    insert into public.site_fail2ban_state (
        server_id, site, reported_at, plugin, mu_plugin, plugin_dir, configs, included,
        jails, bans, log_lines, log_24h
    )
    select p_server_id, x->>'site', v_now,
           coalesce(x->>'plugin', 'broken'), x->>'mu_plugin',
           (x->>'plugin_dir')::boolean, (x->>'configs')::boolean, (x->>'included')::boolean,
           coalesce(x->'jails', '[]'::jsonb), coalesce(x->'bans', '[]'::jsonb),
           coalesce(x->'log', '[]'::jsonb), coalesce((x->>'log_24h')::integer, 0)
      from jsonb_array_elements(p_report->'sites') x
     where x->>'site' is not null
    on conflict (server_id, site) do update set
        reported_at = excluded.reported_at, plugin = excluded.plugin,
        mu_plugin = excluded.mu_plugin, plugin_dir = excluded.plugin_dir,
        configs = excluded.configs, included = excluded.included,
        jails = excluded.jails, bans = excluded.bans,
        log_lines = excluded.log_lines, log_24h = excluded.log_24h;

    insert into public.server_fail2ban_state (
        server_id, reported_at, agent_format, fail2ban_present, fail2ban_running,
        fail2ban_version, token_file_present, gpcloudflare_conf, auth_log_readable,
        server_jails, orphan_jails
    )
    values (
        p_server_id, v_now, coalesce((p_report->>'v')::integer, 1),
        coalesce((p_report#>>'{fail2ban,present}')::boolean, false),
        coalesce((p_report#>>'{fail2ban,running}')::boolean, false),
        nullif(p_report#>>'{fail2ban,version}', ''),
        coalesce((p_report->>'token_file')::boolean, false),
        coalesce((p_report->>'gpcloudflare_conf')::boolean, false),
        coalesce((p_report->>'auth_log')::boolean, false),
        p_report->'server_jails', coalesce(p_report->'orphan_jails', '[]'::jsonb)
    )
    on conflict (server_id) do update set
        reported_at = excluded.reported_at, agent_format = excluded.agent_format,
        fail2ban_present = excluded.fail2ban_present, fail2ban_running = excluded.fail2ban_running,
        fail2ban_version = excluded.fail2ban_version, token_file_present = excluded.token_file_present,
        gpcloudflare_conf = excluded.gpcloudflare_conf, auth_log_readable = excluded.auth_log_readable,
        server_jails = excluded.server_jails, orphan_jails = excluded.orphan_jails;
end;
$function$;
revoke all on function public."report_fail2ban"(p_server_id bigint, p_token text, p_report jsonb) from public, anon, authenticated, service_role;
grant execute on function public."report_fail2ban"(p_server_id bigint, p_token text, p_report jsonb) to anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.report_firewall_state(p_server_id bigint, p_ufw_enabled boolean, p_ufw_denied_ips text[], p_nginx_denies jsonb, p_ufw_allowed_ips text[] DEFAULT NULL::text[], p_fail2ban_ignoreip text[] DEFAULT NULL::text[], p_fail2ban_banned jsonb DEFAULT NULL::jsonb, p_fail2ban_present boolean DEFAULT NULL::boolean, p_token text DEFAULT NULL::text, p_ufw_web_sources text[] DEFAULT NULL::text[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
begin
    if not public.verify_agent(p_server_id, p_token) then
        raise exception 'agent token required and must match for server %', p_server_id
            using errcode = '42501';
    end if;

    insert into public.server_firewall_state (
        server_id, ufw_enabled, ufw_denied_ips, nginx_denies,
        ufw_allowed_ips, fail2ban_ignoreip, fail2ban_banned, fail2ban_present,
        ufw_web_sources, reported_at
    )
    values (
        p_server_id, p_ufw_enabled, p_ufw_denied_ips, p_nginx_denies,
        p_ufw_allowed_ips, p_fail2ban_ignoreip, p_fail2ban_banned, p_fail2ban_present,
        p_ufw_web_sources, now()
    )
    on conflict (server_id) do update set
        ufw_enabled       = excluded.ufw_enabled,
        ufw_denied_ips    = excluded.ufw_denied_ips,
        nginx_denies      = excluded.nginx_denies,
        ufw_allowed_ips   = excluded.ufw_allowed_ips,
        fail2ban_ignoreip = excluded.fail2ban_ignoreip,
        fail2ban_banned   = excluded.fail2ban_banned,
        fail2ban_present  = excluded.fail2ban_present,
        ufw_web_sources   = excluded.ufw_web_sources,
        reported_at       = excluded.reported_at;
end;
$function$;
revoke all on function public."report_firewall_state"(p_server_id bigint, p_ufw_enabled boolean, p_ufw_denied_ips text[], p_nginx_denies jsonb, p_ufw_allowed_ips text[], p_fail2ban_ignoreip text[], p_fail2ban_banned jsonb, p_fail2ban_present boolean, p_token text, p_ufw_web_sources text[]) from public, anon, authenticated, service_role;
grant execute on function public."report_firewall_state"(p_server_id bigint, p_ufw_enabled boolean, p_ufw_denied_ips text[], p_nginx_denies jsonb, p_ufw_allowed_ips text[], p_fail2ban_ignoreip text[], p_fail2ban_banned jsonb, p_fail2ban_present boolean, p_token text, p_ufw_web_sources text[]) to public, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.report_hardware(p_server_id bigint, p_cpu_cores integer, p_ram_total_mb integer, p_vendor text, p_product text, p_token text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
begin
    if not public.verify_agent(p_server_id, p_token) then
        raise exception 'agent token required and must match for server %', p_server_id
            using errcode = '42501';
    end if;

    insert into public.server_hardware (server_id, cpu_cores, ram_total_mb, vendor, product, reported_at)
    values (p_server_id, p_cpu_cores, p_ram_total_mb,
            nullif(btrim(p_vendor), ''), nullif(btrim(p_product), ''), now())
    on conflict (server_id) do update set
        cpu_cores    = excluded.cpu_cores,
        ram_total_mb = excluded.ram_total_mb,
        vendor       = excluded.vendor,
        product      = excluded.product,
        reported_at  = excluded.reported_at;
end;
$function$;
revoke all on function public."report_hardware"(p_server_id bigint, p_cpu_cores integer, p_ram_total_mb integer, p_vendor text, p_product text, p_token text) from public, anon, authenticated, service_role;
grant execute on function public."report_hardware"(p_server_id bigint, p_cpu_cores integer, p_ram_total_mb integer, p_vendor text, p_product text, p_token text) to public, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.report_opcache(p_server_id bigint, p_token text, p_report jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
    v_now timestamptz := now();
begin
    if not public.verify_agent(p_server_id, p_token) then
        raise exception 'agent token required and must match for server %', p_server_id
            using errcode = '42501';
    end if;

    if jsonb_typeof(p_report) is distinct from 'object'
       or jsonb_typeof(p_report->'versions') is distinct from 'array' then
        raise exception 'report must be an object with a versions array'
            using errcode = '22023';
    end if;

    delete from public.php_opcache_state
     where server_id = p_server_id
       and php_version not in (select x->>'version' from jsonb_array_elements(p_report->'versions') x
                                where x->>'version' is not null);

    insert into public.php_opcache_state as t (
        server_id, php_version, reported_at, pools, sites, ini, live, live_error, prev
    )
    select p_server_id, x->>'version', v_now,
           coalesce((x->>'pools')::integer, 0),
           case when jsonb_typeof(x->'sites') = 'array' then x->'sites' else '[]'::jsonb end,
           case when jsonb_typeof(x->'ini') = 'object' then x->'ini' end,
           case when jsonb_typeof(x->'live') = 'object' then x->'live' end,
           nullif(left(x->>'live_error', 200), ''),
           null
      from jsonb_array_elements(p_report->'versions') x
     where x->>'version' is not null
    on conflict (server_id, php_version) do update set
        -- Before the new numbers replace the old: keep the old counters, but only
        -- while it is the same PHP run. After a restart they start from zero.
        prev = case
                 when t.live is not null and excluded.live is not null
                  and t.live->>'start' is not distinct from excluded.live->>'start'
                  and t.live->>'last_restart' is not distinct from excluded.live->>'last_restart'
                 then jsonb_build_object('hits', t.live->'hits', 'misses', t.live->'misses', 'at', t.reported_at)
               end,
        reported_at = excluded.reported_at, pools = excluded.pools, sites = excluded.sites,
        ini = excluded.ini, live = excluded.live, live_error = excluded.live_error;

    -- The server row last: the app listens for it, so the version rows are in by then.
    insert into public.server_opcache_state (server_id, reported_at, agent_format)
    values (p_server_id, v_now, coalesce((p_report->>'v')::integer, 1))
    on conflict (server_id) do update set
        reported_at = excluded.reported_at, agent_format = excluded.agent_format;
end;
$function$;
revoke all on function public."report_opcache"(p_server_id bigint, p_token text, p_report jsonb) from public, anon, authenticated, service_role;
grant execute on function public."report_opcache"(p_server_id bigint, p_token text, p_report jsonb) to anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.report_telemetry(p_server_id bigint, p_cpu_usage numeric, p_ram_usage numeric, p_disk_usage numeric, p_disk_total_gb numeric DEFAULT NULL::numeric, p_disk_www_mb numeric DEFAULT NULL::numeric, p_disk_mysql_mb numeric DEFAULT NULL::numeric, p_disk_backups_mb numeric DEFAULT NULL::numeric, p_top_processes_b64 text DEFAULT NULL::text, p_timestamp timestamp with time zone DEFAULT NULL::timestamp with time zone, p_token text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
begin
    if not public.verify_agent(p_server_id, p_token) then
        raise exception 'agent token required and must match for server %', p_server_id
            using errcode = '42501';
    end if;

    insert into public.server_telemetry (
        server_id, cpu_usage, ram_usage, disk_usage, disk_total_gb,
        disk_www_mb, disk_mysql_mb, disk_backups_mb, top_processes_b64, "timestamp"
    )
    values (
        p_server_id, p_cpu_usage, p_ram_usage, p_disk_usage, p_disk_total_gb,
        p_disk_www_mb, p_disk_mysql_mb, p_disk_backups_mb, p_top_processes_b64,
        coalesce(p_timestamp, now())
    );
end;
$function$;
revoke all on function public."report_telemetry"(p_server_id bigint, p_cpu_usage numeric, p_ram_usage numeric, p_disk_usage numeric, p_disk_total_gb numeric, p_disk_www_mb numeric, p_disk_mysql_mb numeric, p_disk_backups_mb numeric, p_top_processes_b64 text, p_timestamp timestamp with time zone, p_token text) from public, anon, authenticated, service_role;
grant execute on function public."report_telemetry"(p_server_id bigint, p_cpu_usage numeric, p_ram_usage numeric, p_disk_usage numeric, p_disk_total_gb numeric, p_disk_www_mb numeric, p_disk_mysql_mb numeric, p_disk_backups_mb numeric, p_top_processes_b64 text, p_timestamp timestamp with time zone, p_token text) to public, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.report_waf(p_server_id bigint, p_token text, p_report jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
    v_now timestamptz := now();
begin
    if not public.verify_agent(p_server_id, p_token) then
        raise exception 'agent token required and must match for server %', p_server_id
            using errcode = '42501';
    end if;

    if jsonb_typeof(p_report) is distinct from 'object'
       or jsonb_typeof(p_report->'sites') is distinct from 'array' then
        raise exception 'report must be an object with a sites array'
            using errcode = '22023';
    end if;

    delete from public.site_waf_state
     where server_id = p_server_id
       and site not in (select x->>'site' from jsonb_array_elements(p_report->'sites') x
                         where x->>'site' is not null);

    insert into public.site_waf_state (
        server_id, site, reported_at, waf, rulesets, g8_mode, g8_loaded, g8_version,
        g8_log_bytes, g8_log_at, g7_day, g8_day
    )
    select p_server_id, x->>'site', v_now,
           nullif(x->>'waf', ''),
           case when jsonb_typeof(x->'rulesets') = 'object' then x->'rulesets' else '{}'::jsonb end,
           coalesce(nullif(x#>>'{g8,mode}', ''), 'none'),
           coalesce((x#>>'{g8,rules_loaded}')::boolean, false),
           nullif(x#>>'{g8,version}', ''),
           (x#>>'{g8,log_bytes}')::bigint,
           nullif(x#>>'{g8,log_at}', '')::timestamptz,
           case when jsonb_typeof(x->'g7_day') = 'object' then x->'g7_day' end,
           case when jsonb_typeof(x->'g8_day') = 'object' then x->'g8_day' end
      from jsonb_array_elements(p_report->'sites') x
     where x->>'site' is not null
    on conflict (server_id, site) do update set
        reported_at = excluded.reported_at, waf = excluded.waf, rulesets = excluded.rulesets,
        g8_mode = excluded.g8_mode, g8_loaded = excluded.g8_loaded, g8_version = excluded.g8_version,
        g8_log_bytes = excluded.g8_log_bytes, g8_log_at = excluded.g8_log_at,
        g7_day = excluded.g7_day, g8_day = excluded.g8_day;

    -- The server row last: the app listens for it, so the site rows are in by then.
    insert into public.server_waf_state (server_id, reported_at, agent_format)
    values (p_server_id, v_now, coalesce((p_report->>'v')::integer, 1))
    on conflict (server_id) do update set
        reported_at = excluded.reported_at, agent_format = excluded.agent_format;
end;
$function$;
revoke all on function public."report_waf"(p_server_id bigint, p_token text, p_report jsonb) from public, anon, authenticated, service_role;
grant execute on function public."report_waf"(p_server_id bigint, p_token text, p_report jsonb) to anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.verify_agent(p_server_id bigint, p_token text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
    v_ok boolean;
begin
    -- Cheap reject before touching the table. Also stops a caller probing with
    -- an empty string from being treated as a real attempt.
    if p_token is null or length(p_token) < 32 then
        return false;
    end if;

    update public.server_agent_secrets
       set last_used_at = now()
     where server_id  = p_server_id
       and token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    returning true into v_ok;

    return coalesce(v_ok, false);
end;
$function$;
revoke all on function public."verify_agent"(p_server_id bigint, p_token text) from public, anon, authenticated, service_role;
grant execute on function public."verify_agent"(p_server_id bigint, p_token text) to service_role;


-- ── who may read and write each table ───────────────────────────────────────
alter table public."app_settings" enable row level security;
revoke all on table public."app_settings" from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public."app_settings" to anon;
grant delete, insert, references, select, trigger, truncate, update on table public."app_settings" to authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public."app_settings" to service_role;
create policy "app_settings authenticated all" on public."app_settings" for all to authenticated using (true) with check (true);

alter table public."backup_history" enable row level security;
revoke all on table public."backup_history" from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public."backup_history" to anon;
grant delete, insert, references, select, trigger, truncate, update on table public."backup_history" to authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public."backup_history" to service_role;
create policy "Enable read access for all users" on public."backup_history" for select to authenticated using (true);

alter table public."backup_schedules" enable row level security;
revoke all on table public."backup_schedules" from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public."backup_schedules" to anon;
grant delete, insert, references, select, trigger, truncate, update on table public."backup_schedules" to authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public."backup_schedules" to service_role;
create policy "Enable read access for authenticated users" on public."backup_schedules" for select to authenticated using (true);
create policy "backup_schedules authenticated write" on public."backup_schedules" for all to authenticated using (true) with check (true);

alter table public."cloudflare_waf_runs" enable row level security;
revoke all on table public."cloudflare_waf_runs" from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public."cloudflare_waf_runs" to anon;
grant delete, insert, references, select, trigger, truncate, update on table public."cloudflare_waf_runs" to authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public."cloudflare_waf_runs" to service_role;
create policy "cloudflare_waf_runs authenticated read" on public."cloudflare_waf_runs" for select to authenticated using (true);

alter table public."cloudflare_zones" enable row level security;
revoke all on table public."cloudflare_zones" from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public."cloudflare_zones" to anon;
grant delete, insert, references, select, trigger, truncate, update on table public."cloudflare_zones" to authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public."cloudflare_zones" to service_role;
create policy "cloudflare_zones authenticated read" on public."cloudflare_zones" for select to authenticated using (true);

alter table public."fail2ban_events" enable row level security;
revoke all on table public."fail2ban_events" from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public."fail2ban_events" to authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public."fail2ban_events" to service_role;
create policy "fail2ban_events authenticated read" on public."fail2ban_events" for select to authenticated using (true);

alter table public."ip_allowlist" enable row level security;
revoke all on table public."ip_allowlist" from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public."ip_allowlist" to anon;
grant delete, insert, references, select, trigger, truncate, update on table public."ip_allowlist" to authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public."ip_allowlist" to service_role;
create policy "ip_allowlist authenticated all" on public."ip_allowlist" for all to authenticated using (true) with check (true);

alter table public."ip_blocks" enable row level security;
revoke all on table public."ip_blocks" from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public."ip_blocks" to anon;
grant delete, insert, references, select, trigger, truncate, update on table public."ip_blocks" to authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public."ip_blocks" to service_role;
create policy "ip_blocks authenticated all" on public."ip_blocks" for all to authenticated using (true) with check (true);

alter table public."php_opcache_state" enable row level security;
revoke all on table public."php_opcache_state" from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public."php_opcache_state" to authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public."php_opcache_state" to service_role;
create policy "php_opcache_state authenticated read" on public."php_opcache_state" for select to authenticated using (true);

alter table public."server_agent_secrets" enable row level security;
revoke all on table public."server_agent_secrets" from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public."server_agent_secrets" to service_role;

alter table public."server_fail2ban_state" enable row level security;
revoke all on table public."server_fail2ban_state" from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public."server_fail2ban_state" to authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public."server_fail2ban_state" to service_role;
create policy "server_fail2ban_state authenticated read" on public."server_fail2ban_state" for select to authenticated using (true);

alter table public."server_firewall_state" enable row level security;
revoke all on table public."server_firewall_state" from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public."server_firewall_state" to anon;
grant delete, insert, references, select, trigger, truncate, update on table public."server_firewall_state" to authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public."server_firewall_state" to service_role;
create policy "firewall_state authenticated read" on public."server_firewall_state" for select to authenticated using (true);

alter table public."server_hardware" enable row level security;
revoke all on table public."server_hardware" from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public."server_hardware" to anon;
grant delete, insert, references, select, trigger, truncate, update on table public."server_hardware" to authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public."server_hardware" to service_role;
create policy "read server hardware" on public."server_hardware" for select to authenticated using (true);

alter table public."server_opcache_state" enable row level security;
revoke all on table public."server_opcache_state" from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public."server_opcache_state" to authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public."server_opcache_state" to service_role;
create policy "server_opcache_state authenticated read" on public."server_opcache_state" for select to authenticated using (true);

alter table public."server_telemetry" enable row level security;
revoke all on table public."server_telemetry" from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public."server_telemetry" to anon;
grant delete, insert, references, select, trigger, truncate, update on table public."server_telemetry" to authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public."server_telemetry" to service_role;
create policy "Enable read access for all telemetry data" on public."server_telemetry" for select to authenticated using (true);

alter table public."server_waf_state" enable row level security;
revoke all on table public."server_waf_state" from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public."server_waf_state" to authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public."server_waf_state" to service_role;
create policy "server_waf_state authenticated read" on public."server_waf_state" for select to authenticated using (true);

alter table public."servers" enable row level security;
revoke all on table public."servers" from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public."servers" to anon;
grant delete, insert, references, select, trigger, truncate, update on table public."servers" to authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public."servers" to service_role;
create policy "Enable read access for all users" on public."servers" for select to authenticated using (true);

alter table public."site_fail2ban_state" enable row level security;
revoke all on table public."site_fail2ban_state" from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public."site_fail2ban_state" to authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public."site_fail2ban_state" to service_role;
create policy "site_fail2ban_state authenticated read" on public."site_fail2ban_state" for select to authenticated using (true);

alter table public."site_staging_state" enable row level security;
revoke all on table public."site_staging_state" from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public."site_staging_state" to anon;
grant delete, insert, references, select, trigger, truncate, update on table public."site_staging_state" to authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public."site_staging_state" to service_role;
create policy "site_staging_state authenticated all" on public."site_staging_state" for all to authenticated using (true) with check (true);

alter table public."site_waf_state" enable row level security;
revoke all on table public."site_waf_state" from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public."site_waf_state" to authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public."site_waf_state" to service_role;
create policy "site_waf_state authenticated read" on public."site_waf_state" for select to authenticated using (true);

alter table public."sites" enable row level security;
revoke all on table public."sites" from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public."sites" to anon;
grant delete, insert, references, select, trigger, truncate, update on table public."sites" to authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public."sites" to service_role;
create policy "Enable read access for all users" on public."sites" for select to authenticated using (true);

alter table public."system_logs" enable row level security;
revoke all on table public."system_logs" from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public."system_logs" to anon;
grant delete, insert, references, select, trigger, truncate, update on table public."system_logs" to authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public."system_logs" to service_role;
create policy "system_logs authenticated all" on public."system_logs" for all to authenticated using (true) with check (true);


-- ── tables the app watches live ─────────────────────────────────────────────
do $do$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'server_fail2ban_state') then
    alter publication "supabase_realtime" add table public."server_fail2ban_state";
  end if;
end $do$;
do $do$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'server_opcache_state') then
    alter publication "supabase_realtime" add table public."server_opcache_state";
  end if;
end $do$;
do $do$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'server_telemetry') then
    alter publication "supabase_realtime" add table public."server_telemetry";
  end if;
end $do$;
do $do$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'server_waf_state') then
    alter publication "supabase_realtime" add table public."server_waf_state";
  end if;
end $do$;

-- ── clean-up jobs ───────────────────────────────────────────────────────────
do $do$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('prune-system-logs', '30 0 * * *', $job$ DELETE FROM public.system_logs WHERE created_at < NOW() - INTERVAL '30 days' $job$);
    perform cron.schedule('prune-telemetry', '15 0 * * *', $job$ DELETE FROM public.server_telemetry WHERE timestamp < NOW() - INTERVAL '7 days' $job$);
  end if;
end $do$;
