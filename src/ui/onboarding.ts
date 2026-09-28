// התקנה למסך הבית — instructions for iPhone and Android.
import { html, type SafeHtml } from "../lib/html.ts";
import { on } from "../lib/events.ts";
import { S, rerender } from "../state.ts";
import { markArt } from "./art.ts";

export const ONBOARDED = "pi-onboarded";
export const isStandalone = () =>
  matchMedia("(display-mode: standalone)").matches || (navigator as any).standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

let deferred: any = null;
addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e; });

export function renderInstall(): SafeHtml {
  const ios = isIOS();
  return html`<div class="auth">
    ${markArt()}
    <h1>התקנה למסך הבית</h1>
    <p class="muted">כך האפליקציה נפתחת מאייקון, כמו כל אפליקציה בטלפון.</p>
    ${isStandalone() ? html`<div class="banner ok">✓ האפליקציה כבר מותקנת ופתוחה ממסך הבית.</div>` : ""}
    <div class="card"><h2>${ios ? "באייפון (Safari)" : "באייפון"}</h2>
      <ol class="steps">
        <li>פותחים את הקישור ב-<b>Safari</b> (לא בתוך וואטסאפ — שם לוחצים "פתיחה ב-Safari").</li>
        <li>לוחצים על כפתור <b>השיתוף</b> (ריבוע עם חץ למעלה, בתחתית המסך).</li>
        <li>גוללים ובוחרים <b>"הוספה למסך הבית"</b>, ואז <b>"הוספה"</b>.</li>
        <li>פותחים את האפליקציה מהאייקון החדש ומתחברים <b>שם</b> עם הקוד מהמייל.</li>
      </ol>
    </div>
    <div class="card"><h2>באנדרואיד (Chrome)</h2>
      ${deferred ? html`<button class="primary big" data-click="install-now">התקנה עכשיו</button>` : ""}
      <ol class="steps">
        <li>פותחים את הקישור ב-<b>Chrome</b>.</li>
        <li>לוחצים על <b>⋮</b> (שלוש נקודות למעלה) ובוחרים <b>"התקנת אפליקציה"</b> או <b>"הוספה למסך הבית"</b>.</li>
        <li>פותחים מהאייקון החדש.</li>
      </ol>
    </div>
    <button class="big" data-click="install-done">${S.user ? "חזרה לאפליקציה" : "להתחברות"}</button>
  </div>`;
}

on("click", "install-now", async () => {
  if (!deferred) return;
  deferred.prompt();
  await deferred.userChoice.catch(() => undefined);
  deferred = null;
  rerender();
});
on("click", "install-done", () => {
  try { localStorage.setItem(ONBOARDED, "1"); } catch { /* private mode */ }
  location.hash = "#/";
});
