// The delete flow END TO END: the real handlers on top of the real SQL (PGlite, migrations
// 0001–0008) with a fake Storage that can be switched off. Proves what the pieces do
// together: who may delete, that the file goes, that a Storage outage leaves the file
// "waiting for cleanup" (unreadable meanwhile), and that the scheduled retry finishes it.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Deps } from "../../supabase/functions/_shared/deps.ts";
import { createCleanupHandler } from "../../supabase/functions/_shared/handlers/cleanup.ts";
import { createDeleteHandler } from "../../supabase/functions/_shared/handlers/delete.ts";
import { type Actor, as, createTestDb, S, seed, TestDb, U } from "../rls/harness";
import { call, CRON_SECRET, ORIGIN, req } from "./fakes.ts";

let db: TestDb;
let storageDown = false;
const removed: string[] = [];

const TOKENS: Record<string, Actor> = {
  "t-painter": as.painter, "t-sender": as.sender, "t-viewer": as.viewer, "t-painterB": as.painterB,
  "t-admin": as.admin, "t-outsider": as.outsider,
};

/** select public.fn(p_a => $1, ...) as the given actor — like PostgREST does. */
async function rpcAs(a: Actor, fn: string, args: Record<string, unknown>) {
  const keys = Object.keys(args);
  const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}${Array.isArray(args[k]) ? "::text[]" : ""}`).join(", ")}) as r`;
  return (await db.as(a, sql, keys.map((k) => args[k]))).rows[0]?.r;
}

function makeDeps(): Deps {
  return {
    env: { allowedOrigins: [ORIGIN], requireOrigin: true, appUrl: ORIGIN, cronSecret: CRON_SECRET },
    verifyJwt: async (t) => (TOKENS[t] ? { sub: TOKENS[t].uid!, aal: TOKENS[t].aal, role: "authenticated" } : null),
    rpc: (fn, args) => rpcAs(as.service, fn, args),
    userRpc: async (token, fn, args) => {
      try {
        return await rpcAs(TOKENS[token], fn, args);
      } catch (e) {
        throw Object.assign(new Error("user rpc failed"), { code: (e as any).code, pgMessage: (e as Error).message });
      }
    },
    storage: {
      remove: async (paths) => {
        if (storageDown) throw new Error("storage_remove_failed");
        for (const p of paths) {
          await db.sql(`delete from storage.objects where bucket_id = 'images' and name = $1`, [p]);
          removed.push(p);
        }
      },
    },
    admin: { createUser: async () => "created" },
    log: () => undefined,
    now: () => new Date(),
  };
}

const path = (studio: string, uid: string) => `${studio}/${uid}/${randomUUID()}.webp`;
const INSERT_OBJ = `insert into storage.objects (bucket_id, name, owner, owner_id) values ('images', $1, $2::uuid, $3)`;
const fileExists = async (p: string) => (await db.sql(`select 1 from storage.objects where name = $1`, [p])).length === 1;
const canRead = async (a: Actor, p: string) => (await db.as(a, `select 1 from storage.objects where name = $1`, [p])).rows.length === 1;
const queue = (p: string) => db.sql(`select attempts, last_error from public.storage_cleanup where path = $1`, [p]);
const imageExists = async (id: string) => (await db.sql(`select 1 from public.images where id = $1`, [id])).length === 1;

async function upload(a: Actor = as.painter) {
  const p = path(S.A, a.uid!);
  await db.as(a, INSERT_OBJ, [p, a.uid, a.uid]);
  const id = (await db.as(a, `select public.add_upload($1, $2) as id`, [S.A, p])).rows[0].id as string;
  return { id, path: p };
}
async function familyPicture() {
  const p = path(S.A, U.sender);
  await db.as(as.sender, INSERT_OBJ, [p, U.sender, U.sender]);
  const sid = (await db.as(as.sender, `select public.send_suggestion($1, $2, 'שלום') as id`, [S.A, p])).rows[0].id as string;
  const img = (await db.sql(`select image_id from public.suggestions where id = $1`, [sid]))[0].image_id as string;
  return { sid, id: img, path: p };
}

let handler: ReturnType<typeof createDeleteHandler>;
let cleanup: ReturnType<typeof createCleanupHandler>;
const del = (image: string, token = "t-painter") => call(handler, req({ image_id: image }, { token }));
const cron = () => call(cleanup, req({}, { origin: null, headers: { "x-cron-secret": CRON_SECRET } }));

beforeAll(async () => {
  db = await createTestDb();
  await seed(db);
  const deps = makeDeps();
  handler = createDeleteHandler(deps);
  cleanup = createCleanupHandler(deps);
});
afterAll(async () => { await db?.close(); });

describe("delete-image on the real database", () => {
  it("the painter deletes an upload: the picture, its file and its waiting-list row are all gone; one index row stays", async () => {
    const u = await upload();
    const r = await del(u.id);
    expect(r).toMatchObject({ status: 200, body: { ok: true, mode: "deleted", cleanup: "done" } });
    expect(await imageExists(u.id)).toBe(false);
    expect(await fileExists(u.path)).toBe(false);
    expect(await queue(u.path)).toHaveLength(0);
    expect(await db.sql(`select origin from public.deleted_index where id = $1`, [u.id])).toEqual([{ origin: "upload" }]);
  });

  it("a web picture is hidden, not deleted, and comes back with one restore call", async () => {
    const src = { provider: "openverse", provider_id: "e2e-1", page_url: "https://example.test/p", thumb_url: "https://example.test/t.jpg",
      source_name: "Openverse", attribution: "תמונה בדויה" };
    const w = (await db.as(as.painter, `select public.save_web_image($1, $2::jsonb) as id`, [S.A, JSON.stringify(src)])).rows[0].id as string;
    const before = removed.length;
    expect((await del(w)).body).toEqual({ ok: true, mode: "hidden", cleanup: "none" });
    expect(removed).toHaveLength(before);                                          // nothing touched in Storage
    expect((await db.sql(`select deleted_at from public.images where id = $1`, [w]))[0].deleted_at).not.toBeNull();
    await db.as(as.painter, `select public.restore_image($1)`, [w]);
    expect((await db.sql(`select deleted_at from public.images where id = $1`, [w]))[0].deleted_at).toBeNull();
  });

  it("a family member's picture is deleted by the painter — and only by her", async () => {
    const f = await familyPicture();
    for (const t of ["t-sender", "t-viewer", "t-painterB", "t-admin", "t-outsider"]) {
      const r = await del(f.id, t);
      expect(r.status, t).toBe(404);
      expect(r.body.message, t).toMatch(/לא נמצאה/);
    }
    expect((await call(handler, req({ image_id: f.id }))).status).toBe(401);       // no session
    expect(await imageExists(f.id)).toBe(true);
    expect(await fileExists(f.path)).toBe(true);
    expect(await queue(f.path)).toHaveLength(0);

    expect((await del(f.id)).body).toMatchObject({ mode: "deleted", cleanup: "done" });
    expect((await db.sql(`select status, message from public.suggestions where id = $1`, [f.sid]))[0]).toEqual({ status: "deleted", message: null });
    expect(await db.sql(`select origin, sender_id from public.deleted_index where id = $1`, [f.id])).toEqual([{ origin: "suggestion", sender_id: U.sender }]);
  });

  it("deleting the same picture twice: the second is a clear 404 and changes nothing", async () => {
    const u = await upload();
    await del(u.id);
    const again = await del(u.id);
    expect(again.status).toBe(404);
    expect((await db.sql(`select 1 from public.deleted_index where id = $1`, [u.id]))).toHaveLength(1);
  });
});

describe("when Storage is down: 'waiting for cleanup', then the scheduled retry finishes the job", () => {
  it("the picture is deleted at once, the file waits — unreadable to everyone — and is removed by the retry", async () => {
    const u = await upload();
    storageDown = true;
    const r = await del(u.id);
    expect(r).toMatchObject({ status: 200, body: { ok: true, mode: "deleted", cleanup: "pending" } });
    expect(await imageExists(u.id)).toBe(false);                                   // the picture is gone from the app right away
    expect(await fileExists(u.path)).toBe(true);                                   // the file is still in Storage...
    expect(await queue(u.path)).toEqual([{ attempts: 1, last_error: "storage_remove_failed" }]);   // ...marked as waiting
    for (const a of [as.painter, as.sender, as.viewer, as.painterB, as.admin]) {
      expect(await canRead(a, u.path), `read as ${a.uid}`).toBe(false);            // ...and nobody can read it meanwhile
    }

    // the scheduler runs while Storage is still down: it is not due yet (waits longer after each failure)
    expect((await cron()).body).toMatchObject({ ok: true, removed: 0 });
    expect(await fileExists(u.path)).toBe(true);

    // Storage recovers; ten minutes later the retry is due and removes it
    storageDown = false;
    await db.sql(`update public.storage_cleanup set queued_at = now() - interval '1 hour', last_attempt_at = now() - interval '11 minutes' where path = $1`, [u.path]);
    expect((await cron()).body).toEqual({ ok: true, removed: 1, failed: 0 });
    expect(await fileExists(u.path)).toBe(false);
    expect(await queue(u.path)).toHaveLength(0);
  });

  it("a failing scheduled run keeps the file waiting and counts another attempt", async () => {
    const u = await upload();
    storageDown = true;
    await del(u.id);
    await db.sql(`update public.storage_cleanup set queued_at = now() - interval '1 hour', last_attempt_at = now() - interval '11 minutes' where path = $1`, [u.path]);
    expect((await cron()).body).toEqual({ ok: true, removed: 0, failed: 1 });
    expect((await queue(u.path))[0].attempts).toBe(2);
    storageDown = false;
    await db.sql(`update public.storage_cleanup set last_attempt_at = now() - interval '21 minutes' where path = $1`, [u.path]);
    expect((await cron()).body).toMatchObject({ removed: 1 });
    expect(await fileExists(u.path)).toBe(false);
  });

  it("the next delete gives leftovers another go, too", async () => {
    const stuck = await upload();
    storageDown = true;
    await del(stuck.id);
    storageDown = false;
    await db.sql(`update public.storage_cleanup set queued_at = now() - interval '1 hour', last_attempt_at = now() - interval '11 minutes' where path = $1`, [stuck.path]);
    const next = await upload();
    await del(next.id);
    expect(await fileExists(stuck.path)).toBe(false);
    expect(await fileExists(next.path)).toBe(false);
  });

  it("orphans (an upload that never became a picture) are swept up after a day", async () => {
    const orphan = path(S.A, U.painter);
    await db.sql(`insert into storage.objects (bucket_id, name, owner, owner_id, created_at) values ('images', $1, $2::uuid, $2, now() - interval '2 days')`, [orphan, U.painter]);
    expect((await cron()).body).toMatchObject({ removed: 0 });                     // first run only queues it (the one-minute grace)
    expect(await queue(orphan)).toHaveLength(1);
    await db.sql(`update public.storage_cleanup set queued_at = now() - interval '2 minutes' where path = $1`, [orphan]);
    expect((await cron()).body).toMatchObject({ removed: 1 });
    expect(await fileExists(orphan)).toBe(false);
  });

  it("the scheduled run refuses anyone without the secret and touches nothing", async () => {
    const u = await upload();
    storageDown = true;
    await del(u.id);
    storageDown = false;
    await db.sql(`update public.storage_cleanup set queued_at = now() - interval '1 hour', last_attempt_at = null where path = $1`, [u.path]);
    for (const headers of [{} as Record<string, string>, { "x-cron-secret": "wrong" }]) {
      expect((await call(cleanup, req({}, { origin: null, headers }))).status).toBe(401);
    }
    expect((await call(cleanup, req({}, { token: "t-painter" }))).status).toBe(401);
    expect(await fileExists(u.path)).toBe(true);
    await cron();
    expect(await fileExists(u.path)).toBe(false);
  });
});
