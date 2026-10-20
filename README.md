# EduTech Solutions 07 — Registration website

Registration site for **الملتقى الوطني السابع — EduTech Solutions 07**
(31 October 2026, Algiers · organised by Robot Éducatif Algérie).

- Live site: https://edutech07-inscription.vercel.app
- Admin dashboard: https://edutech07-inscription.vercel.app/admin

## What's in this repo

```
index.html          Public registration page (Arabic, RTL, light/dark)
admin/index.html    Admin dashboard (login, registrations, payments, check-in, deleted list)
assets/             Images used by the site and by the confirmation e-mails
vercel.json         Vercel settings: clean URLs + security headers
backend/Code.gs     Google Apps Script backend (stores data in Google Sheets, sends e-mails)
tools/admin-hash.js Makes the admin password hash for backend/Code.gs
```

There is no build step and no framework: the site is plain HTML, CSS and JavaScript.

## How it works

1. A visitor picks an offer (Standard, VIP or Group of 3) and fills in the form on `index.html`.
2. The page sends the data to the Apps Script backend, which saves a row in the Google Sheet
   (tab `Registrations`) and e-mails a 6-digit code to the first member.
3. The visitor enters the code. The registration becomes **verified** and the badges are
   generated in the browser and e-mailed.
4. «لديكم بطاقة مسبقًا؟» lets someone who already registered get their badges again,
   after a one-time code sent to their e-mail.
5. Admins sign in at `/admin` to see registrations, mark payments and check-ins,
   cancel or restore registrations, and see group members together.

## Setup

### 1. Backend (Google Apps Script)

1. Create a Google Sheet. Copy its ID from the URL (`/spreadsheets/d/<ID>/edit`).
2. Open **Extensions → Apps Script** and paste `backend/Code.gs`.
3. In the config block at the top of the file, fill in:
   - `SHEET_ID`: the sheet ID from step 1.
   - `ADMIN_SALT` and `ADMIN_HASH`: run `node tools/admin-hash.js "<a long random password>"`
     and paste the two lines it prints.
   - Check `SITE_URL`, `PRICES`, `DISCOUNT` and `EARLY_DEADLINE`.
4. **Deploy → New deployment → Web app**, with *Execute as: Me* and *Who has access: Anyone*.
   Copy the Web app URL (`https://script.google.com/macros/s/…/exec`).
5. After later code changes, go to **Deploy → Manage deployments → ✏️ → New version → Deploy**.
   This keeps the same URL.

The real sheet ID and admin hash are **not** in this repo. They live only in the deployed
Apps Script project.

### 2. Frontend (Vercel)

1. Put the Web app URL in `API_URL` in both `index.html` and `admin/index.html`.
2. Import this repo in Vercel with **Framework preset: Other**, no build command and output
   directory `.` (the repo root).
3. Every push to `main` deploys automatically. `.vercelignore` keeps `backend/`, `tools/` and this
   README off the public site.

## Notes

- The admin page needs the username in `ADMIN_USER` (in `Code.gs`) and the password you hashed.
- E-mails are sent from the Google account that owns the Apps Script (daily Gmail quota applies;
  `MAIL_RESERVE` stops new registrations just before the limit).
- Prices are checked again on the server, so the amount can't be changed from the browser.
- Rows with status `test` stay in the sheet but are left out of every count.
