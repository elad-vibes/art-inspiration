import { describe, expect, it } from "vitest";
import {
  cleanText, countLabel, creditParts, deletedLabel, deletePrompt, fitSize, fmtBytes, looksLikeImage, MAX_SIDE,
  senderStatusLabel, uploadPath,
} from "../../src/domain/images.ts";

describe("photo size", () => {
  it("scales the long side down to the limit and keeps the proportions", () => {
    expect(fitSize(4032, 3024)).toEqual({ w: MAX_SIDE, h: 1536 });
    expect(fitSize(3024, 4032)).toEqual({ w: 1536, h: MAX_SIDE });
    expect(fitSize(1000, 30000, 1000)).toEqual({ w: 33, h: 1000 });
  });
  it("never scales up, and survives nonsense", () => {
    expect(fitSize(800, 600)).toEqual({ w: 800, h: 600 });
    expect(fitSize(0, 600)).toEqual({ w: 0, h: 0 });
    expect(fitSize(NaN, 600)).toEqual({ w: 0, h: 0 });
    expect(fitSize(50000, 1, 2048)).toEqual({ w: 2048, h: 1 });
  });
});

describe("upload path", () => {
  it("is {studio}/{uploader}/{id}.ext — the only shape Storage accepts", () => {
    const s = "00000000-0000-4000-8000-0000000000aa", u = "00000000-0000-4000-8000-00000000a001", id = "00000000-0000-4000-8000-000000000001";
    expect(uploadPath(s, u, id, "webp")).toBe(`${s}/${u}/${id}.webp`);
    expect(uploadPath(s, u, id, "jpg")).toMatch(/\.jpg$/);
  });
});

describe("only photos from the picker", () => {
  it("accepts images (including iPhone HEIC with no type) and refuses the rest", () => {
    expect(looksLikeImage({ type: "image/jpeg", name: "a.jpg" })).toBe(true);
    expect(looksLikeImage({ type: "", name: "IMG_0001.HEIC" })).toBe(true);
    expect(looksLikeImage({ type: "video/quicktime", name: "a.mov" })).toBe(false);
    expect(looksLikeImage({ type: "application/pdf", name: "a.pdf" })).toBe(false);
  });
});

describe("what the sender sees", () => {
  it("never tells a sender their suggestion was ignored", () => {
    expect(senderStatusLabel("pending").text).toBe("נשלחה");
    expect(senderStatusLabel("ignored").text).toBe("נשלחה");
    expect(senderStatusLabel("accepted").text).toBe("נשמרה");
    expect(senderStatusLabel("deleted").text).toBe("הוסרה");
  });
});

describe("credit under a web image", () => {
  it("web: creator + source + license; an unknown creator is said so, not invented", () => {
    expect(creditParts({ kind: "web", creator: " צלם בדוי ", source_name: "Openverse", license: "CC BY" }))
      .toEqual({ creator: "צלם בדוי", source: "Openverse", license: "CC BY" });
    expect(creditParts({ kind: "web", creator: null, source_name: "Openverse", license: null })?.creator).toBe("יוצר לא ידוע");
  });
  it("an upload or a generated image never gets a credit or a source (AGENTS 7)", () => {
    expect(creditParts({ kind: "upload", creator: "x", source_name: "y", license: "z" })).toBeNull();
    expect(creditParts({ kind: "generated", creator: "x", source_name: "y", license: "z" })).toBeNull();
  });
});

describe("what the delete confirmation promises", () => {
  it("a web picture: it is only hidden and can be brought back, and her note is kept", () => {
    const p = deletePrompt({ kind: "web" });
    expect(p.final).toBe(false);
    expect(p.body).toMatch(/נמחקו/);
    expect(p.body).toMatch(/להחזיר/);
    expect(p.body).not.toMatch(/אי אפשר לשחזר/);
    expect(deletePrompt({ kind: "web", shared: true }).body).toMatch(/תיעלם גם מהמשפחה/);
    expect(p.body).not.toMatch(/תיעלם גם מהמשפחה/);
  });
  it("anything else: deleted for good — says it can't be undone and what goes with it", () => {
    for (const kind of ["upload", "generated"] as const) {
      const p = deletePrompt({ kind });
      expect(p.final).toBe(true);
      expect(p.title).toMatch(/לגמרי/);
      expect(p.body).toMatch(/אי אפשר לשחזר/);
      expect(p.body).toMatch(/הערה/);
      expect(p.confirm).toBe("מחיקה לגמרי");
    }
  });
  it("a family picture also says the sender will see it was removed", () => {
    expect(deletePrompt({ kind: "upload", sender: "מיכל" }).body).toMatch(/מיכל יראה שההצעה הוסרה/);
    expect(deletePrompt({ kind: "upload" }).body).not.toMatch(/יראה שההצעה/);
  });
});

describe("the 'deleted' screen", () => {
  it("names each kind in Hebrew", () => {
    expect(deletedLabel("web")).toBe("תמונה מהרשת");
    expect(deletedLabel("upload")).toBe("תמונה שהעלית");
    expect(deletedLabel("generated")).toBe("תמונה שנוצרה");
    expect(deletedLabel("suggestion", "עומר")).toBe("הצעה מעומר");
    expect(deletedLabel("suggestion")).toBe("הצעה מהמשפחה");
  });
  it("formats the admin's estimated size", () => {
    expect([fmtBytes(0), fmtBytes(null), fmtBytes("abc")]).toEqual(["0", "0", "0"]);
    expect(fmtBytes(100)).toBe("1 KB");
    expect(fmtBytes(480 * 1024)).toBe("480 KB");
    expect(fmtBytes("3355443")).toBe("3.2 MB");                                  // bigint arrives as a string sometimes
    expect(fmtBytes(2.5 * 1024 ** 3)).toBe("2.50 GB");
  });
});

describe("small text helpers", () => {
  it("counts in Hebrew", () => {
    expect([countLabel(0), countLabel(1), countLabel(7)]).toEqual(["אין תמונות", "תמונה אחת", "7 תמונות"]);
  });
  it("trims, limits, and turns empty into null", () => {
    expect(cleanText("  שלום  ", 300)).toBe("שלום");
    expect(cleanText("   ", 300)).toBeNull();
    expect(cleanText(undefined, 300)).toBeNull();
    expect(cleanText("x".repeat(400), 300)).toHaveLength(300);
  });
});
