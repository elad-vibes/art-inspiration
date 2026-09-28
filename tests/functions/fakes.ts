// Fake dependencies for Edge Function tests: an in-memory stand-in for the svc_*
// RPCs, fake token verification and a recording logger. No network, no paid calls.
import type { Claims, Deps } from "../../supabase/functions/_shared/deps.ts";
import { NAMES } from "../fixtures/synthetic.ts";

export const STUDIO = "11111111-1111-4111-8111-111111111111";
export const USER = "22222222-2222-4222-8222-222222222222";
export const ORIGIN = "https://elad-vibes.github.io";
export const CRON_SECRET = "cron-secret-for-tests-only-0123456789";
export const IMAGE = "33333333-3333-4333-8333-333333333333";

export interface FakeState {
  access: Record<string, unknown> | null;
  rateOk: boolean;
  rpcCalls: { fn: string; args: any }[];
  logs: string[];
  invite: any;
  claim: any;
  admin: string[];
  /** What delete_image returns for the caller (a path, or null = a hidden web picture). */
  deleteResult: string | null;
  /** Makes userRpc fail with this database message (e.g. "not_found"). */
  userError: string | null;
  /** Storage removal fails (all paths). */
  storageFails: boolean;
  /** Paths the cleanup queue hands out. */
  batch: string[];
  storageCalls: string[][];
  userCalls: { token: string; fn: string; args: any }[];
}

export function makeDeps(over: Partial<FakeState> = {}) {
  const s: FakeState = {
    access: { role: "family", can_send: true, can_view: false, can_comment: false, can_generate: false, mfa_ok: true },
    rateOk: true,
    rpcCalls: [],
    logs: [],
    invite: { ok: true, studio_name: NAMES.studioA, role: "family", person_name: NAMES.daughter, can_send: true, can_view: true, can_comment: false, can_generate: false },
    claim: { ok: true },
    admin: [],
    deleteResult: null,
    userError: null,
    storageFails: false,
    batch: [],
    storageCalls: [],
    userCalls: [],
    ...over,
  };

  const tokens: Record<string, Claims> = {
    "tok-aal1": { sub: USER, email: "user@example.test", aal: "aal1", role: "authenticated" },
    "tok-aal2": { sub: USER, email: "user@example.test", aal: "aal2", role: "authenticated" },
  };

  const rpc = async (fn: string, args: any): Promise<any> => {
    s.rpcCalls.push({ fn, args });
    switch (fn) {
      case "svc_access": return s.access;
      case "svc_rate_limit": return s.rateOk;
      case "svc_invite_info": return s.invite;
      case "svc_claim_invite": return s.claim;
      case "svc_cleanup_batch": return s.batch;
      default: return null;
    }
  };

  const deps: Deps = {
    env: {
      allowedOrigins: [ORIGIN, "http://localhost:5173"],
      requireOrigin: true,
      appUrl: "https://elad-vibes.github.io/painting-inspiration/",
      cronSecret: CRON_SECRET,
    },
    verifyJwt: async (t) => tokens[t] ?? null,
    rpc,
    userRpc: async (token, fn, args) => {
      s.userCalls.push({ token, fn, args });
      if (s.userError) throw Object.assign(new Error("user rpc failed"), { code: "P0002", pgMessage: s.userError });
      return s.deleteResult as any;
    },
    storage: {
      remove: async (paths) => {
        s.storageCalls.push(paths);
        if (s.storageFails) throw new Error("storage_remove_failed");
      },
    },
    admin: {
      createUser: async (email) => { s.admin.push(`create:${email}`); return "created"; },
    },
    log: (event, fields = {}) => { s.logs.push(JSON.stringify({ event, ...fields })); },
    now: () => new Date("2026-09-28T10:00:00Z"),
  };
  return { deps, s };
}

export function req(body: unknown, opts: { token?: string; origin?: string | null; method?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers ?? {}) };
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  return new Request("https://example.supabase.co/functions/v1/x", {
    method: opts.method ?? "POST",
    headers,
    body: opts.method === "OPTIONS" || opts.method === "GET" ? undefined : JSON.stringify(body),
  });
}

export const call = async (h: (r: Request) => Promise<Response>, r: Request) => {
  const res = await h(r);
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
};
