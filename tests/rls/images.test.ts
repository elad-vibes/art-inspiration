// RLS proofs for phase 2: images, Storage, collections, suggestions, ratings, comments.
// Studio A: painter + "sender" (send only) + "viewer" (view + comment)
//           + "looker" (view only) + "sender2" (send only, a second sender).
// Studio B: another painter. Plus an outsider, the admin (aal2 and aal1) and anon.
// Every privacy rule is proven from the NEGATIVE side too: who must NOT see it.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, as, createTestDb, S, seed, TestDb, U } from "./harness";

let db: TestDb;
const looker = { role: "authenticated", uid: U.newbie } as Actor;      // view only, no comment
const sender2 = { role: "authenticated", uid: U.newbie2 } as Actor;    // a second sender

/** Everyone who is NOT the painter of studio A. */
const notPainterA = () => [as.sender, as.viewer, looker, sender2, as.painterB, as.outsider, as.admin, as.admin1];
const TABLES = ["images", "collections", "collection_items", "reactions", "comments", "suggestions"];

const path = (studio: string, uid: string, ext = "webp") => `${studio}/${uid}/${randomUUID()}.${ext}`;
const INSERT_OBJ = `insert into storage.objects (bucket_id, name, owner, owner_id) values ('images', $1, $2::uuid, $3)`;
// what the Storage API does on upload: INSERT as the caller, owner = the caller
const upload = (a: Actor, p: string) => db.as(a, INSERT_OBJ, [p, a.uid, a.uid]);
const uploadFails = (a: Actor, p: string) => db.fails(a, INSERT_OBJ, [p, a.uid ?? null, a.uid ?? null]);
const canReadFile = async (a: Actor, p: string) =>
  (await db.as(a, `select 1 from storage.objects where bucket_id = 'images' and name = $1`, [p])).rows.length === 1;
const sees = async (a: Actor, image: string) =>
  (await db.as(a, `select 1 from public.images where id = $1`, [image])).rows.length === 1;
const one = async (a: Actor, q: string, p: unknown[] = []) => (await db.as(a, q, p)).rows[0];
const ids = async (a: Actor, q: string, p: unknown[] = []) => (await db.as(a, q, p)).rows.map((r) => r.id);

async function painterUpload(collection: string | null = null) {
  const p = path(S.A, U.painter);
  await upload(as.painter, p);
  const id = (await one(as.painter, `select public.add_upload($1, $2, $3) as id`, [S.A, p, collection])).id as string;
  return { id, path: p };
}
async function suggest(a: Actor, message: string | null = "תראי איזה יפה") {
  const p = path(S.A, a.uid!);
  await upload(a, p);
  const sid = (await one(a, `select public.send_suggestion($1, $2, $3) as id`, [S.A, p, message])).id as string;
  const img = (await db.sql(`select image_id from public.suggestions where id = $1`, [sid]))[0].image_id as string;
  return { sid, img, path: p };
}
const defaultCollection = async () =>
  (await db.sql(`select id from public.collections where studio_id = $1 and is_default`, [S.A]))[0].id as string;

beforeAll(async () => {
  db = await createTestDb();
  await seed(db);
  await db.sql(`
    insert into public.studio_members (studio_id, user_id, role, can_send, can_view, can_comment, can_generate) values
      ('${S.A}', '${U.newbie}', 'family', false, true, false, false),
      ('${S.A}', '${U.newbie2}', 'family', true, false, false, false);`);
});
afterAll(async () => { await db?.close(); });

describe("schema: a painter always has a default collection", () => {
  it("created for existing painters and for a painter who joins later", async () => {
    const rows = await db.sql(`select studio_id, name from public.collections where is_default order by studio_id`);
    expect(rows.map((r) => r.studio_id)).toEqual([S.A, S.B]);
    expect(rows[0].name).toBe("השמורים שלי");
    const sid = (await one(as.admin, `select public.admin_create_studio('סטודיו שלישי') as id`)).id;
    const t = (await one(as.admin, `select public.admin_create_invite($1, 'painter', true, true, true, true, null) as t`, [sid])).t;
    await db.as(as.outsider, `select public.accept_invite($1)`, [t]);
    expect(await db.sql(`select 1 from public.collections where studio_id = $1 and owner_id = $2 and is_default`, [sid, U.outsider])).toHaveLength(1);
    await db.as(as.admin, `select public.admin_delete_studio($1)`, [sid]);
  });

  it("CHECK: a generated or uploaded image can never carry a credit or a source (AGENTS 7)", async () => {
    const p = path(S.A, U.painter);
    for (const extra of ["attribution", "creator", "page_url", "source_name", "license"]) {
      const v = extra === "page_url" ? "https://example.test/x" : "מישהו";
      for (const kind of ["generated", "upload"]) {
        await expect(db.sql(`insert into public.images (studio_id, owner_id, kind, storage_path, ${extra}) values ($1, $2, $3, $4, $5)`,
          [S.A, U.painter, kind, p, v]), `${kind} + ${extra}`).rejects.toThrow(/images_kind_shape/);
      }
    }
  });

  it("CHECK: a web image needs a link and a credit, and has no file", async () => {
    const [page, thumb, credit, source] = ["https://example.test/page", "https://example.test/t.jpg", "צלם בדוי", "Openverse"];
    const ins = `insert into public.images (studio_id, kind, page_url, thumb_url, attribution, source_name, storage_path) values ($1, 'web', $2, $3, $4, $5, $6)`;
    await expect(db.sql(ins, [S.A, null, thumb, credit, source, null])).rejects.toThrow(/images_kind_shape/);
    await expect(db.sql(ins, [S.A, page, thumb, "  ", source, null])).rejects.toThrow(/images_kind_shape/);
    await expect(db.sql(ins, [S.A, page, thumb, credit, null, null])).rejects.toThrow(/images_kind_shape/);
    await expect(db.sql(ins, [S.A, page, thumb, credit, source, path(S.A, U.painter)])).rejects.toThrow(/images_kind_shape/);
    await expect(db.sql(ins, [S.A, "http://example.test/p", thumb, credit, source, null])).rejects.toThrow(/check/);
  });

  it("CHECK: a file path must sit under the image's own studio; a version's source must be in the same studio", async () => {
    const ins = `insert into public.images (studio_id, owner_id, kind, storage_path) values ($1, $2, 'upload', $3)`;
    await expect(db.sql(ins, [S.A, U.painter, path(S.B, U.painter)])).rejects.toThrow(/images_path_studio/);
    await expect(db.sql(ins, [S.A, U.painter, "x/../y.webp"])).rejects.toThrow(/images_path_shape/);
    const [{ id: bImg }] = await db.sql(`${ins} returning id`, [S.B, U.painterB, path(S.B, U.painterB)]);
    await expect(db.sql(`insert into public.images (studio_id, owner_id, kind, storage_path, parent_id) values ($1, $2, 'generated', $3, $4)`,
      [S.A, U.painter, path(S.A, U.painter), bImg])).rejects.toThrow(/foreign key/);
    await db.sql(`delete from public.images where id = $1`, [bImg]);
  });

  it("a version keeps the link to its source; deleting the source keeps the version", async () => {
    const src = await painterUpload();
    const [{ id: v }] = await db.sql(`insert into public.images (studio_id, owner_id, kind, storage_path, parent_id) values ($1, $2, 'generated', $3, $4) returning id`,
      [S.A, U.painter, path(S.A, U.painter), src.id]);
    expect((await one(as.painter, `select parent_id from public.gallery($1) where id = $2`, [S.A, v])).parent_id).toBe(src.id);
    await db.as(as.painter, `select public.delete_image($1)`, [src.id]);
    expect((await db.sql(`select parent_id from public.images where id = $1`, [v]))[0].parent_id).toBeNull();
    await db.sql(`delete from public.images where id = $1`, [v]);
  });
});

describe("Storage: uploads go only into your own folder, with permission", () => {
  it("the painter and a sender may upload; a viewer, an outsider, another studio, the admin and anon may not", async () => {
    await upload(as.painter, path(S.A, U.painter));
    await upload(as.sender, path(S.A, U.sender, "jpg"));
    expect(await uploadFails(as.viewer, path(S.A, U.viewer))).toMatch(/row-level security/);
    expect(await uploadFails(looker, path(S.A, U.newbie))).toMatch(/row-level security/);
    expect(await uploadFails(as.outsider, path(S.A, U.outsider))).toMatch(/row-level security/);
    expect(await uploadFails(as.painterB, path(S.A, U.painterB))).toMatch(/row-level security/);
    expect(await uploadFails(as.admin, path(S.A, U.admin))).toMatch(/row-level security/);
    expect(await uploadFails(as.anon, path(S.A, U.sender))).toMatch(/row-level security|permission denied/);
  });

  it("nobody writes into someone else's folder, another bucket, or with a strange name", async () => {
    expect(await uploadFails(as.sender, path(S.A, U.painter))).toMatch(/row-level security/);
    expect(await uploadFails(as.painter, path(S.A, U.sender))).toMatch(/row-level security/);
    for (const bad of [`${S.A}/${U.sender}/x.webp`, `${S.A}/${U.sender}/${randomUUID()}.png`, `${S.A}/${U.sender}/../${randomUUID()}.webp`,
      `${U.sender}/${randomUUID()}.webp`, `nonsense/${U.sender}/${randomUUID()}.webp`, `${S.A}/${U.sender}/${randomUUID()}.webp/x`]) {
      expect(await uploadFails(as.sender, bad), bad).toMatch(/row-level security/);
    }
    await db.sql(`insert into storage.buckets (id, name) values ('other', 'other') on conflict do nothing`);
    expect(await db.fails(as.painter, `insert into storage.objects (bucket_id, name, owner, owner_id) values ('other', $1, $2::uuid, $2)`,
      [path(S.A, U.painter), U.painter])).toMatch(/row-level security/);
  });

  it("files are never overwritten (no update policy)", async () => {
    const p = path(S.A, U.painter);
    await upload(as.painter, p);
    const { affected } = await db.as(as.painter, `update storage.objects set name = $2 where name = $1`, [p, path(S.A, U.painter)]);
    expect(affected).toBe(0);
  });
});

describe("the painter's own images are private to her", () => {
  let img: { id: string; path: string };
  beforeAll(async () => {
    img = await painterUpload();
    await db.as(as.painter, `select public.set_reaction($1, 'like', 'לצייר בגווני כחול')`, [img.id]);
  });

  it("the upload lands in her default collection, not shared", async () => {
    const row = (await db.sql(`select kind, shared, owner_id from public.images where id = $1`, [img.id]))[0];
    expect(row).toEqual({ kind: "upload", shared: false, owner_id: U.painter });
    expect(await db.sql(`select 1 from public.collection_items where image_id = $1 and collection_id = $2`, [img.id, await defaultCollection()])).toHaveLength(1);
  });

  it("only she sees the row and the file — not family, other studios, outsiders or the admin", async () => {
    expect(await sees(as.painter, img.id)).toBe(true);
    expect(await canReadFile(as.painter, img.path)).toBe(true);
    for (const a of notPainterA()) {
      expect(await sees(a, img.id), `row as ${a.uid}/${a.aal}`).toBe(false);
      expect(await canReadFile(a, img.path), `file as ${a.uid}/${a.aal}`).toBe(false);
    }
    for (const t of TABLES) expect(await db.fails(as.anon, `select * from public.${t}`), t).toMatch(/permission denied/);
    expect((await db.as(as.anon, `select * from storage.objects`)).rows).toHaveLength(0);
  });

  it("her collections, notes and suggestion box are hers alone", async () => {
    for (const a of notPainterA()) {
      for (const t of TABLES) {
        expect((await db.as(a, `select * from public.${t} where studio_id = $1`, [S.A])).rows, `${t} as ${a.uid}/${a.aal}`).toHaveLength(0);
      }
      for (const f of ["gallery", "collections_list", "inbox"]) {
        expect((await db.as(a, `select * from public.${f}($1)`, [S.A])).rows, `${f} as ${a.uid}/${a.aal}`).toHaveLength(0);
      }
    }
    const mine = await one(as.painter, `select my_rating, my_note from public.gallery($1) where id = $2`, [S.A, img.id]);
    expect(mine).toEqual({ my_rating: "like", my_note: "לצייר בגווני כחול" });
  });

  it("nobody else can act on her image (the same 'not_found' as for a missing one)", async () => {
    const calls = [
      "select public.set_reaction($1, 'like', null)", "select public.set_image_shared($1, true)",
      "select public.delete_image($1)", "select public.save_to_collection($1, null)",
      "select public.add_comment($1, 'שלום')",
    ];
    for (const q of calls) {
      for (const a of [as.sender, as.viewer, as.painterB, as.outsider, as.admin]) {
        expect(await db.fails(a, q, [img.id]), `${q} as ${a.uid}`).toMatch(/not_found/);
      }
      expect(await db.fails(as.painter, q, [randomUUID()]), `${q} missing`).toMatch(/not_found/);
      expect(await db.fails(as.anon, q, [img.id])).toMatch(/permission denied/);
    }
    expect(await sees(as.painter, img.id)).toBe(true);
  });
});

describe("suggestions: seen by the sender and the painter only", () => {
  let s1: Awaited<ReturnType<typeof suggest>>;
  beforeAll(async () => { s1 = await suggest(as.sender); });

  it("a sender sends; it waits in the painter's box, marked new, not in her gallery", async () => {
    const row = await one(as.painter, `select * from public.inbox($1) where id = $2`, [S.A, s1.sid]);
    expect(row).toMatchObject({ status: "pending", is_new: true, message: "תראי איזה יפה", storage_path: s1.path });
    expect(row.sender_name).toBeTruthy();
    expect(await ids(as.painter, `select id from public.gallery($1)`, [S.A])).not.toContain(s1.img);
  });

  it("the sender sees their own image and file; nobody else in the family does", async () => {
    expect(await sees(as.sender, s1.img)).toBe(true);
    expect(await canReadFile(as.sender, s1.path)).toBe(true);
    for (const a of [as.viewer, looker, sender2, as.painterB, as.outsider, as.admin]) {
      expect(await sees(a, s1.img), `row as ${a.uid}`).toBe(false);
      expect(await canReadFile(a, s1.path), `file as ${a.uid}`).toBe(false);
      expect(await ids(a, `select * from public.my_suggestions($1)`, [S.A])).not.toContain(s1.sid);
    }
  });

  it("the sender reads their list only through my_suggestions — never the painter's box", async () => {
    expect((await db.as(as.sender, `select * from public.suggestions`)).rows).toHaveLength(0);
    expect((await db.as(as.sender, `select * from public.inbox($1)`, [S.A])).rows).toHaveLength(0);
    const mine = (await db.as(as.sender, `select * from public.my_suggestions($1)`, [S.A])).rows;
    expect(mine.map((r) => r.id)).toEqual([s1.sid]);
    expect(mine[0]).toMatchObject({ status: "pending", storage_path: s1.path });
    // their image is NOT in the family gallery (it isn't shared)
    expect((await db.as(as.sender, `select id from public.gallery($1)`, [S.A])).rows).toHaveLength(0);
  });

  it("only a family member with 'send' can send, only their own fresh upload, only once", async () => {
    for (const a of [as.viewer, as.painter, as.painterB, as.outsider, as.admin]) {
      const p = path(S.A, a.uid!);
      expect(await db.fails(a, `select public.send_suggestion($1, $2, null)`, [S.A, p]), `as ${a.uid}`).toMatch(/not_allowed/);
    }
    const other = path(S.A, U.newbie2);
    await upload(sender2, other);
    expect(await db.fails(as.sender, `select public.send_suggestion($1, $2, null)`, [S.A, other])).toMatch(/bad_path/);
    expect(await db.fails(as.sender, `select public.send_suggestion($1, $2, null)`, [S.A, path(S.A, U.sender)])).toMatch(/upload_missing/);
    expect(await db.fails(as.sender, `select public.send_suggestion($1, $2, null)`, [S.A, s1.path])).toMatch(/bad_path/);
    expect(await db.fails(as.sender, `select public.send_suggestion($1, $2, null)`, [S.B, path(S.B, U.sender)])).toMatch(/not_allowed/);
    const p = path(S.A, U.sender);
    await upload(as.sender, p);
    expect(await db.fails(as.sender, `select public.send_suggestion($1, $2, $3)`, [S.A, p, "x".repeat(301)])).toMatch(/check/);
    await db.as(as.sender, `delete from storage.objects where name = $1`, [p]); // own unused upload: removable
  });

  it("the family can't decide on suggestions or clear the 'new' marker", async () => {
    for (const a of [as.sender, as.viewer, sender2, as.painterB, as.admin]) {
      for (const act of ["accept", "ignore", "delete"]) {
        expect(await db.fails(a, `select public.decide_suggestion($1, $2)`, [s1.sid, act])).toMatch(/not_found/);
      }
      expect(await db.fails(a, `select public.mark_suggestions_seen($1)`, [S.A])).toMatch(/not_allowed/);
    }
    expect(await db.fails(as.painter, `select public.decide_suggestion($1, 'print')`, [s1.sid])).toMatch(/bad_action/);
  });

  it("opening the box clears 'new' (inside the app only)", async () => {
    expect((await one(as.painter, `select public.mark_suggestions_seen($1) as n`, [S.A])).n).toBeGreaterThanOrEqual(1);
    expect((await one(as.painter, `select is_new from public.inbox($1) where id = $2`, [S.A, s1.sid])).is_new).toBe(false);
  });

  it("a waiting suggestion can't be shared before it is accepted", async () => {
    expect(await db.fails(as.painter, `select public.set_image_shared($1, true)`, [s1.img])).toMatch(/suggestion_pending/);
  });

  it("ignore: stays out of the gallery; the sender still sees 'sent'", async () => {
    await db.as(as.painter, `select public.decide_suggestion($1, 'ignore')`, [s1.sid]);
    expect((await one(as.painter, `select status from public.inbox($1) where id = $2`, [S.A, s1.sid])).status).toBe("ignored");
    expect((await one(as.sender, `select status from public.my_suggestions($1) where id = $2`, [S.A, s1.sid])).status).toBe("pending");
    expect(await ids(as.painter, `select id from public.gallery($1)`, [S.A])).not.toContain(s1.img);
  });

  it("accept & save: into her collection and her gallery, still private", async () => {
    await db.as(as.painter, `select public.decide_suggestion($1, 'accept')`, [s1.sid]);
    expect((await one(as.sender, `select status from public.my_suggestions($1) where id = $2`, [S.A, s1.sid])).status).toBe("accepted");
    expect(await one(as.painter, `select by_me, owner_name from public.gallery($1) where id = $2`, [S.A, s1.img]))
      .toMatchObject({ by_me: false, owner_name: expect.any(String) });
    expect(await db.sql(`select 1 from public.collection_items where image_id = $1 and collection_id = $2`, [s1.img, await defaultCollection()])).toHaveLength(1);
    for (const a of [as.viewer, looker, sender2]) expect(await sees(a, s1.img)).toBe(false);
    expect(await db.fails(as.painter, `select public.decide_suggestion($1, 'delete')`, [s1.sid])).toMatch(/already_decided/);
  });

  it("delete: the image row goes, the sender sees 'deleted', and the file is left to the server's cleanup queue", async () => {
    const s2 = await suggest(as.sender, null);
    const p = (await one(as.painter, `select public.decide_suggestion($1, 'delete') as p`, [s2.sid])).p;
    expect(p).toBe(s2.path);
    expect(await db.sql(`select 1 from public.images where id = $1`, [s2.img])).toHaveLength(0);
    expect(await db.sql(`select status, image_id from public.suggestions where id = $1`, [s2.sid])).toEqual([{ status: "deleted", image_id: null }]);
    expect(await one(as.sender, `select status, storage_path from public.my_suggestions($1) where id = $2`, [S.A, s2.sid]))
      .toEqual({ status: "deleted", storage_path: null });
    // queued for removal: nobody reads it or removes it from the app any more — only the server does (0008)
    for (const a of [as.painter, as.sender, as.viewer, sender2, as.painterB, as.outsider, as.admin]) {
      expect(await canReadFile(a, p), `read as ${a.uid}`).toBe(false);
      expect((await db.as(a, `delete from storage.objects where name = $1`, [p])).affected, `remove as ${a.uid}`).toBe(0);
    }
    expect(await db.sql(`select path from public.storage_cleanup where path = $1`, [p])).toHaveLength(1);
    await db.sql(`delete from storage.objects where name = $1`, [p]);
    await db.sql(`delete from public.storage_cleanup where path = $1`, [p]);
  });

  it("a file an image still uses can't be removed by anyone — not even its uploader or the painter", async () => {
    for (const a of [as.sender, as.painter]) {
      expect((await db.as(a, `delete from storage.objects where name = $1`, [s1.path])).affected).toBe(0);
    }
    expect(await canReadFile(as.painter, s1.path)).toBe(true);
  });

  it("a second sender never sees the first one's suggestions, and vice versa", async () => {
    const s3 = await suggest(sender2, "מהטיול");
    expect(await sees(as.sender, s3.img)).toBe(false);
    expect(await canReadFile(as.sender, s3.path)).toBe(false);
    expect(await sees(sender2, s1.img)).toBe(false);
    expect(await ids(sender2, `select id from public.my_suggestions($1)`, [S.A])).toEqual([s3.sid]);
    await db.as(as.painter, `select public.decide_suggestion($1, 'delete')`, [s3.sid]);
  });

  it("limits: at most 20 suggestions a day per sender", async () => {
    const [{ n }] = await db.sql(`select count(*)::int as n from public.suggestions where sender_id = $1 and created_at > now() - interval '1 day'`, [U.newbie2]);
    for (let i = n; i < 20; i++) await suggest(sender2, null);
    const p = path(S.A, U.newbie2);
    await upload(sender2, p);
    expect(await db.fails(sender2, `select public.send_suggestion($1, $2, null)`, [S.A, p])).toMatch(/too_many_suggestions/);
    await db.sql(`update public.suggestions set created_at = now() - interval '2 days' where sender_id = $1`, [U.newbie2]);
  });
});

describe("sharing: only what the painter chooses, only to people with 'view'", () => {
  let img: { id: string; path: string };
  beforeAll(async () => { img = await painterUpload(); });

  it("sharing an image shows it to viewers — not to send-only members, other studios or the admin", async () => {
    await db.as(as.painter, `select public.set_image_shared($1, true)`, [img.id]);
    for (const a of [as.viewer, looker]) {
      expect(await sees(a, img.id)).toBe(true);
      expect(await canReadFile(a, img.path)).toBe(true);
      expect(await ids(a, `select id from public.gallery($1)`, [S.A])).toContain(img.id);
    }
    for (const a of [as.sender, sender2, as.painterB, as.outsider, as.admin, as.admin1]) {
      expect(await sees(a, img.id), `row as ${a.uid}`).toBe(false);
      expect(await canReadFile(a, img.path), `file as ${a.uid}`).toBe(false);
    }
  });

  it("a viewer sees ONLY the shared image, never her other images", async () => {
    const all = await db.sql(`select count(*)::int as n from public.images where studio_id = $1`, [S.A]);
    expect(all[0].n).toBeGreaterThan(1);
    expect(await ids(as.viewer, `select id from public.images`)).toEqual([img.id]);
  });

  it("her private note and rating stay private even on a shared image", async () => {
    await db.as(as.painter, `select public.set_reaction($1, 'not_suitable', 'סוד קטן')`, [img.id]);
    for (const a of [as.viewer, looker]) {
      expect((await db.as(a, `select * from public.reactions`)).rows).toHaveLength(0);
      expect(await one(a, `select my_rating, my_note from public.gallery($1) where id = $2`, [S.A, img.id])).toEqual({ my_rating: null, my_note: null });
    }
    expect(await db.fails(as.viewer, `select public.set_reaction($1, 'like', 'x')`, [img.id])).toMatch(/not_found/);
    expect(await db.fails(as.painter, `select public.set_reaction($1, 'love', null)`, [img.id])).toMatch(/invalid input value/);
    expect(await db.fails(as.painter, `select public.set_reaction($1, null, $2)`, [img.id, "x".repeat(501)])).toMatch(/check/);
  });

  it("comments: only with 'comment', only on a shared image", async () => {
    const cid = (await one(as.viewer, `select public.add_comment($1, 'איזה צבעים!') as id`, [img.id])).id;
    expect(await db.fails(looker, `select public.add_comment($1, 'x')`, [img.id])).toMatch(/not_allowed/);
    expect(await db.fails(as.sender, `select public.add_comment($1, 'x')`, [img.id])).toMatch(/not_found/);
    expect(await db.fails(as.viewer, `select public.add_comment($1, '   ')`, [img.id])).toMatch(/check/);
    const seen = (await db.as(looker, `select * from public.image_comments($1)`, [img.id])).rows;
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ body: "איזה צבעים!", mine: false });
    expect(seen[0].author_name).toBeTruthy();
    for (const a of [as.sender, as.painterB, as.outsider, as.admin]) {
      expect((await db.as(a, `select * from public.image_comments($1)`, [img.id])).rows, `as ${a.uid}`).toHaveLength(0);
      expect((await db.as(a, `select * from public.comments where studio_id = $1`, [S.A])).rows).toHaveLength(0);
    }
    // only the author or the painter deletes a comment
    expect(await db.fails(looker, `select public.delete_comment($1)`, [cid])).toMatch(/not_found/);
    await db.as(as.painter, `select public.add_comment($1, 'תודה')`, [img.id]);
    await db.as(as.viewer, `select public.delete_comment($1)`, [cid]);
    expect((await db.as(as.painter, `select body from public.image_comments($1)`, [img.id])).rows.map((r) => r.body)).toEqual(["תודה"]);
  });

  it("un-sharing hides the image, its file and its comments again", async () => {
    await db.as(as.painter, `select public.set_image_shared($1, false)`, [img.id]);
    for (const a of [as.viewer, looker]) {
      expect(await sees(a, img.id)).toBe(false);
      expect(await canReadFile(a, img.path)).toBe(false);
      expect((await db.as(a, `select * from public.comments`)).rows).toHaveLength(0);
      expect((await db.as(a, `select * from public.image_comments($1)`, [img.id])).rows).toHaveLength(0);
    }
    expect(await db.fails(as.viewer, `select public.add_comment($1, 'x')`, [img.id])).toMatch(/not_found/);
  });

  it("sharing a collection shows exactly its images; removing or un-sharing hides them", async () => {
    const coll = (await one(as.painter, `select public.create_collection($1, 'פרחים') as id`, [S.A])).id;
    const inside = await painterUpload(coll);
    const outside = await painterUpload();
    expect(await sees(as.viewer, inside.id)).toBe(false);
    await db.as(as.painter, `select public.set_collection_shared($1, true)`, [coll]);
    expect(await sees(as.viewer, inside.id)).toBe(true);
    expect(await canReadFile(as.viewer, inside.path)).toBe(true);
    expect(await sees(as.viewer, outside.id)).toBe(false);
    expect((await db.as(as.viewer, `select id, name, items from public.collections_list($1)`, [S.A])).rows)
      .toEqual([{ id: coll, name: "פרחים", items: 1 }]);
    expect(await ids(as.viewer, `select id from public.gallery($1, $2)`, [S.A, coll])).toEqual([inside.id]);
    // the send-only member and the admin still see nothing
    expect((await db.as(as.sender, `select * from public.collections where studio_id = $1`, [S.A])).rows).toHaveLength(0);
    expect(await sees(as.sender, inside.id)).toBe(false);
    expect((await db.as(as.admin, `select * from public.collections_list($1)`, [S.A])).rows).toHaveLength(0);
    await db.as(as.painter, `select public.remove_from_collection($1, $2)`, [inside.id, coll]);
    expect(await sees(as.viewer, inside.id)).toBe(false);
    await db.as(as.painter, `select public.save_to_collection($1, $2)`, [inside.id, coll]);
    expect(await sees(as.viewer, inside.id)).toBe(true);
    await db.as(as.painter, `select public.set_collection_shared($1, false)`, [coll]);
    expect(await sees(as.viewer, inside.id)).toBe(false);
    expect((await db.as(as.viewer, `select * from public.collections`)).rows).toHaveLength(0);
  });

  it("a viewer who loses 'view' loses everything shared", async () => {
    await db.as(as.painter, `select public.set_image_shared($1, true)`, [img.id]);
    expect(await sees(looker, img.id)).toBe(true);
    await db.as(as.admin, `select public.admin_set_member($1, $2, false, false, false, false)`, [S.A, U.newbie]);
    expect(await sees(looker, img.id)).toBe(false);
    expect(await canReadFile(looker, img.path)).toBe(false);
    expect((await db.as(looker, `select * from public.gallery($1)`, [S.A])).rows).toHaveLength(0);
    await db.as(as.admin, `select public.admin_set_member($1, $2, false, true, false, false)`, [S.A, U.newbie]);
  });
});

describe("collections", () => {
  it("only the painter manages them; the default one can't be deleted", async () => {
    for (const a of [as.sender, as.viewer, as.painterB, as.outsider, as.admin]) {
      expect(await db.fails(a, `select public.create_collection($1, 'x')`, [S.A]), `as ${a.uid}`).toMatch(/not_allowed/);
    }
    const def = await defaultCollection();
    expect(await db.fails(as.painter, `select public.delete_collection($1)`, [def])).toMatch(/default_collection/);
    for (const a of [as.viewer, as.painterB, as.admin]) {
      expect(await db.fails(a, `select public.rename_collection($1, 'x')`, [def])).toMatch(/not_found/);
      expect(await db.fails(a, `select public.set_collection_shared($1, true)`, [def])).toMatch(/not_found/);
      expect(await db.fails(a, `select public.delete_collection($1)`, [def])).toMatch(/not_found/);
    }
    expect(await db.fails(as.painter, `select public.create_collection($1, '   ')`, [S.A])).toMatch(/check/);
    await db.as(as.painter, `select public.rename_collection($1, 'השמורים של סבתא')`, [def]);
  });

  it("an image can't go into another studio's collection", async () => {
    const img = await painterUpload();
    const bColl = (await db.sql(`select id from public.collections where studio_id = $1`, [S.B]))[0].id;
    expect(await db.fails(as.painter, `select public.save_to_collection($1, $2)`, [img.id, bColl])).toMatch(/not_found/);
    expect(await db.fails(as.painter, `select public.add_upload($1, $2, $3)`, [S.A, path(S.A, U.painter), bColl])).toMatch(/upload_missing|not_found/);
    expect(await db.fails(as.painterB, `select public.save_to_collection($1, $2)`, [img.id, bColl])).toMatch(/not_found/);
  });

  it("deleting a collection keeps its images", async () => {
    const coll = (await one(as.painter, `select public.create_collection($1, 'זמני') as id`, [S.A])).id;
    const img = await painterUpload(coll);
    await db.as(as.painter, `select public.delete_collection($1)`, [coll]);
    expect(await ids(as.painter, `select id from public.gallery($1)`, [S.A])).toContain(img.id);
  });
});

describe("web images: details and a link, never a file", () => {
  const src = {
    provider: "openverse", provider_id: "synthetic-1", page_url: "https://example.test/page/1",
    thumb_url: "https://example.test/thumb/1.jpg", creator: "צלם בדוי", creator_url: "https://example.test/u",
    source_name: "Openverse", license: "CC BY 4.0", license_url: "https://example.test/license",
    attribution: "\"שקיעה\" מאת צלם בדוי, CC BY 4.0",
  };

  it("the painter saves one once (a second save reuses it), privately", async () => {
    const id1 = (await one(as.painter, `select public.save_web_image($1, $2::jsonb) as id`, [S.A, JSON.stringify(src)])).id;
    const id2 = (await one(as.painter, `select public.save_web_image($1, $2::jsonb) as id`, [S.A, JSON.stringify(src)])).id;
    expect(id2).toBe(id1);
    const g = await one(as.painter, `select kind, storage_path, creator, source_name, page_url from public.gallery($1) where id = $2`, [S.A, id1]);
    expect(g).toEqual({ kind: "web", storage_path: null, creator: src.creator, source_name: "Openverse", page_url: src.page_url });
    for (const a of notPainterA()) expect(await sees(a, id1)).toBe(false);
  });

  it("family can't save web images into her studio; a missing credit or a non-https link is refused", async () => {
    for (const a of [as.sender, as.viewer, as.painterB, as.admin]) {
      expect(await db.fails(a, `select public.save_web_image($1, $2::jsonb)`, [S.A, JSON.stringify(src)])).toMatch(/not_allowed/);
    }
    expect(await db.fails(as.painter, `select public.save_web_image($1, $2::jsonb)`, [S.A, JSON.stringify({ ...src, provider_id: "2", attribution: "" })])).toMatch(/images_kind_shape/);
    expect(await db.fails(as.painter, `select public.save_web_image($1, $2::jsonb)`, [S.A, JSON.stringify({ ...src, provider_id: "3", page_url: "javascript:alert(1)" })])).toMatch(/check/);
  });
});

describe("delete_image cleans everything that hangs on it", () => {
  it("collections, notes, comments go; the suggestion is marked deleted; the path comes back", async () => {
    const s = await suggest(as.sender, null);
    await db.as(as.painter, `select public.decide_suggestion($1, 'accept')`, [s.sid]);
    await db.as(as.painter, `select public.set_image_shared($1, true)`, [s.img]);
    await db.as(as.painter, `select public.set_reaction($1, 'like', 'x')`, [s.img]);
    await db.as(as.viewer, `select public.add_comment($1, 'יפה')`, [s.img]);
    expect((await one(as.painter, `select public.delete_image($1) as p`, [s.img])).p).toBe(s.path);
    for (const t of ["collection_items", "reactions", "comments"]) {
      expect(await db.sql(`select 1 from public.${t} where image_id = $1`, [s.img]), t).toHaveLength(0);
    }
    expect((await db.sql(`select status from public.suggestions where id = $1`, [s.sid]))[0].status).toBe("deleted");
    expect(await db.sql(`select path from public.storage_cleanup where path = $1`, [s.path])).toHaveLength(1);
    await db.sql(`delete from storage.objects where name = $1`, [s.path]);
    await db.sql(`delete from public.storage_cleanup where path = $1`, [s.path]);
  });
});

describe("fail closed", () => {
  it("nobody writes the new tables directly — every change goes through a checked function", async () => {
    const img = await painterUpload();
    const def = await defaultCollection();
    const writes: [string, unknown[]][] = [
      [`insert into public.images (studio_id, owner_id, kind, storage_path) values ($1, $2, 'upload', $3)`, [S.A, U.painter, path(S.A, U.painter)]],
      [`update public.images set shared = true where id = $1`, [img.id]],
      [`delete from public.images where id = $1`, [img.id]],
      [`insert into public.collections (studio_id, owner_id, name) values ($1, $2, 'x')`, [S.A, U.painter]],
      [`update public.collections set shared = true where id = $1`, [def]],
      [`insert into public.collection_items (collection_id, image_id, studio_id) values ($1, $2, $3)`, [def, img.id, S.A]],
      [`delete from public.collection_items where image_id = $1`, [img.id]],
      [`insert into public.reactions (image_id, user_id, studio_id, rating) values ($1, $2, $3, 'like')`, [img.id, U.painter, S.A]],
      [`insert into public.comments (image_id, studio_id, author_id, body) values ($1, $2, $3, 'x')`, [img.id, S.A, U.painter]],
      [`insert into public.suggestions (studio_id, sender_id, image_id) values ($1, $2, $3)`, [S.A, U.sender, img.id]],
      [`update public.suggestions set status = 'accepted'`, []],
      [`delete from public.suggestions`, []],
    ];
    for (const [q, p] of writes) {
      for (const a of [as.painter, as.sender, as.viewer, as.admin, as.anon]) {
        expect(await db.fails(a, q, p), `${q} as ${a.uid ?? "anon"}`).toMatch(/permission denied/);
      }
    }
  });

  it("a session that skipped its second factor sees and does nothing", async () => {
    const img = await painterUpload();
    await db.sql(`insert into auth.mfa_factors (id, user_id, factor_type, status) values (gen_random_uuid(), $1, 'totp', 'verified')`, [U.painter]);
    expect(await sees(as.painter, img.id)).toBe(false);
    expect(await canReadFile(as.painter, img.path)).toBe(false);
    expect((await db.as(as.painter, `select * from public.gallery($1)`, [S.A])).rows).toHaveLength(0);
    expect((await db.as(as.painter, `select * from public.inbox($1)`, [S.A])).rows).toHaveLength(0);
    expect(await uploadFails(as.painter, path(S.A, U.painter))).toMatch(/row-level security/);
    for (const q of [`select public.set_image_shared($1, true)`, `select public.delete_image($1)`, `select public.set_reaction($1, 'like', null)`]) {
      expect(await db.fails(as.painter, q, [img.id]), q).toMatch(/mfa_required/);
    }
    for (const q of [`select public.create_collection($1, 'x')`, `select * from public.my_suggestions($1)`, `select public.mark_suggestions_seen($1)`]) {
      expect(await db.fails(as.painter, q, [S.A]), q).toMatch(/mfa_required/);
    }
    expect(await sees({ ...as.painter, aal: "aal2" }, img.id)).toBe(true);
    await db.sql(`delete from auth.mfa_factors where user_id = $1`, [U.painter]);
  });

  it("someone removed from the studio loses even what they sent; the painter keeps it", async () => {
    const s = await suggest(sender2, null);
    await db.as(as.admin, `select public.admin_remove_member($1, $2)`, [S.A, U.newbie2]);
    expect(await sees(sender2, s.img)).toBe(false);
    expect(await canReadFile(sender2, s.path)).toBe(false);
    expect((await db.as(sender2, `select * from public.my_suggestions($1)`, [S.A])).rows).toHaveLength(0);
    expect(await uploadFails(sender2, path(S.A, U.newbie2))).toMatch(/row-level security/);
    expect(await sees(as.painter, s.img)).toBe(true);
  });

  it("the admin sees no image content anywhere (only admin RPCs, which carry no images)", async () => {
    for (const t of TABLES) expect((await db.as(as.admin, `select * from public.${t}`)).rows, t).toHaveLength(0);
    expect((await db.as(as.admin, `select * from storage.objects`)).rows).toHaveLength(0);
  });

  it("anon can't call a single function; the browser can call only the listed ones", async () => {
    const callable = async (role: string) => (await db.sql(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and has_function_privilege('${role}', p.oid, 'execute') order by 1`)).map((r) => r.proname);
    expect(await callable("anon")).toEqual([]);
    expect(await callable("authenticated")).toEqual([
      "accept_invite", "add_comment", "add_upload", "admin_create_invite", "admin_create_studio", "admin_delete_studio",
      "admin_deleted_index", "admin_invites", "admin_members", "admin_remove_member", "admin_rename_studio",
      "admin_revoke_invite", "admin_set_member", "admin_storage_overview", "admin_studios", "am_i_admin",
      "can_read_object", "can_remove_object", "can_upload_object",
      "can_view_image", "collections_list", "create_collection", "decide_suggestion", "delete_collection",
      "delete_comment", "delete_image", "deleted_list", "gallery", "has_perm", "image_comments", "inbox", "is_image_shared",
      "is_member", "is_painter", "is_super_admin", "jwt_aal", "local_month", "mark_suggestions_seen", "mfa_ok",
      "my_suggestions", "remove_from_collection", "rename_collection", "restore_image", "save_to_collection", "save_web_image",
      "send_suggestion", "set_collection_shared", "set_image_shared", "set_reaction", "try_uuid",
    ].sort());
  });

  it("the bucket is private, 5MB, webp/jpeg only", async () => {
    expect((await db.sql(`select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'images'`))[0])
      .toEqual({ public: false, file_size_limit: 5242880, allowed_mime_types: ["image/webp", "image/jpeg"] });
  });
});
