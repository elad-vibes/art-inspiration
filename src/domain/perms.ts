// Family permissions and presets (ART-PLAN §1). Pure functions — the database
// is what enforces them (has_perm / admin_set_member); this is for the screens.

export type Perm = "send" | "view" | "comment" | "generate";
export type Role = "painter" | "family";
export interface Perms { can_send: boolean; can_view: boolean; can_comment: boolean; can_generate: boolean }

export const PERMS: Perm[] = ["send", "view", "comment", "generate"];

export const PERM_LABEL: Record<Perm, string> = {
  send: "לשלוח הצעות",
  view: "לצפות במה ששותף",
  comment: "להגיב",
  generate: "ליצור ולערוך תמונות",
};

export type PresetId = "sender" | "viewer" | "commenter" | "all";

/** can_generate is never part of a preset: it costs money and is switched on separately. */
export const PRESETS: { id: PresetId; label: string; perms: Perms }[] = [
  { id: "sender", label: "שולח/ת תמונות", perms: { can_send: true, can_view: false, can_comment: false, can_generate: false } },
  { id: "viewer", label: "צופה", perms: { can_send: false, can_view: true, can_comment: false, can_generate: false } },
  { id: "commenter", label: "צופה ומגיב/ה", perms: { can_send: false, can_view: true, can_comment: true, can_generate: false } },
  { id: "all", label: "הכול", perms: { can_send: true, can_view: true, can_comment: true, can_generate: false } },
];

export const has = (p: Perms, perm: Perm): boolean => !!p[`can_${perm}`];

/** Which preset these permissions match (ignoring can_generate), or "custom". */
export function presetOf(p: Perms): PresetId | "custom" {
  const hit = PRESETS.find((x) => x.perms.can_send === p.can_send && x.perms.can_view === p.can_view && x.perms.can_comment === p.can_comment);
  return hit?.id ?? "custom";
}

export function presetPerms(id: PresetId): Perms {
  return { ...PRESETS.find((x) => x.id === id)!.perms };
}

/** "לשלוח הצעות · לצפות במה ששותף" — or a clear sentence when nothing is allowed. */
export function permSummary(p: Perms, role: Role): string {
  if (role === "painter") return "הכול — זה הסטודיו שלך";
  const list = PERMS.filter((k) => has(p, k)).map((k) => PERM_LABEL[k]);
  return list.length ? list.join(" · ") : "עוד אין הרשאות (אפשר לבקש מהמנהל)";
}

/** Commenting on shared images only makes sense for someone who can see them. */
export function normalize(p: Perms): Perms {
  return { ...p, can_comment: p.can_comment && p.can_view };
}
