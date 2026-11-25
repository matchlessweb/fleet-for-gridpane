// GENERATED FILE. Do not edit by hand.
// Written by scripts/schema-to-types.mjs from supabase/schema.snapshot.json.
// Regenerate with:  npm run schema:types      Check it is current with:  npm run schema:types -- --check
// Same shape as `supabase gen types typescript`, so createClient<Database> works the same.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      app_settings: {
        Row: {
          cpu_critical: number
          cpu_warn: number
          disk_critical: number
          disk_warn: number
          id: number
          memory_critical: number
          memory_warn: number
          updated_at: string
        }
        Insert: {
          cpu_critical?: number
          cpu_warn?: number
          disk_critical?: number
          disk_warn?: number
          id?: number
          memory_critical?: number
          memory_warn?: number
          updated_at?: string
        }
        Update: {
          cpu_critical?: number
          cpu_warn?: number
          disk_critical?: number
          disk_warn?: number
          id?: number
          memory_critical?: number
          memory_warn?: number
          updated_at?: string
        }
        Relationships: []
      }
      backup_history: {
        Row: {
          completed_at: string | null
          id: string
          job_id: string | null
          schedule_id: number | null
          server_id: number | null
          site_id: number | null
          size_bytes: number | null
          started_at: string | null
          status: string
          storage_path: string | null
        }
        Insert: {
          completed_at?: string | null
          id?: string
          job_id?: string | null
          schedule_id?: number | null
          server_id?: number | null
          site_id?: number | null
          size_bytes?: number | null
          started_at?: string | null
          status: string
          storage_path?: string | null
        }
        Update: {
          completed_at?: string | null
          id?: string
          job_id?: string | null
          schedule_id?: number | null
          server_id?: number | null
          site_id?: number | null
          size_bytes?: number | null
          started_at?: string | null
          status?: string
          storage_path?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "backup_history_schedule_id_fkey"
            columns: ["schedule_id"]
            isOneToOne: false
            referencedRelation: "backup_schedules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "backup_history_server_id_fkey"
            columns: ["server_id"]
            isOneToOne: false
            referencedRelation: "servers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "backup_history_site_id_fkey"
            columns: ["site_id"]
            isOneToOne: false
            referencedRelation: "sites"
            referencedColumns: ["id"]
          },
        ]
      }
      backup_schedules: {
        Row: {
          bup_schedule: string | null
          created_at: string | null
          day: string | null
          hour: string | null
          id: number
          minute: string | null
          service_id: number | null
          site_id: number | null
          type: string | null
          updated_at: string | null
        }
        Insert: {
          bup_schedule?: string | null
          created_at?: string | null
          day?: string | null
          hour?: string | null
          id: number
          minute?: string | null
          service_id?: number | null
          site_id?: number | null
          type?: string | null
          updated_at?: string | null
        }
        Update: {
          bup_schedule?: string | null
          created_at?: string | null
          day?: string | null
          hour?: string | null
          id?: number
          minute?: string | null
          service_id?: number | null
          site_id?: number | null
          type?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "backup_schedules_site_id_fkey"
            columns: ["site_id"]
            isOneToOne: false
            referencedRelation: "sites"
            referencedColumns: ["id"]
          },
        ]
      }
      cloudflare_waf_runs: {
        Row: {
          generated_at: string
          id: number
          ingested_at: string
          masked_count: number
          report_sha256: string
          rule_count: number
          run_dir: string
          zone_count: number
        }
        Insert: {
          generated_at: string
          id?: number
          ingested_at?: string
          masked_count: number
          report_sha256: string
          rule_count: number
          run_dir: string
          zone_count: number
        }
        Update: {
          generated_at?: string
          id?: number
          ingested_at?: string
          masked_count?: number
          report_sha256?: string
          rule_count?: number
          run_dir?: string
          zone_count?: number
        }
        Relationships: []
      }
      cloudflare_zones: {
        Row: {
          account: string | null
          comparable: boolean | null
          core_fp: string | null
          findings: Json
          klass: string
          name: string
          nearest: string | null
          nrules: number
          order_matches: boolean | null
          paused: boolean
          plan: string | null
          profile: string | null
          ratelimit_rules: number
          reach: Json
          rule_order: Json
          rules: Json
          ruleset_updated: string | null
          ruleset_version: string | null
          run_id: number
          zone_id: string
        }
        Insert: {
          account?: string | null
          comparable?: boolean | null
          core_fp?: string | null
          findings?: Json
          klass: string
          name: string
          nearest?: string | null
          nrules?: number
          order_matches?: boolean | null
          paused?: boolean
          plan?: string | null
          profile?: string | null
          ratelimit_rules?: number
          reach?: Json
          rule_order?: Json
          rules?: Json
          ruleset_updated?: string | null
          ruleset_version?: string | null
          run_id: number
          zone_id: string
        }
        Update: {
          account?: string | null
          comparable?: boolean | null
          core_fp?: string | null
          findings?: Json
          klass?: string
          name?: string
          nearest?: string | null
          nrules?: number
          order_matches?: boolean | null
          paused?: boolean
          plan?: string | null
          profile?: string | null
          ratelimit_rules?: number
          reach?: Json
          rule_order?: Json
          rules?: Json
          ruleset_updated?: string | null
          ruleset_version?: string | null
          run_id?: number
          zone_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "cloudflare_zones_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "cloudflare_waf_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      fail2ban_events: {
        Row: {
          at: string
          event: string
          id: number
          ip: string
          jail: string
          server_id: number
          site: string | null
        }
        Insert: {
          at?: string
          event: string
          id?: number
          ip: string
          jail: string
          server_id: number
          site?: string | null
        }
        Update: {
          at?: string
          event?: string
          id?: number
          ip?: string
          jail?: string
          server_id?: number
          site?: string | null
        }
        Relationships: []
      }
      ip_allowlist: {
        Row: {
          created_at: string
          id: number
          ip: string
          label: string
          layers: string[]
          note: string | null
          removed_at: string | null
          scope: string
          server_id: number | null
          site_id: number | null
        }
        Insert: {
          created_at?: string
          id?: number
          ip: string
          label: string
          layers?: string[]
          note?: string | null
          removed_at?: string | null
          scope?: string
          server_id?: number | null
          site_id?: number | null
        }
        Update: {
          created_at?: string
          id?: number
          ip?: string
          label?: string
          layers?: string[]
          note?: string | null
          removed_at?: string | null
          scope?: string
          server_id?: number | null
          site_id?: number | null
        }
        Relationships: []
      }
      ip_blocks: {
        Row: {
          applied_at: string | null
          created_at: string
          id: number
          ip: string
          layer: string
          reason: string | null
          removed_at: string | null
          scope: string
          server_id: number | null
          site_id: number | null
        }
        Insert: {
          applied_at?: string | null
          created_at?: string
          id?: number
          ip: string
          layer: string
          reason?: string | null
          removed_at?: string | null
          scope: string
          server_id?: number | null
          site_id?: number | null
        }
        Update: {
          applied_at?: string | null
          created_at?: string
          id?: number
          ip?: string
          layer?: string
          reason?: string | null
          removed_at?: string | null
          scope?: string
          server_id?: number | null
          site_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "ip_blocks_server_id_fkey"
            columns: ["server_id"]
            isOneToOne: false
            referencedRelation: "servers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ip_blocks_site_id_fkey"
            columns: ["site_id"]
            isOneToOne: false
            referencedRelation: "sites"
            referencedColumns: ["id"]
          },
        ]
      }
      php_opcache_state: {
        Row: {
          ini: Json | null
          live: Json | null
          live_error: string | null
          php_version: string
          pools: number
          prev: Json | null
          reported_at: string
          server_id: number
          sites: Json
        }
        Insert: {
          ini?: Json | null
          live?: Json | null
          live_error?: string | null
          php_version: string
          pools?: number
          prev?: Json | null
          reported_at?: string
          server_id: number
          sites?: Json
        }
        Update: {
          ini?: Json | null
          live?: Json | null
          live_error?: string | null
          php_version?: string
          pools?: number
          prev?: Json | null
          reported_at?: string
          server_id?: number
          sites?: Json
        }
        Relationships: []
      }
      server_agent_secrets: {
        Row: {
          created_at: string
          last_used_at: string | null
          rotated_at: string | null
          server_id: number
          token_hash: string
        }
        Insert: {
          created_at?: string
          last_used_at?: string | null
          rotated_at?: string | null
          server_id: number
          token_hash: string
        }
        Update: {
          created_at?: string
          last_used_at?: string | null
          rotated_at?: string | null
          server_id?: number
          token_hash?: string
        }
        Relationships: []
      }
      server_fail2ban_state: {
        Row: {
          agent_format: number
          auth_log_readable: boolean
          fail2ban_present: boolean
          fail2ban_running: boolean
          fail2ban_version: string | null
          gpcloudflare_conf: boolean
          orphan_jails: Json
          reported_at: string
          server_id: number
          server_jails: Json
          token_file_present: boolean
        }
        Insert: {
          agent_format?: number
          auth_log_readable: boolean
          fail2ban_present: boolean
          fail2ban_running: boolean
          fail2ban_version?: string | null
          gpcloudflare_conf: boolean
          orphan_jails?: Json
          reported_at?: string
          server_id: number
          server_jails?: Json
          token_file_present: boolean
        }
        Update: {
          agent_format?: number
          auth_log_readable?: boolean
          fail2ban_present?: boolean
          fail2ban_running?: boolean
          fail2ban_version?: string | null
          gpcloudflare_conf?: boolean
          orphan_jails?: Json
          reported_at?: string
          server_id?: number
          server_jails?: Json
          token_file_present?: boolean
        }
        Relationships: []
      }
      server_firewall_state: {
        Row: {
          fail2ban_banned: Json | null
          fail2ban_ignoreip: string[] | null
          fail2ban_present: boolean | null
          nginx_denies: Json
          reported_at: string
          server_id: number
          ufw_allowed_ips: string[] | null
          ufw_denied_ips: string[]
          ufw_enabled: boolean | null
          ufw_web_sources: string[] | null
        }
        Insert: {
          fail2ban_banned?: Json | null
          fail2ban_ignoreip?: string[] | null
          fail2ban_present?: boolean | null
          nginx_denies?: Json
          reported_at?: string
          server_id: number
          ufw_allowed_ips?: string[] | null
          ufw_denied_ips?: string[]
          ufw_enabled?: boolean | null
          ufw_web_sources?: string[] | null
        }
        Update: {
          fail2ban_banned?: Json | null
          fail2ban_ignoreip?: string[] | null
          fail2ban_present?: boolean | null
          nginx_denies?: Json
          reported_at?: string
          server_id?: number
          ufw_allowed_ips?: string[] | null
          ufw_denied_ips?: string[]
          ufw_enabled?: boolean | null
          ufw_web_sources?: string[] | null
        }
        Relationships: [
          {
            foreignKeyName: "server_firewall_state_server_id_fkey"
            columns: ["server_id"]
            isOneToOne: true
            referencedRelation: "servers"
            referencedColumns: ["id"]
          },
        ]
      }
      server_hardware: {
        Row: {
          cpu_cores: number | null
          product: string | null
          ram_total_mb: number | null
          reported_at: string
          server_id: number
          vendor: string | null
        }
        Insert: {
          cpu_cores?: number | null
          product?: string | null
          ram_total_mb?: number | null
          reported_at?: string
          server_id: number
          vendor?: string | null
        }
        Update: {
          cpu_cores?: number | null
          product?: string | null
          ram_total_mb?: number | null
          reported_at?: string
          server_id?: number
          vendor?: string | null
        }
        Relationships: []
      }
      server_opcache_state: {
        Row: {
          agent_format: number
          reported_at: string
          server_id: number
        }
        Insert: {
          agent_format?: number
          reported_at?: string
          server_id: number
        }
        Update: {
          agent_format?: number
          reported_at?: string
          server_id?: number
        }
        Relationships: []
      }
      server_telemetry: {
        Row: {
          cpu_usage: number
          disk_backups_mb: number | null
          disk_mysql_mb: number | null
          disk_total_gb: number | null
          disk_usage: number
          disk_www_mb: number | null
          id: number
          ram_usage: number
          server_id: number
          timestamp: string
          top_processes_b64: string | null
        }
        Insert: {
          cpu_usage: number
          disk_backups_mb?: number | null
          disk_mysql_mb?: number | null
          disk_total_gb?: number | null
          disk_usage: number
          disk_www_mb?: number | null
          id?: number
          ram_usage: number
          server_id: number
          timestamp?: string
          top_processes_b64?: string | null
        }
        Update: {
          cpu_usage?: number
          disk_backups_mb?: number | null
          disk_mysql_mb?: number | null
          disk_total_gb?: number | null
          disk_usage?: number
          disk_www_mb?: number | null
          id?: number
          ram_usage?: number
          server_id?: number
          timestamp?: string
          top_processes_b64?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "server_telemetry_server_id_fkey"
            columns: ["server_id"]
            isOneToOne: false
            referencedRelation: "servers"
            referencedColumns: ["id"]
          },
        ]
      }
      server_waf_state: {
        Row: {
          agent_format: number
          reported_at: string
          server_id: number
        }
        Insert: {
          agent_format?: number
          reported_at?: string
          server_id: number
        }
        Update: {
          agent_format?: number
          reported_at?: string
          server_id?: number
        }
        Relationships: []
      }
      servers: {
        Row: {
          beta_server: number | null
          cpu: string | null
          database: string | null
          failover_id: number | null
          high_availability_sync_interval: number | null
          id: number
          ip: string
          is_health_check_running: boolean | null
          is_paired: boolean | null
          is_preemptive_support_on: number | null
          is_wsod: boolean | null
          label: string
          os_version: string | null
          provider: Json | null
          provider_id: number | null
          ram: string | null
          record_id: string | null
          region: string | null
          region_label: string | null
          server_key: string | null
          status: string | null
          sub_id: string | null
          subdomain: string | null
          update_backups: boolean | null
          us_enabled: boolean | null
          user_id: number | null
          uuid: string | null
          webserver: string | null
        }
        Insert: {
          beta_server?: number | null
          cpu?: string | null
          database?: string | null
          failover_id?: number | null
          high_availability_sync_interval?: number | null
          id: number
          ip: string
          is_health_check_running?: boolean | null
          is_paired?: boolean | null
          is_preemptive_support_on?: number | null
          is_wsod?: boolean | null
          label: string
          os_version?: string | null
          provider?: Json | null
          provider_id?: number | null
          ram?: string | null
          record_id?: string | null
          region?: string | null
          region_label?: string | null
          server_key?: string | null
          status?: string | null
          sub_id?: string | null
          subdomain?: string | null
          update_backups?: boolean | null
          us_enabled?: boolean | null
          user_id?: number | null
          uuid?: string | null
          webserver?: string | null
        }
        Update: {
          beta_server?: number | null
          cpu?: string | null
          database?: string | null
          failover_id?: number | null
          high_availability_sync_interval?: number | null
          id?: number
          ip?: string
          is_health_check_running?: boolean | null
          is_paired?: boolean | null
          is_preemptive_support_on?: number | null
          is_wsod?: boolean | null
          label?: string
          os_version?: string | null
          provider?: Json | null
          provider_id?: number | null
          ram?: string | null
          record_id?: string | null
          region?: string | null
          region_label?: string | null
          server_key?: string | null
          status?: string | null
          sub_id?: string | null
          subdomain?: string | null
          update_backups?: boolean | null
          us_enabled?: boolean | null
          user_id?: number | null
          uuid?: string | null
          webserver?: string | null
        }
        Relationships: []
      }
      site_fail2ban_state: {
        Row: {
          bans: Json
          configs: boolean | null
          included: boolean | null
          jails: Json
          log_24h: number
          log_lines: Json
          mu_plugin: string | null
          plugin: string
          plugin_dir: boolean | null
          reported_at: string
          server_id: number
          site: string
        }
        Insert: {
          bans?: Json
          configs?: boolean | null
          included?: boolean | null
          jails?: Json
          log_24h?: number
          log_lines?: Json
          mu_plugin?: string | null
          plugin: string
          plugin_dir?: boolean | null
          reported_at?: string
          server_id: number
          site: string
        }
        Update: {
          bans?: Json
          configs?: boolean | null
          included?: boolean | null
          jails?: Json
          log_24h?: number
          log_lines?: Json
          mu_plugin?: string | null
          plugin?: string
          plugin_dir?: boolean | null
          reported_at?: string
          server_id?: number
          site?: string
        }
        Relationships: []
      }
      site_staging_state: {
        Row: {
          is_active: boolean
          note: string | null
          noted_at: string
          site_id: number
        }
        Insert: {
          is_active?: boolean
          note?: string | null
          noted_at?: string
          site_id: number
        }
        Update: {
          is_active?: boolean
          note?: string | null
          noted_at?: string
          site_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "site_staging_state_site_id_fkey"
            columns: ["site_id"]
            isOneToOne: true
            referencedRelation: "sites"
            referencedColumns: ["id"]
          },
        ]
      }
      site_waf_state: {
        Row: {
          g7_day: Json | null
          g8_day: Json | null
          g8_loaded: boolean
          g8_log_at: string | null
          g8_log_bytes: number | null
          g8_mode: string
          g8_version: string | null
          reported_at: string
          rulesets: Json
          server_id: number
          site: string
          waf: string | null
        }
        Insert: {
          g7_day?: Json | null
          g8_day?: Json | null
          g8_loaded?: boolean
          g8_log_at?: string | null
          g8_log_bytes?: number | null
          g8_mode?: string
          g8_version?: string | null
          reported_at?: string
          rulesets?: Json
          server_id: number
          site: string
          waf?: string | null
        }
        Update: {
          g7_day?: Json | null
          g8_day?: Json | null
          g8_loaded?: boolean
          g8_log_at?: string | null
          g8_log_bytes?: number | null
          g8_mode?: string
          g8_version?: string | null
          reported_at?: string
          rulesets?: Json
          server_id?: number
          site?: string
          waf?: string | null
        }
        Relationships: []
      }
      sites: {
        Row: {
          automatic_updates: boolean | null
          built_at: string | null
          cloudflare_dns_name: string | null
          id: number
          is_php_slowlog: boolean | null
          is_ssl: boolean | null
          is_sso: boolean | null
          is_wsod: boolean | null
          local_bup: boolean | null
          max_execution_time: number | null
          max_file_uploads: number | null
          max_input_time: number | null
          max_input_vars: number | null
          memory_limit: number | null
          nginx_caching: string | null
          php_slowlog_timeout: number | null
          php_slowlog_trace_depth: number | null
          php_version: string | null
          pm: string | null
          pm_max_children: number | null
          pm_max_requests: number | null
          pm_process_idle_timeout: number | null
          pm_start_servers: number | null
          post_max_size: number | null
          remote_bup: boolean | null
          resolved_at: string | null
          server_id: number | null
          site_customizer: Json | null
          site_nickname: string | null
          site_security_settings: Json | null
          ssl_status: string | null
          staging_site_built_at: string | null
          system_user_id: number | null
          upload_max_filesize: number | null
          url: string
          user_id: number | null
          waf: string | null
        }
        Insert: {
          automatic_updates?: boolean | null
          built_at?: string | null
          cloudflare_dns_name?: string | null
          id: number
          is_php_slowlog?: boolean | null
          is_ssl?: boolean | null
          is_sso?: boolean | null
          is_wsod?: boolean | null
          local_bup?: boolean | null
          max_execution_time?: number | null
          max_file_uploads?: number | null
          max_input_time?: number | null
          max_input_vars?: number | null
          memory_limit?: number | null
          nginx_caching?: string | null
          php_slowlog_timeout?: number | null
          php_slowlog_trace_depth?: number | null
          php_version?: string | null
          pm?: string | null
          pm_max_children?: number | null
          pm_max_requests?: number | null
          pm_process_idle_timeout?: number | null
          pm_start_servers?: number | null
          post_max_size?: number | null
          remote_bup?: boolean | null
          resolved_at?: string | null
          server_id?: number | null
          site_customizer?: Json | null
          site_nickname?: string | null
          site_security_settings?: Json | null
          ssl_status?: string | null
          staging_site_built_at?: string | null
          system_user_id?: number | null
          upload_max_filesize?: number | null
          url: string
          user_id?: number | null
          waf?: string | null
        }
        Update: {
          automatic_updates?: boolean | null
          built_at?: string | null
          cloudflare_dns_name?: string | null
          id?: number
          is_php_slowlog?: boolean | null
          is_ssl?: boolean | null
          is_sso?: boolean | null
          is_wsod?: boolean | null
          local_bup?: boolean | null
          max_execution_time?: number | null
          max_file_uploads?: number | null
          max_input_time?: number | null
          max_input_vars?: number | null
          memory_limit?: number | null
          nginx_caching?: string | null
          php_slowlog_timeout?: number | null
          php_slowlog_trace_depth?: number | null
          php_version?: string | null
          pm?: string | null
          pm_max_children?: number | null
          pm_max_requests?: number | null
          pm_process_idle_timeout?: number | null
          pm_start_servers?: number | null
          post_max_size?: number | null
          remote_bup?: boolean | null
          resolved_at?: string | null
          server_id?: number | null
          site_customizer?: Json | null
          site_nickname?: string | null
          site_security_settings?: Json | null
          ssl_status?: string | null
          staging_site_built_at?: string | null
          system_user_id?: number | null
          upload_max_filesize?: number | null
          url?: string
          user_id?: number | null
          waf?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sites_server_id_fkey"
            columns: ["server_id"]
            isOneToOne: false
            referencedRelation: "servers"
            referencedColumns: ["id"]
          },
        ]
      }
      system_logs: {
        Row: {
          created_at: string
          id: string
          is_read: boolean
          level: string
          message: string
          site_url: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          is_read?: boolean
          level: string
          message: string
          site_url?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          is_read?: boolean
          level?: string
          message?: string
          site_url?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      ingest_cloudflare_waf: {
        Args: {
          p_allow_older?: boolean
          p_generated_at: string
          p_report_sha256: string
          p_run_dir: string
          p_zones: Json
        }
        Returns: Json
      }
      report_fail2ban: {
        Args: { p_report: Json; p_server_id: number; p_token: string }
        Returns: undefined
      }
      report_firewall_state: {
        Args: {
          p_fail2ban_banned?: Json
          p_fail2ban_ignoreip?: string[]
          p_fail2ban_present?: boolean
          p_nginx_denies: Json
          p_server_id: number
          p_token?: string
          p_ufw_allowed_ips?: string[]
          p_ufw_denied_ips: string[]
          p_ufw_enabled: boolean
          p_ufw_web_sources?: string[]
        }
        Returns: undefined
      }
      report_hardware: {
        Args: {
          p_cpu_cores: number
          p_product: string
          p_ram_total_mb: number
          p_server_id: number
          p_token?: string
          p_vendor: string
        }
        Returns: undefined
      }
      report_opcache: {
        Args: { p_report: Json; p_server_id: number; p_token: string }
        Returns: undefined
      }
      report_telemetry: {
        Args: {
          p_cpu_usage: number
          p_disk_backups_mb?: number
          p_disk_mysql_mb?: number
          p_disk_total_gb?: number
          p_disk_usage: number
          p_disk_www_mb?: number
          p_ram_usage: number
          p_server_id: number
          p_timestamp?: string
          p_token?: string
          p_top_processes_b64?: string
        }
        Returns: undefined
      }
      report_waf: {
        Args: { p_report: Json; p_server_id: number; p_token: string }
        Returns: undefined
      }
      verify_agent: {
        Args: { p_server_id: number; p_token: string }
        Returns: boolean
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
