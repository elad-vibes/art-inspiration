// Authentication, studio membership + permissions + two-factor, and rate limits.
import type { Claims, Deps } from "./deps.ts";
import { HttpError } from "./http.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === "string" && UUID.test(s);

export async function caller(req: Request, deps: Deps): Promise<Claims> {
  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) throw new HttpError(401, "no_session", "צריך להתחבר מחדש.");
  const claims = await deps.verifyJwt(m[1].trim());
  if (!claims || !isUuid(claims.sub) || (claims.role && claims.role !== "authenticated")) {
    throw new HttpError(401, "bad_session", "צריך להתחבר מחדש.");
  }
  return claims;
}

export type Perm = "send" | "view" | "comment" | "generate";
type Access = { role: string | null; mfa_ok: boolean } & Record<`can_${Perm}`, boolean>;

/** Membership + one permission + the same two-factor rule the RLS policies use. */
export async function requireAccess(deps: Deps, studio: unknown, claims: Claims, need: Perm | null): Promise<Access> {
  if (!isUuid(studio)) throw new HttpError(400, "bad_studio", "חסר מזהה סטודיו.");
  const a = await deps.rpc<Access>("svc_access", { p_studio: studio, p_user: claims.sub, p_aal: claims.aal ?? "aal1" });
  if (!a || !a.role) throw new HttpError(403, "not_member", "אין לך גישה לסטודיו הזה.");
  if (!a.mfa_ok) throw new HttpError(403, "mfa_required", "צריך להזין קוד מאפליקציית האימות.");
  if (need && !a[`can_${need}`]) throw new HttpError(403, "no_permission", "אין לך הרשאה לפעולה הזאת.");
  return a;
}

export async function rateLimit(deps: Deps, key: string, bucket: string, [max, windowSecs]: [number, number]) {
  const ok = await deps.rpc<boolean>("svc_rate_limit", { p_key: key, p_bucket: bucket, p_max: max, p_window_secs: windowSecs });
  if (!ok) throw new HttpError(429, "rate_limited", "יותר מדי בקשות בזמן קצר. אפשר לנסות שוב בעוד כמה דקות.");
}

/**
 * The caller's IP for rate limiting. cf-connecting-ip is set by the edge proxy;
 * otherwise the LAST x-forwarded-for hop (the one added by our proxy) — the
 * first entries can be supplied by the client and must not be trusted.
 */
export function clientIp(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const hops = (req.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return hops[hops.length - 1] || "unknown";
}
