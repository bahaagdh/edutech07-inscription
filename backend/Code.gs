/**
 * EduTech Solutions 07 — registration backend (Google Apps Script)
 * ----------------------------------------------------------------
 * Public actions (registration page)
 *   register      : stores the registration in the Google Sheet and e-mails a 6-digit code to member 1.
 *   resend        : e-mails a new code (throttled).
 *   verify        : checks the code (limited attempts); on success marks the row "verified".
 *   badges        : e-mails the generated badges (PNG only, size-checked, once per registration).
 *   lookup_start  : "لديكم بطاقة مسبقًا؟" — e-mails a one-time code to a confirmed address.
 *   lookup_verify : returns the registration only when that code is correct.
 * Admin actions (/admin page)
 *   admin_login, admin_list, admin_update, admin_checkin, admin_logout — password checked against a salted hash,
 *   short-lived session token, lock-out after repeated failures.
 *
 * Setup: Deploy → Manage deployments → Web app → Execute as "Me", Who has access "Anyone".
 * E-mails are sent from the Google account that owns this script.
 */
const SHEET_ID     = 'PUT_YOUR_GOOGLE_SHEET_ID_HERE';   // the ID in the sheet's URL: /spreadsheets/d/<ID>/edit
const SHEET_NAME   = 'Registrations';
const FROM_NAME    = 'EduTech Solutions 07';
const CODE_TTL_MIN = 30;
const MAX_BADGES_PER_EMAIL = 1;   // one confirmed registration per e-mail: a second attempt is refused
const PRICES        = { STANDARD:5900, VIP:9900, GROUPE:24900 };   // the site's prices — recomputed here so nobody can send a wrong amount
const MEMBERS       = { STANDARD:1, VIP:1, GROUPE:3 };
const DISCOUNT      = 0.20;
const EARLY_DEADLINE = new Date('2026-10-21T23:00:00Z');            // 22 Oct 2026 00:00 Algiers: the 20% early-bird ends
const SITE_URL     = 'https://edutech07-inscription.vercel.app';
const SITE_HOST    = SITE_URL.replace(/^https?:\/\//, '');
const LOGO_URL     = SITE_URL + '/assets/email-logo.png';
const ORG_LOGO_URL = SITE_URL + '/assets/email-org.png';

// ---- admin access (only the salted hash of the password is stored here) ----
const ADMIN_USER = 'edutech07-admin';
const ADMIN_SALT = 'PUT_ADMIN_SALT_HERE';   // generate with: node tools/admin-hash.js "<your password>"
const ADMIN_HASH = 'PUT_ADMIN_HASH_HERE';
const MAIL_RESERVE = 10;                     // new registrations stop before the daily e-mail quota is fully used
const ADMIN_SESSION_SEC = 6 * 3600;          // a login lasts 6 hours
const ADMIN_MAX_FAILS = 30;                  // per 15-minute window (the password is long and random; this only stops floods)

// ---- extra sheet columns used by the admin page (after the 25 original ones) ----
const COL = { status:3, otp:23, otpExp:24, verifiedAt:25, paid:26, paidAt:27, checkin:28, checkinAt:29, note:30 };
const HEADERS = ['code','createdAt','status','offer','price','discount','total','earlyBird','institution','wilaya',
                 'm1_firstname','m1_lastname','m1_email','m1_phone',
                 'm2_firstname','m2_lastname','m2_email','m2_phone',
                 'm3_firstname','m3_lastname','m3_email','m3_phone',
                 'otp','otpExpires','verifiedAt','paid','paidAt','checkin','checkinAt','note'];
const STATUSES = ['pending','verified','badges sent','cancelled','test'];   // 'test' = kept in the sheet but left out of every count
const CONFIRMED = { 'verified':1, 'badges sent':1 };

/** Opening the API address in a browser (GET) just answers that the service is up. */
function doGet() { return out({ ok:true, service:'EduTech 07 registrations' }); }

function doPost(e) {
  let body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { return out({ ok:false, error:'bad json' }); }
  if (!body || typeof body !== 'object') return out({ ok:false, error:'bad json' });
  try {
    switch (body.action) {
      case 'register':      return out(register(body));
      case 'resend':        return out(resend(body.code));
      case 'verify':        return out(verify(body.code, body.otp));
      case 'lookup':        return out({ ok:false, error:'not found' });     // old page: retrieval now needs an e-mailed code
      case 'lookup_start':  return out(lookupStart(body.email));
      case 'lookup_verify': return out(lookupVerify(body.email, body.otp));
      case 'admin_login':   return out(adminLogin(body.user, body.pass));
      case 'admin_list':    return out(adminList(body.token));
      case 'admin_update':  return out(adminUpdate(body.token, body.code, body.patch));
      case 'admin_checkin': return out(adminCheckin(body.token, body.qr, body.code, body.member));
      case 'admin_logout':  return out(adminLogout(body.token));
      default:              return out({ ok:false, error:'unknown action' });
    }
  } catch (err) {
    console.error(err && err.stack || err);
    return out({ ok:false, error:'server' });                          // no internal details to the outside
  }
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------------------------------------------------------------- helpers */
function cache() { return CacheService.getScriptCache(); }
/** Fixed time windows: the counter for a window starts at 0 when the window starts and simply
 *  expires afterwards — new traffic can never keep an old counter alive. */
function rlKey(key, sec) { return 'rl:' + key + ':' + Math.floor(Date.now() / (sec * 1000)); }
/** Counts an event under `key`; true once it happened more than `max` times in the current `sec`-second window. */
function tooMany(key, max, sec) {
  const c = cache(), k = rlKey(key, sec), n = Number(c.get(k) || 0) + 1;
  c.put(k, String(n), Math.min(21600, sec + 60));
  return n > max;
}
function count(key, sec) { return Number(cache().get(rlKey(key, sec)) || 0); }
function clearCount(key, sec) { cache().remove(rlKey(key, sec)); }

function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try { return fn(); } finally { lock.releaseLock(); }
}

const EMAIL_RE = /^[A-Za-z0-9_][A-Za-z0-9._%+\-]{0,63}@[A-Za-z0-9](?:[A-Za-z0-9\-]{0,62}\.)+[A-Za-z]{2,24}$/;
const CODE_RE  = /^ET07-[A-Z0-9]{4,12}$/;
const PHONE_RE = /^0[5-7]\d{8}$/;
function latinDigits(s) {
  return String(s == null ? '' : s).replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x660)).replace(/[\u06F0-\u06F9]/g, d => String(d.charCodeAt(0) - 0x6F0));
}
function normEmail(e) { return String(e == null ? '' : e).trim().toLowerCase(); }
function cleanText(s, max) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
/** Text that goes into a sheet cell: never let it start like a formula (=, +, -, @). */
function cell(s, max) {
  const t = cleanText(s, max || 200);
  return /^[=+\-@]/.test(t) ? "'" + t : t;
}
function uncell(v) { const s = String(v == null ? '' : v); return s.charAt(0) === "'" ? s.slice(1) : s; }
function newOtp() {
  const b = Utilities.getUuid().replace(/-/g, '');
  return String(100000 + (parseInt(b.slice(0, 8), 16) % 900000));
}
function sha256hex(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(b => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join('');
}
function sameText(a, b) {
  a = String(a); b = String(b);
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}
function mailLeft() { try { return MailApp.getRemainingDailyQuota(); } catch (e) { return -1; } }

function sheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
  } else if (sh.getLastColumn() < HEADERS.length) {
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);       // adds the admin columns once
  }
  return sh;
}
function allRows(sh, width) {
  const n = sh.getLastRow() - 1;
  return n > 0 ? sh.getRange(2, 1, n, width || HEADERS.length).getValues() : [];
}

/** Returns the first e-mail that already has MAX_BADGES_PER_EMAIL confirmed registrations, or ''. */
function limitHit(sh, emails, skipRow) {
  const want = emails.map(normEmail).filter(Boolean);
  if (!want.length) return '';
  const counts = {};
  allRows(sh, 22).forEach((v, i) => {
    if (i + 2 === skipRow || !CONFIRMED[String(v[2])]) return;
    const seen = {};
    [v[12], v[16], v[20]].forEach(e => { e = normEmail(e); if (e && !seen[e]) { seen[e] = 1; counts[e] = (counts[e] || 0) + 1; } });
  });
  for (const e of want) if ((counts[e] || 0) >= MAX_BADGES_PER_EMAIL) return e;
  return '';
}

function recFromRow(v) {
  const label = String(v[3] || 'STANDARD'), key = label.toLowerCase() === 'vip' ? 'vip' : (label.toLowerCase() === 'groupe' ? 'groupe' : 'standard');
  const members = [];
  for (let i = 0; i < 3; i++) { const em = v[12 + i*4]; if (em) members.push({ fn: uncell(v[10 + i*4]), ln: uncell(v[11 + i*4]), em: String(em), ph: String(v[13 + i*4] || '').replace(/^'/, '') }); }
  const created = v[1] instanceof Date ? v[1].toISOString() : String(v[1] || '');
  return { code: String(v[0]), createdAt: created, offer: key, offerLabel: label, price: Number(v[4]) || 0, discount: Number(v[5]) || 0, total: Number(v[6]) || 0,
           earlyBird: v[7] === 'yes', inst: uncell(v[8]), wilaya: uncell(v[9]), members: members };
}

function findRow(sh, code) {
  if (!CODE_RE.test(String(code || ''))) return 0;
  const n = sh.getLastRow() - 1;
  if (n < 1) return 0;
  const codes = sh.getRange(2, 1, n, 1).getValues();
  for (let i = 0; i < codes.length; i++) if (String(codes[i][0]) === String(code)) return i + 2;
  return 0;
}

/** Turns a sheet row into the object the e-mail templates use. */
function rowInfo(v) {
  const members = [];
  for (let i = 0; i < 3; i++) {
    const em = v[12 + i*4];
    if (em) members.push({ fn: uncell(v[10 + i*4]), ln: uncell(v[11 + i*4]), em: String(em) });
  }
  return { code: String(v[0]), offer: String(v[3]), price: Number(v[4]) || 0, discount: Number(v[5]) || 0,
           total: Number(v[6]) || 0, earlyBird: v[7] === 'yes', inst: uncell(v[8]), wilaya: uncell(v[9]), members: members };
}

/* ---------------------------------------------------------------- public actions */
function register(rec) {
  if (!rec || !CODE_RE.test(String(rec.code || '')) || !Array.isArray(rec.members)) return { ok:false, error:'missing fields' };
  const label = String(rec.offerLabel || rec.offer || '').toUpperCase();
  if (!PRICES[label]) return { ok:false, error:'missing fields' };
  const need = MEMBERS[label];
  if (rec.members.length !== need) return { ok:false, error:'missing fields' };
  const inst = cleanText(rec.inst, 150), wilaya = cleanText(rec.wilaya, 60);
  if (!inst || !wilaya) return { ok:false, error:'missing fields' };
  const members = [];
  for (const m of rec.members) {
    const fn = cleanText(m && m.fn, 60), ln = cleanText(m && m.ln, 60), em = normEmail(m && m.em), ph = latinDigits(m && m.ph).replace(/[\s.-]+/g, '');
    if (!fn || !ln || !EMAIL_RE.test(em) || em.length > 120 || !PHONE_RE.test(ph)) return { ok:false, error:'missing fields' };
    members.push({ fn: fn, ln: ln, em: em, ph: ph });
  }
  if (tooMany('reg:' + members[0].em, 12, 3600) || tooMany('reg:all', 30, 600)) return { ok:false, error:'busy' };
  const left = mailLeft();
  if (left !== -1 && left <= MAIL_RESERVE) return { ok:false, error:'quota' };   // keep some e-mails for resends / badge retrieval

  const otp = newOtp();
  const res = withLock(() => {
    const sh = sheet();
    const existing = findRow(sh, rec.code);
    if (existing) {
      // the browser may resend after a lost reply: if it is the same pending registration, it already worked
      const v = sh.getRange(existing, 1, 1, 25).getValues()[0];
      if (String(v[2]) === 'pending' && normEmail(v[12]) === members[0].em) return { ok:true, again:true, v: v };
      return { ok:false, error:'duplicate code' };
    }
    const hit = limitHit(sh, members.map(m => m.em));
    if (hit) return { ok:false, error:'limit', email: hit, max: MAX_BADGES_PER_EMAIL };
    // prices are decided here, from the server clock — not from what the browser sent
    const price = PRICES[label], early = Date.now() < EARLY_DEADLINE.getTime();
    const discount = early ? Math.round(price * DISCOUNT) : 0, total = price - discount;
    const m = i => members[i] || {};
    const row = [String(rec.code), new Date().toISOString(), 'pending', label, price, discount, total, early ? 'yes' : 'no',
                 cell(inst, 150), cell(wilaya, 60)];
    for (let i = 0; i < 3; i++) row.push(cell(m(i).fn || '', 60), cell(m(i).ln || '', 60), m(i).em || '', m(i).ph ? "'" + m(i).ph : '');
    row.push(otp, new Date(Date.now() + CODE_TTL_MIN*60000).toISOString(), '', '', '', '', '', '');
    sh.appendRow(row);
    return { ok:true, info: rowInfo(row) };
  });
  if (!res.ok) return res;
  if (res.again) {
    // same registration sent again: only e-mail the code if the first e-mail never went out
    if (!cache().get('sent:' + rec.code) && res.v[22]) sendCodeOnce(rec.code, rowInfo(res.v), String(res.v[22]));
    return { ok:true };
  }
  sendCodeOnce(rec.code, res.info, otp);
  return { ok:true };
}
/** Marks the code as sent before sending (a repeat arriving meanwhile will not send a second e-mail);
 *  if sending fails the mark is removed so the next attempt sends it. */
function sendCodeOnce(code, info, otp) {
  cache().put('sent:' + code, '1', 21600);
  try { sendCode(info, otp); } catch (e) { cache().remove('sent:' + code); throw e; }
}

function resend(code) {
  if (!CODE_RE.test(String(code || ''))) return { ok:false, error:'not found' };
  if (tooMany('resend1:' + code, 1, 40) || tooMany('resend:' + code, 5, 3600)) return { ok:false, error:'busy' };
  if (mailLeft() === 0) return { ok:false, error:'quota' };
  const sh = sheet(), row = findRow(sh, code);
  if (!row) return { ok:false, error:'not found' };
  const v = sh.getRange(row, 1, 1, 25).getValues()[0];
  if (String(v[2]) !== 'pending') return { ok:false, error:'not found' };
  const otp = newOtp();
  sh.getRange(row, COL.otp, 1, 2).setValues([[otp, new Date(Date.now() + CODE_TTL_MIN*60000).toISOString()]]);
  clearCount('vfail:' + code, 3600);
  sendCode(rowInfo(v), otp);
  return { ok:true };
}

function verify(code, otp) {
  if (!CODE_RE.test(String(code || '')) || !/^\d{6}$/.test(String(otp || ''))) return { ok:false, error:'wrong code' };
  if (count('vfail:' + code, 3600) >= 8) return { ok:false, error:'too many' };
  return withLock(() => {
    const sh = sheet(), row = findRow(sh, code);
    if (!row) return { ok:false, error:'not found' };
    const r = sh.getRange(row, 1, 1, 25).getValues()[0];
    if (CONFIRMED[String(r[2])]) {
      // already confirmed: the same correct code within 30 minutes returns the badge again (reply lost on the way)
      const recent = r[24] && (Date.now() - new Date(r[24]).getTime()) < 30 * 60000;
      if (recent && r[22] && sameText(String(r[22]), String(otp))) return { ok:true, rec: recFromRow(r) };
      return { ok:false, error:'wrong code' };
    }
    if (String(r[2]) !== 'pending') return { ok:false, error:'wrong code' };   // cancelled / test
    if (!sameText(String(r[22]), String(otp))) { tooMany('vfail:' + code, 8, 3600); return { ok:false, error:'wrong code' }; }
    if (new Date(r[23]) < new Date()) return { ok:false, error:'expired' };
    const hit = limitHit(sh, [r[12], r[16], r[20]], row);
    if (hit) return { ok:false, error:'limit', email: hit, max: MAX_BADGES_PER_EMAIL };
    sh.getRange(row, COL.status).setValue('verified');
    sh.getRange(row, COL.verifiedAt).setValue(new Date().toISOString());
    return { ok:true, rec: recFromRow(sh.getRange(row, 1, 1, 25).getValues()[0]) };
  });
}

/** Checks a base64 image: right magic bytes and size. Returns the bytes or null. */
function imageBytes(b64, kind, maxBytes) {
  if (typeof b64 !== 'string' || b64.length > maxBytes * 1.4) return null;
  let bytes;
  try { bytes = Utilities.base64Decode(b64); } catch (e) { return null; }
  if (!bytes || bytes.length < 8 || bytes.length > maxBytes) return null;
  const u = i => (bytes[i] + 256) % 256;
  if (kind === 'png' && !(u(0) === 0x89 && u(1) === 0x50 && u(2) === 0x4E && u(3) === 0x47)) return null;
  if (kind === 'jpg' && !(u(0) === 0xFF && u(1) === 0xD8 && u(2) === 0xFF)) return null;
  return bytes;
}

function sendBadges(code, files, previews) {
  if (!CODE_RE.test(String(code || ''))) return { ok:false, error:'not found' };
  if (!Array.isArray(files) || !files.length || files.length > 3) return { ok:false, error:'no files' };
  if (previews != null && (!Array.isArray(previews) || previews.length > 3)) return { ok:false, error:'no files' };
  const sh = sheet(), row = findRow(sh, code);
  if (!row) return { ok:false, error:'not found' };
  const info = rowInfo(sh.getRange(row, 1, 1, 25).getValues()[0]);
  if (files.length > info.members.length) return { ok:false, error:'no files' };
  const blobs = [];
  for (let i = 0; i < files.length; i++) {
    const b = imageBytes(files[i] && files[i].data, 'png', 4 * 1024 * 1024);
    if (!b) return { ok:false, error:'bad file' };
    blobs.push(Utilities.newBlob(b, 'image/png', 'badge-' + info.code + '-' + (i+1) + '.png'));
  }
  const pv = [];
  for (let i = 0; i < (previews || []).length; i++) {
    const b = imageBytes(previews[i], 'jpg', 800 * 1024);
    if (!b) return { ok:false, error:'bad file' };
    pv.push(Utilities.newBlob(b, 'image/jpeg', 'preview-' + (i+1) + '.jpg'));
  }
  if (mailLeft() !== -1 && mailLeft() < info.members.length) return { ok:false, error:'quota' };
  // only once per registration: switch the status first, under the lock
  const claimed = withLock(() => {
    if (sh.getRange(row, COL.status).getValue() !== 'verified') return false;
    sh.getRange(row, COL.status).setValue('badges sent');
    return true;
  });
  if (!claimed) return { ok:false, error:'not verified' };
  const subject = 'بطاقة المشاركة — الملتقى الوطني السابع | EduTech Solutions 07';
  const send = (to, idxs) => {
    const inline = {}; idxs.forEach(i => { if (pv[i]) inline['badge' + i] = pv[i]; });
    MailApp.sendEmail({
      to: to.em, name: FROM_NAME, subject: subject,
      htmlBody: badgesEmailHtml(info, to, idxs, pv.length > 0),
      body: 'تم تأكيد تسجيلكم في الملتقى الوطني السابع. بطاقة المشاركة مرفقة بهذه الرسالة. رقم التسجيل: ' + info.code,
      attachments: idxs.map(i => blobs[i]).filter(Boolean),
      inlineImages: inline
    });
  };
  try {
    // member 1 (the one who confirmed) gets every badge; other members get their own badge
    send(info.members[0], blobs.map((_, i) => i));
    for (let i = 1; i < info.members.length && i < blobs.length; i++) send(info.members[i], [i]);
  } catch (e) {
    sh.getRange(row, COL.status).setValue('verified');                        // let the page try again
    throw e;
  }
  return { ok:true, sent: info.members.length };
}

/** Step 1 of "لديكم بطاقة مسبقًا؟": if this address has a confirmed registration, e-mail it a one-time code.
 *  The answer is the same whether or not the address is registered (nobody can probe who registered). */
function lookupStart(email) {
  const em = normEmail(email);
  if (!EMAIL_RE.test(em)) return { ok:false, error:'missing' };
  if (tooMany('lk1:' + em, 1, 45) || tooMany('lk:' + em, 6, 86400) || tooMany('lk:all', 120, 600)) return { ok:false, error:'busy' };
  const sh = sheet(), rows = allRows(sh, 25);
  for (let i = 0; i < rows.length; i++) {                 // first confirmed registration = the offer originally applied for
    const v = rows[i];
    if (!CONFIRMED[String(v[2])]) continue;
    const idx = [v[12], v[16], v[20]].map(normEmail).indexOf(em);
    if (idx < 0) continue;
    if (mailLeft() === 0) return { ok:false, error:'quota' };
    const otp = newOtp();
    cache().put('lkc:' + em, JSON.stringify({ otp: otp, code: String(v[0]), idx: idx }), 15 * 60);
    clearCount('lkfail:' + em, 900);
    sendLookupCode(rowInfo(v), idx, otp);
    break;
  }
  return { ok:true };
}

/** Step 2: the code from that e-mail unlocks the badge data. */
function lookupVerify(email, otp) {
  const em = normEmail(email);
  if (!EMAIL_RE.test(em) || !/^\d{6}$/.test(String(otp || ''))) return { ok:false, error:'wrong code' };
  if (count('lkfail:' + em, 900) >= 6) return { ok:false, error:'too many' };
  const raw = cache().get('lkc:' + em);
  if (!raw) return { ok:false, error:'expired' };
  const st = JSON.parse(raw);
  if (!sameText(st.otp, String(otp))) { tooMany('lkfail:' + em, 6, 900); return { ok:false, error:'wrong code' }; }
  cache().remove('lkc:' + em);
  const sh = sheet(), row = findRow(sh, st.code);
  if (!row) return { ok:false, error:'not found' };
  const v = sh.getRange(row, 1, 1, 25).getValues()[0];
  if (!CONFIRMED[String(v[2])]) return { ok:false, error:'not found' };
  return { ok:true, idx: st.idx, rec: recFromRow(v) };
}

/** Badge QR payload is a vCard whose UID/NOTE contain ET07-XXXX-N (N = member 1–3). */
function parseBadgeId(raw, code, member) {
  const text = String(raw == null ? '' : raw).toUpperCase();
  const m = text.match(/ET07-[A-Z0-9]{4,12}(?:-[1-3])?/);
  if (m) {
    const parts = m[0].split('-');
    const id = parts[0] + '-' + parts[1];
    const idx = parts[2] ? Number(parts[2]) : 1;
    if (CODE_RE.test(id)) return { code: id, member: idx };
  }
  const c = String(code || '').toUpperCase().trim();
  if (CODE_RE.test(c)) {
    const idx = Number(member);
    return { code: c, member: idx >= 1 && idx <= 3 ? idx : 1 };
  }
  return null;
}
/** Stored as '' (none), 'yes' (everyone — old rows), or '1,3' (those members). */
function checkinList(raw, n) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return [];
  n = Math.max(1, Number(n) || 1);
  const low = s.toLowerCase();
  if (low === 'yes' || low === 'true') {
    const all = [];
    for (let i = 1; i <= n; i++) all.push(i);
    return all;
  }
  const ids = [];
  s.split(/[,\s]+/).forEach(function (p) {
    const k = Number(p);
    if (k >= 1 && k <= 3 && ids.indexOf(k) < 0) ids.push(k);
  });
  ids.sort(function (a, b) { return a - b; });
  return ids;
}
function checkinCell(ids, n) {
  n = Math.max(1, Number(n) || 1);
  const uniq = [];
  (ids || []).forEach(function (k) {
    k = Number(k);
    if (k >= 1 && k <= n && uniq.indexOf(k) < 0) uniq.push(k);
  });
  uniq.sort(function (a, b) { return a - b; });
  if (!uniq.length) return '';
  if (uniq.length === n) return 'yes';
  return uniq.join(',');
}

/* ---------------------------------------------------------------- admin */
function pwHash(pass) {
  let h = ADMIN_SALT + String(pass);
  for (let i = 0; i < 200; i++) h = sha256hex(h + ADMIN_SALT);   // the password is long and random: 200 rounds is plenty and keeps login fast
  return h;
}
function adminLogin(user, pass) {
  if (count('admfail', 900) >= ADMIN_MAX_FAILS) return { ok:false, error:'locked' };
  const okUser = sameText(String(user || '').trim(), ADMIN_USER);
  const okPass = typeof pass === 'string' && pass.length <= 200 && sameText(pwHash(pass), ADMIN_HASH);
  if (!okUser || !okPass) {
    tooMany('admfail', ADMIN_MAX_FAILS, 900);
    Utilities.sleep(1200);
    return { ok:false, error:'bad login' };
  }
  clearCount('admfail', 900);
  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  cache().put('adm:' + token, '1', ADMIN_SESSION_SEC);
  return Object.assign({ ok:true, token: token, ttl: ADMIN_SESSION_SEC }, adminData());   // data comes with the login: one round trip
}
function isAdmin(token) {
  return typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) && cache().get('adm:' + token) === '1';
}
function adminLogout(token) {
  if (isAdmin(token)) cache().remove('adm:' + token);
  return { ok:true };
}
function adminRow(v, rowNum) {
  const members = [];
  for (let i = 0; i < 3; i++) {
    const em = v[12 + i*4];
    if (em) members.push({ fn: uncell(v[10 + i*4]), ln: uncell(v[11 + i*4]), em: String(em), ph: String(v[13 + i*4] || '').replace(/^'/, '') });
  }
  const iso = x => x instanceof Date ? x.toISOString() : String(x || '');
  const present = checkinList(v[27], members.length);
  return { row: rowNum, code: String(v[0]), createdAt: iso(v[1]), status: String(v[2] || ''), offer: String(v[3] || ''),
           price: Number(v[4]) || 0, discount: Number(v[5]) || 0, total: Number(v[6]) || 0, earlyBird: v[7] === 'yes',
           inst: uncell(v[8]), wilaya: uncell(v[9]), members: members, verifiedAt: iso(v[24]),
           paid: v[25] === 'yes', paidAt: iso(v[26]),
           checkin: present.length === members.length && members.length > 0,
           present: present, checkinAt: iso(v[28]), note: uncell(v[29]) };
}
function adminData() {
  const sh = sheet();
  const rows = allRows(sh, HEADERS.length).map((v, i) => v[0] ? adminRow(v, i + 2) : null).filter(Boolean);
  return { rows: rows, mailLeft: mailLeft(), earlyDeadline: EARLY_DEADLINE.toISOString(), now: new Date().toISOString() };
}
function adminList(token) {
  if (!isAdmin(token)) return { ok:false, error:'auth' };
  return Object.assign({ ok:true }, adminData());
}
function adminUpdate(token, code, patch) {
  if (!isAdmin(token)) return { ok:false, error:'auth' };
  if (!patch || typeof patch !== 'object') return { ok:false, error:'bad patch' };
  return withLock(() => {
    const sh = sheet(), row = findRow(sh, code);
    if (!row) return { ok:false, error:'not found' };
    if ('status' in patch && STATUSES.indexOf(String(patch.status)) < 0) return { ok:false, error:'bad status' };
    const now = new Date().toISOString();
    if ('paid' in patch)    sh.getRange(row, COL.paid, 1, 2).setValues([patch.paid ? ['yes', now] : ['', '']]);
    if ('checkinMember' in patch) {
      const rec0 = adminRow(sh.getRange(row, 1, 1, HEADERS.length).getValues()[0], row);
      const n = rec0.members.length, idx = Number(patch.checkinMember);
      if (idx < 1 || idx > n) return { ok:false, error:'bad member' };
      let ids = rec0.present.slice();
      const on = patch.checkin !== false;
      if (on && ids.indexOf(idx) < 0) ids.push(idx);
      if (!on) ids = ids.filter(k => k !== idx);
      sh.getRange(row, COL.checkin, 1, 2).setValues([[checkinCell(ids, n), ids.length ? now : '']]);
    } else if ('checkin' in patch) {
      const rec0 = adminRow(sh.getRange(row, 1, 1, HEADERS.length).getValues()[0], row);
      const n = rec0.members.length;
      const ids = patch.checkin ? rec0.members.map((_, i) => i + 1) : [];
      sh.getRange(row, COL.checkin, 1, 2).setValues([[checkinCell(ids, n), ids.length ? now : '']]);
    }
    if ('note' in patch)    sh.getRange(row, COL.note).setValue(cell(patch.note, 500));
    if ('status' in patch) {
      const s = String(patch.status);
      if (STATUSES.indexOf(s) < 0) return { ok:false, error:'bad status' };
      sh.getRange(row, COL.status).setValue(s);
    }
    return { ok:true, rec: adminRow(sh.getRange(row, 1, 1, HEADERS.length).getValues()[0], row) };
  });
}
function adminCheckin(token, qr, code, member) {
  if (!isAdmin(token)) return { ok:false, error:'auth' };
  const parsed = parseBadgeId(qr, code, member);
  if (!parsed) return { ok:false, error:'bad qr' };
  return withLock(() => {
    const sh = sheet(), row = findRow(sh, parsed.code);
    if (!row) return { ok:false, error:'not found' };
    const rec = adminRow(sh.getRange(row, 1, 1, HEADERS.length).getValues()[0], row);
    if (!CONFIRMED[rec.status]) return { ok:false, error:'not confirmed', rec: rec, member: parsed.member };
    const n = rec.members.length;
    let idx = parsed.member;
    if (idx < 1 || idx > n) idx = 1;
    const had = rec.present.indexOf(idx) >= 0;
    if (!had) {
      const now = new Date().toISOString();
      sh.getRange(row, COL.checkin, 1, 2).setValues([[checkinCell(rec.present.concat([idx]), n), now]]);
    }
    const rec2 = adminRow(sh.getRange(row, 1, 1, HEADERS.length).getValues()[0], row);
    return { ok:true, already: had, member: idx, rec: rec2 };
  });
}

/* ---------------------------------------------------------------- e-mails */
/** Images are embedded in the e-mail (cid:) so they show in Gmail/Outlook without the "display images" prompt.
 *  The image bytes live in this script (IMG_*_B64 at the bottom), so no extra Google permission is needed. */
function inlineImages() {
  try {
    return { hero: Utilities.newBlob(Utilities.base64Decode(IMG_HERO_B64), 'image/jpeg', 'hero.jpg'),
             org:  Utilities.newBlob(Utilities.base64Decode(IMG_ORG_B64),  'image/png',  'org.png'),
             bandstd: Utilities.newBlob(Utilities.base64Decode(IMG_BAND_STD_B64), 'image/png', 'band-std.png'),
             bandvip: Utilities.newBlob(Utilities.base64Decode(IMG_BAND_VIP_B64), 'image/png', 'band-vip.png'),
             bandgrp: Utilities.newBlob(Utilities.base64Decode(IMG_BAND_GRP_B64), 'image/png', 'band-grp.png') };
  } catch (e) { return null; }   // falls back to remote images
}

function sendCode(info, otp) {
  const to = info.members[0];
  if (!to || !to.em) return;
  const imgs = inlineImages();
  const msg = {
    to: to.em, name: FROM_NAME,
    subject: 'رمز التحقق ' + otp + ' · الملتقى الوطني السابع | EduTech Solutions 07',
    htmlBody: codeEmailHtml(info, otp, !!imgs),
    body: 'رمز التحقق الخاص بكم: ' + otp + ' (صالح لمدة ' + CODE_TTL_MIN + ' دقيقة). رقم التسجيل: ' + info.code
  };
  if (imgs) msg.inlineImages = imgs;
  MailApp.sendEmail(msg);
}

function sendLookupCode(info, idx, otp) {
  const to = info.members[idx];
  if (!to || !to.em) return;
  const imgs = inlineImages();
  const msg = {
    to: to.em, name: FROM_NAME,
    subject: 'رمز استرجاع البطاقة ' + otp + ' · الملتقى الوطني السابع',
    htmlBody: lookupEmailHtml(to, otp, !!imgs),
    body: 'رمز استرجاع بطاقة المشاركة: ' + otp + ' (صالح لمدة 15 دقيقة). إن لم تطلبوه فتجاهلوا هذه الرسالة.'
  };
  if (imgs) msg.inlineImages = { hero: imgs.hero, org: imgs.org };
  MailApp.sendEmail(msg);
}

/* =====================================================================
 *  E-mail templates — table layout + inline styles (Gmail, Outlook, iOS, Android)
 *  + a <style> block for responsive tweaks and the Cairo web font (clients that allow it).
 * ===================================================================== */
const HERO_URL = SITE_URL + '/assets/email-hero.jpg';
const C = { navy:'#071f52', deep:'#0a1f4d', blue:'#06408c', sky:'#1aa7ec', lime:'#d6f41f', ink:'#0f2a5a', text:'#3d4f70', muted:'#6b7a96', line:'#e3e9f3', bg:'#edf2f9', soft:'#f5f8fd' };
const FONT = "'Cairo','Segoe UI',Tahoma,Arial,sans-serif";

function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function money(n, sign) { return '<span dir="ltr" style="unicode-bidi:isolate;white-space:nowrap">' + (sign || '') + Number(n).toLocaleString('fr-FR').replace(/[  ]/g, ' ') + ' DA</span>'; }
function ltr(s) { return '<span dir="ltr" style="unicode-bidi:isolate">' + esc(s) + '</span>'; }

function shell(preheader, inner) {
  return '<!doctype html><html lang="ar" dir="rtl" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="x-apple-disable-message-reformat"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">' +
    '<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->' +
    '<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@500;700;800;900&display=swap" rel="stylesheet">' +
    '<style>' +
      'body{margin:0!important;padding:0!important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}' +
      'table{border-collapse:collapse!important;mso-table-lspace:0;mso-table-rspace:0}img{border:0;line-height:100%;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic}' +
      'a{color:' + C.blue + '}' +
      '.btn:hover{background:#e4ff3d!important}' +
      '@media only screen and (max-width:620px){' +
        '.wrap{width:100%!important;border-radius:0!important}.px{padding-left:20px!important;padding-right:20px!important}' +
        '.h1{font-size:22px!important}.digit{font-size:26px!important;width:40px!important;height:52px!important;line-height:52px!important}' +
        '.col{display:block!important;width:100%!important;padding:6px 0!important}.hide{display:none!important}' +
      '}' +
    '</style></head>' +
    '<body style="margin:0;padding:0;background:' + C.bg + ';">' +
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;font-size:1px;line-height:1px">' + esc(preheader) + '&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="' + C.bg + '" style="background:' + C.bg + ';"><tr><td align="center" style="padding:28px 12px 36px;">' +
    '<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" border="0" dir="rtl" bgcolor="#ffffff" style="width:600px;max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 14px 40px rgba(7,31,82,.14);font-family:' + FONT + ';color:' + C.ink + ';">' +
    inner +
    '</table>' +
    '<p dir="ltr" style="margin:18px 0 0;font-family:' + FONT + ';font-size:12px;color:' + C.muted + ';">© 2026 EduTech Solutions 07 · Robot Éducatif Algérie · Alger</p>' +
    '</td></tr></table></body></html>';
}

function hero(cid) {
  return '<tr><td style="padding:0;line-height:0;" bgcolor="' + C.navy + '">' +
    '<a href="' + SITE_URL + '" style="display:block;line-height:0;"><img src="' + (cid ? 'cid:hero' : HERO_URL) + '" width="600" alt="EduTech Solutions 07 — الملتقى الوطني السابع · 31/10/2026 · الجزائر العاصمة" style="display:block;width:100%;max-width:600px;height:auto;border:0;"></a>' +
    '</td></tr>';
}

/** Tier colours — the same ones the badges use. */
function tier(offer) {
  const o = String(offer || '').toLowerCase();
  if (o === 'vip')    return { key:'vip', band:'bandvip', accent:'#e9c46a', accent2:'#f4e3a1', ink:'#b8902e', label:'VIP',      sub:'ضيف مميّز',   top:'#0a2a66', deep:'#040f2e' };
  if (o === 'groupe') return { key:'grp', band:'bandgrp', accent:'#d6f41f', accent2:'#1aa7ec', ink:'#06408c', label:'GROUPE',   sub:'عضو مجموعة', top:'#0b3f93', deep:'#071f52' };
  return                     { key:'std', band:'bandstd', accent:'#1aa7ec', accent2:'#d6f41f', ink:'#06408c', label:'STANDARD', sub:'مشارك',       top:'#0b3f93', deep:'#071f52' };
}
function confirmUrl(info, otp) { return SITE_URL + '/?c=' + encodeURIComponent(info.code) + '&k=' + encodeURIComponent(otp); }

/** The badge-shaped card: navy top with the code, diagonal band, white bottom with the participant's name. */
function ticket(info, otp, cid) {
  const t = tier(info.offer), url = confirmUrl(info, otp), m = info.members[0] || {};
  const digits = String(otp).split('').map(d =>
    '<td align="center" valign="middle" class="digit" width="54" height="68" bgcolor="#112c66" style="width:54px;height:68px;line-height:68px;background:#112c66;border:1px solid #2b4d94;border-radius:12px;font-family:\'Courier New\',Courier,monospace;font-size:34px;font-weight:700;color:' + t.accent2 + ';">' + esc(d) + '</td>' +
    '<td width="6" style="width:6px;font-size:0;line-height:0;">&nbsp;</td>').join('');
  const nameColor = t.key === 'vip' ? t.ink : C.ink;
  return '<tr><td class="px" style="padding:26px 32px 8px;" align="center">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius:22px;overflow:hidden;box-shadow:0 12px 32px rgba(7,31,82,.18);">' +
    // navy top, like the top of the badge
    '<tr><td bgcolor="' + t.deep + '" style="background:' + t.deep + ';background-image:linear-gradient(160deg,' + t.top + ' 0%,' + t.deep + ' 75%);padding:22px 18px 18px;" align="center">' +
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>' +
        '<td width="34" style="width:34px;vertical-align:middle;"><div style="height:2px;background:' + t.accent + ';font-size:0;line-height:0;">&nbsp;</div></td>' +
        '<td style="padding:0 12px;font-family:' + FONT + ';font-size:14px;font-weight:800;color:#dbe8ff;letter-spacing:.5px;white-space:nowrap;">رمز التحقق</td>' +
        '<td width="34" style="width:34px;vertical-align:middle;"><div style="height:2px;background:' + t.accent + ';font-size:0;line-height:0;">&nbsp;</div></td></tr></table>' +
      '<a href="' + url + '" style="text-decoration:none;display:block;"><table role="presentation" dir="ltr" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:16px auto 6px;"><tr>' + digits + '</tr></table></a>' +
      '<div style="font-family:' + FONT + ';font-size:12.5px;color:#a9bfe6;line-height:1.7;margin-bottom:16px;">⏱ صالح لمدة <b style="color:#fff">' + CODE_TTL_MIN + ' دقيقة</b> &nbsp;·&nbsp; يُستخدم مرة واحدة فقط</div>' +
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td align="center" bgcolor="' + t.accent2 + '" style="background:' + t.accent2 + ';border-radius:14px;">' +
        '<a class="btn" href="' + url + '" style="display:inline-block;padding:15px 30px;font-family:' + FONT + ';font-size:16px;font-weight:900;color:' + C.navy + ';text-decoration:none;border-radius:14px;">تأكيد البريد وتحميل البطاقة ←</a>' +
      '</td></tr></table>' +
      '<div style="font-family:' + FONT + ';font-size:12px;color:#8fa8d6;line-height:1.7;margin-top:10px;">بنقرة واحدة: يُدخَل الرمز تلقائيًا وتظهر بطاقتكم</div>' +
    '</td></tr>' +
    // diagonal band
    '<tr><td style="padding:0;line-height:0;font-size:0;background:#ffffff;"><img src="' + (cid ? 'cid:' + t.band : SITE_URL + '/assets/band-' + t.key + '.png') + '" width="600" height="44" alt="" style="display:block;width:100%;height:auto;border:0;"></td></tr>' +
    // white bottom, like the bottom of the badge
    '<tr><td bgcolor="#ffffff" style="background:#ffffff;padding:6px 26px 20px;font-family:' + FONT + ';text-align:right;">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
        '<td style="vertical-align:top;font-family:' + FONT + ';">' +
          '<div style="font-size:26px;line-height:1.4;font-weight:900;color:' + nameColor + ';">' + esc((m.fn || '') + ' ' + (m.ln || '')) + '</div>' +
          '<div style="font-size:13px;font-weight:800;color:' + t.ink + ';margin-top:2px;">' + t.sub + ' · ' + ltr(t.label) + '</div>' +
          '<div style="font-size:15px;font-weight:700;color:' + C.text + ';margin-top:10px;">' + esc(info.inst) + '</div>' +
          '<div style="font-size:12px;color:' + C.muted + ';margin-top:12px;">رقم التسجيل</div>' +
          '<div style="font-family:\'Courier New\',Courier,monospace;font-size:17px;font-weight:700;color:' + C.ink + ';letter-spacing:1px;">' + ltr(info.code) + '</div>' +
        '</td>' +
        '<td width="96" style="width:96px;vertical-align:top;padding-top:4px;" align="left">' +
          '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="' + t.accent2 + '" style="background:' + t.accent2 + ';border-radius:999px;padding:6px 14px;font-family:' + FONT + ';font-size:13px;font-weight:900;color:' + C.navy + ';">' + ltr(t.label) + '</td></tr></table>' +
        '</td>' +
      '</tr></table>' +
      '<div style="border-top:1px solid ' + C.line + ';margin-top:16px;padding-top:12px;font-family:' + FONT + ';font-size:12.5px;color:' + C.muted + ';">' + ltr('31 أكتوبر 2026') + ' · الجزائر العاصمة &nbsp;·&nbsp; الملتقى الوطني السابع</div>' +
    '</td></tr>' +
    '</table></td></tr>';
}

function steps() {
  const st = (n, t) => '<td class="col" width="33%" valign="top" style="padding:0 6px;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
    '<td align="center" style="padding:14px 10px 12px;background:' + C.soft + ';border:1px solid ' + C.line + ';border-radius:14px;">' +
      '<div style="width:30px;height:30px;line-height:30px;margin:0 auto 8px;border-radius:50%;background:' + C.lime + ';color:' + C.navy + ';font-family:' + FONT + ';font-size:14px;font-weight:900;text-align:center;">' + n + '</div>' +
      '<div style="font-family:' + FONT + ';font-size:13px;line-height:1.7;color:' + C.text + ';font-weight:700;">' + t + '</div>' +
    '</td></tr></table></td>';
  return '<tr><td class="px" style="padding:18px 26px 4px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
    st('1', 'اضغطوا الزر أو أدخلوا الرمز في صفحة التسجيل') + st('2', 'تظهر بطاقة الملتقى وتُحمَّل فورًا') + st('3', 'احتفظوا بها على الهاتف وقدّموها عند الاستقبال') +
    '</tr></table></td></tr>';
}

function eventStrip() {
  return '<tr><td class="px" style="padding:0 32px 26px;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="' + C.navy + '" style="background:' + C.navy + ';border-radius:14px;"><tr>' +
    '<td class="col" width="50%" style="padding:16px 18px;text-align:center;font-family:' + FONT + ';">' +
      '<div style="font-size:12px;color:#a9bfe6;">📅 التاريخ</div><div style="font-size:18px;font-weight:800;color:#ffffff;">' + ltr('31 / 10 / 2026') + '</div></td>' +
    '<td class="col" width="50%" style="padding:16px 18px;text-align:center;font-family:' + FONT + ';border-right:1px solid rgba(255,255,255,.15);">' +
      '<div style="font-size:12px;color:#a9bfe6;">📍 المكان</div><div style="font-size:18px;font-weight:800;color:#ffffff;">الجزائر العاصمة</div></td>' +
    '</tr></table></td></tr>';
}

function summaryRows(info) {
  const r = (k, v) => '<tr><td style="padding:10px 0;border-bottom:1px solid ' + C.line + ';font-size:14px;color:' + C.muted + ';">' + k + '</td>' +
                      '<td style="padding:10px 0;border-bottom:1px solid ' + C.line + ';font-size:14px;font-weight:700;color:' + C.ink + ';text-align:left;">' + v + '</td></tr>';
  let rows = r('رقم التسجيل', ltr(info.code)) + r('العرض', ltr(info.offer)) + r('المؤسسة', esc(info.inst)) + r('الولاية', esc(info.wilaya));
  if (info.members.length > 1) rows += r('المشاركون', info.members.map(m => esc(m.fn + ' ' + m.ln)).join('<br>'));
  if (info.discount > 0) rows += r('السعر', '<s style="color:' + C.muted + ';font-weight:600">' + money(info.price) + '</s>') +
                               r('خصم التسجيل المبكر (20%)', '<span style="color:#1f9d55">' + money(info.discount, '− ') + '</span>');
  rows += '<tr><td style="padding:12px 0 0;font-size:15px;font-weight:800;color:' + C.ink + ';">المبلغ الإجمالي</td>' +
          '<td style="padding:12px 0 0;font-size:20px;font-weight:900;color:' + C.blue + ';text-align:left;">' + money(info.total) + '</td></tr>';
  return '<tr><td class="px" style="padding:18px 32px 22px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="' + C.soft + '" style="background:' + C.soft + ';border:1px solid ' + C.line + ';border-radius:14px;"><tr><td style="padding:14px 20px 18px;">' +
         '<div style="font-size:13px;font-weight:800;color:' + C.blue + ';margin-bottom:4px;font-family:' + FONT + ';">ملخص التسجيل</div>' +
         '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family:' + FONT + ';">' + rows + '</table></td></tr></table></td></tr>';
}

function cta(label, href) {
  return '<tr><td class="px" align="center" style="padding:6px 32px 10px;">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td align="center" bgcolor="' + C.lime + '" style="background:' + C.lime + ';border-radius:12px;">' +
    '<a class="btn" href="' + href + '" style="display:inline-block;padding:14px 34px;font-family:' + FONT + ';font-size:15px;font-weight:900;color:' + C.navy + ';text-decoration:none;border-radius:12px;">' + label + '</a>' +
    '</td></tr></table></td></tr>';
}

function footer(cid) {
  return '<tr><td bgcolor="' + C.navy + '" style="background:' + C.navy + ';padding:22px 32px;" class="px">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
    '<td width="60" style="vertical-align:middle;"><img src="' + (cid ? 'cid:org' : ORG_LOGO_URL) + '" width="46" alt="Robot Éducatif Algérie" style="display:block;width:46px;height:auto;border:0;"></td>' +
    '<td style="vertical-align:middle;font-family:' + FONT + ';font-size:13px;line-height:1.7;color:#a9bfe6;">' +
      '<b style="color:#ffffff;">تنظيم: ' + ltr('Robot Éducatif Algérie') + '</b><br>' +
      'لأي استفسار، يكفي الرد على هذه الرسالة.<br>' +
      '<a href="' + SITE_URL + '" style="color:' + C.lime + ';text-decoration:none;font-weight:700;">' + ltr(SITE_HOST) + '</a>' +
    '</td></tr></table></td></tr>';
}

function codeEmailHtml(info, otp, cid) {
  const fn = info.members[0] ? info.members[0].fn : '';
  const inner = hero(cid) +
    '<tr><td class="px" style="padding:30px 32px 4px;font-family:' + FONT + ';text-align:center;">' +
      '<div style="display:inline-block;background:#eaf3ff;color:' + C.blue + ';font-size:12px;font-weight:800;padding:6px 14px;border-radius:999px;letter-spacing:.3px;">الخطوة الأخيرة لتأكيد تسجيلكم</div>' +
      '<h1 class="h1" style="margin:16px 0 8px;font-size:26px;line-height:1.45;font-weight:900;color:' + C.ink + ';">مرحبًا ' + esc(fn) + '، يسعدنا انضمامكم</h1>' +
      '<p style="margin:0 auto;max-width:470px;font-size:15px;line-height:1.9;color:' + C.text + ';">شكرًا لتسجيلكم في الملتقى الوطني السابع. اضغطوا زر التأكيد في البطاقة أدناه، أو أدخلوا الرمز في صفحة التسجيل، لتأكيد بريدكم الإلكتروني والحصول على بطاقة الملتقى.</p>' +
    '</td></tr>' +
    ticket(info, otp, cid) +
    steps() +
    '<tr><td class="px" style="padding:14px 32px 6px;font-family:' + FONT + ';font-size:12.5px;line-height:1.8;color:' + C.muted + ';text-align:center;">لم تطلبوا هذا الرمز؟ تجاهلوا هذه الرسالة؛ لن يُؤكَّد أي تسجيل دون إدخاله.</td></tr>' +
    summaryRows(info) + eventStrip() + footer(cid);
  return shell('رمز التحقق: ' + otp + ' — صالح لمدة ' + CODE_TTL_MIN + ' دقيقة · الملتقى الوطني السابع', inner);
}

function badgesEmailHtml(info, to, idxs, hasPreviews) {
  const many = idxs.length > 1;
  let gallery = '';
  if (hasPreviews) {
    const w = many ? 170 : 280;
    const cells = idxs.map(i => '<td class="col" align="center" style="padding:8px;vertical-align:top;">' +
        '<img src="cid:badge' + i + '" width="' + w + '" alt="بطاقة المشاركة" style="display:block;margin:0 auto;width:' + w + 'px;max-width:100%;height:auto;border:0;border-radius:10px;">' +
      '</td>').join('');
    gallery = '<tr><td class="px" style="padding:10px 24px 6px;" align="center"><table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0"><tr>' + cells + '</tr></table></td></tr>';
  }
  const inner = hero() +
    '<tr><td class="px" style="padding:30px 32px 6px;font-family:' + FONT + ';text-align:center;">' +
      '<div style="display:inline-block;background:#e8f8ee;color:#1f9d55;font-size:13px;font-weight:800;padding:6px 14px;border-radius:999px;">✓ تم تأكيد التسجيل</div>' +
      '<h1 class="h1" style="margin:14px 0 6px;font-size:24px;line-height:1.5;font-weight:900;color:' + C.ink + ';">مرحبًا ' + esc(to.fn) + '، مقعدكم محجوز</h1>' +
      '<p style="margin:0 auto;max-width:460px;font-size:15px;line-height:1.9;color:' + C.text + ';">' + (many ? 'تجدون أدناه بطاقات المشاركين.' : 'تجدون أدناه بطاقة المشاركة الخاصة بكم.') + '</p></td></tr>' +
    gallery + summaryRows(info) + eventStrip() + footer();
  return shell('تم تأكيد تسجيلكم — رقم التسجيل ' + info.code, inner);
}

function lookupEmailHtml(to, otp, cid) {
  const digits = String(otp).split('').map(d =>
    '<td align="center" valign="middle" class="digit" width="54" height="68" bgcolor="#112c66" style="width:54px;height:68px;line-height:68px;background:#112c66;border:1px solid #2b4d94;border-radius:12px;font-family:\'Courier New\',Courier,monospace;font-size:34px;font-weight:700;color:' + C.lime + ';">' + esc(d) + '</td>' +
    '<td width="6" style="width:6px;font-size:0;line-height:0;">&nbsp;</td>').join('');
  const inner = hero(cid) +
    '<tr><td class="px" style="padding:30px 32px 6px;font-family:' + FONT + ';text-align:center;">' +
      '<div style="display:inline-block;background:#eaf3ff;color:' + C.blue + ';font-size:12px;font-weight:800;padding:6px 14px;border-radius:999px;">استرجاع بطاقة المشاركة</div>' +
      '<h1 class="h1" style="margin:16px 0 8px;font-size:24px;line-height:1.45;font-weight:900;color:' + C.ink + ';">مرحبًا ' + esc(to.fn) + '</h1>' +
      '<p style="margin:0 auto;max-width:470px;font-size:15px;line-height:1.9;color:' + C.text + ';">أدخلوا هذا الرمز في صفحة التسجيل، في خانة «لديكم بطاقة مسبقًا؟»، لعرض بطاقتكم وتحميلها.</p>' +
    '</td></tr>' +
    '<tr><td class="px" style="padding:18px 32px 8px;" align="center"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="' + C.navy + '" style="background:' + C.navy + ';border-radius:18px;"><tr><td align="center" style="padding:22px 12px 18px;">' +
      '<table role="presentation" dir="ltr" cellpadding="0" cellspacing="0" border="0" align="center"><tr>' + digits + '</tr></table>' +
      '<div style="font-family:' + FONT + ';font-size:12.5px;color:#a9bfe6;line-height:1.7;margin-top:12px;">⏱ صالح لمدة <b style="color:#fff">15 دقيقة</b> · يُستخدم مرة واحدة فقط</div>' +
    '</td></tr></table></td></tr>' +
    '<tr><td class="px" style="padding:10px 32px 22px;font-family:' + FONT + ';font-size:12.5px;line-height:1.8;color:' + C.muted + ';text-align:center;">لم تطلبوا هذا الرمز؟ تجاهلوا هذه الرسالة؛ لا تُعرض بياناتكم دون إدخاله.</td></tr>' +
    eventStrip() + footer(cid);
  return shell('رمز استرجاع البطاقة: ' + otp + ' — صالح لمدة 15 دقيقة', inner);
}

/** Editor only (select it, then ▶ Run). Flags the test registrations made while building the site:
 *  they stay in the sheet but leave every count. Nothing is deleted; the dashboard can restore any of them. */
function markTestRegistrations() {
  const codes = ['ET07-T9ZJU5','ET07-5B6LLJ','ET07-5B8YFF','ET07-5BPT41','ET07-5CJBTU','ET07-5HTY6O','ET07-5IHBS0','ET07-LINKTEST','ET07-5UPFAX','ET07-5MVWD6'];
  const sh = sheet(), done = [], missing = [];
  withLock(() => codes.forEach(c => { const r = findRow(sh, c); if (r) { sh.getRange(r, COL.status).setValue('test'); done.push(c); } else missing.push(c); }));
  Logger.log('Marked as test (' + done.length + '): ' + done.join(', ') + (missing.length ? ' | not found: ' + missing.join(', ') : ''));
}

/** Editor only: prints the numbers the dashboard should show, straight from the sheet. */
function healthCheck() {
  const d = adminData(), conf = d.rows.filter(r => CONFIRMED[r.status]);
  const by = s => d.rows.filter(r => r.status === s).length;
  Logger.log(JSON.stringify({
    rows: d.rows.length, confirmed: conf.length, people: conf.reduce((s, r) => s + r.members.length, 0),
    expectedDA: conf.reduce((s, r) => s + r.total, 0), paidDA: conf.filter(r => r.paid).reduce((s, r) => s + r.total, 0),
    pending: by('pending'), test: by('test'), cancelled: by('cancelled'), mailLeftToday: d.mailLeft,
    byOffer: ['STANDARD','VIP','GROUPE'].map(o => o + ':' + conf.filter(r => r.offer === o).length).join(' '),
    columns: sheet().getLastColumn()
  }));
}

/** Run once from the editor: creates the Registrations tab and checks the embedded images. */
function setup() {
  const sh = sheet();
  const im = inlineImages();
  Logger.log('Sheet ready: ' + sh.getName() + ' | images: ' + (im ? im.hero.getBytes().length + ' + ' + im.org.getBytes().length + ' bytes' : 'FAILED') + ' | e-mails left today: ' + MailApp.getRemainingDailyQuota());
}

/* ---- embedded e-mail images (base64) ---- */
const IMG_HERO_B64 = [
'/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAkGBwgHBgkIBwgKCgkLDRYPDQwMDRsUFRAWIB0iIiAdHx8kKDQsJCYxJx8fLT0tMTU3Ojo6Iys/RD84QzQ5Ojf/2wBDAQoKCg0MDRoPDxo3JR8lNzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3',
'Nzc3Nzc3Nzf/wgARCAImA+gDASIAAhEBAxEB/8QAGwABAQACAwEAAAAAAAAAAAAAAAEFBgIDBAf/xAAZAQEBAQEBAQAAAAAAAAAAAAAAAQIDBAX/2gAMAwEAAhADEAAAAdasv0fIAKAgVSCgsosoEUJQUCyiywBQUCywKAUCgssCkoKQoCgsCkogAUAFgAUFAJVkURVR',
'VkURVRanG1YlVFWRRCUlLJRFElVKFS2JSRRAJRxck1jB5/QAsoCBVgUCyiygsAlBQLKKARQUCkLKAUFAssLKAlEtCLKLLCwUAAUAFgUAFABYFAgUKS1ZKWBZFEVUIJSxRFlRVSURRALCVLYlEWAGMHm9QFACBQoAsososoElBQLKLKBFBQUCywsFAsosoElBQVLCwUFS',
'iwVKBQIAFABYAFBQIq2SlgUFAgigBSURVRYJVQEUQCUQFQlFgGLHm9QFACBSygCygJQUFAssLKLBQVLFSiwUFBRIsFBUososRQVKLBQLBUoFiwVBUVQAgUFCopYFgUAFIAKFgAUAFQCAAlgBAATlxqUWYseb1AVKAgUBQAUJQLKLKLEUFBUosFsRQK2DNw205np8/bnq',
'mTz0vzVu2q9+PjuX8lnjsazUpUosFSlQWwVBQgCwVLQAWALBUVyFysWVBUVYhYKFVBUWVBUUAJVgCFQAEACAsoFzjEvm9QCygIFWWFABUqLKAUFSlSwsFsFBUoyXu3Dh18Hsw+qc953XOF9HB7PG1N6yvzHf/L36/bruezrSO671156I3tjWi9P0DFWa3d4S6P5PofTZ',
'ovpzecPnHp4bJ154bp3zF8umvN1S6T1b3jbNa5bj2S6U3UfPPTnM9vGlN1Y38+79w8m8a9j/AKJ876Y9fdm81z6fOvPfB24e5jmdZFjuRl55fV25hqABQUsAIFEFRQBBUABAAAIcnEmNsvn9IAFCBVlhUoAFlSxUosFsFBUosFsRQbZksbkvJ6NL8+R4+75ngd3Tj0VD',
'V9/h9DO1eTDpx8n0r5r9K8/ux2K2Lr5ddVySdOew6Bv3zc27N6/sHPeHzGHzEvz7ZNa2X0cM989+g/O8bzW1ajt2dajiMph/Rw+i+f0Xx+rXvPsng68/JsWubHnWj5TC8/Tw2vhgM7w65TXNk68b83tlzfmnZ1ZP0+fYcd5+fn75TX8rp1no9fk9fv8ADOHbN561l0AJ',
'VQVFlQWFCFQVBYAAAhYKIVEY6xw70AFSgIsUqFAAsWUFSixFsFAsosFsG2ZLG5PxejVuGweLzefG8OV+x4PH2ehdS8e/E6PTkfR8b6Gp/S/me8+/p24z3Oe/D3ejG6my4L1sXu9mMxFezPfOdr3nv9nlnPWS+c5jB+jjndu0nZOXTX8RkMd6eH0bp8fb4/V4Z7m8+XOa',
'Vnk4+3pZ1kMbie/Wdh+c7npfXnt+a1jK8eui+b1eP0efaMD4rx65vWfXdT0+zx+v1ebkjXO8aOudvG64EugAogqLKgqCoKgCUSqiLAAIMePP3WWgFgoQKFJZQALKlAKlFgtiKlKgtg23L6nuvj9GvenJYX5fTuxvv7fK1ztzfL6Hm8nsnl+f6vV5vZmvdn5pLx+349r9',
'PfPH6dPyXh23vy6cP0bPz3p2Xxuybxpvd0evtzzXRmvJ5u+By3g8PXntmG2TQ8ay/Tk/LqefP9GNzfZrn0DQNTbcHuXTx6a5j89h+/LPefIdHDrp6Pd5ag5pdYqCoOPb1dsUMCVUF4ch1OzhdxFtgAAAAAEFQVAAAUmOHn9AVQALKAgVYFSgAWUAFSiwVKVBbBe7osbj',
'sPy3Iefrt2Ly2R8nXA+f2ZLy3EZzhqnuzsWpY2evhR0xufforj09uY1q9M71idbY17dw0Jc7fqvVdTeLoznv1dPXe3LcNQjOs958SM1n9HZu26pxam3+fWGbsWPxrc3fo1Bz0R6OVsHNFzUWVKce3p7Y5IYqCoAsAnDsNdLs4XUCgAAAEFQVBTmnHnUyCYocPWAsVQAV',
'KBYsCoUACxZQAVKALBbxpUFsJc/r7N+l4LUnLp29cvfksFQWwVCVKVBUVUosFQVKVBUJUFvG1UFQVBzvG6zUJUHHlwNd16Ocx2IZooAAADjw7YvU5cbsFIKgqCnOZ486ZqEsADFpeHsBAFiqACpQLFgVCgAWLKlAKgoAFiqlSoKlKgqUqCpQEqCoLYKgqC3jSoqoKhLY',
'KgqKqCoOdi4qKqDj6PN6sb6eHq4HR2cJrPe6OxnmlZAAAASjr493FrrI3TmnHnyMiM1BUFRAGLscfZQAgCxVABUoCBQoSgAWVBQLBUoAFiwVKLBUFSlQVBQlQVFVKAVBUFQVLZUFQVBUFRXYluFgqDj6vJ6sdOQxXV2q8s9XTvPHs6Vz3ursmKEAAAASlBABCoKgqAhc',
'aOPrAqUBAFiqACoKECgKlAAFndHUzfDzaw7K8NzG33cNzyPRw1Opy47BYuc9fPesM93J58Hsvilw9z3bqY30cfVm4rx+/wAHTK5DNZuuenL+bN8eN3DqjVLnvZuapmvLkzz4TZNbsqOmb7PFs2NYrjsWuYr3dPuNdux91a5kPJkzyYvN4PWexL15nLnl1u7ni+P1cvXx',
'6eN7+XPWOZTwanUO+ePT6FeS93TvPPn0LnvcOcwAAAAAAQVBU4HPh1m6GvGOHYAKqChAAqpQBYKhKKWCoKlAARYqoKBYKlMrnsL28end0YL36zm+epDa+WpDaPFhFnty2ue6vJmu5nXbzwPkTZ2sKzWS1zMZvo8OI695znkx3Oz39OUZ16eeJxUbX0a21Nm7dUG18dWG',
'yeTDLMtio3nsRrFRVvGnD1+T1890Z1UFQVBYJ1dPrmp5eV69Tvvn5sdqVkAAAAnE59fCN07Wurt7bjQS4gY3UoAFLBQAgAAUsFQUicnG1UFQVBUFsFQlsVUFQVBUFIlsVUHveBm2xqVBUFQVFVCW8RyQVKVAAQdidlzwZfDy8nG6zx9fj5Z363Xz56qCoKgqCoLw5K8/',
'D19Wp1dnU1n0OjsY5oZqReXHr4tcpOxrh2dvLGpTNAAxIz0WEqUAACgBC5PF5nzXpnfy8+sKyeL9uK9npzcVfX5dyMpiiu/25YtkMdqVlMYuV6815vl78XDL9Na5eN+vyr1+yXEPT5bKmWMV6+jIy5HWfpfzPnu3u9/TGKe3w6mz9mu5rh09ep+vxdMcnf79TEu/z6lM',
'nLjGUxh3bDhPonDp8uccp35Y138jzshja5Mh6M3EPX49ZqKZ/X/oHHpqWd8PgTYtd93Xm9+A3/59vNldufHs67Nenl2ePGvQ7fdm4xkcacpGpfZ4cxi92C3nRMa5PZ6N5xfV7+jU8TN47U6OfRd458ZzXjz7eebx5xm1BUFQVBibGelAACVKIABnfXz1kdM+g6V8fpjP',
'b5Pb9Xnu+p7ZgPg9c7047ozfRrOz6z9Ln9D0Df8ATPFvbvFdc5Nl0Te9D9+fpfzn6N875XZvN6vLHo6O7os1wn3uP0vq9mi+Tv8AQPmm/wCpamC+ofMfp2pofJy3ndfnv0L5rz39XwfswPPWz6ntfz7Ux/1r5P8AWNZ+W+f0ef08thz2gXlv6l8823F8t4j6Joe4nT06',
'pvub89+i/Ofou58s+jfOPo+s6r6ej0Gaw+X6eeso1/0y9Gp7XqXp48pns4aL9A+ffQc6wPDnxk2PWdm1jGtp+e/Qvn+87brm/wClS7tov0L5xnX0j5n9N0SXdMd6dKzd6+efQvnPTHbH0XefnWYxuRNjwOex/DrmOOHstw2Z1Xrz3TJ/OdrxrB4nbtY9HLj2S6zQAAAA',
'AYkZ2BUVQAAkBufg1uc95nZdBeO/RHzt57v2meTt9M3j2apm/jdMj04HXO8+gaDn9a9uN4yGrZL5+/doW6Yb0zcfP2fN/Jfoeua9fqY2bpwDtl3dOf8AXN34+L5v5uv1R8rbz9Uan58a3NoeI3Pqd+WLPqXn+aj6lflo+pPlo9HQejltW1dWl+Pvut1TWtT6g+WtT6l5',
'vm1s9u+/NW8z6Rpn0Dltw0CS7PrXrxfTP0H2aZs3DphNR2TW/Vx2v24HduHT5f8AQsZsll6/n+ON913CXrj6g+Y3F+ncfmY+hev5ks+m/O/M3N8yeoZPz9c18w+i/O+uPV9P+T/S86+e5jLeyLqGf1g3v16ln+W/f065re59Hvzi6zsuu8eXXnbG80AAAB19NdzztTy2',
'OXSoKgqCpQiqgAHbHVOUJ6OiRtPm1949crwvszmcPGLs/DWnmvfm9dveZHHc3ScKdICXN4SZv0b5z2dedFdM5rrxLN9/gLFlslKAWUSjYdv+XOO8rijrgqwAKznPAOens8d3Mp0eJm7h4ddZth1wyOOkuzYrHM0N5URZTleFs5FsgNpatOXT0+ZemJ2cBnuvB8ee/R7M',
'XyrcvLrvLluxd5VbFlKlKgqCuHTZ3dPXdxyrWaLPETzeiopZUTlkJcbfqPy3NqN5AA9H0LQNm471vxZP6PXyV6vptnyh7/B0zz9PLaca1Xy7zpx5LL0w58PbLneHv7OHTSOPqnfn5py+tZvyT1cdmrK6LsvDlrVe7oznbGN7NgyPPWgjtzqKs5/V+W/kzs6umKbVLqrd',
'tIijcL9W57+UO/6hHyi+ny9edAstSgAAAjujov1j5Tz338Nlx5hG2eg0xL151KOfCV2zhyZsvKuF7shnWIfRdP56xT6L87s48ebpnh29cmvW8v1Xh0+acu3O2a9Nw005d3Rm6xnRn9ZO7p6voFmgM7sJolzuB6c+SN5qDxjz+g5LNhz+j53lvwdf0H57H0L5X9U+Wy7b',
'lcvoWNZ7Vt2wGp5vTz9taH9e+Q/Xj5d9S+WfU8vlX1L5b9Sr5n4Pf4O/PIbjPHw6ZTV9lwpqm5ab9E6Z1fB7NrOs7T15Pq5b036/8f8AsB8q+rfKfq0vyfhz49+f0H519e+Rct8c1hPqes4/s1zcOPT575ffsPfny6+/UOevN9b+R/XD5NtGrbzvOA9/Xzzcj0bFpGNZ',
'/T9gyWp8++t/I/rlfKvqvyr6rHy7OYj6ZqYflqP0fnv5Jx5cfX57K1CUIjv3By83bo1Pt6euPq/yT638j5dNtx2w4hPR7fDtONa/6dfyOpr/AIN++f8Abn9E17ecF5+vPGYbf9T5dl/P29+W7abuWm8em46ZuemG6fNvpPzbeXZ1bp15+bjk9c4dcJ9Z+UfV1+Yb78/5',
'bzv+OwWx8empZn1ap1xuup5fYcX5v9D+efQ951vYtc2PGsBgM/gPRxtl6YBPJyOPZLKz2Wwfu4dN4+ZZTAS/U9V8zN2X0al0Lv2qeIbB48Vj69u+fPPWe/atGRgfqPyjYd5xXg7ujrjevb882DjvbfLgGderYdUJnMZ5lbNhPLi6yO+fPPVHu2vRkvtnjam8/Itk1nWZ',
'9L+aenU3PO6Xy47yuT1dWwYbp41rn135Bs2s+zO6sxrPctfpsuC81MtmNQp6du0ga/8AVvkuxbziPpnyn11su16VuvDp8l4Xj7PP9C0z6R8+4dcVsGvZbtzzTLPP19HmwFO7WM9rvbn9c1HyuPTafHghsPZrQ9PuxCzbdc8w3fVfEl9Gzais82e1DNam34bEsa2bTO7F',
'9MfQvm2dwW8cvpXzXYpc1jfO56xP0n5nmNPb09KXuymFRl8F0ctTN7FprGvRsOq1OjY9K93TPowHs8XXnbwm88nFL1o57ARxXk4cooqURKNl9WoXG+tz46gAoBKUlRu7R7z1umlG5S6zAFAAtRRFEURRFJNz01nWw67SSmoAWBYN+0LljX1HEaP1Y1R257DuXyz3cun0',
'lovs5b2f5/j3bmHXAqRYCrFEURQlJKAABZV58Cc0tyWEURRFEURSxRLOJyksqwVFdZOe7xklCUC8uCznePK5ChSKOM5o4KWXlbOLkOE7B1uXGUUAAFoAAEBSxAABSKAoUgAAACiezxozHp15nVi7yCBQABRFAAEoAJQAABzvXbnmlsAAAHEvGM6BQKlAOiHLoBYFikoA',
'cuXXdZ5pbAFEAAAASjgsmgFlAAApYCiUARKAAALAooQqCgIKAAAEUAAAAAAoAIAACgAHPgO1187mksTjJqwlCAoAIA6Bz6AAALBUFA5cVdjhyuaECrHCOTimud6+dzRY4c+Ep2ds15noHnehZ573jod46HoHneged6B573jod46HeOh3jod46Ho6LIBYFgWd50z0DzvQ',
'Oh3jod46HeOh3jod46L3Dpdw6XcOl3U6HdToc+uqgqEqCpQAAACwCCoWoKgqCoKg6Rz2AAAAAABUHLn187mpbOPHlxmqhbePJOVjWb3cvFL2dJnVQVBUoAAAAAAAAFX0+Unr6eXKzrRV58O+Hl4pahQSoKlBCoKgqUAAAA7u/wAVOx6PNrNSgAAAAAAAAhUFQVBUFQdQ',
'xsAAAAAAAB2dfKzkLHDmODklnIsqd6PHz4Z2MvLiG3YCPAy/lrxMx4jyzaPHLg7kMsmstmwJwuSykups106mLZjujAtw1Ahl8urw7F1+O66PoZezx+qzpRZ6fJ6vJKEptmOzcI3LTaNjwKdTZ+mXXm7aiedncbZ5Gc90uqt2wxgrtvA1WZTF6jvyWd8WtQ6N2wRhh7s+',
'vq4ei56RYAAAAAAAAACgAgKB1DGgAAAAAAAFg7HDnchQADv88icPX5Jptmp9udbhNcYuycNeGR9eD6K2r0anxjZ/Pg+g2DH43O2ezngvDLm+Hdj6z3R4PDGxaf3efebksYjN85iPHeoe/L1eX12ecHo8ns8YEu34zy4/Gto1Xv6bNp1X0+Yyua1Oy7brl8CbVqvq8tbT',
'ww3VLtPnw3mjZfXq3SbPqHd06mZw/p9/nYfMPAeUeqcvTOnWQAAAAAAAAAAAAAAOsZ0AAAAAAAAAsHLl1k7HBXI5px5kz2+Pl6W/E7umaAAAAqCoKhKAKAAAHqOF5dFgF9Hm7DoezySkFQVBUFAAAAAAAAvZ6EnmNQFBAAAAAAAAUAAAADgM0AAAAAAAAAA5804c6YAA',
'6uPLi6dvZ5h6XmHpeYel5h6XmHpeYel5h6XmHpeYep5R6nlHqeYel5h6ejiAFgqKvo8xPS8w9LzD0vOPQ849Dzj0POPS8w9LzD0vMPS8w9LzD0vMO3rgqCoKgqCgAAAEKgqCoKgqCoKg4iUAAAAAAAA5804c6YAAAA6uPLi2CgAAAAAAAAAAAALBUFQVBUoAAAAAAsFR',
'VQVBUFQVCVBUFQVBUFQVBUFQVBULUFQVBUHLh3yZ6XPg0AAAAAc+acOdMAAAAAHHgriNgAAAAAAAAAAAAAAAAAAAAAAAALBUFQVBUFQVBUFQVBUFQVBUFQVBUFQVBUFQVB3hzcQ64OgAAHLsGaGQAAAAJ1jXENWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
'AAAAAAB//8QAMxAAAQQBAQYFBAICAgMBAAAAAwABAgQFEhARExQVNCAwMTIzIUBQYCIkBjUjQSVEcKD/2gAIAQEAAQUC/wDwICFMsquNhBFAMsLWPIL94b6qrjZTQhQFGxZGBhZSEpxdpNaojMi1iinHHHkx6pQfudamWwq1MVdTnEcbWTd1J3k6r2SAeteGfYe8IM2e',
'BR2hcKxyVhcjYXI2FyVhDrGI/I2FyNhcjYRBEE4a5DLkbCdnZw1ymbkbCHWMRcjYXI2FyNhEqmHFqR3bkbC5GwuRsKcHhKFU825GwuRsIg5jcVYpYvSOzIVcpm5GwvRcaC48Fx4LjwXHgt/6Tiq4zP6NayIxIxyGl4aROJWt48kz1hcENwjEu+Cl8m0o4lhim0wVj58R',
'8CoezbkO0H8e2AWLkNtkTGFje0l7X9cV26s/WUiaX401xiLjTTFd3F/GX6RhPbkuzkPx1bU60o5MUmsXnI0PergJnj086s1jVx4f41M5teKJMglj9lj58R8CLJ2NipSc6yc5NZ1SdD+O0KRhdPMj1DBHiPRWyT5nH2oxG9yvux3av9W6W6qA5caP8uLrwsW5cjE1ivVr',
'XAyoHlnYCHKPzf8AW79HwntyfZp2Z1Ibt4GbemHtj71KcYLjhWTKOVbDfE6n78P8Sx+yx3GI+BG+bEdwsr3SH8cpNFuOJXjDerh/RWu5BWIdun2FjO0WuCZ2fYf5cF3dkBZZj/Ifiw9fgVrp+Zst8zbd36LhPbk+zmMgkz79jxZ08HZRHtd9ygCc1H5FarNZj0oa6UNY',
'yHD2PixO9avGvFY0jSmp0ATmAMAQd9zTfVPEdwsr3SH8dkLHH0uC6XBUIME6LjoEJWrxrwl9I43tZe1/XE9uj/LXsSq2euRVu7zR7eW41dN8zeDd+iYT25Ps0WtGSk0hvtd2ZQCQiGGA9npPn6y5+sufrLn6yq3Axnz9Zc/WXP1lcyOuISyCQWSDJufrJ79ZXL/Gisca',
'ATc9WV8sTWEO9X0c9WXPV1z1dEs6bo8iCTc9XXPV1cv8SNC0EdeV6vpWOsiEF71fcaOtS+q0wWmC0wTbouOOnx7v0LCe2/CRKoyxk6dmdiVU76VCEyIVeENjvuTTmZ39UDGR0dMrqxBhno0uYj0yur1HgRrQYp79MYAoMdZbtEQQY+oOxC4Jg2KVIRgdMAshWhXWPrQs',
'K8GIDU6r2ZdNArWOaA29emh3Qrf3L9WFeNYL2CtjQKxQCMP2e79Ax9zlXEWBonrDO0xnrKE4kZSi0tvF1SHReTszRaXuULVc4Y16pFcDwD4zs5Tlz+S7Oh3eX7VVe5ynZ4b4cn3gpSad76VHd3WGWW7nD/Fk5O1tu2j7pzYY5CaZcx8WPNEBySqlRqQ5h+13fc7vwwiz',
'FKrk4zTbnY9KE3eZAuzs6mZmcdQhkMcBxs3BV1ZulPtCekwucqDa0bjnx12AoczS35G7Ao6k2HZe5VkrJ6jghJ4TherEhztUcbBeMaD7p3LYJ1lizjC+RLAp8faau72aclaviYTetq2CdXH3YxHk7AiwoSFA/HpKxfFEX2+77bd+JrXC13q3RWFKLSaeObUCuMDGMMMb',
'WSmT8zu+z3fjauTmNDsCIO1lGZTnIkvxm9b/ADt3n7v2Hf5+7y937Du3s8d23f5+7x7v2NvRPFO27bv87d4N37K3pteO3et/nbv2dvTweqeO3f8Apd4AxA20BwLYGEb5G3CI7O0LQ4rQFK5kBQDY8GSAMKyABhh4KzhaU3By9ZwMiuDgWQDhTTs7IEWke0EY7mRFAJvI',
'b08TtvTtu2s/27v+BFo4n/j1/RX9Nf1V/WX/AAL/AIl/BfTwYlhubnj8fLNCJMv8eU7avWgSlRFCdPHfzp4ruw/7e/3ioQiS1ZuGrzq5Apjn/wBtbIGuWtZa5KhWjzda9I1nId5mVlfj8ANNagCxKxVo91k+7u/67Hvw6dWxzqA2m5e/2GW7jb9F/Ff8a/4V/XTcuv6y',
'/qr+oi6NfgeKdt21n+z1bW+v43HgkUvPVOLPp85ZI4jRIakcQzURhgeiIQC0QRBKgCYzjbI25xJZxcIuNndnDkSs54iq3pEoyOeVA8wSoAmK3EV2s1J7FmNFz5M4zLIHGaFBmlbyDM1utwdfK0uDxqPLiLSEMfTxzNKgYhC0iCGWiMICUa8m5Bi2zDJcyJYGN5DenlPH',
'azrf5+/wNH8djbEAvKlX2WTwM3jq2ZVp8elNcekNWjysE215DgVrlUKnN5z2Qk8Jc5XMuNj1aucaH2TeY/1Tx2s/mb/A0fzgrMhBsWZHj9+3nO29O27a0vI3rftaKZt36wOEiTJjjwH4Gfcmlv8APeK9Nm9M/gd1v2tFM277gFIphtSLxz0yAh51SnzMLlXllUp8zC5V',
'5byqoeYOfFcEPhxlINkE6IGv36AAVvJAPimJiNEPNqY3mQXK3Klwov42qtw0q1bj2LON4APA0kz7/Jqh5gtjH8EPgeO1nW9b9rR3pm3fdVr7gE19+ZNblcZ6FiLIdU5G6fZRqpQRi2p+n2dggFKun2USkccF0+ynbc+H+DM+uH+HMbQ1jmbpltGrmDthjrM4FHIJMV31',
'/skIJSpsbbRKdgewZyiblMi8zHO+wQCmXTbe4oSBdN9Xjj7clLHW4qTPF6HeWPgQqFgwzCmAlcBLEj0jggh0bJG6ZbVisWv4cR2Oa7qo9mbljkAjxD77uU7HwRZ5PyVnS00IRDLp9lTo2IR8GK7vJdmh1LBG6dZR6xQMOEyP0+y7GrFD4Gbemju+7amBxnaMTKl3Zvhx',
'YGKU5oAhWtQsLMfAD53VQXHsSeARhvCMS/2f/aN8uH+DM+uH+HMbcbHTRNkQBN/A4rYuBYVLtMp3+K7+/wBlU0va+kYvlqzPXPCwPORhEqb0sdwsXbHWi2Vqu/8Ax2BXq/LWMdHVdKRhDr5AFgmWrxJWod7Y7dYvscx32D7nM9lha7TlZtCqtVtQtRzvhxHY5vusN3mV',
'7HD97lOwQMWEgbY2DYGOHDJLh5F23sAPFs/wAIORAYtrtfBie7yXZYoDEJYsDrxrWYWWzXsx54gO2TrqMhmHkKrANpdNH7vEV4nNmAhCMcmkO5WIM2mSpRlzRvhwr/xzEJSHhmdny7O4ARlxnWJf+3kISnUxkX5y/wBn/wBsixlxcQzsDM+uH+HMbafaZOMuexvY5eMn',
'vaJqn2mTjJ72KjJr1/stM1QscwG3ipysDhCrXuEJZPomm9LHcbGZ3WF38pnYu5sTGTXsh9aWOjJrtvtqHeWO3WL7DMRk93BxdrGZ7HBu3K5wc3lg2dg57ZhoarWVGKFRYjsc00ntYaLtcyvY4fvcn9aOiSqdrkITlei26NiM3tKi+7K3oSJUxsZNet9q0t+xgw0WN3Hx',
'PeZLssK//FmYSk2FZ2jmWd4aZLTJYfew816feYiYRVs0aBJUrzgaF2vJcwBcwBGOFxVbEq5R3a82gSBFOcYNzAE9gG4c3HMGQCSMTCm9/s29VzAVzAFliQm+KIOAsqSE9ghyKQA+CF7IGfmq65quuarrmq65quuarrmq65quuarqWRqRlzdZ1zVdc1XXNV0d951i8fEk',
'HcIG5quuarrmq65quuarqzZA9ei7RtnsgcCxXYTOGD81XWWOKdOhbeoQd6tNhkgRZ7ZgW/lnH/rLEdjMwhvzVdZKwGdPFTjC3zVdczXXNV1zVddSq6+arrmq6nN42K2TCSMbAZvc7RV33mTvvfEd5k+yp2XrFHdrkaBIEUyQGuZAuYAuYAsuSBG815fbCg5SPiiqjV5a',
'OZIyhHXPpL7OlF3UaDgJlCNCrVx8iIk2HB33v4cJHfcy03hR2hxDlEDGOYl+lyfmUd3J5YZOcx9OsYEvd4qlElqNcTADkSsa5Rq82S5jXqhrBewZ8MdUKvKBzZWkdYuy1exYCOyLov8AIUIVw3ztYteXHElmOjjZANkysOmmfc9WxCyI2LhOVOlCq+YO3DAJzFfEmVGr',
'yo80Rnn57yZk8nf7cBeCXqzIuUI7Sk8pRfTLqdhN9HjlvpPKvuKWZphyTCDZuEsePDz0XcppnR2jylkcBZA4p2rZbXmY3Icu0LICNlHZ7vjoX2qQtZQpoqtZJWlYvnsDp2OWN1pkfLmmz/V9le6eu3WTbrN09jzR5fdGeYfcc5Dz2DIQMoZc7MXLWJtr1PWNwDdXZGyp',
'ZM7vJ/NeW5PLf9rEc5p2dn81oykni8fHwp/n2luTPv8AOd9yeX21cfGNZLKmO25Zn8MIynKVU8ItVsSaTPF9sIynLGvOi2S4lyUmeMvBCuYkZXYyadcwooYpledc0FyllvwowGJEgpif7VpeBm3u7PF9kBzIpiINlvTz8/Hd9bhHlfHVO9Y3UrqvWp2iQhHRb7kEI8G/',
'3qpEiK1cyVYtWvlK0AWpsSxtpEiG1cyVctavk6w69qbEs8udekmhHcf58bfBXqxvgbI5O8CxWWKsjrFv3wGjPK1Xh4Ie7RFF+XZgWZ5ZyLNX2t6xhHdY+aEI6bXc+cH5tEVL3Y28CvWylkdkuCZnWcizA8W/bGLydwlZsV9b1+MWp4z63b8Y8n4Wfc8Yx0n+fEV9Ustw',
'mDsxtkddZK2I4nnsxUYvRzDM1zExZ6WZbda8jEVhWHniasmvUZ1HxvfXO0izykDC/RsTUZEw1eSvUSU3w9YVl8vTBXAhfHc7wfst9yD4L/eqnUnbIPEVot0uosvWFWIsZRrnqZYA651iKgbIsvVDWZN6WO5b0sfOJtRel1E/qqGPlbUcTVZdLqLIDiG2EUzkBhxRa9j6',
'oa8Pei/Li6QLFbLVxVyYD3ZmEiir4cbNPE1ZNdqzqEb1j7bPzw9lruaOL40GxdRl0yope7xhFM5AYgUWvUKoa4fmdS92LpAPWy1cdcuAWZHIowYgbNPFVpNcqzqlTY2rur45zmbF1WVzFNGG9Yrv7/ZYnvsj2WK77IdlsHCRJBw7ux8Q0YKPtsO7WMaUZatikOxMmJhu',
'MOQZ4sArESYqvJrlOdWaxXY5nvMR2Oa7ryBHKFUMifmLgmNWxvfXO0hLTMc4lHdt3Q2cXI5K2fMzz/x73Z/tUL47neD9lvuQfBf71YODRp5i4YJcOUhqv+QfKsJ2Oe7pf4/8P+Qeib0sdy3pY+cHzKXuVKDDqZC/Ya1Tk86uW/2GCEzBy12ddFtnNCHvRflwfZZ/5v8A',
'H/cUkBQtZYxHxF4pTZkbTpN6x9tn54ewkdd9/wCMeoWZmU/f48GJmBlrs66LaOaAfmdS92E7LPfPgEUkBQs5UxHxN0pS5kbSpKPtv5CFVdRt6q5OMDJDYd3E9/kOyxHf5HssV32Q7LZhQswcjeeq58kY4FH22e4r2S15NlbSxl2VlZ0bcIRyhWNvmlYyA+LTWJ7HNd5i',
'OxzXd+RRx3NhHhtBJe3G98aHEF0NUas6sD1Q2Hf0nhpEnj6HJvn+1p4rma8W0xNhuIaLbmt90D4L/erBGZw38fG5KhV5QOQoc5PoapV+VBfx3OF6GsfT5OH+QelXFcxXRMNrKiYbWSGF0zUvcsYZjU7eJic4B8ENvFcxYoVuUDkKDXHlhd0Ye9SwuqVGtygchQ5yePo8',
'm9+pzY+iKnjOVPaDzAOiJvo1n54ew0tF0c4mH0ZuIp+9AoVpV7sIDtLH4/mY9FXRVRrcqG/Qa3KWG0xD8qfC73o1uVDfoc3OhS5NX6nNj6IqeM5U9oPMA6Im9C4fiE6IqwuADLNvyFTF8vYsD4wKeM5Y+R7LFd9kOyTNvlTBywL2P5onRVcr8qePtJh9ZOiLoioUOUnm',
'+zp43mQAxXCMSOuHRVUBy4M13mH7HNd35FPIEqi60ZdaMgFcJutGXWjLrZlPL2ZO2aOutGXWzK5kZ2x1coWsHrZl1sy62ZElxCQzJoxMRylUJyHKGZsRbrZl1sy62ZdbMutmXWzLrZldvTuKvlC1w9bMutmXWzLrRl1oy60ZP6oByV5tmj7utGXWjLrRl1oyfMmdmfc/',
'WjLrRl1sy60ZdaMutGXWjLrRl1oy60ZdaMpy1zbMmZiT4hK1w1ZDy55kUvcgSaQckGYrSr5E4I46yW1DJXHqQ60ZdaMpZg0mg+mXWjLrRl1oy60ZdaMutGXWjLrRl1oy60ZdaMutGXWjLrJlYsSOfrRl1oy60ZHypTCrHcBjZQphJn3P1gy6wZdZMrViVkrZgzLrJl1k',
'y6yZdZMrWQJZFVyJK4usmXWTLrJl1kytWJWS1siSuG1YlaIt/wBjhZBi+ZmCVfzMSStGmxK3VMvOvKp9tiJ141czIUieVjawpUYVwCfI5AYx7MdkeXYZwHjoEtAka2AEbtqVo37lGUopyTl4adZ7RreMesLosk7bn/K7/tdy3fjq1idYljImsD6xYT/V/wD43v8AK3//',
'ACV/27f5O9b/AP4JGEprhMy0DWga0DWga0jWka0jWka0jWka0jWka0jWka0jWka0jWka0jWka0jWka0jWga4TunZ28hhSWiC0jWka0jWka0jWka0jWka0jWka0jWka0jWka0jWka0jWka0jWka0jWka4bOpQlH8u/hbwaWGpklP7tiqcNzeCEXm7kYad3f7mBJQW5iN+',
'VfwtthujGTvJ/vBT0uSOiW0r6G+7Z3i890o/nLD/AMvPEOZZlFIJPIjQsyiSEhy2+4GwP0+5cU2EwpuLbXf+X5FvKD9SzffLZjInexarW+Tq1C2nsY6xXhUrTtEBjbJ42a5K08y38R4q3NrNI9ZrzN0jMszQrhlYLU4te/Sb/wAsHX1WQDWLx8bZDDCtvvYxm6g/qsdG',
'OuMGKxt5am0Hps/9fbWPWJO5WFDIlDT6YsMJtZJ8QmNDTdcrAuXg9ItqwPgnw4eLatEY1ivbrChepD513pRtzYNG4SNe3jq4BApXSjJsxY2mZ3u8Nnu8PKDaBtkX3SN9C/mgvuLL6S2YvfPH0q5oY7H1zDpYyueFfC1jBs2h37Bco0unZQBjRs1TXgZAJuXyUXhis18e',
'I/2EaxusA/31L/dXKlqVvDgsCLiqpxXsX/sH9VQKwzOexSc/9entB6bP/X2055ESzMIQu1/9GrX9TFrF/wCwFNo56vUNHL3ptO52eHWOpaRtM/UyVDdYOB7+VyDG4TFsPispqegsbtyW2Lb5GfeX83Yb+eyE5Dlz1pc9aXPWlz1pc9aRbBjM120ylbsyXO2kWwYzEKQq',
'xQxjc2QsSKxysXGRhGRshYkW1YKJ+etKBywntDdhwykkWe32g2B+vg5+0zSk8nYxGH6I5yWJKE5QlKcpTe7ZeCNYKfZG3YhEpymTXbTREYolK5ZlERyhRCzLJVjOAnMVFzFRWDyOTZX9/wCU3+Ldsj/Nnbc/3g4a3JLXLZ6Ira2+7Zt7z/hH8xu8EvXVErTHKH3cRfSc',
'97eCE3g7jaa9PuYDlNb4ib8vu8UvVQJKC4kXWoS1CWoS1CWoS1CWoS1CWoS1CWoS1CWoS1CWoS1CWoS1CWoS1CWoS1CWoS1CXF3J3eT+PjSWsa1CWoS1CWoS1CWoS1CWoS1CWoS1CWoS1CWoS1CWoS1CWoS1CWoS1CWoS4kWUiSl+X3eRL1/ct3lS9f3Dd5kvX9e3fYb',
'vOf1/YN3mbvO3rf+x7vJZvP3/sX/xAApEQACAgEDAwQCAwEBAAAAAAAAAQIREgMQIRMgMSIwMlBAQQRCUTNw/9oACAEDAQE/Afvr/wDUVFsUFHyVGZKDRi/uoad8sc1HwOTe2nPLgTd8kYKTZ0kdNWdJD0kR000RjcqOkrOkh6So6SOlEjpWdGJ0vVRqQUSOkmrFE6Z0',
'xqvwq/DX/MjrNeRST8bPUUCf8qcuDR8DimJVM1SHxI+DT+ZreDS+JP5H6HGNGn8RNqXBFty5JRT8i4Rpedn4Jl/SL4Gr/DT5iOMtNj1pNENKeo+DT/iRj8jSaVjwZ6Ux4syikac1R6UasrNJrEl8i40VpkJx8CwXJmnI1nZCSxIyo6o52T3v6KDTjRlXklCM1yL+HBSs',
'9MS29sY/ohG5clRafBFLFi8mKzOFI1MVxRSwsSSjZqRSHppkksxxVcLul2WJ+7f4kdX/AEX+otjaiS1G9uqxSadj1GyM3ElKzqsslLIy9NEdRpUSk5HUd2Oduzqvul3WJ+zZf4ybQ9V/kOPffdZf2CKKGu9S2sv7Jb0NFe7X4OJiUVuomJJciiLwh+RR4spDirFH/SuG',
'T87RQ1yivJgJcE/O9CiYjjW1FDj7SQo/kLxwZcGZmZCfIuP2ZGZFjkXzZSuxyS8GZmZmQ3fYu6ihx71Havzrfu0OLXnZexRQ1uo7V7ka/ZUSjFlFGLKKoxWNmKwvbFlFCXJqRS8GLKFVeCVN8GLKKKZCKa5KsoqjFjVbacU3yKozHTkjVik+OzFlVtFck0k+DFmI4sx2',
'r3ceLJrgXkfkt5US+RLyhtpmp5NQ/of02bpcE+UaZ/Yn5HdcE/BpjFNonzGyHERPKPJp+DT8n9xr1lvKjU+QoWrNLyV6yXzRqrknFY8Gp+if6JNp0avkjHIj8hr1FvKiXyIybZNc+/lxQptHUHKxNjnySsTkSVslKhztGXFCVslKjqGUv8M2jqHUOodTb4oc2jqHUFOj',
'TX7M+aRJuxN/sn8iPMaIRafI9QcrdnWOszrMlPIi5f4avk0mKDsk/VwJsc6Z1CTt99+5m9rZmxSaHzunRJ3tky+5TaG+zJ1RZkzN7XRk+/qSLLM2WZv2b7VySjXZEUbFG9kkNLfjwURjYkrHTEYx3jG9krZKNPaMciML9mUKMVVmHF70VslzQ4U6JxxL2jHIStklTEh0',
'iKyFG5USVOuyyLXgcaZM4Q0qK9JAiRGJJKx1RDyS8lek0yG00QViplWx4rg0yK5P7kqTtjSatGmQIxtipj7FFJWxtN8GoNLEivSLHwSjTHGIsZCVSJ/JE/kjW8kI5MeC4NIjKmXGR8WUpK0aXkj82T+XasSUkNxZkjKLG1QmkWiLrZSVUy0XFHpG1QmkJxPSTdkXRlEu',
'I3Eg0hOJcbG4syiJxRFpEZURr9bTXBGv2YxqzKPgdfocosyiZR8FwG4scosTihONmUSTTlZqSTfBptLyN6bIySbLgZQHKLkKUEKUEKSysk7ZXs5cV35Dd+2nQ3fbF0Of+bRk/Bb/AMJSv8ut67b2ssv8fJ/gV3V7dfYVtXv12vZfcvZbPZfcve+2iiiiiiiiitq2ey2o',
'aooxGiiijHZIa2f0CLRaLLRZ5ZZ+i17LfAxsTGxlotFj7H+XRW6+7bL3X3Nl9q+wT77L7q+3fevsv//EADgRAAICAQIDBgMGBQQDAAAAAAECABEDEiEEEzEQICIyQVEFMFAUIzNAYWIVNVKAkUJgcYGh4fD/2gAIAQIBAT8B/sPZgvWNkLbCAskXIGmpfrWTLRoRcbNu',
'YqBekIuZcencRgoG0ZyoE5zQZTU5zQZj6xspBjNS3BlNTnNBmJM5zTnNGzVOe053huYnLxsxDVGepzZzYDY+it+LCsrs06ouBBM/pAzAbQknHvMA6zJ5o/mmTyTB6zN5og8M9Yrtcy+eFVKbx1ULsYrMvSE2Zl6di9YnT6K/4kwfFN9OWK6uLE0zLmTELYzP8UZjWOZQ',
'SBBzB0njINwax0gRmMyYzdiU5mFCvWZlOqIPDNLAzVlmRG6w6yKnLYJMCkXcyIdXSOs5cCVFG30XKCGuZeDvfHMebLgbaP8AFXK0BvKy5295i4RU3bcwdIWb1mRiE2lspG8djrAh6QMeXc3KTDqbe4CeZUJZnoGYmJBuLlb1iFuXcDm9z9LqPg/pmTEH2cReCQGybiYy',
'dlG0TEF7OQIUBFQYQDcfEGNxU0icgStqiJonLGrVGwhjcTGFE5K1UGMBdMGAfTWUN1gwAH/azQN9ebtB/Pk0Lg4v9jf4g4j9pgy/oYH/AEl9hc3UD3URqXeHJGO5i9Iz0aE1G94rnT0hye0uyJj8vY5oQHY3L8sOQj0jHxTH5R2Focn6GNn/AGmfaf2H/Ex59ZrSR/z2',
'XL+iNu280UROXOUJojL4aEJv0gx7bzl+lx19oqVNNLQlmqqDGT5jOV+s5X6zlfrBjiihXcbvA/L1fntI6/NuKwbp2Hf5Abv6vmcScwT7nrA/FBxq8vrEypk8puHicK7FhFyKw1A7RMqZPKbjcRiU0zRMqOLUxMyP5TcTisp404r2i8VlPHcq9v8A12awJcLAdYx8NiYW',
'LDeFwICDGBBu4gIG8LgesuFgOsDA9JlyMG2hYDrNQq4GB6TmL7wG+zMxUWIbfHFtUNGYHLDft2PSFgIGB6djmlmJiRvNawN6wZFPaW+aX3qfDs55jB2mZ15bb+k4Z2ThchWDh8Z4Q5b8U4Bh9k/zOAYrhysJg4fHkwNkY7z4V+A0+EkB3uY/5iYn8y/+9uxVDMbmI01T',
'P0l+CYfKYoW6aYh4rmf0g6RsSk3MZ0vUy7uIw0OKmbzCZ/LL+6gNYpoGi5h8kbLTaZn8sv7qJ+EZw/lmJzqNmYepmI0GiKCpJmDpHyaY3lgNY5pGi5j3So+MAWJjY6fn6PFcz/DsWVtXQz+EL/UZh4PHgxspNgziMXDKt43nD/DhkxcxmqcBiwAMEa5nw8KASj/9TgMi',
'4eHLP6zguD+02SanD/DVw5NYaDglHEc+4xoXEx695yBNCe8GEH1nIE5AnIHvOQPfs87bwYgTU5A95yI2PUZnYdJyRVmKF0RggGxmLyTJ4clmZcgYUIMG0GOl0z7OPefZx7z7OImIJGXH6GcP0nED1jZFKzGPBvGC+hi4rFzkiKukV3qlfLYBhRi/D+HBvTKFVEw48flF',
'T+H8Pd6Zk4bFkUKw2Ex40xjSvawsVEXT2aFgFd5sIJuAUK7nLW7hFzSKqcpR2EA9YMajv8lIBUIucpfaFZy1HfqAd47CI+ruZASYX0gRn0iCMxB2isSd+wze9VS476YzGtolqekY0Nprf27XyaOxm0i4jahfY+TTHyaYD8jHk1wM2qqnM8envFqFxcupSZjfX25G0Rmo',
'XEbULjEgbRLI3jtoFw5KXVEbUL7rq3URX1KZi6QFmMRm1VCTzJmmToJk6CDpCzM1CITrozKfDE8ss8yZvSZfSekwkmZX0jaHUBdwtpS4odt7mf0mQ0sJ+6iaiKEDMrUZn9Jm6CZHIAAja19YO4zszaRFBA3mD1ik8yOayQjJV3Mb6liu/QQ603uM1pMf4ZmPyGcP0mR9',
'IuLzW3nEekdNSwq6CC3SBmRqMz+WP+EJi8g7rB7ioQDArjpOW9wI46QK2qzGVjCjmOpIEHSMhuxND3cKuYBkEVG1WYyuYUcyskxKV6x01CFHO00vVQDIJlUt0hXIZoeqgXIOkKOTcKZD1mRCQI+PUI+r1gmJvFvHutpryXU0PdxNX+qBMi9Joe7mh7uEZDAuQdIEcdIV',
'yN1hV9IAgTIBURCFImFSo3mZWbpAuUCpkRmAlZYVymBXVNoceQ9YUyN1jISgEQUtGX8nRvff5e8VdI+Wy6hUUUK7rrqgxb79j4x1mke8TGF+i12V+WIuaF+g39Qvsv8ALH8rcuXLly5cuX+cHeP1kdtdwmoGliahAwqaoDYuFpc1bXAbmV9C6onFNq8Xe1RWuXvNcDXL',
'3qat4HmuAzNxZR9AmDiy76G7B9AYWJpM0maTNJgUzos0mb3tKJgFTIgddJmPES3iFV/57wXe4BUUVCtwA+sAqaTe80maDUUUIdSZCdN3BqfIDpqvzty/7L//xABBEAABAwEEBwUFBwMEAgMBAAABAAIDERIhMTMQEyJBUXKSMmFxgaEEIEJSkSMwQFBggqI0YrEUc8Hw',
'kNEFJGOg/9oACAEBAAY/Av8A+BCzG2pVqbadw3Ky9tytR7bfX9cXK1NsjhvVmNtAts38FSRtkbiqtNQqt2X8VZc3HCm9VuHiVttu4j9Z3CjeJVwq75irTzQKzB1KrjU6Ng3cFQ7L+B0WHVJ30VRe1ydGONyyystZay04NZ2cVlrLXYX2jSEdW2tF2FQ4omNtV2EbLcDR',
'dj1XYXYVp7blWwuwux6rseqLXChCq1houwuwqPaQrTG3KtjRVjahdjTv+i3rf+i3ukFbOGizHtu9FWR1feYa7qFF8dCHJsda0RIwqB7vtHP7ha4KQcHaJOYp3Nok/wBw+49N8Pckc68N9wtPkm+JR0Hm0WeLlRlwC7S7S7S29oJzOH6Jl8Qnq739m9pxC7L6qzGLIQ8d',
'DQx9mhWerZlqFJzaD9o7HinW3E0O/RNz6JOYp3NokoSNop1STs6LnHBXuKb4Ky11krPRfra0UmiTaOKImk33VWYEPE6M30Vmtb9DeZO1l7W30QhLY7fCyo5XhojcCCKXVVmJsbjyqIRta031on+X6Jl8Qn6L1d7t+keOjbcB4rNZ9VRr2k13FSeOh3in+Oibn0ScxTub',
'Q/mKdy6P26G+Cq4gDvWYz6p4D2k+Kk0ScyJjpdxXw/VDxOjtD6q46G8ym5Ux4jcWVG1RQ+JRmfcX3+ATpN27wT/0TL4hPV+03iFd7l/ubWyPVDx0AOcRTgsxyzHKZnB+itt6LWVv46Jh/dXQXEGp71ZjFyqU53Ep3Lo/bob4KwTRZjlmOU0Va0poc+24VVlpJrxRQ8Sj',
'4aDzaG8y1jb+IWQ7qTHSN+zb8IKMUcZZXv3aH/omXxCf5aKt2XKkg8/d+Vq2Rfx0V71mLMWYsxTFzqWnVCzFmLM9EWQ1vxcg9mK26tKzFmeisRXN3njoJkNBRZitMNRTQ2r9yzFmLMRmiw/yryWnvWYsxGOLA4lBj3UNUdvQWyOoarMRpxuX2jDXiF2HrsPXYetiN1e9',
'X4n9Ey+ITmsFSrPZd8p0UKrEfJUeKFbIoOJVcXcToqVZ9nbX+44aQZiancNyxd9U9jcAVbeaNXxfVW2Gre9MY7AlB7K479DWHeUXstVCc59bjuTmNwQe8uqV8X1TLBN/FPt1u4KyytKVvRvo0YrF31RfETduOjF31WokTSyt53qwPNXl31T3tLqgcf0oQ5tWuVqN1Qts',
'X/MMVtfaR8RiFVp0XgHTYhbbcrXtLrX9owVBQAI+OjaeBUXglGwa+D05lapiO0czinqLxQ5tEfMneSfzJ3gE2hOKkpwV5JUiHKn+KO0cOK/Yh4q27AKOYYtUfiqvwIogXyN6kTHWtLr/ANK2o3EFWZ9k8dyuVuM6t/EKz7Q2n94wVQrLdp/AKvtBst+RqoxoAV5q7gFe',
'aN+UaWBxZWl9yJa5v7Qi/wCi1Ut3AqtplfBaqK/iUxzjQArakaU8MLLVLqBBwxBW24DiCtlw8GhOk4oHvT2tkBJGh+sdZqqxmooi1/ZKq5zD5IthNSdDmtfUkYLVzOpTApgjdavVZqWab1jH9EWwmppdT9L7Jq35SqVsu+UqjhUL7KRzGnFqpG3zVZHUVmLYb6/rmzNt',
't471ba8WVZ9nv/uKtPcSf/BLd+v7v0dC5jaF2N/uWZBUUKMRbsVNyexgoAfcGtrY3prGVMZIxVmMUFPdj1TaVURjbS1jf7p/1DS4bqKjWO1tcU7XtLvlomBjSJfiKika3adSp0XhRtdgXJkbW0aaXINjFBT9GN1vY3r4/VfH6r4vVfEviW9b/ecHgE0uqtTqW1rSiYGg',
'B2+igXs//dykldW02qmc5gJGB8lO3/uCHKU7xKl8dDWvw4ItbCAwYFNjc1oB4IcwWtc23KRcOCMM0bcFIH36vBCOw0NvUniovAqD3deGgvKmc4AUBF3govFO8AoPL/CllAvCdFMxuCY3g9R/t/ym8vvb1vW9b18S+JfF6r7Ps/oy0HWQzeu/C3ZRc+aQk+P/AKUYidWy',
'o2yyHZ4VTomyGy7HFGFr3WXYlOayR1HY1qrbJHV76oyl2xU3p72GoJUxIB8VUXFBslHhRSdlpvK1xkdb81bfI6vdVW2SOr31UkmLHlB0LnW+CdrXuD99EzVOrSqiEbq2cblHVPAFAv8A7BNnuWutPscarUaw2PNOY2Q0djWqD2yPqPFW3yOr3VTYnSGy3DFOiEhsuxxR',
'dHI6tKX1Ws1jrVa70yRjqtFL0HRmop+Eu/D3/lz2S3NfvRI9rbTQwNiDKev3FW3g4hWnezmu+5BzfZzXdcrbruA9wGVlpvBWoINpFzsTpDm4hD/UwbXELIKEcbLEY/M7/wA8fEAKPTA4AWeH59f+mQxgqSi91igxv/OrbLNO8oxbNoCuKtPs07vvy7WWaGmCbt2q9yLr',
'dmh4Ju3atd33TYrVmu9Pk11bIrSz7znyA1tUuKjhAdYcwnFOkjDrQ7/umR1paNKpztfgK9n74Sa2zXdZQZatXVwT5eNwTxrW6s4NWptWcb06TW1s7rP39i1ZurVOk1tabrPu3fkYj1YPmjNqxe2lKpsIjAJPFElou79FWRmi7A+qDpBQHvQAxK7I+uj7NhPeuwPqi9zR',
'Qd+jsD6og7k/mUXmn8yi89NYoyRxWV/IL7WMt0h7WChvF6Mb+0FH5qbkOj7ONzvALK/kFtwu/wA6KRyOaO4oPqbQwNtOjllceIJ0fZMLvBZX8gqSsLdFBisk+ZWVXwKo4EHgVDzKTlOgPY0WT3qxIKORbEKkK3I0Bvjoq2I077l2B1Ia0Urhf7rPEpvItV7O8jfStEXv',
'kcGj+9X8Cpf+7/do0VJ4Iu1RAHFXr7JhcuwPqi5zRQX4+7+0qTRVsZp33LsD6oGQUr3qkbS49yy/VbbCPyBodGK0xTwzsg3aIuZP5Si54q1n+VakKdYrdxTOZR8wRTWHDeqnZY1atlqveFL4aX8xT+ZReafzKLz0xeFUYn2qjuW5zHBPj3A3aIeQKXxUfmpuQqIPvaXX',
'q64BfGf2q3GblHZADiL9MnMdEmtJvwoFi4eLVuexyLPhxCiHfVOkdg0VVhlQ7vCdJTbZfVQ8yk5ToiR5Qn8qPME6Z4rZuahrTjgAi6OtxpeofP3WeJTeRfsKkQ5Spf8Au/Qx5dJVza4p8ba0HFN2G4cE4/LL/wAqibDxdetzWNCEbLVT3KXkPu/tKkRkcKhuHiqyHFGx',
'W7iovFWn4UXxdKqKOYVs9k3j8a4yNtNaFHqo2tJO5NcN4TjZJaTUELsn6KLZPa4J/KVKPBMLQSAb1LUHcmUHxKPZPaG5FeLSnhoqU2oOB3KXw0v2T2juT6/MovNP5lF56YeQKXZOPBQ1+VOo04Dcuw76KLkClo048FHVp37lNyFdl30QLhR47QVYaWHG/wDtQaLmsCdJ',
'YdTcKbl2XfTRJzHTcKqhr2ioqAnZ4JlWnfuU1PlUOye1wUvKVDzKTlOiJGjSdkbk+oI2eCPME4cHqJ4aS2lLlJUEbSh89BJFwanOEbbWFaaGeJTaNJ2OCvBGydykQ5Spaf8Ab12XfRQ8gUga0mp4IDuUhsOvfw0fucpWsxIUVWnHgpuQ6WhzGmg3hSWRQWl+0qRSD+5R',
'uaCQK1opagi8KKgJvXZd9F2XfRSA1xUXn+NJfKxrnOwLlEI3tdQHAqw8Wmf4V0oHjcs6PqWdH1J9JWdk/ErYv4hV1gHc65bD2u8CqvcG+JWdH1LOj6kHtxC2nWHcCqNkYTwBUvhpzmdSzo+pR2HtdjgU+29rdreVHYe12OB0NjZi4pkda2RSqoZoweZZ8XWFnxdYWfF1',
'hZ8XWFnxdYWfF1hZ8XWFnxdYWfF1hU1w8lnx9Sz4usLPi6ws+LrCkIwtHRrpxUHstV5ZGPos+LrCz4usLPi6ws+LrCz4usKQCaMmyfiURcaAOxKkAmj7J+LRErL5WNPAuWfF1hEMlY42hcHKtKsPaCqJmjmuVY3td4FQ+eiY9wTBxfoZ4lUfIxp73LPi6wpGslY48A5B',
'z3Boobys+PqCz4+pZ8fUFnx9Ss6zzpcs+PqWfH1BOew3h9QV9odW/vVGysJ4Bym5DojB+YaKr9pUitYg4hV1rRzXLYe13gVtva3xKzo+pZ0fUs6PqUVh7XY4H8kawfEaK57E6rqudwTIt+JTW8TRZw6dAIexax7gTS4BFu99yZI5zbBv7057sBeiferwapLO+73GP1wF',
'oV7KmZraat1MMUzbtWu77yGnyBPc5pocCrU3atfNRHx98uY5oANL0yMfCFI5uGARZas0FcFrNbavwomxNNK71mR+qsVqSakpsY+AX6NvsvuJ4Kw/DcQs+7lQY25rRvTnt7OA+8a4PZeK0KEsr2mmACfXF2yNAI3IPb5jgrUb7Fd1EXWrTjvQhHaN5TYxvVz2IgmrjimR',
'j4bz+UNkpWm5XwnqVI2Bvfii5xqSg4YhfB06NqH6FbEQHiVakdUprNUTZFK1VDc35R74qbiCFKKjjj7jWNsUaKdlSObYrIam5N1tnZ4D7zVS5e48FsysPmpC0gju+4c0xl1TXFFrBq2n66C6KlSKXhauSzTuC1gaHXUWQepUjaI+/eqnTRj9n5Sstio92z8o+9AdD9Ct',
'iH6lWpXV02o3Fp7ltNY70VG2WeCq43oSBtaLJPUqRtDO9VJqT+SbDHO8AqEUP32y0nwC2gR4+/lu6f1KyPiUxvs3s9vuG5GSdpaXbj7wawEk7gi50LwBvIQIheQe5EOFCN3uBrBUncFK6eGUA0vsqN8MEtmz8qLXChG73bUcT3DiAnQiGbWWcLCrJE5o4kaKRsLj3IW4',
'ntrdeFkSfT8ltRxOcOICpIwtPf8Ahr/coMVQih0/ZsLqcFV7HNHePwUNfmUuyOwd33AlaASOK/pP4lAyMDS26ibsjDgpucqPZHZG5Tc+iOR/Zab1LGwutObQXKNji6oaB2VI9uDnVHuRyP7LTepGMLrTm0FyjY4uq1oB2VI9uDnVCyZOlUK7I+ik5ihHITaqdydPU2DH',
'ZwViMmtquGh7pSaFu5RhhOzICbk4Auw+X3W+K7I+ifzHTNUbgmUA7XujZH0UvMUNkYcFLzH79nMF2R9EfFWJCa14Jjoq0A3hTVHBR0A7X3VGgk8AqmJ4HKmV4FS3Ds8FGprh2eHvjZH0UnMVr3YDsraaDIezpfrK39yaGE3HgrtDKgb1cPhCbUDEoU+X7mTWtrSlFdab',
'4FY2mHByh5lNyFBoxNyrPJfwauy4/uWw57POqFohzTgVLrm1pSl6a6JlCXUx0N8FN/uH/Kb4KbnKj5QpufRZZcBi7gtq0895WX6qMRNpUaA+VlXVO9NbEKAtrokMrakO4qLVNparW/QFJznRJzFMBwJCy/VHRaJsx8eKva4+Lll+qkjjFGiiDIxVxX2zi93dcE+QBzSM',
'L03x0P5ircrKm1TFRiJtKhT+A/5UTGCri9VncXHgLgrg5p4gqy68HB3HQFLzFN8FLzlCSYlrTgAuwepZfqj4/cBkYqSvtnF57rgnyAOaRhemcw0HxVuVlXWuKYIhQFqm8lEyMVcXr7dxc7gLgtkOaeIKsuvG48dGX6qT4ImuI8V2XH9yL/ZibvhOiPz/AMKblTPAqblU',
'fmpuXSGsFXHcqzSUPBqLmTYfMNAUvOU3V3WbiFae5y+zkcD3oskFCFJrG1oVdbafFUde04O0R+a/YE3xKHL9ydU8trwTGSuttcaX7lIw7woeZTchTXcDVNe3BwqnsdKRTCg3K37Q6pPZu3KOIfDeVN5JnPob4Kb/AHD/AJTfBTc7lHyhT8+i1vc4pscLrN1Si6VxcbZx',
'UXLoHMUzk0S8yg8ToCk5zok5io+YaD46Imj5VIyOQta00uUTnGpLcVL5f4T5d7jRNjiuc6+qsSSFze9N8dD+Yo85UXKp/Af8oySGgCpD9m31RimdauqCnO3sv0BS8xTfBFpwMtPVeCzSATgNDvH7h0u9xomxxXOcK1ViSQubWqj5hoPiv3FRcqm8kZJDQBfY/Zt9UYpn',
'Wrqgou3sNdAWrjAMnoFa1vlS5Mk+YKRowxUfn/hTcqZ4FTcqj81Ny6TN8TjTyQYxtXkVv3IxuDRXEjQFLzlF0TqVV7h0p7ZKWm31CZLvBojqnlteCbFM60HeikHAVGiPzX7Am+JQ5fuTJrbN9ME1+v7Jr2UVDzJ7K0tCi/qP4osMttu67BNMrA6zgtm5F7/aauOOyn/a',
'W7Xcmc6bLrrNd1lAcE+TX0tOrSygFNzuUfKFPz6HQ/E018k11uw4CmCMdu1tVrRNdrLNkcF/UfxQitWr8UH6yzQUwX9R/FObbtWjXBQeabLrqWt1nQ5+vxNezoc7X4mvZTXa/A17Og+OhlMWiyU6Rstm1iKJkda2RSqdLrrNrdZWrt2r64Jpt2S3uROv/im+OgnX4n5V',
'q7Vq+taJrtZZsjgn/aWrVNyDLdmhrgv6j+KEuttXYUT4q0tb1n/x0S8xTfBPdwkqg9t7XBWmzGla0s6HeOiO3ELVkVKkZGKNaaaC+SrWbqb1n/xWf/Fau3avrgmut2SLsETr8B8qj5hoz/4rV2rV9a0TXayzQUwT/tLVruTWW7NDXBZ/8VrNbauwonRVpa3rP/joc/X9',
'o17Kz/4pkVa2d6I40TZdbapusp8daWhSqEuttU3UU3Ko/NTcugDihHatIPt2SBTBZ/8AFau1aurVBOdrsTXsrP8A4rP/AIpztZaqKYL9wQk1tnuomSa6tk1pZTm8RRZ/8U2O1apvX7Am+JQ5fudWxjSK1vWVH6rKj9U2QCpbxWVH6rKj9VlR+q2bDfJZcayo/VZUfqgx',
'7GChrcmxNjYQOKyo/VZUfqsqP1Tnn4jVBuqjuFN6dIRQuNdAcwlrhvCo5rHd6yo/VZUfqsqP1WVGsuNZUfqsqP1TbbWizwTYmxsIbxWVH6rKj9VlR+qyo/VZUfqsqP102onUKvjjKyo/VZUfqsqP1WVH6ojVR+qqsqP1WVH6rLjWVH6rKj9VlR+qyo/VZUfqsqP1WVH6',
'rKj9U5x+I1WVH6pzz8RqvsnXfKU1mqZUmm/QfHQxwwLQpC4bLjUHRZDg5o3OTnyMDW7qb0wsAJcd6yo/VZUfqiNUy9B3BZUfqsqP1WVH6rKj9VlR+qyo/VZUfqsqP1WVH6rKj9VlR+qyo/VZUayo/Va5wAN1wWVH6rKj9VlR+qdGY2AOCEgAJHFOjMbKOFNAPBZbFlsW',
'WxaxwANNyy2eqy2LLYstiy2LVuY0CtbkI2saR3rLYstiymLLYtY4AGlLkI2saQOKtuABpS78HLriwYUtpmpdGTb+Gn3oEr4g6p7RCJtRavVY1FFSJ0RdaHZI/D0ldEHWj2iFHqSwil9n7tmsjY4m+8K0yJjTxonRxOtSG67dp1ctTHu7lsPY4Lss+i7LPotuRvgFbNzR',
'2R+s9lxHgVtPcfE+7qw6zdVawyNN4GCzm9Kp+utYylaUvVh4ZStbl2Y/p/4SNkVW1IwLOHSVnDpKzh0lZw6Ss4dJWcOkrOHSVnDpKzh0lZw6Ss4dJWcOkrOHSVnDpKzh0lZw6Ss4dJWcOkrOHSVnDpKzh0lZw6Ss4dJWcPotgtd4FUP3FTsj+5XytWcOkrOHSVnDpKzh',
'0lZw6Ss4dJWcOkrOHSVnDpKzh0lZw6Ss4dJWcOkrOHSVnDpKzh0lZw6Ss4dJWcOkrOHSVnDpKzh0lbMjCtoU/QFZLzuar8OA/F0kFoeqtNNWnf7tAqR3n5lUmv4m7DgVWPHe38+1jv2hVOP42hvacQqfT3NU39x/GVGK1jfMfntgYNu/ABkYq47kWP7Q4H7moiPmrL2l',
'p7/c72H00uf8o/EiSmyTQIyU2Qae5YODrvzxviie/Ta9nY1xAvtYJwkENhptXYo6oC7GpVtwBaN7SiyOlQK3q01oDf7t6sStoV7LQfCq2Q3mKrKzZ4heyr2Snyf+kImUtHitUwMMnZ2sFYfHG0taRRguR1IbbtupawUkYDdZU1pgi8tBaMbJQr8pXtV3H/OmSVwrqm2g',
'FG/2iaTWTdmzgFKJTWT2d3a4j3JB/bpPe73GRD/4+511VqQ/Vxnf8qld7O21ZutnRJ7RJ2IgnPpSpqo9a7WSyYM4J0AFGVwHgnex/wCmApUByfH8porbuzGLRT3gUBNya13sYe74ncV7OyIWBLiOCHsf+lFMLXepWSQ64fBUqSdkAicxMnfAZ5ZMG8EA32XUO39+hxID',
'rLagHigA2K3W81uRBbFbrca3JpADbTakDjpB707x/O2eKI79PtUcWaV7Sx8bg52AO9e1NdG5r3C7vXtLJmOAc24FOdLG5osb0XOikp8LRgF7KZcwXGvgvZtSwuo3con0McrbnNcovZYI3va29z+K9ma4UcMQvZOT/wBKLz/wtbq3avWE2lJ5r97/APlTPZE+hcaEKQTM',
'e2Mt3q0+JzW0N5Xtfn/nTR/YeLJRgBFB2ahCJ2bKbT/ckP8AbpPc73IotT9mOLdydY3ip8VPzaI4Pjlvdoh8f+E+u809EXlhsBxdaUzm4Fy//T2j/Gj/AFUrC/5IxvUM3tbSyrqCu5B4YbFq1aUjWHYbS05aiCB7PZmYmmKhd7H2hc6gqVA72gAT10T/AO0dMH+0NIHe',
'neP55a3Ov02o3Fp4hf1En1X9RJ9V/USfVf1En1X9RJ9VSWRzh3lUE8n1W1PJ9V/USfVUlkc8d5Q1jy6zhXch7XLM1obXZ3p7mTSNaTcKrWiR1v5l/rZ52ihNxxKe5k0jWk3Cqbqvbny1F/cv6iT6ovZI4OdiRv8Acbr47ckeWUXvNSfc73n00uZ8w9ymverTjUneUYw9',
'1g4t0WpnWiBTQHMJDhvCtucS7irBnfTx0N1rq2bhoDWzPAG6qGtkc+mFVZ176eKJikc2uNEWuneQe9fZSOb4K1I8uPfotAV3EHev6T+S/o/5K0RTcAN2m2cG3/nurP7VQ/jb7mjEqu7d7mtb+4cPxlBitWP3fn1JLnbnLaHn+LtPNlqssFGe7d9FWLoV/wCJuHmqR3u3',
'u/QGybuC2om+Syj1rKPWso9ayj1rKPWso9ayj1rKPWso9ayj1rKPWso9ayj1rKPWso9ayj1rKPWso9ayj1rKPWso9ayj1rKPWsr+S2GNb5KrjU/cbVHcyvi+hWUetZR61lHrWUetZR61lHrWUetZR61lHrWUetZR61lHrWUetZR61lHrWUetZR61lHrWUetZR61lHrWU',
'epbMTVebuH/kP//EAC0QAQACAAQEBgIDAQEBAQAAAAEAESExQVEQYfDxIDBxkaGxQIFQYMHR4XCA/9oACAEBAAE/If69X5tf1+v73X/6Vv8A+VolWJeX97sw5UoafaP+yrdGVaeksbOTk/vAUAVdCU1u3zShjlSz8sc2MEO7nvB5EySWpcpk+sPNXMxEX0cvEmJe9D+L',
'v+kOXDgL3nMjwJassBo3f5FrEzXhZ+eeTK5vmPTh6XCZQnQb3mjQ9hnfpzfvOb95z/vEBKq5GdZnWZ12VD1WBKhmZ12MyoNJKAAaWddhqvLGOvDOszqMZ1Tm3Cwwpec6jxgNbsiY6Jq4TqM6jLGnnMWnLdxIsBz4Oaw1dxAX7R3YVEmrX0OAdAnQJiYqepAJZif0nGC5',
'RymGkBLT1XRLlNhoeIjrJ+xG1QttqpnYDFiN2CPp4dD1rwG2RPaWns8Ovbzp+XBeB2ex9z4DwBYUcOfgG3GrWzOobz4rMz14U5MuAawmKteEyxfB76xXVGFssFh/SembRpW1l9zV9sRGnxMHcHWY0LZUaXHN1Z8P98LiWxd51bl8F1YLHfUyjkzBOejQEW3DP6/Dr286',
'flw5OYPOChm54VMBXAY1RhzZ8HMwYu50rinqzlsSq4tnBGhsMZT8T9CWm1HadVw2G5FHJNo8e11HKfLwWNFW7GUR3lJk6gt+iYBtuiVEAQNT4MGSOz+j9c2n0/vgbgmIYjwIsDhQrLh8f98ChDd1TtGXqI4WToeUyM+Q+51fLhn9fh1bedfy4dU34h9KGc+LnOzSqdmx',
'N4MAtPlnD5qHhRU2qJF1Hom/GwtknKOU+XnUc5kVosE6FtCwyrLFdSNHaPikyHBLjT+i9c2Z9P7mOD349YAtXwz3PeLYYzUf6gBlwHBm7Ex98vVMI8v3wv2O47WTtZM3XhX+uDXMN6R+Fa1haLYU3On04XLpbUWCFrxbhMlAWsrTUeIfShnPi5amLuydtJ2wgrzgXhdw',
'O0IytC1hCHII7fqufPTM9Z8hHJnysfDmRNSYeNnoi1KuGcPWBk+VYGc+rMh4EMRP6H1zafK+0Moj++MmYWOxyYN5cc0ZjL6zmwn3DPgNKyL/ADDb+zOX9mcj7M5H2ZV64oZk5H2ZyPsxLR7oBsGBMPaNhg+YF52JZOR9mCLxeijoS+ZnwWFCtzlfZjTBIvgAqUGFM5X2',
'Zy/szl/Zl5btrogV1wCct7Ma8nswxKYS4WSlHrSYbu1lUW2ZuC5S2wezMSzYoo/9d8CqpsM0umOFdtbDI8Tsjh/QeubS1c1RLUsc8F4UIEdGUXS58paUFo8POxEcIAWAGrPXp5SYEOd8H1XXkcA0QWkXLRt9FZs5k8S9tJmIoSUmouN8OK+BvKDGI1YM2ILlC1RM1AJc',
'taByZzZbum7XFbaVq0NNZJcWqoa0SQ1bYYgbsHObWcYWwLcTUj35RtDj1qtiCCy7xjECL8wZHkOz+gBbCLTMh0EtLPLAEygn/wCxK4n/ADhTYZlZxXcuXkfuErzTKSnmzYBPkOFYwsrEhYwudzUxEDMWfYhC9F6p9HgvwHD4qfJ+06LlOubQREVwHnGpSOo9Z8vDM36z',
'4zhZyAUwIxG+lcEd5BjH9NzcSfM/UyT3DtHUFGFVjYjEV0fMMjyUvOP5IT/DA+QUriNnmitIR1J8aSvqTCaaZiA2WOpKPLZTpuuGLPQWUESXJpxMEhBLa6lITlisw7ocBylpKDdM/d65tBRY505GFUFslxuBbjcyRkkF8ocVH54jsFWwNiAlkBlTowHCifAq4TqxLIdr',
'vmjHLJuxWE1WGBHRXeEJpQTmdNtCToS1NUhpFl8M34OlGB5hl5aDGn4oLAH8T6wDIggOiYRORMxnIlr/ACUUG+plax0NWW3qmqKra2/xZl5qGIn4ILAH8YKNjTKuz2D/ALMCWzVqvWWgW/V+o8U9X+NEQD5ztjh5oLAH8hf8ib4N5ebnHb5QLAH9hoFxOY4XDf5yDFHi',
'BYEz/seRwJywYmbgNZQvn5yGInALhv8A7Lkcc5/4olZ8BEA+dS/7PkeFDNHN3ErBvL8lQz/jqdn24ImYzXxJZvDwG8b1XUveEMTtMIQgcadn2jKZ2iUUlbmZArau5iacKdn24F5DbxWWUI1G8PDh83BuiaPqbqr/AOQa/JqYRYOVZdMq9ZwccJnlMwD1ISFmE5TPNLZ1',
'ZbLr1a8Dx5HjHNF9HHdl/iqGc2f4HWmLLtHZJ2Qdsnb9o7PtHZ947PtHbcdvgxlNVe8S/Z5KrduqfCfonS9ExJpSnDIlk6rDKBb7PzHWNp0XbiJyjjbaxrNUo0n6iGZxbXl6zpu0aAAH0byvSbFRIwVQd7gxTwVd4T4L6mToZT43+Hhxqvm+sXkAYo+HnWtp8n7JVws1',
'fInPWiTkknzw51vPwG6G+4b4N32hu+8wD/uG77Q3/aG+WLx7b8JOWDEzcBrKW5/hLUdkvgHJ/G391FOcxiuE5iB6FarDPl14JtMAr6BjXpMQrsRb6mMKeEzZNkX+QbTxMC/yYzzRR2mMIQYz9DIXow06GImkKFbTZjBtRkAygWqI4FMP1MmvrAP8mTXpgX+QFW5ln6y4',
'k2juvqKN9wW/5NDlbBJbQjUKwhgRLWn0gCyqgK0heE0wprPuPf8AJmC8xb3qbe/icq2mN27L/wDEbXcrI/yYfm4C31MUPsRbH9S6qZBf5EQ1uWv2maYWjoym3Vuk8nI8pLzn/mjhnwQgHz3bFvPgC5cEFZfxuDQD0QJqgGH/AHghJzp5BoRgF1mPLWiLlH42p9ylgKoN',
'DwKGrbmwUMq3CMtb28X/AKexlZWEhR/xnKUG/wCHkPMBmjmWPHdg3l5bXKKufAxy4IAy/j78x5e61zMKh540fwDIecPqi8A1lNyX40kU8VdkDJ/WFx5YJgYGx4a5IXI+eblgxHNwEQXwCRTxVzwgZPyATWqQRZxHoqFmsaxefy3Bj/2WTqdlTaKKxz1MbKryt4Dkua6/',
'kb+fEgKXkcKJawB12QTCirbr5XpQBdTMVdTXX787UOJmf7NYfGwSpNe6KzmJz8ysPaMquMVLym3e0Lx9eDxczxIOSXL4X4eexgXPihn+8L4NOc/8Uyz4bsrFvFOQg/lBZRVtpnBYsCQuQaiqqFuGXL0a1cD5naMKGiirRc1FEq/5eGRv7PeH/gYCodrXh2jGz0qZ0vIn',
'wo6LlM/Xpx0UdoPeYN09P/SZCW6Ye/FtA8jlClrNLuddy4891jAiy8Hr/wBIXYTcKfHC+8N1RjLBYqpWEowxqwLODLg2aMCZz2f+k/fDGDwCQKmgNYJYHoEItY5DF53mFJPhZ17aGRGHslSRwYAaG4LEFttReYIWF4FLNrT7TtKYP9lbw9A3nxn2ywuxqqmfGhxRBVas',
'z4R9PA1uQazJGK4XkRaoJ/7JlwbmXvBzK9TBOhthyl+DL6Mp9L7lz1Q7/pOyYCsOirTVcFCY0+8zK+3rDwL6IXM/lv5glMGGdSSzw+KnVNpV0Bg66JboC0AYsTBOuk63lOobzL+09c30kU1A0MiFwsFGjgJk9YaTpm86XkT4UdFymfr0413V+aV667S5Exns5JX+OKct',
'OHQNp8F9E6rlw4DEBA6wKQAZBK6PMIsmb1iVjEBQLDPhkek6tvwPQXEWXKw81BMZVeoyi1cy7Tld8UspxioQZhgVXAYKacmpPgZ1baGRPjP3wr1fOdN3g4QqHfeOaXlFrCkJcp4JfDrG8+E+2dZ6T6P3wB8A+nAL4CoanpFxT0OaPdyOnaADgWYQTrJKj5ZgcgZwMIWr',
'0JsnVaE6ptxvhk9WU+IfcP1kzAJxagC1jyTrpPlfqJnRsaLiWrPrFifbWUC1Po8piQjPF/LCRkrlbLEG4jYjL2Akv1uFec76gGRKap1TaBvLXxEuiwF1KSGGYqXAPKcoa71RvMv7QCjsIh7AaNaYFBGotuAmT1miYa9Ubyoic5yJ8aOm5TP16ccdHQRbilMRbEKEEd0c',
'WmknSdww0Lg/4RzSUxFsRTCbkaQKIW5BA2w0yby3DBoVjvLXm9Z/b1mpAjFYOS7hHcsyPSdW345geguUsRVQkQMcXVtYjlKxKNIEQVtgRKRNStmCyeonx86vtDInxH7iGFopnqfmms6rvFEzS/aEyCSLpnrHErQ4gjBXnCMUgBvPh1jeUkVMk6ssg2sjafT++GCiCtGB',
'6J3bChOD/jFYwhSnK8EYI2OfeGULE1D7hFXhQ1iwMtmto6bpqFBi1vhH0WDBYsAWAD1mV1ZT6n3AdQD6lcklF1dTmAAVM4g5F6Tv2d+wlIK0Jygxef8Aj827BZAIGBA4KFuqWJaNZwffIJdoztWDS1oAbQkNKreJWzdcQS2wzOpqDhzhdU7VlpsbYvtPZC1Wtk+8uPWh',
'XhOR6wyIioimZSdozCWC2NUFlHAEaRnDGLGrLgDF1CY6c4axsOaJ8rjjjjjjhjgk1XWye8AWfvPgYYYJAKoTXHgG/UQ82CTQlp4jDDDDCa4QBxwgjAFSgj4akAccIZE+A/c1GrSHgxlZqJc4tswv+pB/ISt8wdAjSk1MvADe0fcc0GJ7PDrG8wb1dEPBhiNqgLnM7hZo',
'4Ddp8BkcfhxD718oLj8PgNiEAD1hIPUMj6MKv+QFZ1/bhoKQ+YtCxkWa3Mjqyn0PuUaZLfJTXIK0KWpzqalEkOWFc7Pnbs7VmDUNqmsvOMyx/GU+nEbS3iz9zD1nHIRVTYfS2mMNVWiA9D34WYxF02SjuohvFjUPuDmKqaiP1Q2l2ZrfiC9rpExU0tyXwYJY00fMAgzX',
'/wBouIcbZVeYlof8JZBqwsKlx0uK0vSAAMhV47lWmOIVZRe8YKy3b1FCOfYopYoDJzh8FfFphLGCHTaCiw4jC42t2fs8GmUvoGK8R4oy5kpqfN9zdAZfLP8AYYh4B8go6rEYRyB+5gasGje5UbPSsjkl/uUcpstdj9S0A1WKogUxQ5JEJpdXtLWLOdytFtoyirW25F/g',
'c4ZmH47GF47QpzHKFXNJtEwYpXWPnQsuK9X+x0tXTdQNxNdGN7pdJ9UuOOYZlabZ/p4wphiyII6AMGj4MgjF/wDqaoYOv3nNQrC8wcRbYGf/AJl8mE4CsVy8jOIOKQc+AabX74ZzUMaK8TRyXD9xCaWotQrxt9ERmHdcJRFXFXjizbGycx72wHB+hPEPj0YSprwQ73zG',
'0aGh6cKuGd+Yp3PcYwIO5tlkQrNXOMWO2Cwrxu5CIrZ6mMXItXXzgh+Q4BDD8Itw7O9iJQZiedcYDniSqLTZXjox+R/Ij5acU5iBk84c0dyw4BKry7NzyFEFrGtDVjHA4aII8n7ArCWbnvws3PfjkoWDFhQutwJDrxYmeL0VStPAoHLBiwx9YGEq8/eXfRmc94xcCqVm',
'cbNz34FOYIJjwLvVWcI5S4LHg0Fi0NwNAKmo7RAqAeLZue/hvn4bNz34Wbnv+DZucMVC1iIEViwNS5Zv4Rg+K5ZucLNzhXgQjlLNzghAqaA1jFwZjxv9yUuocWGho4IM5pjUu8bn7IV5VSobIWf8QrnojbyBtAlZMYMWOI2nar3nLi0TAB0rFt+sbQUIUW4O4lihyYqE',
'iybMLHNUs/uWbeBTEsUOUT6RZPryVAJfvcsneMpoERxGU31p1beDJhML6xKYNOe7hp2rFXgHBQKXrF92zVwJcxKCNPB8J9wr/wA06Bvxped09ZV65Tl4Mj1nJyaJh6vFnI60ToW/n9E3jW/SnyErG3uF4wiSOBrMNzznrKuXKcvGRfAO9ZBbHxhmqwhAAdB9I5hMCCQT',
'HP0gmCb8WcTgwVvOSGOpby0HR9WrEbLFanPileMNVaWx1rdNOEu84gqdxzmEA2j1iep1DnAKAw5HkVD3C8yooq+9v3C62eAfDOm5TpW0NW0Ac2ChfTzYNjzioFjH6PmIC3Q/8gxgegqYr7TZwp4fD/XAr4Sdd3Z1LafPcGrGIbKBnrlP1Of98qBXXG9eFyQK7Gsx/wDo',
'u8b4YcejEaTPDsw8PjTpW8yJ07eBkIn3jTn98wkaLwuq+1u9ELxHdJzfvmXQIvkT6w4hV1oKiBUHJe3TOfAfcMp1DeNcR7WMJWmuuN68Mlj1QHpAe67RKD1o4y0+aKMj1nwCdD3Z8BOubxQcLzSc4Zn+qnO++GjMheR9YdQa7FVEMsOAzumc6NvMjPkJmcAuxLv8Ljes',
'6/7iTcID0h91EtErugrP3MxbiejgsNst8dlRR1o6QbHnFS0BxLXfozmnxPsnzM65twTpOU+X4pXygnoExdfuZKpble8Mz1nxSdJOMpNgcuzHehQDgRD2hnOBwT9gYMU0i71gv9wsmntf/YE6jnOs9Z13efH+MOFy19um2OxjzQCs2uTpOu5TpW0QnMh+o4d1EsjzIA6G',
'Dbxu1GEatDy7ynwf9T4/6eHw/wBcCvhJ17dnUtp85woMxRfTCVrbcDFlZll7KJ8t98Om7zqufD4f6nWeXD406VvMidO3nSt45M+S4CbhV/biysI4Q1IRVrOq5IxDKnYIW2lbaTErl1TOfAfcMp1DedQ5T5r74JEwHisQrsuamJktRiVEIYgX4mR6z4BOh7s+AgauT0Yo',
'iGAyic7IgBfD5T78jnMrkSyeKK5HKaIYGs51LeZGfIcO+d+51/3DYDzj0WzWKmuo0YlRFGAHvXD4E9Ea+2a1/R8Jh/VLWzCVpNP2XPj/AGT5GdE24J0nKfL8XUZA7CGOxBkEuCDmTaGZPiE6RvLkQU2WM/42jdoAAqyOEZn6MOA+J3TIA8UxUNDP9kcOk5zpPWdd3nxf',
'hCHHTBdcczqU01/M+BOu5TV0bbXOjvmMkbGG0QGK09ZQIyirDDAjmk2u+XXQ7aqfH/TNyTqVTW8xhulTUotrbe85GFTq27OpbT5zg/UEg3UvL3IEmpispt/yatYa7nR3zTyTgrOco9Y50d85hIwVPnf5mmSvMr5gUBMgF9PV6wwJkmupz/uZ0Kqd8cmfJcLdFYdkiBM7',
'E4zSQcDObHjUqit4qKnCcFSw8yXismzEvrc+B+4ZTKfY13y9z7yGc1SQrHct+TGmqv8A7OZysVzq75ppIyc/3NBNWC6mBvr94KDadL3Z8BGBzf2MW3ECJ0I0Lg+U++Cm9MGDdTAFILvheehWst/Sev19Z198RHTcOCYanxYrJnmsetzrG8cpaOt65zmeZDOcv+Y7xnpr',
'2VU5kexXOnvlRlEZOf7mk20XWM6e+CgbTIZbTunT3zTTVgq5jZVDN6LoZnrPTFC6mg0TJz/fBOk5T5fhjRVgjo4St1WcIrHDNc6O+cgjAqfEJlXvpov9zp750985f+w1jMU2qIpmz54AfMxFq60MHX9zck5KnWes6bvPi+N1FvwqkZ2bO+QqV8kEuRYZJ3yO+R3SDjR2',
'L37wQC3PGd8jvsFscW2WFlxTeLc75HdI7pDhAUQaXAdQQxgnVkDLhlFwSWUe4T6ndI7pHeY7izuTO6R3SADiuseNwyAYKbndI7pHdI75HfI7pCtO7fCyfW2fUhQIb4k75HfI75HfIdmIVnFBsbndI75Hcmd4jvkd8jvkd8jvkd8jvkMCpRBzggMA3hAAKIIy5vPEIenF',
'g4Hbmq4ZzoHtFj2dKjLNyHstRZQ4eQdvVnKOPKek7hHcIUtIrNilFrEvlO4R3CO6R3CO4R3CO4R3CO4R3CO4R3CO4M7xH62SMJ3CO4R3CKDQFFuWbhwyQjSwReHOxc72zvbO5swD0K5IAGXzjubO5s7mzubMNLLWgt4raZ3Nnc2dxZ3NmEmlIdPC2m8YZPsDgdn4OK3m',
'IDfeF2fw01Tt5uQKlY+ZoPhqFzTjFcr9fjvcmK5WG8r/AM8UdeXltNiqp1nLawjDbDxLDjwqs4jP/wAywbIv/J2VOyJZgbNa/qMgyGyfkjUG/wAO/JuovAfJT+R+VsIVQ+yvhoQV7JcpqcIb2YdxWGxr8wd/wFqXfkvhDBvyKieGuJX8bU13YEqNUYG0wa+RFY7t/m5Q',
'fMyi+Ssu/IHyalQJXiTb+mkD5Ls8pfMH8FPxa/mR38S/kjBv8Af04ag3wWot/mG7yFriD4H+oW/n3UHwuHhHwOczp5pqA2u/yGGGGOOMOOOMMMMMMMMMMMMMLMv2sla/daIUI7PkLKDcVSj6Qv4+GGGGGCCCCCCCCCCCCCCCCGoDa6mcvN/Jj5oiCt6WYMqGWEH5boc9',
'uT0ZRaDf9eH3au0yJ1GfUdtLd/JwRWs8YZeFR6T+SM/MCsrppNWKXtZv5tsOTla3szW5xBUDNg657zt+YZehkwjKra2n+WSuJjxMWjOUHIfdr+AjXKCFEamJ5NWgcrAxeY6eBda6D9uOa7x66RVbc/yEnjyc4E8OTz8FjyH3aRwaf5ZRKPAaccwk8fRjcrlQtTW83+w9',
'ym1Gce5+rFRcTYXqbRiVX6TFqCxGxIZQW6T0lpndKWYElqushEAt1rlKiBbyIzLTVsIHW+50KXujFIKqcC9aYqjiqG9TFbIrKhDAmpHChA0xmevAgYWjfSX2/hcRhOw1+Axbpvtxy5Sex4AY3mr+8v8AZRVQtY4iUnaKxWzHhRIs579phMtUCgl5NCU4euNDHd2S0p56',
'DuTFO77QaXXG+kM9goKw0hGoUjj+k1MmHu+JblSP0oAsapVWsSY+Ca5f9jIQyskoLFvoOCuR8lihyFgMHpLHKGAwekViHkvFymDDT/m1yg8mRxGShgDS4TmTC2CYOYVNk5gWFaYmtUEa2Q8IuwOUrqnOXSo5ZvoyyhMzdAPOacmjNF3YRNMGfMx1nNB26QMKqfD+hOu5',
'QpPvwJlBx5VvvBVYtGE+NPM9eH1X3cb4TFbg6kuiv00eDBs2e/HPlL7ngZHGU8xvALSDzT5T7OGC8G/X1Rw+b+0udVw9aQ3wloRuvuJlbaYZmSfvoffDKK4ltW7K8ypwAyr5imlnbCoYkpbH/sLVjiaOryjKK9eUdE1+i3rquKW7st3feZuM5xAlz/kg15FwW7JhDk+7',
'Xjz4a0+JKUpSBLmwupgAEGRItIJrhAljYXQYjirriiDK7iwqMzKnkNIkAedsWZ/LWxN/mJwKnkIEnWIattwTmaEmPgB+Sr6yw47fAH7x+nH4d9dJ68SkVesToxylrA6socGCoTMh3CIarDhkNUzCPlFtbjcbIMpOAg0zk5cDh9QMBPUAG6lJ4CoVQc55wEFUjml/jOds',
'5zsu74U7FHJhw7lv3FSwDQhxFLIfdpFttz/k78S7yhv4Id6btu+37iMFJmfm3isxtS9BQwGxxFQmCZQ9Bf2PzGILWRKm9t2jfb9fy9zFhvmWXgMSA/2+sZ0HIYj+W76lub6EMKlpq83w3CiOCskmL+OqcT03iKoU7P5LOkZrAJjBf+n0/mDfArLxgVeqYk1hd7E78nfk',
'78nfk78nfk78nfk78nfk78nfk78nfk7sndk7snfk78ndk7sndk7slWXvbL+4yz8y8DcfGNYkEKI8l/Mtyf2k7sndk7sndk7sndk7sndk7sndk7ondE7ondE7sndE7ondE7ondk7snds0Bd22F1ywwP5c3wKy/vQb4AZf3oN8AP7UO38AvnAD+2yDnGuXmD1gB5qCKf7G',
'hiV5FkAPNWiKf7F//9oADAMBAAIAAwAAABChToP0SKij5dUGmtZYSrpwSCrjSabhoqMsAYMMIAJHPDHHCPtLWs3B2NmABHG0kIBSof1wKijpddGmB5ZSKrxQCqpVZWmu/NMT5/35z73z/wB6iiBzxnTzn5eyO79Z19AcCX94CqooXXBpo2WUQqmUoo/VRLv3ZnKAzzw2',
'/wD/ALz+vORT+aMFPCZi7I5IpYEEBQJf2gKr1VVGuiRQoqzRAudVmmfdqxCRrGU8wJPHT8INDbjEDX/z6Cp6par4C8EBQpf3wJZdGmm9ZAiyZaoEV+6dsqxgSAxPO4hLHG47a845NPAIEMDLRqY7I6hzr0hSpP1QJYuvdVlqaZIjgBrQVmjFK2nYRgXT7BHIeVj0xxbH',
'PHCDPG8jK47Iz3mU+hT4P1QoL1su6bAiyZJB583ifWoo9X9N92Z93xi41Fjc9RznPT60tGU0133GViQ6wDwpe2QJa1Fm6bKiSTuuuJmng4yOlxOFKApxdq10r0qSwFIMHLD43000nLQ5LM/+hK4P3ioL0lFiyZo6JCqqS4odoXINA4o2wlCM3fz7kMLLPTx+4JLLLLLK',
'88//AD939AUqT9cKS9B1KkYckaGst+ly/IyfpV7i9Tyn8C8gGNYUNOCxzixzzzzx99NNCwT/ALANClbZAlrQdyspqnp/3OZnol+wzeIHOAl/6QAgqAwrO98MMMMB+cPLDDzTHMCk/wCwDQrW2QLK0nU4JKzkXkTgTjE32I76oAz+MMAz6ckz92tzjDDDDEMoYDU00/8A',
'sCT/ALANis/eCkvTUbigtbW4zuhnsw/eMDjvuQQ09vGZzjMkFQe888884s89zzz/AJHwhP8AsAwOT18KC2qQwhPY14fWtlKypTJ5xEIFlEevY4KKc1zisE7yyyyyyOODqODT8MT39IQgPxtMKSzhVwuKcDnvv4kTy2kG8ZBhMtJXcozwEMMdZOf5wwAAJfhyA9LD0sCT',
'Dzxke3JJMAeiXldC++3hRfjW6+49tH7Dz+V0JFWvX++6wWoc94Nt6yzzAlLDT4gEPizwiAb34zJLBz1dYmRyHKVgg7f2E6DK6RvtimoBSYPT1NHCCftNNNNsAQ1LfzP8etUl+rq84d31RN9e5gfwi2tusSGLxNZwPvLJgE/pRd3gfF1+yyyyyzT2MAwD50qRyuCttMl6',
'xmjDH0l2AexisOZBjC+RUmhC6netoaJE1vfQgLFxwxx+ClPDe68owjS3DLoPZRkfHeghirhUqSrlzD9rICSRgUNnb2JJ06BdNt+hQaCCJ0kAGMtWBl363zjFyipC9CZ0nKrTAKe03okyt3ok4KQfryR57kfxozbcgOzNgy5ZXFN204X9vx4gDppOBAxRPi2Ya6c6XXn7',
'58jpI7RJLzJspbPNBxdQSAMe8B4Qty6xyzDQta3QmsABVlDMX/UrC+n6PNQ/K56pxnI6PI8hoJsMNehQhqgy9k74QxaAbtGlPP8A3AzJX6MhegoEm/GXcT+MMMMMcM7T559rV3OGhG5yAMPm5zz1Ytx/6926Fre7zbFPvhIzONCwQQMRawzmAAPfNb/28zGLJLDML/GD',
'wJPMMAAIAGPMPjTDDDAegNCMPfXGolrSHIQ/7zgwXaw1/LMIAUzy33wBDADAAFP4www5z3fXvv8A332woCxz7z3/AP8AfffbTAoENvExv9zwvvbTUc8ojjjvvdb7708QQ09/rjjijhDjzywwwwwzzjjDDDPfffffffTJy/jHrFPzzywggggwgssBSjHrzPTSRTTSwwwQ',
'Rhywwwwwwwwxzzzzz/fffffffffdPTXHykNfcXLy3hAohuwhT68tdO/fv++YVbmvB8ccccccccccIAQAPffffffffbSwEMKlaEYFDRg3hDzXqw1UgQwAgiiwkNxUqVcpc88888888888888/fffffffffbbwLA7dvvvvjjjwwccce0dbPjzzzwwwgggggl+cMccccccc',
'cMMMMMPfffffffffffMwgvPfffffffPDDAgstohLffccccRTTTDDrjjjjgggghjjjjjjj/ffffffffdMwgggvffffffffffffffbTTXCgstsssrjDDDDDTTTTTTTTTTTDDDDNNPffffcAwggggivPffffffffffffffffffffffffbTTTTDjjjjjjjjjjjjjjzTQnnff',
'fQggggggoPXffffffffffffffffffffffffffffffffffffffffffffffff/xAAmEQEBAQACAQQDAQEAAwEAAAABABEhMRAgQVFhMEBQcYGhweHw/9oACAEDAQE/EP5y5L6c9Kejf5xZfSH4Esz+evpCz8afzFl9Ofmf1WcI7ag48Kian6T6M/Qf1MHsRWRnmFHSTkmo',
'HHgD75MA+PFxCFi2SINvvip2M77oNbfZBNHiyc94KrV+bXx/5/8AloNz/wA//IF/FcP+GcznE6vHObzcA4LumtYBCaZk1C3Xf+yXCW8pOiwcMZI3XLXlcc5x4MDA6hv/AO/M9PE77P8AkfOEf4fPMD0tzXhsJcQRm8m5BBNcuIku9J4plYYW0yFge0LCzFJbYW/ygDq0',
'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'
].join('');
const IMG_ORG_B64 = [
'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'
].join('');
const IMG_BAND_STD_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAlgAAAAsCAIAAAA2KFF1AAABBUlEQVR42u3XsQ2AMAADQRIhUTBEatZhb0QFNUPQhzmC70Zw83JZ2j4BQKpqAgCEEABCzSYAYDjndQghALn18ggBiK6XEAIQXS8hBFAvhBBAvRBCAPVCCAH1AiEE1AuEEFAvEEJQL0AIQb0AIQT1gn/b1kcIQb0gtGEeIeoFRDdMCFEvILphQoh6gYYhhOqlXqBhCKF6AQKGEKoXoGEIoXqBhsEPQqheoGEwXgjVCzQMhlPut1kBNAw8QkDDQAgBDQMhBA0DhBA0DBBC0DBACEHDACFEwwCEEAEDEEI0DEAINQwAIdQwAIRQwwAQQg0DYOQQahgAsUrv3QoAxKomAEAIASDUBztxWi0uzJAOAAAAAElFTkSuQmCC';
const IMG_BAND_VIP_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAlgAAAAsCAIAAAA2KFF1AAABA0lEQVR42u3XQQ2AMBREQdqQ4IBwQwgu8IYEjGGk6PjdGQl7edm2nfcCAKm6CQAQQgAItZoAgHK+9xBCAHLr5RECEF0vIQQgul5CCKBeCCGAeiGEAOqFEALqBUIIqBcIIaBeIISgXoAQgnoBQgjqBXPbr0cIQb0gtGEeIeoFRDdMCFEvILphQoh6gYYhhOqlXqBhCKF6AQKGEKoXoGEIoXqBhsEEIVQv0DCoF0L1Ag2DeiFUL9Aw8AgBDQMhBDQMhBA0DBBC0DBACEHDACEEDQOEEA0DEEIEDEAI0TAAIdQwAIRQwwAQQg0DQAg1DIDiIdQwAGK1MYYVAIjVTQCAEAJAqB85DkJcxeTjJgAAAABJRU5ErkJggg==';
const IMG_BAND_GRP_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAlgAAAAsCAIAAAA2KFF1AAABB0lEQVR42u3XMQ2AMABEUdqQIKAbC56YkIQGDKCMDQ9FR7n3JNzyc2XZ9gkAUlUTACCEABBqNgEAw2nnJYQA5NbLIwQgul5CCEB0vYQQQL0QQgD1QggB1AshBNQLhBBQLxBCQL1ACEG9ACEE9QKEENQL/u05mhCCekFowzxC1AuIbpgQol5AdMOEEPUCDUMI1Uu9QMMQQvUCBAwhVC9AwxBC9QINgx+EUL1Aw2C8EKoXaBgMp6z3awXQMPAIAQ0DIQQ0DIQQNAwQQtAwQAhBwwAhBA0DhBANAxBCBAxACNEwACHUMACEUMMAEEINA0AINQyAkUOoYQDEKr13KwAQq5oAACEEgFAfKRtDpdtwpLsAAAAASUVORK5CYII=';
