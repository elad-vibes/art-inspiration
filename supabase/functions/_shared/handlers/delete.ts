// delete-image: the one server function that deletes a picture (ART-PLAN, phase 2b).
//
// The permission check is the database's, not ours: the caller's own token is used
// to call delete_image, so only the painter of that studio, with the two-factor
// rule satisfied, gets anywhere. A web picture is only hidden (no file, no cost);
// any other picture is deleted for real, its file path is queued in the same
// transaction, and then removed from Storage right here. If Storage fails, the
// picture is still deleted — the file waits in the cleanup queue and is retried
// by storage-cleanup (and by the next delete).
import { CLEANUP, RATE } from "../config.ts";
import type { Deps } from "../deps.ts";
import { bearerToken, caller, isUuid, rateLimit } from "../guard.ts";
import { endpoint, HttpError } from "../http.ts";
import { drainQueue, removeAndMark } from "../storageCleanup.ts";

/** Database errors we know, in Hebrew. Anything else is a plain 500. */
function dbError(e: unknown): HttpError | null {
  const m = String((e as any)?.pgMessage ?? "");
  if (/not_found/.test(m)) return new HttpError(404, "not_found", "התמונה לא נמצאה. אולי כבר נמחקה.");
  if (/mfa_required/.test(m)) return new HttpError(403, "mfa_required", "צריך להזין קוד מאפליקציית האימות.");
  if (/not_authenticated/.test(m)) return new HttpError(401, "bad_session", "צריך להתחבר מחדש.");
  if (/not_allowed/.test(m)) return new HttpError(403, "no_permission", "אין לך הרשאה לפעולה הזאת.");
  return null;
}

export function createDeleteHandler(deps: Deps) {
  return endpoint(deps, "delete-image", async (req, body) => {
    const claims = await caller(req, deps);
    const token = bearerToken(req);
    if (!isUuid(body.image_id)) throw new HttpError(400, "bad_image", "חסר מזהה תמונה.");
    await rateLimit(deps, `user:${claims.sub}`, "delete", RATE.deleteUser);

    let path: string | null;
    try {
      path = await deps.userRpc<string | null>(token, "delete_image", { p_image: body.image_id });
    } catch (e) {
      throw dbError(e) ?? e;
    }

    // A web picture has no file: it was only hidden, and can be restored.
    if (path === null) return { ok: true, mode: "hidden", cleanup: "none" };

    const r = await removeAndMark(deps, [path]);
    await drainQueue(deps, CLEANUP.afterDelete);            // give older leftovers another go
    deps.log("image_deleted", { file_removed: r.failed === 0 });
    return { ok: true, mode: "deleted", cleanup: r.failed === 0 ? "done" : "pending" };
  }, { allowNoOrigin: false, maxBytes: 2048 });
}
