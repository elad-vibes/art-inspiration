-- ============================================================================
-- 0002_rls.sql — Row Level Security + two-factor rules. Default deny: RLS is
-- enabled everywhere and access exists only where a policy grants it.
-- Service-role (Edge Functions) bypasses RLS by design.
--
-- Two-factor rule (DECISIONS 6):
--   * the super-admin needs aal2 for every admin function (is_super_admin);
--   * anyone who has a verified factor must use it (restrictive mfa_gate).
-- ============================================================================

-- 'aal1' | 'aal2' from the caller's JWT (PostgREST sets request.jwt.claims)
create function public.jwt_aal() returns text
language sql stable set search_path = '' as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'aal', 'aal1')
$$;

create function public.has_verified_factor(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.mfa_factors f
    where f.user_id = p_user and f.status::text = 'verified' and f.factor_type::text <> 'recovery_code'
  )
$$;

-- true when this session passes the two-factor rule
create function public.mfa_ok() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.jwt_aal() = 'aal2' or not public.has_verified_factor((select auth.uid()))
$$;

-- ------------------------------------------------------- helper functions
-- SECURITY DEFINER so they can read studio_members without recursing into its
-- own policies. search_path is pinned to '' (no hijacking).
create function public.is_member(p_studio uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.studio_members m
    where m.studio_id = p_studio and m.user_id = (select auth.uid())
  )
$$;

create function public.is_painter(p_studio uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.studio_members m
    where m.studio_id = p_studio and m.user_id = (select auth.uid()) and m.role = 'painter'
  )
$$;

-- p_perm: 'send' | 'view' | 'comment' | 'generate'. The painter has them all.
-- An unknown permission name is false for everyone (fail closed).
create function public.has_perm(p_studio uuid, p_perm text) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_perm in ('send', 'view', 'comment', 'generate') and exists (
    select 1 from public.studio_members m
    where m.studio_id = p_studio and m.user_id = (select auth.uid())
      and (m.role = 'painter' or case p_perm
            when 'send' then m.can_send
            when 'view' then m.can_view
            when 'comment' then m.can_comment
            when 'generate' then m.can_generate
            else false end)
  )
$$;

create function public.is_super_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.jwt_aal() = 'aal2'
     and exists (select 1 from public.app_admins a where a.user_id = (select auth.uid()))
$$;

-- --------------------------------------------------------- enable RLS
alter table public.profiles        enable row level security;
alter table public.studios         enable row level security;
alter table public.studio_members  enable row level security;
alter table public.invites         enable row level security;   -- no policies: admin RPCs only
alter table public.app_admins      enable row level security;   -- no policies: nobody
alter table public.app_config      enable row level security;   -- no policies: nobody
alter table public.rate_limits     enable row level security;   -- no policies: nobody

-- ------------------------------------------------------------ policies
-- studios: members read the name. Created / renamed / deleted by admin RPCs only.
create policy studios_select on public.studios
  for select to authenticated using (public.is_member(id));

-- studio_members: you see your own row; the painter sees everyone in her
-- studio; family members see who the painter is (not each other).
-- Changes only via admin RPCs and accept_invite.
create policy members_select on public.studio_members
  for select to authenticated using (
    user_id = (select auth.uid())
    or public.is_painter(studio_id)
    or (role = 'painter' and public.is_member(studio_id))
  );

-- profiles: your own, plus the people whose membership row you may see
-- (the subquery runs under members_select above).
create policy profiles_select on public.profiles
  for select to authenticated using (
    user_id = (select auth.uid())
    or exists (select 1 from public.studio_members m where m.user_id = profiles.user_id)
  );
create policy profiles_insert on public.profiles
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy profiles_update on public.profiles
  for update to authenticated using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- two-factor gate: AND-ed with every policy above
create policy mfa_gate on public.studios        as restrictive for all to authenticated using (public.mfa_ok()) with check (public.mfa_ok());
create policy mfa_gate on public.studio_members as restrictive for all to authenticated using (public.mfa_ok()) with check (public.mfa_ok());
create policy mfa_gate on public.profiles       as restrictive for all to authenticated using (public.mfa_ok()) with check (public.mfa_ok());

-- ------------------------------------------------------------ privileges
-- Supabase grants ALL on public tables to anon/authenticated by default.
-- Tighten: anon gets nothing, authenticated gets only what the app uses.
revoke all on all tables in schema public from anon, authenticated;

grant select on public.studios to authenticated;
grant select on public.studio_members to authenticated;
grant select, insert on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;

grant all on all tables in schema public to service_role;
