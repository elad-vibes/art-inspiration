// The studio home. Phase 1: who you are here and what you may do; the gallery,
// search and suggestions arrive in the next phases (ART-PLAN §9).
import { attr, html, type SafeHtml, $ } from "../lib/html.ts";
import { on } from "../lib/events.ts";
import { dbMessage, sb } from "../lib/supa.ts";
import { can, flash, isPainter, rerender, S, studio } from "../state.ts";
import { chooseStudio, saveMyName } from "../data.ts";
import { permSummary } from "../domain/perms.ts";
import { art } from "./art.ts";
import { icon } from "./icons.ts";

function greeting(): string {
  const h = new Date().getHours();
  const t = h >= 5 && h < 12 ? "בוקר טוב" : h >= 12 && h < 17 ? "צהריים טובים" : "ערב טוב";
  return S.myName ? `${t}, ${S.myName}` : t;
}

const soon = (ic: string, title: string, text: string) =>
  html`<li class="soon">${icon(ic)}<span class="grow"><b>${title}</b><small>${text}</small></span><span class="chip grey">בקרוב</span></li>`;

export function renderHome(): SafeHtml {
  const s = studio()!;
  if (isPainter()) {
    return html`<p class="greet">${greeting()}</p>
      <div class="card empty">${art.easel()}<h2>הגלריה עוד ריקה</h2>
        <p class="muted">כאן יופיעו התמונות שתשמרי לציור: מהרשת, מהטלפון ומהמשפחה.</p></div>
      <div class="card"><h2>מה יהיה כאן</h2><ul class="soonlist">
        ${soon("search", "חיפוש תמונות לציור", "פרחים, נופים, בעלי חיים — עם שם הצלם והמקור")}
        ${soon("inbox", "הצעות מהמשפחה", "תמונות שהמשפחה שולחת לך, בתיבה נפרדת")}
        ${soon("images", "תמונות דומות", "לפי תמונה ששמרת או העלית")}
        ${soon("sparkles", "תמונות חדשות", "לבקש תמונה, או גרסה אחרת של תמונה — המקור תמיד נשמר")}
      </ul></div>`;
  }
  const who = S.painterName || "הציירת";
  return html`<p class="greet">${greeting()}</p>
    <div class="card"><h2>ההרשאות שלך</h2><p>${permSummary(s.perms, s.role)}</p></div>
    ${can("send") ? html`<div class="card empty">${art.letter()}<h2>לשלוח ל${who} תמונה</h2>
      <p class="muted">בקרוב: שולחים תמונה עם הודעה קצרה, והיא מגיעה לתיבת ההצעות של ${who}.</p></div>` : ""}
    ${can("view") ? html`<div class="card empty">${art.easel()}<h2>מה ש${who} משתפת</h2>
      <p class="muted">תמונות ואוספים ש${who} תבחר לשתף עם המשפחה יופיעו כאן${can("comment") ? ", ואפשר יהיה להגיב עליהם" : ""}.</p></div>` : ""}`;
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
});
on("click", "signout", async () => { await sb.auth.signOut(); location.hash = ""; location.reload(); });
