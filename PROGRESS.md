# PROGRESS

Resume rule: read this file first, then `ART-PLAN.md`, `DECISIONS.md`, `AGENTS.md`, then `git log`.
Commit messages are in Hebrew (מה שונה · למה · מה נבדק); hooks in `tools-git/` scan every commit.

## Status (2026-09-28)
- **Phase 0 ✅** — spec (`ART-PLAN.md`), decisions 1–12, agent rules, README, SETUP, ASSETS.
- **Phase 1 ✅ (local only)** — skeleton: Vite + TS + PWA (manifest, SW, palette icon, iOS splash),
  warm RTL design (light + dark), sign-in with e-mail code, invite links, optional TOTP (required for admin),
  admin screen (studios, people, 4 permissions + presets, invite links, revoke, remove).
  DB: `0001_core` · `0002_rls` (RLS + mfa_gate) · `0003_rpc` (accept_invite, admin_*, svc_*).
  Edge Function: `invite-signin`.
- **Not deployed**: no GitHub repo and no Supabase project yet (SETUP.md §1–2, Elad).

## Checks (phase 1)
`npm test` 48 (RLS 27 on PGlite · functions 10 · unit 11) · `npm run typecheck` · `npm run check:functions` (invite-signin) ·
`npm run build` · `npm run scan` · visual check at 390px, light + dark (sign-in, install, invite error, painter home,
family home, menu, admin) with synthetic data.

## Next: phase 2 — images, collections, Storage + RLS (tests first)
Tables `images`, `collections`, `collection_items`, `reactions`; private bucket `images`; `can_view_image()`;
CHECK that generated images carry no credit/source; RLS matrix (painter / sender / viewer / other studio /
outsider / admin / anon) incl. Storage paths. Harness needs a small `storage` schema shim.

## Known limits
- Remote RLS run (`RLS_TARGET=remote`) needs the `pg` package + a live project — added at deploy time.
- No E2E (Playwright) yet — needs a live Supabase project.
