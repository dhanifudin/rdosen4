-- WiFi-presence attendance schema
-- Run this in the Supabase SQL editor (or `supabase db push`) before the
-- ada agent or the web frontend are used.
--
-- All objects live in the `dosen4` schema (not `public`), so this app is
-- namespaced away from anything else in the Supabase project. After
-- running this file, go to Supabase Dashboard -> Project Settings -> API
-- -> "Exposed schemas" and add `dosen4` (PostgREST only serves schemas on
-- that list). Equivalent SQL:
--   alter role authenticator set pgrst.db_schemas = 'public, dosen4, graphql_public';
--   notify pgrst, 'reload config';

create schema if not exists dosen4;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
-- gen_random_uuid() lives in pg_catalog on Supabase's Postgres (15+), so
-- it resolves regardless of search_path -- no extension needed.

create table if not exists dosen4.users (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  identifier text unique,          -- e.g. student/staff ID (NIM/NIP)
  role text not null default 'student',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists dosen4.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references dosen4.users(id) on delete cascade,
  mac_address text not null unique,
  label text,
  created_at timestamptz not null default now(),
  constraint mac_address_format check (mac_address ~ '^([0-9a-f]{2}:){5}[0-9a-f]{2}$')
);

create index if not exists devices_user_id_idx on dosen4.devices(user_id);

-- Current status, one row per user.
create table if not exists dosen4.presence (
  user_id uuid primary key references dosen4.users(id) on delete cascade,
  status text not null default 'absent' check (status in ('present', 'absent')),
  last_seen_at timestamptz,
  since timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Daily audit trail.
create table if not exists dosen4.attendance_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references dosen4.users(id) on delete cascade,
  date date not null default (now() at time zone 'utc')::date,
  first_seen timestamptz not null,
  last_seen timestamptz not null,
  present boolean not null default true,
  unique (user_id, date)
);

-- ---------------------------------------------------------------------
-- MAC normalization: lowercase colon form, e.g. "aa:bb:cc:dd:ee:ff".
-- Accepts input with any/no separators so the RPC and the devices table
-- always compare like-for-like.
-- ---------------------------------------------------------------------

create or replace function dosen4.normalize_mac(raw text)
returns text
language plpgsql
immutable
as $$
declare
  hex text;
begin
  hex := lower(regexp_replace(raw, '[^0-9a-fA-F]', '', 'g'));
  if length(hex) <> 12 then
    return null;
  end if;
  return substring(hex from 1 for 2) || ':' || substring(hex from 3 for 2) || ':' ||
         substring(hex from 5 for 2) || ':' || substring(hex from 7 for 2) || ':' ||
         substring(hex from 9 for 2) || ':' || substring(hex from 11 for 2);
end;
$$;

create or replace function dosen4.devices_normalize_mac()
returns trigger
language plpgsql
as $$
begin
  new.mac_address := dosen4.normalize_mac(new.mac_address);
  if new.mac_address is null then
    raise exception 'invalid mac address: %', new.mac_address;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_devices_normalize_mac on dosen4.devices;
create trigger trg_devices_normalize_mac
  before insert or update on dosen4.devices
  for each row execute function dosen4.devices_normalize_mac();

-- ---------------------------------------------------------------------
-- Public read view (name + status only — no MAC addresses or identifiers).
-- ---------------------------------------------------------------------

create or replace view dosen4.presence_board as
select
  u.id as user_id,
  u.full_name,
  coalesce(p.status, 'absent') as status,
  p.last_seen_at,
  p.since
from dosen4.users u
left join dosen4.presence p on p.user_id = u.id
where u.active = true
order by u.full_name;

-- ---------------------------------------------------------------------
-- report_presence: called by the ada agent (service_role) every scan cycle.
-- ---------------------------------------------------------------------

create or replace function dosen4.report_presence(
  macs text[],
  seen_at timestamptz default now(),
  agent_id text default null,
  absence_timeout_seconds int default 120
)
returns void
language plpgsql
security definer
set search_path = dosen4
as $$
declare
  normalized_macs text[];
  matched_user_ids uuid[];
begin
  select array_agg(distinct nm) into normalized_macs
  from (select dosen4.normalize_mac(m) as nm from unnest(macs) as m) s
  where nm is not null;

  select array_agg(distinct d.user_id) into matched_user_ids
  from dosen4.devices d
  where d.mac_address = any(normalized_macs);

  if matched_user_ids is not null then
    insert into dosen4.presence (user_id, status, last_seen_at, since, updated_at)
    select uid, 'present', seen_at, seen_at, seen_at
    from unnest(matched_user_ids) as uid
    on conflict (user_id) do update
      set status = 'present',
          last_seen_at = excluded.last_seen_at,
          since = case when dosen4.presence.status = 'present'
                       then dosen4.presence.since
                       else excluded.since end,
          updated_at = excluded.updated_at;

    insert into dosen4.attendance_log (user_id, date, first_seen, last_seen, present)
    select uid, (seen_at at time zone 'utc')::date, seen_at, seen_at, true
    from unnest(matched_user_ids) as uid
    on conflict (user_id, date) do update
      set last_seen = excluded.last_seen,
          present = true;
  end if;

  -- Flip previously-present users to absent once they exceed the timeout
  -- and weren't in this scan. Server-side, so the board self-heals even
  -- if the agent restarts or a scan cycle is skipped.
  update dosen4.presence p
  set status = 'absent', updated_at = seen_at
  where p.status = 'present'
    and p.last_seen_at < seen_at - make_interval(secs => absence_timeout_seconds)
    and (matched_user_ids is null or not (p.user_id = any(matched_user_ids)));
end;
$$;

revoke all on function dosen4.report_presence(text[], timestamptz, text, int) from public;
grant execute on function dosen4.report_presence(text[], timestamptz, text, int) to service_role;

-- ---------------------------------------------------------------------
-- Row-level security: deny direct table access to anon/authenticated.
-- service_role bypasses RLS automatically (Supabase default) so the RPC
-- above still works. Only the presence_board view is exposed publicly.
-- ---------------------------------------------------------------------

alter table dosen4.users enable row level security;
alter table dosen4.devices enable row level security;
alter table dosen4.presence enable row level security;
alter table dosen4.attendance_log enable row level security;
-- No policies defined for anon/authenticated -> default deny on the base tables.

grant usage on schema dosen4 to anon, authenticated, service_role;
grant select on dosen4.presence_board to anon, authenticated;
revoke all on dosen4.users, dosen4.devices, dosen4.presence, dosen4.attendance_log
  from anon, authenticated;

-- ---------------------------------------------------------------------
-- Realtime: let the frontend subscribe to live presence changes.
-- ---------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'dosen4' and tablename = 'presence'
  ) then
    alter publication supabase_realtime add table dosen4.presence;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Self-service device registration via Google SSO (Supabase Auth).
--
-- Google OAuth alone doesn't enforce an email domain (that needs the app to
-- be an "Internal" Google Workspace app, which isn't assumed here), so
-- enforcement happens in this app layer: any Google account can sign in,
-- get a profile row, and browse -- but only `auth_domain_ok` accounts
-- (email ends with @polinema.ac.id) can register a device, checked inside
-- register_device(). The frontend also checks client-side for fast/clean
-- UX, but this RPC check is the real gate.
-- ---------------------------------------------------------------------

alter table dosen4.users
  add column if not exists auth_domain_ok boolean not null default false;

-- Auto-provision a dosen4.users profile (keyed by the Supabase Auth user
-- id) the moment someone completes Google sign-in.
create or replace function dosen4.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = dosen4
as $$
begin
  insert into dosen4.users (id, full_name, auth_domain_ok)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    (new.email ilike '%@polinema.ac.id')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function dosen4.handle_new_user();

-- register_device / remove_device: the only way `authenticated` can write
-- to dosen4.devices -- centralizes the domain check, MAC normalization,
-- the per-user device cap, and a friendly duplicate-MAC message, instead
-- of duplicating that logic in RLS WITH CHECK clauses.

create or replace function dosen4.register_device(mac text, label text default null)
returns dosen4.devices
language plpgsql
security definer
set search_path = dosen4
as $$
declare
  uid uuid := auth.uid();
  domain_ok boolean;
  normalized text;
  device_count int;
  new_device dosen4.devices;
begin
  if uid is null then
    raise exception 'Not signed in.';
  end if;

  select auth_domain_ok into domain_ok from dosen4.users where id = uid;
  if coalesce(domain_ok, false) = false then
    raise exception 'Only @polinema.ac.id accounts can register a device.';
  end if;

  normalized := dosen4.normalize_mac(mac);
  if normalized is null then
    raise exception 'Invalid MAC address: %', mac;
  end if;

  select count(*) into device_count from dosen4.devices where user_id = uid;
  if device_count >= 5 then
    raise exception 'Device limit reached (max 5 per user).';
  end if;

  begin
    insert into dosen4.devices (user_id, mac_address, label)
    values (uid, normalized, label)
    returning * into new_device;
  exception when unique_violation then
    raise exception 'This device is already registered.';
  end;

  return new_device;
end;
$$;

revoke all on function dosen4.register_device(text, text) from public;
grant execute on function dosen4.register_device(text, text) to authenticated;

create or replace function dosen4.remove_device(device_id uuid)
returns void
language plpgsql
security definer
set search_path = dosen4
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'Not signed in.';
  end if;

  delete from dosen4.devices where id = device_id and user_id = uid;
  if not found then
    raise exception 'Device not found.';
  end if;
end;
$$;

revoke all on function dosen4.remove_device(uuid) from public;
grant execute on function dosen4.remove_device(uuid) to authenticated;

-- RLS: authenticated users can see/update their own profile and see
-- (not directly write) their own devices; writes go through the RPCs above.

drop policy if exists "users can view own profile" on dosen4.users;
create policy "users can view own profile" on dosen4.users
  for select using (auth.uid() = id);

drop policy if exists "users can update own profile" on dosen4.users;
create policy "users can update own profile" on dosen4.users
  for update using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "users can view own devices" on dosen4.devices;
create policy "users can view own devices" on dosen4.devices
  for select using (auth.uid() = user_id);

grant select, update on dosen4.users to authenticated;
grant select on dosen4.devices to authenticated;

-- ---------------------------------------------------------------------
-- Auto-detected device registration: correlate "who just started a
-- detection window" with "what MAC just freshly appeared on the LAN",
-- reported by the ada agent (which has the LAN visibility a browser
-- never can). At most one detection window is open globally at a time
-- (enforced by the partial unique index below), which is what lets a
-- single newly-appearing MAC be attributed unambiguously.
--
-- Critical UX ordering (enforced by the frontend copy, not by SQL): the
-- user must turn Wi-Fi OFF before/as they start a window, then back on a
-- few seconds later. The first observation after a window opens becomes
-- the "baseline" (assumed not to be the registrant); anything unregistered
-- that appears afterwards is a candidate. If they're still connected when
-- they click start, their own MAC lands in the baseline and can never
-- become a candidate.
-- ---------------------------------------------------------------------

create table if not exists dosen4.detection_windows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references dosen4.users(id) on delete cascade,
  label text,
  status text not null default 'open' check (status in ('open', 'resolved', 'ambiguous', 'expired')),
  baseline_macs text[],
  candidate_macs text[] not null default '{}',
  resolved_device_id uuid references dosen4.devices(id),
  started_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '120 seconds'
);

-- A partial unique index on a constant expression: every qualifying row
-- indexes to the same value, so at most one row total can ever have
-- status = 'open'. This is the single-global-window guarantee.
create unique index if not exists one_open_detection_window
  on dosen4.detection_windows ((true))
  where status = 'open';

alter table dosen4.detection_windows enable row level security;

drop policy if exists "users can view own detection window" on dosen4.detection_windows;
create policy "users can view own detection window" on dosen4.detection_windows
  for select using (auth.uid() = user_id);

grant select on dosen4.detection_windows to authenticated;

create or replace function dosen4.start_detection_window(p_label text default null)
returns table(id uuid, expires_at timestamptz)
language plpgsql
security definer
set search_path = dosen4
as $$
declare
  uid uuid := auth.uid();
  domain_ok boolean;
  device_count int;
  new_id uuid;
  new_expires timestamptz;
begin
  if uid is null then
    raise exception 'Not signed in.';
  end if;

  select u.auth_domain_ok into domain_ok from dosen4.users u where u.id = uid;
  if coalesce(domain_ok, false) = false then
    raise exception 'Only @polinema.ac.id accounts can register a device.';
  end if;

  select count(*) into device_count from dosen4.devices where user_id = uid;
  if device_count >= 5 then
    raise exception 'Device limit reached (max 5 per user).';
  end if;

  begin
    insert into dosen4.detection_windows (user_id, label)
    values (uid, p_label)
    returning detection_windows.id, detection_windows.expires_at into new_id, new_expires;
  exception when unique_violation then
    raise exception 'Someone else is registering a device right now -- please try again in a minute.';
  end;

  return query select new_id, new_expires;
end;
$$;

revoke all on function dosen4.start_detection_window(text) from public;
grant execute on function dosen4.start_detection_window(text) to authenticated;

-- Called by the ada agent (service_role) on every scan cycle. A no-op
-- when no window is open. Returns whether a window is open and how many
-- seconds remain, so the agent can decide its next sleep interval without
-- a second round-trip.
create or replace function dosen4.observe_macs_for_detection(p_macs text[])
returns table(window_open boolean, seconds_remaining numeric)
language plpgsql
security definer
set search_path = dosen4
as $$
declare
  w dosen4.detection_windows;
  normalized text[];
  unregistered text[];
  new_candidates text[];
  domain_ok boolean;
  device_count int;
  new_device_id uuid;
begin
  select array_agg(distinct nm) into normalized
  from (select dosen4.normalize_mac(m) as nm from unnest(p_macs) as m) s
  where nm is not null;

  select * into w from dosen4.detection_windows where status = 'open' limit 1;

  if w is null then
    return query select false, 0::numeric;
    return;
  end if;

  if w.expires_at <= now() then
    update dosen4.detection_windows set status = 'expired' where id = w.id;
    return query select false, 0::numeric;
    return;
  end if;

  -- MACs not already claimed by anyone are the only ones interesting here.
  select coalesce(array_agg(m), '{}') into unregistered
  from unnest(coalesce(normalized, '{}')) as m
  where not exists (select 1 from dosen4.devices d where d.mac_address = m);

  if w.baseline_macs is null then
    -- First observation since the window opened: whatever's already
    -- present is the baseline, not a match (the registrant hasn't
    -- reconnected yet).
    update dosen4.detection_windows set baseline_macs = unregistered where id = w.id;
    return query select true, extract(epoch from (w.expires_at - now()));
    return;
  end if;

  -- Anything unregistered, not in the baseline, and not already recorded.
  select coalesce(array_agg(m), '{}') into new_candidates
  from unnest(unregistered) as m
  where m <> all(w.baseline_macs) and m <> all(w.candidate_macs);

  if array_length(new_candidates, 1) > 0 then
    update dosen4.detection_windows
    set candidate_macs = candidate_macs || new_candidates
    where id = w.id
    returning * into w;
  end if;

  if array_length(w.candidate_macs, 1) = 1 then
    select auth_domain_ok into domain_ok from dosen4.users where id = w.user_id;
    if coalesce(domain_ok, false) = false then
      update dosen4.detection_windows set status = 'ambiguous' where id = w.id;
      return query select false, 0::numeric;
      return;
    end if;

    select count(*) into device_count from dosen4.devices where user_id = w.user_id;
    if device_count >= 5 then
      update dosen4.detection_windows set status = 'ambiguous' where id = w.id;
      return query select false, 0::numeric;
      return;
    end if;

    begin
      insert into dosen4.devices (user_id, mac_address, label)
      values (w.user_id, w.candidate_macs[1], w.label)
      returning devices.id into new_device_id;
    exception when unique_violation then
      update dosen4.detection_windows set status = 'ambiguous' where id = w.id;
      return query select false, 0::numeric;
      return;
    end;

    update dosen4.detection_windows
    set status = 'resolved', resolved_device_id = new_device_id
    where id = w.id;
    return query select false, 0::numeric;
    return;
  elsif array_length(w.candidate_macs, 1) > 1 then
    update dosen4.detection_windows set status = 'ambiguous' where id = w.id;
    return query select false, 0::numeric;
    return;
  end if;

  return query select true, extract(epoch from (w.expires_at - now()));
end;
$$;

revoke all on function dosen4.observe_macs_for_detection(text[]) from public;
grant execute on function dosen4.observe_macs_for_detection(text[]) to service_role;

-- Cheap, scan-free probe the agent can call frequently (e.g. every 5s)
-- during its normal idle cadence, to notice a newly-opened window sooner
-- than waiting out the full scan interval -- without needing a real
-- network scan just to check.
create or replace function dosen4.is_detection_window_open()
returns boolean
language sql
stable
security definer
set search_path = dosen4
as $$
  select exists(
    select 1 from dosen4.detection_windows
    where status = 'open' and expires_at > now()
  );
$$;

revoke all on function dosen4.is_detection_window_open() from public;
grant execute on function dosen4.is_detection_window_open() to service_role;
