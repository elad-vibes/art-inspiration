// The demo's pretend "create a new version": colour looks on pixels, and the generated version's
// place in the demo database (private, linked to its source, deleted for real like an upload).
import { describe, expect, it } from "vitest";
import { DemoDb, DemoError } from "../../src/demo/db.ts";
import { applyLook, LOOKS, matrixOf, pickLooks } from "../../src/demo/looks.ts";

const px = (r: number, g: number, b: number) => new Uint8ClampedArray([r, g, b, 255]);
const neutral = { label: "", hue: 0, sat: 1, bright: 1, contrast: 1, warm: 0 };

describe("colour looks", () => {
  it("the neutral look is the identity; amount 0 leaves the picture as it was", () => {
    expect(matrixOf(neutral).map((n) => Math.round(n * 1000) / 1000)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const a = px(200, 120, 40);
    applyLook(a, neutral);
    expect([...a]).toEqual([200, 120, 40, 255]);
    const b = px(200, 120, 40);
    applyLook(b, LOOKS.blue, 0);
    expect([...b]).toEqual([200, 120, 40, 255]);
  });

  it("black-and-white removes colour; night is darker; warm moves red up and blue down; bright is lighter", () => {
    const m = px(230, 90, 40); applyLook(m, LOOKS.mono);
    expect(Math.abs(m[0] - m[1])).toBeLessThan(6);
    expect(Math.abs(m[1] - m[2])).toBeLessThan(6);
    const n = px(200, 200, 200); applyLook(n, LOOKS.night);
    expect(n[0] + n[1] + n[2]).toBeLessThan(600 * 0.75);
    const w = px(120, 120, 120); applyLook(w, LOOKS.warm);
    expect(w[0]).toBeGreaterThan(w[2]);
    const l = px(100, 100, 100); applyLook(l, LOOKS.bright);
    expect(l[0]).toBeGreaterThan(100);
  });

  it("a gentler amount lands between the original and the full look; alpha is never touched", () => {
    const orig = [220, 100, 60];
    const full = px(220, 100, 60); applyLook(full, LOOKS.blue, 1);
    const half = px(220, 100, 60); applyLook(half, LOOKS.blue, 0.5);
    for (let c = 0; c < 3; c++) {
      expect(half[c]).toBeGreaterThanOrEqual(Math.min(orig[c], full[c]) - 1);
      expect(half[c]).toBeLessThanOrEqual(Math.max(orig[c], full[c]) + 1);
    }
    expect(full[3]).toBe(255);
    expect(half[3]).toBe(255);
  });

  it("three options for every request: what was asked, a gentler one, and a neighbour — or a default trio", () => {
    const blue = pickLooks("יותר כחול");
    expect(blue).toHaveLength(3);
    expect(blue[0].look).toBe(LOOKS.blue);
    expect(blue[1].look).toBe(LOOKS.blue);
    expect(blue[1].amount).toBeLessThan(blue[0].amount);
    expect(blue[2].look).not.toBe(LOOKS.blue);
    expect(new Set(blue.map((o) => o.label)).size).toBe(3);
    expect(pickLooks("שקיעה חמה")[0].look).toBe(LOOKS.warm);
    expect(pickLooks("לילה")[0].look).toBe(LOOKS.night);
    expect(pickLooks("צבעים רכים")[0].look).toBe(LOOKS.soft);
    expect(pickLooks("בשחור-לבן")[0].look).toBe(LOOKS.mono);
    // whole words only: "צבעים" contains the letters of "ים" (sea) but is not blue; "בים" and "הים" are
    expect(pickLooks("צבעים חדשים")[0].look).toBe(LOOKS.warm);          // no keyword → the default trio starts with warm
    expect(pickLooks("תצייר את זה בים")[0].look).toBe(LOOKS.blue);
    expect(pickLooks("הים בערב")[0].look).toBe(LOOKS.blue);              // the first keyword wins
    expect(pickLooks("בשחור-לבן")[0].look).toBe(LOOKS.mono);
    const other = pickLooks("משהו לא מוכר");
    expect(other).toHaveLength(3);
    expect(new Set(other.map((o) => o.label)).size).toBe(3);
  });
});

describe("a generated version in the demo database", () => {
  const make = () => new DemoDb({ art: (n) => `/art/${n}.svg`, webArt: (n) => `https://demo.example/art/${n}.svg`, blobUrl: () => "blob:local" });
  const gallery = (db: DemoDb, who: "mom" | "fam") => db.rpc(who, "gallery") as any[];
  const fails = (fn: () => unknown, re: RegExp) => { try { fn(); } catch (e) { expect(e).toBeInstanceOf(DemoError); expect((e as Error).message).toMatch(re); return; } throw new Error("expected an error"); };

  it("is saved private, in her main collection, linked to the picture it came from, with no credit", () => {
    const db = make();
    const src = gallery(db, "mom").find((r) => r.kind === "upload" && r.family_can_see === false);
    db.upload("demo-mom/mom/x.jpg", new Blob(["x"]));
    const id = db.rpc("mom", "add_generated", { p_parent: src.id, p_path: "demo-mom/mom/x.jpg", p_width: 10, p_height: 8 }) as string;
    const row = gallery(db, "mom").find((r) => r.id === id);
    expect(row).toMatchObject({ kind: "generated", parent_id: src.id, shared: false, family_can_see: false, by_me: true });
    expect([row.creator, row.attribution, row.page_url, row.source_name, row.license]).toEqual([null, null, null, null, null]);
    expect(gallery(db, "fam").some((r) => r.id === id)).toBe(false);
    expect(db.membership(id)).toEqual([(db.rpc("mom", "collections_list") as any[]).find((c) => c.is_default).id]);
    expect(gallery(db, "mom").some((r) => r.id === src.id)).toBe(true);                     // the original is kept
  });

  it("only Mom saves one, only from a picture that exists, only after the file is there", () => {
    const db = make();
    const some = gallery(db, "mom")[0].id;
    db.upload("demo-mom/mom/y.jpg", new Blob(["x"]));
    fails(() => db.rpc("fam", "add_generated", { p_parent: some, p_path: "demo-mom/mom/y.jpg" }), /not_found/);
    fails(() => db.rpc("mom", "add_generated", { p_parent: "nope", p_path: "demo-mom/mom/y.jpg" }), /not_found/);
    fails(() => db.rpc("mom", "add_generated", { p_parent: some, p_path: "demo-mom/mom/never.jpg" }), /upload_missing/);
  });

  it("deleting the source keeps the version (the link is dropped); deleting a version leaves a 'generated' index row", () => {
    const db = make();
    const src = gallery(db, "mom").find((r) => r.kind === "upload" && !r.family_can_see);
    db.upload("demo-mom/mom/z.jpg", new Blob(["x"]));
    const id = db.rpc("mom", "add_generated", { p_parent: src.id, p_path: "demo-mom/mom/z.jpg" }) as string;
    db.deleteImage("mom", src.id);
    expect(gallery(db, "mom").find((r) => r.id === id).parent_id).toBeNull();
    expect(db.deleteImage("mom", id)).toEqual({ ok: true, mode: "deleted", cleanup: "done" });
    expect(db.hasFile("demo-mom/mom/z.jpg")).toBe(false);
    expect(db.indexRows().at(-1)).toMatchObject({ origin: "generated", sender_name: "" });
  });
});
