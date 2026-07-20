-- WiFi-presence attendance schema
-- Run this in the Supabase SQL editor (or `supabase db push`) before the
-- ada agent or the web frontend are used.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  identifier text unique,          -- e.g. student/staff ID (NIM/NIP)
  role text not null default 'student',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  mac_address text not null unique,
  label text,
  created_at timestamptz not null default now(),
  constraint mac_address_format check (mac_address ~ '^([0-9a-f]{2}:){5}[0-9a-f]{2}$')
);

create index if not exists devices_user_id_idx on public.devices(user_id);

-- Current status, one row per user.
create table if not exists public.presence (
  user_id uuid primary key references public.users(id) on delete cascade,
  status text not null default 'absent' check (status in ('present', 'absent')),
  last_seen_at timestamptz,
  since timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Daily audit trail.
create table if not exists public.attendance_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
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

create or replace function public.normalize_mac(raw text)
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

create or replace function public.devices_normalize_mac()
returns trigger
language plpgsql
as $$
begin
  new.mac_address := public.normalize_mac(new.mac_address);
  if new.mac_address is null then
    raise exception 'invalid mac address: %', new.mac_address;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_devices_normalize_mac on public.devices;
create trigger trg_devices_normalize_mac
  before insert or update on public.devices
  for each row execute function public.devices_normalize_mac();

-- ---------------------------------------------------------------------
-- Public read view (name + status only — no MAC addresses or identifiers).
-- ---------------------------------------------------------------------

create or replace view public.presence_board as
select
  u.id as user_id,
  u.full_name,
  coalesce(p.status, 'absent') as status,
  p.last_seen_at,
  p.since
from public.users u
left join public.presence p on p.user_id = u.id
where u.active = true
order by u.full_name;

-- ---------------------------------------------------------------------
-- report_presence: called by the ada agent (service_role) every scan cycle.
-- ---------------------------------------------------------------------

create or replace function public.report_presence(
  macs text[],
  seen_at timestamptz default now(),
  agent_id text default null,
  absence_timeout_seconds int default 120
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_macs text[];
  matched_user_ids uuid[];
begin
  select array_agg(distinct nm) into normalized_macs
  from (select public.normalize_mac(m) as nm from unnest(macs) as m) s
  where nm is not null;

  select array_agg(distinct d.user_id) into matched_user_ids
  from public.devices d
  where d.mac_address = any(normalized_macs);

  if matched_user_ids is not null then
    insert into public.presence (user_id, status, last_seen_at, since, updated_at)
    select uid, 'present', seen_at, seen_at, seen_at
    from unnest(matched_user_ids) as uid
    on conflict (user_id) do update
      set status = 'present',
          last_seen_at = excluded.last_seen_at,
          since = case when public.presence.status = 'present'
                       then public.presence.since
                       else excluded.since end,
          updated_at = excluded.updated_at;

    insert into public.attendance_log (user_id, date, first_seen, last_seen, present)
    select uid, (seen_at at time zone 'utc')::date, seen_at, seen_at, true
    from unnest(matched_user_ids) as uid
    on conflict (user_id, date) do update
      set last_seen = excluded.last_seen,
          present = true;
  end if;

  -- Flip previously-present users to absent once they exceed the timeout
  -- and weren't in this scan. Server-side, so the board self-heals even
  -- if the agent restarts or a scan cycle is skipped.
  update public.presence p
  set status = 'absent', updated_at = seen_at
  where p.status = 'present'
    and p.last_seen_at < seen_at - make_interval(secs => absence_timeout_seconds)
    and (matched_user_ids is null or not (p.user_id = any(matched_user_ids)));
end;
$$;

revoke all on function public.report_presence(text[], timestamptz, text, int) from public;
grant execute on function public.report_presence(text[], timestamptz, text, int) to service_role;

-- ---------------------------------------------------------------------
-- Row-level security: deny direct table access to anon/authenticated.
-- service_role bypasses RLS automatically (Supabase default) so the RPC
-- above still works. Only the presence_board view is exposed publicly.
-- ---------------------------------------------------------------------

alter table public.users enable row level security;
alter table public.devices enable row level security;
alter table public.presence enable row level security;
alter table public.attendance_log enable row level security;
-- No policies defined for anon/authenticated -> default deny on the base tables.

grant usage on schema public to anon, authenticated;
grant select on public.presence_board to anon, authenticated;
revoke all on public.users, public.devices, public.presence, public.attendance_log
  from anon, authenticated;

-- ---------------------------------------------------------------------
-- Realtime: let the frontend subscribe to live presence changes.
-- ---------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'presence'
  ) then
    alter publication supabase_realtime add table public.presence;
  end if;
end $$;
