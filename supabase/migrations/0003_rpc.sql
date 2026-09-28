-- ============================================================================
-- 0003_rpc.sql — server-side functions.
--   * user RPCs   (authenticated; check the caller themselves)
--   * admin RPCs  (require is_super_admin() = app_admins + aal2). They manage
--                 studios, people and permissions — never images or notes.
--   * svc_* RPCs  (service_role only — called by Edge Functions)
-- All are SECURITY DEFINER with search_path = '' and explicit grants at the end.
-- ============================================================================

create function public.token_hash(p_token text) returns text
language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex')
$$;

-- 244 random bits, url-safe hex (64 chars)
create function public.new_token() returns text
language sql volatile set search_path = '' as $$
  select replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
$$;

create function public.require_admin() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_super_admin() then
    raise exception 'not_admin' using errcode = '42501';
  end if;
end $$;

-- ================================================================ user RPCs
-- Lets the app know whether to show the admin entry (and to ask for 2FA first).
-- Says nothing about anyone else; admin DATA still requires aal2.
create function public.am_i_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_admins where user_id = (select auth.uid()))
$$;

create function public.accept_invite(p_token text, p_display_name text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_inv    public.invites;
  v_uid    uuid := auth.uid();
  v_email  text;
  v_name   text;
  v_painter boolean;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  select * into v_inv from public.invites where token_hash = public.token_hash(p_token) for update;
  if not found or v_inv.revoked_at is not null or v_inv.expires_at < now() then
    raise exception 'invite_invalid' using errcode = 'P0001';
  end if;
  if v_inv.used_at is not null then
    if v_inv.used_by = v_uid then
      return v_inv.studio_id;                  -- idempotent re-accept
    end if;
    raise exception 'invite_used' using errcode = 'P0001';
  end if;
  select lower(u.email) into v_email from auth.users u where u.id = v_uid;
  if v_inv.claimed_email is not null and v_inv.claimed_email is distinct from v_email then
    raise exception 'invite_other_email' using errcode = 'P0001';
  end if;

  v_painter := v_inv.role = 'painter';
  if exists (select 1 from public.studio_members where studio_id = v_inv.studio_id and user_id = v_uid) then
    -- already in this studio: the invite is spent, permissions stay as the admin set them
    null;
  elsif v_painter and exists (select 1 from public.studio_members where studio_id = v_inv.studio_id and role = 'painter') then
    raise exception 'studio_has_painter' using errcode = 'P0001';
  else
    insert into public.studio_members (studio_id, user_id, role, can_send, can_view, can_comment, can_generate)
    values (v_inv.studio_id, v_uid, v_inv.role,
            v_painter or v_inv.can_send, v_painter or v_inv.can_view,
            v_painter or v_inv.can_comment, v_painter or v_inv.can_generate);
  end if;

  v_name := left(coalesce(nullif(btrim(p_display_name), ''), v_inv.person_name,
                          split_part(coalesce(v_email, ''), '@', 1), 'אני'), 40);
  insert into public.profiles (user_id, display_name) values (v_uid, v_name)
  on conflict (user_id) do update
    set display_name = case when public.profiles.display_name = '' then excluded.display_name
                            else public.profiles.display_name end;

  update public.invites set used_at = now(), used_by = v_uid where id = v_inv.id;
  return v_inv.studio_id;
end $$;

-- =============================================================== admin RPCs
create function public.admin_studios()
returns table (id uuid, name text, created_at timestamptz, painter_name text, members int, open_invites int)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_admin();
  return query
  select s.id, s.name, s.created_at,
         (select p.display_name from public.studio_members m
            left join public.profiles p on p.user_id = m.user_id
           where m.studio_id = s.id and m.role = 'painter'),
         (select count(*)::int from public.studio_members m where m.studio_id = s.id),
         (select count(*)::int from public.invites i
           where i.studio_id = s.id and i.used_at is null and i.revoked_at is null and i.expires_at > now())
    from public.studios s
   order by s.created_at;
end $$;

create function public.admin_create_studio(p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform public.require_admin();
  insert into public.studios (name) values (btrim(p_name)) returning id into v_id;
  return v_id;
end $$;

create function public.admin_rename_studio(p_studio uuid, p_name text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_admin();
  update public.studios set name = btrim(p_name) where id = p_studio;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
end $$;

create function public.admin_delete_studio(p_studio uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_admin();
  delete from public.studios where id = p_studio;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
end $$;

create function public.admin_members(p_studio uuid)
returns table (user_id uuid, display_name text, email text, role public.studio_role,
               can_send boolean, can_view boolean, can_comment boolean, can_generate boolean, joined_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_admin();
  return query
  select m.user_id, coalesce(p.display_name, ''), u.email::text, m.role,
         m.can_send, m.can_view, m.can_comment, m.can_generate, m.joined_at
    from public.studio_members m
    join auth.users u on u.id = m.user_id
    left join public.profiles p on p.user_id = m.user_id
   where m.studio_id = p_studio
   order by (m.role = 'painter') desc, m.joined_at, m.user_id;
end $$;

create function public.admin_set_member(
  p_studio uuid, p_user uuid, p_send boolean, p_view boolean, p_comment boolean, p_generate boolean
) returns void
language plpgsql security definer set search_path = '' as $$
declare v_role public.studio_role;
begin
  perform public.require_admin();
  select role into v_role from public.studio_members where studio_id = p_studio and user_id = p_user for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_role = 'painter' then
    raise exception 'painter_fixed' using errcode = 'P0001';   -- the painter always has everything
  end if;
  update public.studio_members
     set can_send = coalesce(p_send, false), can_view = coalesce(p_view, false),
         can_comment = coalesce(p_comment, false), can_generate = coalesce(p_generate, false)
   where studio_id = p_studio and user_id = p_user;
end $$;

create function public.admin_remove_member(p_studio uuid, p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_admin();
  delete from public.studio_members where studio_id = p_studio and user_id = p_user;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
end $$;

-- One-time link, 7 days. A painter invite is refused while the studio has a painter.
create function public.admin_create_invite(
  p_studio uuid, p_role public.studio_role, p_send boolean, p_view boolean,
  p_comment boolean, p_generate boolean, p_person_name text default null
) returns text
language plpgsql security definer set search_path = '' as $$
declare v_token text; v_active int; v_painter boolean := p_role = 'painter';
begin
  perform public.require_admin();
  if not exists (select 1 from public.studios where id = p_studio) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_painter and exists (select 1 from public.studio_members where studio_id = p_studio and role = 'painter') then
    raise exception 'studio_has_painter' using errcode = 'P0001';
  end if;
  select count(*) into v_active from public.invites
   where studio_id = p_studio and used_at is null and revoked_at is null and expires_at > now();
  if v_active >= 20 then
    raise exception 'too_many_invites' using errcode = 'P0001';
  end if;
  v_token := public.new_token();
  insert into public.invites (studio_id, token_hash, role, can_send, can_view, can_comment, can_generate, person_name, created_by)
  values (p_studio, public.token_hash(v_token), p_role,
          v_painter or coalesce(p_send, false), v_painter or coalesce(p_view, false),
          v_painter or coalesce(p_comment, false), v_painter or coalesce(p_generate, false),
          nullif(left(btrim(coalesce(p_person_name, '')), 30), ''), auth.uid());
  return v_token;
end $$;

create function public.admin_invites(p_studio uuid)
returns table (id uuid, role public.studio_role, person_name text, can_send boolean, can_view boolean,
               can_comment boolean, can_generate boolean, created_at timestamptz, expires_at timestamptz,
               claimed_email text, status text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_admin();
  return query
  select i.id, i.role, i.person_name, i.can_send, i.can_view, i.can_comment, i.can_generate,
         i.created_at, i.expires_at, i.claimed_email,
         case when i.revoked_at is not null then 'revoked'
              when i.used_at is not null then 'used'
              when i.expires_at < now() then 'expired'
              else 'open' end
    from public.invites i
   where i.studio_id = p_studio
   order by i.created_at desc
   limit 30;
end $$;

create function public.admin_revoke_invite(p_invite uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_admin();
  update public.invites set revoked_at = now() where id = p_invite and used_at is null and revoked_at is null;
end $$;

-- ============================================================ service RPCs
-- Fixed-window rate limit. Returns true when the call is allowed.
create function public.svc_rate_limit(p_key text, p_bucket text, p_max int, p_window_secs int)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_start timestamptz; v_count int;
begin
  v_start := to_timestamp(floor(extract(epoch from now()) / p_window_secs) * p_window_secs);
  insert into public.rate_limits as r (key, bucket, window_start, count)
  values (p_key, p_bucket, v_start, 1)
  on conflict (key, bucket, window_start) do update set count = r.count + 1
  returning count into v_count;
  delete from public.rate_limits where key = p_key and window_start < now() - interval '2 days';
  return v_count <= p_max;
end $$;

-- Invite details for the join screen (before sign-in).
create function public.svc_invite_info(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v public.invites; v_name text;
begin
  select * into v from public.invites where token_hash = public.token_hash(p_token);
  if not found or v.revoked_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  if v.used_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'used');
  end if;
  if v.expires_at < now() then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  select name into v_name from public.studios where id = v.studio_id;
  return jsonb_build_object('ok', true, 'studio_name', v_name, 'role', v.role, 'person_name', v.person_name,
    'can_send', v.can_send, 'can_view', v.can_view, 'can_comment', v.can_comment, 'can_generate', v.can_generate);
end $$;

-- Binds an invite to the first e-mail that uses it (so a leaked link can't
-- be used to create more than one account).
create function public.svc_claim_invite(p_token text, p_email text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.invites; v_email text := lower(btrim(p_email));
begin
  select * into v from public.invites where token_hash = public.token_hash(p_token) for update;
  if not found or v.revoked_at is not null or v.expires_at < now() then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  if v.used_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'used');
  end if;
  if v.claimed_email is null then
    update public.invites set claimed_email = v_email where id = v.id;
  elsif v.claimed_email <> v_email then
    return jsonb_build_object('ok', false, 'reason', 'claimed');
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- One call for Edge Functions: role, permissions and the two-factor rule.
create function public.svc_access(p_studio uuid, p_user uuid, p_aal text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'role', m.role,
    'can_send', m.role = 'painter' or m.can_send,
    'can_view', m.role = 'painter' or m.can_view,
    'can_comment', m.role = 'painter' or m.can_comment,
    'can_generate', m.role = 'painter' or m.can_generate,
    'mfa_ok', coalesce(p_aal, 'aal1') = 'aal2' or not public.has_verified_factor(p_user))
  from (select 1) x
  left join public.studio_members m on m.studio_id = p_studio and m.user_id = p_user
$$;

-- ================================================================== grants
revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function
  public.jwt_aal(), public.mfa_ok(), public.is_member(uuid), public.is_painter(uuid),
  public.has_perm(uuid, text), public.is_super_admin(), public.local_month(timestamptz),
  public.am_i_admin(), public.accept_invite(text, text),
  public.admin_studios(), public.admin_create_studio(text), public.admin_rename_studio(uuid, text),
  public.admin_delete_studio(uuid), public.admin_members(uuid),
  public.admin_set_member(uuid, uuid, boolean, boolean, boolean, boolean),
  public.admin_remove_member(uuid, uuid),
  public.admin_create_invite(uuid, public.studio_role, boolean, boolean, boolean, boolean, text),
  public.admin_invites(uuid), public.admin_revoke_invite(uuid)
to authenticated;

grant execute on all functions in schema public to service_role;
