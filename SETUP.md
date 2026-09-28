# SETUP — הקמה (מה אלעד עושה, ומתי)

עד שלב הפריסה אין צורך בכלום: הכול נבנה ונבדק מקומית (PGlite, תלויות מדומות).
כשמגיעים לפריסה, Claude יכין לכל צעד הוראה מדויקת עם קופסה להעתקה. זו רק רשימת המשימות.

## 1. GitHub (פעם אחת)
- ריפו **ציבורי** חדש בשם `art-inspiration` בחשבון `elad-vibes` (GitHub Pages חינמי רק לריפו ציבורי;
  בריפו אין נתונים ואין מפתחות — AGENTS.md).
- Settings → Pages → Source: **GitHub Actions**.
- Settings → Variables (לא Secrets): `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` — ערכים ציבוריים.

## 2. Supabase — פרויקט חדש ונפרד (פעם אחת)
- פרויקט חדש (אזור קרוב לישראל, למשל Frankfurt). **לא** הפרויקט של "הכסף של הבית".
  בתוכנית החינמית אפשר 2 פרויקטים פעילים — לבדוק שיש מקום.
- Auth: הרשמה כבויה · קוד במייל (OTP) · TOTP מופעל · SMS כבוי · SMTP (אפשר אותו חשבון Brevo).
- מילוי `.env.local` לפי `.env.example` (מקומי בלבד, לא בצ'אט).
- הרצת המיגרציות (`supabase/migrations/0001–0008`), פריסת שלוש הפונקציות (`invite-signin`, `delete-image`,
  `storage-cleanup`), והוספת החשבון של אלעד ל-`app_admins`.
- **מחיקה וניקוי קבצים (שלב 2ב):**
  - `supabase secrets set CRON_SECRET=<מחרוזת אקראית ארוכה>` — הסוד ש-`storage-cleanup` דורש. בלי סוד הפונקציה כבויה.
  - אם ב-Edge אין `SUPABASE_ANON_KEY`: `supabase secrets set SB_PUBLISHABLE_KEY=<המפתח הציבורי>` (הוא ציבורי; משמש רק כדי
    ש-`delete-image` יקרא ל-`delete_image` בזהות המשתמש עצמו).
  - תזמון: Integrations → Cron → משימה כל ~15 דקות שקוראת ל-`POST https://<project>.supabase.co/functions/v1/storage-cleanup`
    עם הכותרת `x-cron-secret: <אותו סוד>`. בלי התזמון, ניסיון חוזר לקובץ שהמחיקה שלו נכשלה קורה רק אחרי המחיקה הבאה.
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
