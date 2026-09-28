// RLS proofs for phase 1: studios, people, permissions, invites, admin.
// Studio A: painter + "sender" (send only) + "viewer" (view + comment). Studio B: another painter.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { as, createTestDb, S, seed, TestDb, U } from "./harness";

let db: TestDb;
const members = async (studio: string) =>
  (await db.sql(`select user_id, role, can_send, can_view, can_comment, can_generate from public.studio_members where studio_id = $1`, [studio]));

beforeAll(async () => {
  db = await createTestDb();
  await seed(db);
});
afterAll(async () => { await db?.close(); });

describe("reading: everyone sees only their own studio", () => {
  it("anonymous callers are refused on every table", async () => {
    for (const t of ["studios", "studio_members", "profiles", "invites", "app_admins", "app_config", "rate_limits"]) {
      expect(await db.fails(as.anon, `select * from public.${t}`), t).toMatch(/permission denied/);
    }
  });

  it("an outsider (signed in, no studio) sees nothing", async () => {
    for (const t of ["studios", "studio_members"]) {
      expect((await db.as(as.outsider, `select * from public.${t}`)).rows, t).toHaveLength(0);
    }
    expect((await db.as(as.outsider, `select user_id from public.profiles`)).rows).toHaveLength(0);
  });

  it("members read their studio's name, never another studio", async () => {
    for (const a of [as.painter, as.sender, as.viewer]) {
      const { rows } = await db.as(a, `select id from public.studios`);
      expect(rows.map((r) => r.id)).toEqual([S.A]);
    }
    expect((await db.as(as.painterB, `select id from public.studios`)).rows.map((r) => r.id)).toEqual([S.B]);
  });

  it("the painter sees everyone in her studio; family see themselves and the painter only", async () => {
    const p = (await db.as(as.painter, `select user_id from public.studio_members order by user_id`)).rows.map((r) => r.user_id);
    expect(p).toEqual([U.painter, U.sender, U.viewer]);
    const s = (await db.as(as.sender, `select user_id from public.studio_members order by user_id`)).rows.map((r) => r.user_id);
    expect(s).toEqual([U.painter, U.sender]);
    const v = (await db.as(as.viewer, `select user_id from public.studio_members order by user_id`)).rows.map((r) => r.user_id);
    expect(v).toEqual([U.painter, U.viewer]);
  });

  it("profiles follow the same visibility", async () => {
    const s = (await db.as(as.sender, `select user_id from public.profiles order by user_id`)).rows.map((r) => r.user_id);
    expect(s).toEqual([U.painter, U.sender]);
    const b = (await db.as(as.painterB, `select user_id from public.profiles`)).rows.map((r) => r.user_id);
    expect(b).toEqual([U.painterB]);
  });

  it("nobody reads invites, admins, config or rate limits directly — not even the admin", async () => {
    for (const a of [as.painter, as.admin]) {
      for (const t of ["invites", "app_admins", "app_config", "rate_limits"]) {
        expect(await db.fails(a, `select * from public.${t}`), t).toMatch(/permission denied/);
      }
    }
  });

  it("the admin sees no studio content through RLS (only through admin RPCs)", async () => {
    expect((await db.as(as.admin, `select * from public.studios`)).rows).toHaveLength(0);
    expect((await db.as(as.admin, `select * from public.studio_members`)).rows).toHaveLength(0);
  });
});

describe("writing: permissions cannot be changed from the browser", () => {
  it("members cannot grant themselves permissions or change roles", async () => {
    expect(await db.fails(as.sender, `update public.studio_members set can_view = true where user_id = $1`, [U.sender])).toMatch(/permission denied/);
    expect(await db.fails(as.painter, `update public.studio_members set can_generate = true where user_id = $1`, [U.sender])).toMatch(/permission denied/);
    expect((await members(S.A)).find((m) => m.user_id === U.sender)).toMatchObject({ can_view: false, can_generate: false });
  });

  it("nobody inserts or deletes memberships, studios or invites directly", async () => {
    expect(await db.fails(as.outsider, `insert into public.studio_members (studio_id, user_id, role) values ($1, $2, 'family')`, [S.A, U.outsider])).toMatch(/permission denied/);
    expect(await db.fails(as.painter, `delete from public.studio_members where user_id = $1`, [U.sender])).toMatch(/permission denied/);
    expect(await db.fails(as.painter, `insert into public.studios (name) values ('x')`)).toMatch(/permission denied/);
    expect(await db.fails(as.painter, `insert into public.invites (studio_id, token_hash) values ($1, 'h')`, [S.A])).toMatch(/permission denied/);
    expect(await db.fails(as.outsider, `insert into public.app_admins (user_id) values ($1)`, [U.outsider])).toMatch(/permission denied/);
  });

  it("a user edits only their own display name", async () => {
    await db.as(as.sender, `update public.profiles set display_name = 'שם חדש' where user_id = $1`, [U.sender]);
    const { affected } = await db.as(as.sender, `update public.profiles set display_name = 'x' where user_id = $1`, [U.painter]);
    expect(affected).toBe(0);
    expect((await db.sql(`select display_name from public.profiles where user_id = $1`, [U.painter]))[0].display_name).not.toBe("x");
    expect(await db.fails(as.sender, `insert into public.profiles (user_id, display_name) values ($1, 'x')`, [U.outsider])).toMatch(/row-level security/);
  });

  it("the database refuses a second painter in a studio", async () => {
    await expect(db.sql(`update public.studio_members set role = 'painter' where studio_id = $1 and user_id = $2`, [S.A, U.sender]))
      .rejects.toThrow(/studio_one_painter|duplicate key/);
  });
});

describe("has_perm: the painter has everything, family only what was granted", () => {
  const perm = async (a: typeof as.painter, p: string, studio = S.A) =>
    (await db.as(a, `select public.has_perm($1, $2) as ok`, [studio, p])).rows[0].ok;
  it("matches the seeded flags", async () => {
    for (const p of ["send", "view", "comment", "generate"]) expect(await perm(as.painter, p), p).toBe(true);
    expect([await perm(as.sender, "send"), await perm(as.sender, "view"), await perm(as.sender, "comment"), await perm(as.sender, "generate")])
      .toEqual([true, false, false, false]);
    expect([await perm(as.viewer, "send"), await perm(as.viewer, "view"), await perm(as.viewer, "comment"), await perm(as.viewer, "generate")])
      .toEqual([false, true, true, false]);
    expect(await perm(as.painterB, "view", S.A)).toBe(false);
    expect(await perm(as.painter, "nonsense")).toBe(false);
  });
});

describe("admin RPCs require the super-admin at aal2", () => {
  const calls: [string, unknown[]][] = [
    ["select * from public.admin_studios()", []],
    ["select public.admin_create_studio('x')", []],
    ["select * from public.admin_members($1)", [S.A]],
    ["select public.admin_set_member($1, $2, true, true, true, true)", [S.A, U.sender]],
    ["select public.admin_create_invite($1, 'family', true, false, false, false, null)", [S.A]],
    ["select * from public.admin_invites($1)", [S.A]],
  ];
  it("refuses the painter, family, outsiders and the admin without 2FA", async () => {
    for (const [q, p] of calls) {
      for (const a of [as.painter, as.sender, as.outsider, as.admin1]) {
        expect(await db.fails(a, q, p), `${q} as ${a.uid}`).toMatch(/not_admin/);
      }
      expect(await db.fails(as.anon, q, p)).toMatch(/permission denied/);
    }
  });

  it("lists studios with painter name and counts — no content", async () => {
    const { rows } = await db.as(as.admin, `select * from public.admin_studios()`);
    const a = rows.find((r) => r.id === S.A)!;
    expect(a).toMatchObject({ members: 3, open_invites: 1 });
    expect(a.painter_name).toBeTruthy();
  });

  it("lists members with their permissions, painter first", async () => {
    const { rows } = await db.as(as.admin, `select * from public.admin_members($1)`, [S.A]);
    expect(rows.map((r) => r.user_id)).toEqual([U.painter, U.sender, U.viewer]);
    expect(rows[1]).toMatchObject({ role: "family", can_send: true, can_view: false, email: "sender@example.test" });
  });

  it("changes a family member's permissions, never the painter's", async () => {
    await db.as(as.admin, `select public.admin_set_member($1, $2, true, true, false, false)`, [S.A, U.sender]);
    expect((await members(S.A)).find((m) => m.user_id === U.sender)).toMatchObject({ can_send: true, can_view: true, can_comment: false });
    expect(await db.fails(as.admin, `select public.admin_set_member($1, $2, false, false, false, false)`, [S.A, U.painter])).toMatch(/painter_fixed/);
    expect(await db.fails(as.admin, `select public.admin_set_member($1, $2, true, true, true, true)`, [S.A, U.outsider])).toMatch(/not_found/);
    await db.as(as.admin, `select public.admin_set_member($1, $2, true, false, false, false)`, [S.A, U.sender]);
  });

  it("creates, renames and deletes a studio", async () => {
    const id = (await db.as(as.admin, `select public.admin_create_studio('  סטודיו בדיקה  ') as id`)).rows[0].id;
    expect((await db.sql(`select name from public.studios where id = $1`, [id]))[0].name).toBe("סטודיו בדיקה");
    await db.as(as.admin, `select public.admin_rename_studio($1, 'שם אחר')`, [id]);
    expect(await db.fails(as.admin, `select public.admin_create_studio('   ')`)).toMatch(/check/);
    await db.as(as.admin, `select public.admin_delete_studio($1)`, [id]);
    expect(await db.sql(`select 1 from public.studios where id = $1`, [id])).toHaveLength(0);
  });
});

describe("invites", () => {
  const invite = async (role: "painter" | "family", send = false, view = false, comment = false, gen = false, studio = S.A) =>
    (await db.as(as.admin, `select public.admin_create_invite($1, $2, $3, $4, $5, $6, 'אורח') as t`, [studio, role, send, view, comment, gen])).rows[0].t as string;

  it("a family invite gives exactly the chosen permissions, once", async () => {
    const t = await invite("family", false, true, true, false);
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    const info = (await db.as(as.service, `select public.svc_invite_info($1) as i`, [t])).rows[0].i;
    expect(info).toMatchObject({ ok: true, role: "family", can_view: true, can_comment: true, can_send: false });
    const sid = (await db.as(as.newbie, `select public.accept_invite($1, 'אורח חדש') as s`, [t])).rows[0].s;
    expect(sid).toBe(S.A);
    expect((await members(S.A)).find((m) => m.user_id === U.newbie)).toMatchObject({ role: "family", can_send: false, can_view: true, can_comment: true, can_generate: false });
    // idempotent for the same user, refused for anyone else
    expect((await db.as(as.newbie, `select public.accept_invite($1) as s`, [t])).rows[0].s).toBe(S.A);
    expect(await db.fails(as.newbie2, `select public.accept_invite($1)`, [t])).toMatch(/invite_used/);
    expect((await db.as(as.service, `select public.svc_invite_info($1) as i`, [t])).rows[0].i).toMatchObject({ ok: false, reason: "used" });
  });

  it("a painter invite is refused while the studio has a painter", async () => {
    expect(await db.fails(as.admin, `select public.admin_create_invite($1, 'painter', true, true, true, true, null)`, [S.A])).toMatch(/studio_has_painter/);
  });

  it("a painter invite always carries every permission, and a second painter can't slip in", async () => {
    const sid = (await db.as(as.admin, `select public.admin_create_studio('סטודיו חדש') as id`)).rows[0].id;
    const t1 = await invite("painter", false, false, false, false, sid);
    const t2 = await invite("painter", false, false, false, false, sid);
    await db.as(as.newbie2, `select public.accept_invite($1)`, [t1]);
    expect((await members(sid))[0]).toMatchObject({ role: "painter", can_send: true, can_view: true, can_comment: true, can_generate: true });
    expect(await db.fails(as.outsider, `select public.accept_invite($1)`, [t2])).toMatch(/studio_has_painter/);
  });

  it("claimed e-mail, expiry and revocation are enforced", async () => {
    const t = await invite("family", true);
    expect((await db.as(as.service, `select public.svc_claim_invite($1, ' Someone@Example.Test ') as r`, [t])).rows[0].r).toEqual({ ok: true });
    expect((await db.as(as.service, `select public.svc_claim_invite($1, 'other@example.test') as r`, [t])).rows[0].r).toMatchObject({ ok: false, reason: "claimed" });
    expect(await db.fails(as.outsider, `select public.accept_invite($1)`, [t])).toMatch(/invite_other_email/);

    const t2 = await invite("family", true);
    await db.sql(`update public.invites set expires_at = now() - interval '1 minute' where token_hash = public.token_hash($1)`, [t2]);
    expect(await db.fails(as.outsider, `select public.accept_invite($1)`, [t2])).toMatch(/invite_invalid/);
    expect((await db.as(as.service, `select public.svc_invite_info($1) as i`, [t2])).rows[0].i).toMatchObject({ reason: "expired" });

    const t3 = await invite("family", true);
    const id = (await db.as(as.admin, `select id from public.admin_invites($1) where status = 'open' order by created_at desc limit 1`, [S.A])).rows[0].id;
    await db.as(as.admin, `select public.admin_revoke_invite($1)`, [id]);
    expect(await db.fails(as.outsider, `select public.accept_invite($1)`, [t3])).toMatch(/invite_invalid/);
    expect(await db.fails(as.anon, `select public.accept_invite($1)`, [t3])).toMatch(/permission denied/);
    expect(await db.fails(as.outsider, `select public.accept_invite('not-a-real-token')`)).toMatch(/invite_invalid/);
  });

  it("removing a member ends their access", async () => {
    await db.as(as.admin, `select public.admin_remove_member($1, $2)`, [S.A, U.newbie]);
    expect((await db.as(as.newbie, `select * from public.studios`)).rows).toHaveLength(0);
  });
});

describe("two-factor", () => {
  it("someone with a verified factor must use it (aal1 sees nothing)", async () => {
    await db.sql(`insert into auth.mfa_factors (id, user_id, factor_type, status) values (gen_random_uuid(), $1, 'totp', 'verified')`, [U.viewer]);
    expect((await db.as(as.viewer, `select * from public.studios`)).rows).toHaveLength(0);
    expect((await db.as({ ...as.viewer, aal: "aal2" }, `select * from public.studios`)).rows).toHaveLength(1);
    await db.sql(`delete from auth.mfa_factors where user_id = $1`, [U.viewer]);
  });

  it("an unverified (half-finished) factor never locks anyone out", async () => {
    await db.sql(`insert into auth.mfa_factors (id, user_id, factor_type, status) values (gen_random_uuid(), $1, 'totp', 'unverified')`, [U.sender]);
    expect((await db.as(as.sender, `select * from public.studios`)).rows).toHaveLength(1);
  });
});

describe("service functions", () => {
  it("svc_* are not callable from the browser", async () => {
    for (const q of [`select public.svc_invite_info('x')`, `select public.svc_claim_invite('x', 'y@example.test')`,
      `select public.svc_rate_limit('k', 'b', 1, 60)`, `select public.svc_access($1, $2, 'aal1')`]) {
      expect(await db.fails(as.painter, q, q.includes("$1") ? [S.A, U.painter] : []), q).toMatch(/permission denied/);
    }
  });

  it("svc_access reports role and permissions", async () => {
    const a = (await db.as(as.service, `select public.svc_access($1, $2, 'aal1') as a`, [S.A, U.viewer])).rows[0].a;
    expect(a).toMatchObject({ role: "family", can_view: true, can_send: false, mfa_ok: true });
    const none = (await db.as(as.service, `select public.svc_access($1, $2, 'aal1') as a`, [S.B, U.viewer])).rows[0].a;
    expect(none.role).toBeNull();
  });

  it("rate limit counts per window", async () => {
    const hit = async () => (await db.as(as.service, `select public.svc_rate_limit('k1', 'b', 2, 3600) as ok`)).rows[0].ok;
    expect([await hit(), await hit(), await hit()]).toEqual([true, true, false]);
  });
});
