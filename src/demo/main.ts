// Entry of the DEMO build (vite --mode demo). It shows the real painter and family screens on
// top of the in-memory database: a fixed bar says it is a demo, and a switch changes who is
// looking (Mom / a family member). No sign-in, no Supabase, no keys, no service worker,
// nothing stored: a refresh puts everything back.
import "../styles.css";
import "./demo.css";
import { html, render, type SafeHtml } from "../lib/html.ts";
import { installEvents, on } from "../lib/events.ts";
import { S, setRenderer } from "../state.ts";
import { loadAll } from "../images.ts";
import { renderHome } from "../ui/home.ts";
import { markArt } from "../ui/art.ts";
import { PEOPLE, type Who } from "./db.ts";
import { demo } from "./runtime.ts";
import { GEN, genSheet, injectGenButton } from "./gen.ts";

const FAMILY = { can_send: true, can_view: true, can_comment: true, can_generate: false };
const ALL = { can_send: true, can_view: true, can_comment: true, can_generate: true };

function setWho(who: Who) {
  demo.who = who;
  GEN.cur = null;                      // an open "create" screen belongs to the person who opened it
  const mom = who === "mom";
  S.myName = PEOPLE[who];
  S.painterName = PEOPLE.mom;
  S.sid = `demo-${who}`;              // a new "studio id" makes the app reload its lists for this role
  S.studios = [{ id: S.sid, name: "הסטודיו של אמא", role: mom ? "painter" : "family", perms: mom ? ALL : FAMILY }];
  window.scrollTo({ top: 0 });
  return loadAll();
}

on("click", "demo-who", (el) => { void setWho(el.dataset.who as Who); });

function view(): SafeHtml {
  const mom = demo.who === "mom";
  return html`<div class="demo-bar" role="region" aria-label="גרסת הדגמה">
      <p><b>גרסת הדגמה – שום דבר לא נשמר</b></p>
      <div class="seg" role="radiogroup" aria-label="מי מסתכל">
        <button type="button" role="radio" aria-checked="${mom}" data-click="demo-who" data-who="mom">אמא</button>
        <button type="button" role="radio" aria-checked="${!mom}" data-click="demo-who" data-who="fam">בן משפחה</button>
      </div>
    </div>
    <header class="top">
      <div class="brand">${markArt()}<div><small>השראה לציור</small><h1>הסטודיו של אמא</h1></div></div>
    </header>
    <main class="wrap">${renderHome()}</main>
    ${genSheet()}`;
}

// keep what someone typed in a text box while the screen redraws (same idea as the real app)
type Snap = { value: string; def: string; focus: boolean };
function snapshot(): Map<string, Snap> {
  const m = new Map<string, Snap>();
  document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("#app input[id], #app textarea[id]").forEach((el) => {
    if (el instanceof HTMLInputElement && !["text", "email", "search"].includes(el.type)) return;
    m.set(el.id, { value: el.value, def: el.defaultValue, focus: document.activeElement === el });
  });
  return m;
}
function restore(m: Map<string, Snap>) {
  for (const [id, s] of m) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el) continue;
    if (el.defaultValue === s.def && s.value !== s.def) el.value = s.value;
    if (s.focus) el.focus();
  }
}

function renderAll() {
  const root = document.getElementById("app");
  if (!root) return;
  const snap = snapshot();
  render(root, html`${view()}${S.flash ? html`<div class="flash banner ${S.flash.kind}" role="status">${S.flash.text}</div>` : ""}`);
  restore(snap);
  injectGenButton();
}

installEvents();
setRenderer(renderAll);
document.body.classList.add("in-app", "demo");
S.user = { id: "demo", email: "" };
S.view = "app";
void setWho("mom");
