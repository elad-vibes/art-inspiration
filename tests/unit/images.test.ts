import { describe, expect, it } from "vitest";
import {
  cleanText, countLabel, creditParts, fitSize, looksLikeImage, MAX_SIDE, senderStatusLabel, uploadPath,
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
