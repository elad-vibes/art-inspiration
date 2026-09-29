// Data access. All reads/writes go through RLS with the user's session.
import { sb, invoke } from "./lib/supa.ts";
import { S, type Studio } from "./state.ts";

const SID_KEY = "pi-sid";

export async function refreshAal() {
  const { data } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
  S.aal = { current: data?.currentLevel ?? "aal1", next: data?.nextLevel ?? "aal1" };
  const { data: f } = await sb.auth.mfa.listFactors();
  S.hasFactor = !!f?.all?.some((x: any) => x.status === "verified" && x.factor_type !== "recovery_code");
}

export async function loadStudios() {
  const { data, error } = await sb.from("studio_members")
    .select("studio_id, role, can_send, can_view, can_comment, can_generate, studios(name)")
    .eq("user_id", S.user!.id);
  if (error) throw error;
  S.studios = (data ?? []).map((r: any): Studio => ({
    id: r.studio_id, name: r.studios?.name ?? "", role: r.role,
    perms: { can_send: r.can_send, can_view: r.can_view, can_comment: r.can_comment, can_generate: r.can_generate },
  }));
  const saved = localStorage.getItem(SID_KEY);
  S.sid = (S.studios.find((s) => s.id === saved) ?? S.studios[0])?.id ?? null;
  const [{ data: adm }, { data: me }] = await Promise.all([
    sb.rpc("am_i_admin"),
    sb.from("profiles").select("display_name").eq("user_id", S.user!.id).maybeSingle(),
  ]);
  S.isAdmin = !!adm;
  S.myName = me?.display_name ?? "";
  await loadPainterName();
}

export async function loadPainterName() {
  S.painterName = "";
  if (!S.sid) return;
  const { data: p } = await sb.from("studio_members").select("user_id").eq("studio_id", S.sid).eq("role", "painter").maybeSingle();
  if (!p) return;
  const { data: prof } = await sb.from("profiles").select("display_name").eq("user_id", p.user_id).maybeSingle();
  S.painterName = prof?.display_name ?? "";
}

export async function chooseStudio(id: string) {
  if (!S.studios.some((s) => s.id === id)) return;
  S.sid = id;
  localStorage.setItem(SID_KEY, id);
  await loadPainterName();
}

/** "mfa-challenge" when this account has a second factor that this session didn't use yet. */
export async function bootStudio(): Promise<"ok" | "none" | "mfa-challenge"> {
  await refreshAal();
  if (S.hasFactor && S.aal.current !== "aal2") return "mfa-challenge";
  await loadStudios();
  return S.studios.length ? "ok" : "none";
}

export async function saveMyName(name: string) {
  const v = name.trim().slice(0, 40);
  // update, then insert if there was no profile yet (an upsert would need UPDATE on user_id, which is not granted)
  const { data, error } = await sb.from("profiles").update({ display_name: v }).eq("user_id", S.user!.id).select("user_id");
  if (error) throw error;
  if (!data?.length) {
    const { error: e2 } = await sb.from("profiles").insert({ user_id: S.user!.id, display_name: v });
    if (e2) throw e2;
  }
  S.myName = v;
}

export const fn = {
  inviteInfo: (token: string) => invoke<{
    studio_name: string; role: "painter" | "family"; person_name: string | null;
    can_send: boolean; can_view: boolean; can_comment: boolean; can_generate: boolean;
  }>("invite-signin", { action: "info", token }),
  inviteClaim: (token: string, email: string) => invoke("invite-signin", { action: "claim", token, email }),
};
