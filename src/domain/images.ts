// Images, credit lines and suggestion states — pure functions for the screens.
// The database enforces the rules (0004–0007); this only formats and checks input.

export type ImageKind = "web" | "upload" | "generated";
export type Rating = "like" | "not_suitable";
export type SuggestionStatus = "pending" | "accepted" | "ignored" | "deleted";

export interface GalleryImage {
  id: string; kind: ImageKind; storage_path: string | null; width: number | null; height: number | null;
  shared: boolean; family_can_see: boolean; parent_id: string | null; by_me: boolean; owner_name: string | null;
  page_url: string | null; thumb_url: string | null; creator: string | null; creator_url: string | null;
  source_name: string | null; license: string | null; license_url: string | null; attribution: string | null;
  source_status: "ok" | "unavailable" | null; created_at: string;
  my_rating: Rating | null; my_note: string | null; comment_count: number;
}

export interface InboxItem {
  id: string; status: SuggestionStatus; message: string | null; created_at: string; is_new: boolean;
  sender_name: string; image_id: string; storage_path: string; width: number | null; height: number | null;
}

/** What the sender sees (the database already shows "ignored" as "pending"). */
export interface MySuggestion {
  id: string; created_at: string; message: string | null; status: SuggestionStatus;
  image_id: string | null; storage_path: string | null;
}

export interface CollectionRow {
  id: string; name: string; is_default: boolean; shared: boolean; items: number;
  cover_path: string | null; cover_thumb: string | null;
}

export interface CommentRow { id: string; author_name: string; mine: boolean; body: string; created_at: string }

/** A row of the painter's "deleted" screen: a hidden web picture, or a small index row of a real delete. */
export type DeletedOrigin = "web" | "upload" | "suggestion" | "generated";
export interface DeletedRow {
  id: string; origin: DeletedOrigin; restorable: boolean; sender_name: string | null;
  uploaded_at: string; deleted_at: string;
  thumb_url: string | null; page_url: string | null; creator: string | null; source_name: string | null; attribution: string | null;
}

/** What the delete-image function answers. */
export interface DeleteResult { ok: true; mode: "hidden" | "deleted"; cleanup: "none" | "done" | "pending" }

/** Admin: numbers per studio, and the index rows (never a picture, file name or note). */
export interface StorageOverviewRow {
  id: string; name: string; image_count: number; file_count: number; bytes_est: number | string;
  files_no_size: number; deleted_count: number; cleanup_pending: number;
}
export interface AdminIndexRow { id: string; origin: Exclude<DeletedOrigin, "web">; sender_name: string; uploaded_at: string; deleted_at: string }

export const MAX_MESSAGE = 300;
export const MAX_NOTE = 500;
export const MAX_COMMENT = 500;
export const MAX_COLLECTION_NAME = 40;
/** Longest side after re-encoding in the browser, and the bucket's size limit (0007). */
export const MAX_SIDE = 2048;
export const MAX_BYTES = 5 * 1024 * 1024;

/** Scales (w, h) down so the longer side is at most `max`; never scales up. */
export function fitSize(w: number, h: number, max = MAX_SIDE): { w: number; h: number } {
  if (!(w > 0 && h > 0)) return { w: 0, h: 0 };
  const k = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** {studio}/{uploader}/{uuid}.webp|jpg — the only shape Storage accepts (0007). */
export function uploadPath(studio: string, uploader: string, id: string, ext: "webp" | "jpg"): string {
  return `${studio}/${uploader}/${id}.${ext}`;
}

/** Only real photos: the phone's picker can also hand over videos or documents. */
export function looksLikeImage(file: { type: string; name: string }): boolean {
  return /^image\//i.test(file.type) || /\.(jpe?g|png|webp|gif|heic|heif|avif)$/i.test(file.name);
}

/** Label of a suggestion for the person who sent it. */
export function senderStatusLabel(s: SuggestionStatus): { text: string; tone: "grey" | "ok" | "accent" } {
  switch (s) {
    case "accepted": return { text: "נשמרה", tone: "ok" };
    case "deleted": return { text: "הוסרה", tone: "grey" };
    default: return { text: "נשלחה", tone: "accent" };
  }
}

/**
 * The credit under a web image: who made it and where it's from. Nothing for an
 * upload or a generated image — they never get a made-up source (AGENTS 7).
 */
export function creditParts(img: Pick<GalleryImage, "kind" | "creator" | "source_name" | "license">):
  { creator: string; source: string; license: string } | null {
  if (img.kind !== "web") return null;
  return {
    creator: (img.creator ?? "").trim() || "יוצר לא ידוע",
    source: (img.source_name ?? "").trim(),
    license: (img.license ?? "").trim(),
  };
}

/** "3 תמונות" / "תמונה אחת" / "אין תמונות". */
export function countLabel(n: number): string {
  if (n <= 0) return "אין תמונות";
  if (n === 1) return "תמונה אחת";
  return `${n} תמונות`;
}

/** What the confirmation says BEFORE a delete — plainly what will happen, and whether it can be undone. */
export interface DeletePrompt { title: string; body: string; confirm: string; final: boolean }

export function deletePrompt(img: { kind: ImageKind; shared?: boolean; sender?: string | null }): DeletePrompt {
  if (img.kind === "web") {
    return {
      title: "להסיר את התמונה מהגלריה?",
      body: `התמונה תעבור למסך "נמחקו", ואפשר יהיה להחזיר אותה בלחיצה אחת. ההערה והדירוג שלך יישמרו.${img.shared ? " היא תיעלם גם מהמשפחה." : ""}`,
      confirm: "הסרה מהגלריה",
      final: false,
    };
  }
  const who = img.sender ? ` ${img.sender} יראה שההצעה הוסרה.` : "";
  return {
    title: "למחוק את התמונה לגמרי?",
    body: `התמונה תימחק מהאחסון, וגם ההערה, הדירוג והתגובות שקשורים אליה. אי אפשר לשחזר אותה.${who}`,
    confirm: "מחיקה לגמרי",
    final: true,
  };
}

/** One line for a row of the "deleted" screen. */
export function deletedLabel(origin: DeletedOrigin, sender?: string | null): string {
  switch (origin) {
    case "web": return "תמונה מהרשת";
    case "upload": return "תמונה שהעלית";
    case "suggestion": return sender ? `הצעה מ${sender}` : "הצעה מהמשפחה";
    default: return "תמונה שנוצרה";
  }
}

/** "3.2 MB" / "480 KB" / "0" — for the admin's estimated storage. */
export function fmtBytes(n: number | string | null | undefined): string {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "0";
  if (v < 1024 * 1024) return `${Math.max(1, Math.round(v / 1024))} KB`;
  if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  return `${(v / 1024 ** 3).toFixed(2)} GB`;
}

/** Trimmed text within a limit, or null when empty. */
export function cleanText(s: string | null | undefined, max: number): string | null {
  const t = (s ?? "").trim();
  return t ? t.slice(0, max) : null;
}
