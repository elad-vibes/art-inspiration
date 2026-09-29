// Sign-in (e-mail code + magic link), joining by invite, and two-factor
// authentication (TOTP): the code prompt on a new device and enrollment.
// Two-factor is required for the admin only (DECISIONS 6); anyone may add it.
import { attr, html, type SafeHtml, $ } from "../lib/html.ts";
import { on } from "../lib/events.ts";
import { appUrl, dbMessage, sb } from "../lib/supa.ts";
import { S, flash, rerender } from "../state.ts";
import { fn } from "../data.ts";
import { permSummary } from "../domain/perms.ts";
import { banner, copyText } from "./common.ts";
import { markArt } from "./art.ts";

const logo = () => markArt();
const A = () => (S.extra.auth ??= {}) as Record<string, any>;
const JOIN_KEY = "pi-join";

// ------------------------------------------------------------------ sign in
export function renderSignin(): SafeHtml {
  const a = A();
  if (a.sentTo) return codeForm(a.sentTo, "signin");
  return html`<div class="auth">${logo()}<h1>השראה לציור</h1>
    <p class="muted">מתחברים עם כתובת המייל. נשלח אליך קוד בן 6 ספרות.</p>
    ${a.msg ? banner(a.msg, a.msgKind ?? "info") : ""}
    <form class="card" data-submit="signin-email">
      <label class="f">כתובת מייל<input type="email" id="authEmail" autocomplete="email" inputmode="email" required value="${a.email ?? ""}"></label>
      <button class="primary big" type="submit" ${attr(a.busy, "disabled")}>${a.busy ? html`<span class="spin"></span>` : "שליחת קוד"}</button>
    </form>
    <p class="muted small">מצטרפים רק דרך קישור הזמנה ממנהל האפליקציה.</p>
    <p class="small"><a href="#/install">איך מתקינים את האפליקציה במסך הבית?</a></p>
  </div>`;
}

function codeForm(email: string, mode: "signin" | "join"): SafeHtml {
  const a = A();
  return html`<div class="auth">${logo()}<h1>בדקו את המייל</h1>
    <p>שלחנו ל-<b dir="ltr">${email}</b> מייל עם קוד. מקלידים אותו כאן.</p>
    <p class="muted small">לא הגיע? כדאי לבדוק בתיקיית הספאם, או שהכתובת נכונה.</p>
    ${a.msg ? banner(a.msg, a.msgKind ?? "err") : ""}
    <form class="card" data-submit="verify-code" data-mode="${mode}">
      <label class="f">הקוד מהמייל<input class="code" id="authCode" inputmode="numeric" autocomplete="one-time-code" maxlength="10" required></label>
      <button class="primary big" type="submit" ${attr(a.busy, "disabled")}>${a.busy ? html`<span class="spin"></span>` : "כניסה"}</button>
    </form>
    <div class="row"><button class="ghost" data-click="resend" data-mode="${mode}" ${attr(a.cooldown, "disabled")}>שליחה חוזרת</button><button class="ghost" data-click="change-email">כתובת אחרת</button></div>
  </div>`;
}

async function sendCode(email: string, redirect: string) {
  const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: redirect } });
  // Unknown addresses get the same screen (no account enumeration).
  if (error && !/signups not allowed|not found|otp_disabled/i.test(error.message)) {
    if (/rate|too many|security purposes/i.test(error.message)) throw new Error("נשלחו יותר מדי קודים. אפשר לנסות שוב בעוד דקה.");
    throw new Error("שליחת המייל נכשלה. כדאי לנסות שוב בעוד רגע.");
  }
}

on("submit", "signin-email", async () => {
  const a = A();
  const email = ($("authEmail") as HTMLInputElement).value.trim().toLowerCase();
  a.busy = true; a.msg = null; a.email = email; rerender();
  try {
    await sendCode(email, appUrl());
    a.sentTo = email;
    startCooldown();
  } catch (e: any) { a.msg = e.message; a.msgKind = "err"; }
  a.busy = false; rerender();
});

function startCooldown() {
  const a = A();
  a.cooldown = true;
  setTimeout(() => { a.cooldown = false; rerender(); }, 60_000);
}

on("click", "resend", async (el) => {
  const a = A();
  try {
    await sendCode(a.sentTo, el.dataset.mode === "join" ? `${appUrl()}#/join/${S.joinToken}` : appUrl());
    startCooldown();
    flash("נשלח קוד חדש", "info");
  } catch (e: any) { flash(e.message, "err"); }
});
on("click", "change-email", () => { const a = A(); a.sentTo = null; a.msg = null; rerender(); });

on("submit", "verify-code", async () => {
  const a = A();
  const token = ($("authCode") as HTMLInputElement).value.replace(/\D/g, "");
  if (token.length < 6) { a.msg = "הקוד צריך להיות לפחות 6 ספרות."; rerender(); return; }
  a.busy = true; a.msg = null; rerender();
  const { error } = await sb.auth.verifyOtp({ email: a.sentTo, token, type: "email" });
  a.busy = false;
  if (error) { a.msg = /expired/i.test(error.message) ? "תוקף הקוד פג. אפשר לבקש קוד חדש." : "הקוד לא נכון. כדאי לבדוק ולנסות שוב."; a.msgKind = "err"; rerender(); return; }
  a.sentTo = null;
  // onAuthStateChange (main.ts) continues: join → accept invite, or boot
});

// ------------------------------------------------------------------- join
export function renderJoin(): SafeHtml {
  const a = A();
  if (a.sentTo) return codeForm(a.sentTo, "join");
  if (a.inviteError) return html`<div class="auth">${logo()}<h1>הזמנה</h1>${banner(a.inviteError, "err")}<p><button class="ghost" data-click="join-cancel">למסך הכניסה</button></p></div>`;
  const info = a.invite as Awaited<ReturnType<typeof fn.inviteInfo>> | null;
  if (!info) return html`<div class="auth">${logo()}<p class="muted"><span class="spin"></span> בודק את ההזמנה…</p></div>`;
  const painter = info.role === "painter";
  return html`<div class="auth">${logo()}<h1>${painter ? "ברוכה הבאה לסטודיו שלך" : html`הוזמנת ל"${info.studio_name}"`}</h1>
    <p class="muted">${painter ? `"${info.studio_name}" — כאן שומרים תמונות לציור, מקבלים הצעות מהמשפחה ומבקשים תמונות חדשות.` : `מה אפשר לעשות: ${permSummary(info, "family")}.`}</p>
    ${a.msg ? banner(a.msg, a.msgKind ?? "err") : ""}
    <form class="card" data-submit="join-submit">
      <label class="f">איך לקרוא לך באפליקציה?<input type="text" id="joinName" maxlength="40" required value="${a.joinName ?? info.person_name ?? ""}"></label>
      ${S.user ? html`<p class="small">מחובר/ת בתור <b dir="ltr">${S.user.email}</b></p>`
        : html`<label class="f">כתובת מייל<input type="email" id="joinEmail" autocomplete="email" inputmode="email" required></label>`}
      <button class="primary big" type="submit" ${attr(a.busy, "disabled")}>${a.busy ? html`<span class="spin"></span>` : S.user ? "הצטרפות" : "שליחת קוד"}</button>
    </form>
  </div>`;
}

export async function loadInvite() {
  const a = A();
  if (!S.joinToken || a.invite || a.inviteError) return;
  try {
    a.invite = await fn.inviteInfo(S.joinToken);
  } catch (e: any) {
    a.inviteError = e.message;
  }
  rerender();
}

on("submit", "join-submit", async () => {
  const a = A();
  const name = ($("joinName") as HTMLInputElement).value.trim();
  a.joinName = name;
  a.busy = true; a.msg = null; rerender();
  try {
    if (S.user) {
      await acceptInvite();
      return;
    }
    const email = ($("joinEmail") as HTMLInputElement).value.trim().toLowerCase();
    await fn.inviteClaim(S.joinToken!, email);
    localStorage.setItem(JOIN_KEY, JSON.stringify({ token: S.joinToken, name }));
    await sendCode(email, `${appUrl()}#/join/${S.joinToken}`);
    a.sentTo = email;
    startCooldown();
  } catch (e: any) {
    a.msg = e.message; a.msgKind = "err";
  } finally {
    a.busy = false; rerender();
  }
});

/** Leaves the invite screen and clears every trace of the pending invite. */
export function leaveJoin() {
  const a = A();
  try { localStorage.removeItem(JOIN_KEY); } catch { /* private mode */ }
  S.joinToken = null;
  a.invite = null; a.inviteError = null; a.sentTo = null; a.msg = null;
  history.replaceState(null, "", location.pathname + location.search);
}
on("click", "join-cancel", () => {
  leaveJoin();
  if (S.user) location.reload(); else { S.view = "signin"; rerender(); }
});

/** Called after sign-in when a join token is pending. */
export async function acceptInvite(): Promise<boolean> {
  const a = A();
  let pending: { token: string; name: string } | null = null;
  try { pending = JSON.parse(localStorage.getItem(JOIN_KEY) || "null"); } catch { /* ignore */ }
  const token = S.joinToken ?? pending?.token;
  if (!token) return false;
  const name = a.joinName ?? pending?.name ?? null;
  const { data, error } = await sb.rpc("accept_invite", { p_token: token, p_display_name: name });
  localStorage.removeItem(JOIN_KEY);
  if (error) { a.inviteError = dbMessage(error); S.joinToken = null; S.view = "join"; rerender(); return false; }
  localStorage.setItem("pi-sid", String(data));
  S.joinToken = null;
  history.replaceState(null, "", location.pathname + location.search);
  location.hash = "#/";
  location.reload();
  return true;
}

// -------------------------------------------------------------- MFA prompt
export function renderMfaChallenge(): SafeHtml {
  const a = A();
  return html`<div class="auth">${logo()}<h1>קוד מאפליקציית האימות</h1>
    <p class="muted">מקלידים את הקוד בן 6 הספרות שמופיע עכשיו באפליקציית האימות (Google Authenticator, Microsoft Authenticator או "סיסמאות" באייפון).</p>
    ${a.msg ? banner(a.msg, "err") : ""}
    <form class="card" data-submit="mfa-verify">
      <label class="f">קוד<input class="code" id="mfaCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></label>
      <button class="primary big" type="submit" ${attr(a.busy, "disabled")}>${a.busy ? html`<span class="spin"></span>` : "אישור"}</button>
    </form>
    ${a.lost ? banner("אם אין גישה לאפליקציית האימות, מנהל האפליקציה יכול לאפס את האימות הדו-שלבי של החשבון, ואז מגדירים אותו מחדש.", "info") : ""}
    <div class="row"><button class="ghost" data-click="mfa-lost">אין לי גישה לאפליקציה</button><button class="ghost" data-click="signout">יציאה</button></div>
  </div>`;
}

async function factors() {
  const { data } = await sb.auth.mfa.listFactors();
  const all = (data?.all ?? []) as any[];
  return {
    totp: all.find((f) => f.factor_type === "totp" && f.status === "verified"),
    unverified: all.filter((f) => f.status === "unverified"),
  };
}

on("click", "mfa-lost", () => { A().lost = true; rerender(); });
on("submit", "mfa-verify", async () => {
  const a = A();
  const code = ($("mfaCode") as HTMLInputElement).value.replace(/\D/g, "");
  const f = await factors();
  if (!f.totp) { a.msg = "לא נמצאה אפליקציית אימות מוגדרת."; rerender(); return; }
  a.busy = true; a.msg = null; rerender();
  const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: f.totp.id, code });
  a.busy = false;
  if (error) { a.msg = "הקוד לא נכון או שפג תוקפו (הוא מתחלף כל 30 שניות). כדאי לנסות שוב."; rerender(); return; }
  location.reload();
});

// ---------------------------------------------------------- MFA enrollment
export function renderMfaEnroll(): SafeHtml {
  const a = A();
  const required = !!S.extra.adminGate;
  const step = a.enroll?.step ?? "intro";
  if (step === "done") {
    return html`<div class="auth">${logo()}<h1>✓ האימות הדו-שלבי מוגדר</h1>
      <p>מעכשיו, בכל כניסה ממכשיר חדש תתבקשו להקליד קוד מאפליקציית האימות. במכשיר הזה לא תתבקשו בכל פתיחה.</p>
      <button class="primary big" data-click="enroll-done">המשך</button></div>`;
  }
  if (step === "qr") {
    const e = a.enroll;
    return html`<div class="auth">${logo()}<h1>הוספה לאפליקציית האימות</h1>
      <ol class="steps">
        <li><b>בטלפון הזה:</b> לוחצים על הכפתור. הוא פותח את אפליקציית האימות (או "סיסמאות" באייפון) ומוסיף את החשבון.
          <div style="margin-top:8px"><a class="btnlink" href="${e.uri}">הוספה לאפליקציית האימות</a></div></li>
        <li><b>ממחשב או טלפון אחר:</b> סורקים את הקוד.<div class="qr" style="margin-top:8px"><img src="${e.qr}" alt="QR להוספה לאפליקציית האימות"></div></li>
        <li><b>ידנית:</b> מעתיקים את המפתח לאפליקציה.<div class="secret" style="margin-top:8px">${e.secret}</div><button class="ghost" data-click="secret-copy">העתקת המפתח</button></li>
      </ol>
      ${a.msg ? banner(a.msg, "err") : ""}
      <form class="card" data-submit="enroll-verify">
        <label class="f">הקוד בן 6 הספרות שמופיע עכשיו באפליקציה<input class="code" id="enrollCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></label>
        <button class="primary big" type="submit" ${attr(a.busy, "disabled")}>${a.busy ? html`<span class="spin"></span>` : "אימות"}</button>
      </form>
      <button class="ghost" data-click="enroll-cancel">${required ? "יציאה" : "לא עכשיו"}</button>
    </div>`;
  }
  return html`<div class="auth">${logo()}<h1>אימות דו-שלבי</h1>
    <p>${required ? "מסך הניהול דורש אימות דו-שלבי." : "לא חובה. גם אם מישהו ישיג גישה למייל, הוא לא ייכנס בלי הטלפון."}
      בכל כניסה ממכשיר חדש מקלידים קוד מתחלף מאפליקציית אימות. במכשיר שכבר מחובר לא מתבקשים בכל פתיחה.</p>
    <div class="card"><h3>צריך אפליקציית אימות אחת מאלה:</h3>
      <ul class="plain"><li>באייפון (iOS 18 ומעלה): אפליקציית "סיסמאות" המובנית</li><li>Google Authenticator</li><li>Microsoft Authenticator</li></ul></div>
    ${a.msg ? banner(a.msg, "err") : ""}
    <button class="primary big" data-click="enroll-start" ${attr(a.busy, "disabled")}>${a.busy ? html`<span class="spin"></span>` : "המשך"}</button>
    <button class="ghost" data-click="enroll-cancel">${required ? "יציאה" : "לא עכשיו"}</button>
  </div>`;
}

on("click", "mfa-enroll-start", () => { S.view = "mfa-enroll"; A().enroll = { step: "intro" }; rerender(); });
on("click", "enroll-start", async () => {
  const a = A();
  a.busy = true; a.msg = null; rerender();
  try {
    const f = await factors();
    for (const u of f.unverified) await sb.auth.mfa.unenroll({ factorId: u.id });  // clean half-finished attempts
    const { data, error } = await sb.auth.mfa.enroll({ factorType: "totp", friendlyName: `השראה לציור ${new Date().toISOString().slice(0, 10)}`, issuer: "השראה לציור" });
    if (error || !data) throw error ?? new Error("enroll");
    a.enroll = { step: "qr", factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret, uri: data.totp.uri };
  } catch {
    a.msg = "ההגדרה לא התחילה. כדאי לנסות שוב.";
  }
  a.busy = false; rerender();
});
on("click", "secret-copy", async () => flash((await copyText(A().enroll?.secret ?? "")) ? "המפתח הועתק" : "לא הצלחתי להעתיק", "info"));
on("submit", "enroll-verify", async () => {
  const a = A();
  const code = ($("enrollCode") as HTMLInputElement).value.replace(/\D/g, "");
  a.busy = true; a.msg = null; rerender();
  const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: a.enroll.factorId, code });
  a.busy = false;
  if (error) { a.msg = "הקוד לא נכון. בודקים שהשעה בטלפון מדויקת ומקלידים את הקוד שמופיע עכשיו."; rerender(); return; }
  await sb.auth.refreshSession();
  a.enroll = { step: "done" };
  S.hasFactor = true;
  rerender();
});
on("click", "enroll-done", () => { A().enroll = null; location.reload(); });
on("click", "enroll-cancel", async () => {
  if (S.extra.adminGate) { S.extra.adminGate = false; location.hash = "#/"; location.reload(); return; }
  A().enroll = null;
  S.view = "app";
  rerender();
});
