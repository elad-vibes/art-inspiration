# PROGRESS

Resume rule: read this file first, then `ART-PLAN.md`, `DECISIONS.md`, `AGENTS.md`, then `git log`.
Commit messages are in Hebrew (מה שונה · למה · מה נבדק); hooks in `tools-git/` scan every commit.

## Status (2026-09-28)
- **Phase 0 ✅** — spec (`ART-PLAN.md`), decisions 1–12, agent rules, README, SETUP, ASSETS.
- **Phase 1 ✅ (local only)** — skeleton: Vite + TS + PWA, warm RTL design, e-mail code sign-in, invites,
  optional TOTP (required for admin), admin screen. DB `0001_core` · `0002_rls` · `0003_rpc`. Edge Function `invite-signin`.
- **Phase 2 ✅ (local only, branch `claude/phase2-images`)** — images, Storage, RLS, suggestion box (DECISIONS 13–17):
  - DB `0004_images` (images · collections + default "השמורים שלי" · collection_items · reactions · comments ·
    suggestions; CHECK: uploads/generated carry no credit, web images need link + credit; `parent_id` = source → version)
    · `0005_images_rls` (SELECT-only policies, `can_view_image` / `is_image_shared`, mfa_gate)
    · `0006_images_rpc` (every write is a checked function; `gallery` / `inbox` / `collections_list` are INVOKER)
    · `0007_storage` (private bucket `images`, own-folder upload, read only via a visible image row, no overwrite).
  - App: painter tabs (gallery · suggestions with "new" count · collections), detail sheet (like / not suitable /
    private note / collections / share / comments / delete), upload from photos or files (re-encoded in the browser),
    family side (send a photo + message, "what I sent", what was shared + comments), offline / loading / error / empty states.
  - `save_web_image` exists for phase 3 (no network calls, no demo results).
- **Phase 2b ✅ (local only, branch `claude/phase2b-delete-index`, from `claude/phase2-images`)** — deleting + index (DECISIONS 14, 18–20):
  - DB `0008_delete_index`: a web picture is only **hidden** (`images.deleted_at`, restorable, comes back private);
    an upload / family suggestion / generated picture is **deleted for real** (file removed, notes / ratings / comments /
    collection places gone) leaving one small `deleted_index` row (kind, sender, upload + delete dates — no picture, thumbnail,
    note, message or file name). Restore: painter only, hidden web pictures only, fails closed. `images.size_bytes` (from Storage,
    never from the browser). Admin: `admin_storage_overview` (counts, estimated size) and `admin_deleted_index` (kind, sender, dates).
  - Reliable delete: Edge Function `delete-image` calls `delete_image` **as the user** (permission checked in the database),
    then removes the file. The path is queued in `storage_cleanup` in the same transaction ("waiting for cleanup"); on a Storage
    failure the file waits (unreadable, not removable from the app) and `storage-cleanup` (scheduled) + every later delete retry
    with a growing delay. Orphans (upload never registered > 1 day, deleted studio) are swept into the same queue.
  - App: "נמחקו" tab (simple RTL list, "שחזור" only for web pictures, "נמחקה ולא ניתן לשחזר" for the rest), a confirmation sheet
    before every delete that says what will happen (hide vs. delete for good), admin cards "אחסון" + "אינדקס מחיקות".
- **Not deployed**: no GitHub repo and no Supabase project yet (SETUP.md §1–2, Elad).

## Checks (phase 2b)
`npm test` 165 (RLS 104 on PGlite: core 27 + images 44 + delete 33 · functions 36: invite 10 + delete-image / storage-cleanup 17
+ end-to-end on the real SQL 9 · unit 25) · `npm run typecheck` · `npm run check:functions` (3 functions) · `npm run build` ·
`npm run scan`. Mutation check on 0008 (11 rules softened one at a time, every one caught): family sees the index · restore accepts
any image · queued file stays readable · delete skips the owner check · hidden picture still shared · admin overview open to all ·
`purge_image` callable from the app · queued file re-registrable · a file-backed row can be "hidden" · queue hands out an in-use
path · retry backoff removed. Visual check at 390px, light + dark, synthetic data (deleted list, empty list, confirmations for a
web picture / shared web picture / upload / family suggestion / over the picture sheet, admin storage + index).
(Phase 2 mutation check: loosening the image, reaction or Storage read rule makes 11 / 2 / 8 tests fail.)

## Waiting for Elad
- DECISIONS 18, my readings (please confirm or correct): no title column in the index (nothing to fill it with yet) ·
  the sender's caption is deleted with the picture · a hidden web picture that sits in a family-**shared collection** is visible
  to the family again after restore (it comes back private, but the collection membership is kept).
- At deploy: schedule `storage-cleanup` every ~15 minutes (SETUP.md §2) — without it retries happen only after the next delete.

## Next: phase 3 — search (Openverse + Commons), credit, save (`save_web_image`), Claude Haiku translation
Add the thumbnail hosts to the CSP `img-src` (no wildcard).

## Known limits
- Remote RLS run (`RLS_TARGET=remote`) needs the `pg` package + a live project — added at deploy time.
- No E2E (Playwright) yet — needs a live Supabase project.
- Storage in tests is a shim (`storage.buckets` / `storage.objects` + our policies). The bucket's size/MIME limits and
  signed URLs are enforced by the real Storage API only — verify on the live project.
- Phase 2b, verify on the live project: (1) `storage.objects.metadata->>'size'` is really filled by Storage (drives
  `images.size_bytes`; if not, the admin screen shows the files as "no known size", it never guesses); (2) the Edge runtime
  provides `SUPABASE_ANON_KEY` (else set the public `SB_PUBLISHABLE_KEY` secret) for calling `delete_image` as the user;
  (3) `storage.objects.created_at` for the one-day orphan sweep; (4) the scheduled call to `storage-cleanup` works with its secret.
- The deleted list shows a hidden web picture's thumbnail as a hotlink; the CSP `img-src` hosts arrive in phase 3 together
  with web search, so until then no web picture exists to show.
- Phase 2b light-mode admin screenshot after scrolling was unreliable in the preview pane (blank capture); its layout was
  checked in dark mode and its text through the DOM.
- Phone upload (HEIC → canvas → WebP/JPEG) is not yet tested on a real iPhone (phase 9).
