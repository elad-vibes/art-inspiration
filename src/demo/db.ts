// The demo's stand-in for the database: everything lives in memory and is gone on refresh.
// It answers the same calls the real app makes (gallery, inbox, delete, restore…) with the
// same rules (what the family may see, hide vs. delete, the small index), so the real
// screens run unchanged on top of it. All data is synthetic. Nothing here touches a network.
import type {
  AdminIndexRow, CollectionRow, CommentRow, DeletedRow, DeleteResult, GalleryImage, InboxItem, MySuggestion,
} from "../domain/images.ts";

export type Who = "mom" | "fam";
type Owner = "mom" | "fam" | "omer";
export const PEOPLE: Record<Owner, string> = { mom: "אמא", fam: "מיכל", omer: "עומר" };

interface Img {
  id: string; kind: "web" | "upload" | "generated"; path: string | null; thumb: string | null; width: number; height: number;
  shared: boolean; owner: Owner; created_at: string; deleted_at: string | null;
  /** a pretend-generated version keeps a link to the picture it came from (like the real design) */
  parent?: string;
  web?: { page_url: string; creator: string; source_name: string; license: string; license_url: string; attribution: string };
}
interface Coll { id: string; name: string; is_default: boolean; shared: boolean }
interface Sug { id: string; image_id: string | null; sender: Owner; message: string | null; status: "pending" | "accepted" | "ignored" | "deleted"; seen: boolean; created_at: string }
interface Cmt { id: string; image_id: string; author: Owner; body: string; created_at: string }
interface Gone { id: string; origin: "upload" | "suggestion" | "generated"; sender: Owner | null; uploaded_at: string; deleted_at: string }

export interface DemoOptions {
  /** URL of one of the demo paintings, by name (drawn in code, not photographs). */
  art: (name: string) => string;
  /** The same painting as an absolute https URL (a "web" picture's thumbnail must be https). */
  webArt: (name: string) => string;
  blobUrl?: (b: Blob) => string;
  now?: () => Date;
}

export class DemoError extends Error {
  constructor(message: string, public code = "P0001") { super(message); }
}

export class DemoDb {
  private imgs: Img[] = [];
  private colls: Coll[] = [];
  private items: { coll: string; img: string; seq: number }[] = [];
  private sugs: Sug[] = [];
  private cmts: Cmt[] = [];
  private react = new Map<string, { rating: "like" | "not_suitable" | null; note: string | null }>();
  private gone: Gone[] = [];
  private blobs = new Map<string, string>();     // uploaded photo path → local object URL (never sent anywhere)
  private seq = 0;
  private n = 0;

  constructor(private o: DemoOptions) { this.seed(); }

  private now = () => (this.o.now ?? (() => new Date()))();
  private ago = (days: number, hours = 0) => new Date(this.now().getTime() - days * 864e5 - hours * 36e5).toISOString();
  private id = (p: string) => `${p}-${++this.n}`;
  private err = (m: string, code = "P0001"): never => { throw new DemoError(m, code); };

  // -------------------------------------------------------------------- seed
  private seed() {
    const web = (name: string, tag: string, creator: string, w = 800, h = 600): Img => ({
      id: this.id("w"), kind: "web", path: null, thumb: this.o.webArt(name), width: w, height: h, shared: false, owner: "mom",
      created_at: this.ago(9), deleted_at: null,
      web: { page_url: `https://example.com/demo/${name}`, creator, source_name: "מקור לדוגמה", license: "CC BY 4.0",
        license_url: "https://example.com/demo/license", attribution: `${tag}, ${creator}` },
    });
    const up = (name: string, owner: Owner, days: number, w = 800, h = 600): Img => ({
      id: this.id("u"), kind: "upload", path: `demo/${name}`, thumb: null, width: w, height: h, shared: false, owner,
      created_at: this.ago(days), deleted_at: null,
    });
    const cDefault: Coll = { id: this.id("c"), name: "השמורים שלי", is_default: true, shared: false };
    const cFlowers: Coll = { id: this.id("c"), name: "פרחים", is_default: false, shared: true };
    const cSea: Coll = { id: this.id("c"), name: "ים ושקיעות", is_default: false, shared: false };
    this.colls.push(cDefault, cFlowers, cSea);

    const u1 = up("sunset-sea", "mom", 12); u1.shared = true;
    const u2 = up("mountains-lake", "mom", 10);
    const u3 = up("forest", "omer", 6, 600, 800);
    const u4 = up("poppies", "fam", 4);
    const w1 = web("meadow-flowers", "אחו עם פרחים", "צלמת בדויה");
    const w2 = web("poppies", "פרגים", "צלם בדוי");
    const w3 = web("sailboat", "סירת מפרש", "צלמת בדויה");
    const w4 = web("village", "כפר קטן", "צלם בדוי", 600, 800); w4.deleted_at = this.ago(2);
    this.imgs.push(u1, u2, u3, u4, w1, w2, w3, w4);

    const put = (c: Coll, i: Img) => this.items.push({ coll: c.id, img: i.id, seq: ++this.seq });
    [u1, u2, u3, u4, w1, w2].forEach((i) => put(cDefault, i));
    [w1, w2].forEach((i) => put(cFlowers, i));
    [u1, w3].forEach((i) => put(cSea, i));
    put(cDefault, w4);

    this.react.set(u1.id, { rating: "like", note: null });
    this.react.set(u2.id, { rating: "like", note: "לצייר בגווני כחול" });
    this.react.set(w2.id, { rating: "like", note: null });
    this.react.set(w3.id, { rating: "not_suitable", note: null });

    this.cmts.push(
      { id: this.id("k"), image_id: u1.id, author: "fam", body: "איזה צבעים יפים!", created_at: this.ago(11) },
      { id: this.id("k"), image_id: u1.id, author: "mom", body: "תודה, מיכל. זה מהנוף ליד הים.", created_at: this.ago(11, -2) },
    );

    // accepted suggestions (private until she shares)
    this.sugs.push(
      { id: this.id("s"), image_id: u3.id, sender: "omer", message: "ראיתי בטיול וחשבתי עלייך", status: "accepted", seen: true, created_at: this.ago(6) },
      { id: this.id("s"), image_id: u4.id, sender: "fam", message: null, status: "accepted", seen: true, created_at: this.ago(4) },
    );
    // waiting in her box
    const p1 = up("night-hills", "omer", 1); const p2 = up("meadow-flowers", "fam", 0);
    this.imgs.push(p1, p2);
    this.sugs.push(
      { id: this.id("s"), image_id: p1.id, sender: "omer", message: "הזכיר לי אותך", status: "pending", seen: false, created_at: this.ago(1) },
      { id: this.id("s"), image_id: p2.id, sender: "fam", message: "נראה לי בשבילך", status: "pending", seen: false, created_at: this.ago(0, 3) },
    );
    this.gone.push(
      { id: this.id("g"), origin: "upload", sender: null, uploaded_at: this.ago(20), deleted_at: this.ago(3) },
      { id: this.id("g"), origin: "suggestion", sender: "omer", uploaded_at: this.ago(12), deleted_at: this.ago(5) },
    );
  }

  // ---------------------------------------------------------------- helpers
  private img(id: string) { return this.imgs.find((i) => i.id === id); }
  private coll(id: string) { return this.colls.find((c) => c.id === id); }
  private defaultColl() { return this.colls.find((c) => c.is_default)!; }
  private sugOf(imgId: string) { return this.sugs.find((s) => s.image_id === imgId); }
  private waiting(imgId: string) { const s = this.sugOf(imgId); return !!s && (s.status === "pending" || s.status === "ignored"); }
  private isShared(i: Img) {
    return !i.deleted_at && (i.shared || this.items.some((x) => x.img === i.id && this.coll(x.coll)?.shared));
  }
  private live(who: Who) { return this.imgs.filter((i) => !i.deleted_at && (who === "mom" || this.isShared(i))); }
  private target(c: string | null | undefined) {
    if (!c) return this.defaultColl().id;
    if (!this.coll(c)) this.err("not_found", "P0002");
    return c;
  }
  private addItem(coll: string, img: string) {
    if (!this.items.some((x) => x.coll === coll && x.img === img)) this.items.push({ coll, img, seq: ++this.seq });
  }
  private mom(who: Who) { if (who !== "mom") this.err("not_found", "P0002"); }
  private ownerName = (o: Owner) => PEOPLE[o];

  // ---------------------------------------------------------- Storage (local)
  hasFile(path: string) { return this.blobs.has(path) || path.startsWith("demo/"); }
  upload(path: string, blob: Blob) { this.blobs.set(path, (this.o.blobUrl ?? URL.createObjectURL)(blob)); }
  removeFile(path: string) { this.blobs.delete(path); }
  signedUrl(path: string): string | null {
    if (path.startsWith("demo/")) return this.o.art(path.slice(5));
    return this.blobs.get(path) ?? null;
  }
  membership(imgId: string) { return this.items.filter((x) => x.img === imgId).map((x) => x.coll); }

  // ------------------------------------------------------------- the "server"
  rpc(who: Who, fn: string, a: Record<string, any> = {}): any {
    switch (fn) {
      case "gallery": {
        const col = a.p_collection as string | null;
        return this.live(who)
          .filter((i) => !this.waiting(i.id) && (!col || this.items.some((x) => x.coll === col && x.img === i.id)))
          .sort((x, y) => y.created_at.localeCompare(x.created_at)).slice(0, 500)
          .map((i): GalleryImage => {
            const r = who === "mom" ? this.react.get(i.id) : undefined;
            return {
              id: i.id, kind: i.kind, storage_path: i.path, width: i.width, height: i.height, shared: i.shared,
              family_can_see: this.isShared(i), parent_id: i.parent && this.img(i.parent) ? i.parent : null, by_me: i.owner === who, owner_name: this.ownerName(i.owner),
              page_url: i.web?.page_url ?? null, thumb_url: i.thumb, creator: i.web?.creator ?? null, creator_url: null,
              source_name: i.web?.source_name ?? null, license: i.web?.license ?? null, license_url: i.web?.license_url ?? null,
              attribution: i.web?.attribution ?? null, source_status: null, created_at: i.created_at,
              my_rating: r?.rating ?? null, my_note: r?.note ?? null, comment_count: this.cmts.filter((c) => c.image_id === i.id).length,
            };
          });
      }
      case "collections_list": {
        return this.colls.filter((c) => who === "mom" || c.shared).map((c): CollectionRow => {
          const mine = this.items.filter((x) => x.coll === c.id && this.img(x.img) && !this.img(x.img)!.deleted_at)
            .sort((x, y) => y.seq - x.seq);
          const cover = mine.length ? this.img(mine[0].img)! : null;
          return { id: c.id, name: c.name, is_default: c.is_default, shared: c.shared, items: mine.length,
            cover_path: cover?.path ?? null, cover_thumb: cover?.thumb ?? null };
        });
      }
      case "inbox": {
        if (who !== "mom") return [];
        return this.sugs.filter((s) => s.image_id && (s.status === "pending" || s.status === "ignored"))
          .sort((x, y) => y.created_at.localeCompare(x.created_at)).map((s): InboxItem => {
            const i = this.img(s.image_id!)!;
            return { id: s.id, status: s.status, message: s.message, created_at: s.created_at, is_new: !s.seen && s.status === "pending",
              sender_name: this.ownerName(s.sender), image_id: i.id, storage_path: i.path!, width: i.width, height: i.height };
          });
      }
      case "my_suggestions": {
        return this.sugs.filter((s) => s.sender === who).sort((x, y) => y.created_at.localeCompare(x.created_at)).map((s): MySuggestion => {
          const i = s.image_id ? this.img(s.image_id) : null;
          return { id: s.id, created_at: s.created_at, message: s.message, status: s.status === "ignored" ? "pending" : s.status,
            image_id: i?.id ?? null, storage_path: i?.path ?? null };
        });
      }
      case "deleted_list": {
        this.mom(who);
        const hidden = this.imgs.filter((i) => i.deleted_at && i.kind === "web").map((i): DeletedRow => ({
          id: i.id, origin: "web", restorable: true, sender_name: null, uploaded_at: i.created_at, deleted_at: i.deleted_at!,
          thumb_url: i.thumb, page_url: i.web!.page_url, creator: i.web!.creator, source_name: i.web!.source_name, attribution: i.web!.attribution,
        }));
        const idx = this.gone.map((g): DeletedRow => ({
          id: g.id, origin: g.origin, restorable: false, sender_name: g.origin === "suggestion" && g.sender ? this.ownerName(g.sender) : null,
          uploaded_at: g.uploaded_at, deleted_at: g.deleted_at, thumb_url: null, page_url: null, creator: null, source_name: null, attribution: null,
        }));
        return [...hidden, ...idx].sort((x, y) => y.deleted_at.localeCompare(x.deleted_at)).slice(0, 300);
      }
      case "mark_suggestions_seen": {
        this.mom(who);
        let n = 0;
        for (const s of this.sugs) if (s.status === "pending" && !s.seen) { s.seen = true; n++; }
        return n;
      }
      case "decide_suggestion": {
        this.mom(who);
        const s = this.sugs.find((x) => x.id === a.p_suggestion);
        if (!s) this.err("not_found", "P0002");
        if (s!.status !== "pending" && s!.status !== "ignored") this.err("already_decided");
        if (a.p_action === "accept") { this.addItem(this.target(a.p_collection), s!.image_id!); s!.status = "accepted"; s!.seen = true; return null; }
        if (a.p_action === "ignore") { s!.status = "ignored"; s!.seen = true; return null; }
        if (a.p_action === "delete") { this.purge(s!.image_id!); return null; }
        return this.err("bad_action");
      }
      case "set_reaction": {
        this.mom(who);
        const i = this.img(a.p_image);
        if (!i || i.deleted_at) this.err("not_found", "P0002");
        const rating = (a.p_rating || null) as "like" | "not_suitable" | null;
        const note = (String(a.p_note ?? "").trim() || null) as string | null;
        if (!rating && !note) this.react.delete(a.p_image); else this.react.set(a.p_image, { rating, note });
        return null;
      }
      case "set_image_shared": {
        this.mom(who);
        const i = this.img(a.p_image);
        if (!i || i.deleted_at) this.err("not_found", "P0002");
        if (this.waiting(i!.id)) this.err("suggestion_pending");
        i!.shared = !!a.p_shared;
        return null;
      }
      case "save_to_collection": {
        this.mom(who);
        const i = this.img(a.p_image);
        if (!i || i.deleted_at) this.err("not_found", "P0002");
        this.addItem(this.target(a.p_collection), i!.id);
        const s = this.sugOf(i!.id);
        if (s && (s.status === "pending" || s.status === "ignored")) { s.status = "accepted"; s.seen = true; }
        return null;
      }
      case "remove_from_collection": {
        this.mom(who);
        this.items = this.items.filter((x) => !(x.img === a.p_image && x.coll === a.p_collection));
        return null;
      }
      case "create_collection": {
        this.mom(who);
        if (this.colls.length >= 100) this.err("too_many_collections");
        const c: Coll = { id: this.id("c"), name: String(a.p_name).trim(), is_default: false, shared: false };
        this.colls.push(c);
        return c.id;
      }
      case "rename_collection": { this.mom(who); this.coll(a.p_collection)!.name = String(a.p_name).trim(); return null; }
      case "set_collection_shared": { this.mom(who); this.coll(a.p_collection)!.shared = !!a.p_shared; return null; }
      case "delete_collection": {
        this.mom(who);
        const c = this.coll(a.p_collection);
        if (!c) this.err("not_found", "P0002");
        if (c!.is_default) this.err("default_collection");
        this.colls = this.colls.filter((x) => x.id !== c!.id);
        this.items = this.items.filter((x) => x.coll !== c!.id);
        return null;
      }
      case "add_comment": {
        const i = this.img(a.p_image);
        if (!i || i.deleted_at || (who !== "mom" && !this.isShared(i))) this.err("not_found", "P0002");
        const body = String(a.p_body ?? "").trim();
        if (!body || body.length > 500) this.err("check constraint");
        const c: Cmt = { id: this.id("k"), image_id: i!.id, author: who, body, created_at: this.now().toISOString() };
        this.cmts.push(c);
        return c.id;
      }
      case "delete_comment": {
        const c = this.cmts.find((x) => x.id === a.p_comment);
        if (!c || (who !== "mom" && c.author !== who)) this.err("not_found", "P0002");
        this.cmts = this.cmts.filter((x) => x.id !== c!.id);
        return null;
      }
      case "image_comments": {
        const i = this.img(a.p_image);
        if (!i || (who !== "mom" && !this.isShared(i))) return [];
        return this.cmts.filter((c) => c.image_id === a.p_image).sort((x, y) => x.created_at.localeCompare(y.created_at))
          .map((c): CommentRow => ({ id: c.id, author_name: this.ownerName(c.author), mine: c.author === who, body: c.body, created_at: c.created_at }));
      }
      case "add_upload": {
        this.mom(who);
        if (!this.hasFile(a.p_path)) this.err("upload_missing");
        const i: Img = { id: this.id("u"), kind: "upload", path: a.p_path, thumb: null, width: a.p_width || 800, height: a.p_height || 600,
          shared: false, owner: "mom", created_at: this.now().toISOString(), deleted_at: null };
        this.imgs.push(i);
        this.addItem(this.target(a.p_collection), i.id);
        return i.id;
      }
      case "add_generated": {
        // the pretend "new version" the demo's create screen saves: private, in her main collection, linked to its source
        this.mom(who);
        const src = this.img(a.p_parent);
        if (!src || src.deleted_at) this.err("not_found", "P0002");
        if (!this.hasFile(a.p_path)) this.err("upload_missing");
        const i: Img = { id: this.id("u"), kind: "generated", path: a.p_path, thumb: null, width: a.p_width || src!.width, height: a.p_height || src!.height,
          shared: false, owner: "mom", created_at: this.now().toISOString(), deleted_at: null, parent: src!.id };
        this.imgs.push(i);
        this.addItem(this.defaultColl().id, i.id);
        return i.id;
      }
      case "send_suggestion": {
        if (who !== "fam") this.err("not_allowed", "42501");
        if (!this.hasFile(a.p_path)) this.err("upload_missing");
        if (this.sugs.filter((s) => s.sender === who && this.now().getTime() - Date.parse(s.created_at) < 864e5).length >= 20) this.err("too_many_suggestions");
        const i: Img = { id: this.id("u"), kind: "upload", path: a.p_path, thumb: null, width: a.p_width || 800, height: a.p_height || 600,
          shared: false, owner: who, created_at: this.now().toISOString(), deleted_at: null };
        this.imgs.push(i);
        const s: Sug = { id: this.id("s"), image_id: i.id, sender: who, message: String(a.p_message ?? "").trim() || null, status: "pending", seen: false, created_at: i.created_at };
        this.sugs.push(s);
        return s.id;
      }
      case "restore_image": {
        this.mom(who);
        const i = this.img(a.p_image);
        if (!i || i.kind !== "web" || !i.deleted_at) this.err("not_found", "P0002");
        i!.deleted_at = null;
        return null;
      }
      default:
        return this.err(`demo: ${fn} is not part of the demo`, "PGRST202");
    }
  }

  /** The delete-image function: a web picture is hidden, anything else is deleted for good. */
  deleteImage(who: Who, imageId: string): DeleteResult {
    this.mom(who);
    const i = this.img(imageId);
    if (!i || i.deleted_at) this.err("not_found", "P0002");
    const web = i!.kind === "web";
    return { ok: true, mode: this.purge(imageId), cleanup: web ? "none" : "done" };
  }

  private purge(imageId: string): "hidden" | "deleted" {
    const i = this.img(imageId)!;
    if (i.kind === "web") { i.deleted_at = this.now().toISOString(); i.shared = false; return "hidden"; }
    const s = this.sugOf(i.id);
    this.gone.push({ id: this.id("g"), origin: i.kind === "generated" ? "generated" : s ? "suggestion" : "upload", sender: s ? s.sender : null, uploaded_at: i.created_at, deleted_at: this.now().toISOString() });
    if (s) { s.status = "deleted"; s.image_id = null; s.message = null; }
    this.items = this.items.filter((x) => x.img !== i.id);
    this.cmts = this.cmts.filter((c) => c.image_id !== i.id);
    this.react.delete(i.id);
    if (i.path) this.removeFile(i.path);
    this.imgs = this.imgs.filter((x) => x.id !== i.id);
    return "deleted";
  }

  /** The small index of what was deleted for good (kind, sender, dates), as the admin would see it. */
  indexRows(): AdminIndexRow[] {
    return this.gone.map((g) => ({ id: g.id, origin: g.origin as "upload", sender_name: g.sender ? this.ownerName(g.sender) : "", uploaded_at: g.uploaded_at, deleted_at: g.deleted_at }));
  }
}
