# SETUP — הקמה (מה אלעד עושה, ומתי)

## מצב נוכחי (עודכן 29.09.2026): שלבים 1–2 בוצעו והאפליקציה חיה
**https://elad-vibes.github.io/art-inspiration/** — ריפו ציבורי, Supabase נפרד (Frankfurt), SMTP דרך
Gmail (App Password), הרשמה סגורה + קוד במייל + TOTP, כל 8 המיגרציות ושלוש הפונקציות פרוסות,
`CRON_SECRET` מוגדר, התזמון רץ (ראה למטה — לא דרך Integrations, אלא ב-`pg_cron`/`pg_net` ישירות
במסד), ואלעד רשום ב-`app_admins`. הפירוט המלא נשאר למטה בשביל פרויקט Supabase נוסף/חדש.

## 1. GitHub (פעם אחת)
- ריפו **ציבורי** בשם `art-inspiration` בחשבון `elad-vibes` (GitHub Pages חינמי רק לריפו ציבורי;
  בריפו אין נתונים ואין מפתחות — AGENTS.md).
- Settings → Pages → Source: **GitHub Actions**.
- Settings → Secrets and variables → Actions → **Variables**: `VITE_SUPABASE_URL`,
  `VITE_SUPABASE_PUBLISHABLE_KEY` — ערכים ציבוריים (אפשר `gh variable set <שם> --repo <חשבון>/<ריפו>`
  עם הערך נקרא מ-`.env.local`, בלי להדביק בצ'אט).

## 2. Supabase — פרויקט חדש ונפרד (פעם אחת)
- פרויקט חדש (אזור קרוב לישראל, למשל Frankfurt). **לא** הפרויקט של "הכסף של הבית".
  בתוכנית החינמית אפשר 2 פרויקטים פעילים — לבדוק שיש מקום.
- SMTP: **App Password של Gmail** (myaccount.google.com/apppasswords, לא הסיסמה הרגילה) הוגדר דרך ה-API
  (`PATCH /v1/projects/{ref}/config/auth`), לא ידנית בלוח הבקרה. Brevo עובד באותה צורה אם עדיפה.
  תבנית מייל הקוד בעברית (`{{ .Token }}` בגדול) נקבעת רק **אחרי** שה-SMTP מחובר — Supabase חוסם עריכת
  תבנית בלי SMTP מותאם.
- Auth (`PATCH /v1/projects/{ref}/config/auth`): `disable_signup: true` · קוד במייל בן 6 ספרות
  (`mailer_otp_length: 6`) · `mfa_totp_enroll_enabled` + `mfa_totp_verify_enabled: true` · SMS/משתמשים
  אנונימיים כבויים · `rate_limit_email_sent` הועלה מ-2 (ברירת המחדל של שרת המייל המשותף) ל-30, כי עם
  SMTP עצמי אין סיבה שתישאר נמוכה וכמה בני משפחה שנכנסים באותה שעה נתקלים בה.
- מילוי `.env.local` לפי `.env.example` (מקומי בלבד, לא בצ'אט). `SUPABASE_ACCESS_TOKEN`:
  supabase.com/dashboard/account/tokens.
- `npx supabase link --project-ref <ref>` ואז `npx supabase db push` — כל 8 המיגרציות
  (`supabase/migrations/0001–0008`) בבת אחת, מסודרות לפי שם קובץ.
- `npx supabase functions deploy --use-api` — שלוש הפונקציות (`invite-signin`, `delete-image`,
  `storage-cleanup`) לפי `supabase/config.toml` (`verify_jwt = false` לכולן — האימות בפנים).
- הוספת אלעד ל-`app_admins`: יוצרים לו משתמש Auth (או שהוא נוצר לבד בכניסה הראשונה), ומכניסים ידנית
  שורה ל-`app_admins` (`insert into public.app_admins (user_id) values ('<uuid>')`) — אין דרך אחרת:
  אף אחד לא יכול להזמין את האדמין הראשון, כי `admin_create_invite` דורשת להיות אדמין כבר.
- **מחיקה וניקוי קבצים (שלב 2ב):**
  - `supabase secrets set CRON_SECRET=<מחרוזת אקראית ארוכה>` — הסוד ש-`storage-cleanup` דורש. בלי סוד הפונקציה כבויה.
  - `SB_PUBLISHABLE_KEY` **לא נדרש בפועל**: Supabase מזרים `SUPABASE_ANON_KEY` לכל Edge Function
    כברירת מחדל, וזה מספיק כדי ש-`delete-image` יקרא ל-`delete_image` בזהות המשתמש עצמו.
  - תזמון: אין תפריט "Integrations → Cron" בפועל בלוח הבקרה של הפרויקט הזה. הדרך שעבדה: מפעילים את
    ההרחבות `pg_cron` ו-`pg_net` (SQL: `create extension if not exists pg_cron; create extension if not
    exists pg_net;`) ואז `select cron.schedule('storage-cleanup-15min', '*/15 * * * *', $$select
    net.http_post(url := '<project-url>/functions/v1/storage-cleanup', headers :=
    jsonb_build_object('Content-Type','application/json','x-cron-secret','<CRON_SECRET>'), body :=
    '{}'::jsonb)$$)`. ה-secret נכתב ישירות בתוך משימת ה-cron במסד (נגיש רק לבעל הפרויקט, כמו כל
    השאר שם) — לא ל-Vault, זה מיותר כאן. `select * from cron.job_run_details order by runid desc` בודק ריצות.
  - אחרי הפריסה: למחוק תמונה אחת לבדיקה ולוודא ב-Storage שהקובץ נעלם, ושבמסך האדמין "ממתינים לניקוי" חוזר ל-0.
- Storage: המיגרציה `0007` יוצרת לבד את ה-bucket `images` (פרטי, 5MB, WebP/JPEG) ואת ההרשאות עליו.
  אחרי ההרצה לבדוק בלוח הבקרה: Storage → `images` → **Public: כבוי**. אין צורך ליצור אותו ידנית.

## 3. אחר כך (שלבים מאוחרים — לא עכשיו)
- `ANTHROPIC_API_KEY` — מפתח **חדש ונפרד** עם תקרת הוצאה בקונסולה של Anthropic (שלב 3).
- `HF_API_KEY_ID` / `HF_API_KEY_SECRET` — Higgsfield, **רק בשלב 8 ובאישור אלעד**. עד אז `HIGGSFIELD_MODE=off`.
- `PEXELS_API_KEY` — אופציונלי.
כל המפתחות האלה נכנסים רק ל-Supabase secrets (`supabase secrets set ...`), אף פעם לא לדפדפן או לגיט.

## איפוס אימות דו-שלבי לאדמין שאיבד טלפון
לוח הבקרה של Supabase → Authentication → Users → המשתמש → Factors → מחיקה. בכניסה הבאה מגדירים מחדש.
