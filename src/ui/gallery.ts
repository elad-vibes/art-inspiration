// The studio's pictures: one mixed gallery, the suggestion box, collections,
// and the family's side (send a photo, see what was shared, comment).
// Rules shown here are enforced in the database (0005–0007); the screens only
// hide what someone can't do anyway. No print button, anywhere.
import { attr, html, safeUrl, type SafeHtml, $ } from "../lib/html.ts";
import { armed2, isArmed, on } from "../lib/events.ts";
import { can, flash, isPainter, rerender, S } from "../state.ts";
import {
  addComment, askDelete, cancelDelete, decide, deleteCollection, deleteComment, deletePicture, errMsg, G, loadAll,
  loadComments, loadDeleted, loadGallery, loadMembership, markSeen, renameCollection, restoreImage, saveNote,
  sendSuggestion, setRating, setShared, shareCollection, createCollection, toggleCollection, type Tab, uploadMine, urlOf,
} from "../images.ts";
import {
  countLabel, creditParts, type DeletedRow, deletedLabel, deletePrompt, type GalleryImage, type InboxItem,
  MAX_COLLECTION_NAME, MAX_COMMENT, MAX_MESSAGE, MAX_NOTE, senderStatusLabel,
} from "../domain/images.ts";
import { banner, fmtDate } from "./common.ts";
import { art } from "./art.ts";
import { icon } from "./icons.ts";

const who = () => S.painterName || "הציירת";

// ------------------------------------------------------------ shared bits
function netBanner(): SafeHtml | "" {
  if (!G.online) return banner(html`${icon("wifi-off")} אין חיבור לאינטרנט. מה שכבר נטען מוצג; שמירה, העלאה ושליחה יחזרו כשהחיבור יחזור.`, "warn");
  if (G.err) return banner(html`${G.err} <button data-click="g-reload">${icon("refresh-cw")} לנסות שוב</button>`, "err");
  return "";
}

const skeletonGrid = () => html`<div class="grid" aria-busy="true" aria-label="טוען תמונות">
  ${[0, 1, 2, 3].map(() => html`<div class="tile"><div class="skel-img tile-skel"></div><div class="skel-line" style="width:60%"></div></div>`)}</div>`;

function picture(i: GalleryImage): SafeHtml {
  const src = i.kind === "web" ? safeUrl(i.thumb_url ?? "") : urlOf(i.storage_path);
  if (!src || src === "#") return html`<span class="ph" aria-hidden="true">${icon("images")}</span>`;
  return html`<img src="${src}" alt="${i.attribution ?? ""}" loading="lazy" decoding="async" referrerpolicy="no-referrer"
    ${i.width && i.height ? html`width="${i.width}" height="${i.height}"` : ""}>`;
}

/** Credit UNDER a web image, never on it (ART-PLAN §2). Uploads and generated images get none. */
function credit(i: GalleryImage, full = false): SafeHtml | "" {
  const c = creditParts(i);
  if (!c) return "";
  const page = safeUrl(i.page_url ?? "");
  const lic = safeUrl(i.license_url ?? "");
  const creatorUrl = safeUrl(i.creator_url ?? "");
  return html`<p class="credit">
    <span>${full ? "יוצר/ת: " : ""}${full && creatorUrl !== "#" ? html`<a href="${creatorUrl}" target="_blank" rel="noopener noreferrer">${c.creator}</a>` : c.creator}</span>
    ${c.source ? html`<span>· ${c.source}</span>` : ""}
    ${full && c.license ? html`<span>· ${lic !== "#" ? html`<a href="${lic}" target="_blank" rel="noopener noreferrer">${c.license}</a>` : c.license}</span>` : ""}
    ${page !== "#" ? html`<a class="src" href="${page}" target="_blank" rel="noopener noreferrer">${icon("external-link")} ${full ? "לעמוד המקור" : "מקור"}</a>` : ""}
    ${i.source_status === "unavailable" ? html`<span class="muted">(המקור כבר לא זמין)</span>` : ""}
  </p>`;
}

function tile(i: GalleryImage): SafeHtml {
  const painter = isPainter();
  return html`<figure class="tile ${painter && i.my_rating === "not_suitable" ? "dim" : ""}">
    <button class="tile-img" data-click="g-open" data-id="${i.id}" aria-label="פתיחת התמונה">${picture(i)}</button>
    <figcaption>
      ${credit(i)}
      <span class="marks">
        ${painter && i.my_rating === "like" ? html`<span class="mark-like" title="אהבתי">${icon("heart")}</span>` : ""}
        ${painter && i.my_rating === "not_suitable" ? html`<span class="chip grey">לא מתאים</span>` : ""}
        ${painter && i.family_can_see ? html`<span class="mark-shared" title="משותף עם המשפחה">${icon("users")}</span>` : ""}
        ${i.comment_count ? html`<span class="mark-comments">${icon("message-circle")} ${i.comment_count}</span>` : ""}
      </span>
    </figcaption>
  </figure>`;
}

function filterChips(): SafeHtml | "" {
  const cols = G.collections ?? [];
  if (!cols.length) return "";
  return html`<div class="chips" role="radiogroup" aria-label="אוסף">
    <button type="button" role="radio" aria-checked="${G.filter === null}" data-click="g-filter" data-id="">הכול</button>
    ${cols.map((c) => html`<button type="button" role="radio" aria-checked="${G.filter === c.id}" data-click="g-filter" data-id="${c.id}">${c.name}</button>`)}
  </div>`;
}

// ================================================================ painter
export function renderPainter(): SafeHtml {
  const tabs: [Tab, string][] = [["gallery", "הגלריה"], ["inbox", "הצעות"], ["collections", "אוספים"], ["deleted", "נמחקו"]];
  return html`<div class="tabs" role="tablist" aria-label="מסכים">
      ${tabs.map(([t, label]) => html`<button role="tab" aria-selected="${G.tab === t}" data-click="g-tab" data-tab="${t}">${label}
        ${t === "inbox" && G.newCount ? html`<span class="count" aria-label="${G.newCount} חדשות">${G.newCount}</span>` : ""}</button>`)}
    </div>
    ${netBanner()}
    ${G.tab === "inbox" ? renderInbox() : G.tab === "collections" ? renderCollections() : G.tab === "deleted" ? renderDeleted() : renderGallery()}
    ${renderSheet()}${renderConfirm()}`;
}

function renderGallery(): SafeHtml {
  const list = G.images;
  const inColl = G.collections?.find((c) => c.id === G.filter);
  return html`<div class="card upcard">
      <label class="btnlink big" for="gUpload">${icon("image-plus")} העלאה מהטלפון</label>
      <input type="file" id="gUpload" class="vh" accept="image/*" multiple data-change="g-upload" ${attr(!!G.busy || !G.online, "disabled")}>
      ${G.busy ? html`<p class="small" role="status"><span class="spin"></span> מעלה ${Math.min(G.busy.done + 1, G.busy.total)} מתוך ${G.busy.total}…</p>`
        : html`<p class="muted small">בוחרים מהתמונות או מהקבצים בטלפון. התמונה נשמרת פרטית${inColl ? ` באוסף "${inColl.name}"` : ""}, בלי פרטי מיקום.</p>`}
    </div>
    ${filterChips()}
    ${list === null ? (G.err ? "" : skeletonGrid())
      : list.length ? html`<div class="grid">${list.map(tile)}</div>`
      : html`<div class="card empty">${art.easel()}<h2>${G.filter ? "האוסף הזה עוד ריק" : "הגלריה עוד ריקה"}</h2>
          <p class="muted">${G.filter ? "אפשר לשמור לכאן תמונות מהגלריה או מהצעות המשפחה." : "תמונות שתעלי מהטלפון ותמונות שתשמרי מהצעות המשפחה יופיעו כאן."}</p></div>`}
    <div class="card muted-card"><h2>בקרוב</h2><ul class="soonlist">
      <li class="soon">${icon("search")}<span class="grow"><b>חיפוש תמונות לציור</b><small>עם שם הצלם והמקור, מתחת לתמונה</small></span></li>
      <li class="soon">${icon("images")}<span class="grow"><b>תמונות דומות</b><small>לפי תמונה ששמרת</small></span></li>
      <li class="soon">${icon("sparkles")}<span class="grow"><b>תמונות חדשות</b><small>גרסה אחרת של תמונה — המקור תמיד נשמר</small></span></li>
    </ul></div>`;
}

// ------------------------------------------------------- suggestion box
function suggestionCard(s: InboxItem): SafeHtml {
  const src = urlOf(s.storage_path);
  const cols = G.collections ?? [];
  return html`<article class="card sugg">
    <div class="sugg-h"><b>מ${s.sender_name}</b> <span class="muted small">${fmtDate(s.created_at)}</span>
      ${s.is_new ? html`<span class="chip accent">חדש</span>` : ""}</div>
    ${src ? html`<img class="sugg-img" src="${src}" alt="" loading="lazy" ${s.width && s.height ? html`width="${s.width}" height="${s.height}"` : ""}>`
      : html`<span class="ph">${icon("images")}</span>`}
    ${s.message ? html`<p class="msg">"${s.message}"</p>` : ""}
    ${cols.length > 1 ? html`<label class="f">לשמור באוסף<select id="acc-${s.id}">${cols.map((c) => html`<option value="${c.id}">${c.name}</option>`)}</select></label>` : ""}
    <div class="row">
      <button class="primary" data-click="g-accept" data-id="${s.id}" ${attr(!G.online, "disabled")}>${icon("check")} לשמור</button>
      ${s.status === "pending" ? html`<button data-click="g-ignore" data-id="${s.id}" ${attr(!G.online, "disabled")}>להתעלם</button>` : ""}
      <button class="ghost danger" data-click="g-sdelete" data-id="${s.id}" ${attr(!G.online, "disabled")}>${icon("trash-2")} מחיקה</button>
    </div>
  </article>`;
}

function renderInbox(): SafeHtml {
  if (G.inbox === null) return G.err ? html`` : html`<div class="skel"><div class="skel-card"><div class="skel-line" style="width:40%"></div><div class="skel-img"></div></div></div>`;
  const waiting = G.inbox.filter((s) => s.status === "pending");
  const ignored = G.inbox.filter((s) => s.status === "ignored");
  return html`${waiting.length ? waiting.map(suggestionCard)
      : html`<div class="card empty">${art.letter()}<h2>אין הצעות חדשות</h2>
        <p class="muted">כשמישהו מהמשפחה ישלח לך תמונה, היא תחכה כאן עד שתחליטי: לשמור, להתעלם או למחוק.</p></div>`}
    ${ignored.length ? html`<details class="card"><summary><b>הצעות שהתעלמת מהן (${ignored.length})</b></summary>
      <p class="muted small">הן לא בגלריה. אפשר עדיין לשמור או למחוק.</p>${ignored.map(suggestionCard)}</details>` : ""}`;
}

// -------------------------------------------------------------- collections
function renderCollections(): SafeHtml {
  const cols = G.collections;
  if (cols === null) return G.err ? html`` : html`<div class="skel"><div class="skel-card"><div class="skel-line"></div><div class="skel-line" style="width:60%"></div></div></div>`;
  return html`<div class="card"><h2>האוספים שלי</h2>
      <div class="list">${cols.map((c) => {
        const cover = urlOf(c.cover_path) ?? (c.cover_thumb ? safeUrl(c.cover_thumb) : null);
        const editing = G.editColl === c.id;
        const del = `g-cdel/${c.id}`;
        return html`<div class="coll">
          <div class="coll-row">
            <button class="listrow" data-click="g-show-coll" data-id="${c.id}">
              ${cover && cover !== "#" ? html`<img class="cover" src="${cover}" alt="" loading="lazy" referrerpolicy="no-referrer">` : html`<span class="cover ph">${icon("folder")}</span>`}
              <span class="grow"><b>${c.name}</b><small>${countLabel(c.items)}${c.shared ? " · משותף עם המשפחה" : " · פרטי"}</small></span>
            </button>
            <button class="iconbtn" data-click="g-edit-coll" data-id="${c.id}" aria-expanded="${editing}" aria-label="עריכת האוסף ${c.name}">${icon("pencil")}</button>
          </div>
          ${editing ? html`<div class="coll-edit">
            <form class="row nowrap" data-submit="g-rename-coll" data-id="${c.id}"><input type="text" id="collName-${c.id}" maxlength="${MAX_COLLECTION_NAME}" required value="${c.name}" aria-label="שם האוסף"><button type="submit">שמירה</button></form>
            <label class="chk"><input type="checkbox" data-change="g-share-coll" data-id="${c.id}" ${attr(c.shared, "checked")}> לשתף את האוסף עם המשפחה</label>
            <p class="muted small">רק מי שקיבל הרשאת צפייה יראה אותו. ההערות שלך לא משותפות אף פעם.</p>
            ${c.is_default ? html`<p class="muted small">זה האוסף הראשי, ואי אפשר למחוק אותו.</p>`
              : html`<button class="ghost danger ${isArmed(del) ? "armed" : ""}" data-click="g-del-coll" data-id="${c.id}">${icon("trash-2")} ${isArmed(del) ? "למחוק את האוסף? התמונות יישארו בגלריה" : "מחיקת האוסף"}</button>`}
          </div>` : ""}
        </div>`;
      })}</div>
    </div>
    <form class="card" data-submit="g-new-coll"><h2>אוסף חדש</h2>
      <div class="row nowrap"><input type="text" id="gNewColl" maxlength="${MAX_COLLECTION_NAME}" required placeholder="למשל: פרחים, ים, נופים" aria-label="שם האוסף החדש"><button class="primary" type="submit">${icon("folder-plus")} יצירה</button></div>
    </form>`;
}

// ------------------------------------------------------------ detail sheet
function commentsBlock(i: GalleryImage): SafeHtml | "" {
  if (!i.family_can_see && !i.comment_count) return "";
  const list = G.comments[i.id];
  const mayWrite = can("comment") && i.family_can_see;
  return html`<section class="comments"><h3>${icon("message-circle")} תגובות</h3>
    ${list === undefined ? html`<p class="muted small"><span class="spin"></span> טוען…</p>`
      : list === "error" ? html`<p class="muted small">לא הצלחנו לטעון את התגובות.</p>`
      : list.length ? html`<ul class="clist">${list.map((c) => html`<li><b>${c.author_name}</b> <span class="muted small">${fmtDate(c.created_at)}</span>
          <p>${c.body}</p>${c.mine || isPainter() ? html`<button class="ghost danger" data-click="g-del-comment" data-id="${c.id}">מחיקה</button>` : ""}</li>`)}</ul>`
      : html`<p class="muted small">עוד אין תגובות.</p>`}
    ${mayWrite ? html`<form class="col" data-submit="g-comment" data-id="${i.id}"><textarea id="gComment" rows="2" maxlength="${MAX_COMMENT}" required placeholder="מה חשבת?" aria-label="תגובה"></textarea><button type="submit">${icon("send")} שליחת תגובה</button></form>` : ""}
  </section>`;
}

function renderSheet(): SafeHtml | "" {
  const i = G.open ? G.images?.find((x) => x.id === G.open) : null;
  if (!i) return "";
  const painter = isPainter();
  const src = i.kind === "web" ? safeUrl(i.thumb_url ?? "") : urlOf(i.storage_path);
  const member = G.memberOf[i.id];
  const parent = i.parent_id ? G.images?.find((x) => x.id === i.parent_id) : null;
  const byline = i.kind === "generated" ? "תמונה שנוצרה" : painter && !i.by_me && i.owner_name ? `מ${i.owner_name}` : "";
  return html`<div class="sheet-bg" data-click="g-close"></div>
    <div class="sheet viewer" role="dialog" aria-label="תמונה">
      <div class="card-h"><span class="muted small">${byline}</span>
        <button class="iconbtn" data-click="g-close" aria-label="סגירה">${icon("x")}</button></div>
      ${src && src !== "#" ? html`<img class="big" src="${src}" alt="${i.attribution ?? ""}" referrerpolicy="no-referrer">` : html`<span class="ph big">${icon("images")}</span>`}
      ${credit(i, true)}
      ${parent ? html`<button class="ghost" data-click="g-open" data-id="${parent.id}">${icon("arrow-right")} לתמונת המקור</button>` : ""}
      ${painter ? html`
        <div class="seg" role="group" aria-label="דירוג">
          <button type="button" aria-pressed="${i.my_rating === "like"}" data-click="g-rate" data-id="${i.id}" data-rating="like">${icon("heart")} אהבתי</button>
          <button type="button" aria-pressed="${i.my_rating === "not_suitable"}" data-click="g-rate" data-id="${i.id}" data-rating="not_suitable">${icon("thumbs-down")} לא מתאים</button>
        </div>
        <form class="col" data-submit="g-note" data-id="${i.id}">
          <label class="f">הערה לעצמי (רק את רואה)<textarea id="gNote" rows="2" maxlength="${MAX_NOTE}" placeholder="למשל: לצייר בגווני כחול">${i.my_note ?? ""}</textarea></label>
          <button type="submit">שמירת ההערה</button></form>
        <section class="col"><h3>${icon("folder")} באוספים</h3>
          ${member === undefined ? html`<p class="muted small"><span class="spin"></span></p>`
            : (G.collections ?? []).map((c) => html`<label class="chk"><input type="checkbox" data-change="g-in-coll" data-id="${i.id}" data-coll="${c.id}" ${attr(member.includes(c.id), "checked")}> ${c.name}${c.shared ? html` <small class="muted">(משותף)</small>` : ""}</label>`)}
        </section>
        <section class="col"><label class="chk"><input type="checkbox" data-change="g-share" data-id="${i.id}" ${attr(i.shared, "checked")}> לשתף את התמונה עם המשפחה</label>
          <p class="muted small">${!i.shared && i.family_can_see ? "התמונה כבר משותפת דרך אוסף משותף. " : ""}רק מי שקיבל הרשאת צפייה יראה אותה.</p></section>
      ` : ""}
      ${commentsBlock(i)}
      ${painter ? html`<button class="ghost danger" data-click="g-idelete" data-id="${i.id}" ${attr(!G.online, "disabled")}>${icon("trash-2")} ${i.kind === "web" ? "הסרת התמונה מהגלריה" : "מחיקת התמונה"}</button>` : ""}
    </div>`;
}

// ---------------------------------------------------------- delete confirmation
/** What the confirmation must say depends on what is being deleted (hide vs. delete for real). */
function confirmPrompt() {
  const c = G.confirm!;
  const gi = G.images?.find((x) => x.id === c.image);
  if (gi) return deletePrompt({ kind: gi.kind, shared: gi.family_can_see, sender: !gi.by_me ? gi.owner_name : null });
  const s = G.inbox?.find((x) => x.image_id === c.image);
  return deletePrompt({ kind: "upload", sender: s?.sender_name ?? null });
}

function renderConfirm(): SafeHtml | "" {
  const c = G.confirm;
  if (!c) return "";
  const p = confirmPrompt();
  return html`<div class="sheet-bg cf-bg" data-click="g-confirm-no"></div>
    <div class="sheet confirm" role="alertdialog" aria-modal="true" aria-labelledby="cfTitle" aria-describedby="cfBody">
      <h2 id="cfTitle">${p.title}</h2>
      <p id="cfBody">${p.body}</p>
      <div class="col">
        <button class="${p.final ? "solid-danger" : "primary"} big" data-click="g-confirm-yes" ${attr(c.busy || !G.online, "disabled")}>${c.busy ? html`<span class="spin"></span>` : icon(p.final ? "trash-2" : "check")} ${p.confirm}</button>
        <button class="big" data-click="g-confirm-no" ${attr(c.busy, "disabled")}>ביטול</button>
      </div>
    </div>`;
}

// ------------------------------------------------------------ "deleted" screen
function deletedRow(d: DeletedRow): SafeHtml {
  const label = deletedLabel(d.origin, d.sender_name);
  if (d.restorable) {
    const thumb = safeUrl(d.thumb_url ?? "");
    const page = safeUrl(d.page_url ?? "");
    return html`<article class="card del-row">
      <div class="del-pic">${thumb !== "#" ? html`<img src="${thumb}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : html`<span class="ph">${icon("images")}</span>`}</div>
      <div class="del-txt"><b>${label}</b>
        <small>${(d.creator ?? "").trim() || "יוצר לא ידוע"}${d.source_name ? ` · ${d.source_name}` : ""}${page !== "#" ? html` · <a href="${page}" target="_blank" rel="noopener noreferrer">מקור</a>` : ""}</small>
        <small>הוסרה ב-${fmtDate(d.deleted_at)}</small></div>
      <button class="primary" data-click="g-restore" data-id="${d.id}" ${attr(!G.online, "disabled")}>${icon("undo-2")} שחזור</button>
    </article>`;
  }
  return html`<article class="card del-row gone">
    <div class="del-pic"><span class="ph">${icon("file-x")}</span></div>
    <div class="del-txt"><b>${label}</b>
      <small>הועלתה ב-${fmtDate(d.uploaded_at)} · נמחקה ב-${fmtDate(d.deleted_at)}</small>
      <small class="final">התמונה נמחקה ולא ניתן לשחזר.</small></div>
  </article>`;
}

function renderDeleted(): SafeHtml {
  const list = G.deleted;
  return html`<div class="card"><h2>${icon("trash-2")} נמחקו</h2>
      <p class="small">תמונה מהרשת רק מוסתרת כאן, ואפשר להחזיר אותה בלחיצה.
        תמונה שהעלית, הצעה מהמשפחה או תמונה שנוצרה נמחקו לגמרי, ולא ניתן לשחזר אותן. נשארת רק שורה קטנה עם התאריך.</p></div>
    ${list === null ? (G.err ? "" : html`<div class="skel"><div class="skel-card"><div class="skel-line" style="width:50%"></div><div class="skel-line"></div></div></div>`)
      : list.length ? list.map(deletedRow)
      : html`<div class="card empty">${art.easel()}<h2>אין תמונות שנמחקו</h2><p class="muted">כשתמחקי או תסירי תמונה, היא תופיע כאן.</p></div>`}`;
}

// ================================================================= family
export function renderFamily(): SafeHtml {
  const w = who();
  return html`${netBanner()}${can("send") ? renderSend(w) : ""}${can("view") ? renderShared(w) : ""}${renderSheet()}`;
}

function renderSend(w: string): SafeHtml {
  const d = G.draft;
  return html`<div class="card"><h2>לשלוח ל${w} תמונה</h2>
    ${d ? html`<img class="preview" src="${d.preview}" alt="התמונה שנבחרה">
        <form class="col" data-submit="g-send">
          <label class="f">הודעה קצרה (לא חובה)<textarea id="gMsg" rows="2" maxlength="${MAX_MESSAGE}" placeholder="למשל: ראיתי וחשבתי עלייך"></textarea></label>
          <button class="primary big" type="submit" ${attr(!!G.busy || !G.online, "disabled")}>${G.busy ? html`<span class="spin"></span> שולח…` : html`${icon("send")} שליחה ל${w}`}</button>
          <button class="ghost" type="button" data-click="g-draft-cancel" ${attr(!!G.busy, "disabled")}>ביטול</button>
        </form>`
      : html`<label class="btnlink big" for="gPick">${icon("image-plus")} בחירת תמונה</label>
        <input type="file" id="gPick" class="vh" accept="image/*" data-change="g-pick" ${attr(!G.online, "disabled")}>
        <p class="muted small">התמונה מגיעה לתיבת ההצעות של ${w}, ורק ${w} ואת/ה רואים אותה.</p>
        <details class="help"><summary>איך שולחים תמונה מוואטסאפ באייפון?</summary>
          <ol class="steps small"><li>בוואטסאפ פותחים את התמונה ולוחצים <b>שיתוף</b> ← <b>שמירה</b> (היא נשמרת בתמונות).</li>
          <li>חוזרים לכאן ולוחצים <b>בחירת תמונה</b> ← בוחרים אותה מהתמונות.</li></ol>
          <p class="muted small">באייפון אין אפשרות לשתף מוואטסאפ ישירות לאפליקציה הזאת, ולכן שומרים קודם.</p></details>`}
    ${renderMine()}
  </div>`;
}

function renderMine(): SafeHtml | "" {
  const mine = G.mine;
  if (mine === null) return G.err ? "" : html`<p class="muted small"><span class="spin"></span> טוען…</p>`;
  if (!mine.length) return html`<p class="muted small">עוד לא שלחת תמונות.</p>`;
  return html`<h3>מה ששלחת</h3><div class="grid">${mine.map((m) => {
    const src = urlOf(m.storage_path);
    const st = senderStatusLabel(m.status);
    return html`<figure class="tile">
      <div class="tile-img">${src ? html`<img src="${src}" alt="" loading="lazy">` : html`<span class="ph">${icon("images")}</span>`}</div>
      <figcaption><span class="marks"><span class="chip ${st.tone}">${st.text}</span> <span class="muted small">${fmtDate(m.created_at)}</span></span>
        ${m.message ? html`<small class="msg">"${m.message}"</small>` : ""}</figcaption></figure>`;
  })}</div>`;
}

function renderShared(w: string): SafeHtml {
  const list = G.images;
  return html`<div class="card"><h2>מה ש${w} שיתפה</h2>
    ${filterChips()}
    ${list === null ? (G.err ? "" : skeletonGrid())
      : list.length ? html`<div class="grid">${list.map(tile)}</div>`
      : html`<div class="empty">${art.easel()}<p class="muted">${w} עוד לא שיתפה תמונות. כשתשתף, הן יופיעו כאן${can("comment") ? " ואפשר יהיה להגיב" : ""}.</p></div>`}
  </div>`;
}

// ================================================================= events
const run = async (fn: () => Promise<unknown>, ok?: string) => {
  try {
    await fn();
    if (ok) flash(ok, "ok");
  } catch (e) {
    flash(errMsg(e), "err");
  }
  rerender();
};

on("click", "g-reload", () => loadAll());
on("click", "g-tab", async (el) => {
  G.tab = el.dataset.tab as Tab;
  rerender();
  window.scrollTo({ top: 0 });
  if (G.tab === "inbox") { await markSeen(); rerender(); }
  if (G.tab === "deleted") {
    try { await loadDeleted(); } catch (e) { flash(errMsg(e), "err"); }
    rerender();
  }
});
on("click", "g-filter", (el) => run(async () => { G.filter = el.dataset.id || null; G.images = null; rerender(); await loadGallery(); }));
on("click", "g-show-coll", (el) => run(async () => { G.filter = el.dataset.id!; G.tab = "gallery"; G.images = null; rerender(); await loadGallery(); }));

on("change", "g-upload", async (el) => {
  const input = el as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = "";
  if (!files.length) return;
  try {
    const r = await uploadMine(files);
    if (r.error) flash(r.ok ? `${r.ok} נשמרו, חלק לא: ${r.error}` : r.error, "err");
    else flash(r.ok === 1 ? "✓ התמונה נשמרה" : `✓ ${r.ok} תמונות נשמרו`, "ok");
  } catch (e) { flash(errMsg(e), "err"); }
});

// suggestion box
on("click", "g-accept", (el) => {
  const id = el.dataset.id!;
  const sel = $<HTMLSelectElement>(`acc-${id}`);
  return run(() => decide(id, "accept", sel?.value || null), "✓ נשמרה בגלריה");
});
on("click", "g-ignore", (el) => run(() => decide(el.dataset.id!, "ignore"), "ההצעה הועברה ל'הצעות שהתעלמת מהן'"));
on("click", "g-sdelete", (el) => {
  const s = G.inbox?.find((x) => x.id === el.dataset.id);
  if (s) askDelete(s.image_id, s.id);           // the confirmation says what will happen; the server deletes
});

// one image
on("click", "g-open", async (el) => {
  const id = el.dataset.id!;
  G.open = id;
  rerender();
  const i = G.images?.find((x) => x.id === id);
  await Promise.all([
    isPainter() ? loadMembership(id).catch(() => { G.memberOf[id] = []; }) : null,
    i && (i.family_can_see || i.comment_count) ? loadComments(id) : null,
  ]);
  rerender();
});
on("click", "g-close", () => { G.open = null; rerender(); });
addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (G.confirm) cancelDelete();
  else if (G.open) { G.open = null; rerender(); }
});
on("click", "g-rate", (el) => run(() => setRating(el.dataset.id!, el.dataset.rating as "like" | "not_suitable")));
on("submit", "g-note", (el) => run(() => saveNote(el.dataset.id!, $<HTMLTextAreaElement>("gNote")?.value ?? ""), "✓ ההערה נשמרה"));
on("change", "g-share", (el) => {
  const shared = (el as HTMLInputElement).checked;
  return run(() => setShared(el.dataset.id!, shared), shared ? "✓ משותפת עם המשפחה" : "✓ התמונה פרטית שוב");
});
on("change", "g-in-coll", (el) => run(() => toggleCollection(el.dataset.id!, el.dataset.coll!, (el as HTMLInputElement).checked)));
on("click", "g-idelete", (el) => askDelete(el.dataset.id!));
on("click", "g-confirm-no", () => cancelDelete());
on("click", "g-confirm-yes", async () => {
  const c = G.confirm;
  if (!c || c.busy) return;
  c.busy = true;
  rerender();
  try {
    const r = await deletePicture(c.image);
    flash(r.mode === "hidden" ? "✓ התמונה הוסרה. אפשר להחזיר אותה ממסך \"נמחקו\"" : "✓ התמונה נמחקה לגמרי", "ok");
  } catch (e) {
    if (G.confirm) G.confirm.busy = false;
    flash(errMsg(e), "err");
  }
  rerender();
});
on("click", "g-restore", (el) => run(() => restoreImage(el.dataset.id!), "✓ התמונה חזרה לגלריה"));
on("submit", "g-comment", (el) => run(async () => {
  const t = $<HTMLTextAreaElement>("gComment");
  await addComment(el.dataset.id!, t?.value ?? "");
  if (t) t.value = "";
}));
on("click", "g-del-comment", (el) => run(() => deleteComment(G.open!, el.dataset.id!)));

// collections
on("submit", "g-new-coll", (el) => run(async () => {
  await createCollection($<HTMLInputElement>("gNewColl")?.value ?? "");
  (el as HTMLFormElement).reset();
}, "✓ האוסף נוצר"));
on("click", "g-edit-coll", (el) => { G.editColl = G.editColl === el.dataset.id ? null : el.dataset.id!; rerender(); });
on("submit", "g-rename-coll", (el) => run(() => renameCollection(el.dataset.id!, $<HTMLInputElement>(`collName-${el.dataset.id}`)?.value ?? ""), "✓ השם נשמר"));
on("change", "g-share-coll", (el) => {
  const shared = (el as HTMLInputElement).checked;
  return run(() => shareCollection(el.dataset.id!, shared), shared ? "✓ האוסף משותף עם המשפחה" : "✓ האוסף פרטי שוב");
});
on("click", "g-del-coll", (el) => {
  if (!armed2(`g-cdel/${el.dataset.id}`, rerender)) return;
  return run(() => deleteCollection(el.dataset.id!), "האוסף נמחק. התמונות נשארו בגלריה");
});

// family: send a photo
on("change", "g-pick", (el) => {
  const input = el as HTMLInputElement;
  const f = input.files?.[0];
  input.value = "";
  if (!f) return;
  if (G.draft) URL.revokeObjectURL(G.draft.preview);
  G.draft = { file: f, preview: URL.createObjectURL(f) };
  rerender();
});
on("click", "g-draft-cancel", () => {
  if (G.draft) URL.revokeObjectURL(G.draft.preview);
  G.draft = null;
  rerender();
});
on("submit", "g-send", async () => {
  const d = G.draft;
  if (!d) return;
  try {
    await sendSuggestion(d.file, $<HTMLTextAreaElement>("gMsg")?.value ?? "");
    URL.revokeObjectURL(d.preview);
    G.draft = null;
    flash(`✓ נשלחה ל${who()}`, "ok");
  } catch (e) {
    flash(errMsg(e), "err");
  }
  rerender();
});
