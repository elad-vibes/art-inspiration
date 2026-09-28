-- ============================================================================
-- 0005_images_rls.sql — who sees which image, collection, note and comment.
-- Default deny (RLS on, SELECT-only policies). Every write goes through the
-- server functions in 0006, which check the caller themselves.
--
--   painter            → everything in her studio (except other people's notes)
--   family, sender     → the images they sent, nothing else of hers
--   family, can_view   → only what the painter shared (an image, or a shared
--                        collection), and the comments on it
--   admin / outsider   → nothing (DECISIONS 5)
-- ============================================================================

-- Shared with the family = the image itself is shared, or it sits in a shared
-- collection. False for anyone outside the image's studio.
create function public.is_image_shared(p_image uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.images i
    where i.id = p_image and public.is_member(i.studio_id)
      and (i.shared or exists (
        select 1 from public.collection_items ci
        join public.collections c on c.id = ci.collection_id
        where ci.image_id = i.id and c.shared))
  )
$$;

create function public.can_view_image(p_image uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.mfa_ok() and exists (
    select 1 from public.images i
    where i.id = p_image and (
      public.is_painter(i.studio_id)
      or (i.owner_id = (select auth.uid()) and public.is_member(i.studio_id))
      or (public.has_perm(i.studio_id, 'view') and public.is_image_shared(i.id))
    )
  )
$$;

alter table public.images            enable row level security;
alter table public.collections       enable row level security;
alter table public.collection_items  enable row level security;
alter table public.reactions         enable row level security;
alter table public.comments          enable row level security;
alter table public.suggestions       enable row level security;

create policy images_select on public.images
  for select to authenticated using (public.can_view_image(id));

create policy collections_select on public.collections
  for select to authenticated using (
    public.is_painter(studio_id) or (shared and public.has_perm(studio_id, 'view'))
  );

-- an item is visible exactly when its collection is (subquery runs under collections_select)
create policy collection_items_select on public.collection_items
  for select to authenticated using (
    exists (select 1 from public.collections c where c.id = collection_id)
  );

-- ratings and private notes: only the person who wrote them, never anyone else
create policy reactions_select on public.reactions
  for select to authenticated using (
    user_id = (select auth.uid()) and public.is_member(studio_id)
  );

-- comments live only on shared images
create policy comments_select on public.comments
  for select to authenticated using (
    public.is_painter(studio_id)
    or (public.has_perm(studio_id, 'view') and public.is_image_shared(image_id))
  );

-- the suggestion box is the painter's; senders read their own list through
-- my_suggestions() (0006)
create policy suggestions_select on public.suggestions
  for select to authenticated using (public.is_painter(studio_id));

create policy mfa_gate on public.images           as restrictive for all to authenticated using (public.mfa_ok()) with check (public.mfa_ok());
create policy mfa_gate on public.collections      as restrictive for all to authenticated using (public.mfa_ok()) with check (public.mfa_ok());
create policy mfa_gate on public.collection_items as restrictive for all to authenticated using (public.mfa_ok()) with check (public.mfa_ok());
create policy mfa_gate on public.reactions        as restrictive for all to authenticated using (public.mfa_ok()) with check (public.mfa_ok());
create policy mfa_gate on public.comments         as restrictive for all to authenticated using (public.mfa_ok()) with check (public.mfa_ok());
create policy mfa_gate on public.suggestions      as restrictive for all to authenticated using (public.mfa_ok()) with check (public.mfa_ok());

-- ------------------------------------------------------------ privileges
-- New tables inherit Supabase's default "grant all"; take it back.
revoke all on public.images, public.collections, public.collection_items,
              public.reactions, public.comments, public.suggestions from anon, authenticated;
grant select on public.images, public.collections, public.collection_items,
                public.reactions, public.comments, public.suggestions to authenticated;
grant all on public.images, public.collections, public.collection_items,
             public.reactions, public.comments, public.suggestions to service_role;
