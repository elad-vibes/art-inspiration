// Removing files from Storage and keeping the "waiting for cleanup" queue honest.
// A file is queued in the database in the same transaction that deletes its picture
// (0008), so whatever happens here — Storage down, the function killed half way —
// the path is still on the list and a later run removes it.
import type { Deps } from "./deps.ts";

/**
 * Tries to remove the files, then tells the database what happened: removed ones
 * leave the queue, failed ones stay ("waiting for cleanup") with one more attempt
 * on record, so the next run waits longer. Never throws: the picture is already
 * deleted, and this is only the file part.
 */
export async function removeAndMark(deps: Deps, paths: string[]): Promise<{ removed: number; failed: number }> {
  if (!paths.length) return { removed: 0, failed: 0 };
  let ok = true;
  let reason = "storage_error";
  try {
    await deps.storage.remove(paths);
  } catch (e) {
    ok = false;
    reason = (e as Error)?.message?.slice(0, 60) || reason;   // our own short code, never a path
  }
  try {
    if (ok) await deps.rpc("svc_cleanup_done", { p_paths: paths });
    else await deps.rpc("svc_cleanup_failed", { p_paths: paths, p_error: reason });
  } catch {
    // the file part is done or will be retried either way; the queue row is the safety net
    deps.log("cleanup_mark_failed", { count: paths.length });
  }
  return ok ? { removed: paths.length, failed: 0 } : { removed: 0, failed: paths.length };
}

/** Takes the next due files from the queue (retries, orphans) and removes them. */
export async function drainQueue(deps: Deps, limit: number): Promise<{ removed: number; failed: number }> {
  let paths: string[] = [];
  try {
    paths = (await deps.rpc<string[] | null>("svc_cleanup_batch", { p_limit: limit })) ?? [];
  } catch {
    deps.log("cleanup_batch_failed");
    return { removed: 0, failed: 0 };
  }
  const r = await removeAndMark(deps, paths);
  if (paths.length) deps.log("cleanup_run", { removed: r.removed, failed: r.failed });
  return r;
}
