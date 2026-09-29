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
- **Not deployed**: no GitHub repo and no Supabase project yet (SETUP.md §1–2, Elad).

## Checks (phase 2)
`npm test` 101 (RLS 71 on PGlite: core 27 + images 44 · functions 10 · unit 20) · `npm run typecheck` ·
`npm run check:functions` · `npm run build` · `npm run scan`. Mutation check: loosening the image, reaction or
Storage read rule makes 11 / 2 / 8 tests fail. Visual check at 390px, light + dark, synthetic data (gallery,
suggestions, empty box, collections, detail sheet, family view, family sheet, offline, error).

## Waiting for Elad
- DECISIONS 14: the limits (20/day, 50 waiting, 100 collections, 5MB, 2048px) and "ignored shows as sent".

## Next: phase 3 — search (Openverse + Commons), credit, save (`save_web_image`), Claude Haiku translation
Add the thumbnail hosts to the CSP `img-src` (no wildcard).

## Known limits
- Remote RLS run (`RLS_TARGET=remote`) needs the `pg` package + a live project — added at deploy time.
- No E2E (Playwright) yet — needs a live Supabase project.
- Storage in tests is a shim (`storage.buckets` / `storage.objects` + our policies). The bucket's size/MIME limits and
  signed URLs are enforced by the real Storage API only — verify on the live project.
- Phone upload (HEIC → canvas → WebP/JPEG) is not yet tested on a real iPhone (phase 9).
