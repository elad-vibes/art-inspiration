// RLS proofs for phase 2 (part b): hiding web pictures, deleting for real, the small
// "deleted" index, the admin's minimal view, and the cleanup queue (migration 0008).
// Studio A: painter + "sender" (send only) + "viewer" (view + comment) + "looker" (view only).
// Studio B: another painter. Studio C: created below for the admin's numbers.
// Every rule is proven from the NEGATIVE side too: who must NOT see it or do it.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, as, createTestDb, S, seed, TestDb, U } from "./harness";

let db: TestDb;
const looker = { role: "authenticated", uid: U.newbie } as Actor;                    // view only
const UC = "00000000-0000-4000-8000-00000000f001";                                    // painter of studio C
const painterC = { role: "authenticated", uid: UC } as Actor;
const SC = "00000000-0000-4000-8000-0000000000cc";
const notPainterA = () => [as.sender, as.viewer, looker, as.painterB, as.outsider, as.admin, as.admin1];

const path = (studio: string, uid: string, ext = "webp") => `${studio}/${uid}/${randomUUID()}.${ext}`;
const INSERT_OBJ = `insert into storage.objects (bucket_id, name, owner, owner_id, metadata) values ('images', $1, $2::uuid, $3, $4::jsonb)`;
const upload = (a: Actor, p: string, size: number | null = null) =>
  db.as(a, INSERT_OBJ, [p, a.uid, a.uid, size === null ? null : JSON.stringify({ size })]);
const canReadFile = async (a: Actor, p: string) =>
  (await db.as(a, `select 1 from storage.objects where bucket_id = 'images' and name = $1`, [p])).rows.length === 1;
const sees = async (a: Actor, image: string) =>
  (await db.as(a, `select 1 from public.images where id = $1`, [image])).rows.length === 1;
const one = async (a: Actor, q: string, p: unknown[] = []) => (await db.as(a, q, p)).rows[0];
const rows = async (a: Actor, q: string, p: unknown[] = []) => (await db.as(a, q, p)).rows;
const ids = async (a: Actor, q: string, p: unknown[] = []) => (await db.as(a, q, p)).rows.map((r) => r.id);
const count = async (q: string, p: unknown[] = []) => (await db.sql(q, p)).length;

async function painterUpload(studio = S.A, a: Actor = as.painter, size: number | null = null) {
  const p = path(studio, a.uid!);
  await upload(a, p, size);
  const id = (await one(a, `select public.add_upload($1, $2) as id`, [studio, p])).id as string;
  return { id, path: p };
}
async function suggest(a: Actor, message: string | null = "תראי איזה יפה") {
  const p = path(S.A, a.uid!);
  await upload(a, p);
  const sid = (await one(a, `select public.send_suggestion($1, $2, $3) as id`, [S.A, p, message])).id as string;
  const img = (await db.sql(`select image_id from public.suggestions where id = $1`, [sid]))[0].image_id as string;
  return { sid, img, path: p };
}
let n = 0;
const webSrc = (extra: object = {}) => JSON.stringify({
  provider: "openverse", provider_id: `w-${++n}`, page_url: "https://example.test/p", thumb_url: "https://example.test/t.jpg",
  creator: "צלם בדוי", source_name: "Openverse", license: "CC BY 4.0", attribution: "תמונה בדויה, צלם בדוי",
  ...extra,
});
const webImage = async (src = webSrc()) => (await one(as.painter, `select public.save_web_image($1, $2::jsonb) as id`, [S.A, src])).id as string;
const defaultCollection = async (studio = S.A) =>
  (await db.sql(`select id from public.collections where studio_id = $1 and is_default`, [studio]))[0].id as string;
const del = (a: Actor, image: string) => one(a, `select public.delete_image($1) as p`, [image]).then((r) => r.p as string | null);
const svc = (q: string, p: unknown[] = []) => db.as(as.service, q, p);
const backdate = (path_: string, col: "queued_at" | "last_attempt_at", interval: string) =>
  db.sql(`update public.storage_cleanup set ${col} = now() - interval '${interval}' where path = $1`, [path_]);

beforeAll(async () => {
  db = await createTestDb();
  await seed(db);
  await db.sql(`
    insert into public.studio_members (studio_id, user_id, role, can_send, can_view, can_comment, can_generate) values
      ('${S.A}', '${U.newbie}', 'family', false, true, false, false);
    insert into auth.users (id, email) values ('${UC}', 'painter.c@example.test');
    insert into public.studios (id, name) values ('${SC}', 'סטודיו שלישי');
    insert into public.studio_members (studio_id, user_id, role, can_send, can_view, can_comment, can_generate) values
      ('${SC}', '${UC}', 'painter', true, true, true, true);
    insert into public.profiles (user_id, display_name) values ('${UC}', 'ציירת שלישית');`);
});
afterAll(async () => { await db?.close(); });

// ============================================================ web: hide only
describe("a web picture is hidden, not deleted — and can be restored", () => {
  let w: string;
  let collection: string;
  beforeAll(async () => {
    w = await webImage();
    collection = await defaultCollection();
    await db.as(as.painter, `select public.set_reaction($1, 'like', 'לצייר בגווני כחול')`, [w]);
    await db.as(as.painter, `select public.set_image_shared($1, true)`, [w]);
    await db.as(as.viewer, `select public.add_comment($1, 'יפה')`, [w]);
  });

  it("shared web picture: the family sees it before, and not at all after it is hidden", async () => {
    expect(await sees(as.viewer, w)).toBe(true);
    expect(await ids(as.viewer, `select id from public.gallery($1)`, [S.A])).toContain(w);
    const cleanupBefore = await count(`select 1 from public.storage_cleanup`);

    expect(await del(as.painter, w)).toBeNull();                                  // no file → nothing to remove

    const r = (await db.sql(`select deleted_at, shared, page_url, creator, attribution, source_name from public.images where id = $1`, [w]))[0];
    expect(r.deleted_at).not.toBeNull();
    expect(r.shared).toBe(false);                                                 // it will come back private
    expect(r).toMatchObject({ page_url: "https://example.test/p", creator: "צלם בדוי", source_name: "Openverse" });  // link + credit stay
    expect(await count(`select 1 from public.storage_cleanup`)).toBe(cleanupBefore);   // no storage, no cleanup
    expect(await count(`select 1 from public.deleted_index where id = $1`, [w])).toBe(0);  // not "deleted for real"

    for (const a of [as.viewer, looker]) {
      expect(await sees(a, w), `row as ${a.uid}`).toBe(false);
      expect(await ids(a, `select id from public.gallery($1)`, [S.A]), `gallery as ${a.uid}`).not.toContain(w);
      expect((await db.as(a, `select * from public.comments where image_id = $1`, [w])).rows, `comments as ${a.uid}`).toHaveLength(0);
      expect((await db.as(a, `select * from public.image_comments($1)`, [w])).rows).toHaveLength(0);
      expect((await db.as(a, `select * from public.deleted_list($1)`, [S.A])).rows).toHaveLength(0);
    }
    expect(await db.fails(as.viewer, `select public.add_comment($1, 'עוד')`, [w])).toMatch(/not_found/);
  });

  it("a picture that sits in a SHARED collection disappears for the family too when hidden", async () => {
    const shared = (await one(as.painter, `select public.create_collection($1, 'משותף') as id`, [S.A])).id as string;
    await db.as(as.painter, `select public.set_collection_shared($1, true)`, [shared]);
    const x = await webImage();
    await db.as(as.painter, `select public.save_to_collection($1, $2)`, [x, shared]);
    expect(await sees(as.viewer, x)).toBe(true);                                  // visible through the shared collection alone
    await del(as.painter, x);
    expect(await sees(as.viewer, x)).toBe(false);
    expect(await ids(as.viewer, `select id from public.gallery($1)`, [S.A])).not.toContain(x);
    expect((await one(as.viewer, `select items from public.collections_list($1) where id = $2`, [S.A, shared])).items).toBe(0);
    expect(await db.fails(as.viewer, `select public.add_comment($1, 'שלום')`, [x])).toMatch(/not_found/);
    await db.as(as.painter, `select public.restore_image($1)`, [x]);
    expect(await sees(as.viewer, x)).toBe(true);                                  // her shared collection still holds it
  });

  it("gone from her gallery and the collection counts, kept in the 'deleted' list with its credit", async () => {
    expect(await ids(as.painter, `select id from public.gallery($1)`, [S.A])).not.toContain(w);
    expect(await ids(as.painter, `select id from public.gallery($1, $2)`, [S.A, collection])).not.toContain(w);
    const c = await one(as.painter, `select items from public.collections_list($1) where id = $2`, [S.A, collection]);
    const live = (await db.sql(`select count(*)::int as n from public.collection_items ci join public.images i on i.id = ci.image_id
                                 where ci.collection_id = $1 and i.deleted_at is null`, [collection]))[0].n;
    expect(c.items).toBe(live);
    const item = await one(as.painter, `select * from public.deleted_list($1) where id = $2`, [S.A, w]);
    expect(item).toMatchObject({ origin: "web", restorable: true, thumb_url: "https://example.test/t.jpg", creator: "צלם בדוי", source_name: "Openverse" });
    expect(await sees(as.painter, w)).toBe(true);                                 // she still owns the record
  });

  it("her note, rating and the family's comments are kept while hidden", async () => {
    expect(await count(`select 1 from public.reactions where image_id = $1 and rating = 'like' and note is not null`, [w])).toBe(1);
    expect(await count(`select 1 from public.comments where image_id = $1`, [w])).toBe(1);
  });

  it("a hidden picture can't be acted on, hidden twice, shared or saved to a collection", async () => {
    for (const q of [`select public.delete_image($1)`, `select public.set_image_shared($1, true)`,
      `select public.set_reaction($1, 'like', null)`, `select public.save_to_collection($1, null)`, `select public.add_comment($1, 'x')`]) {
      expect(await db.fails(as.painter, q, [w]), q).toMatch(/not_found/);
    }
  });

  it("restore: one call by the painter; it returns private, with the note and rating", async () => {
    await db.as(as.painter, `select public.restore_image($1)`, [w]);
    expect(await ids(as.painter, `select id from public.gallery($1)`, [S.A])).toContain(w);
    expect(await ids(as.painter, `select id from public.gallery($1, $2)`, [S.A, collection])).toContain(w);
    expect(await one(as.painter, `select shared, family_can_see, my_rating, my_note from public.gallery($1) where id = $2`, [S.A, w]))
      .toEqual({ shared: false, family_can_see: false, my_rating: "like", my_note: "לצייר בגווני כחול" });
    for (const a of [as.viewer, looker]) expect(await sees(a, w)).toBe(false);   // not re-shared silently
    expect(await ids(as.painter, `select id from public.deleted_list($1)`, [S.A])).not.toContain(w);
  });

  it("only the owner can restore: family, other studios, outsiders, the admin and anon can't", async () => {
    await del(as.painter, w);
    for (const a of [as.sender, as.viewer, looker, as.painterB, as.outsider, as.admin, as.admin1]) {
      expect(await db.fails(a, `select public.restore_image($1)`, [w]), `restore as ${a.uid}/${a.aal}`).toMatch(/not_found/);
    }
    expect(await db.fails(as.anon, `select public.restore_image($1)`, [w])).toMatch(/permission denied/);
    expect((await db.sql(`select deleted_at from public.images where id = $1`, [w]))[0].deleted_at).not.toBeNull();
  });

  it("restore fails closed for everything that is not a hidden web picture", async () => {
    const live = await webImage();
    const up = await painterUpload();
    const gone = await painterUpload();
    await del(as.painter, gone.id);                                               // deleted for real: only an index row remains
    for (const [what, id] of [["a live web picture", live], ["a live upload", up.id], ["a really deleted upload", gone.id], ["nothing", randomUUID()]] as const) {
      expect(await db.fails(as.painter, `select public.restore_image($1)`, [id]), what).toMatch(/not_found/);
    }
    expect(await sees(as.painter, up.id)).toBe(true);
    expect(await count(`select 1 from public.deleted_index where id = $1`, [gone.id])).toBe(1);   // still deleted
    await db.as(as.painter, `select public.restore_image($1)`, [w]);
  });

  it("saving the same web picture again brings it back instead of duplicating it", async () => {
    const src = webSrc();
    const id = await webImage(src);
    await del(as.painter, id);
    expect(await ids(as.painter, `select id from public.gallery($1)`, [S.A])).not.toContain(id);
    expect(await webImage(src)).toBe(id);
    expect(await ids(as.painter, `select id from public.gallery($1)`, [S.A])).toContain(id);
    expect(await count(`select 1 from public.images where provider_id = $1`, [JSON.parse(src).provider_id])).toBe(1);
  });

  it("CHECK: only a web picture can be marked hidden — a row with a file never is", async () => {
    const up = await painterUpload();
    await expect(db.sql(`update public.images set deleted_at = now() where id = $1`, [up.id])).rejects.toThrow(/images_hidden_web_only/);
  });
});

// ============================================================ real deletes
describe("an uploaded / family / generated picture is deleted for real", () => {
  it("upload: file queued for removal, everything on it gone, one small index row stays", async () => {
    const img = await painterUpload(S.A, as.painter, 4321);
    const created = (await db.sql(`select created_at, size_bytes from public.images where id = $1`, [img.id]))[0];
    expect(Number(created.size_bytes)).toBe(4321);                                // recorded by the server from Storage
    await db.as(as.painter, `select public.set_reaction($1, 'like', 'הערה פרטית')`, [img.id]);
    await db.as(as.painter, `select public.set_image_shared($1, true)`, [img.id]);
    await db.as(as.viewer, `select public.add_comment($1, 'תגובה')`, [img.id]);

    expect(await del(as.painter, img.id)).toBe(img.path);

    expect(await count(`select 1 from public.images where id = $1`, [img.id])).toBe(0);
    for (const t of ["collection_items", "reactions", "comments"]) {
      expect(await count(`select 1 from public.${t} where image_id = $1`, [img.id]), t).toBe(0);
    }
    const idx = (await db.sql(`select * from public.deleted_index where id = $1`, [img.id]))[0];
    expect(idx).toMatchObject({ id: img.id, studio_id: S.A, origin: "upload", sender_id: null });
    expect(new Date(idx.uploaded_at).getTime()).toBe(new Date(created.created_at).getTime());
    expect(idx.deleted_at).not.toBeNull();
    expect(await count(`select 1 from public.storage_cleanup where path = $1 and studio_id = $2`, [img.path, S.A])).toBe(1);
    for (const a of [as.painter, as.sender, as.viewer, looker, as.painterB, as.outsider, as.admin]) {
      expect(await canReadFile(a, img.path), `read as ${a.uid}`).toBe(false);
    }
    expect(await one(as.painter, `select origin, restorable, thumb_url, page_url, creator from public.deleted_list($1) where id = $2`, [S.A, img.id]))
      .toEqual({ origin: "upload", restorable: false, thumb_url: null, page_url: null, creator: null });
  });

  it("the index holds no picture, thumbnail, note, message, file name or path — the columns are exactly these", async () => {
    const cols = (await db.sql(`select column_name from information_schema.columns
                                 where table_schema = 'public' and table_name = 'deleted_index' order by 1`)).map((r) => r.column_name);
    expect(cols).toEqual(["deleted_at", "id", "origin", "sender_id", "studio_id", "uploaded_at"]);
  });

  it("a family suggestion: the sender is kept in the index; the picture and their caption are not", async () => {
    const s = await suggest(as.sender, "הודעה פרטית של השולח");
    await db.as(as.painter, `select public.decide_suggestion($1, 'accept')`, [s.sid]);
    await db.as(as.painter, `select public.set_reaction($1, 'not_suitable', 'לא מתאים לי')`, [s.img]);
    expect(await del(as.painter, s.img)).toBe(s.path);
    expect(await db.sql(`select origin, sender_id from public.deleted_index where id = $1`, [s.img]))
      .toEqual([{ origin: "suggestion", sender_id: U.sender }]);
    expect((await db.sql(`select status, image_id, message from public.suggestions where id = $1`, [s.sid]))[0])
      .toEqual({ status: "deleted", image_id: null, message: null });
    expect(await one(as.sender, `select status, storage_path, message from public.my_suggestions($1) where id = $2`, [S.A, s.sid]))
      .toEqual({ status: "deleted", storage_path: null, message: null });
    expect(await one(as.painter, `select origin, sender_name from public.deleted_list($1) where id = $2`, [S.A, s.img]))
      .toMatchObject({ origin: "suggestion", sender_name: expect.any(String) });
    expect(await count(`select 1 from public.reactions where image_id = $1`, [s.img])).toBe(0);
  });

  it("deleting a waiting suggestion from the box works the same way", async () => {
    const s = await suggest(as.sender, "עוד אחת");
    expect(await one(as.painter, `select public.decide_suggestion($1, 'delete') as p`, [s.sid]).then((r) => r.p)).toBe(s.path);
    expect(await count(`select 1 from public.deleted_index where id = $1 and origin = 'suggestion'`, [s.img])).toBe(1);
    expect(await count(`select 1 from public.storage_cleanup where path = $1`, [s.path])).toBe(1);
  });

  it("a generated picture is deleted for real too, and a version keeps working when its source is deleted", async () => {
    const src = await painterUpload();
    const gp = path(S.A, U.painter);
    const [{ id: g }] = await db.sql(`insert into public.images (studio_id, owner_id, kind, storage_path, parent_id) values ($1, $2, 'generated', $3, $4) returning id`,
      [S.A, U.painter, gp, src.id]);
    await del(as.painter, src.id);
    expect((await db.sql(`select parent_id from public.images where id = $1`, [g]))[0].parent_id).toBeNull();
    expect(await del(as.painter, g)).toBe(gp);
    expect(await db.sql(`select origin, sender_id from public.deleted_index where id = $1`, [g])).toEqual([{ origin: "generated", sender_id: null }]);
  });

  it("a second delete is refused and adds nothing", async () => {
    const img = await painterUpload();
    await del(as.painter, img.id);
    expect(await db.fails(as.painter, `select public.delete_image($1)`, [img.id])).toMatch(/not_found/);
    expect(await count(`select 1 from public.deleted_index where id = $1`, [img.id])).toBe(1);
    expect(await count(`select 1 from public.storage_cleanup where path = $1`, [img.path])).toBe(1);
  });

  it("a file waiting for removal can't be registered again as a new picture", async () => {
    const s = await suggest(as.sender, null);
    await del(as.painter, s.img);
    expect(await db.fails(as.sender, `select public.send_suggestion($1, $2, null)`, [S.A, s.path])).toMatch(/bad_path/);
    expect(await count(`select 1 from public.images where storage_path = $1`, [s.path])).toBe(0);
  });

  it("NOBODY else can delete it — not the family member who uploaded it, not another studio, not the admin, not anon", async () => {
    const mine = await painterUpload();
    const fam = await suggest(as.sender, "שלי");
    await db.as(as.painter, `select public.decide_suggestion($1, 'accept')`, [fam.sid]);
    const web = await webImage();
    const who = [as.sender, as.viewer, looker, as.painterB, as.outsider, as.admin, as.admin1];
    for (const id of [mine.id, fam.img, web]) {
      for (const a of who) {
        expect(await db.fails(a, `select public.delete_image($1)`, [id]), `delete ${id} as ${a.uid}/${a.aal}`).toMatch(/not_found/);
      }
      expect(await db.fails(as.anon, `select public.delete_image($1)`, [id])).toMatch(/permission denied/);
    }
    // deleting through the suggestion box is the painter's too — including the sender of that very picture
    const waiting = await suggest(as.sender, null);
    for (const a of who) expect(await db.fails(a, `select public.decide_suggestion($1, 'delete')`, [waiting.sid]), `decide as ${a.uid}`).toMatch(/not_found/);
    // ...and the internal function is not callable from the app at all
    for (const a of [as.painter, as.sender, as.viewer, as.admin, as.anon]) {
      expect(await db.fails(a, `select public.purge_image($1)`, [mine.id]), `purge as ${a.uid ?? "anon"}`).toMatch(/permission denied/);
    }
    for (const id of [mine.id, fam.img, web, waiting.img]) expect(await sees(as.painter, id)).toBe(true);
    expect(await count(`select 1 from public.deleted_index where id = any($1::uuid[])`, [[mine.id, fam.img, web, waiting.img]])).toBe(0);
  });

  it("a session that skipped its second factor can neither delete nor restore", async () => {
    const img = await painterUpload();
    const w = await webImage();
    await del(as.painter, w);
    await db.sql(`insert into auth.mfa_factors (id, user_id, factor_type, status) values (gen_random_uuid(), $1, 'totp', 'verified')`, [U.painter]);
    expect(await db.fails(as.painter, `select public.delete_image($1)`, [img.id])).toMatch(/mfa_required/);
    expect(await db.fails(as.painter, `select public.restore_image($1)`, [w])).toMatch(/mfa_required/);
    expect((await db.as(as.painter, `select * from public.deleted_list($1)`, [S.A])).rows).toHaveLength(0);
    expect((await db.as(as.painter, `select * from public.deleted_index`)).rows).toHaveLength(0);
    expect(await sees({ ...as.painter, aal: "aal2" }, img.id)).toBe(true);
    await db.sql(`delete from auth.mfa_factors where user_id = $1`, [U.painter]);
  });
});

// ============================================================ privacy of the index
describe("the painter's index of deleted pictures is hers alone", () => {
  beforeAll(async () => {
    const b = await painterUpload(S.B, as.painterB);
    await del(as.painterB, b.id);
  });

  it("family, other studios, outsiders and the admin get no index rows — directly or through the list", async () => {
    expect(await count(`select 1 from public.deleted_index where studio_id = $1`, [S.A])).toBeGreaterThan(3);
    for (const a of notPainterA().filter((x) => x !== as.painterB)) {
      expect((await db.as(a, `select * from public.deleted_index`)).rows, `index as ${a.uid}/${a.aal}`).toHaveLength(0);
      expect((await db.as(a, `select * from public.deleted_list($1)`, [S.A])).rows, `list as ${a.uid}/${a.aal}`).toHaveLength(0);
    }
    expect(await db.fails(as.anon, `select * from public.deleted_index`)).toMatch(/permission denied/);
    expect(await db.fails(as.anon, `select * from public.deleted_list($1)`, [S.A])).toMatch(/permission denied/);
  });

  it("studios are separated in both directions", async () => {
    const a = await rows(as.painter, `select studio_id from public.deleted_index`);
    const b = await rows(as.painterB, `select studio_id from public.deleted_index`);
    expect(a.length).toBeGreaterThan(0);
    expect(b).toHaveLength(1);
    expect(new Set(a.map((r) => r.studio_id))).toEqual(new Set([S.A]));
    expect(new Set(b.map((r) => r.studio_id))).toEqual(new Set([S.B]));
    expect((await db.as(as.painterB, `select * from public.deleted_list($1)`, [S.A])).rows).toHaveLength(0);
    expect((await db.as(as.painter, `select * from public.deleted_list($1)`, [S.B])).rows).toHaveLength(0);
  });

  it("nobody writes the index or the queue from the app; nobody reads the queue", async () => {
    const someId = (await db.sql(`select id from public.deleted_index limit 1`))[0].id;
    const writes = [
      `insert into public.deleted_index (id, studio_id, origin, uploaded_at) values (gen_random_uuid(), '${S.A}', 'upload', now())`,
      `update public.deleted_index set origin = 'generated'`, `delete from public.deleted_index`,
      `delete from public.deleted_index where id = '${someId}'`,
      `update public.images set deleted_at = null`, `update public.images set deleted_at = now()`,
      `insert into public.storage_cleanup (path, studio_id) values ('${path(S.A, U.painter)}', '${S.A}')`,
      `delete from public.storage_cleanup`, `select * from public.storage_cleanup`,
    ];
    for (const q of writes) {
      for (const a of [as.painter, as.sender, as.viewer, as.painterB, as.admin]) {
        expect(await db.fails(a, q), `${q} as ${a.uid}`).toMatch(/permission denied/);
      }
      expect(await db.fails(as.anon, q), `${q} as anon`).toMatch(/permission denied/);
    }
  });
});

// ============================================================ the admin's view
describe("the admin sees only counts and the index — never a picture, note, file name or path", () => {
  let big: { id: string; path: string };
  beforeAll(async () => {
    await painterUpload(SC, painterC, 1000);
    big = await painterUpload(SC, painterC, 2500);
    await painterUpload(SC, painterC, null);                                      // Storage gave no size
    const w = (await one(painterC, `select public.save_web_image($1, $2::jsonb) as id`, [SC, webSrc()])).id;
    await one(painterC, `select public.delete_image($1)`, [w]);                   // hidden: not stored, not counted as a file
    await del(painterC, big.id);
  });

  it("per-studio numbers: images, files, estimated size, files without a size, deleted, waiting for cleanup", async () => {
    const r = await one(as.admin, `select * from public.admin_storage_overview() where id = $1`, [SC]);
    expect(r).toMatchObject({ name: "סטודיו שלישי", image_count: 2, file_count: 2, files_no_size: 1, deleted_count: 1, cleanup_pending: 1 });
    expect(Number(r.bytes_est)).toBe(1000);
    const all = await rows(as.admin, `select id from public.admin_storage_overview()`);
    expect(all.map((x) => x.id).sort()).toEqual([S.A, S.B, SC].sort());
  });

  it("the index listing has only kind, sender and dates — and no path or file name anywhere", async () => {
    const list = await rows(as.admin, `select * from public.admin_deleted_index($1)`, [SC]);
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0]).sort()).toEqual(["deleted_at", "id", "origin", "sender_name", "uploaded_at"]);
    expect(JSON.stringify(list)).not.toContain(big.path);
    expect(JSON.stringify(list)).not.toMatch(/\.webp|\.jpg/);
    const fam = await suggest(as.sender, "פרטי");
    await del(as.painter, fam.img);
    const a = await rows(as.admin, `select origin, sender_name from public.admin_deleted_index($1) where id = $2`, [S.A, fam.img]);
    expect(a).toEqual([{ origin: "suggestion", sender_name: expect.any(String) }]);
    expect(JSON.stringify(await rows(as.admin, `select * from public.admin_deleted_index($1)`, [S.A]))).not.toContain("פרטי");
  });

  it("only the admin with two-factor: the painter, family, other studios and anon are refused", async () => {
    for (const q of [`select * from public.admin_storage_overview()`, `select * from public.admin_deleted_index('${SC}')`]) {
      for (const a of [as.admin1, painterC, as.painter, as.sender, as.viewer, as.painterB, as.outsider]) {
        expect(await db.fails(a, q), `${q} as ${a.uid}/${a.aal}`).toMatch(/not_admin/);
      }
      expect(await db.fails(as.anon, q)).toMatch(/permission denied/);
    }
  });

  it("the admin still reads no table that holds content: images, the index, the queue, files", async () => {
    for (const t of ["images", "deleted_index", "reactions", "comments", "suggestions"]) {
      expect((await db.as(as.admin, `select * from public.${t}`)).rows, t).toHaveLength(0);
    }
    expect(await db.fails(as.admin, `select * from public.storage_cleanup`)).toMatch(/permission denied/);
    expect((await db.as(as.admin, `select * from storage.objects`)).rows).toHaveLength(0);
  });
});

// ============================================================ the cleanup queue
describe("no file is left behind: the cleanup queue and its retry", () => {
  it("only server code (service role) can use the queue functions", async () => {
    for (const q of [`select public.svc_cleanup_batch(10)`, `select public.svc_cleanup_done(array['x'])`,
      `select public.svc_cleanup_failed(array['x'], 'e')`, `select public.enqueue_orphan_files()`]) {
      for (const a of [as.painter, as.admin, as.sender, as.anon]) {
        expect(await db.fails(a, q), `${q} as ${a.uid ?? "anon"}`).toMatch(/permission denied/);
      }
      expect(await db.fails(as.service, q)).toBeNull();
    }
  });

  it("a fresh file waits a minute (the immediate removal gets first go), then is handed out", async () => {
    const img = await painterUpload();
    await del(as.painter, img.id);
    expect((await one(as.service, `select public.svc_cleanup_batch(50) as b`)).b).not.toContain(img.path);
    await backdate(img.path, "queued_at", "2 minutes");
    expect((await one(as.service, `select public.svc_cleanup_batch(50) as b`)).b).toContain(img.path);
    expect((await one(as.service, `select public.svc_cleanup_done($1::text[]) as n`, [[img.path]])).n).toBe(1);
    expect(await count(`select 1 from public.storage_cleanup where path = $1`, [img.path])).toBe(0);
  });

  it("a failed removal is marked 'waiting', tried again later, and waits longer after each failure", async () => {
    const img = await painterUpload();
    await del(as.painter, img.id);
    await backdate(img.path, "queued_at", "2 minutes");
    const due = async () => (await one(as.service, `select public.svc_cleanup_batch(50) as b`)).b.includes(img.path);
    expect(await due()).toBe(true);

    await svc(`select public.svc_cleanup_failed($1::text[], 'storage down')`, [[img.path]]);
    let row = (await db.sql(`select attempts, last_error, last_attempt_at from public.storage_cleanup where path = $1`, [img.path]))[0];
    expect(row).toMatchObject({ attempts: 1, last_error: "storage down" });
    expect(await due()).toBe(false);                                              // just failed: not again right away
    await backdate(img.path, "last_attempt_at", "9 minutes");
    expect(await due()).toBe(false);                                              // 1st retry after 10 minutes
    await backdate(img.path, "last_attempt_at", "11 minutes");
    expect(await due()).toBe(true);

    await svc(`select public.svc_cleanup_failed($1::text[], null)`, [[img.path]]);
    row = (await db.sql(`select attempts from public.storage_cleanup where path = $1`, [img.path]))[0];
    expect(row.attempts).toBe(2);
    await backdate(img.path, "last_attempt_at", "11 minutes");
    expect(await due()).toBe(false);                                              // 2nd retry after 20 minutes
    await backdate(img.path, "last_attempt_at", "21 minutes");
    expect(await due()).toBe(true);

    await db.sql(`update public.storage_cleanup set attempts = 50 where path = $1`, [img.path]);
    await backdate(img.path, "last_attempt_at", "25 hours");
    expect(await due()).toBe(true);                                               // never waits more than a day, never gives up
    await svc(`select public.svc_cleanup_done($1::text[])`, [[img.path]]);
  });

  it("orphans: an old file no picture points at is queued; young, in-use and foreign files are not", async () => {
    const young = path(S.A, U.painter);
    const old = path(S.A, U.painter);
    const inUse = await painterUpload();
    const foreign = `readme/${randomUUID()}.webp`;
    for (const p of [young, old, foreign]) await db.sql(INSERT_OBJ, [p, U.painter, U.painter, null]);
    await db.sql(`update storage.objects set created_at = now() - interval '2 days' where name = any($1::text[])`, [[old, foreign, inUse.path]]);
    await svc(`select public.svc_cleanup_batch(50)`);
    const queued = (await db.sql(`select path from public.storage_cleanup`)).map((r) => r.path);
    expect(queued).toContain(old);
    for (const p of [young, foreign, inUse.path]) expect(queued, p).not.toContain(p);
    expect(await canReadFile(as.painter, inUse.path)).toBe(true);
    await db.sql(`delete from public.storage_cleanup where path = $1`, [old]);
  });

  it("the queue never hands out (and drops) a path a picture still uses", async () => {
    const live = await painterUpload();
    await db.sql(`insert into public.storage_cleanup (path, studio_id, queued_at) values ($1, $2, now() - interval '1 hour')`, [live.path, S.A]);
    expect((await one(as.service, `select public.svc_cleanup_batch(50) as b`)).b).not.toContain(live.path);
    expect(await count(`select 1 from public.storage_cleanup where path = $1`, [live.path])).toBe(0);
    expect(await canReadFile(as.painter, live.path)).toBe(true);
  });

  it("the queue only accepts our own path shape (it can never be pointed at another file)", async () => {
    await expect(db.sql(`insert into public.storage_cleanup (path, studio_id) values ('../../etc/passwd', $1)`, [S.A])).rejects.toThrow(/check/);
    await expect(db.sql(`insert into public.storage_cleanup (path, studio_id) values ($1, $2)`, [`${S.A}/x.webp`, S.A])).rejects.toThrow(/check/);
  });

  it("deleting a whole studio queues every file it had, and the studio's index goes with it", async () => {
    const d = "00000000-0000-4000-8000-0000000000dd";
    const ud = "00000000-0000-4000-8000-00000000f002";
    await db.sql(`
      insert into auth.users (id, email) values ('${ud}', 'painter.d@example.test');
      insert into public.studios (id, name) values ('${d}', 'סטודיו לפירוק');
      insert into public.studio_members (studio_id, user_id, role, can_send, can_view, can_comment, can_generate) values ('${d}', '${ud}', 'painter', true, true, true, true);`);
    const pd = { role: "authenticated", uid: ud } as Actor;
    const keep = await painterUpload(d, pd);
    const gone = await painterUpload(d, pd);
    await del(pd, gone.id);
    await db.sql(`delete from public.storage_cleanup where path = $1`, [gone.path]);
    await db.as(as.admin, `select public.admin_delete_studio($1)`, [d]);
    expect(await count(`select 1 from public.images where studio_id = $1`, [d])).toBe(0);
    expect(await count(`select 1 from public.deleted_index where studio_id = $1`, [d])).toBe(0);
    expect((await db.sql(`select path from public.storage_cleanup where studio_id = $1`, [d])).map((r) => r.path)).toEqual([keep.path]);
    await db.sql(`delete from public.storage_cleanup where studio_id = $1`, [d]);
  });
});
