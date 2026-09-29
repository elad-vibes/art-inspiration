-- ============================================================================
-- 0008_delete_index.sql — deleting pictures, the small index of what was
-- deleted, and making sure no file is left behind (DECISIONS 18–20).
--
-- Two different kinds of "delete", on purpose:
--   * a picture found on the web is only HIDDEN (images.deleted_at). It was never
--     stored as a file, so nothing costs anything; the record (link + credit)
--     stays and the painter can restore it with one tap;
--   * an upload, a family suggestion or a generated picture is DELETED for real:
--     the file is removed from Storage, its notes / ratings / comments / collection
--     places go with it, and only a tiny index row stays (kind, sender, dates —
--     no picture, no thumbnail, no note, no file name). It can NOT be restored.
--
-- Removing the file is the part that can fail (Storage is a separate service),
-- so the path is written to `storage_cleanup` in the SAME transaction as the
-- delete. The Edge Function removes it right away; if that fails, or the app
-- dies half way, the queue row stays ("waiting for cleanup") and a scheduled
-- function retries with a growing delay. Files nobody points at any more
-- (failed uploads, a deleted studio) are swept into the same queue.
-- ============================================================================

-- ------------------------------------------------------------------ images
alter table public.images
  add column deleted_at timestamptz null,
  add column size_bytes bigint  null check (size_bytes >= 0);

-- Only a web image can be hidden. Everything else is deleted for real, so a row
-- that keeps a file can never be "deleted" by mistake.
alter table public.images
  add constraint images_hidden_web_only check (deleted_at is null or kind = 'web');
create index images_hidden_idx on public.images (studio_id, deleted_at desc) where deleted_at is not null;

-- The size Storage recorded for the file (never a number the browser sends).
-- Null when Storage didn't say; the admin screen counts those separately.
create function public.object_size(p_path text) returns bigint
language sql stable security definer set search_path = '' as $$
  select case when o.metadata ->> 'size' ~ '^[0-9]{1,12}$' then (o.metadata ->> 'size')::bigint end
    from storage.objects o where o.bucket_id = 'images' and o.name = p_path
$$;

create function public.tg_images_size() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.storage_path is not null and new.size_bytes is null then
    new.size_bytes := public.object_size(new.storage_path);
  end if;
  return new;
end $$;
create trigger images_size before insert on public.images
  for each row execute function public.tg_images_size();

update public.images i set size_bytes = public.object_size(i.storage_path)
 where i.storage_path is not null and i.size_bytes is null;

-- ---------------------------------------------------------- the small index
-- What is left after a real delete. Deliberately no picture, thumbnail, note,
-- comment, message or file name; `id` is the id the image had. There is no
-- title column either: uploads are re-encoded and their file name is never kept.
create table public.deleted_index (
  id           uuid primary key,
  studio_id    uuid not null references public.studios (id) on delete cascade,
  origin       text not null check (origin in ('upload', 'suggestion', 'generated')),
  sender_id    uuid null references auth.users (id) on delete set null,   -- family suggestions only
  uploaded_at  timestamptz not null,
  deleted_at   timestamptz not null default now(),
  constraint deleted_index_sender_only_suggestion check (origin = 'suggestion' or sender_id is null)
);
create index deleted_index_studio_idx on public.deleted_index (studio_id, deleted_at desc);

-- ------------------------------------------------- files waiting for cleanup
-- A row = a file that must be removed from Storage and isn't yet. Nobody can
-- read or write this table from the app (no policy); only server code does.
-- No foreign key to studios: the row must survive the studio's deletion.
create table public.storage_cleanup (
  path             text primary key check (path ~
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webp|jpg)$'),
  studio_id        uuid not null,
  queued_at        timestamptz not null default now(),
  attempts         int not null default 0,
  last_attempt_at  timestamptz null,
  last_error       text null check (char_length(last_error) <= 200)
);

-- --------------------------------------------------------------------- RLS
alter table public.deleted_index   enable row level security;
alter table public.storage_cleanup enable row level security;   -- no policies: server code only

-- The painter's index is hers alone: not a family member, not another studio, not the admin.
create policy deleted_index_select on public.deleted_index
  for select to authenticated using (public.is_painter(studio_id));
create policy mfa_gate on public.deleted_index as restrictive for all to authenticated
  using (public.mfa_ok()) with check (public.mfa_ok());

revoke all on public.deleted_index, public.storage_cleanup from anon, authenticated;
grant select on public.deleted_index to authenticated;
grant all on public.deleted_index, public.storage_cleanup to service_role;

-- ------------------------------------------- who sees what: hidden pictures
-- A hidden picture is visible to the painter only (for the "deleted" screen and
-- restore). For the family it does not exist, and it is not "shared" any more.
create or replace function public.is_image_shared(p_image uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.images i
    where i.id = p_image and i.deleted_at is null and public.is_member(i.studio_id)
      and (i.shared or exists (
        select 1 from public.collection_items ci
        join public.collections c on c.id = ci.collection_id
        where ci.image_id = i.id and c.shared))
  )
$$;

create or replace function public.can_view_image(p_image uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.mfa_ok() and exists (
    select 1 from public.images i
    where i.id = p_image and (
      public.is_painter(i.studio_id)
      or (i.deleted_at is null and (
            (i.owner_id = (select auth.uid()) and public.is_member(i.studio_id))
            or (public.has_perm(i.studio_id, 'view') and public.is_image_shared(i.id))))
    )
  )
$$;

-- Every "act on my image" function starts here; a hidden image is not one to act on
-- (restore has its own check below).
create or replace function public.painter_image_studio(p_image uuid) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v_studio uuid;
begin
  perform public.require_ok();
  select studio_id into v_studio from public.images where id = p_image and deleted_at is null;
  if v_studio is null or not public.is_painter(v_studio) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  return v_studio;
end $$;

create function public.painter_hidden_image_studio(p_image uuid) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v_studio uuid;
begin
  perform public.require_ok();
  select studio_id into v_studio from public.images where id = p_image and deleted_at is not null and kind = 'web';
  if v_studio is null or not public.is_painter(v_studio) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  return v_studio;
end $$;

-- A file that is queued for deletion is gone for everybody, even before Storage
-- has actually removed it (no signed URL for it, no matter who uploaded it).
create or replace function public.can_read_object(p_bucket text, p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_bucket = 'images' and public.mfa_ok()
    and not exists (select 1 from public.storage_cleanup c where c.path = p_name)
    and (
      exists (select 1 from public.images i where i.storage_path = p_name and public.can_view_image(i.id))
      or public.can_remove_object(p_bucket, p_name)
    )
$$;

-- ...and a file that is being deleted can't be registered as a new image.
create or replace function public.check_upload(p_studio uuid, p_uid uuid, p_path text) returns void
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
  if exists (select 1 from public.images where storage_path = p_path)
     or exists (select 1 from public.storage_cleanup where path = p_path) then
    raise exception 'bad_path' using errcode = 'P0001';
  end if;
end $$;

-- ================================================================ deleting
-- The one place that deletes a picture. Internal: not callable from the app.
-- Callers have already checked that the caller is the painter of this studio.
--   web image  → hidden (returns null: there is no file)
--   otherwise  → the row and everything on it go, one index row stays, the file
--                path is queued for removal and returned.
create function public.purge_image(p_image uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare v public.images; v_origin text; v_sender uuid;
begin
  select * into v from public.images where id = p_image for update;
  if not found or v.deleted_at is not null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  if v.kind = 'web' then
    -- restoring must never re-share silently: it comes back private
    update public.images set deleted_at = now(), shared = false where id = p_image;
    return null;
  end if;

  if v.kind = 'generated' then
    v_origin := 'generated';
  elsif exists (select 1 from public.suggestions where image_id = p_image) then
    v_origin := 'suggestion';
    select s.sender_id into v_sender from public.suggestions s where s.image_id = p_image;
  else
    v_origin := 'upload';
  end if;

  insert into public.deleted_index (id, studio_id, origin, sender_id, uploaded_at)
  values (v.id, v.studio_id, v_origin, v_sender, v.created_at);
  insert into public.storage_cleanup (path, studio_id) values (v.storage_path, v.studio_id)
  on conflict (path) do nothing;
  -- the sender keeps seeing "removed", but their caption goes with the picture
  update public.suggestions
     set status = 'deleted', image_id = null, message = null,
         decided_at = coalesce(decided_at, now()), seen_at = coalesce(seen_at, now())
   where image_id = p_image;
  delete from public.images where id = p_image;     -- collection places, notes, ratings, comments cascade
  return v.storage_path;
end $$;

-- Same signature and result as before (0006): the file path to remove, or null.
create or replace function public.delete_image(p_image uuid) returns text
language plpgsql security definer set search_path = '' as $$
begin
  perform public.painter_image_studio(p_image);
  return public.purge_image(p_image);
end $$;

-- Restore: only the painter, only a hidden web image. Anything else is "not found".
create function public.restore_image(p_image uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.painter_hidden_image_studio(p_image);
  update public.images set deleted_at = null where id = p_image;    -- still private (shared = false)
end $$;

-- 0006's function with one change: the "delete" action goes through purge_image.
create or replace function public.decide_suggestion(p_suggestion uuid, p_action text, p_collection uuid default null) returns text
language plpgsql security definer set search_path = '' as $$
declare v public.suggestions;
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
    return public.purge_image(v.image_id);
  end if;
  raise exception 'bad_action' using errcode = 'P0001';
end $$;

-- 0006's function with one change: saving a web picture she hid brings it back.
create or replace function public.save_web_image(p_studio uuid, p_src jsonb, p_collection uuid default null) returns uuid
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
  else
    update public.images set deleted_at = null where id = v_id and deleted_at is not null;
  end if;
  insert into public.collection_items (collection_id, image_id, studio_id)
  values (public.target_collection(p_studio, p_collection), v_id, p_studio)
  on conflict do nothing;
  return v_id;
end $$;

-- ================================================== read helpers (INVOKER)
-- 0006's gallery / collections_list, with hidden pictures left out.
create or replace function public.gallery(p_studio uuid, p_collection uuid default null)
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
     and i.deleted_at is null
     and not exists (select 1 from public.suggestions s where s.image_id = i.id and s.status in ('pending', 'ignored'))
     and (public.is_painter(p_studio) or public.is_image_shared(i.id))
     and (p_collection is null or exists (
           select 1 from public.collection_items ci where ci.collection_id = p_collection and ci.image_id = i.id))
   order by i.created_at desc
   limit 500
$$;

create or replace function public.collections_list(p_studio uuid)
returns table (id uuid, name text, is_default boolean, shared boolean, items int,
               cover_path text, cover_thumb text)
language sql stable security invoker set search_path = '' as $$
  select c.id, c.name, c.is_default, c.shared,
         (select count(*)::int from public.collection_items ci join public.images i on i.id = ci.image_id
           where ci.collection_id = c.id and i.deleted_at is null),
         cov.storage_path, cov.thumb_url
    from public.collections c
    left join lateral (
      select i.storage_path, i.thumb_url from public.collection_items ci
        join public.images i on i.id = ci.image_id
       where ci.collection_id = c.id and i.deleted_at is null
       order by ci.added_at desc limit 1) cov on true
   where c.studio_id = p_studio
   order by c.is_default desc, c.created_at
$$;

-- The painter's "deleted" screen: hidden web pictures (restorable) and the small
-- index rows of real deletes (not restorable, no picture). RLS decides who gets
-- anything: a family member, another studio or the admin gets no rows.
create function public.deleted_list(p_studio uuid)
returns table (id uuid, origin text, restorable boolean, sender_name text, uploaded_at timestamptz,
               deleted_at timestamptz, thumb_url text, page_url text, creator text, source_name text, attribution text)
language sql stable security invoker set search_path = '' as $$
  select * from (
    select i.id, 'web'::text as origin, true as restorable, null::text as sender_name, i.created_at as uploaded_at,
           i.deleted_at, i.thumb_url, i.page_url, i.creator, i.source_name, i.attribution
      from public.images i
     where i.studio_id = p_studio and i.deleted_at is not null
    union all
    select d.id, d.origin, false,
           case when d.origin = 'suggestion' then coalesce(nullif(p.display_name, ''), 'בן/בת משפחה') end,
           d.uploaded_at, d.deleted_at, null, null, null, null, null
      from public.deleted_index d
      left join public.profiles p on p.user_id = d.sender_id
     where d.studio_id = p_studio
  ) x
  order by x.deleted_at desc
  limit 300
$$;

-- ================================================================== admin
-- Counts and the index only — never a picture, a note, a file name or a path.
create function public.admin_storage_overview()
returns table (id uuid, name text, image_count int, file_count int, bytes_est bigint, files_no_size int,
               deleted_count int, cleanup_pending int)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_admin();
  return query
  select s.id, s.name,
         (select count(*)::int from public.images i where i.studio_id = s.id and i.deleted_at is null),
         (select count(*)::int from public.images i where i.studio_id = s.id and i.storage_path is not null),
         coalesce((select sum(i.size_bytes) from public.images i where i.studio_id = s.id), 0)::bigint,
         (select count(*)::int from public.images i where i.studio_id = s.id and i.storage_path is not null and i.size_bytes is null),
         (select count(*)::int from public.deleted_index d where d.studio_id = s.id),
         (select count(*)::int from public.storage_cleanup c where c.studio_id = s.id)
    from public.studios s
   order by s.created_at;
end $$;

create function public.admin_deleted_index(p_studio uuid)
returns table (id uuid, origin text, sender_name text, uploaded_at timestamptz, deleted_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_admin();
  return query
  select d.id, d.origin, coalesce(p.display_name, ''), d.uploaded_at, d.deleted_at
    from public.deleted_index d
    left join public.profiles p on p.user_id = d.sender_id and d.origin = 'suggestion'
   where d.studio_id = p_studio
   order by d.deleted_at desc
   limit 200;
end $$;

-- Deleting a whole studio removes every image row, so its files must be queued first.
create or replace function public.admin_delete_studio(p_studio uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_admin();
  insert into public.storage_cleanup (path, studio_id)
  select i.storage_path, i.studio_id from public.images i
   where i.studio_id = p_studio and i.storage_path is not null
  on conflict (path) do nothing;
  delete from public.studios where id = p_studio;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
end $$;

-- ================================================ cleanup queue (service role)
-- Files nobody points at: an old upload that never became an image (a failed
-- send whose own clean-up also failed), or files left by a deleted studio.
-- Only our own path shape is ever queued, and only after a day: a photo that
-- was just uploaded and is about to be registered is never touched.
create function public.enqueue_orphan_files() returns int
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  insert into public.storage_cleanup (path, studio_id)
  select o.name, split_part(o.name, '/', 1)::uuid
    from storage.objects o
   where o.bucket_id = 'images'
     and o.created_at < now() - interval '1 day'
     and o.name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webp|jpg)$'
     and not exists (select 1 from public.images i where i.storage_path = o.name)
   limit 500
  on conflict (path) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- The next files to remove: not tried in the last moment, and waiting longer after
-- every failure (10 min, 20, 40 … at most a day). A path an image row still uses is
-- never handed out — the queue can never delete a picture that is in use.
create function public.svc_cleanup_batch(p_limit int default 50) returns text[]
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.storage_cleanup c where exists (select 1 from public.images i where i.storage_path = c.path);
  perform public.enqueue_orphan_files();
  return coalesce(array(
    select c.path from public.storage_cleanup c
     where c.queued_at < now() - interval '1 minute'
       and (c.last_attempt_at is null
            or c.last_attempt_at + least(interval '1 day', interval '5 minutes' * power(2, least(c.attempts, 10))) <= now())
     order by c.queued_at
     limit greatest(1, least(coalesce(p_limit, 50), 200))
  ), array[]::text[]);
end $$;

create function public.svc_cleanup_done(p_paths text[]) returns int
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  delete from public.storage_cleanup where path = any (coalesce(p_paths, array[]::text[]));
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create function public.svc_cleanup_failed(p_paths text[], p_error text default null) returns int
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  update public.storage_cleanup
     set attempts = attempts + 1, last_attempt_at = now(), last_error = left(nullif(btrim(p_error), ''), 200)
   where path = any (coalesce(p_paths, array[]::text[]));
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ================================================================== grants
revoke execute on function
  public.object_size(text), public.tg_images_size(), public.painter_hidden_image_studio(uuid),
  public.purge_image(uuid), public.restore_image(uuid), public.deleted_list(uuid),
  public.admin_storage_overview(), public.admin_deleted_index(uuid),
  public.enqueue_orphan_files(), public.svc_cleanup_batch(int), public.svc_cleanup_done(text[]),
  public.svc_cleanup_failed(text[], text)
from public, anon, authenticated;

grant execute on function
  public.restore_image(uuid), public.deleted_list(uuid),
  public.admin_storage_overview(), public.admin_deleted_index(uuid)
to authenticated;

grant execute on all functions in schema public to service_role;
