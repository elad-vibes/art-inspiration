-- ============================================================================
-- 0004_images.sql — images, collections, suggestions, ratings, comments.
-- (ART-PLAN §7, phase 2.) RLS in 0005, server functions in 0006, Storage in 0007.
--
-- Privacy model (DECISIONS 8, 13):
--   * everything the painter keeps is private to her until she shares it
--     (an image, or a whole collection);
--   * a family suggestion is seen by its sender and the painter only;
--   * ratings and private notes are only ever seen by the person who wrote them;
--   * family comments exist only on shared images.
-- Web images are never stored as files — only details, credit and a link.
-- ============================================================================

create type public.image_kind as enum ('web', 'upload', 'generated');
create type public.image_rating as enum ('like', 'not_suitable');
create type public.suggestion_status as enum ('pending', 'accepted', 'ignored', 'deleted');

-- ------------------------------------------------------------------ images
create table public.images (
  id            uuid primary key default gen_random_uuid(),
  studio_id     uuid not null references public.studios (id) on delete cascade,
  -- who added it (the painter, or the family member who sent it). Kept when an
  -- account is deleted, so the painter never loses an image she saved.
  owner_id      uuid null references auth.users (id) on delete set null,
  kind          public.image_kind not null,
  -- private bucket "images": {studio}/{owner}/{uuid}.webp|jpg (0007)
  storage_path  text null unique,
  width         int null check (width between 1 and 20000),
  height        int null check (height between 1 and 20000),
  -- a version keeps a link to its source image (versions arrive in phase 7)
  parent_id     uuid null,
  shared        boolean not null default false,    -- the painter shared it with the family
  -- web images only: where it came from, never the file itself
  provider      text null check (char_length(provider) <= 40),
  provider_id   text null check (char_length(provider_id) <= 200),
  page_url      text null check (char_length(page_url) <= 2000 and page_url ~ '^https://'),
  thumb_url     text null check (char_length(thumb_url) <= 2000 and thumb_url ~ '^https://'),
  creator       text null check (char_length(creator) <= 200),
  creator_url   text null check (char_length(creator_url) <= 2000 and creator_url ~ '^https://'),
  source_name   text null check (char_length(source_name) <= 100),
  license       text null check (char_length(license) <= 100),
  license_url   text null check (char_length(license_url) <= 2000 and license_url ~ '^https://'),
  attribution   text null check (char_length(attribution) <= 500),
  -- is the original page still reachable? Set by a future link check, never guessed.
  source_status text null check (source_status in ('ok', 'unavailable')),
  created_at    timestamptz not null default now(),
  unique (id, studio_id),
  foreign key (parent_id, studio_id) references public.images (id, studio_id) on delete set null (parent_id),

  -- A web image: link + credit, no file. Upload / generated: a file, and NO
  -- credit or source at all — a generated image must never look "found" (AGENTS 7).
  constraint images_kind_shape check (
    case kind
      when 'web' then storage_path is null and page_url is not null and thumb_url is not null
                      and nullif(btrim(attribution), '') is not null and nullif(btrim(source_name), '') is not null
      else storage_path is not null
           and provider is null and provider_id is null and page_url is null and thumb_url is null
           and creator is null and creator_url is null and source_name is null
           and license is null and license_url is null and attribution is null and source_status is null
    end),
  constraint images_path_shape check (storage_path is null or storage_path ~
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webp|jpg)$'),
  constraint images_path_studio check (storage_path is null or split_part(storage_path, '/', 1) = studio_id::text),
  constraint images_no_self_parent check (parent_id is distinct from id)
);
create index images_studio_idx on public.images (studio_id, created_at desc);
create index images_owner_idx on public.images (owner_id);
create index images_parent_idx on public.images (parent_id) where parent_id is not null;
-- the same web picture is saved once per studio
create unique index images_web_once on public.images (studio_id, provider, provider_id)
  where kind = 'web' and provider_id is not null;

-- ------------------------------------------------------------- collections
create table public.collections (
  id          uuid primary key default gen_random_uuid(),
  studio_id   uuid not null references public.studios (id) on delete cascade,
  owner_id    uuid not null references auth.users (id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 1 and 40),
  is_default  boolean not null default false,
  shared      boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (id, studio_id)
);
create index collections_studio_idx on public.collections (studio_id);
-- one default collection per owner per studio
create unique index collections_one_default on public.collections (studio_id, owner_id) where is_default;

-- Composite keys: an image can only go into a collection of its own studio.
create table public.collection_items (
  collection_id  uuid not null,
  image_id       uuid not null,
  studio_id      uuid not null,
  added_at       timestamptz not null default now(),
  primary key (collection_id, image_id),
  foreign key (collection_id, studio_id) references public.collections (id, studio_id) on delete cascade,
  foreign key (image_id, studio_id) references public.images (id, studio_id) on delete cascade
);
create index collection_items_image_idx on public.collection_items (image_id);

-- ---------------------------------------------- ratings + private notes
-- One row per person per image. Visible only to its author (0005).
create table public.reactions (
  image_id    uuid not null references public.images (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  studio_id   uuid not null references public.studios (id) on delete cascade,
  rating      public.image_rating null,
  note        text null check (char_length(note) <= 500),
  updated_at  timestamptz not null default now(),
  primary key (image_id, user_id)
);

-- ------------------------------------------------------ family comments
create table public.comments (
  id          uuid primary key default gen_random_uuid(),
  image_id    uuid not null references public.images (id) on delete cascade,
  studio_id   uuid not null references public.studios (id) on delete cascade,
  author_id   uuid not null references auth.users (id) on delete cascade,
  body        text not null check (char_length(btrim(body)) between 1 and 500),
  created_at  timestamptz not null default now()
);
create index comments_image_idx on public.comments (image_id, created_at);

-- ---------------------------------------------------- the suggestion box
create table public.suggestions (
  id          uuid primary key default gen_random_uuid(),
  studio_id   uuid not null references public.studios (id) on delete cascade,
  sender_id   uuid null references auth.users (id) on delete set null,
  -- null once the painter deleted it (the file and the image are gone)
  image_id    uuid null unique references public.images (id) on delete set null,
  message     text null check (char_length(message) <= 300),
  status      public.suggestion_status not null default 'pending',
  seen_at     timestamptz null,               -- the painter opened the box ("new" marker)
  decided_at  timestamptz null,
  created_at  timestamptz not null default now(),
  constraint suggestions_deleted_no_image check (status <> 'deleted' or image_id is null),
  constraint suggestions_live_has_image check (status = 'deleted' or image_id is not null)
);
create index suggestions_studio_idx on public.suggestions (studio_id, status, created_at desc);
create index suggestions_sender_idx on public.suggestions (sender_id, created_at desc);

-- ------------------------------------------------ default collection
-- Every painter gets "השמורים שלי" as soon as she joins a studio.
create function public.ensure_default_collection(p_studio uuid, p_owner uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  select id into v_id from public.collections where studio_id = p_studio and owner_id = p_owner and is_default;
  if v_id is null then
    insert into public.collections (studio_id, owner_id, name, is_default)
    values (p_studio, p_owner, 'השמורים שלי', true)
    on conflict do nothing
    returning id into v_id;
    if v_id is null then
      select id into v_id from public.collections where studio_id = p_studio and owner_id = p_owner and is_default;
    end if;
  end if;
  return v_id;
end $$;

create function public.tg_painter_default_collection() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.role = 'painter' then
    perform public.ensure_default_collection(new.studio_id, new.user_id);
  end if;
  return new;
end $$;

create trigger studio_members_default_collection
  after insert or update of role on public.studio_members
  for each row execute function public.tg_painter_default_collection();

-- painters who joined before this migration
select public.ensure_default_collection(m.studio_id, m.user_id)
  from public.studio_members m where m.role = 'painter';
