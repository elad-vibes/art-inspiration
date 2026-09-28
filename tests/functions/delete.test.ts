// delete-image and storage-cleanup, with fake dependencies (no network, no Storage).
import { describe, expect, it } from "vitest";
import { createDeleteHandler } from "../../supabase/functions/_shared/handlers/delete.ts";
import { createCleanupHandler } from "../../supabase/functions/_shared/handlers/cleanup.ts";
import { call, CRON_SECRET, IMAGE, makeDeps, ORIGIN, req } from "./fakes.ts";

const PATH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/cccccccc-cccc-4ccc-8ccc-cccccccccccc.webp";
const ok = (extra: object = {}) => req({ image_id: IMAGE, ...extra }, { token: "tok-aal1" });

describe("delete-image", () => {
  it("calls delete_image AS THE CALLER (their own token), never with the service role", async () => {
    const { deps, s } = makeDeps({ deleteResult: PATH });
    const r = await call(createDeleteHandler(deps), ok());
    expect(r.status).toBe(200);
    expect(s.userCalls).toEqual([{ token: "tok-aal1", fn: "delete_image", args: { p_image: IMAGE } }]);
    expect(s.rpcCalls.map((c) => c.fn)).not.toContain("delete_image");
  });

  it("a real delete: removes the file, takes it off the waiting list, says so", async () => {
    const { deps, s } = makeDeps({ deleteResult: PATH });
    const r = await call(createDeleteHandler(deps), ok());
    expect(r.body).toEqual({ ok: true, mode: "deleted", cleanup: "done" });
    expect(s.storageCalls[0]).toEqual([PATH]);
    expect(s.rpcCalls.find((c) => c.fn === "svc_cleanup_done")!.args.p_paths).toEqual([PATH]);
    expect(s.rpcCalls.map((c) => c.fn)).not.toContain("svc_cleanup_failed");
  });

  it("a web picture is only hidden: no Storage call at all", async () => {
    const { deps, s } = makeDeps({ deleteResult: null });
    const r = await call(createDeleteHandler(deps), ok());
    expect(r.body).toEqual({ ok: true, mode: "hidden", cleanup: "none" });
    expect(s.storageCalls).toHaveLength(0);
    expect(s.rpcCalls.map((c) => c.fn)).not.toContain("svc_cleanup_done");
  });

  it("when Storage fails the picture is still deleted; the file is marked 'waiting for cleanup'", async () => {
    const { deps, s } = makeDeps({ deleteResult: PATH, storageFails: true });
    const r = await call(createDeleteHandler(deps), ok());
    expect(r.status).toBe(200);                                                   // the delete itself succeeded
    expect(r.body).toEqual({ ok: true, mode: "deleted", cleanup: "pending" });
    const failed = s.rpcCalls.find((c) => c.fn === "svc_cleanup_failed")!;
    expect(failed.args.p_paths).toEqual([PATH]);
    expect(failed.args.p_error).toBe("storage_remove_failed");
    expect(s.rpcCalls.map((c) => c.fn)).not.toContain("svc_cleanup_done");
  });

  it("older leftovers get another go after each delete", async () => {
    const older = "dddddddd-dddd-4ddd-8ddd-dddddddddddd/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/ffffffff-ffff-4fff-8fff-ffffffffffff.jpg";
    const { deps, s } = makeDeps({ deleteResult: PATH, batch: [older] });
    await call(createDeleteHandler(deps), ok());
    expect(s.rpcCalls.find((c) => c.fn === "svc_cleanup_batch")!.args.p_limit).toBe(5);
    expect(s.storageCalls).toEqual([[PATH], [older]]);
  });

  it("a hiccup marking the queue never turns a finished delete into an error", async () => {
    const { deps } = makeDeps({ deleteResult: PATH });
    const base = deps.rpc;
    deps.rpc = async (fn, args) => { if (fn.startsWith("svc_cleanup")) throw new Error("db down"); return base(fn, args); };
    const r = await call(createDeleteHandler(deps), ok());
    expect(r.status).toBe(200);
  });

  it("the database's refusals become clear Hebrew errors (not the owner / no second factor)", async () => {
    for (const [pg, status, text] of [["not_found", 404, /לא נמצאה/], ["mfa_required", 403, /קוד/], ["not_authenticated", 401, /להתחבר/], ["not_allowed", 403, /הרשאה/]] as const) {
      const { deps, s } = makeDeps({ userError: pg });
      const r = await call(createDeleteHandler(deps), ok());
      expect(r.status, pg).toBe(status);
      expect(r.body.message, pg).toMatch(text);
      expect(s.storageCalls, pg).toHaveLength(0);                                 // a refused delete touches no file
    }
  });

  it("an unknown database failure is a 500 with no details", async () => {
    const { deps } = makeDeps({ userError: "relation public.secret_table does not exist" });
    const r = await call(createDeleteHandler(deps), ok());
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toMatch(/secret_table/);
  });

  it("needs a session, a valid image id, the app's origin, and POST", async () => {
    const { deps, s } = makeDeps({ deleteResult: PATH });
    const h = createDeleteHandler(deps);
    expect((await call(h, req({ image_id: IMAGE }))).status).toBe(401);                                    // no token
    expect((await call(h, req({ image_id: IMAGE }, { token: "nope" }))).status).toBe(401);                 // bad token
    expect((await call(h, req({ image_id: "not-a-uuid" }, { token: "tok-aal1" }))).status).toBe(400);
    expect((await call(h, req({}, { token: "tok-aal1" }))).status).toBe(400);
    expect((await call(h, req({ image_id: IMAGE }, { token: "tok-aal1", origin: "https://evil.example" }))).status).toBe(403);
    expect((await call(h, req({ image_id: IMAGE }, { token: "tok-aal1", origin: null }))).status).toBe(403);
    expect((await call(h, req({ image_id: IMAGE }, { token: "tok-aal1", method: "GET" }))).status).toBe(405);
    expect(s.userCalls).toHaveLength(0);
    expect((await call(h, req({}, { method: "OPTIONS", origin: ORIGIN }))).status).toBe(204);
  });

  it("rate limits per signed-in user", async () => {
    const { deps, s } = makeDeps({ deleteResult: PATH, rateOk: false });
    const r = await call(createDeleteHandler(deps), ok());
    expect(r.status).toBe(429);
    expect(s.rpcCalls.find((c) => c.fn === "svc_rate_limit")!.args.p_key).toMatch(/^user:/);
    expect(s.userCalls).toHaveLength(0);
  });

  it("logs no image id, path or token", async () => {
    const { deps, s } = makeDeps({ deleteResult: PATH, storageFails: true });
    await call(createDeleteHandler(deps), ok());
    const logs = s.logs.join("\n");
    expect(logs).not.toContain(IMAGE);
    expect(logs).not.toContain(PATH);
    expect(logs).not.toContain("tok-aal1");
    expect(logs).not.toMatch(/aaaaaaaa/);
  });
});

describe("storage-cleanup (the retry)", () => {
  const cron = (secret: string | null = CRON_SECRET) =>
    req({}, { origin: null, headers: secret === null ? {} : { "x-cron-secret": secret } });

  it("removes the waiting files and clears them from the queue", async () => {
    const { deps, s } = makeDeps({ batch: [PATH] });
    const r = await call(createCleanupHandler(deps), cron());
    expect(r.body).toEqual({ ok: true, removed: 1, failed: 0 });
    expect(s.storageCalls).toEqual([[PATH]]);
    expect(s.rpcCalls.find((c) => c.fn === "svc_cleanup_done")!.args.p_paths).toEqual([PATH]);
    expect(s.rpcCalls.find((c) => c.fn === "svc_cleanup_batch")!.args.p_limit).toBe(100);
  });

  it("a failure keeps them waiting (marked, retried later) — and the run still answers 200", async () => {
    const { deps, s } = makeDeps({ batch: [PATH], storageFails: true });
    const r = await call(createCleanupHandler(deps), cron());
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, removed: 0, failed: 1 });
    expect(s.rpcCalls.find((c) => c.fn === "svc_cleanup_failed")!.args.p_paths).toEqual([PATH]);
  });

  it("nothing waiting: no Storage call", async () => {
    const { deps, s } = makeDeps({ batch: [] });
    expect((await call(createCleanupHandler(deps), cron())).body).toEqual({ ok: true, removed: 0, failed: 0 });
    expect(s.storageCalls).toHaveLength(0);
  });

  it("needs the secret: missing, wrong, or a browser with a good origin but no secret are all refused", async () => {
    const { deps, s } = makeDeps({ batch: [PATH] });
    const h = createCleanupHandler(deps);
    expect((await call(h, cron(null))).status).toBe(401);
    expect((await call(h, cron("wrong"))).status).toBe(401);
    expect((await call(h, cron(CRON_SECRET + "x"))).status).toBe(401);
    expect((await call(h, req({}, { token: "tok-aal2" }))).status).toBe(401);                  // a signed-in user isn't the scheduler
    expect(s.storageCalls).toHaveLength(0);
    expect(s.rpcCalls.map((c) => c.fn)).not.toContain("svc_cleanup_batch");
  });

  it("with no secret configured the function is switched off, even for an empty header", async () => {
    const { deps, s } = makeDeps({ batch: [PATH] });
    deps.env.cronSecret = "";
    const h = createCleanupHandler(deps);
    expect((await call(h, cron(""))).status).toBe(401);
    expect((await call(h, cron(null))).status).toBe(401);
    expect(s.storageCalls).toHaveLength(0);
  });

  it("logs counts only — never a path or the secret", async () => {
    const { deps, s } = makeDeps({ batch: [PATH], storageFails: true });
    await call(createCleanupHandler(deps), cron());
    const logs = s.logs.join("\n");
    expect(logs).not.toContain(PATH);
    expect(logs).not.toContain(CRON_SECRET);
    expect(logs).toMatch(/cleanup_run/);
  });
});
