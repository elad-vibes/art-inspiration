// storage-cleanup: the retry. Called on a schedule (every ~15 minutes) with a shared
// secret; removes files that are waiting for cleanup — leftovers of a failed
// removal, old uploads that never became a picture, files of a deleted studio.
// No user is involved, so there is no origin and no session: the secret is the credential.
import { CLEANUP } from "../config.ts";
import type { Deps } from "../deps.ts";
import { endpoint, HttpError, safeEqual } from "../http.ts";
import { drainQueue } from "../storageCleanup.ts";

export function createCleanupHandler(deps: Deps) {
  return endpoint(deps, "storage-cleanup", async (req) => {
    const secret = req.headers.get("x-cron-secret") ?? "";
    // no secret configured = switched off (never "open")
    if (!deps.env.cronSecret || !safeEqual(secret, deps.env.cronSecret)) {
      throw new HttpError(401, "bad_secret", "לא מורשה.");
    }
    const r = await drainQueue(deps, CLEANUP.scheduled);
    return { ok: true, ...r };
  }, { allowNoOrigin: true, maxBytes: 1024 });
}
