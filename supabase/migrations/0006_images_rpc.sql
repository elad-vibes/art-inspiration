-- ============================================================================
-- 0006_images_rpc.sql — every write to images, collections, suggestions,
-- ratings and comments. SECURITY DEFINER functions bypass RLS, so each one
-- checks the caller itself: signed in, the two-factor rule (mfa_ok), and the
-- studio permission it needs. "Not yours" and "doesn't exist" give the same
-- error, so nothing leaks through error messages.
--
-- The read-side helpers at the bottom (gallery, inbox, collections_list) are
-- SECURITY INVOKER: they only shape queries that still run under RLS.
-- ============================================================================

-- ------------------------------------------------------------- guards
create function public.require_ok() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v uuid := auth.uid();
begin
  if v is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if not public.mfa_ok() then
    raise exception 'mfa_required' using errcode = '42501';
  end if;
  return v;
end $$;

create function public.require_painter(p_studio uuid) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v uuid := public.require_ok();
begin
  if p_studio is null or not public.is_painter(p_studio) then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  return v;
end $$;

-- The studio of an image the painter owns, or not_found (same error for "not yours").
create function public.painter_image_studio(p_image uuid) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v_studio uuid;
begin
  perform public.require_ok();
  select studio_id into v_studio from public.images where id = p_image;
  if v_studio is null or not public.is_painter(v_studio) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  return v_studio;
end $$;

create function public.painter_collection_studio(p_collection uuid) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v_studio uuid;
begin
  perform public.require_ok();
  select studio_id into v_studio from public.collections where id = p_collection;
  if v_studio is null or not public.is_painter(v_studio) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  return v_studio;
end $$;

-- A file the caller just uploaded to their own folder of this studio, not yet used.
create function public.check_upload(p_studio uuid, p_uid uuid, p_path text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_path is null or split_part(p_path, '/', 1) <> p_studio::text or split_part(p_path, '/', 2) <> p_uid::text then
    raise exception 'bad_path' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'images' and o.name = p_path
      and (o.owner_id = p_uid::text or o.owner = p_uid)
  ) then
    raise exception 'upload_missing' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.images where storage_path = p_path) then
    raise exception 'bad_path' using errcode = 'P0001';
  end if;
end $$;

-- The chosen collection (must be in this studio) or the painter's default one.
create function public.target_collection(p_studio uuid, p_collection uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  if p_collection is null then
    return public.ensure_default_collection(p_studio, auth.uid());
  end if;
  if not exists (select 1 from public.collections where id = p_collection and studio_id = p_studio) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  return p_collection;
end $$;

-- ================================================================ uploads
-- The painter adds a photo from her phone. It goes into a collection (default
-- one unless she chose another) and stays private.
create function public.add_upload(p_studio uuid, p_path text, p_collection uuid default null,
                                  p_width int default null, p_height int default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := public.require_painter(p_studio); v_id uuid;
begin
  perform public.check_upload(p_studio, v_uid, p_path);
  insert into public.images (studio_id, owner_id, kind, storage_path, width, height)
  values (p_studio, v_uid, 'upload', p_path, p_width, p_height)
  returning id into v_id;
  insert into public.collection_items (collection_id, image_id, studio_id)
  values (public.target_collection(p_studio, p_collection), v_id, p_studio);
  return v_id;
end $$;

-- Saves a picture found on the web: details, credit and link only — never the
-- file (ART-PLAN §2). Called by the search screen (phase 3); no network here.
create function public.save_web_image(p_studio uuid, p_src jsonb, p_collection uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.require_painter(p_studio);
  v_id uuid;
  v_provider text := nullif(btrim(p_src ->> 'provider'), '');
  v_pid text := nullif(btrim(p_src ->> 'provider_id'), '');
begin
  if v_pid is not null then
    select id into v_id from public.images
     where studio_id = p_studio and kind = 'web' and provider is not distinct from v_provider and provider_id = v_pid;
  end if;
  if v_id is null then
    insert into public.images (studio_id, owner_id, kind, provider, provider_id, page_url, thumb_url, creator,
                               creator_url, source_name, license, license_url, attribution, width, height)
    values (p_studio, v_uid, 'web', v_provider, v_pid,
            nullif(btrim(p_src ->> 'page_url'), ''), nullif(btrim(p_src ->> 'thumb_url'), ''),
            nullif(btrim(p_src ->> 'creator'), ''), nullif(btrim(p_src ->> 'creator_url'), ''),
            nullif(btrim(p_src ->> 'source_name'), ''), nullif(btrim(p_src ->> 'license'), ''),
            nullif(btrim(p_src ->> 'license_url'), ''), nullif(btrim(p_src ->> 'attribution'), ''),
            (p_src ->> 'width')::int, (p_src ->> 'height')::int)
    returning id into v_id;
  end if;
  insert into public.collection_items (collection_id, image_id, studio_id)
  values (public.target_collection(p_studio, p_collection), v_id, p_studio)
  on conflict do nothing;
  return v_id;
end $$;

-- ============================================================ suggestions
-- A family member (can_send) sends the painter a photo + an optional message.
-- Limits (DECISIONS 14): 20 a day and 50 waiting per sender, so the box and
-- the storage quota stay sane.
create function public.send_suggestion(p_studio uuid, p_path text, p_message text default null,
                                       p_width int default null, p_height int default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := public.require_ok(); v_img uuid; v_id uuid;
begin
  if not exists (select 1 from public.studio_members
                  where studio_id = p_studio and user_id = v_uid and role = 'family' and can_send) then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  perform public.check_upload(p_studio, v_uid, p_path);
  if (select count(*) from public.suggestions
       where studio_id = p_studio and sender_id = v_uid and created_at > now() - interval '1 day') >= 20 then
    raise exception 'too_many_suggestions' using errcode = 'P0001';
  end if;
  if (select count(*) from public.suggestions
       where studio_id = p_studio and sender_id = v_uid and status = 'pending') >= 50 then
    raise exception 'too_many_suggestions' using errcode = 'P0001';
  end if;
  insert into public.images (studio_id, owner_id, kind, storage_path, width, height)
  values (p_studio, v_uid, 'upload', p_path, p_width, p_height)
  returning id into v_img;
  insert into public.suggestions (studio_id, sender_id, image_id, message)
  values (p_studio, v_uid, v_img, nullif(btrim(p_message), ''))
  returning id into v_id;
  return v_id;
end $$;

-- The painter decides: accept (save to a collection) / ignore / delete.
-- Delete removes the image row and returns the file path, which the app then
-- removes from Storage (Storage files can't be deleted from SQL).
create function public.decide_suggestion(p_suggestion uuid, p_action text, p_collection uuid default null) returns text
language plpgsql security definer set search_path = '' as $$
declare v public.suggestions; v_path text;
begin
  perform public.require_ok();
  select * into v from public.suggestions where id = p_suggestion for update;
  if not found or not public.is_painter(v.studio_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v.status not in ('pending', 'ignored') then
    raise exception 'already_decided' using errcode = 'P0001';
  end if;
  if p_action = 'accept' then
    insert into public.collection_items (collection_id, image_id, studio_id)
    values (public.target_collection(v.studio_id, p_collection), v.image_id, v.studio_id)
    on conflict do nothing;
    update public.suggestions set status = 'accepted', decided_at = now(), seen_at = coalesce(seen_at, now())
     where id = v.id;
    return null;
  elsif p_action = 'ignore' then
    update public.suggestions set status = 'ignored', decided_at = now(), seen_at = coalesce(seen_at, now())
     where id = v.id;
    return null;
  elsif p_action = 'delete' then
    select storage_path into v_path from public.images where id = v.image_id;
    update public.suggestions set status = 'deleted', image_id = null, decided_at = now(),
           seen_at = coalesce(seen_at, now())
     where id = v.id;
    delete from public.images where id = v.image_id;
    return v_path;
  end if;
  raise exception 'bad_action' using errcode = 'P0001';
end $$;

-- Opening the box clears the "new" marker (inside the app only — no notifications).
create function public.mark_suggestions_seen(p_studio uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  perform public.require_painter(p_studio);
  update public.suggestions set seen_at = now()
   where studio_id = p_studio and status = 'pending' and seen_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- What a sender sees about what they sent. The painter's "ignore" is shown as
-- "sent" (DECISIONS 14): the box is hers, and ignoring is a quiet choice.
create function public.my_suggestions(p_studio uuid)
returns table (id uuid, created_at timestamptz, message text, status text,
               image_id uuid, storage_path text, width int, height int)
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := public.require_ok();
begin
  if not public.is_member(p_studio) then
    return;
  end if;
  return query
  select s.id, s.created_at, s.message,
         case s.status when 'ignored' then 'pending' else s.status::text end,
         i.id, i.storage_path, i.width, i.height
    from public.suggestions s
    left join public.images i on i.id = s.image_id
   where s.studio_id = p_studio and s.sender_id = v_uid
   order by s.created_at desc
   limit 100;
end $$;

-- ============================================================ the painter
create function public.set_reaction(p_image uuid, p_rating text, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_studio uuid := public.painter_image_studio(p_image);
  v_uid uuid := auth.uid();
  v_rating public.image_rating := nullif(p_rating, '')::public.image_rating;
  v_note text := nullif(btrim(p_note), '');
begin
  if v_rating is null and v_note is null then
    delete from public.reactions where image_id = p_image and user_id = v_uid;
    return;
  end if;
  insert into public.reactions (image_id, user_id, studio_id, rating, note)
  values (p_image, v_uid, v_studio, v_rating, v_note)
  on conflict (image_id, user_id) do update
    set rating = excluded.rating, note = excluded.note, updated_at = now();
end $$;

-- A waiting suggestion must be accepted before it can be shared.
create function public.set_image_shared(p_image uuid, p_shared boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.painter_image_studio(p_image);
  if exists (select 1 from public.suggestions where image_id = p_image and status in ('pending', 'ignored')) then
    raise exception 'suggestion_pending' using errcode = 'P0001';
  end if;
  update public.images set shared = coalesce(p_shared, false) where id = p_image;
end $$;

-- Removes the image everywhere (collections, notes, comments). Returns the file
-- path for the app to remove from Storage (null for a web image — no file).
create function public.delete_image(p_image uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare v_path text;
begin
  perform public.painter_image_studio(p_image);
  select storage_path into v_path from public.images where id = p_image;
  update public.suggestions set status = 'deleted', image_id = null, decided_at = coalesce(decided_at, now())
   where image_id = p_image;
  delete from public.images where id = p_image;
  return v_path;
end $$;

-- ============================================================ collections
create function public.create_collection(p_studio uuid, p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := public.require_painter(p_studio); v_id uuid;
begin
  if (select count(*) from public.collections where studio_id = p_studio) >= 100 then
    raise exception 'too_many_collections' using errcode = 'P0001';
  end if;
  insert into public.collections (studio_id, owner_id, name) values (p_studio, v_uid, btrim(p_name))
  returning id into v_id;
  return v_id;
end $$;

create function public.rename_collection(p_collection uuid, p_name text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.painter_collection_studio(p_collection);
  update public.collections set name = btrim(p_name) where id = p_collection;
end $$;

create function public.set_collection_shared(p_collection uuid, p_shared boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.painter_collection_studio(p_collection);
  update public.collections set shared = coalesce(p_shared, false) where id = p_collection;
end $$;

-- The images stay (they may be in other collections, or in "הכול").
create function public.delete_collection(p_collection uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.painter_collection_studio(p_collection);
  if exists (select 1 from public.collections where id = p_collection and is_default) then
    raise exception 'default_collection' using errcode = 'P0001';
  end if;
  delete from public.collections where id = p_collection;
end $$;

-- Saving a waiting suggestion into a collection accepts it.
create function public.save_to_collection(p_image uuid, p_collection uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_studio uuid := public.painter_image_studio(p_image);
begin
  insert into public.collection_items (collection_id, image_id, studio_id)
  values (public.target_collection(v_studio, p_collection), p_image, v_studio)
  on conflict do nothing;
  update public.suggestions set status = 'accepted', decided_at = now(), seen_at = coalesce(seen_at, now())
   where image_id = p_image and status in ('pending', 'ignored');
end $$;

create function public.remove_from_collection(p_image uuid, p_collection uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_studio uuid := public.painter_image_studio(p_image);
begin
  delete from public.collection_items
   where image_id = p_image and collection_id = p_collection and studio_id = v_studio;
end $$;

-- =============================================================== comments
-- Only on shared images, only with can_comment + can_view (the painter has both).
create function public.add_comment(p_image uuid, p_body text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := public.require_ok(); v_studio uuid; v_id uuid;
begin
  select studio_id into v_studio from public.images where id = p_image;
  if v_studio is null or not public.has_perm(v_studio, 'view') or not public.is_image_shared(p_image) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not public.has_perm(v_studio, 'comment') then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  insert into public.comments (image_id, studio_id, author_id, body) values (p_image, v_studio, v_uid, btrim(p_body))
  returning id into v_id;
  return v_id;
end $$;

-- Your own comment, or any comment in her studio for the painter.
create function public.delete_comment(p_comment uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := public.require_ok(); v public.comments;
begin
  select * into v from public.comments where id = p_comment;
  if not found or not (public.is_painter(v.studio_id)
                       or (v.author_id = v_uid and public.has_perm(v.studio_id, 'view') and public.is_image_shared(v.image_id))) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  delete from public.comments where id = p_comment;
end $$;

-- Comments with the author's first name. Same rule as comments_select (0005);
-- a name is only revealed next to a comment you are allowed to read.
create function public.image_comments(p_image uuid)
returns table (id uuid, author_name text, mine boolean, body text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := public.require_ok(); v_studio uuid;
begin
  select i.studio_id into v_studio from public.images i where i.id = p_image;
  if v_studio is null or not (public.is_painter(v_studio)
                              or (public.has_perm(v_studio, 'view') and public.is_image_shared(p_image))) then
    return;
  end if;
  return query
  select c.id, coalesce(nullif(p.display_name, ''), 'בן/בת משפחה'), c.author_id = v_uid, c.body, c.created_at
    from public.comments c
    left join public.profiles p on p.user_id = c.author_id
   where c.image_id = p_image
   order by c.created_at
   limit 200;
end $$;

-- ================================================== read helpers (INVOKER)
-- These run as the caller: RLS decides what comes back; they only filter and join.

-- The mixed gallery. Waiting suggestions are not in it (they are in the box).
-- The painter sees all her images; family see only what she shared.
create function public.gallery(p_studio uuid, p_collection uuid default null)
returns table (id uuid, kind public.image_kind, storage_path text, width int, height int, shared boolean,
               family_can_see boolean, parent_id uuid, by_me boolean, owner_name text, page_url text, thumb_url text,
               creator text, creator_url text, source_name text, license text, license_url text,
               attribution text, source_status text, created_at timestamptz,
               my_rating public.image_rating, my_note text, comment_count int)
language sql stable security invoker set search_path = '' as $$
  select i.id, i.kind, i.storage_path, i.width, i.height, i.shared,
         public.is_image_shared(i.id), i.parent_id, i.owner_id = (select auth.uid()), p.display_name, i.page_url, i.thumb_url,
         i.creator, i.creator_url, i.source_name, i.license, i.license_url,
         i.attribution, i.source_status, i.created_at,
         r.rating, r.note, (select count(*)::int from public.comments c where c.image_id = i.id)
    from public.images i
    left join public.reactions r on r.image_id = i.id and r.user_id = (select auth.uid())
    left join public.profiles p on p.user_id = i.owner_id
   where i.studio_id = p_studio
     and not exists (select 1 from public.suggestions s where s.image_id = i.id and s.status in ('pending', 'ignored'))
     and (public.is_painter(p_studio) or public.is_image_shared(i.id))
     and (p_collection is null or exists (
           select 1 from public.collection_items ci where ci.collection_id = p_collection and ci.image_id = i.id))
   order by i.created_at desc
   limit 500
$$;

-- The painter's suggestion box (RLS: suggestions are hers only).
create function public.inbox(p_studio uuid)
returns table (id uuid, status public.suggestion_status, message text, created_at timestamptz, is_new boolean,
               sender_name text, image_id uuid, storage_path text, width int, height int)
language sql stable security invoker set search_path = '' as $$
  select s.id, s.status, s.message, s.created_at, s.seen_at is null and s.status = 'pending',
         coalesce(nullif(p.display_name, ''), 'בן/בת משפחה'), i.id, i.storage_path, i.width, i.height
    from public.suggestions s
    join public.images i on i.id = s.image_id
    left join public.profiles p on p.user_id = s.sender_id
   where s.studio_id = p_studio and s.status in ('pending', 'ignored')
   order by s.created_at desc
   limit 200
$$;

-- Collections with a count and a cover (RLS: family see shared ones only).
create function public.collections_list(p_studio uuid)
returns table (id uuid, name text, is_default boolean, shared boolean, items int,
               cover_path text, cover_thumb text)
language sql stable security invoker set search_path = '' as $$
  select c.id, c.name, c.is_default, c.shared,
         (select count(*)::int from public.collection_items ci join public.images i on i.id = ci.image_id
           where ci.collection_id = c.id),
         cov.storage_path, cov.thumb_url
    from public.collections c
    left join lateral (
      select i.storage_path, i.thumb_url from public.collection_items ci
        join public.images i on i.id = ci.image_id
       where ci.collection_id = c.id
       order by ci.added_at desc limit 1) cov on true
   where c.studio_id = p_studio
   order by c.is_default desc, c.created_at
$$;

-- ================================================================== grants
revoke execute on function
  public.ensure_default_collection(uuid, uuid), public.tg_painter_default_collection(),
  public.is_image_shared(uuid), public.can_view_image(uuid),
  public.require_ok(), public.require_painter(uuid), public.painter_image_studio(uuid),
  public.painter_collection_studio(uuid), public.check_upload(uuid, uuid, text),
  public.target_collection(uuid, uuid),
  public.add_upload(uuid, text, uuid, int, int), public.save_web_image(uuid, jsonb, uuid),
  public.send_suggestion(uuid, text, text, int, int), public.decide_suggestion(uuid, text, uuid),
  public.mark_suggestions_seen(uuid), public.my_suggestions(uuid),
  public.set_reaction(uuid, text, text), public.set_image_shared(uuid, boolean), public.delete_image(uuid),
  public.create_collection(uuid, text), public.rename_collection(uuid, text),
  public.set_collection_shared(uuid, boolean), public.delete_collection(uuid),
  public.save_to_collection(uuid, uuid), public.remove_from_collection(uuid, uuid),
  public.add_comment(uuid, text), public.delete_comment(uuid), public.image_comments(uuid),
  public.gallery(uuid, uuid), public.inbox(uuid), public.collections_list(uuid)
from public, anon, authenticated;

grant execute on function
  -- used inside RLS policies and the INVOKER helpers, so the caller needs them
  public.is_image_shared(uuid), public.can_view_image(uuid),
  public.add_upload(uuid, text, uuid, int, int), public.save_web_image(uuid, jsonb, uuid),
  public.send_suggestion(uuid, text, text, int, int), public.decide_suggestion(uuid, text, uuid),
  public.mark_suggestions_seen(uuid), public.my_suggestions(uuid),
  public.set_reaction(uuid, text, text), public.set_image_shared(uuid, boolean), public.delete_image(uuid),
  public.create_collection(uuid, text), public.rename_collection(uuid, text),
  public.set_collection_shared(uuid, boolean), public.delete_collection(uuid),
  public.save_to_collection(uuid, uuid), public.remove_from_collection(uuid, uuid),
  public.add_comment(uuid, text), public.delete_comment(uuid), public.image_comments(uuid),
  public.gallery(uuid, uuid), public.inbox(uuid), public.collections_list(uuid)
to authenticated;

grant execute on all functions in schema public to service_role;
