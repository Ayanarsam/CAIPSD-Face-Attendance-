/**
 * CAIPSD Attendance: secure receiver for check-ins (Google Apps Script).
 *
 * Protection layers
 *  1. Signature: every check-in must be signed by the office device's secret key (HMAC-SHA256).
 *     The key is stored in Script Properties (HMAC_SECRET), never in the website or on GitHub.
 *  2. Write-only: this web app never returns any attendance data. doGet only says "OK".
 *  3. Strict checks: field types and lengths, date window, photo format and size.
 *  4. No duplicates and no replays: each check-in ID is accepted once.
 *  5. Rate limit: at most 60 check-ins a minute, so the Sheet can't be flooded.
 *  6. Spreadsheet-formula guard: text starting with = + - @ is stored as plain text.
 *  7. One write at a time (lock), so rows never mix.
 *
 * Setup (once):
 *  Project Settings → Script Properties → add  HMAC_SECRET = <the secret Claude gave you>
 *  Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy  (the web app URL stays the same)
 *  Keep "Execute as: Me" and "Who has access: Anyone". Do NOT share the Sheet itself publicly.
 */

const SHEET_NAME = 'Attendance Log';
const HEADERS = ['Received at', 'Date', 'Time', 'Name', 'Section', 'Status', 'Photo', 'Check-in ID'];
const MAX_BODY = 600000;              // bytes
const MAX_PHOTO = 400000;             // characters of the data URL
const MAX_AGE_DAYS = 14;              // offline check-ins older than this are refused
const MAX_PER_MINUTE = 60;

function doGet() {
  return out_('OK');                  // never returns data
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents || e.postData.contents.length > MAX_BODY) return out_('rejected');
    if (!rateOk_()) return out_('busy');

    const b = JSON.parse(e.postData.contents);
    const rec = validate_(b);
    if (!rec) return out_('rejected');
    if (!signatureOk_(b, rec)) return out_('rejected');

    const lock = LockService.getScriptLock();
    if (!lock.tryLock(15000)) return out_('busy');
    try {
      const sheet = sheet_();
      if (alreadyHave_(sheet, rec.id)) return out_('duplicate');
      sheet.appendRow([new Date(), safe_(rec.date), safe_(rec.time), safe_(rec.name), safe_(rec.section), rec.status, '', rec.id]);
      if (rec.image) putPhoto_(sheet, sheet.getLastRow(), rec);
      CacheService.getScriptCache().put('id_' + rec.idHash, '1', 21600);
    } finally {
      lock.releaseLock();
    }
    return out_('saved');
  } catch (err) {
    console.error(err);
    return out_('error');
  }
}

/* ---------- checks ---------- */

function validate_(b) {
  if (!b || b.v !== 1) return null;
  const str = (v, max) => typeof v === 'string' && v.length <= max ? v : null;
  const name = str(b.name, 60), section = b.section == null ? '' : str(b.section, 20);
  const date = str(b.date, 40), time = str(b.time, 40), sig = str(b.sig, 100);
  if (!name || !name.trim() || section === null || !date || !time || !sig) return null;
  if (b.status !== 'Late' && b.status !== 'On time') return null;
  if (typeof b.ts !== 'number' || !isFinite(b.ts) || b.ts % 1 !== 0) return null;
  const now = Date.now();
  if (b.ts > now + 10 * 60 * 1000 || b.ts < now - MAX_AGE_DAYS * 86400000) return null;
  let image = '';
  if (b.image != null) {
    if (typeof b.image !== 'string' || b.image.length > MAX_PHOTO || !/^data:image\/jpeg;base64,[A-Za-z0-9+\/=]+$/.test(b.image)) return null;
    image = b.image;
  }
  const id = b.ts + '|' + name;
  return { name: name, section: section, date: date, time: time, status: b.status, ts: b.ts, image: image, sig: sig, id: id, idHash: hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, id, Utilities.Charset.UTF_8)) };
}

function signatureOk_(b, rec) {
  const secret = PropertiesService.getScriptProperties().getProperty('HMAC_SECRET');
  if (!secret) return false;          // not set up yet: refuse everything
  const imgHash = rec.image ? hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, rec.image, Utilities.Charset.UTF_8)) : '';
  const msg = ['v1', String(rec.ts), rec.name, rec.section, rec.date, rec.time, rec.status, imgHash].join('\n');
  const expected = Utilities.computeHmacSha256Signature(Utilities.newBlob(msg).getBytes(), Utilities.base64Decode(secret));
  let given;
  try { given = Utilities.base64Decode(rec.sig); } catch (err) { return false; }
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= (expected[i] ^ given[i]);
  return diff === 0;
}

function alreadyHave_(sheet, id) {
  const idHash = hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, id, Utilities.Charset.UTF_8));
  if (CacheService.getScriptCache().get('id_' + idHash)) return true;
  const col = HEADERS.length, last = sheet.getLastRow();
  if (last < 2) return false;
  return !!sheet.getRange(2, col, last - 1, 1).createTextFinder(id).matchEntireCell(true).findNext();
}

function rateOk_() {
  const cache = CacheService.getScriptCache(), k = 'rate_' + Math.floor(Date.now() / 60000);
  const n = Number(cache.get(k) || 0) + 1;
  cache.put(k, String(n), 120);
  return n <= MAX_PER_MINUTE;
}

/* ---------- writing ---------- */

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold').setBackground('#0B1F4B').setFontColor('#FFFFFF');
    sh.setColumnWidth(7, 110);
    sh.getRange('H:H').setNumberFormat('@');
  }
  return sh;
}

function putPhoto_(sheet, row, rec) {
  try {
    const img = SpreadsheetApp.newCellImage().setSourceUrl(rec.image).setAltTextTitle(rec.name + ' check-in').build();
    sheet.getRange(row, 7).setValue(img);
    sheet.setRowHeight(row, 90);
  } catch (err) {
    // fallback: keep the photo as a private file in your Drive and link it
    const folder = folder_();
    const blob = Utilities.newBlob(Utilities.base64Decode(rec.image.split(',')[1]), 'image/jpeg', rec.id.replace(/[^\w-]+/g, '_') + '.jpg');
    const file = folder.createFile(blob);
    sheet.getRange(row, 7).setValue(file.getUrl());
  }
}

function folder_() {
  const name = 'CAIPSD Attendance Photos', it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}

/* ---------- helpers ---------- */

function safe_(v) {
  v = String(v == null ? '' : v).replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  return /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
}

function hex_(bytes) {
  return bytes.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}

function out_(text) {
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.TEXT);
}
