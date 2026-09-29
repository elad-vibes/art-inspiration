// The studio home: the painter's gallery, suggestion box and collections, or a
// family member's side — each by their own permissions (ART-PLAN §1).
import { attr, html, type SafeHtml, $ } from "../lib/html.ts";
import { on } from "../lib/events.ts";
import { dbMessage, sb } from "../lib/supa.ts";
import { can, flash, isPainter, rerender, S, studio } from "../state.ts";
import { chooseStudio, saveMyName } from "../data.ts";
import { permSummary } from "../domain/perms.ts";
import { loadAll } from "../images.ts";
import { renderFamily, renderPainter } from "./gallery.ts";
import { icon } from "./icons.ts";

function greeting(): string {
  const h = new Date().getHours();
  const t = h >= 5 && h < 12 ? "בוקר טוב" : h >= 12 && h < 17 ? "צהריים טובים" : "ערב טוב";
  return S.myName ? `${t}, ${S.myName}` : t;
}

export function renderHome(): SafeHtml {
  const s = studio()!;
  if (isPainter()) return html`<p class="greet">${greeting()}</p>${renderPainter()}`;
  const none = !can("send") && !can("view");
  return html`<p class="greet">${greeting()}</p>
    ${renderFamily()}
    <div class="card ${none ? "" : "muted-card"}"><h2>ההרשאות שלך</h2><p>${permSummary(s.perms, s.role)}</p></div>`;
}

// ---------------------------------------------------------------- the menu
export function renderMenu(): SafeHtml {
  if (!S.menu) return html``;
  return html`<div class="sheet-bg" data-click="menu"></div>
    <div class="sheet" role="dialog" aria-label="תפריט">
      <form class="row nowrap" data-submit="save-name"><label class="f grow">השם שלי<input type="text" id="myName" maxlength="40" value="${S.myName}"></label><button type="submit">שמירה</button></form>
      ${S.studios.length > 1 ? html`<label class="f">סטודיו<select data-change="pick-studio">${S.studios.map((x) => html`<option value="${x.id}" ${attr(x.id === S.sid, "selected")}>${x.name}</option>`)}</select></label>` : ""}
      <button data-click="go-install">${icon("download")} התקנה למסך הבית</button>
      ${S.hasFactor ? html`<p class="muted small">${icon("shield-check")} אימות דו-שלבי מופעל</p>` : html`<button data-click="mfa-enroll-start">${icon("shield-check")} אימות דו-שלבי (לא חובה)</button>`}
      ${S.isAdmin ? html`<button data-click="go-admin">${icon("users")} ניהול: אנשים והרשאות</button>` : ""}
      <button data-click="signout">${icon("log-out")} יציאה</button>
    </div>`;
}

on("click", "menu", () => { S.menu = !S.menu; rerender(); });
on("click", "go-install", () => { S.menu = false; location.hash = "#/install"; });
on("click", "go-admin", () => { S.menu = false; location.hash = "#/admin"; });
on("submit", "save-name", async () => {
  try {
    await saveMyName(($("myName") as HTMLInputElement).value);
    flash("✓ השם נשמר", "ok");
  } catch (e) { flash(dbMessage(e), "err"); }
});
on("change", "pick-studio", async (el) => {
  await chooseStudio((el as HTMLSelectElement).value);
  S.menu = false;
  rerender();
  await loadAll();
});
on("click", "signout", async () => { await sb.auth.signOut(); location.hash = ""; location.reload(); });
