-- ==============================================================================
-- One-click WordPress sign-in (single sign-on) — tables and functions
-- ==============================================================================
-- Apply it with scripts/apply-sql.sh (SETUP.md, step 11c). Safe to run again.
--
-- HOW IT FITS TOGETHER
--   1. A signed-in person clicks W in the dashboard. The dashboard's server code
--      checks who they are (lib/sso/gate.ts), signs a short request and calls
--      sso_request_create().
--   2. A small service on the site's server asks sso_agent_poll() for work,
--      checks the signature itself, runs GridPane's own login command, and hands
--      back the link SEALED (encrypted so that only the dashboard can read it)
--      with sso_agent_complete().
--   3. The dashboard takes the sealed link exactly once with sso_request_take().
--
-- WHAT THE DATABASE NEVER HOLDS
--   A usable login link, the dashboard's signing key, or the key that opens a
--   sealed link. Someone who reads or even writes every row here cannot mint a
--   sign-in: the server only obeys requests carrying the dashboard's signature.
--
-- WHO CAN TOUCH WHAT
--   Browsers (anon, authenticated): nothing. Row level security is on with no
--   policies, and every privilege is revoked.
--   Server services (anon key + their own per-server token): only
--   sso_agent_poll() and sso_agent_complete(), which check the token first.
--   The dashboard's server code (service role): everything else.
--
-- OFF SWITCH
--   update public.sso_state set enabled = false;   -- every W button is a plain link again
-- ==============================================================================

-- ---- the master switch -------------------------------------------------------
create table if not exists public.sso_state (
    id          integer     primary key default 1 check (id = 1),
    enabled     boolean     not null default false,
    -- Server services poll quickly only while someone is using the dashboard.
    armed_until timestamptz,
    updated_at  timestamptz not null default now(),
    updated_by  uuid
);
insert into public.sso_state (id, enabled) values (1, false) on conflict (id) do nothing;
comment on table public.sso_state is 'One row. enabled=false turns one-click sign-in off everywhere.';

-- ---- which sites have opted in (default: none) ---------------------------------
-- Keyed on server + hostname, not the site id: a site can exist on two servers
-- during a move, and staging copies have no id of their own.
create table if not exists public.sso_site_policy (
    server_id  bigint      not null,
    hostname   text        not null check (hostname ~ '^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$'),
    enabled    boolean     not null default false,
    updated_at timestamptz not null default now(),
    updated_by uuid,
    primary key (server_id, hostname)
);
comment on table public.sso_site_policy is 'A site allows one-click sign-in only if it has a row here with enabled=true.';

-- ---- per-server tokens for the sign-in service --------------------------------
-- Separate from server_agent_secrets on purpose: the telemetry agent's token
-- must not be enough to collect sign-in requests.
create table if not exists public.sso_agent_secrets (
    server_id    bigint      primary key,
    token_hash   text        not null,
    created_at   timestamptz not null default now(),
    last_used_at timestamptz,
    rotated_at   timestamptz
);
comment on table public.sso_agent_secrets is 'SHA-256 hashes of the per-server sign-in service tokens. Never readable by anon or authenticated.';

-- ---- requests ----------------------------------------------------------------
create table if not exists public.sso_requests (
    id             uuid        primary key,
    server_id      bigint      not null,
    hostname       text        not null check (hostname ~ '^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$'),
    requested_by   uuid        not null,
    -- The dashboard's signed request, exactly as the server service must verify it.
    signed_request text        not null check (length(signed_request) between 40 and 4096),
    status         text        not null default 'pending'
                   check (status in ('pending', 'claimed', 'ready', 'failed', 'consumed', 'expired')),
    -- The link, encrypted to the dashboard's key. Cleared the moment it is taken.
    sealed_link    text        check (sealed_link is null or (length(sealed_link) <= 2048 and sealed_link ~ '^[A-Za-z0-9+/=_-]+$')),
    error          text        check (error is null or length(error) <= 200),
    created_at     timestamptz not null default now(),
    expires_at     timestamptz not null,
    claimed_at     timestamptz,
    completed_at   timestamptz,
    consumed_at    timestamptz
);
create index if not exists sso_requests_pending_idx on public.sso_requests (server_id, created_at) where status = 'pending';
create index if not exists sso_requests_by_user_idx on public.sso_requests (requested_by, created_at desc);

-- ---- the record of who signed in where ----------------------------------------
-- Never holds a link, sealed or not. Kept for a year.
create table if not exists public.sso_audit (
    id           bigint generated always as identity primary key,
    at           timestamptz not null default now(),
    event        text        not null check (event in ('requested', 'refused', 'minted', 'failed', 'opened', 'expired', 'policy', 'switch')),
    request_id   uuid,
    user_id      uuid,
    user_email   text,
    access_email text,
    ip           text,
    server_id    bigint,
    hostname     text,
    detail       text check (detail is null or length(detail) <= 300)
);
create index if not exists sso_audit_at_idx on public.sso_audit (at desc);
create index if not exists sso_audit_site_idx on public.sso_audit (server_id, hostname, at desc);

-- ---- nobody but the dashboard's server code reads or writes these --------------
alter table public.sso_state         enable row level security;
alter table public.sso_site_policy   enable row level security;
alter table public.sso_agent_secrets enable row level security;
alter table public.sso_requests      enable row level security;
alter table public.sso_audit         enable row level security;
revoke all on public.sso_state, public.sso_site_policy, public.sso_agent_secrets, public.sso_requests, public.sso_audit
    from public, anon, authenticated;

-- ==============================================================================
-- Functions
-- ==============================================================================

-- Is this the sign-in service of that server? Never callable from outside.
create or replace function public.sso_verify_agent(p_server_id bigint, p_token text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    v_ok boolean;
begin
    if p_token is null or length(p_token) < 32 then
        return false;
    end if;
    update public.sso_agent_secrets
       set last_used_at = now()
     where server_id  = p_server_id
       and token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    returning true into v_ok;
    return coalesce(v_ok, false);
end;
$$;
revoke all on function public.sso_verify_agent(bigint, text) from public, anon, authenticated;

-- The dashboard asks for a sign-in. Returns {ok:true,...} or {ok:false, reason}.
-- Limits per person: 10 in five minutes, 60 in a day.
create or replace function public.sso_request_create(
    p_id             uuid,
    p_user           uuid,
    p_server_id      bigint,
    p_hostname       text,
    p_signed_request text,
    p_user_email     text    default null,
    p_access_email   text    default null,
    p_ip             text    default null,
    p_ttl_seconds    integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    v_reason  text;
    v_expires timestamptz;
begin
    -- Housekeeping rides along with real use: no scheduled job to forget.
    delete from public.sso_requests where created_at < now() - interval '2 days';
    delete from public.sso_audit    where at         < now() - interval '1 year';

    if p_id is null or p_user is null or p_server_id is null or p_hostname is null or p_signed_request is null then
        v_reason := 'bad-request';
    elsif p_ttl_seconds is null or p_ttl_seconds < 15 or p_ttl_seconds > 120 then
        v_reason := 'bad-request';
    elsif not coalesce((select enabled from public.sso_state where id = 1), false) then
        v_reason := 'switched-off';
    elsif not coalesce((select enabled from public.sso_site_policy
                         where server_id = p_server_id and hostname = p_hostname), false) then
        v_reason := 'site-not-enabled';
    elsif (select count(*) from public.sso_requests
            where requested_by = p_user and created_at > now() - interval '5 minutes') >= 10 then
        v_reason := 'too-many-5m';
    elsif (select count(*) from public.sso_requests
            where requested_by = p_user and created_at > now() - interval '1 day') >= 60 then
        v_reason := 'too-many-day';
    end if;

    if v_reason is not null then
        insert into public.sso_audit (event, request_id, user_id, user_email, access_email, ip, server_id, hostname, detail)
        values ('refused', p_id, p_user, p_user_email, p_access_email, p_ip, p_server_id, left(p_hostname, 253), v_reason);
        return jsonb_build_object('ok', false, 'reason', v_reason);
    end if;

    v_expires := now() + make_interval(secs => p_ttl_seconds);
    insert into public.sso_requests (id, server_id, hostname, requested_by, signed_request, expires_at)
    values (p_id, p_server_id, p_hostname, p_user, p_signed_request, v_expires);
    insert into public.sso_audit (event, request_id, user_id, user_email, access_email, ip, server_id, hostname)
    values ('requested', p_id, p_user, p_user_email, p_access_email, p_ip, p_server_id, p_hostname);
    return jsonb_build_object('ok', true, 'id', p_id, 'expires_at', v_expires);
end;
$$;
revoke all on function public.sso_request_create(uuid, uuid, bigint, text, text, text, text, text, integer) from public, anon, authenticated;

-- A server's sign-in service collects its waiting requests. Each is handed out once.
create or replace function public.sso_agent_poll(p_server_id bigint, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    v_enabled boolean;
    v_armed   boolean;
    v_reqs    jsonb;
begin
    if not public.sso_verify_agent(p_server_id, p_token) then
        raise exception 'sign-in service token rejected for server %', p_server_id using errcode = '42501';
    end if;
    select enabled, coalesce(armed_until > now(), false) into v_enabled, v_armed from public.sso_state where id = 1;
    if not coalesce(v_enabled, false) then
        return jsonb_build_object('enabled', false, 'armed', false, 'requests', '[]'::jsonb);
    end if;
    with picked as (
        select id from public.sso_requests
         where server_id = p_server_id and status = 'pending' and expires_at > now()
         order by created_at
         limit 5
         for update skip locked
    ), claimed as (
        update public.sso_requests r
           set status = 'claimed', claimed_at = now()
          from picked
         where r.id = picked.id
        returning r.id, r.signed_request, r.created_at
    )
    select coalesce(jsonb_agg(jsonb_build_object('id', id, 'signed_request', signed_request) order by created_at), '[]'::jsonb)
      into v_reqs from claimed;
    return jsonb_build_object('enabled', true, 'armed', coalesce(v_armed, false), 'requests', v_reqs);
end;
$$;
revoke all on function public.sso_agent_poll(bigint, text) from public, anon, authenticated;
grant execute on function public.sso_agent_poll(bigint, text) to anon;

-- The service hands back a sealed link, or says why it could not make one.
create or replace function public.sso_agent_complete(
    p_server_id   bigint,
    p_token       text,
    p_request_id  uuid,
    p_sealed_link text default null,
    p_error       text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    v_row public.sso_requests%rowtype;
begin
    if not public.sso_verify_agent(p_server_id, p_token) then
        raise exception 'sign-in service token rejected for server %', p_server_id using errcode = '42501';
    end if;
    if (p_sealed_link is null) = (p_error is null) then
        raise exception 'give a sealed link or an error, not both and not neither' using errcode = '22023';
    end if;
    -- Only a request this server claimed, still in time, can be completed, and only once.
    update public.sso_requests
       set status       = case when p_error is null then 'ready' else 'failed' end,
           sealed_link  = p_sealed_link,
           error        = left(p_error, 200),
           completed_at = now()
     where id = p_request_id and server_id = p_server_id and status = 'claimed' and expires_at > now()
    returning * into v_row;
    if not found then
        return false;
    end if;
    insert into public.sso_audit (event, request_id, user_id, server_id, hostname, detail)
    values (case when p_error is null then 'minted' else 'failed' end, v_row.id, v_row.requested_by, v_row.server_id, v_row.hostname, left(p_error, 200));
    return true;
end;
$$;
revoke all on function public.sso_agent_complete(bigint, text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.sso_agent_complete(bigint, text, uuid, text, text) to anon;

-- The dashboard collects the result for the person who asked. A ready link is
-- handed over exactly once and erased in the same step.
create or replace function public.sso_request_take(p_request_id uuid, p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    v_row public.sso_requests%rowtype;
begin
    select * into v_row from public.sso_requests
     where id = p_request_id and requested_by = p_user
       for update;
    if not found then
        return jsonb_build_object('status', 'unknown');
    end if;

    if v_row.status in ('pending', 'claimed') and v_row.expires_at <= now() then
        update public.sso_requests set status = 'expired' where id = v_row.id;
        insert into public.sso_audit (event, request_id, user_id, server_id, hostname, detail)
        values ('expired', v_row.id, v_row.requested_by, v_row.server_id, v_row.hostname,
                case when v_row.status = 'pending' then 'the server never collected it' else 'the server collected it and did not answer' end);
        return jsonb_build_object('status', 'expired', 'collected', v_row.status = 'claimed');
    end if;

    if v_row.status = 'ready' then
        -- The server makes the link good for 60 seconds. Hand it over only while
        -- there is still time to use it.
        if v_row.completed_at < now() - interval '45 seconds' then
            update public.sso_requests set status = 'expired', sealed_link = null where id = v_row.id;
            insert into public.sso_audit (event, request_id, user_id, server_id, hostname, detail)
            values ('expired', v_row.id, v_row.requested_by, v_row.server_id, v_row.hostname, 'ready but not opened in time');
            return jsonb_build_object('status', 'expired', 'collected', true);
        end if;
        update public.sso_requests set status = 'consumed', sealed_link = null, consumed_at = now() where id = v_row.id;
        insert into public.sso_audit (event, request_id, user_id, server_id, hostname)
        values ('opened', v_row.id, v_row.requested_by, v_row.server_id, v_row.hostname);
        -- The hostname comes from the row, so the dashboard checks the opened link
        -- against the site that was asked for, not against anything a browser sent.
        return jsonb_build_object('status', 'ready', 'sealed_link', v_row.sealed_link, 'hostname', v_row.hostname);
    end if;

    return jsonb_build_object('status', v_row.status, 'error', v_row.error);
end;
$$;
revoke all on function public.sso_request_take(uuid, uuid) from public, anon, authenticated;

-- Someone is using the dashboard: have the server services poll quickly for ten minutes.
create or replace function public.sso_arm()
returns timestamptz
language sql
security definer
set search_path = public, extensions
as $$
    update public.sso_state set armed_until = now() + interval '10 minutes' where id = 1 and enabled
    returning armed_until;
$$;
revoke all on function public.sso_arm() from public, anon, authenticated;

-- What the dashboard needs to draw its buttons: the switch, and the sites that opted in.
create or replace function public.sso_state_read()
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $$
    select jsonb_build_object(
        'enabled', coalesce((select enabled from public.sso_state where id = 1), false),
        'sites', coalesce((select jsonb_agg(jsonb_build_object('server_id', server_id, 'hostname', hostname) order by hostname, server_id)
                             from public.sso_site_policy where enabled), '[]'::jsonb));
$$;
revoke all on function public.sso_state_read() from public, anon, authenticated;

-- Turn one-click sign-in on or off for one site on one server, and write it down.
-- Turning ON needs a site Fleet knows on that server (or its staging copy);
-- turning off always works.
create or replace function public.sso_policy_set(
    p_user         uuid,
    p_user_email   text,
    p_access_email text,
    p_ip           text,
    p_server_id    bigint,
    p_hostname     text,
    p_enabled      boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
    if p_user is null or p_server_id is null or p_hostname is null or p_enabled is null
       or p_hostname !~ '^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$' then
        return jsonb_build_object('ok', false, 'reason', 'bad-request');
    end if;
    if p_enabled and not exists (
        select 1 from public.sites s
         where s.server_id = p_server_id and (s.url = p_hostname or 'staging.' || s.url = p_hostname)) then
        return jsonb_build_object('ok', false, 'reason', 'unknown-site');
    end if;
    insert into public.sso_site_policy (server_id, hostname, enabled, updated_at, updated_by)
    values (p_server_id, p_hostname, p_enabled, now(), p_user)
    on conflict (server_id, hostname) do update set enabled = excluded.enabled, updated_at = now(), updated_by = excluded.updated_by;
    insert into public.sso_audit (event, user_id, user_email, access_email, ip, server_id, hostname, detail)
    values ('policy', p_user, p_user_email, p_access_email, p_ip, p_server_id, p_hostname, case when p_enabled then 'on' else 'off' end);
    return jsonb_build_object('ok', true, 'enabled', p_enabled);
end;
$$;
revoke all on function public.sso_policy_set(uuid, text, text, text, bigint, text, boolean) from public, anon, authenticated;

-- The master switch, and a line in the record each time it moves.
create or replace function public.sso_switch_set(p_user uuid, p_user_email text, p_access_email text, p_ip text, p_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
    if p_user is null or p_enabled is null then
        return jsonb_build_object('ok', false, 'reason', 'bad-request');
    end if;
    update public.sso_state
       set enabled = p_enabled, updated_at = now(), updated_by = p_user,
           armed_until = case when p_enabled then armed_until else null end
     where id = 1;
    insert into public.sso_audit (event, user_id, user_email, access_email, ip, detail)
    values ('switch', p_user, p_user_email, p_access_email, p_ip, case when p_enabled then 'on' else 'off' end);
    return jsonb_build_object('ok', true, 'enabled', p_enabled);
end;
$$;
revoke all on function public.sso_switch_set(uuid, text, text, text, boolean) from public, anon, authenticated;

-- The dashboard's server code is the only caller of these six.
grant execute on function public.sso_request_create(uuid, uuid, bigint, text, text, text, text, text, integer) to service_role;
grant execute on function public.sso_request_take(uuid, uuid) to service_role;
grant execute on function public.sso_arm() to service_role;
grant execute on function public.sso_state_read() to service_role;
grant execute on function public.sso_policy_set(uuid, text, text, text, bigint, text, boolean) to service_role;
grant execute on function public.sso_switch_set(uuid, text, text, text, boolean) to service_role;
grant all on public.sso_state, public.sso_site_policy, public.sso_agent_secrets, public.sso_requests, public.sso_audit to service_role;
