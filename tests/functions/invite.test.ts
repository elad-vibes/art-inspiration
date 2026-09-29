// invite-signin + the shared guard, with fake dependencies (no network).
import { describe, expect, it } from "vitest";
import { createInviteHandler } from "../../supabase/functions/_shared/handlers/invite.ts";
import { caller, requireAccess } from "../../supabase/functions/_shared/guard.ts";
import { endpoint } from "../../supabase/functions/_shared/http.ts";
import { call, makeDeps, ORIGIN, req, STUDIO } from "./fakes.ts";
import { NAMES } from "../fixtures/synthetic.ts";

const token = "a".repeat(64);

describe("invite-signin", () => {
  it("shows the studio name and the permissions of a valid invite", async () => {
    const { deps } = makeDeps();
    const r = await call(createInviteHandler(deps), req({ action: "info", token }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      ok: true, studio_name: NAMES.studioA, role: "family", person_name: NAMES.daughter,
      can_send: true, can_view: true, can_comment: false, can_generate: false,
    });
  });

  it("explains used / expired invites in Hebrew", async () => {
    for (const [reason, text] of [["expired", /תוקף/], ["used", /כבר שימש/], ["invalid", /לא תקין/]] as const) {
      const { deps } = makeDeps({ invite: { ok: false, reason } });
      const r = await call(createInviteHandler(deps), req({ action: "info", token }));
      expect(r.status).toBe(410);
      expect(r.body.message).toMatch(text);
    }
  });

  it("claims the invite and creates the account (normalised e-mail)", async () => {
    const { deps, s } = makeDeps();
    const r = await call(createInviteHandler(deps), req({ action: "claim", token, email: " Mom@Example.Test " }));
    expect(r.body).toEqual({ ok: true });
    expect(s.admin).toEqual(["create:mom@example.test"]);
    expect(s.logs.join()).not.toMatch(/example\.test/); // no e-mail in logs
  });

  it("does not create an account if the invite is bound to another e-mail", async () => {
    const { deps, s } = makeDeps({ claim: { ok: false, reason: "claimed" } });
    const r = await call(createInviteHandler(deps), req({ action: "claim", token, email: "x@example.test" }));
    expect(r.status).toBe(410);
    expect(s.admin).toHaveLength(0);
  });

  it("validates token, e-mail and action", async () => {
    const { deps } = makeDeps();
    const h = createInviteHandler(deps);
    expect((await call(h, req({ action: "info", token: "short" }))).status).toBe(400);
    expect((await call(h, req({ action: "claim", token, email: "not-an-email" }))).status).toBe(400);
    expect((await call(h, req({ action: "other", token }))).status).toBe(400);
  });

  it("rate limits by the proxy-added IP, not a client-supplied one", async () => {
    const { deps, s } = makeDeps();
    await call(createInviteHandler(deps), req({ action: "info", token }, { headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.9" } }));
    expect(s.rpcCalls.find((c) => c.fn === "svc_rate_limit")!.args.p_key).toBe("ip:203.0.113.9");
    const limited = makeDeps({ rateOk: false });
    expect((await call(createInviteHandler(limited.deps), req({ action: "info", token }))).status).toBe(429);
  });

  it("answers only the app origin (CORS) and only POST", async () => {
    const { deps } = makeDeps();
    const h = createInviteHandler(deps);
    const ok = await h(req(null, { method: "OPTIONS" }));
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect((await h(req(null, { method: "OPTIONS", origin: "https://evil.example" }))).status).toBe(403);
    expect((await call(h, req({ action: "info", token }, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await call(h, req({ action: "info", token }, { origin: null }))).status).toBe(403);
    expect((await call(h, req({ action: "info", token }, { method: "GET" }))).status).toBe(405);
  });
});

describe("guard (for the image endpoints of the next phases)", () => {
  const probe = (deps: ReturnType<typeof makeDeps>["deps"], need: "send" | "view" | null) =>
    endpoint(deps, "probe", async (r, body) => {
      const claims = await caller(r, deps);
      const a = await requireAccess(deps, body.studio_id, claims, need);
      return { role: a.role };
    });

  it("refuses missing / forged sessions", async () => {
    const { deps } = makeDeps();
    expect((await call(probe(deps, null), req({ studio_id: STUDIO }))).status).toBe(401);
    expect((await call(probe(deps, null), req({ studio_id: STUDIO }, { token: "forged" }))).status).toBe(401);
  });

  it("refuses non-members, missing permissions and sessions that still need the 2nd factor", async () => {
    const cases: [Record<string, unknown> | null, "send" | "view", string][] = [
      [{ role: null, mfa_ok: true }, "send", "not_member"],
      [{ role: "family", can_send: true, can_view: false, mfa_ok: true }, "view", "no_permission"],
      [{ role: "family", can_send: true, mfa_ok: false }, "send", "mfa_required"],
    ];
    for (const [access, need, code] of cases) {
      const { deps } = makeDeps({ access });
      const r = await call(probe(deps, need), req({ studio_id: STUDIO }, { token: "tok-aal1" }));
      expect(r.status).toBe(403);
      expect(r.body.error).toBe(code);
    }
  });

  it("lets a member with the permission through, and checks the studio id shape", async () => {
    const { deps, s } = makeDeps();
    expect((await call(probe(deps, "send"), req({ studio_id: STUDIO }, { token: "tok-aal2" }))).body).toEqual({ role: "family" });
    expect(s.rpcCalls.find((c) => c.fn === "svc_access")!.args).toMatchObject({ p_studio: STUDIO, p_aal: "aal2" });
    expect((await call(probe(deps, "send"), req({ studio_id: "nope" }, { token: "tok-aal2" }))).status).toBe(400);
  });
});
