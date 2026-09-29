// מסך ניהול (super-admin): studios, people, permissions and invite links.
// Never images, notes or prompts — the database doesn't give them to this screen
// (DECISIONS 5). Usage, quotas and estimated spend arrive in phase 7.
import { attr, html, type SafeHtml, $ } from "../lib/html.ts";
import { armed2, isArmed, on } from "../lib/events.ts";
import { appUrl, dbMessage, sb } from "../lib/supa.ts";
import { S, flash, rerender } from "../state.ts";
import { normalize, PERM_LABEL, PERMS, type Perms, PRESETS, presetOf, presetPerms, type PresetId, type Role } from "../domain/perms.ts";
import { banner, copyText, fmtDate, shareLink } from "./common.ts";
import { icon } from "./icons.ts";

interface StudioRow { id: string; name: string; created_at: string; painter_name: string | null; members: number; open_invites: number }
interface MemberRow extends Perms { user_id: string; display_name: string; email: string; role: Role; joined_at: string }
interface InviteRow extends Perms { id: string; role: Role; person_name: string | null; created_at: string; expires_at: string; claimed_email: string | null; status: string }

interface AdminState {
  studios: StudioRow[] | null;
  open: string | null;                    // studio being managed
  members: MemberRow[];
  invites: InviteRow[];
  draft: { role: Role; perms: Perms; name: string };
  link: { url: string; who: string } | null;
  err?: string;
}
const X = () => (S.extra.admin ??= {
  studios: null, open: null, members: [], invites: [],
  draft: { role: "family", perms: presetPerms("sender"), name: "" }, link: null,
}) as AdminState;

export async function loadAdmin() {
  const x = X();
  const { data, error } = await sb.rpc("admin_studios");
  if (error) { x.err = dbMessage(error); rerender(); return; }
  x.studios = data ?? [];
  x.err = undefined;
  if (!x.open && x.studios!.length === 1) x.open = x.studios![0].id;
  if (x.open) await loadStudio(x.open); else rerender();
}

async function loadStudio(id: string) {
  const x = X();
  const [m, i] = await Promise.all([sb.rpc("admin_members", { p_studio: id }), sb.rpc("admin_invites", { p_studio: id })]);
  if (m.error || i.error) { flash(dbMessage(m.error ?? i.error), "err"); return; }
  x.members = m.data ?? [];
  x.invites = i.data ?? [];
  rerender();
}

const reload = () => loadAdmin().catch(() => undefined);

// ------------------------------------------------------------------ render
export function renderAdmin(): SafeHtml {
  const x = X();
  if (x.err) return html`<div class="card">${banner(x.err, "err")}<button data-click="adm-back">חזרה</button></div>`;
  if (!x.studios) return html`<p class="muted"><span class="spin"></span> טוען…</p>`;
  const open = x.studios.find((s) => s.id === x.open) ?? null;
  return html`<div class="card">
      <div class="card-h"><h1>ניהול</h1><button class="ghost" data-click="adm-back">${icon("arrow-right")} חזרה לאפליקציה</button></div>
      <p class="muted small">כאן מנהלים סטודיו, אנשים והרשאות. אין מכאן גישה לתמונות, להערות או לבקשות של אף אחד.</p>
    </div>
    <div class="card"><h2>סטודיו</h2>
      ${x.studios.length ? html`<div class="list">${x.studios.map((s) => html`<button class="listrow ${s.id === x.open ? "on" : ""}" data-click="adm-open" data-id="${s.id}">
          <span class="grow"><b>${s.name}</b><small>${s.painter_name ? `ציירת: ${s.painter_name}` : "עוד אין ציירת"} · ${s.members} אנשים${s.open_invites ? ` · ${s.open_invites} הזמנות פתוחות` : ""}</small></span>
          ${icon("settings")}</button>`)}</div>`
        : html`<p class="muted">עוד אין סטודיו. יוצרים אחד, ואז מזמינים את הציירת.</p>`}
      <form class="row nowrap" data-submit="adm-create"><input type="text" id="admName" maxlength="60" required placeholder="שם הסטודיו, למשל: הסטודיו של אמא"><button class="primary" type="submit">יצירה</button></form>
    </div>
    ${open ? renderStudio(open) : ""}
    <div class="card muted-card"><h2>שימוש ותקרות יצירה</h2><p class="muted">יתווסף בשלב 7: תקרה חודשית, מספר בקשות, שימוש והוצאה משוערת. עד אז היצירה כבויה.</p></div>`;
}

function renderStudio(s: StudioRow): SafeHtml {
  const x = X();
  const hasPainter = x.members.some((m) => m.role === "painter");
  return html`<div class="card">
      <div class="card-h"><h2>${s.name}</h2>
        <button class="ghost danger ${isArmed("adm-del/" + s.id) ? "armed" : ""}" data-click="adm-delete" data-id="${s.id}">${icon("trash-2")} ${isArmed("adm-del/" + s.id) ? "למחוק את הסטודיו וכל מה שבו?" : "מחיקה"}</button></div>
      <form class="row nowrap" data-submit="adm-rename" data-id="${s.id}"><input type="text" id="admRename" maxlength="60" required value="${s.name}" aria-label="שם הסטודיו"><button type="submit">שינוי שם</button></form>
      <h3>אנשים</h3>
      ${x.members.length ? x.members.map(memberRow) : html`<p class="muted">עוד אין אנשים בסטודיו.</p>`}
    </div>
    ${renderInviteForm(hasPainter)}
    ${x.invites.length ? html`<div class="card"><h2>הזמנות</h2>${x.invites.map(inviteRow)}</div>` : ""}`;
}

function memberRow(m: MemberRow): SafeHtml {
  const painter = m.role === "painter";
  const key = `adm-rm/${m.user_id}`;
  return html`<form class="member" data-submit="adm-perms" data-user="${m.user_id}">
    <div class="who"><b>${m.display_name || "(בלי שם)"}</b> <span class="chip ${painter ? "accent" : "grey"}">${painter ? "ציירת" : "משפחה"}</span>
      <small dir="ltr">${m.email}</small></div>
    ${painter ? html`<p class="muted small">לציירת יש תמיד את כל ההרשאות בסטודיו שלה.</p>` : html`
      <div class="perms">${PERMS.map((p) => html`<label class="chk"><input type="checkbox" name="${p}" ${attr(m[`can_${p}`], "checked")}> ${PERM_LABEL[p]}${p === "generate" ? html` <small class="muted">(עולה כסף)</small>` : ""}</label>`)}</div>
      <div class="row"><button type="submit">שמירת הרשאות</button>
        <button type="button" class="ghost danger" data-click="adm-remove" data-user="${m.user_id}">${isArmed(key) ? "להוציא מהסטודיו?" : "הוצאה"}</button></div>`}
  </form>`;
}

function renderInviteForm(hasPainter: boolean): SafeHtml {
  const x = X();
  const d = x.draft;
  if (hasPainter && d.role === "painter") d.role = "family";
  const preset = presetOf(d.perms);
  return html`<div class="card"><h2>הזמנה חדשה</h2>
    <p class="muted small">קישור חד-פעמי, תקף 7 ימים. שולחים אותו בוואטסאפ או במייל, והאדם נכנס עם קוד שנשלח למייל שלו.</p>
    <div class="seg" role="radiogroup" aria-label="תפקיד">
      <button type="button" role="radio" aria-checked="${d.role === "family"}" data-click="adm-role" data-role="family">בן/בת משפחה</button>
      <button type="button" role="radio" aria-checked="${d.role === "painter"}" data-click="adm-role" data-role="painter" ${attr(hasPainter, "disabled")}>הציירת${hasPainter ? " (כבר יש)" : ""}</button>
    </div>
    ${d.role === "painter" ? html`<p class="small">לציירת יש את כל ההרשאות בסטודיו שלה. יצירת תמונות מוגבלת בתקרה שתקבע.</p>` : html`
      <div class="seg" role="radiogroup" aria-label="הרשאות מוכנות">${PRESETS.map((p) => html`<button type="button" role="radio" aria-checked="${preset === p.id}" data-click="adm-preset" data-preset="${p.id}">${p.label}</button>`)}</div>
      <div class="perms">${PERMS.map((p) => html`<label class="chk"><input type="checkbox" data-change="adm-draft-perm" data-perm="${p}" ${attr(d.perms[`can_${p}`], "checked")}> ${PERM_LABEL[p]}${p === "generate" ? html` <small class="muted">(עולה כסף)</small>` : ""}</label>`)}</div>`}
    <form class="col" data-submit="adm-invite">
      <label class="f">שם (לא חובה)<input type="text" id="admPerson" maxlength="30" value="${d.name}" placeholder="למשל: אמא, מיכל"></label>
      <button class="primary big" type="submit">${icon("link")} יצירת קישור הזמנה</button>
    </form>
    ${x.link ? html`<div class="banner ok linkbox"><p>הקישור ל${x.link.who} מוכן. שולחים אותו רק לאדם הזה.</p><div class="secret">${x.link.url}</div>
      <div class="row"><button data-click="adm-share">${icon("share-2")} שליחה</button><button data-click="adm-copy">${icon("copy")} העתקה</button></div></div>` : ""}
  </div>`;
}

const STATUS: Record<string, [string, string]> = {
  open: ["פתוחה", "ok"], used: ["נוצלה", "grey"], expired: ["פג תוקף", "grey"], revoked: ["בוטלה", "grey"],
};
function inviteRow(i: InviteRow): SafeHtml {
  const [label, cls] = STATUS[i.status] ?? [i.status, "grey"];
  const what = i.role === "painter" ? "ציירת" : (PRESETS.find((p) => p.id === presetOf(i))?.label ?? "הרשאות מותאמות");
  return html`<div class="member"><div class="who"><b>${i.person_name || "בלי שם"}</b> <span class="chip ${cls}">${label}</span>
      <small>${what} · נוצרה ${fmtDate(i.created_at)}${i.claimed_email ? html` · <span dir="ltr">${i.claimed_email}</span>` : ""}</small></div>
    ${i.status === "open" ? html`<button class="ghost danger" data-click="adm-revoke" data-id="${i.id}">ביטול</button>` : ""}</div>`;
}

// ---------------------------------------------------------------- handlers
on("click", "adm-back", () => { location.hash = "#/"; });
on("click", "adm-open", async (el) => {
  const x = X();
  x.open = el.dataset.id!;
  x.link = null;
  await loadStudio(x.open);
});
on("submit", "adm-create", async () => {
  const name = ($("admName") as HTMLInputElement).value.trim();
  if (!name) return;
  const { data, error } = await sb.rpc("admin_create_studio", { p_name: name });
  if (error) { flash(dbMessage(error), "err"); return; }
  X().open = data as string;
  X().draft = { role: "painter", perms: presetPerms("all"), name: "" };
  flash("✓ הסטודיו נוצר. עכשיו מזמינים את הציירת.", "ok");
  reload();
});
on("submit", "adm-rename", async (el) => {
  const { error } = await sb.rpc("admin_rename_studio", { p_studio: el.dataset.id, p_name: ($("admRename") as HTMLInputElement).value });
  flash(error ? dbMessage(error) : "✓ השם עודכן", error ? "err" : "ok");
  reload();
});
on("click", "adm-delete", async (el) => {
  const id = el.dataset.id!;
  if (!armed2("adm-del/" + id, rerender)) return;
  const { error } = await sb.rpc("admin_delete_studio", { p_studio: id });
  if (error) { flash(dbMessage(error), "err"); return; }
  X().open = null;
  flash("הסטודיו נמחק", "ok");
  reload();
});
on("submit", "adm-perms", async (el) => {
  const f = el as HTMLFormElement;
  const val = (p: string) => (f.elements.namedItem(p) as HTMLInputElement | null)?.checked ?? false;
  const asked = { can_send: val("send"), can_view: val("view"), can_comment: val("comment"), can_generate: val("generate") };
  const p = normalize(asked);
  const { error } = await sb.rpc("admin_set_member", {
    p_studio: X().open, p_user: f.dataset.user, p_send: p.can_send, p_view: p.can_view, p_comment: p.can_comment, p_generate: p.can_generate,
  });
  if (error) flash(dbMessage(error), "err");
  else if (p.can_comment !== asked.can_comment) flash("✓ נשמר. תגובה דורשת גם צפייה, אז היא כבויה.", "info");
  else flash("✓ ההרשאות נשמרו", "ok");
  await loadStudio(X().open!);
});
on("click", "adm-remove", async (el) => {
  const user = el.dataset.user!;
  if (!armed2(`adm-rm/${user}`, rerender)) return;
  const { error } = await sb.rpc("admin_remove_member", { p_studio: X().open, p_user: user });
  flash(error ? dbMessage(error) : "הוצא/ה מהסטודיו", error ? "err" : "ok");
  reload();
});
on("click", "adm-role", (el) => {
  const d = X().draft;
  d.role = el.dataset.role as Role;
  if (d.role === "painter") d.perms = presetPerms("all");
  rerender();
});
on("click", "adm-preset", (el) => {
  const d = X().draft;
  d.perms = { ...presetPerms(el.dataset.preset as PresetId), can_generate: d.perms.can_generate };
  rerender();
});
on("change", "adm-draft-perm", (el) => {
  const d = X().draft;
  const k = `can_${el.dataset.perm}` as keyof Perms;
  d.perms = normalize({ ...d.perms, [k]: (el as HTMLInputElement).checked });
  rerender();
});
on("submit", "adm-invite", async () => {
  const x = X();
  const d = x.draft;
  d.name = ($("admPerson") as HTMLInputElement).value.trim();
  const p = d.role === "painter" ? presetPerms("all") : normalize(d.perms);
  const { data, error } = await sb.rpc("admin_create_invite", {
    p_studio: x.open, p_role: d.role, p_send: p.can_send, p_view: p.can_view, p_comment: p.can_comment,
    p_generate: p.can_generate, p_person_name: d.name || null,
  });
  if (error) { flash(dbMessage(error), "err"); return; }
  x.link = { url: `${appUrl()}#/join/${data}`, who: d.name || (d.role === "painter" ? "הציירת" : "בן/בת המשפחה") };
  d.name = "";
  await loadStudio(x.open!);
  reload();
});
on("click", "adm-share", async () => {
  const l = X().link;
  if (!l) return;
  const r = await shareLink(l.url, "הזמנה ל\"השראה לציור\". פותחים את הקישור ומתחברים עם המייל:");
  if (r === "copied") flash("הקישור הועתק", "info");
  if (r === "failed") flash("לא הצלחתי לשתף. אפשר להעתיק.", "warn");
});
on("click", "adm-copy", async () => flash((await copyText(X().link?.url ?? "")) ? "הקישור הועתק" : "לא הצלחתי להעתיק", "info"));
on("click", "adm-revoke", async (el) => {
  const { error } = await sb.rpc("admin_revoke_invite", { p_invite: el.dataset.id });
  flash(error ? dbMessage(error) : "ההזמנה בוטלה", error ? "err" : "ok");
  await loadStudio(X().open!);
});
