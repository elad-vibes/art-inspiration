// The demo's pretend "create a new version of this picture" (the real feature is phase 7–8).
// Mom picks a picture, says what to change, waits a moment, chooses one of three examples and
// saves it as a new version that keeps a link to the original. The examples are colour looks
// applied to the picture in the browser: nothing is sent anywhere, and every step says so.
// This screen exists only in the demo build; the real screens are untouched (a button is added
// to the picture sheet after it is drawn).
import { html, safeUrl, type SafeHtml, $ } from "../lib/html.ts";
import { on } from "../lib/events.ts";
import { flash, rerender } from "../state.ts";
import { G, loadCollections, loadGallery, loadMembership, urlOf } from "../images.ts";
import { icon } from "../ui/icons.ts";
import { demo } from "./runtime.ts";
import { applyLook, pickLooks } from "./looks.ts";

interface Opt { id: string; label: string; url: string; blob: Blob; w: number; h: number }
interface Gen { image: string; step: "consent" | "form" | "working" | "pick" | "saving"; prompt: string; options: Opt[]; picked: string | null }

export const GEN = { cur: null as Gen | null, consented: false };

const EXAMPLES = ["יותר כחול", "שקיעה חמה", "לילה", "צבעים רכים", "בשחור-לבן"];
const NOTE = "זו הדגמה: התוצאות הן גרסאות צבע מוכנות, ולא נוצרו באמת.";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const sourceOf = (id: string): string | null => {
  const i = G.images?.find((x) => x.id === id);
  if (!i) return null;
  if (i.kind === "web") { const u = safeUrl(i.thumb_url ?? ""); return u === "#" ? null : u; }
  return urlOf(i.storage_path);
};

function release() {
  for (const o of GEN.cur?.options ?? []) URL.revokeObjectURL(o.url);
}
function close() {
  release();
  GEN.cur = null;
  rerender();
}

async function makeOptions(src: string, prompt: string): Promise<Opt[]> {
  const im = new Image();
  im.src = src;
  await im.decode();
  const k = Math.min(1, 900 / Math.max(im.naturalWidth, im.naturalHeight));
  const w = Math.max(1, Math.round(im.naturalWidth * k)), h = Math.max(1, Math.round(im.naturalHeight * k));
  const out: Opt[] = [];
  for (const [n, o] of pickLooks(prompt).entries()) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const x = c.getContext("2d")!;
    x.drawImage(im, 0, 0, w, h);
    const d = x.getImageData(0, 0, w, h);
    applyLook(d.data, o.look, o.amount);
    x.putImageData(d, 0, 0);
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/jpeg", 0.88));
    if (!blob) throw new Error("no blob");
    out.push({ id: `opt${n}`, label: o.label, url: URL.createObjectURL(blob), blob, w, h });
  }
  return out;
}

// ------------------------------------------------------------------ the screen
export function genSheet(): SafeHtml | "" {
  const g = GEN.cur;
  if (!g) return "";
  const src = sourceOf(g.image);
  const busy = g.step === "working" || g.step === "saving";
  let body: SafeHtml;
  if (g.step === "consent") {
    body = html`<h2>לפני שיוצרים גרסה חדשה</h2>
      <p>בגרסה האמיתית, כדי ליצור גרסה חדשה התמונה נשלחת לשירות יצירה חיצוני, ורק אחרי שאת מאשרת.
        אם יש בתמונה אנשים, תופיע אזהרה נוספת. בהדגמה הזאת שום דבר לא נשלח.</p>
      <div class="col"><button class="primary big" data-click="demo-gen-consent">הבנתי, להמשיך</button>
        <button class="big" data-click="demo-gen-close">ביטול</button></div>`;
  } else if (g.step === "form") {
    body = html`<h2>${icon("sparkles")} ליצור גרסה חדשה</h2>
      ${src ? html`<img class="gen-src" src="${src}" alt="התמונה שנבחרה">` : ""}
      <label class="f">מה לשנות בתמונה?<input type="text" id="demoGenPrompt" maxlength="120" value="${g.prompt}" data-input="demo-gen-input"
        placeholder="למשל: יותר כחול, שקיעה חמה, לילה"></label>
      <div class="chips" role="group" aria-label="דוגמאות">${EXAMPLES.map((t) => html`<button type="button" data-click="demo-gen-example" data-text="${t}">${t}</button>`)}</div>
      <div class="banner info">${NOTE}</div>
      <div class="col"><button class="primary big" data-click="demo-gen-go">${icon("sparkles")} ליצור</button>
        <button class="big" data-click="demo-gen-close">ביטול</button></div>`;
  } else if (g.step === "working") {
    body = html`<h2>יוצרת שלוש אפשרויות…</h2>
      <p class="muted" role="status" aria-busy="true"><span class="spin"></span> זה לוקח כמה שניות.</p>
      <div class="banner info">${NOTE}</div>`;
  } else {
    body = html`<h2>בחרי גרסה</h2>
      <div class="gen-opts" role="group" aria-label="אפשרויות">${g.options.map((o) => html`<button type="button" class="gen-opt" aria-pressed="${g.picked === o.id}"
        data-click="demo-gen-pick" data-id="${o.id}"><img src="${o.url}" alt="${o.label}"><span>${o.label}</span></button>`)}</div>
      <p class="muted small">התמונה המקורית נשמרת תמיד. הגרסה החדשה נשמרת פרטית, עם קישור למקור.</p>
      <div class="banner info">${NOTE}</div>
      <div class="col"><button class="primary big" data-click="demo-gen-save" ${g.picked && g.step === "pick" ? "" : html`disabled`}>שמירה כגרסה חדשה</button>
        <button class="big" data-click="demo-gen-retry" ${busy ? html`disabled` : ""}>לנסות שוב</button>
        <button class="ghost big" data-click="demo-gen-close">ביטול</button></div>`;
  }
  return html`<div class="sheet-bg cf-bg" data-click="demo-gen-close"></div>
    <div class="sheet confirm gen" role="dialog" aria-modal="true" aria-label="ליצור גרסה חדשה">${body}</div>`;
}

/** The real picture sheet has no "create" button (it doesn't exist yet), so the demo adds one after each draw. */
export function injectGenButton() {
  if (demo.who !== "mom" || GEN.cur || !G.open) return;
  const sheet = document.querySelector<HTMLElement>(".sheet.viewer");
  const del = sheet?.querySelector('[data-click="g-idelete"]');
  if (!sheet || !del || sheet.querySelector('[data-click="demo-gen-open"]')) return;
  const b = document.createElement("button");
  b.type = "button";
  b.className = "primary big";
  b.dataset.click = "demo-gen-open";
  b.dataset.id = G.open;
  b.innerHTML = `${icon("sparkles")} ליצור גרסה חדשה <small class="demo-tag">דוגמה</small>`;
  del.before(b);
}

// ---------------------------------------------------------------- the steps
on("click", "demo-gen-open", (el) => {
  GEN.cur = { image: el.dataset.id!, step: GEN.consented ? "form" : "consent", prompt: "", options: [], picked: null };
  rerender();
});
on("click", "demo-gen-consent", () => { GEN.consented = true; if (GEN.cur) GEN.cur.step = "form"; rerender(); });
on("click", "demo-gen-example", (el) => { if (GEN.cur) GEN.cur.prompt = el.dataset.text ?? ""; rerender(); });
on("input", "demo-gen-input", (el) => { if (GEN.cur) GEN.cur.prompt = (el as HTMLInputElement).value; });
on("click", "demo-gen-close", () => { if (GEN.cur?.step !== "working" && GEN.cur?.step !== "saving") close(); });
on("click", "demo-gen-retry", () => { release(); if (GEN.cur) { GEN.cur.step = "form"; GEN.cur.options = []; GEN.cur.picked = null; } rerender(); });
on("click", "demo-gen-pick", (el) => { if (GEN.cur) GEN.cur.picked = el.dataset.id ?? null; rerender(); });

on("click", "demo-gen-go", async () => {
  const g = GEN.cur;
  if (!g) return;
  g.prompt = ($<HTMLInputElement>("demoGenPrompt")?.value ?? g.prompt).trim();
  if (!g.prompt) { flash("כותבים מה לשנות, או לוחצים על אחת הדוגמאות.", "info"); return; }
  const src = sourceOf(g.image);
  if (!src) { flash("אי אפשר לפתוח את התמונה הזאת בהדגמה.", "err"); return; }
  g.step = "working";
  rerender();
  try {
    const [opts] = await Promise.all([makeOptions(src, g.prompt), sleep(2200)]);
    if (GEN.cur !== g) { opts.forEach((o) => URL.revokeObjectURL(o.url)); return; }   // cancelled meanwhile
    g.options = opts;
    g.picked = null;
    g.step = "pick";
  } catch {
    g.step = "form";
    flash("לא הצלחנו ליצור בהדגמה. אפשר לנסות שוב.", "err");
  }
  rerender();
});

on("click", "demo-gen-save", async () => {
  const g = GEN.cur;
  const o = g?.options.find((x) => x.id === g.picked);
  if (!g || !o) return;
  g.step = "saving";
  rerender();
  try {
    const path = `demo-mom/mom/${crypto.randomUUID()}.jpg`;
    demo.db.upload(path, o.blob);
    const id = demo.db.rpc("mom", "add_generated", { p_parent: g.image, p_path: path, p_width: o.w, p_height: o.h }) as string;
    release();
    GEN.cur = null;
    await Promise.all([loadGallery(), loadCollections()]);
    G.open = id;
    await loadMembership(id).catch(() => { G.memberOf[id] = []; });
    flash("✓ נשמרה גרסה חדשה. התמונה המקורית נשמרה", "ok");
  } catch {
    g.step = "pick";
    flash("השמירה נכשלה. אפשר לנסות שוב.", "err");
  }
  rerender();
});

addEventListener("keydown", (e) => {
  if (e.key === "Escape" && GEN.cur && GEN.cur.step !== "working" && GEN.cur.step !== "saving") close();
});
