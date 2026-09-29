-- ============================================================================
-- 0001_core.sql — "השראה לציור": people, studios, permissions, invites, admin.
-- A studio belongs to one painter (Mom). Family members get four separate
-- permissions, set only by the super-admin (DECISIONS 3–4).
-- Every table gets RLS in 0002_rls.sql (default deny).
-- ============================================================================

create type public.studio_role as enum ('painter', 'family');

create table public.profiles (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  display_name  text not null default '' check (char_length(display_name) <= 40),
  created_at    timestamptz not null default now()
);

create table public.studios (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 60),
  created_at  timestamptz not null default now()
);

-- The painter implicitly has every permission (see has_perm in 0002); the
-- flags matter for family members only.
create table public.studio_members (
  studio_id     uuid not null references public.studios (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  role          public.studio_role not null,
  can_send      boolean not null default false,   -- send Mom suggestions
  can_view      boolean not null default false,   -- see what Mom marked as shared
  can_comment   boolean not null default false,   -- comment on shared images
  can_generate  boolean not null default false,   -- create / edit images (costs money)
  joined_at     timestamptz not null default now(),
  primary key (studio_id, user_id)
);
create index studio_members_user_idx on public.studio_members (user_id);
-- exactly one painter per studio
create unique index studio_one_painter on public.studio_members (studio_id) where role = 'painter';

create table public.invites (
  id             uuid primary key default gen_random_uuid(),
  studio_id      uuid not null references public.studios (id) on delete cascade,
  token_hash     text not null unique,
  role           public.studio_role not null default 'family',
  can_send       boolean not null default false,
  can_view       boolean not null default false,
  can_comment    boolean not null default false,
  can_generate   boolean not null default false,
  person_name    text null check (char_length(person_name) <= 30),
  created_by     uuid null references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null default (now() + interval '7 days'),
  claimed_email  text null,
  used_at        timestamptz null,
  used_by        uuid null references auth.users (id) on delete set null,
  revoked_at     timestamptz null
);
create index invites_studio_idx on public.invites (studio_id);

-- --------------------------------------------------------- admin & limits
create table public.app_admins (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now()
);

create table public.app_config (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

create table public.rate_limits (
  key           text not null,
  bucket        text not null,
  window_start  timestamptz not null,
  count         integer not null default 0,
  primary key (key, bucket, window_start)
);

-- The current month as the family sees it (Israel time) — for quotas later.
create function public.local_month(ts timestamptz default now()) returns text
language sql stable set search_path = '' as $$
  select to_char(ts at time zone 'Asia/Jerusalem', 'YYYY-MM')
$$;
