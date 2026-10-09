/**
 * CAIPSD Attendance: 9:30 reminder (Google Apps Script). No spreadsheet: phones that turned on reminders
 * are kept in this project's Script Properties. Every weekday at REMIND_AT each of them gets
 * "Please mark your attendance".
 *
 * Setup: paste this file, Save, choose "setup" and Run (allow the permissions), then
 * Deploy -> New deployment -> Web app (Execute as: Me, Who has access: Anyone).
 */

const REMIND_AT = { hour: 9, minute: 30 };     // weekdays, in TIMEZONE
const TIMEZONE = 'Asia/Karachi';
const SITE = 'https://ayanarsam.github.io/CAIPSD-Face-Attendance-/';
const PUSH_HOSTS = ['fcm.googleapis.com', 'push.services.mozilla.com', 'web.push.apple.com', 'notify.windows.com'];
const MAX_PHONES = 1500;

function doGet() { return out_('OK'); }

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents || e.postData.contents.length > 3000) return out_('rejected');
    const b = JSON.parse(e.postData.contents), endpoint = String((b && b.endpoint) || '');
    if (!validEndpoint_(endpoint)) return out_('rejected');
    if (!rateOk_()) return out_('busy');
    const props = PropertiesService.getScriptProperties(), key = subKey_(endpoint);
    if (b.type === 'subscribe') {
      if (!props.getProperty(key) && countSubs_(props) >= MAX_PHONES) return out_('full');
      props.setProperty(key, endpoint); return out_('subscribed');
    }
    if (b.type === 'unsubscribe') { props.deleteProperty(key); return out_('unsubscribed'); }
    return out_('rejected');
  } catch (err) { console.error(err); return out_('error'); }
}

function remind() {
  const day = Number(Utilities.formatDate(new Date(), TIMEZONE, 'u'));   // 1 = Monday ... 7 = Sunday
  if (day > 5) return;
  sendAll_();
}

// Run by hand to send the reminder to every phone right now.
function testReminder() { sendAll_(); }

function sendAll_() {
  const props = PropertiesService.getScriptProperties(), all = props.getProperties();
  let sent = 0, removed = 0, failed = 0;
  for (const k in all) {
    if (k.indexOf('sub_') !== 0) continue;
    const code = sendPush_(all[k]);
    if (code === 404 || code === 410) { props.deleteProperty(k); removed++; }   // app removed or reminders turned off
    else if (code >= 200 && code < 300) sent++;
    else { failed++; console.warn('Push failed', code); }
  }
  console.log('Reminders sent: ' + sent + ', removed: ' + removed + ', failed: ' + failed);
}

function sendPush_(endpoint) {
  if (!validEndpoint_(endpoint)) return 400;
  const props = PropertiesService.getScriptProperties();
  const pub = props.getProperty('VAPID_PUBLIC_KEY'), priv = props.getProperty('VAPID_PRIVATE_KEY');
  if (!pub || !priv) throw new Error('Run setup first');
  const aud = endpoint.match(/^https:\/\/[^/]+/)[0];
  const res = UrlFetchApp.fetch(endpoint, {
    method: 'post', muteHttpExceptions: true, payload: '',
    headers: { TTL: '21600', Urgency: 'high', Authorization: 'vapid t=' + vapidJwt_(aud, priv) + ', k=' + pub }
  });
  return res.getResponseCode();
}

function vapidJwt_(aud, privB64url) {
  const cache = CacheService.getScriptCache(), ck = 'jwt_' + aud.replace(/[^\w]/g, '_');
  const hit = cache.get(ck); if (hit) return hit;
  const enc = (o) => b64url_(Utilities.newBlob(JSON.stringify(o)).getBytes());
  const signingInput = enc({ typ: 'JWT', alg: 'ES256' }) + '.' + enc({ aud: aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SITE });
  const jwt = signingInput + '.' + b64url_(es256Sign_(Utilities.newBlob(signingInput).getBytes(), b64urlBytes_(privB64url)));
  cache.put(ck, jwt, 6 * 3600);
  return jwt;
}

// BigInt numbers (Apps Script's editor rejects the 0n literal form)
const N0_ = BigInt(0), N1_ = BigInt(1), N2_ = BigInt(2), N3_ = BigInt(3), N4_ = BigInt(4), N8_ = BigInt(8), N255_ = BigInt(255);
/* ---- ECDSA P-256 / SHA-256 (RFC 6979 deterministic nonce), pure JavaScript ---- */
const P256 = {
  p: BigInt('0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff'),
  n: BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551'),
  Gx: BigInt('0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296'),
  Gy: BigInt('0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5')
};
function mod_(a, m) { const r = a % m; return r >= N0_ ? r : r + m; }
function inv_(a, m) {   // extended Euclid
  let [r0, r1] = [mod_(a, m), m], [s0, s1] = [N1_, N0_];
  while (r1 !== N0_) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1]; }
  return mod_(s0, m);
}
// Jacobian point arithmetic on y^2 = x^3 - 3x + b
function jDouble_(P) {
  const p = P256.p; if (!P || P[2] === N0_) return null;
  const [X, Y, Z] = P, YY = mod_(Y * Y, p), S = mod_(N4_ * X * YY, p), ZZ = mod_(Z * Z, p);
  const M = mod_(N3_ * (X - ZZ) * (X + ZZ), p);
  const X3 = mod_(M * M - N2_ * S, p), Y3 = mod_(M * (S - X3) - N8_ * YY * YY, p), Z3 = mod_(N2_ * Y * Z, p);
  return [X3, Y3, Z3];
}
function jAdd_(P, Q) {
  const p = P256.p; if (!P) return Q; if (!Q) return P;
  const [X1, Y1, Z1] = P, [X2, Y2, Z2] = Q;
  const Z1Z1 = mod_(Z1 * Z1, p), Z2Z2 = mod_(Z2 * Z2, p);
  const U1 = mod_(X1 * Z2Z2, p), U2 = mod_(X2 * Z1Z1, p), S1 = mod_(Y1 * Z2 * Z2Z2, p), S2 = mod_(Y2 * Z1 * Z1Z1, p);
  if (U1 === U2) return S1 === S2 ? jDouble_(P) : null;
  const H = mod_(U2 - U1, p), R = mod_(S2 - S1, p), HH = mod_(H * H, p), HHH = mod_(H * HH, p), V = mod_(U1 * HH, p);
  const X3 = mod_(R * R - HHH - N2_ * V, p), Y3 = mod_(R * (V - X3) - S1 * HHH, p), Z3 = mod_(Z1 * Z2 * H, p);
  return [X3, Y3, Z3];
}
function mulG_(k) {
  let R = null, Q = [P256.Gx, P256.Gy, N1_];
  while (k > N0_) { if (k & N1_) R = jAdd_(R, Q); Q = jDouble_(Q); k >>= N1_; }
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
    if (k >= N1_ && k < n) {
      const r = mod_(mulG_(k)[0], n);
      const s = mod_(inv_(k, n) * (z + r * d), n);
      if (r !== N0_ && s !== N0_) return bigTo32_(r).concat(bigTo32_(s));
    }
    K = hmac(K, V.concat([0])); V = hmac(K, V);
  }
}

/* ======================= helpers ======================= */
function subKey_(endpoint) { return 'sub_' + b64url_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, endpoint)).slice(0, 32); }
function countSubs_(props) { return Object.keys(props.getProperties()).filter(k => k.indexOf('sub_') === 0).length; }
function validEndpoint_(u) {
  const m = /^https:\/\/([^/:?#]+)\//.exec(u || ''); if (!m || u.length > 1000) return false;
  return PUSH_HOSTS.some(h => m[1] === h || m[1].endsWith('.' + h));
}
function rateOk_() {
  const c = CacheService.getScriptCache(), k = 'rate_' + Math.floor(Date.now() / 60000), n = Number(c.get(k) || 0) + 1;
  c.put(k, String(n), 120); return n <= 120;
}
function out_(t) { return ContentService.createTextOutput(t).setMimeType(ContentService.MimeType.TEXT); }
function u8_(a) { return a.map(x => (x + 256) % 256); }
function s8_(a) { return a.map(x => (x > 127 ? x - 256 : x)); }
function bytesToBig_(a) { let x = N0_; for (const v of a) x = (x << N8_) | BigInt((v + 256) % 256); return x; }
function bigTo32_(x) { const out = new Array(32); for (let i = 31; i >= 0; i--) { out[i] = Number(x & N255_); x >>= N8_; } return out; }
function b64url_(bytes) { return Utilities.base64EncodeWebSafe(s8_(u8_(bytes))).replace(/=+$/, ''); }
function b64urlBytes_(s) { while (s.length % 4) s += '='; return u8_(Utilities.base64DecodeWebSafe(s)); }

function setup() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('VAPID_PUBLIC_KEY') || !props.getProperty('VAPID_PRIVATE_KEY')) {
    const keys = makeVapidKeys_();   // the private key stays inside this project's settings
    props.setProperties({ VAPID_PUBLIC_KEY: keys.pub, VAPID_PRIVATE_KEY: keys.priv });
  }
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'remind').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('remind').timeBased().everyDays(1).atHour(REMIND_AT.hour).nearMinute(REMIND_AT.minute).inTimezone(TIMEZONE).create();
  console.log('Ready. PUBLIC KEY: ' + props.getProperty('VAPID_PUBLIC_KEY'));
}

function makeVapidKeys_() {
  let d = N0_;
  while (d === N0_ || d >= P256.n) {
    const seed = [Utilities.getUuid(), Utilities.getUuid(), Utilities.getUuid(), Utilities.getUuid(), Date.now(), Math.random()].join('|');
    d = bytesToBig_(u8_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, seed)));
  }
  const xy = mulG_(d);
  return { pub: b64url_([4].concat(bigTo32_(xy[0]), bigTo32_(xy[1]))), priv: b64url_(bigTo32_(d)) };
}
