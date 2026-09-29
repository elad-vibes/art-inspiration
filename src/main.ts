// App shell: boot, auth gate, hash router, rendering.
import "./styles.css";
import type { Session } from "@supabase/supabase-js";
import { html, render, type SafeHtml } from "./lib/html.ts";
import { installEvents, on } from "./lib/events.ts";
import { configured, sb } from "./lib/supa.ts";
import { rerender, S, setRenderer, studio } from "./state.ts";
import { bootStudio, refreshAal } from "./data.ts";
import { acceptInvite, loadInvite, renderJoin, renderMfaChallenge, renderMfaEnroll, renderSignin } from "./ui/auth.ts";
import { loadAdmin, renderAdmin } from "./ui/admin.ts";
import { isStandalone, ONBOARDED, renderInstall } from "./ui/onboarding.ts";
import { renderHome, renderMenu } from "./ui/home.ts";
import { loadAll, watchNetwork } from "./images.ts";
import { banner } from "./ui/common.ts";
import { art, markArt } from "./ui/art.ts";
import { icon } from "./ui/icons.ts";

// ------------------------------------------------------------------ routing
function readHash(): string {
  const [a, b] = location.hash.replace(/^#\/?/, "").split("/");
  if (a === "join" && /^[0-9a-f]{64}$/.test(b ?? "")) S.joinToken = b;
  return a ?? "";
}

async function onHash() {
  const a = readHash();
  S.menu = false;
  if (a === "install") { S.view = "install"; rerender(); return; }
  if (a === "admin") { await openAdmin(); return; }
  if (a === "join" && S.joinToken) { S.view = "join"; await loadInvite(); return; }
  if (S.user && ["install", "admin", "mfa-enroll"].includes(S.view)) { await start(); return; }
  rerender();
  window.scrollTo({ top: 0 });
}

async function openAdmin() {
  if (!S.user) { S.view = "signin"; rerender(); return; }
  if (!S.isAdmin) { location.hash = "#/"; return; }
  await refreshAal();
  if (S.aal.current !== "aal2") {
    S.extra.adminGate = true;
    S.view = S.hasFactor ? "mfa-challenge" : "mfa-enroll";
    rerender();
    return;
  }
  S.view = "admin";
  rerender();
  await loadAdmin();
}

on("click", "reload", () => location.reload());
on("click", "sw-update", () => { navigator.serviceWorker.getRegistration().then((r) => r?.waiting?.postMessage("SKIP_WAITING")); });

// ------------------------------------------------------------------ boot
async function onSession(session: Session | null) {
  if (!session) {
    S.user = null;
    S.view = S.joinToken ? "join" : location.hash.startsWith("#/install") ? "install" : "signin";
    if (S.view === "join") await loadInvite();
    rerender();
    return;
  }
  S.user = { id: session.user.id, email: session.user.email ?? "" };
  if (S.joinToken || localStorage.getItem("pi-join")) {
    if (await acceptInvite()) return;
  }
  await start();
}

async function start() {
  S.view = "loading";
  rerender();
  let r: Awaited<ReturnType<typeof bootStudio>>;
  try {
    r = await bootStudio();
    S.offline = false;
  } catch {
    S.offline = true;
    S.view = "app";
    rerender();
    return;
  }
  if (r === "mfa-challenge") { S.view = "mfa-challenge"; rerender(); return; }
  if (location.hash.startsWith("#/admin")) { await openAdmin(); return; }
  if (r === "none") { S.view = "nostudio"; rerender(); return; }
  const mobile = /mobile|iphone|android/i.test(navigator.userAgent);
  let onboarded = true;
  try { onboarded = !!localStorage.getItem(ONBOARDED); } catch { /* private mode */ }
  S.view = !isStandalone() && !onboarded && mobile ? "install" : "app";
  rerender();
  await loadAll();
}

async function boot() {
  installEvents();
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => rerender());
  setRenderer(renderAll);
  if (!configured) { S.view = "noconfig"; renderAll(); return; }
  readHash();
  renderAll();
  const { data } = await sb.auth.getSession();
  await onSession(data.session);
  sb.auth.onAuthStateChange((event, session) => {
    // never await Supabase calls inside this callback (auth lock); defer instead
    if (event === "SIGNED_IN" && !S.user) setTimeout(() => onSession(session), 0);
    if (event === "SIGNED_OUT" && S.user) { S.user = null; setTimeout(() => location.reload(), 0); }
  });
  addEventListener("hashchange", () => { onHash(); });
  addEventListener("online", () => { if (S.offline) start(); });
  watchNetwork();
  registerServiceWorker();
}

function registerServiceWorker() {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL }).then((reg) => {
    const ask = () => { S.extra.swUpdate = true; rerender(); };
    if (reg.waiting && navigator.serviceWorker.controller) ask();
    reg.addEventListener("updatefound", () => {
      reg.installing?.addEventListener("statechange", () => { if (reg.waiting && navigator.serviceWorker.controller) ask(); });
    });
  }).catch(() => undefined);
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (!reloaded) { reloaded = true; location.reload(); } });
}

// ---------------------------------------------------------------- render
const skeleton = () => html`<div class="skel" aria-busy="true" aria-label="טוען">
  <div class="skel-card"><div class="skel-line" style="width:40%"></div><div class="skel-img"></div></div>
  <div class="skel-card"><div class="skel-line" style="width:30%"></div><div class="skel-line"></div><div class="skel-line" style="width:70%"></div></div></div>`;

function shell(): SafeHtml {
  if (S.offline) {
    return html`<div class="auth"><div class="card empty">${art.offline()}<h2>אין חיבור כרגע</h2>
      <p class="muted">לא הצלחנו להגיע לשרת. כשהאינטרנט יחזור, האפליקציה תתעדכן לבד.</p>
      <button class="primary big" data-click="reload">${icon("refresh-cw")} לנסות שוב</button></div></div>`;
  }
  const s = studio();
  return html`<header class="top">
      <div class="brand">${markArt()}<div><small>השראה לציור</small><h1>${s?.name ?? ""}</h1></div></div>
      <button class="iconbtn" data-click="menu" aria-label="תפריט" aria-expanded="${S.menu}">${icon("menu")}</button>
    </header>
    ${S.extra.swUpdate ? banner(html`יש גרסה חדשה של האפליקציה. <button data-click="sw-update">עדכון</button>`, "info") : ""}
    <main class="wrap">${renderHome()}</main>
    ${renderMenu()}`;
}

function viewHtml(): SafeHtml {
  switch (S.view) {
    case "noconfig": return html`<div class="auth">${markArt()}<h1>השראה לציור</h1>${banner("חסרים פרטי חיבור ל-Supabase (VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY).", "err")}</div>`;
    case "loading": return html`<div class="wrap" style="margin-top:4vh">${skeleton()}</div>`;
    case "signin": return renderSignin();
    case "join": return renderJoin();
    case "mfa-challenge": return renderMfaChallenge();
    case "mfa-enroll": return renderMfaEnroll();
    case "install": return renderInstall();
    case "admin": return html`<div class="wrap">${renderAdmin()}</div>`;
    case "nostudio": return html`<div class="auth">${markArt()}<h1>עוד לא צורפת לסטודיו</h1>
      <p>החשבון מחובר, אבל עוד לא הצטרפת לאף סטודיו. כדי להצטרף צריך קישור הזמנה ממנהל האפליקציה.</p>
      ${S.isAdmin ? html`<button class="primary big" data-click="go-admin">${icon("users")} ניהול: סטודיו ואנשים</button>` : ""}
      <button class="ghost" data-click="signout">יציאה</button></div>`;
    default: return shell();
  }
}

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
    if (el.defaultValue === s.def && s.value !== s.def) el.value = s.value; // keep what the user typed
    if (s.focus) el.focus();
  }
}

function renderAll() {
  const root = document.getElementById("app");
  if (!root) return;
  document.body.classList.toggle("in-app", S.view === "app");
  const snap = snapshot();
  render(root, html`${viewHtml()}${S.flash ? html`<div class="flash banner ${S.flash.kind}" role="status">${S.flash.text}</div>` : ""}`);
  restore(snap);
}

boot();
