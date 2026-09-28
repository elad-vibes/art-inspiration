-- ============================================================================
-- 0007_storage.sql — private bucket "images" for family photos and the
-- painter's uploads. Web images are never stored here (ART-PLAN §2).
--
-- Path: {studio}/{uploader}/{uuid}.webp|jpg — the app re-encodes every photo in
-- the browser first (drops EXIF and location).
--   upload  → only into your own folder, in a studio where you are the painter
--             or may send suggestions;
--   read    → only files that belong to an image row you may see (can_view_image),
--             or your own upload that isn't used yet (so a failed send can be cleaned);
--   delete  → only files no image row uses any more (your own, or any in her
--             studio for the painter);
--   update  → nobody (no overwriting).
-- Files are shown through short-lived signed URLs; the bucket is not public.
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('images', 'images', false, 5242880, array['image/webp', 'image/jpeg'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create function public.try_uuid(p text) returns uuid
language plpgsql immutable set search_path = '' as $$
begin
  return p::uuid;
exception when others then
  return null;
end $$;

create function public.can_upload_object(p_bucket text, p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_bucket = 'images' and public.mfa_ok() and (select auth.uid()) is not null
     and p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webp|jpg)$'
     and split_part(p_name, '/', 2) = (select auth.uid())::text
     and public.has_perm(public.try_uuid(split_part(p_name, '/', 1)), 'send')   -- the painter has every permission
$$;

create function public.can_remove_object(p_bucket text, p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_bucket = 'images' and public.mfa_ok() and (select auth.uid()) is not null
     and not exists (select 1 from public.images i where i.storage_path = p_name)
     and (
       (split_part(p_name, '/', 2) = (select auth.uid())::text
         and public.is_member(public.try_uuid(split_part(p_name, '/', 1))))
       or public.is_painter(public.try_uuid(split_part(p_name, '/', 1)))
     )
$$;

create function public.can_read_object(p_bucket text, p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_bucket = 'images' and public.mfa_ok() and (
    exists (select 1 from public.images i where i.storage_path = p_name and public.can_view_image(i.id))
    or public.can_remove_object(p_bucket, p_name)
  )
$$;

create policy pi_images_read on storage.objects
  for select to authenticated using (public.can_read_object(bucket_id, name));
create policy pi_images_upload on storage.objects
  for insert to authenticated with check (public.can_upload_object(bucket_id, name));
create policy pi_images_remove on storage.objects
  for delete to authenticated using (public.can_remove_object(bucket_id, name));

revoke execute on function public.try_uuid(text), public.can_upload_object(text, text),
  public.can_remove_object(text, text), public.can_read_object(text, text) from public, anon, authenticated;
grant execute on function public.try_uuid(text), public.can_upload_object(text, text),
  public.can_remove_object(text, text), public.can_read_object(text, text) to authenticated, service_role;
