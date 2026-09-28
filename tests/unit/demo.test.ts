// The demo's in-memory database: the rules the real screens rely on (who sees what, hide vs.
// delete, the small index, family suggestions) — all in memory, nothing on a network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DemoDb, DemoError } from "../../src/demo/db.ts";

let db: DemoDb;
const make = () => new DemoDb({ art: (n) => `/art/${n}.svg`, webArt: (n) => `https://demo.example/art/${n}.svg`, blobUrl: () => "blob:local" });
const rows = (who: "mom" | "fam", fn: string, a: Record<string, unknown> = {}) => db.rpc(who, fn, a) as any[];
const ids = (who: "mom" | "fam") => rows(who, "gallery").map((r) => r.id as string);
const byAttr = (who: "mom" | "fam", tag: string) => rows(who, "gallery").find((r) => (r.attribution ?? "").startsWith(tag)) ?? null;
const fails = (fn: () => unknown, msg: RegExp) => { try { fn(); } catch (e) { expect(e).toBeInstanceOf(DemoError); expect((e as Error).message).toMatch(msg); return; } throw new Error("expected an error"); };

beforeEach(() => { db = make(); vi.stubGlobal("fetch", () => { throw new Error("the demo must never touch the network"); }); });
afterEach(() => vi.unstubAllGlobals());

describe("what each role sees", () => {
  it("Mom sees her pictures (not the ones still waiting in the box); web pictures carry a credit and an https thumbnail", () => {
    const g = rows("mom", "gallery");
    expect(g).toHaveLength(7);
    const web = g.filter((r) => r.kind === "web");
    expect(web).toHaveLength(3);
    for (const w of web) {
      expect(w.thumb_url).toMatch(/^https:\/\//);
      expect(w.page_url).toMatch(/^https:\/\//);
      expect(w.attribution).toBeTruthy();
      expect(w.creator).toBeTruthy();
    }
    for (const u of g.filter((r) => r.kind === "upload")) expect([u.creator, u.attribution, u.page_url]).toEqual([null, null, null]);
    expect(rows("mom", "inbox")).toHaveLength(2);
  });

  it("a family member sees only what Mom shared (a picture, or a picture in a shared collection) — never her notes", () => {
    const g = rows("fam", "gallery");
    expect(g).toHaveLength(3);
    for (const r of g) expect([r.my_rating, r.my_note]).toEqual([null, null]);
    expect(rows("fam", "collections_list").map((c) => c.name)).toEqual(["פרחים"]);
    expect(rows("fam", "inbox")).toEqual([]);
  });

  it("the family can't do what only Mom does", () => {
    const some = ids("mom")[0];
    fails(() => db.rpc("fam", "set_reaction", { p_image: some, p_rating: "like" }), /not_found/);
    fails(() => db.rpc("fam", "set_image_shared", { p_image: some, p_shared: true }), /not_found/);
    fails(() => db.rpc("fam", "create_collection", { p_name: "x" }), /not_found/);
    fails(() => db.rpc("fam", "deleted_list"), /not_found/);
    fails(() => db.deleteImage("fam", some), /not_found/);
    fails(() => db.rpc("fam", "restore_image", { p_image: some }), /not_found/);
  });
});

describe("rating, notes, sharing, collections", () => {
  it("rating and note are private to Mom; sharing a picture makes it visible to the family, unsharing hides it", () => {
    const u2 = rows("mom", "gallery").find((r) => r.my_note === "לצייר בגווני כחול").id as string;
    db.rpc("mom", "set_reaction", { p_image: u2, p_rating: "not_suitable", p_note: "  הערה  " });
    const mine = rows("mom", "gallery").find((r) => r.id === u2);
    expect([mine.my_rating, mine.my_note]).toEqual(["not_suitable", "הערה"]);
    expect(ids("fam")).not.toContain(u2);
    db.rpc("mom", "set_image_shared", { p_image: u2, p_shared: true });
    expect(ids("fam")).toContain(u2);
    db.rpc("mom", "set_image_shared", { p_image: u2, p_shared: false });
    expect(ids("fam")).not.toContain(u2);
    db.rpc("mom", "set_reaction", { p_image: u2, p_rating: null, p_note: "" });
    expect(rows("mom", "gallery").find((r) => r.id === u2).my_rating).toBeNull();
  });

  it("collections: create, put a picture in, share (the family sees it), rename, delete — the main one can't be deleted", () => {
    const id = db.rpc("mom", "create_collection", { p_name: " נופים " }) as string;
    const img = byAttr("mom", "סירת מפרש")!.id;
    db.rpc("mom", "save_to_collection", { p_image: img, p_collection: id });
    expect(db.membership(img)).toContain(id);
    expect(ids("fam")).not.toContain(img);
    db.rpc("mom", "set_collection_shared", { p_collection: id, p_shared: true });
    expect(ids("fam")).toContain(img);
    db.rpc("mom", "rename_collection", { p_collection: id, p_name: "ים" });
    expect(rows("mom", "collections_list").find((c) => c.id === id)).toMatchObject({ name: "ים", items: 1, shared: true });
    db.rpc("mom", "delete_collection", { p_collection: id });
    expect(rows("mom", "collections_list").some((c) => c.id === id)).toBe(false);
    const main = rows("mom", "collections_list").find((c) => c.is_default).id;
    fails(() => db.rpc("mom", "delete_collection", { p_collection: main }), /default_collection/);
  });
});

describe("hide a web picture, delete the rest for real", () => {
  it("a web picture is hidden (not deleted): out of the gallery and the family's view, in the 'deleted' list, and restorable", () => {
    const w = byAttr("mom", "אחו עם פרחים")!.id as string;
    expect(ids("fam")).toContain(w);
    expect(db.deleteImage("mom", w)).toEqual({ ok: true, mode: "hidden", cleanup: "none" });
    expect(ids("mom")).not.toContain(w);
    expect(ids("fam")).not.toContain(w);
    const item = rows("mom", "deleted_list").find((r) => r.id === w);
    expect(item).toMatchObject({ origin: "web", restorable: true });
    expect(item.thumb_url).toMatch(/^https:/);
    fails(() => db.deleteImage("mom", w), /not_found/);
    db.rpc("mom", "restore_image", { p_image: w });
    expect(ids("mom")).toContain(w);
    expect(rows("mom", "deleted_list").some((r) => r.id === w)).toBe(false);
  });

  it("an uploaded picture is deleted for real: gone with its note and comments, one small index row stays, no restore", () => {
    const u1 = rows("mom", "gallery").find((r) => r.comment_count === 2).id as string;
    const before = rows("mom", "deleted_list").filter((r) => !r.restorable).length;
    expect(db.deleteImage("mom", u1)).toEqual({ ok: true, mode: "deleted", cleanup: "done" });
    expect(ids("mom")).not.toContain(u1);
    expect(rows("fam", "image_comments", { p_image: u1 })).toEqual([]);
    const after = rows("mom", "deleted_list").filter((r) => !r.restorable);
    expect(after).toHaveLength(before + 1);
    for (const r of after) expect([r.thumb_url, r.page_url, r.creator, r.attribution]).toEqual([null, null, null, null]);
    expect(db.indexRows()).toHaveLength(before + 1);
    expect(Object.keys(db.indexRows()[0]).sort()).toEqual(["deleted_at", "id", "origin", "sender_name", "uploaded_at"]);
    fails(() => db.rpc("mom", "restore_image", { p_image: u1 }), /not_found/);
    fails(() => db.deleteImage("mom", u1), /not_found/);
  });

  it("restoring only works for a hidden web picture", () => {
    const upload = rows("mom", "gallery").find((r) => r.kind === "upload").id;
    const liveWeb = byAttr("mom", "פרגים")!.id;
    fails(() => db.rpc("mom", "restore_image", { p_image: upload }), /not_found/);
    fails(() => db.rpc("mom", "restore_image", { p_image: liveWeb }), /not_found/);
    fails(() => db.rpc("mom", "restore_image", { p_image: "nope" }), /not_found/);
  });
});

describe("family suggestions", () => {
  const send = (msg: string | null = "בדיקה") => {
    db.upload("s/u/photo.webp", new Blob(["x"]));
    return db.rpc("fam", "send_suggestion", { p_path: "s/u/photo.webp", p_message: msg, p_width: 10, p_height: 10 }) as string;
  };

  it("a sent picture waits in Mom's box, marked new and not in the gallery; the sender sees it as sent", () => {
    const sid = send();
    const item = rows("mom", "inbox").find((r) => r.id === sid);
    expect(item).toMatchObject({ status: "pending", is_new: true, message: "בדיקה", sender_name: "מיכל" });
    expect(ids("mom")).not.toContain(item.image_id);
    expect(rows("fam", "my_suggestions").find((r) => r.id === sid).status).toBe("pending");
    expect(db.signedUrl("s/u/photo.webp")).toBe("blob:local");
    fails(() => db.rpc("mom", "set_image_shared", { p_image: item.image_id, p_shared: true }), /suggestion_pending/);
    expect(db.rpc("mom", "mark_suggestions_seen")).toBeGreaterThanOrEqual(1);
    expect(rows("mom", "inbox").find((r) => r.id === sid).is_new).toBe(false);
  });

  it("ignoring shows the sender 'sent' (not 'ignored'); saving puts it in the gallery, still private", () => {
    const sid = send();
    const imageId = rows("mom", "inbox").find((r) => r.id === sid).image_id;
    db.rpc("mom", "decide_suggestion", { p_suggestion: sid, p_action: "ignore" });
    expect(rows("fam", "my_suggestions").find((r) => r.id === sid).status).toBe("pending");
    expect(rows("mom", "inbox").find((r) => r.id === sid).status).toBe("ignored");
    db.rpc("mom", "decide_suggestion", { p_suggestion: sid, p_action: "accept" });
    expect(rows("fam", "my_suggestions").find((r) => r.id === sid).status).toBe("accepted");
    expect(ids("mom")).toContain(imageId);
    expect(ids("fam")).not.toContain(imageId);
    fails(() => db.rpc("mom", "decide_suggestion", { p_suggestion: sid, p_action: "accept" }), /already_decided/);
  });

  it("deleting a suggestion removes the picture and the sender's caption; the sender sees 'removed'; the index keeps the sender", () => {
    const sid = send("שלום");
    const imageId = rows("mom", "inbox").find((r) => r.id === sid).image_id;
    db.deleteImage("mom", imageId);
    expect(db.hasFile("s/u/photo.webp")).toBe(false);
    expect(rows("fam", "my_suggestions").find((r) => r.id === sid)).toMatchObject({ status: "deleted", storage_path: null, message: null });
    expect(rows("mom", "inbox").some((r) => r.id === sid)).toBe(false);
    expect(rows("mom", "deleted_list")[0]).toMatchObject({ origin: "suggestion", sender_name: "מיכל", restorable: false });
  });

  it("only a family member sends, and only after the upload", () => {
    fails(() => db.rpc("mom", "send_suggestion", { p_path: "x" }), /not_allowed/);
    fails(() => db.rpc("fam", "send_suggestion", { p_path: "never/uploaded.webp" }), /upload_missing/);
  });

  it("at most 20 a day per sender (as in the real app)", () => {
    for (let i = 0; i < 19; i++) send(null);       // the seed already has 1 from this sender in the last day
    fails(() => send(null), /too_many_suggestions/);
  });
});

describe("comments", () => {
  it("the family comments on shared pictures only; Mom deletes any comment, a member only their own", () => {
    const shared = rows("fam", "gallery")[0].id;
    const priv = rows("mom", "gallery").find((r) => !r.family_can_see).id;
    const cid = db.rpc("fam", "add_comment", { p_image: shared, p_body: " יפה מאוד " }) as string;
    expect(rows("mom", "image_comments", { p_image: shared }).map((c) => c.body)).toContain("יפה מאוד");
    fails(() => db.rpc("fam", "add_comment", { p_image: priv, p_body: "x" }), /not_found/);
    fails(() => db.rpc("fam", "add_comment", { p_image: shared, p_body: "   " }), /check constraint/);
    const momsC = db.rpc("mom", "add_comment", { p_image: shared, p_body: "תודה" }) as string;
    fails(() => db.rpc("fam", "delete_comment", { p_comment: momsC }), /not_found/);
    db.rpc("fam", "delete_comment", { p_comment: cid });
    db.rpc("mom", "delete_comment", { p_comment: momsC });
    expect(rows("mom", "image_comments", { p_image: shared }).some((c) => [cid, momsC].includes(c.id))).toBe(false);
  });
});

describe("uploads stay local; a refresh starts over", () => {
  it("Mom's upload is shown from a local object URL and lands in her main collection, private", () => {
    db.upload("s/m/mine.webp", new Blob(["x"]));
    const id = db.rpc("mom", "add_upload", { p_path: "s/m/mine.webp", p_collection: null, p_width: 4, p_height: 3 }) as string;
    expect(rows("mom", "gallery")[0].id).toBe(id);
    expect(db.signedUrl("s/m/mine.webp")).toBe("blob:local");
    expect(ids("fam")).not.toContain(id);
    const main = rows("mom", "collections_list").find((c) => c.is_default).id;
    expect(db.membership(id)).toEqual([main]);
  });

  it("a new database is the original data again — nothing survives (a page refresh)", () => {
    db.deleteImage("mom", ids("mom")[0]);
    db.rpc("mom", "create_collection", { p_name: "חדש" });
    const fresh = make();
    expect(fresh.rpc("mom", "gallery")).toHaveLength(7);
    expect(fresh.rpc("mom", "collections_list")).toHaveLength(3);
  });

  it("unknown calls are refused instead of silently working", () => {
    fails(() => db.rpc("mom", "admin_studios"), /not part of the demo/);
  });
});
