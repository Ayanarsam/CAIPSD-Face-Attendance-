/**
 * CAIPSD Attendance: attendance reminders (Google Apps Script, standalone project).
 *
 * What it does
 *  - People turn on reminders in the app on their own phone (they type their name once).
 *  - The office device tells this script who has checked in today.
 *  - Every weekday at REMIND_AT, everyone with reminders on who hasn't checked in gets a phone notification.
 *
 * Setup (once): see SETUP STEPS at the bottom of this file.
 * Nothing here needs editing except REMIND_AT / TIMEZONE if you want a different time.
 */

const REMIND_AT = { hour: 9, minute: 30 };     // weekdays, in TIMEZONE
const TIMEZONE = 'Asia/Karachi';
const SITE = 'https://ayanarsam.github.io/CAIPSD-Face-Attendance-/';
const PUSH_HOSTS = ['fcm.googleapis.com', 'push.services.mozilla.com', 'web.push.apple.com', 'notify.windows.com'];

/* ======================= web endpoints ======================= */

function doGet() { return out_('OK'); }   // never returns any data

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents || e.postData.contents.length > 5000) return out_('rejected');
    const b = JSON.parse(e.postData.contents);
    const props = PropertiesService.getScriptProperties();
    if (!b || b.token !== props.getProperty('SYNC_TOKEN')) return out_('rejected');
    if (!rateOk_()) return out_('busy');
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(15000)) return out_('busy');
    try {
      if (b.type === 'subscribe') return out_(subscribe_(b));
      if (b.type === 'unsubscribe') return out_(unsubscribe_(b));
      if (b.type === 'present') return out_(present_(b));
      return out_('rejected');
    } finally { lock.releaseLock(); }
  } catch (err) { console.error(err); return out_('error'); }
}

function subscribe_(b) {
  const name = cleanName_(b.name), endpoint = String(b.endpoint || '');
  if (!name || !validEndpoint_(endpoint)) return 'rejected';
  const sh = sheet_('Subscribers', ['Name', 'Endpoint', 'Added', 'Last reminded']);
  const row = findRow_(sh, 2, endpoint);
  if (row) sh.getRange(row, 1).setValue(safe_(name));
  else sh.appendRow([safe_(name), endpoint, new Date(), '']);
  return 'subscribed';
}

function unsubscribe_(b) {
  const sh = sheet_('Subscribers', ['Name', 'Endpoint', 'Added', 'Last reminded']);
  const row = findRow_(sh, 2, String(b.endpoint || ''));
  if (row) sh.deleteRow(row);
  return 'unsubscribed';
}

function present_(b) {
  const name = cleanName_(b.name), date = String(b.date || '');
  if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return 'rejected';
  const today = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd');
  if (date !== today) return 'ignored';   // only today's check-ins matter for today's reminder
  const sh = sheet_('Present', ['Date', 'Name', 'Received']);
  sh.appendRow([date, safe_(name), new Date()]);
  return 'saved';
}

/* ======================= daily reminder ======================= */

function remind() {
  const now = new Date(), day = Number(Utilities.formatDate(now, TIMEZONE, 'u'));   // 1 = Monday … 7 = Sunday
  if (day > 5) return;
  const today = Utilities.formatDate(now, TIMEZONE, 'yyyy-MM-dd');
  const present = new Set();
  const ps = sheet_('Present', ['Date', 'Name', 'Received']), pv = ps.getDataRange().getValues();
  for (let i = 1; i < pv.length; i++) if (String(pv[i][0]) === today || formatCell_(pv[i][0]) === today) present.add(key_(pv[i][1]));
  const subs = sheet_('Subscribers', ['Name', 'Endpoint', 'Added', 'Last reminded']), sv = subs.getDataRange().getValues();
  const dead = [];
  let sent = 0;
  for (let i = 1; i < sv.length; i++) {
    const name = String(sv[i][0]), endpoint = String(sv[i][1]);
    if (!name || !endpoint || present.has(key_(name))) continue;
    const code = sendPush_(endpoint);
    if (code === 404 || code === 410) dead.push(i + 1);   // phone uninstalled the app or turned reminders off
    else if (code >= 200 && code < 300) { subs.getRange(i + 1, 4).setValue(now); sent++; }
    else console.warn('Push failed', code, name);
  }
  dead.reverse().forEach(r => subs.deleteRow(r));
  prunePresent_(ps, today);
  console.log(`Reminders sent: ${sent}, removed: ${dead.length}, present today: ${present.size}`);
}

// Run this by hand (choose it in the toolbar, then Run) to send yourself a test notification.
function testReminder() {
  const subs = sheet_('Subscribers', ['Name', 'Endpoint', 'Added', 'Last reminded']), sv = subs.getDataRange().getValues();
  if (sv.length < 2) { console.log('Nobody has turned on reminders yet.'); return; }
  const code = sendPush_(String(sv[sv.length - 1][1]));
  console.log(`Sent a test to ${sv[sv.length - 1][0]}: HTTP ${code}`);
}

/* ======================= web push (VAPID, no payload) ======================= */

function sendPush_(endpoint) {
  if (!validEndpoint_(endpoint)) return 400;
  const props = PropertiesService.getScriptProperties();
  const pub = props.getProperty('VAPID_PUBLIC_KEY'), priv = props.getProperty('VAPID_PRIVATE_KEY');
  if (!pub || !priv) throw new Error('VAPID keys are missing in Script Properties');
  const aud = endpoint.match(/^https:\/\/[^/]+/)[0];
  const jwt = vapidJwt_(aud, priv);
  const res = UrlFetchApp.fetch(endpoint, {
    method: 'post', muteHttpExceptions: true, payload: '',
    headers: { TTL: '21600', Urgency: 'high', Authorization: `vapid t=${jwt}, k=${pub}` }
  });
  return res.getResponseCode();
}

function vapidJwt_(aud, privB64url) {
  const cache = CacheService.getScriptCache(), ck = 'jwt_' + aud.replace(/[^\w]/g, '_');
  const hit = cache.get(ck); if (hit) return hit;
  const enc = (o) => b64url_(Utilities.newBlob(JSON.stringify(o)).getBytes());
  const head = enc({ typ: 'JWT', alg: 'ES256' });
  const body = enc({ aud: aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SITE });
  const signingInput = head + '.' + body;
  const jwt = signingInput + '.' + b64url_(es256Sign_(Utilities.newBlob(signingInput).getBytes(), b64urlBytes_(privB64url)));
  cache.put(ck, jwt, 6 * 3600);
  return jwt;
}

/* ---- ECDSA P-256 / SHA-256 (RFC 6979 deterministic nonce), pure JavaScript ---- */
const P256 = {
  p: BigInt('0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff'),
  n: BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551'),
  Gx: BigInt('0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296'),
  Gy: BigInt('0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5')
};
function mod_(a, m) { const r = a % m; return r >= 0n ? r : r + m; }
function inv_(a, m) {   // extended Euclid
  let [r0, r1] = [mod_(a, m), m], [s0, s1] = [1n, 0n];
  while (r1 !== 0n) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1]; }
  return mod_(s0, m);
}
// Jacobian point arithmetic on y^2 = x^3 - 3x + b
function jDouble_(P) {
  const p = P256.p; if (!P || P[2] === 0n) return null;
  const [X, Y, Z] = P, YY = mod_(Y * Y, p), S = mod_(4n * X * YY, p), ZZ = mod_(Z * Z, p);
  const M = mod_(3n * (X - ZZ) * (X + ZZ), p);
  const X3 = mod_(M * M - 2n * S, p), Y3 = mod_(M * (S - X3) - 8n * YY * YY, p), Z3 = mod_(2n * Y * Z, p);
  return [X3, Y3, Z3];
}
function jAdd_(P, Q) {
  const p = P256.p; if (!P) return Q; if (!Q) return P;
  const [X1, Y1, Z1] = P, [X2, Y2, Z2] = Q;
  const Z1Z1 = mod_(Z1 * Z1, p), Z2Z2 = mod_(Z2 * Z2, p);
  const U1 = mod_(X1 * Z2Z2, p), U2 = mod_(X2 * Z1Z1, p), S1 = mod_(Y1 * Z2 * Z2Z2, p), S2 = mod_(Y2 * Z1 * Z1Z1, p);
  if (U1 === U2) return S1 === S2 ? jDouble_(P) : null;
  const H = mod_(U2 - U1, p), R = mod_(S2 - S1, p), HH = mod_(H * H, p), HHH = mod_(H * HH, p), V = mod_(U1 * HH, p);
  const X3 = mod_(R * R - HHH - 2n * V, p), Y3 = mod_(R * (V - X3) - S1 * HHH, p), Z3 = mod_(Z1 * Z2 * H, p);
  return [X3, Y3, Z3];
}
function mulG_(k) {
  let R = null, Q = [P256.Gx, P256.Gy, 1n];
  while (k > 0n) { if (k & 1n) R = jAdd_(R, Q); Q = jDouble_(Q); k >>= 1n; }
  const zi = inv_(R[2], P256.p), zi2 = mod_(zi * zi, P256.p);
  return [mod_(R[0] * zi2, P256.p), mod_(R[1] * zi2 * zi, P256.p)];
}
function es256Sign_(msgBytes, dBytes) {
  const n = P256.n, d = bytesToBig_(dBytes);
  const h = u8_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, msgBytes)), z = bytesToBig_(h);
  const x = bigTo32_(d), h1 = bigTo32_(mod_(z, n));
  const hmac = (key, data) => u8_(Utilities.computeHmacSha256Signature(s8_(data), s8_(key)));
  let V = new Array(32).fill(1), K = new Array(32).fill(0);
  K = hmac(K, V.concat([0], x, h1)); V = hmac(K, V);
  K = hmac(K, V.concat([1], x, h1)); V = hmac(K, V);
  for (;;) {
    V = hmac(K, V);
    const k = bytesToBig_(V);
    if (k >= 1n && k < n) {
      const r = mod_(mulG_(k)[0], n);
      const s = mod_(inv_(k, n) * (z + r * d), n);
      if (r !== 0n && s !== 0n) return bigTo32_(r).concat(bigTo32_(s));
    }
    K = hmac(K, V.concat([0])); V = hmac(K, V);
  }
}

/* ======================= helpers ======================= */

function sheet_(name, headers) {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('SHEET_ID'), ss;
  if (id) ss = SpreadsheetApp.openById(id);
  else { ss = SpreadsheetApp.create('CAIPSD Attendance Reminders'); props.setProperty('SHEET_ID', ss.getId()); }
  let sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.appendRow(headers); sh.setFrozenRows(1); sh.getRange(1, 1, 1, headers.length).setFontWeight('bold'); }
  const first = ss.getSheetByName('Sheet1'); if (first && ss.getSheets().length > 1) ss.deleteSheet(first);
  return sh;
}
function findRow_(sh, col, value) {
  const last = sh.getLastRow(); if (last < 2 || !value) return 0;
  const hit = sh.getRange(2, col, last - 1, 1).createTextFinder(value).matchEntireCell(true).findNext();
  return hit ? hit.getRow() : 0;
}
function prunePresent_(sh, today) {   // keep two weeks of history
  const v = sh.getDataRange().getValues(), cutoff = new Date(today); cutoff.setDate(cutoff.getDate() - 14);
  for (let i = v.length - 1; i >= 1; i--) { const d = new Date(formatCell_(v[i][0]) || v[i][0]); if (d < cutoff) sh.deleteRow(i + 1); }
}
function validEndpoint_(u) {
  const m = /^https:\/\/([^/:?#]+)\//.exec(u || ''); if (!m || u.length > 1000) return false;
  return PUSH_HOSTS.some(h => m[1] === h || m[1].endsWith('.' + h));
}
function cleanName_(s) { s = String(s == null ? '' : s).replace(/[\u0000-\u001F\u007F<>]/g, '').replace(/\s+/g, ' ').trim(); return s.length && s.length <= 60 ? s : ''; }
function key_(s) { return cleanName_(s).toLowerCase(); }
function safe_(v) { v = String(v); return /^[=+\-@]/.test(v) ? "'" + v : v; }
function formatCell_(v) { return v instanceof Date ? Utilities.formatDate(v, TIMEZONE, 'yyyy-MM-dd') : String(v); }
function rateOk_() {
  const c = CacheService.getScriptCache(), k = 'rate_' + Math.floor(Date.now() / 60000), n = Number(c.get(k) || 0) + 1;
  c.put(k, String(n), 120); return n <= 120;
}
function out_(t) { return ContentService.createTextOutput(t).setMimeType(ContentService.MimeType.TEXT); }
function u8_(a) { return a.map(x => (x + 256) % 256); }
function s8_(a) { return a.map(x => (x > 127 ? x - 256 : x)); }
function bytesToBig_(a) { let x = 0n; for (const v of a) x = (x << 8n) | BigInt((v + 256) % 256); return x; }
function bigTo32_(x) { const out = new Array(32); for (let i = 31; i >= 0; i--) { out[i] = Number(x & 255n); x >>= 8n; } return out; }
function b64url_(bytes) { return Utilities.base64EncodeWebSafe(s8_(u8_(bytes))).replace(/=+$/, ''); }
function b64urlBytes_(s) { while (s.length % 4) s += '='; return u8_(Utilities.base64DecodeWebSafe(s)); }

/* ======================= SETUP STEPS =======================
 * 1. Go to script.google.com → New project. Name it "CAIPSD Attendance Reminders".
 * 2. Delete the sample code, paste this whole file, and Save.
 * 3. Project Settings (gear) → Script Properties → add three properties:
 *      VAPID_PUBLIC_KEY   = (the public key Claude gave you)
 *      VAPID_PRIVATE_KEY  = (the private key Claude gave you, keep it secret)
 *      SYNC_TOKEN         = (the same token the attendance app uses)
 * 4. Back in the editor, choose "setup" in the toolbar and click Run. Allow the permissions it asks for.
 *    This creates the "CAIPSD Attendance Reminders" sheet in your Drive and the 9:30 weekday timer.
 * 5. Deploy → New deployment → type "Web app". Execute as: Me. Who has access: Anyone. Deploy.
 *    Copy the Web app URL and send it to Claude (it goes into the app's settings).
 */
function setup() {
  sheet_('Subscribers', ['Name', 'Endpoint', 'Added', 'Last reminded']);
  sheet_('Present', ['Date', 'Name', 'Received']);
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'remind').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('remind').timeBased().everyDays(1).atHour(REMIND_AT.hour).nearMinute(REMIND_AT.minute).inTimezone(TIMEZONE).create();
  console.log('Ready. Reminder sheet: ' + SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SHEET_ID')).getUrl());
}
