import { describe, expect, it } from "vitest";
import { normalize, permSummary, PRESETS, presetOf, presetPerms } from "../../src/domain/perms.ts";

const P = (send: boolean, view: boolean, comment: boolean, generate = false) =>
  ({ can_send: send, can_view: view, can_comment: comment, can_generate: generate });

describe("permission presets", () => {
  it("every preset round-trips and never includes generating (it costs money)", () => {
    for (const p of PRESETS) {
      expect(presetOf(p.perms)).toBe(p.id);
      expect(p.perms.can_generate).toBe(false);
      expect(presetPerms(p.id)).toEqual(p.perms);
    }
  });

  it("recognises a preset regardless of can_generate, otherwise 'custom'", () => {
    expect(presetOf(P(true, false, false, true))).toBe("sender");
    expect(presetOf(P(true, true, false))).toBe("custom");
    expect(presetOf(P(false, false, false))).toBe("custom");
  });

  it("presetPerms returns a copy (editing it can't change the preset)", () => {
    const a = presetPerms("all");
    a.can_send = false;
    expect(presetPerms("all").can_send).toBe(true);
  });

  it("commenting needs viewing", () => {
    expect(normalize(P(true, false, true))).toEqual(P(true, false, false));
    expect(normalize(P(false, true, true))).toEqual(P(false, true, true));
  });

  it("summaries in Hebrew", () => {
    expect(permSummary(P(true, true, false), "family")).toBe("לשלוח הצעות · לצפות במה ששותף");
    expect(permSummary(P(false, false, false), "family")).toMatch(/עוד אין הרשאות/);
    expect(permSummary(P(false, false, false), "painter")).toMatch(/הסטודיו שלך/);
  });
});
