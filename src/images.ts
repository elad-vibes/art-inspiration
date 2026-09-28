// Images, collections and suggestions: loading, uploading and every change.
// Reads run under RLS (gallery / inbox / collections_list are SECURITY INVOKER);
// writes are the checked server functions of 0006. Files live in the private
// bucket "images" and are shown through short-lived signed URLs.
import { dbMessage, sb } from "./lib/supa.ts";
import { encodePhoto } from "./lib/photo.ts";
import { can, isPainter, rerender, S } from "./state.ts";
import {
  cleanText, type CollectionRow, type CommentRow, type GalleryImage, type InboxItem, looksLikeImage,
  MAX_COMMENT, MAX_MESSAGE, MAX_NOTE, type MySuggestion, type Rating, uploadPath,
} from "./domain/images.ts";

export type Tab = "gallery" | "inbox" | "collections";

const BUCKET = "images";
const URL_TTL = 3600;              // seconds a signed URL lives
const RELOAD_AFTER = 30 * 60e3;    // reload when the app comes back after this long

export const G = {
  sid: null as string | null,
  tab: "gallery" as Tab,
  filter: null as string | null,                    // collection shown in the gallery (null = everything)
  images: null as GalleryImage[] | null,
  inbox: null as InboxItem[] | null,
  collections: null as CollectionRow[] | null,
  mine: null as MySuggestion[] | null,
  newCount: 0,
  err: null as string | null,
  online: typeof navigator === "undefined" ? true : navigator.onLine,
  loadedAt: 0,
  open: null as string | null,                      // image in the detail sheet
  memberOf: {} as Record<string, string[]>,         // image → its collections (painter)
  comments: {} as Record<string, CommentRow[] | "error">,
  busy: null as null | { done: number; total: number },
  draft: null as null | { file: File; preview: string },  // a family member's photo before sending
  editColl: null as string | null,
  urls: new Map<string, { url: string; exp: number }>(),
};

function reset(sid: string | null) {
  if (G.draft) URL.revokeObjectURL(G.draft.preview);
  Object.assign(G, {
    sid, tab: "gallery", filter: null, images: null, inbox: null, collections: null, mine: null, newCount: 0,
    err: null, open: null, memberOf: {}, comments: {}, busy: null, draft: null, editColl: null,
  });
  G.urls.clear();
}

/** Hebrew message for any failure here (photo decoding, Storage, database, network). */
export function errMsg(e: any): string {
  if (e && ["decode", "too_big", "not_image", "offline"].includes(e.code)) return e.message;
  const m = String(e?.message ?? "");
  if (/exceeded the maximum|too large|payload/i.test(m) || String(e?.statusCode) === "413") return "התמונה גדולה מדי. אפשר לנסות תמונה אחרת.";
  if (/mime type/i.test(m)) return "אפשר להעלות רק תמונות.";
  return dbMessage(e);
}

// ------------------------------------------------------------ signed URLs
export const urlOf = (path: string | null) => (path ? G.urls.get(path)?.url ?? null : null);

async function sign(paths: (string | null | undefined)[]) {
  const now = Date.now();
  const need = [...new Set(paths.filter((p): p is string => !!p && !((G.urls.get(p)?.exp ?? 0) > now + 5 * 60e3)))];
  for (let i = 0; i < need.length; i += 100) {
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(need.slice(i, i + 100), URL_TTL);
    if (error) throw error;
    for (const d of data ?? []) {
      if (d.signedUrl && d.path) G.urls.set(d.path, { url: d.signedUrl, exp: now + URL_TTL * 1000 });
    }
  }
}

// ------------------------------------------------------------------ loading
async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw error;
  return data as T;
}

export async function loadGallery() {
  const rows = await rpc<GalleryImage[]>("gallery", { p_studio: G.sid, p_collection: G.filter });
  await sign(rows.map((r) => r.storage_path));
  G.images = rows;
}
export async function loadInbox() {
  const rows = await rpc<InboxItem[]>("inbox", { p_studio: G.sid });
  await sign(rows.map((r) => r.storage_path));
  G.inbox = rows;
  G.newCount = rows.filter((r) => r.is_new).length;
}
export async function loadCollections() {
  const rows = await rpc<CollectionRow[]>("collections_list", { p_studio: G.sid });
  await sign(rows.map((r) => r.cover_path));
  G.collections = rows;
  if (G.filter && !rows.some((c) => c.id === G.filter)) G.filter = null;
}
export async function loadMine() {
  const rows = await rpc<MySuggestion[]>("my_suggestions", { p_studio: G.sid });
  await sign(rows.map((r) => r.storage_path));
  G.mine = rows;
}

/** Everything this person may see in the current studio. */
export async function loadAll() {
  if (G.sid !== S.sid) reset(S.sid);
  if (!G.sid) return;
  G.err = null;
  rerender();
  try {
    const jobs: Promise<void>[] = [];
    if (isPainter() || can("view")) jobs.push(loadGallery(), loadCollections());
    if (isPainter()) jobs.push(loadInbox());
    else if (can("send")) jobs.push(loadMine());
    await Promise.all(jobs);
    G.loadedAt = Date.now();
  } catch (e) {
    G.err = errMsg(e);
  }
  rerender();
}

export function watchNetwork() {
  addEventListener("offline", () => { G.online = false; rerender(); });
  addEventListener("online", () => { G.online = true; if (S.view === "app") loadAll(); else rerender(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && S.view === "app" && G.sid && Date.now() - G.loadedAt > RELOAD_AFTER) loadAll();
  });
}

// ---------------------------------------------------------------- uploading
function needNet() {
  if (!navigator.onLine) throw Object.assign(new Error("אין חיבור לאינטרנט כרגע. אפשר לנסות שוב כשהחיבור יחזור."), { code: "offline" });
}

async function putPhoto(file: File): Promise<{ path: string; width: number; height: number }> {
  if (!looksLikeImage(file)) throw Object.assign(new Error("אפשר להעלות רק תמונות."), { code: "not_image" });
  const enc = await encodePhoto(file);
  const path = uploadPath(G.sid!, S.user!.id, crypto.randomUUID(), enc.ext);
  const { error } = await sb.storage.from(BUCKET).upload(path, enc.blob, { contentType: enc.type, upsert: false, cacheControl: "3600" });
  if (error) throw error;
  return { path, width: enc.width, height: enc.height };
}

/** Removes files nobody uses any more (after a delete, or a send that failed). Best effort. */
export async function removeFiles(paths: (string | null | undefined)[]) {
  const list = paths.filter((p): p is string => !!p);
  if (!list.length) return;
  try { await sb.storage.from(BUCKET).remove(list); } catch { /* an orphan file stays unreadable to others (0007) */ }
  for (const p of list) G.urls.delete(p);
}

async function uploadThen(file: File, register: (u: { path: string; width: number; height: number }) => Promise<unknown>) {
  const u = await putPhoto(file);
  try {
    await register(u);
  } catch (e) {
    await removeFiles([u.path]);
    throw e;
  }
}

/** The painter's upload: into the collection being viewed, or her default one. */
export async function uploadMine(files: File[]): Promise<{ ok: number; error: string | null }> {
  needNet();
  let ok = 0;
  let error: string | null = null;
  G.busy = { done: 0, total: files.length };
  rerender();
  for (const f of files) {
    try {
      await uploadThen(f, (u) => rpc("add_upload", {
        p_studio: G.sid, p_path: u.path, p_collection: G.filter, p_width: u.width, p_height: u.height,
      }));
      ok++;
    } catch (e) {
      error = errMsg(e);
    }
    G.busy.done++;
    rerender();
  }
  G.busy = null;
  await Promise.all([loadGallery(), loadCollections()]).catch((e) => { G.err = errMsg(e); });
  rerender();
  return { ok, error };
}

export async function sendSuggestion(file: File, message: string) {
  needNet();
  G.busy = { done: 0, total: 1 };
  rerender();
  try {
    await uploadThen(file, (u) => rpc("send_suggestion", {
      p_studio: G.sid, p_path: u.path, p_message: cleanText(message, MAX_MESSAGE), p_width: u.width, p_height: u.height,
    }));
  } finally {
    G.busy = null;
  }
  await loadMine();
}

// ------------------------------------------------------- the painter's box
export async function decide(id: string, action: "accept" | "ignore" | "delete", collection: string | null = null) {
  needNet();
  const path = await rpc<string | null>("decide_suggestion", { p_suggestion: id, p_action: action, p_collection: collection });
  if (action === "delete") await removeFiles([path]);
  await Promise.all(action === "accept" ? [loadInbox(), loadGallery(), loadCollections()] : [loadInbox()]);
}

/** Clears the "new" marker. The chips stay for this visit so she sees which were new. */
export async function markSeen() {
  if (!G.newCount) return;
  G.newCount = 0;
  try { await rpc("mark_suggestions_seen", { p_studio: G.sid }); } catch { /* shown as new next time */ }
}

// ------------------------------------------------------ one image (painter)
const img = (id: string) => G.images?.find((i) => i.id === id) ?? null;

export async function setRating(id: string, rating: Rating) {
  const i = img(id);
  if (!i) return;
  const next = i.my_rating === rating ? null : rating;          // tapping again clears it
  await rpc("set_reaction", { p_image: id, p_rating: next, p_note: i.my_note });
  i.my_rating = next;
}

export async function saveNote(id: string, note: string) {
  const i = img(id);
  if (!i) return;
  const v = cleanText(note, MAX_NOTE);
  await rpc("set_reaction", { p_image: id, p_rating: i.my_rating, p_note: v });
  i.my_note = v;
}

export async function setShared(id: string, shared: boolean) {
  await rpc("set_image_shared", { p_image: id, p_shared: shared });
  await loadGallery();
}

export async function loadMembership(id: string) {
  const { data, error } = await sb.from("collection_items").select("collection_id").eq("image_id", id);
  if (error) throw error;
  G.memberOf[id] = (data ?? []).map((r: any) => r.collection_id);
}

export async function toggleCollection(id: string, collection: string, on: boolean) {
  await rpc(on ? "save_to_collection" : "remove_from_collection", { p_image: id, p_collection: collection });
  await Promise.all([loadMembership(id), loadCollections(), loadGallery()]);
}

export async function deleteImage(id: string) {
  needNet();
  const path = await rpc<string | null>("delete_image", { p_image: id });
  await removeFiles([path]);
  G.open = null;
  await Promise.all([loadGallery(), loadCollections()]);
}

// -------------------------------------------------------------- collections
export async function createCollection(name: string) {
  await rpc("create_collection", { p_studio: G.sid, p_name: name.trim() });
  await loadCollections();
}
export async function renameCollection(id: string, name: string) {
  await rpc("rename_collection", { p_collection: id, p_name: name.trim() });
  await loadCollections();
}
export async function shareCollection(id: string, shared: boolean) {
  await rpc("set_collection_shared", { p_collection: id, p_shared: shared });
  await Promise.all([loadCollections(), loadGallery()]);
}
export async function deleteCollection(id: string) {
  await rpc("delete_collection", { p_collection: id });
  if (G.filter === id) G.filter = null;
  G.editColl = null;
  await Promise.all([loadCollections(), loadGallery()]);
}

// ----------------------------------------------------------------- comments
export async function loadComments(id: string) {
  try {
    G.comments[id] = await rpc<CommentRow[]>("image_comments", { p_image: id });
  } catch {
    G.comments[id] = "error";
  }
}
export async function addComment(id: string, body: string) {
  const v = cleanText(body, MAX_COMMENT);
  if (!v) return;
  await rpc("add_comment", { p_image: id, p_body: v });
  await loadComments(id);
  const i = img(id);
  if (i) i.comment_count++;
}
export async function deleteComment(imageId: string, id: string) {
  await rpc("delete_comment", { p_comment: id });
  await loadComments(imageId);
  const i = img(imageId);
  if (i) i.comment_count = Math.max(0, i.comment_count - 1);
}
