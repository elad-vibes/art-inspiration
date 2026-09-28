// In the demo build this file REPLACES src/lib/supa.ts (see vite.config.ts, mode "demo").
// There is no Supabase client, no URL and no key here: the same calls the app makes are
// answered from the in-memory database. Nothing leaves the browser.
import { DemoError } from "./db.ts";
import { demo } from "./runtime.ts";

export const configured = true;
export const appUrl = () => location.origin + import.meta.env.BASE_URL;

const fail = (e: unknown) => {
  const m = (e as Error)?.message ?? "error";
  return { data: null, error: { message: m, code: e instanceof DemoError ? e.code : "P0001" } };
};

export const sb = {
  rpc: async (fn: string, args: Record<string, unknown> = {}) => {
    try { return { data: demo.db.rpc(demo.who, fn, args), error: null }; } catch (e) { return fail(e); }
  },
  storage: {
    from: (_bucket: string) => ({
      createSignedUrls: async (paths: string[], _ttl: number) => ({
        data: paths.map((path) => ({ path, signedUrl: demo.db.signedUrl(path) })), error: null,
      }),
      upload: async (path: string, blob: Blob, _opts?: unknown) => { demo.db.upload(path, blob); return { data: { path }, error: null }; },
      remove: async (paths: string[]) => { paths.forEach((p) => demo.db.removeFile(p)); return { data: [], error: null }; },
    }),
  },
  from: (table: string) => ({
    select: (_cols: string) => ({
      eq: async (col: string, val: string) =>
        table === "collection_items" && col === "image_id"
          ? { data: demo.db.membership(val).map((collection_id) => ({ collection_id })), error: null }
          : { data: [], error: null },
    }),
  }),
};

/** The "delete-image" function is the only Edge Function the demo screens call. */
export async function invoke<T = unknown>(name: string, body: any): Promise<T> {
  try {
    if (name === "delete-image") return demo.db.deleteImage(demo.who, body.image_id) as T;
    throw new DemoError(`demo: ${name} is not part of the demo`);
  } catch (e) {
    throw Object.assign(new Error(dbMessage(e)), { code: "error", extra: {} });
  }
}

/** Hebrew message for the few errors the demo can produce. */
export function dbMessage(e: any): string {
  const m = String(e?.message ?? "");
  if (/suggestion_pending/.test(m)) return "קודם שומרים את ההצעה, ואז אפשר לשתף אותה.";
  if (/already_decided/.test(m)) return "כבר החלטת על ההצעה הזאת.";
  if (/too_many_suggestions/.test(m)) return "נשלחו הרבה תמונות היום. אפשר לשלוח עוד מחר.";
  if (/too_many_collections/.test(m)) return "יש כבר הרבה אוספים. אפשר למחוק אוסף שלא צריך.";
  if (/default_collection/.test(m)) return "אי אפשר למחוק את האוסף הראשי.";
  if (/upload_missing/.test(m)) return "ההעלאה לא הושלמה. כדאי לנסות שוב.";
  if (/not_found|not_allowed/.test(m)) return "לא נמצא. אולי כבר נמחק.";
  if (/check constraint/.test(m)) return "הערך לא תקין (אולי ריק או ארוך מדי).";
  return "הפעולה הזאת לא זמינה בהדגמה.";
}
