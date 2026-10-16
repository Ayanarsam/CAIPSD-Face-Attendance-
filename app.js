/* CAIPSD Attendance app code (loaded by index.html).
   Edit freely: the page's security rule trusts files from this site, so no hash needs updating.
   Devices pick up changes automatically; bump ?v= and the version label in index.html when you release. */
(() => {
'use strict';
const APP_SCRIPT = document.currentScript ? new URL(document.currentScript.src) : null;
if (window.top !== window.self) { document.documentElement.replaceChildren(); throw new Error('Framing is not allowed'); }
/* CAIPSD Face Attendance — liquid glass UI, fast blink check-in, phone-first.
   Security: strict CSP + pinned library, no inline handlers / innerHTML (XSS-proof rendering),
   input sanitising, CSV formula-injection guard,
   face data, records and check-in photos encrypted on-device with a non-extractable key (no passphrase needed). */
const CONFIG = (() => { try { return JSON.parse(document.getElementById('config').textContent); } catch (e) { return {}; } })();
const GOOGLE_SHEET_WEB_APP_URL = typeof CONFIG.sheetUrl === 'string' ? CONFIG.sheetUrl : '';
const SYNC_TOKEN = typeof CONFIG.token === 'string' ? CONFIG.token : '';
const MAX_ENROLLED = 2000;
const MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.13/model";
const KEY = { enr: 'caipsd2_enr', rec: 'caipsd2_rec', oldEnr: 'eyeAttendance_enrollments', oldRec: 'eyeAttendance_records' };

// Speed / accuracy tuning
const FAST_INPUT_SIZE = 160;         // face box + eyes, every frame (fallback engine)
const ID_INPUT_SIZE = 224;           // identity pass
const ID_RETRY_MS = 200;             // retry this fast while a face is still unidentified
const ID_REVERIFY_MS = 1500;         // re-check a recognised face this often while it stays in view (someone else may have stepped in)
const ID_FRESH_MS = 250;             // a blink only checks someone in if their face was recognised from a picture taken at the blink
                                     // (or at most this long before it), so a person who just stepped in can't be checked in under the previous name
const TRACK_GAP_FRAMES = 3;          // a face missing from this many camera frames in a row (and for at least
const TRACK_GAP_MS = 400;            // this long) may be a different person when one reappears; frames, not just time, so a slow phone isn't fooled
const EYES_SHUT_WAIT_MS = 700;       // recognition waits (at most this long) for closed eyes to open: a closed-eye picture is often not recognised
const TRACK_MATCH_RATIO = 0.6;       // how far (in face widths) a face may move between frames
const TRACK_TTL_MS = 700;
const MATCH_DISTANCE_THRESHOLD = 0.45;
const MATCH_MARGIN = 0.06;
const BLINK_WINDOW_MS = 4000;        // a blink made while being identified still counts
const PHOTO_WAIT_MS = 300;           // after a blink, wait for eyes to reopen before the check-in photo
const SUCCESS_HOLD_MS = 1900;
const LATE_AFTER = '';        // late marking is off; set a time like '09:15' (24-hour clock) to mark later check-ins Late
const VOICE_ON = true;   // set to false to turn off the spoken "Welcome, name"

let mode = 'recognize';                 // 'recognize' | 'enroll'
let enrollments = [];                   // [{id, name, section, descriptor: Float32Array}]
let records = [];
let dataVer = 0;                        // goes up whenever records or enrollments change (lets results be reused until then)
let deviceKey = null;
let video, overlay, ctx;
let pendingEnrollDescriptor = null, capturedDescriptorForSave = null;
let tracks = [], trackSeq = 0, idBusy = false, lastEnrollIdAt = 0;
let faceLandmarker = null, engine = 'faceapi';   // 'faceapi' until MediaPipe is ready, then 'mp'
let mediaStream = null, facing = 'user';
let recogReady = false, recogFailed = false;   // big 6 MB recognition model loads in the background
let saveQueue = Promise.resolve();
let statusHoldUntil = 0, lastStatusKey = '', stepsKey = '', highlightTs = 0;
let view = { cw: 0, ch: 0, dpr: 1 };

const $ = (id) => document.getElementById(id);
const enc = new TextEncoder(), dec = new TextDecoder();
const clamp01 = (v) => v < 0 ? 0 : v > 1 ? 1 : v;

/* ---------- helpers ---------- */
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) for (const k in props) { if (k === 'class') e.className = props[k]; else if (k === 'text') e.textContent = props[k]; else e[k] = props[k]; }
  for (const kid of kids) if (kid) e.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
  return e;
}
function clean(s, max) { return String(s || '').replace(/[\u0000-\u001F\u007F<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max); }
function safeImg(s) { return typeof s === 'string' && s.length < 400000 && /^data:image\/jpeg;base64,[A-Za-z0-9+\/=]+$/.test(s); }
function sanitizeEnrollments(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(x => x && typeof x.name === 'string' && Array.isArray(x.descriptor) && x.descriptor.length === 128 && x.descriptor.every(Number.isFinite))
    .map(x => ({ id: (typeof x.id === 'string' && x.id.length <= 64) ? x.id : crypto.randomUUID(), name: clean(x.name, 60), section: clean(x.section, 20), descriptor: new Float32Array(x.descriptor) }))
    .filter(x => x.name).slice(0, MAX_ENROLLED);
}
function sanitizeRecords(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(r => r && typeof r.name === 'string' && Number.isFinite(r.ts))
    .map(r => Object.assign({ name: clean(r.name, 60), section: clean(r.section, 20), date: clean(r.date, 40), time: clean(r.time, 40), ts: r.ts, late: r.late === true },
      r.sync === 'rejected' ? { sync: 'rejected', reason: clean(r.reason, 60) } : {}))
    .filter(r => r.name);
}
function localDate(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function downloadText(text, name, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
function csvCell(v) { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; }
function setStatus(text, kind, hold) {
  const now = performance.now();
  if (!hold && now < statusHoldUntil) return;          // keep a success message on screen briefly
  if (hold) statusHoldUntil = now + hold;
  const key = kind + '|' + text; if (key === lastStatusKey) return;
  const kindChanged = !lastStatusKey.startsWith(kind + '|'); lastStatusKey = key;
  const b = $('statusBar');
  if (kindChanged) { b.className = 'status-bar status-' + kind; void b.offsetWidth; b.classList.add('pop'); }
  $('statusText').textContent = text;
}
function setSteps(face, id, blink) {   // each: '' | 'on' | 'done'
  const key = face + id + blink; if (key === stepsKey) return; stepsKey = key;
  const el = $('steps').children; el[0].className = face; el[1].className = id; el[2].className = blink;
}
function setProgress(pct, text) { $('progressBar').style.width = pct + '%'; if (text) $('splashStatus').textContent = text; }
function bump(el) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }

/* ---------- on-device encryption (transparent, no passphrase) ---------- */
function toB64(buf) { const b = new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); }
function fromB64(s) { const bin = atob(s), out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }

let dbP = null;
// The connection is reopened if the browser ever closes it (low storage, data cleared, a newer tab upgrading it)
// or if opening it once failed, so saving never stays broken for the rest of the day.
function openDB() {
  return dbP || (dbP = new Promise((res, rej) => {
    const r = indexedDB.open('caipsd', 4);
    r.onupgradeneeded = () => { const d = r.result; for (const s of ['k', 'photos', 'outbox', 'rec']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s); };
    r.onsuccess = () => {
      const d = r.result;
      d.onclose = () => { dbP = null; };
      d.onversionchange = () => { try { d.close(); } catch (e) {} dbP = null; };
      res(d);
    };
    r.onerror = () => { dbP = null; rej(r.error); };
  }));
}
// a transaction on a connection that has just been closed: forget it, so the next save opens a fresh one
function dbGone(e) { if (e && (e.name === 'InvalidStateError' || e.name === 'UnknownError')) dbP = null; }
// Check-in photos live in IndexedDB (big quota), each one encrypted with the device key.
// The Google Sheet / Drive keep the real copies, so the device keeps only the last PHOTO_KEEP_DAYS days.
const PHOTO_KEEP_DAYS = 60;
async function putPhoto(ts, dataUrl) {
  try {
    const db = await openDB(), val = await seal({ img: dataUrl });
    await new Promise((res, rej) => { const tx = db.transaction('photos', 'readwrite'); tx.objectStore('photos').put(val, ts); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  } catch (e) { dbGone(e); console.warn('Photo save failed', e); }
}
async function clearPhotos() {
  try { const db = await openDB(); await new Promise((res, rej) => { const tx = db.transaction('photos', 'readwrite'); tx.objectStore('photos').clear(); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); } catch (e) {}
}
async function pruneOldPhotos() {
  try {
    const db = await openDB(), cutoff = Date.now() - PHOTO_KEEP_DAYS * 864e5;
    await new Promise((res, rej) => { const tx = db.transaction('photos', 'readwrite'); tx.objectStore('photos').delete(IDBKeyRange.upperBound(cutoff)); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  } catch (e) {}
}
async function getDeviceKey() {
  try {
    const db = await openDB();
    let key = await new Promise((res, rej) => { const q = db.transaction('k').objectStore('k').get('main'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    if (!key) {
      key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);   // non-extractable
      await new Promise((res, rej) => { const tx = db.transaction('k', 'readwrite'); tx.objectStore('k').put(key, 'main'); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    }
    return key;
  } catch (e) { console.warn('Device key unavailable; storing unencrypted.', e); return null; }
}
async function seal(obj) {
  const json = JSON.stringify(obj);
  if (!deviceKey) return 'p:' + json;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, deviceKey, enc.encode(json));
  return 'e:' + toB64(iv) + '.' + toB64(ct);
}
async function unseal(str) {
  if (!str) return null;
  if (str.startsWith('p:')) return JSON.parse(str.slice(2));
  const [i, c] = str.slice(2).split('.');
  return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(i) }, deviceKey, fromB64(c))));
}

/* Saving: enrolled faces stay in localStorage (small). Attendance records are saved one month per entry in
   IndexedDB, so a check-in re-saves only the current month instead of every record ever (no screen freeze).
   Changes are flagged where they happen; persist() saves only what was flagged (or everything if nothing was). */
let enrDirty = false, recAll = false;
const recDirty = new Set();
const monthKey = (ts) => { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); };
const markRecord = (ts) => recDirty.add(monthKey(ts));
async function saveNow() {
  if (!enrDirty && !recAll && !recDirty.size) { enrDirty = true; recAll = true; }   // nothing flagged: save everything
  const enr = enrDirty, all = recAll, months = new Set(recDirty);
  enrDirty = false; recAll = false; recDirty.clear();
  if (enr) localStorage.setItem(KEY.enr, await seal(enrollments.map(x => ({ id: x.id, name: x.name, section: x.section, descriptor: Array.from(x.descriptor) }))));
  if (!all && !months.size) return 'none';
  const byMonth = new Map();
  for (const r of records) { const k = monthKey(r.ts); if (all || months.has(k)) { let l = byMonth.get(k); if (!l) byMonth.set(k, l = []); l.push(r); } }
  const keys = all ? [...byMonth.keys()] : [...months];
  const sealed = [];
  for (const k of keys) { const l = byMonth.get(k); sealed.push([k, l && l.length ? await seal(l) : null]); }
  try {
    const db = await openDB();
    await new Promise((res, rej) => {
      const tx = db.transaction('rec', 'readwrite'), st = tx.objectStore('rec');
      if (all) st.clear();
      for (const [k, v] of sealed) { if (v === null) st.delete(k); else st.put(v, k); }
      tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
    });
    return 'monthly';
  } catch (err) {   // no IndexedDB on this device (e.g. private window): keep everything in localStorage as before
    dbGone(err);
    console.warn('Monthly save unavailable, saving all records in one piece', err);
    localStorage.setItem(KEY.rec, await seal(records));
    return 'single';
  }
}
function persist() {
  saveQueue = saveQueue.then(saveNow).catch(err => {
    console.error('Save failed', err);
    if (err && (err.name === 'QuotaExceededError' || /quota/i.test(err.message || ''))) setStatus('This device’s storage is full. Export the CSV, then use Clear all to free space (the Google Sheet keeps everything).', 'err', 30000);
  });
  return saveQueue;
}
async function loadRecordMonths() {
  try {
    const db = await openDB();
    const vals = await new Promise((res, rej) => { const q = db.transaction('rec').objectStore('rec').getAll(); q.onsuccess = () => res(q.result || []); q.onerror = () => rej(q.error); });
    const out = [];
    for (const v of vals) { try { const l = await unseal(v); if (Array.isArray(l)) out.push(...l); } catch (e) { console.warn('A saved month is unreadable', e); } }
    return out;
  } catch (e) { return null; }
}
async function loadData() {
  deviceKey = await getDeviceKey();
  let e = null, r = null, legacy = null;
  try { e = await unseal(localStorage.getItem(KEY.enr)); } catch (err) { console.warn('Stored faces unreadable', err); }
  const monthsLoaded = await loadRecordMonths();
  r = monthsLoaded || [];
  try { legacy = await unseal(localStorage.getItem(KEY.rec)); } catch (err) { console.warn('Stored records unreadable', err); }
  if (Array.isArray(legacy) && legacy.length) {   // records saved by the previous version (all in one piece)
    const seen = new Set(r.map(x => x.ts + '|' + x.name));
    for (const x of legacy) if (x && !seen.has(x.ts + '|' + x.name)) r.push(x);
  }
  if (!e && !r.length && (localStorage.getItem(KEY.oldEnr) || localStorage.getItem(KEY.oldRec))) {
    // migrate data from the original version (drop stored photos), then delete the plaintext copy
    try {
      e = JSON.parse(localStorage.getItem(KEY.oldEnr) || '[]');
      const oldRecs = JSON.parse(localStorage.getItem(KEY.oldRec) || '[]');
      for (const x of oldRecs) if (safeImg(x.image) && Number.isFinite(x.ts)) await putPhoto(x.ts, x.image);
      r = oldRecs.map(x => ({ name: x.name, section: x.section, date: x.date, time: x.time, ts: x.ts }));
      enrollments = sanitizeEnrollments(e); records = sanitizeRecords(r).sort((a, b) => a.ts - b.ts);
      enrDirty = true; recAll = true;
      await saveNow();
      localStorage.removeItem(KEY.oldEnr); localStorage.removeItem(KEY.oldRec);
      return;
    } catch (err) { console.warn('Migration failed', err); }
  }
  enrollments = sanitizeEnrollments(e); records = sanitizeRecords(r).sort((a, b) => a.ts - b.ts);
  if (Array.isArray(legacy) && legacy.length && monthsLoaded !== null) {
    // move the previous version's single copy into monthly saves; remove it only once that worked
    try { recAll = true; if (await saveNow() === 'monthly') localStorage.removeItem(KEY.rec); }
    catch (err) { console.warn('Could not move records to monthly saves yet', err); }
  }
}

/* ---------- camera (restarts itself if it disconnects, freezes or is busy) ---------- */
let camError = '', camStarting = null, camRetryTimer = 0, camRetryDelay = 3000, lastFrameTime = -1, lastFrameAt = 0;
function startCamera() {
  if (!camStarting) camStarting = openCamera().finally(() => { camStarting = null; });
  return camStarting;
}
async function openCamera() {
  stopCamera();
  clearTimeout(camRetryTimer);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } }, audio: false });
    mediaStream = stream;
    stream.getVideoTracks().forEach(t => t.addEventListener('ended', () => { if (mediaStream === stream) cameraLost('Camera disconnected.'); }));
    video.srcObject = stream;
    video.classList.toggle('mirror', facing === 'user');
    await new Promise((res, rej) => {
      if (video.readyState >= 1) return res();
      const t = setTimeout(() => rej(new Error('the camera sent no picture')), 8000);
      video.onloadedmetadata = () => { clearTimeout(t); res(); };
    });
    video.play().catch(() => {});
    camError = ''; camRetryDelay = 3000; tracks = [];
    lastFrameTime = -1; lastFrameAt = performance.now();
    statusHoldUntil = 0;   // clear a "camera error" message that was holding the status bar
    setStatus(engineReady ? 'Camera ready. Look at the camera.' : 'Starting face engine…', 'wait');
    loadMediapipe();       // fast blink engine (loads once; also covers a camera that was unavailable at start)
    return true;
  } catch (err) {
    stopCamera();
    camError = err.name === 'NotAllowedError' ? 'Camera blocked. Allow camera access in the browser settings.'
             : err.name === 'NotReadableError' ? 'The camera is busy (another app may be using it).'
             : err.name === 'NotFoundError' ? 'No camera found. Check the camera cable.'
             : 'Camera problem: ' + err.message + '.';
    statusHoldUntil = 0;
    setStatus(camError + ' Retrying…', 'err', 600000);   // stays on screen until the camera is back
    scheduleCameraRetry();
    return false;
  }
}
function scheduleCameraRetry() {
  clearTimeout(camRetryTimer);
  camRetryTimer = setTimeout(() => { if (document.hidden) scheduleCameraRetry(); else startCamera(); }, camRetryDelay);
  camRetryDelay = Math.min(15000, Math.round(camRetryDelay * 1.6));   // 3 s, 5 s, 8 s … then every 15 s
}
function cameraLost(why) {
  if (camStarting) return;
  console.warn('Camera lost:', why);
  stopCamera(); tracks = [];
  camError = why;
  statusHoldUntil = 0;
  setStatus(why + ' Reconnecting…', 'err', 600000);
  camRetryDelay = 1500;
  scheduleCameraRetry();
}
// every 3 s: is the camera still connected and still sending new pictures?
setInterval(() => {
  if (document.hidden || camStarting || !mediaStream || !video) return;
  if (!mediaStream.active || !mediaStream.getVideoTracks().some(t => t.readyState === 'live')) return cameraLost('Camera disconnected.');
  if (video.paused) video.play().catch(() => {});
  if (video.currentTime !== lastFrameTime) { lastFrameTime = video.currentTime; lastFrameAt = performance.now(); }
  else if (performance.now() - lastFrameAt > 8000) cameraLost('The camera stopped sending pictures.');
}, 3000);
function stopCamera() { if (mediaStream) mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
async function flipCamera() { facing = facing === 'user' ? 'environment' : 'user'; tracks = []; await startCamera(); }

/* ---------- detection: a fast eye/blink loop that never waits for face recognition ---------- */
// MediaPipe eye contours (person's right eye = left side of the raw image)
const MP_EYE_IMG_LEFT = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
const MP_EYE_IMG_RIGHT = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];

function eyeAspectRatio(p) {
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  return (d(p[1], p[5]) + d(p[2], p[4])) / (2.0 * d(p[0], p[3]));
}
const MP_FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
function centroid(pts) { let x = 0, y = 0; for (const p of pts) { x += p.x; y += p.y; } return { x: x / pts.length, y: y / pts.length }; }
function eyeRect(pts, s, ci, cj) {   // box around one eye, rotated to the eye's tilt, in video pixels
  const a = pts[ci], b = pts[cj], c = centroid(pts);
  let ang = Math.atan2(b.y - a.y, b.x - a.x); if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI;
  const w = Math.hypot(b.x - a.x, b.y - a.y) * 1.65;
  return { cx: c.x, cy: c.y, w, h: w * 0.68, a: ang, s, pts };
}
// face box that turns with the head (roll), fitted around the landmarks
function faceBox(pts, lp, rp, padTop, pad) {
  const l = centroid(lp), r = centroid(rp), a = Math.atan2(r.y - l.y, r.x - l.x), c = centroid(pts);
  const cs = Math.cos(-a), sn = Math.sin(-a);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const p of pts) { const dx = p.x - c.x, dy = p.y - c.y, u = dx * cs - dy * sn, v = dx * sn + dy * cs; if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v; }
  const hh = v1 - v0, top = v0 - hh * (padTop + pad), bot = v1 + hh * pad, w = (u1 - u0) * (1 + pad * 2);
  const uc = (u0 + u1) / 2, vc = (top + bot) / 2, c2 = Math.cos(a), s2 = Math.sin(a);
  return { cx: c.x + uc * c2 - vc * s2, cy: c.y + uc * s2 + vc * c2, w, h: bot - top, a };
}

// MediaPipe loads in the background; until then the face-api engine handles blinks.
let mpLoading = false;
async function loadMediapipe() {
  if (faceLandmarker || mpLoading) return;   // load once (switching camera early used to start a second copy)
  mpLoading = true;
  try {
    const { FaceLandmarker, FilesetResolver } = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs");
    const fs = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm");
    const make = (delegate) => FaceLandmarker.createFromOptions(fs, {
      baseOptions: { modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task", delegate },
      outputFaceBlendshapes: true, runningMode: "VIDEO", numFaces: WEAK_DEVICE ? 1 : 2, minFaceDetectionConfidence: 0.5, minTrackingConfidence: 0.5
    });
    try { faceLandmarker = await make('GPU'); } catch (e) { faceLandmarker = await make('CPU'); }
    engine = 'mp'; tracks = [];
    mpLoop();
  } catch (e) { console.warn('MediaPipe unavailable, using face-api blink detection', e); faceLandmarker = null; engine = 'faceapi'; }
  finally { mpLoading = false; }
}

/* Engine A (until MediaPipe is ready): face-api box + 68 landmarks every frame.
   Identity is computed in the same pass only when a face actually needs it. */
let hadFace = false, faScan = 0, faWide = false, faMiss = 0;
async function faLoop() {
  if (engine !== 'faceapi') return;
  loopBeat = performance.now();
  try { await faFrame(); engineOk(); } catch (e) { console.warn(e); engineFailed(e); }
  setTimeout(faLoop, hadFace ? (isLite() ? 30 : 0) : 150);
}
async function faFrame() {
  if (document.hidden || !video || video.readyState < 2 || !video.videoWidth) { hadFace = false; return; }
  // track faces every frame (recognition runs afterwards on a close-up, see runIdentity).
  // Nobody found lately: every 4th frame take a wider look (320 px) so people standing further back are found;
  // once someone is found that way, keep the wide look while they stay, and go back to the fast size when they leave.
  const wide = faWide || (!hadFace && ++faScan % 4 === 0);
  const dets = await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions({ inputSize: wide ? 320 : FAST_INPUT_SIZE, scoreThreshold: 0.5 })).withFaceLandmarks();
  if (engine !== 'faceapi') return;
  const now = performance.now();
  hadFace = dets.length > 0; if (hadFace) lastFaceAt = now;
  if (hadFace) { faMiss = 0; if (wide) faWide = true; } else if (faWide && ++faMiss > 8) { faWide = false; faMiss = 0; }
  const faces = dets.map(det => {
    const lp = det.landmarks.getLeftEye(), rp = det.landmarks.getRightEye();
    return { ob: faceBox(det.landmarks.positions, lp, rp, 0.22, 0.05), lp, rp, outline: det.landmarks.getJawOutline(), closed: false, src: 'ear' };
  });
  updateTracks(faces, now);
  if (recogReady && !idBusy && needsIdentity(performance.now())) await runIdentity();
}

/* Engine B (preferred): MediaPipe face mesh + blink blendshapes on every video frame (~30 fps).
   Identity runs asynchronously alongside it, so blinks are never missed. */
let lastVideoTime = -1, lastFaceAt = -Infinity;   // no face seen yet
let detCost = 15;
function mpLoop() {
  if (engine !== 'mp') return;
  loopBeat = performance.now();
  const t0 = performance.now();
  try { mpStep(); } catch (e) { console.warn(e); }
  const cost = performance.now() - t0;
  detCost = detCost * 0.9 + cost * 0.1;
  // about 30 detections a second, leaving gaps so the overlay can be drawn smoothly in between
  const idle = !hadFace && performance.now() - lastFaceAt > 1500;   // nobody there: check ~6 times a second instead of 30
  setTimeout(mpLoop, document.hidden ? 250 : idle ? 160 : Math.max(4, (isLite() ? 45 : 33) - cost));
}
function mpStep() {
  if (document.hidden || !video || video.readyState < 2 || !video.videoWidth || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  let res; try { res = faceLandmarker.detectForVideo(video, performance.now()); engineOk(); } catch (e) { engineFailed(e); return; }
  const W = video.videoWidth, H = video.videoHeight, faces = [];
  for (let i = 0; i < res.faceLandmarks.length; i++) {
    const lm = res.faceLandmarks[i];
    const cats = res.faceBlendshapes[i]?.categories || [];
    const sc = (n) => cats.find(c => c.categoryName === n)?.score ?? 0;
    const pts = (idx) => idx.map(k => ({ x: lm[k].x * W, y: lm[k].y * H }));
    const lp = pts(MP_EYE_IMG_LEFT), rp = pts(MP_EYE_IMG_RIGHT), oval = pts(MP_FACE_OVAL);
    faces.push({ ob: faceBox(oval, lp, rp, 0, 0.04), lp, rp, outline: oval, closed: true, sL: sc('eyeBlinkRight'), sR: sc('eyeBlinkLeft'), src: 'mp' });
  }
  hadFace = faces.length > 0; if (hadFace) lastFaceAt = performance.now();
  updateTracks(faces, performance.now());
  if (recogReady && !idBusy && needsIdentity(performance.now())) runIdentity();
}

function idInputSize() { return ID_INPUT_SIZE; }   // keep one size: changing it makes the GPU recompile (stutter)
// a named face blinked, but its name was last confirmed too long ago: check who it is before checking anyone in
function needsConfirm(tr, t) {
  return !!(tr.name && tr.name !== 'Unknown' && blinkLive(tr, t) && !(tr.confirmedAt > tr.blinkAt - ID_FRESH_MS));
}
// a blink still counts for BLINK_WINDOW_MS, or until the check of who blinked comes back (slow phones take longer; at most 15 s)
function blinkLive(tr, t) { return !!tr.blinkAt && (t - tr.blinkAt < BLINK_WINDOW_MS || t < tr.confirmUntil); }
// 2 = urgent (not identified yet, or a blink waiting for confirmation), 1 = due for a re-check, 0 = not due
function idPriority(tr, t) {
  if (t - tr.lastSeen >= 300) return 0;
  if (tr.closed && t - tr.closedAt < EYES_SHUT_WAIT_MS) return 0;   // mid-blink: wait until the eyes are open again
  if (tr.name === null || needsConfirm(tr, t)) return 2;
  if (tr.name === 'Unknown') return t - tr.lastIdAt > (tr.unknownHits >= 3 ? 1200 : ID_RETRY_MS) ? 1 : 0;
  return t - tr.lastIdAt > ID_REVERIFY_MS ? 1 : 0;
}
function needsIdentity(t) {
  if (mode === 'enroll') return tracks.length > 0 && t - lastEnrollIdAt > 250;
  return tracks.some(tr => idPriority(tr, t) > 0);
}
let engineFails = 0;
function engineOk() { engineFails = 0; }
function engineFailed(e) {
  if (++engineFails === 40) {   // ~40 failures in a row: the engine is broken, not just one bad frame
    console.error('Face engine keeps failing, restarting', e);
    setStatus('Face engine stopped working. Restarting…', 'err', 15000);
    reloadWhenFree(30000);   // it can't check anyone in while broken, so don't wait long for an empty camera
  }
}
let idCost = 120, idNextAt = 0, idStartedAt = 0;
async function runIdentity() {
  // a blink waiting for confirmation skips the usual pause between passes, so check-in isn't slowed down
  if (performance.now() < idNextAt && !tracks.some(tr => needsConfirm(tr, performance.now()))) return;
  idBusy = true; const t0 = performance.now(); idStartedAt = t0;
  try {
    const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: idInputSize(), scoreThreshold: 0.45 });
    // Close-up first: the blink engine already knows where the face is, so recognise a crop around it.
    // The face then fills the picture: found reliably from further away, and the result matches enrollments.
    let done = false;
    // Each result is applied only if that face is still the same person it was when the picture was taken
    // (gen changes when a face vanishes and someone reappears), and it counts from the moment of the picture.
    const tr = pickIdentityTrack(performance.now()), gen = tr ? tr.gen : -1, shotAt = performance.now();
    if (tr && cropFace(tr)) {
      const cd = await faceapi.detectAllFaces(idCanvas, opts).withFaceLandmarks().withFaceDescriptors();
      if (cd.length) {
        let big = cd[0]; for (const d of cd) if (d.detection.box.width > big.detection.box.width) big = d;
        if (mode === 'enroll') { lastEnrollIdAt = performance.now(); pendingEnrollDescriptor = big.descriptor; }
        if (tr.gen === gen) identifyTrack(tr, big.descriptor, shotAt);
        done = true;
      }
    }
    if (!done) {   // no close-up result: fall back to the whole picture, as before
      const gens = new Map(tracks.map(c => [c, c.gen])), fullAt = performance.now();
      const dets = await faceapi.detectAllFaces(video, opts).withFaceLandmarks().withFaceDescriptors();
      applyIdentity(dets, fullAt, gens);
    }
    engineOk();
  } catch (e) { console.warn('Identity pass failed', e); engineFailed(e); }
  idCost = idCost * 0.7 + (performance.now() - t0) * 0.3;
  idNextAt = performance.now() + Math.min(600, idCost * 0.8);   // let the blink engine breathe between identity passes
  idBusy = false;
}
// the face that most needs identifying (unknown first, then the biggest)
function pickIdentityTrack(t) {
  let best = null, bestP = 0;
  for (const tr of tracks) {
    if (!tr.target || t - tr.lastSeen > 300) continue;
    const p = mode === 'enroll' ? 2 : idPriority(tr, t);
    if (!p) continue;
    if (!best || p > bestP || (p === bestP && tr.target.w > best.target.w)) { best = tr; bestP = p; }
  }
  return best;
}
const idCanvas = document.createElement('canvas'); idCanvas.width = idCanvas.height = ID_INPUT_SIZE;   // fixed size: no GPU recompiles
const idCtx = idCanvas.getContext('2d', { willReadFrequently: false });
function cropFace(tr) {
  const g = tr.target; if (!g || !g.w || !video.videoWidth) return false;
  const side = Math.max(g.w, g.h) * 1.8;
  idCtx.fillStyle = '#808080'; idCtx.fillRect(0, 0, ID_INPUT_SIZE, ID_INPUT_SIZE);
  // draw the visible part of the square around the face, keeping the scale the same at the picture edges
  const sx = g.cx - side / 2, sy = g.cy - side / 2, k = ID_INPUT_SIZE / side;
  const x0 = Math.max(0, sx), y0 = Math.max(0, sy), x1 = Math.min(video.videoWidth, sx + side), y1 = Math.min(video.videoHeight, sy + side);
  if (x1 - x0 < 20 || y1 - y0 < 20) return false;
  idCtx.drawImage(video, x0, y0, x1 - x0, y1 - y0, (x0 - sx) * k, (y0 - sy) * k, (x1 - x0) * k, (y1 - y0) * k);
  return true;
}
// compare one face fingerprint with the roster and update that face's name
function identifyTrack(tr, descriptor, t) {
  let bestDist = Infinity, second = Infinity, cand = 'Unknown';
  for (const e of enrollments) {
    const d = faceapi.euclideanDistance(descriptor, e.descriptor);
    if (d < bestDist) { second = bestDist; bestDist = d; cand = e.name; } else if (d < second) second = d;
  }
  const marginOk = (second - bestDist) >= MATCH_MARGIN || enrollments.length === 1;
  if (bestDist > MATCH_DISTANCE_THRESHOLD || !marginOk) cand = 'Unknown';
  // an identified face keeps its name on screen through one bad re-check, but that never counts as confirming it
  if (cand === 'Unknown' && tr.name && tr.name !== 'Unknown' && tr.unknownHits < 1) { tr.unknownHits++; tr.lastIdAt = t; tr.confirmedAt = 0; return; }
  tr.unknownHits = cand === 'Unknown' ? tr.unknownHits + 1 : 0;
  tr.name = cand; tr.lastIdAt = t;
  tr.confirmedAt = cand === 'Unknown' ? 0 : t;   // when this face was last positively matched to this name
  if (cand === 'Unknown') { tr.blinkAt = 0; tr.confirmUntil = 0; }   // whoever blinked is not enrolled: that blink checks no one in
}
function applyIdentity(dets, t, gens) {
  if (mode === 'enroll') {
    lastEnrollIdAt = t;
    let big = null; for (const d of dets) if (!big || d.detection.box.width > big.detection.box.width) big = d;
    pendingEnrollDescriptor = big ? big.descriptor : null;
  }
  const used = new Set();
  for (const det of dets) {
    const b = det.detection.box, bx = b.x + b.width / 2, by = b.y + b.height / 2;
    let tr = null, best = Math.max(60, b.width * 0.7);
    for (const c of tracks) { if (used.has(c)) continue; const d = Math.hypot(c.bx - bx, c.by - by); if (d < best) { best = d; tr = c; } }
    if (!tr) continue;
    used.add(tr);
    if (gens && gens.get(tr) !== tr.gen) continue;   // that face changed (or is new) since the picture was taken
    if (tr.closed && t - tr.closedAt < EYES_SHUT_WAIT_MS) continue;   // eyes were shut in that picture: don't judge by it
    identifyTrack(tr, det.descriptor, t);
  }
}

/* Shared: follow faces across frames, read both eyes, latch blinks, decide what to show. */
function resetIdentity(tr) {
  tr.gen++;   // any recognition still running for the previous person is ignored when it finishes
  tr.name = null; tr.unknownHits = 0; tr.lastIdAt = 0; tr.confirmedAt = 0;
  tr.blinkAt = 0; tr.confirmUntil = 0; tr.seenOpen = false; tr.closed = false; tr.base = 0;
}
function updateTracks(faces, t) {
  const used = new Set();
  let primary = null;
  for (const f of faces) {
    const ob = f.ob, bx = ob.cx, by = ob.cy;
    let tr = null, best = Math.max(60, ob.w * TRACK_MATCH_RATIO);
    for (const c of tracks) { if (used.has(c)) continue; const d = Math.hypot(c.bx - bx, c.by - by); if (d < best) { best = d; tr = c; } }
    let jumped = false;
    if (!tr && faces.length === 1 && tracks.length === 1 && !used.has(tracks[0])) { tr = tracks[0]; jumped = true; }   // one person: keep the box on a fast move
    if (!tr) { tr = { id: ++trackSeq, gen: 0, name: null, unknownHits: 0, lastIdAt: 0, confirmedAt: 0, confirmUntil: 0, seenOpen: false, closed: false, closedAt: 0, blinkAt: 0, flashAt: -1e9, base: 0, alpha: 0.35, disp: null, vx: 0, vy: 0, tT: 0, w: ob.w, missed: 0 }; tracks.push(tr); }
    else if (tr.missed >= TRACK_GAP_FRAMES && t - tr.lastSeen > TRACK_GAP_MS) resetIdentity(tr);   // the face was gone for a moment: whoever is there now must be recognised again
    else if (jumped || Math.abs(ob.w - tr.w) > tr.w * 0.5) resetIdentity(tr);   // the face jumped across the picture or changed size at once: likely someone else
    tr.w = ob.w; tr.missed = 0;
    if (tr.tT && t - tr.tT > 0 && t - tr.tT < 200) {   // movement speed, used to keep the boxes ahead of the video
      const dt = t - tr.tT; tr.vx = tr.vx * 0.35 + ((bx - tr.bx) / dt) * 0.65; tr.vy = tr.vy * 0.35 + ((by - tr.by) / dt) * 0.65;
    } else { tr.vx = 0; tr.vy = 0; }
    used.add(tr); tr.bx = bx; tr.by = by; tr.lastSeen = t; tr.tT = t;

    // closedness per eye: 0 = open, 1 = closed, relative to this person's own open-eye level
    let sL, sR, closeT, openT;
    if (f.src === 'mp') {
      sL = f.sL; sR = f.sR;
      const raw = (sL + sR) / 2;
      if (!tr.base) tr.base = raw; else if (raw < tr.base + 0.1) tr.base += (raw - tr.base) * 0.12;
      closeT = Math.min(0.8, tr.base + 0.28); openT = tr.base + 0.12;
    } else {
      const eL = eyeAspectRatio(f.lp), eR = eyeAspectRatio(f.rp), avg = (eL + eR) / 2;
      if (!tr.base) tr.base = Math.max(avg, 0.2);
      else if (avg > tr.base * 0.88) tr.base += (avg - tr.base) * 0.15;
      const k = tr.base * 0.45;
      sL = clamp01((tr.base - eL) / k); sR = clamp01((tr.base - eR) / k);
      closeT = 0.45; openT = 0.22;
    }
    const blink = (sL + sR) / 2;
    if (blink < openT) tr.seenOpen = true;
    if (!tr.closed && blink > closeT) {
      tr.closed = true; tr.closedAt = t;
      if (tr.seenOpen) { tr.blinkAt = t; tr.flashAt = t; tr.confirmUntil = 0; }   // counted the moment the eyes close
    } else if (tr.closed && blink < openT) tr.closed = false;

    // what this face should show
    let tone = 'scan', label = 'Identifying…', state = 'scan';
    if (!recogReady) { label = recogFailed ? 'Model error' : 'Loading…'; state = 'loading'; }
    else if (mode === 'enroll') { tone = 'enroll'; label = tr.name && tr.name !== 'Unknown' ? tr.name + ' (enrolled)' : 'New face'; state = 'enroll'; }
    else if (tr.name === 'Unknown' && tr.unknownHits >= 2) { tone = 'unknown'; label = 'Not enrolled'; state = 'unknown'; }
    else if (tr.name && tr.name !== 'Unknown') {
      tone = 'ok'; label = tr.name;
      if (presentToday().has(tr.name)) { state = 'done'; label = tr.name + '  ✓'; }
      else if (blinkLive(tr, t)) {
        if (tr.closed && t - tr.blinkAt < PHOTO_WAIT_MS) state = 'blinked';   // wait a moment so the photo has open eyes
        else if (needsConfirm(tr, t)) {   // make sure it's still the same person first
          if (!tr.confirmUntil) tr.confirmUntil = t + 15000;
          state = 'confirming'; tone = 'scan'; label = 'Checking…';
        } else {
          const { rec } = recordAttendance(tr.name, ob);
          tr.blinkAt = 0; tr.confirmUntil = 0; state = 'recorded'; label = tr.name + '  ✓';
          showSuccess(rec, tr);
        }
      } else state = 'blink';
    }
    const ci = 0, cj = f.src === 'mp' ? 8 : 3;
    tr.target = { cx: ob.cx, cy: ob.cy, w: ob.w, h: ob.h, a: ob.a, tone, label, prompt: state === 'blink' || state === 'scan', eyes: [eyeRect(f.lp, sL, ci, cj), eyeRect(f.rp, sR, ci, cj)], outline: f.outline, closedOutline: f.closed };
    tr.state = state;
    if (!primary || ob.w > primary.w) primary = { w: ob.w, tr };
  }
  for (const c of tracks) if (!used.has(c)) c.missed++;   // camera frames in a row in which this face was not seen
  tracks = tracks.filter(c => t - c.lastSeen < TRACK_TTL_MS);

  if (!primary) {
    setFrameState('idle', false);
    if (mode === 'enroll') pendingEnrollDescriptor = null;
    setSteps('on', '', '');
    setStatus(mode === 'enroll' ? 'Show your face to the camera.' : 'Look at the camera and blink once.', 'wait');
    return;
  }
  const p = primary.tr, blinked = blinkLive(p, t) ? 'done' : 'on';
  // someone else is in front of the camera now: close the previous person's thank-you straight away
  if (successFor && (p !== successFor.tr || p.gen !== successFor.gen)) hideSuccess();
  setFrameState({ done: 'ok', recorded: 'ok', blinked: 'ok', enroll: 'ok', unknown: 'err' }[p.state] || 'scan', true);
  switch (p.state) {
    case 'loading': setSteps('done', 'on', blinked); setStatus(recogFailed ? 'Recognition model failed to load. Reload the page.' : 'Loading face recognition…', recogFailed ? 'err' : 'wait'); break;
    case 'enroll': setStatus('Face detected. Ready to capture.', 'ok'); break;
    case 'scan': setSteps('done', 'on', blinked); setStatus(blinked === 'done' ? 'Blink received. Identifying…' : 'Identifying… you can blink now.', 'wait'); break;
    case 'unknown': setSteps('done', 'on', ''); setStatus('Face not recognised. Ask an admin to enroll you.', 'err'); break;
    case 'blink': setSteps('done', 'done', 'on'); setStatus(`${p.name}, blink once to confirm.`, 'wait'); break;
    case 'blinked': setSteps('done', 'done', 'done'); setStatus(`Blink received, ${p.name}…`, 'ok'); break;
    case 'confirming': setSteps('done', 'on', 'done'); setStatus('Blink received. Checking who it is…', 'wait'); break;
    case 'recorded': setSteps('done', 'done', 'done'); setStatus(`✓ Attendance recorded for ${p.name}`, 'ok', SUCCESS_HOLD_MS); break;
    case 'done': setSteps('done', 'done', 'done'); setStatus(`✓ ${p.name} is already marked present`, 'ok'); break;
  }
}

/* ---------- overlay rendering (60 fps, smoothed between detections) ---------- */
const TONES = { scan: '#5AA2FF', enroll: '#5AA2FF', ok: '#2BD49A', unknown: '#FF6B6B' };
const EYE_OPEN = '#9BE7FF', EYE_SHUT = '#E8C95A', EYE_BLINK = '#2BD49A';
const rgbaCache = new Map();
function rgba(hex, a) { const key = hex + a; let v = rgbaCache.get(key); if (!v) { const n = parseInt(hex.slice(1), 16); v = `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; rgbaCache.set(key, v); } return v; }
function rr(x, y, w, hh, r) {
  r = Math.max(0, Math.min(r, w / 2, hh / 2));
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + hh, r); ctx.arcTo(x + w, y + hh, x, y + hh, r);
  ctx.arcTo(x, y + hh, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function sizeOverlay() {
  const r = overlay.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, document.body.classList.contains('lite') ? 1 : 1.5);
  view = { cw: r.width, ch: r.height, dpr };
  overlay.width = Math.max(1, Math.round(r.width * dpr)); overlay.height = Math.max(1, Math.round(r.height * dpr));
}
function mapper() {   // video pixels -> on-screen pixels (object-fit: cover + mirror)
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !view.cw) return null;
  const c = Math.max(view.cw / vw, view.ch / vh);
  return { c, ox: (view.cw - vw * c) / 2, oy: (view.ch - vh * c) / 2, mirror: facing === 'user' };
}
function mapP(m, x, y) { let sx = x * m.c + m.ox; if (m.mirror) sx = view.cw - sx; return [sx, y * m.c + m.oy]; }
// big moves snap instantly, tiny jitter is smoothed
function followK(cx, cy, tx, ty, w) { return Math.min(1, 0.5 + Math.hypot(tx - cx, ty - cy) / Math.max(6, w * 0.035)); }
let frameState = '', frameFace = null;
function setFrameState(st, has) {
  const ring = $('ring');
  if (st !== frameState) { ring.dataset.state = st; frameState = st; }
  if (has !== frameFace) { ring.classList.toggle('has-face', has); frameFace = has; }
}

let lastFrameT = 0, drewLast = false, frameEma = 16, slowFrames = 0, perfFrom = Infinity;
// weaker computers and phones start in lite mode straight away (no glass blur over the live video)
const WEAK_DEVICE = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4 || matchMedia('(pointer: coarse)').matches;
if (WEAK_DEVICE) document.body.classList.add('lite');
const isLite = () => document.body.classList.contains('lite');
function render(ts) {
  requestAnimationFrame(render);
  if (isLite() && ts - lastFrameT < 30) return;   // lite: about 30 fps is plenty for the boxes
  const dt = Math.min(64, ts - (lastFrameT || ts)); lastFrameT = ts;
  // if this computer can't keep up, switch off the heavy glass blur automatically
  if (ts > perfFrom && !document.hidden) {
    frameEma = frameEma * 0.95 + dt * 0.05;
    if ((frameEma > 21 || detCost > 26) && ++slowFrames > 45) { document.body.classList.add('lite'); sizeOverlay(); perfFrom = Infinity; }
    else if (frameEma <= 21 && detCost <= 26) slowFrames = 0;
  }
  const m = video && mapper();
  if (!m || !tracks.length || document.hidden) {
    if (drewLast) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, overlay.width, overlay.height); drewLast = false; }
    return;
  }
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  ctx.clearRect(0, 0, view.cw, view.ch);
  const now = performance.now(), sg = m.mirror ? -1 : 1;
  for (const tr of tracks) {
    const tg = tr.target; if (!tg) continue;
    tr.alpha += ((now - tr.lastSeen < 500 ? 1 : 0) - tr.alpha) * Math.min(1, dt / 70);
    if (tr.alpha < 0.02) continue;
    // predict where the face is right now from its speed, so the boxes don't trail behind
    const lead = Math.min(Math.max(now - tr.tT, 0), 90), ox = tr.vx * lead, oy = tr.vy * lead;
    const [fx, fy] = mapP(m, tg.cx + ox, tg.cy + oy);
    const eyes = tg.eyes.map(e => { const [x, y] = mapP(m, e.cx + ox, e.cy + oy); return { cx: x, cy: y, w: e.w * m.c, h: e.h * m.c, a: sg * e.a, s: e.s, pts: e.pts.map(p => mapP(m, p.x + ox, p.y + oy)) }; });
    const outline = tg.outline ? tg.outline.map(p => mapP(m, p.x + ox, p.y + oy)) : null;
    const fw = tg.w * m.c, fh = tg.h * m.c, fa = sg * tg.a;
    if (!tr.disp) tr.disp = { cx: fx, cy: fy, w: fw, h: fh, a: fa, eyes };
    else {
      const D = tr.disp, k = followK(D.cx, D.cy, fx, fy, fw);
      D.cx += (fx - D.cx) * k; D.cy += (fy - D.cy) * k;
      D.w += (fw - D.w) * Math.max(k, 0.55); D.h += (fh - D.h) * Math.max(k, 0.55); D.a += (fa - D.a) * 0.6;
      eyes.forEach((e, i) => {
        const E = D.eyes[i], ke = followK(E.cx, E.cy, e.cx, e.cy, fw);
        E.cx += (e.cx - E.cx) * ke; E.cy += (e.cy - E.cy) * ke;
        E.w += (e.w - E.w) * 0.6; E.h += (e.h - E.h) * 0.6; E.a += (e.a - E.a) * 0.6; E.s += (e.s - E.s) * 0.75; E.pts = e.pts;
      });
    }
    drawFace(tr, tr.disp, outline, now);
  }
  ctx.globalAlpha = 1; drewLast = true;
}

function glowStroke(c, w) { ctx.lineWidth = w + 5; ctx.strokeStyle = rgba(c, 0.2); ctx.stroke(); ctx.lineWidth = w; ctx.strokeStyle = c; ctx.stroke(); }
function drawFace(tr, D, outline, now) {
  const tg = tr.target, col = TONES[tg.tone] || TONES.scan, A = tr.alpha;
  ctx.globalAlpha = A;
  // face outline (jaw or full face oval), dotted
  if (outline && outline.length > 2) {
    ctx.beginPath(); outline.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); if (tg.closedOutline) ctx.closePath();
    ctx.setLineDash([1.5, 6]); ctx.lineCap = 'round'; ctx.lineWidth = 1.8; ctx.strokeStyle = rgba(col, 0.6); ctx.stroke(); ctx.setLineDash([]);
  }
  // face frame, turned with the head
  ctx.save(); ctx.translate(D.cx, D.cy); ctx.rotate(D.a);
  const w = D.w, hh = D.h, x = -w / 2, y = -hh / 2, L = Math.min(w, hh) * 0.22, r = 14;
  rr(x, y, w, hh, 18); ctx.fillStyle = rgba(col, 0.06); ctx.fill();
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x, y + L); ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r); ctx.lineTo(x + L, y);
  ctx.moveTo(x + w - L, y); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r); ctx.lineTo(x + w, y + L);
  ctx.moveTo(x + w, y + hh - L); ctx.lineTo(x + w, y + hh - r); ctx.arcTo(x + w, y + hh, x + w - r, y + hh, r); ctx.lineTo(x + w - L, y + hh);
  ctx.moveTo(x + L, y + hh); ctx.lineTo(x + r, y + hh); ctx.arcTo(x, y + hh, x, y + hh - r, r); ctx.lineTo(x, y + hh - L);
  glowStroke(col, 3);
  if (tg.tone === 'scan' || tg.tone === 'enroll') {   // scanning sweep while identifying
    const p = (now % 1500) / 1500, sy = y + hh * (0.5 - 0.5 * Math.cos(p * Math.PI * 2));
    const g = ctx.createLinearGradient(0, sy - 22, 0, sy + 2);
    g.addColorStop(0, rgba(col, 0)); g.addColorStop(1, rgba(col, 0.45));
    ctx.save(); rr(x, y, w, hh, 18); ctx.clip(); ctx.fillStyle = g; ctx.fillRect(x, sy - 22, w, 24);
    ctx.fillStyle = rgba(col, 0.95); ctx.fillRect(x + 6, sy, w - 12, 1.5); ctx.restore();
  }
  ctx.restore();
  // both eyes: tilted box, live eyelid outline and an openness meter
  const sinceBlink = now - tr.flashAt;
  for (const e of D.eyes) {
    let ec = e.s > 0.45 ? EYE_SHUT : EYE_OPEN, a = 1;
    if (sinceBlink < 700) ec = EYE_BLINK;
    else if (tg.prompt) a = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(now / 170));
    ctx.globalAlpha = A * a;
    ctx.save(); ctx.translate(e.cx, e.cy); ctx.rotate(e.a);
    rr(-e.w / 2, -e.h / 2, e.w, e.h, Math.min(e.h / 2, 9)); ctx.fillStyle = rgba(ec, e.s > 0.45 || sinceBlink < 700 ? 0.26 : 0.08); ctx.fill();
    glowStroke(ec, 2.5);
    const mh = 3.5, my = e.h / 2 + 4;
    rr(-e.w / 2, my, e.w, mh, mh / 2); ctx.fillStyle = 'rgba(255,255,255,.28)'; ctx.fill();
    rr(-e.w / 2, my, Math.max(mh, e.w * (1 - clamp01(e.s))), mh, mh / 2); ctx.fillStyle = ec; ctx.fill();
    ctx.restore();
    if (e.pts && e.pts.length > 3) {
      ctx.beginPath(); e.pts.forEach(([px, py], i) => i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)); ctx.closePath();
      glowStroke(ec, 1.6);
    }
  }
  ctx.globalAlpha = A;
  // name pill
  const fs = view.cw < 420 ? 13 : 14;
  ctx.font = `700 ${fs}px "Plus Jakarta Sans", system-ui, sans-serif`; ctx.textBaseline = 'middle';
  const tw = ctx.measureText(tg.label).width, ph = fs + 14, pw = tw + 34;
  let px = D.cx - pw / 2, py = D.cy - D.h / 2 - ph - 12;
  px = Math.max(8, Math.min(px, view.cw - pw - 8));
  if (py < 8) py = Math.min(D.cy + D.h / 2 + 12, view.ch - ph - 8);
  rr(px, py, pw, ph, ph / 2); ctx.fillStyle = 'rgba(6,16,44,.62)'; ctx.fill();
  ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,.3)'; ctx.stroke();
  ctx.beginPath(); ctx.arc(px + 14, py + ph / 2, 4, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
  ctx.fillStyle = '#fff'; ctx.fillText(tg.label, px + 24, py + ph / 2 + 1);
}

/* ---------- success feedback ---------- */
let successTimer = 0, audioCtx = null;
let voicePrimed = false, voicePick = null;
function unlockAudio() {
  try { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') audioCtx.resume(); } catch (e) {}
  // browsers only allow speech after a first tap; a silent utterance unlocks it
  if (!voicePrimed && 'speechSynthesis' in window) { try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); voicePrimed = true; } catch (e) {} }
}
// Woman's voice: known female voice names across Windows, Edge, Chrome, Android, macOS and iOS
const FEMALE_VOICES = /neerja|heera|veena|kajal|swara|aditi|raveena|zira|aria|jenny|sonia|libby|natasha|hazel|susan|catherine|linda|female|samantha|karen|moira|tessa|fiona|serena|kate|victoria|allison|ava|susan|zoe|isha|priya/i;
const MALE_VOICES = /\bmale\b|david|mark|ravi|prabhat|rishi|daniel|alex|fred|george|guy|ryan|thomas|oliver|arthur|aaron|tom\b/i;
function chooseVoice() {
  if (!('speechSynthesis' in window)) return null;
  const vs = speechSynthesis.getVoices().filter(v => /^en/i.test(v.lang)); if (!vs.length) return null;
  const female = vs.filter(v => FEMALE_VOICES.test(v.name) && !/\bmale\b/i.test(v.name.replace(/female/i, '')));
  // voices built into the device speak instantly; online ones wait for the internet first
  const rank = v => (v.localService === false || /online/i.test(v.name) ? 10 : 0) + (/en-IN/i.test(v.lang) ? 0 : /en-GB/i.test(v.lang) ? 1 : 2);
  if (female.length) return female.sort((a, b) => rank(a) - rank(b))[0];
  return vs.filter(v => !MALE_VOICES.test(v.name)).sort((a, b) => rank(a) - rank(b))[0] || null;   // unnamed default voices are usually female
}
if ('speechSynthesis' in window) { speechSynthesis.onvoiceschanged = () => { voicePick = chooseVoice(); }; voicePick = chooseVoice(); }
function sayWelcome(name) {
  if (!VOICE_ON || !('speechSynthesis' in window)) return;
  try {
    if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();   // never queue up behind the previous person
    const u = new SpeechSynthesisUtterance(`Welcome, ${name}`);
    voicePick = voicePick || chooseVoice(); if (voicePick) { u.voice = voicePick; u.lang = voicePick.lang; }
    u.rate = 1.05; u.pitch = voicePick && FEMALE_VOICES.test(voicePick.name) ? 1.05 : 1.3; u.volume = 1;   // raise pitch if no female voice is installed
    speechSynthesis.speak(u);
  } catch (e) {}
}
function chime() {
  if (!audioCtx || audioCtx.state !== 'running') return;
  const t0 = audioCtx.currentTime;
  [[880, 0], [1318.5, 0.09]].forEach(([f, d]) => {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t0 + d); g.gain.exponentialRampToValueAtTime(0.16, t0 + d + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.35);
    o.connect(g); g.connect(audioCtx.destination); o.start(t0 + d); o.stop(t0 + d + 0.4);
  });
}
let successFor = null;   // the face the thank-you pop-up is showing for
function hideSuccess() {
  clearTimeout(successTimer); successFor = null;
  $('success').classList.remove('show'); $('ring').classList.remove('flash', 'success-on');
  statusHoldUntil = 0;   // let the status bar talk to the new person
}
function showSuccess(rec, tr) {
  sayWelcome(rec.name.split(' ')[0]);   // first, so the voice starts together with the pop-up
  const box = $('success'), ring = $('ring');
  $('sTitle').textContent = `Thank you, ${rec.name.split(' ')[0]}!`;
  const tm = new Date(rec.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  $('sMeta').textContent = `Attendance marked at ${tm}` + (rec.section ? `, ${rec.section}` : '');
  const st = weekStats().rows.find(r => r.name === rec.name);
  $('sWeek').textContent = st && st.pct !== null ? `This week: ${st.count} of ${st.denom} day${st.denom === 1 ? '' : 's'}, ${st.pct}%` : '';
  const run = streaks().get(rec.name) || 0;
  $('sStreak').textContent = run >= 2 ? `🔥 ${run} days in a row` + (run % 5 === 0 ? '. Great work!' : '') : '';
  box.classList.remove('show'); void box.offsetWidth; box.classList.add('show');
  ring.classList.add('flash', 'success-on');
  clearTimeout(successTimer);
  successFor = tr ? { tr, gen: tr.gen } : null;
  successTimer = setTimeout(() => { successFor = null; box.classList.remove('show'); ring.classList.remove('flash', 'success-on'); }, SUCCESS_HOLD_MS);
  if (navigator.vibrate) navigator.vibrate([60, 40, 90]);
  chime();
}

/* ---------- attendance streaks (consecutive weekdays present; weekends are skipped) ---------- */
let streakCache = { key: '', map: new Map() };
// local calendar day as a whole number (days since 1 Jan 1970); worked out once per record and remembered
const dayCache = new Map();
function dayNum(ts) {
  let v = dayCache.get(ts);
  if (v === undefined) { const d = new Date(ts); v = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5; dayCache.set(ts, v); }
  return v;
}
const isWeekendDay = (n) => { const wd = (n + 4) % 7; return wd === 0 || wd === 6; };   // day 0 was a Thursday
const prevWeekdayNum = (n) => { n--; while (isWeekendDay(n)) n--; return n; };
function streaks() {
  const now = new Date(), key = now.toDateString() + '|' + records.length;
  if (streakCache.key === key) return streakCache.map;
  const days = new Map();
  for (const r of records) { if (r.sync === 'rejected') continue; let s = days.get(r.name); if (!s) days.set(r.name, s = new Set()); s.add(dayNum(r.ts)); }
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 864e5, weekend = isWeekendDay(today);
  const map = new Map();
  for (const [name, set] of days) {
    // today only extends the streak once they check in; not checking in yet doesn't break it
    let d = (!weekend && set.has(today)) ? today : prevWeekdayNum(today), n = 0;
    while (set.has(d)) { n++; d = prevWeekdayNum(d); }
    map.set(name, n);
  }
  streakCache = { key, map };
  return map;
}

/* ---------- weekly attendance (Monday to Friday, starts fresh every Monday) ---------- */
const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], DAY_LETTER = ['M', 'T', 'W', 'T', 'F'];
function weekInfo(now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayIdx = (today.getDay() + 6) % 7;                       // Mon = 0 … Sun = 6
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - todayIdx);
  const next = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 7);
  const friday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 4);
  return { monday, friday, start: monday.getTime(), end: next.getTime(), todayIdx, key: monday.toDateString() + '|' + todayIdx };
}
let weekCache = { key: '', val: null };
function weekStats() {
  const w = weekInfo(), ck = w.key + '|' + dataVer + '|' + records.length + '|' + enrollments.length;
  if (weekCache.key === ck) return weekCache.val;   // nothing changed since last time: no need to go through every record again
  const val = computeWeekStats(w);
  weekCache = { key: ck, val };
  return val;
}
function computeWeekStats(w) {
  const seen = new Map(), daily = [0, 0, 0, 0, 0];
  for (const r of records) {
    if (r.ts < w.start || r.ts >= w.end || r.sync === 'rejected') continue;   // refused by the Sheet: not counted
    const d = new Date(r.ts), idx = (d.getDay() + 6) % 7;
    if (idx > 4) continue;
    if (!seen.has(r.name)) seen.set(r.name, new Set());
    const set = seen.get(r.name);
    if (!set.has(idx)) { set.add(idx); daily[idx]++; }
  }
  const sections = new Map(enrollments.map(e => [e.name, e.section]));
  for (const r of records) if (!sections.has(r.name) && seen.has(r.name)) sections.set(r.name, r.section);
  const names = [...new Set([...enrollments.map(e => e.name), ...seen.keys()])].sort((a, b) => a.localeCompare(b));
  const weekend = w.todayIdx > 4, past = weekend ? 5 : w.todayIdx;   // school days already finished
  const rows = names.map(name => {
    const set = seen.get(name) || new Set();
    const denom = past + (!weekend && set.has(w.todayIdx) ? 1 : 0);   // today counts once they've checked in
    const days = DAY_SHORT.map((_, i) => set.has(i) ? 'p' : (weekend || i < w.todayIdx) ? 'a' : i === w.todayIdx ? 't' : 'f');
    return { name, section: sections.get(name) || '', count: set.size, denom, pct: denom ? Math.round(set.size / denom * 100) : null, days };
  });
  const withPct = rows.filter(r => r.pct !== null);
  const avg = withPct.length ? Math.round(withPct.reduce((a, r) => a + r.pct, 0) / withPct.length) : null;
  return { w, rows, daily, avg, roster: Math.max(enrollments.length, rows.length) };
}
let lastWeekKey = '', barsBuilt = false;
function renderWeek(pulseName) {
  const st = weekStats(), w = st.w;
  lastWeekKey = w.key;
  const fmt = (d) => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  $('weekRange').textContent = `${fmt(w.monday)} – ${fmt(w.friday)}`;

  // today ring
  const todayN = w.todayIdx <= 4 ? st.daily[w.todayIdx] : 0, roster = enrollments.length;
  const pct = roster ? Math.min(100, Math.round(todayN / roster * 100)) : 0;
  $('ringFg').style.strokeDashoffset = String(314.16 * (1 - pct / 100));
  $('todayPct').textContent = w.todayIdx > 4 ? '–' : pct + '%';
  $('todayFrac').textContent = w.todayIdx > 4 ? 'Weekend, no classes' : `${todayN} of ${roster} present today`;
  $('weekAvg').textContent = st.avg === null ? '–' : st.avg + '%';

  // Mon–Fri bars
  const bars = $('weekBars');
  if (!barsBuilt) { DAY_SHORT.forEach(dn => bars.appendChild(h('div', { class: 'bar' }, h('em', { text: '0' }), h('div', { class: 'bar-col' }, h('i')), h('span', { text: dn })))); barsBuilt = true; }
  const max = Math.max(roster, ...st.daily, 1);
  [...bars.children].forEach((bar, i) => {
    bar.className = 'bar' + (i === w.todayIdx ? ' is-today' : '') + (w.todayIdx <= 4 && i > w.todayIdx ? ' future' : '');
    bar.firstChild.textContent = String(st.daily[i]);
    bar.children[1].firstChild.style.height = (st.daily[i] / max * 100) + '%';
  });

  // per-student rows: each row is built once and then only its text/colours are updated (no full rebuild per check-in)
  const list = $('weekList');
  const runs = streaks();
  if (!st.rows.length) { weekRows.clear(); list.replaceChildren(h('div', { class: 'empty', text: 'Enroll students to see their weekly attendance here.' })); return; }
  const wanted = [];
  for (const r of st.rows) {
    let w = weekRows.get(r.name);
    if (!w) {
      const meta = document.createTextNode(''), streak = h('span', { class: 'streak' });
      const dots = DAY_SHORT.map(() => h('span', { class: 'dot' }));
      const pct = h('span', { class: 'pct' });
      const row = h('div', { class: 'wrow' }, h('span', { class: 'avatar', text: r.name.charAt(0).toUpperCase() }),
        h('div', { class: 'wname-box' }, h('b', { text: r.name }), h('small', null, meta, streak)), h('div', { class: 'dots' }, ...dots), pct);
      w = { row, meta, streak, dots, pct, key: '' };
      weekRows.set(r.name, w);
    }
    const run = runs.get(r.name) || 0;
    const key = [r.section, r.count, r.denom, r.pct, r.days.join(''), run].join('|');
    if (key !== w.key) {   // something about this student changed: update just this row
      w.key = key;
      w.meta.data = `${r.section ? r.section + ', ' : ''}${r.count} of ${r.denom || 0} day${r.denom === 1 ? '' : 's'}`;
      w.streak.style.display = run < 2 ? 'none' : '';
      if (run >= 2) { w.streak.textContent = `🔥 ${run}`; w.streak.title = `${run} days in a row`; }
      r.days.forEach((v, i) => { const d = w.dots[i]; d.className = 'dot ' + v; d.textContent = DAY_LETTER[i]; d.title = `${DAY_SHORT[i]}: ${{ p: 'Present', a: 'Absent', t: 'Not checked in yet', f: 'Upcoming' }[v]}`; });
      w.pct.className = 'pct ' + (r.pct === null ? 'na' : r.pct >= 75 ? 'hi' : r.pct >= 50 ? 'mid' : 'lo');
      w.pct.textContent = r.pct === null ? '–' : r.pct + '%';
    }
    if (r.name === pulseName) { w.row.classList.remove('pulse'); void w.row.offsetWidth; w.row.classList.add('pulse'); }
    wanted.push(w.row);
  }
  for (const name of weekRows.keys()) if (!st.rows.some(r => r.name === name)) weekRows.delete(name);
  const cur = list.children;
  if (cur.length !== wanted.length || wanted.some((el, i) => cur[i] !== el)) list.replaceChildren(...wanted);   // only when people were added/removed
}
const weekRows = new Map();
function exportWeekCSV() {
  const st = weekStats(), label = { p: 'Present', a: 'Absent', t: '', f: '' };
  let csv = 'Name,Section,' + DAY_SHORT.join(',') + ',Days present,Days counted,Percentage\n';
  for (const r of st.rows) csv += [r.name, r.section, ...r.days.map(v => label[v]), r.count, r.denom, r.pct === null ? '' : r.pct + '%'].map(csvCell).join(',') + '\n';
  downloadText(csv, 'weekly_attendance_' + localDate(st.w.monday) + '.csv', 'text/csv');
}

/* ---------- enrollment ---------- */
function captureEnrollment() {
  if (!pendingEnrollDescriptor) { setStatus(recogReady ? 'No face detected right now.' : 'Face recognition is still loading…', recogReady ? 'err' : 'wait'); return; }
  capturedDescriptorForSave = pendingEnrollDescriptor;
  const ring = $('ring'); ring.classList.remove('shutter'); void ring.offsetWidth; ring.classList.add('shutter');
  $('nameSection').classList.remove('hidden');
  $('enrollName').value = ''; $('enrollSection').value = ''; $('enrollName').focus();
}
async function saveEnrollmentName() {
  const name = clean($('enrollName').value, 60), section = clean($('enrollSection').value, 20);
  if (!name || !section) { setStatus('Please enter both name and section.', 'err'); return; }
  if (!capturedDescriptorForSave) return;
  const idx = enrollments.findIndex(e => e.name.toLowerCase() === name.toLowerCase());
  if (idx < 0 && enrollments.length >= MAX_ENROLLED) { setStatus('Roster is full.', 'err'); return; }
  const entry = { id: idx >= 0 ? enrollments[idx].id : crypto.randomUUID(), name, section, descriptor: capturedDescriptorForSave };
  if (idx >= 0) enrollments[idx] = entry; else enrollments.push(entry);
  capturedDescriptorForSave = null; $('nameSection').classList.add('hidden'); dataVer++;
  tracks.forEach(t => { t.name = null; });
  renderEnrolledList(); renderLog(); setStatus(`${name} enrolled.`, 'ok', 1500);
  enrDirty = true; await persist();
}
function cancelEnrollment() { capturedDescriptorForSave = null; $('nameSection').classList.add('hidden'); }
async function deleteEnrollment(id) {
  const e = enrollments.find(x => x.id === id); if (!e) return;
  if (!confirm(`Remove ${e.name} and their face data?`)) return;
  enrollments = enrollments.filter(x => x.id !== id); dataVer++;
  tracks.forEach(t => { t.name = null; });
  renderEnrolledList(); renderLog(); enrDirty = true; await persist();
}
function renderEnrolledList() {
  const box = $('enrolledList'); box.replaceChildren();
  if (!enrollments.length) { box.appendChild(h('div', { class: 'empty', text: 'No one enrolled yet. Capture a face to add the first student.' })); return; }
  for (const e of enrollments) {
    const left = h('span', { class: 'who' }, h('span', { class: 'avatar', text: (e.name || '?').charAt(0).toUpperCase() }), h('span', { class: 'wname', text: e.name }));
    if (e.section) left.appendChild(h('span', { class: 'pill', text: e.section }));
    box.appendChild(h('div', { class: 'enrolled-item' }, left, h('button', { class: 'btn btn-danger btn-sm', text: 'Delete', onclick: () => deleteEnrollment(e.id) })));
  }
}

/* ---------- records ---------- */
let presentCache = { key: '', set: new Set() };
let todayStr = '', todayStrAt = -1e9;
function todayString() {
  const n = performance.now();
  if (n - todayStrAt > 1000) { todayStr = new Date().toLocaleDateString(); todayStrAt = n; }
  return todayStr;
}
function presentToday() {
  const today = todayString(), key = today + '|' + records.length;
  if (presentCache.key !== key) presentCache = { key, set: new Set(records.filter(r => r.date === today).map(r => r.name)) };
  return presentCache.set;
}
// The check-in photo is copied from the camera at the moment of the blink (fast), and turned into a JPEG
// a moment later, after the thank-you pop-up is on screen, so the pop-up and voice never wait for it.
function grabPhoto() {
  try {
    const w = 320, ratio = (video.videoHeight / video.videoWidth) || 0.75;
    const c = document.createElement('canvas'); c.width = w; c.height = Math.round(w * ratio);
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    return c;
  } catch (e) { return null; }
}
function encodePhoto(c) { try { return c ? c.toDataURL('image/jpeg', 0.6) : null; } catch (e) { return null; } }
const later = (fn) => setTimeout(() => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 700 }) : fn()), 350);
function isLate(d) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(LATE_AFTER || ''); if (!m) return false;
  return d.getHours() * 60 + d.getMinutes() > (+m[1]) * 60 + (+m[2]);
}
function recordAttendance(name, face) {
  const now = new Date(), enr = enrollments.find(e => e.name === name);
  const shot = grabPhoto(), bgShot = grabBackground(face);   // both pictures are taken now, from this exact frame
  const rec = { name, section: enr ? enr.section : '', date: now.toLocaleDateString(), time: now.toLocaleTimeString(), ts: now.getTime(), late: isLate(now) };
  records.push(rec); markRecord(rec.ts); highlightTs = rec.ts; presentCache.key = ''; dataVer++;
  // just after the thank-you pop-up appears: finish the photo and office check, then send it to the Sheet
  setTimeout(() => {
    const photo = encodePhoto(shot);
    const bg = scoreBackground(bgShot);
    if (syncEnabled()) {
      const payload = { ...rec, status: rec.late ? 'Late' : 'On time', token: SYNC_TOKEN }; if (photo) payload.image = photo;
      if (bg !== null) payload.bg = bg;
      queueSync(payload);
    }
    // then, in separate small steps so the camera never stutters
    later(() => { renderLog(); later(() => { persist(); if (photo) later(() => putPhoto(rec.ts, photo)); }); });
  }, 80);
  return { rec };
}

/* ---------- offline sync: every check-in waits in an encrypted outbox until the Sheet receives it ---------- */
let outboxCount = 0, flushing = false, flushAgain = false, outboxReady = false;   // ready once the device key has loaded
function syncEnabled() { return GOOGLE_SHEET_WEB_APP_URL.startsWith('https://script.google.com/macros/s/'); }
function outboxTx(txMode, fn) {
  return openDB().then(db => new Promise((res, rej) => { const tx = db.transaction('outbox', txMode); const out = fn(tx.objectStore('outbox')); tx.oncomplete = () => res(out && out.result); tx.onerror = () => rej(tx.error); }))
    .catch(e => { dbGone(e); throw e; });
}
async function refreshSyncPill() {
  try { outboxCount = await outboxTx('readonly', s => s.count()) || 0; } catch (e) {}
  const pill = $('syncPill'); if (!pill) return;
  pill.hidden = outboxCount === 0;
  pill.textContent = navigator.onLine ? `Syncing ${outboxCount}…` : `Offline · ${outboxCount} saved`;
  pill.title = `${outboxCount} check-in${outboxCount === 1 ? '' : 's'} saved on this device, sent automatically when the internet is back`;
}
async function queueSync(payload) {
  try { const sealed = await seal(payload); await outboxTx('readwrite', s => s.put(sealed, payload.ts)); }
  catch (e) { console.warn('Outbox save failed, sending directly', e); sendToSheet(payload).catch(() => {}); return; }
  refreshSyncPill(); flushOutbox();
}
// Sends one check-in and reads the Sheet's reply: {result: 'saved' | 'duplicate' | 'rejected' | 'busy' | 'error', reason}.
// blind = true sends without reading the reply (only used if replies can't be read on this device).
// sentAt (this phone's clock when sending) lets the Sheet correct the check-in time if the phone's clock is wrong.
async function sendToSheet(payload, blind) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), 45000);   // the Sheet can take a while when many check in at once
  try {
    const res = await fetch(GOOGLE_SHEET_WEB_APP_URL, { method: 'POST', mode: blind ? 'no-cors' : 'cors', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ ...payload, token: SYNC_TOKEN, sentAt: Date.now() }), referrerPolicy: 'no-referrer', credentials: 'omit', signal: ac.signal });
    if (blind) return { result: 'sent' };
    const text = await res.text();
    try { const j = JSON.parse(text); if (j && typeof j.result === 'string') return { result: j.result, reason: typeof j.reason === 'string' ? j.reason : '' }; } catch (e) {}
    return { result: 'error' };   // not a reply from our script (e.g. a Google error page): try again later
  } finally { clearTimeout(t); }
}
let replyFails = 0;   // requests that failed while online; if replies keep failing, fall back to sending without a reply
async function flushOutbox() {
  if (!outboxReady) return;
  if (flushing) { flushAgain = true; return; }
  if (!syncEnabled() || !navigator.onLine) { refreshSyncPill(); return; }
  flushing = true;
  try {
    const keys = await outboxTx('readonly', s => s.getAllKeys()) || [];
    for (const k of keys) {
      let payload = null;
      try { payload = await unseal(await outboxTx('readonly', s => s.get(k))); } catch (e) {}
      if (!payload) { await outboxTx('readwrite', s => s.delete(k)); continue; }   // unreadable entry, drop it
      const blind = replyFails >= 3;
      let r;
      try { r = await sendToSheet(payload, blind); }
      catch (e) { if (navigator.onLine && e.name !== 'AbortError') replyFails++; console.warn('No reply from the Sheet, will retry', e); break; }
      if (r.result === 'busy' || r.result === 'error') { console.warn('Sheet could not save it yet, will retry', r); break; }   // stays on the device
      replyFails = 0;
      if (r.result === 'sent') {   // sent without a reply: we can't know it arrived, so it goes out 3 times (repeats are ignored)
        payload.blindSends = (payload.blindSends || 0) + 1;
        if (payload.blindSends < 3) { try { const sealed = await seal(payload); await outboxTx('readwrite', s => s.put(sealed, k)); } catch (e) {} continue; }
      }
      await outboxTx('readwrite', s => s.delete(k));   // saved, already there, refused, or sent blind 3 times
      if (r.result === 'rejected') onSheetRejected(payload, r.reason);
      refreshSyncPill();
    }
  } catch (e) { console.error('Outbox flush failed', e); }
  flushing = false; refreshSyncPill();
  if (flushAgain) { flushAgain = false; flushOutbox(); }
}
// The Sheet refused a check-in: say so on screen and mark it in the log, so the screen matches the Sheet.
function onSheetRejected(p, reason) {
  reason = clean(reason, 60) || 'Refused';
  console.warn('Sheet refused the check-in of', p.name, '-', reason);
  if (/^already checked in/i.test(reason)) return;   // they are present already (e.g. checked in on another device)
  const rec = records.find(r => r.ts === p.ts && r.name === p.name);
  const first = String(p.name || '').split(' ')[0];
  let msg;
  if (/photo/i.test(reason)) {
    if (rec) records = records.filter(r => r !== rec);   // no photo: let them check in again
    msg = `${first}, no photo was taken. Please check in again.`;
  } else {
    if (rec) { rec.sync = 'rejected'; rec.reason = reason; }
    msg = /roster/i.test(reason) ? `${first} is not on the roster, so attendance was not saved. Ask an admin to add you.`
        : /office hours/i.test(reason) ? `${first}'s check-in was outside office hours, so it was not saved.`
        : /CAIPSD office/i.test(reason) ? `${first}'s check-in was not saved: please check in in front of the CAIPSD wall.`
        : `${first}'s check-in was not saved (${reason}). Ask an admin.`;
  }
  presentCache.key = ''; streakCache.key = ''; logDirty = true; dataVer++;
  markRecord(p.ts); persist(); renderLog();
  statusHoldUntil = 0;
  setStatus('⚠ ' + msg, 'err', 9000);
}
let lastCounts = '';
function renderLog() {
  const todayN = presentToday().size;
  $('todayPill').textContent = `${todayN} today`;
  $('countPill').textContent = `${records.length} record${records.length === 1 ? '' : 's'}`;
  const counts = todayN + '|' + records.length;
  if (lastCounts && counts !== lastCounts) bump($('todayPill'));
  lastCounts = counts;
  const pulse = highlightTs ? (records.find(r => r.ts === highlightTs) || {}).name : null;
  renderWeek(pulse);
  const body = $('logBody');
  const last = records[records.length - 1], prev = records[records.length - 2];
  if (!logDirty && logShown.count > 0 && records.length === logShown.count + 1 && prev && prev.ts === logShown.lastTs) {
    // the usual case, one new check-in: add one row at the top instead of rebuilding all 150
    body.prepend(logRow(last));
    while (body.children.length > LOG_ROWS) body.lastElementChild.remove();
  } else if (logDirty || records.length !== logShown.count || (last && last.ts) !== logShown.lastTs) {
    body.replaceChildren();
    if (!records.length) body.appendChild(h('tr', null, h('td', { colSpan: 5, class: 'empty-state' }, h('div', { class: 'empty-ico', text: '📋' }), h('div', { text: 'No attendance yet. Students appear here as soon as they blink to check in.' }))));
    else { const frag = document.createDocumentFragment(); for (const r of records.slice(-LOG_ROWS).reverse()) frag.appendChild(logRow(r)); body.appendChild(frag); }
  }
  logDirty = false; logShown = { count: records.length, lastTs: last ? last.ts : 0 };
  highlightTs = 0;
}
const LOG_ROWS = 150;   // newest rows on screen; the CSV export has everything
let logShown = { count: 0, lastTs: 0 }, logDirty = true;
function logRow(r) {
  const av = h('div', { class: 'avatar', text: (r.name || '?').charAt(0).toUpperCase() });
  const row = h('tr', null, h('td', null, h('div', { class: 'namecell' }, av, h('span', { text: r.name }))), h('td', { text: r.section || '' }), h('td', { text: r.date }), h('td', { text: r.time }), h('td', null, r.sync === 'rejected' ? h('span', { class: 'chip-late', text: 'Not saved', title: r.reason || 'Refused by the Sheet' }) : (LATE_AFTER && r.late) ? h('span', { class: 'chip-late', text: 'Late' }) : h('span', { class: 'chip-ok', text: 'Present' })));
  if (r.ts === highlightTs) row.className = 'new';
  return row;
}
async function clearRecords() {
  if (!(await askPin('clear'))) return;   // same passcode as enrolling
  if (!confirm('Delete ALL attendance records on this device? This cannot be undone.')) return;
  records = []; presentCache.key = ''; streakCache.key = ''; dayCache.clear(); dataVer++; renderLog();
  recAll = true; await Promise.all([persist(), clearPhotos()]);
  try { localStorage.removeItem(KEY.rec); } catch (e) {}
}
function exportCSV() {
  let csv = 'Name,Section,Date,Time,Status\n';
  records.forEach(r => { csv += [r.name, r.section, r.date, r.time, r.sync === 'rejected' ? 'Not saved (' + (r.reason || 'refused') + ')' : (LATE_AFTER && r.late) ? 'Late' : 'Present'].map(csvCell).join(',') + '\n'; });
  downloadText(csv, 'attendance_' + localDate(new Date()) + '.csv', 'text/csv');
}

/* ---------- office background check (watch mode) ----------
   Every check-in gets a score for how much the picture around the person looks like the CAIPSD wall
   (1 = same, 0 = nothing alike). MediaPipe's picture model compares it with the office photos in assets/office-bg/
   (the person there is greyed out). The phone only measures; the Sheet records the score and decides
   (Script property BG_MIN). The model loads quietly after the face engine is ready. */
const BG_MODEL = 'https://storage.googleapis.com/mediapipe-models/image_embedder/mobilenet_v3_small/float32/1/mobilenet_v3_small.tflite';
const BG_DIR = 'assets/office-bg/';
const BG_W = 240, BG_H = 320;   // office photos and check-ins are compared at this size (portrait selfie shape)
let bgEmbedder = null, bgRefs = null, bgLoading = false;
function bgGrey(g, x0, y0, x1, y1) { g.fillStyle = '#808080'; g.fillRect(x0, y0, x1 - x0, y1 - y0); }
function bgVector(c) {
  const e = bgEmbedder.embed(c).embeddings[0];
  const v = e.floatEmbedding; let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
  return Float32Array.from(v, x => x / n);
}
function bgImage(src) { return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; }); }
async function loadBackgroundCheck() {
  if (bgEmbedder || bgLoading) return;
  if ((navigator.deviceMemory || 8) <= 1 || (navigator.hardwareConcurrency || 8) <= 2) return;   // very small phones (1 GB): keep memory for face checks
  bgLoading = true;
  try {
    const { ImageEmbedder, FilesetResolver } = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs");
    const fs = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm");
    bgEmbedder = await ImageEmbedder.createFromOptions(fs, { baseOptions: { modelAssetPath: BG_MODEL, delegate: 'CPU' }, runningMode: 'IMAGE' });
    const c = document.createElement('canvas'); c.width = BG_W; c.height = BG_H;
    const g = c.getContext('2d', { willReadFrequently: true }), refs = [];
    // office selfies (person already greyed out)
    for (const n of ['selfie1', 'selfie2', 'selfie3']) {
      const im = await bgImage(BG_DIR + n + '.jpg'); g.drawImage(im, 0, 0, BG_W, BG_H); refs.push(bgVector(c)); await timeout(15);
    }
    // the whole wall, cut into selfie-sized pieces, with the middle greyed out where a person would stand
    for (const n of ['wide1', 'wide2']) {
      const im = await bgImage(BG_DIR + n + '.jpg'), IW = im.naturalWidth, IH = im.naturalHeight;
      for (const hs of [0.5, 0.7, 0.95]) {
        const ch = IH * hs, cw = Math.min(IW, ch * 0.75);
        for (let xi = 0; xi < 4; xi++) {
          g.drawImage(im, (IW - cw) * xi / 3, (IH - ch) * 0.3, cw, ch, 0, 0, BG_W, BG_H);
          bgGrey(g, BG_W * 0.22, BG_H * 0.15, BG_W * 0.80, BG_H);
          refs.push(bgVector(c)); await timeout(15);
        }
      }
    }
    bgRefs = refs;
    console.info('Background check ready (' + refs.length + ' office views)');
  } catch (e) { console.warn('Background check unavailable', e); bgEmbedder = null; bgRefs = null; }
  finally { bgLoading = false; }
}
// The selfie-shaped part of the current camera picture around the face, with the person greyed out
// (face = the person's face box in video pixels). Copied at the moment of the check-in; null = can't tell.
function grabBackground(face) {
  if (!bgRefs || !bgEmbedder || !video || !video.videoWidth || !face) return null;
  try {
    const vw = video.videoWidth, vh = video.videoHeight;
    // landscape cameras are cut to portrait
    let sw = vw, sh = vh;
    if (vw / vh > BG_W / BG_H) sw = vh * BG_W / BG_H; else sh = vw * BG_H / BG_W;
    const sx = Math.max(0, Math.min(vw - sw, face.cx - sw / 2)), sy = Math.max(0, Math.min(vh - sh, face.cy - sh * 0.4));
    const c = document.createElement('canvas'); c.width = BG_W; c.height = BG_H;   // one per check-in, so two people close together never mix
    const g = c.getContext('2d', { willReadFrequently: true }), k = BG_W / sw;
    g.drawImage(video, sx, sy, sw, sh, 0, 0, BG_W, BG_H);
    // grey out the person: the face and everything below it
    bgGrey(g, (face.cx - 0.95 * face.w - sx) * k, (face.cy - 0.9 * face.h - sy) * k, (face.cx + 0.95 * face.w - sx) * k, BG_H);
    return c;
  } catch (e) { console.warn('Background picture failed', e); return null; }
}
// How much that picture looks like the CAIPSD wall (1 = same, 0 = nothing alike). null = can't tell.
function scoreBackground(c) {
  if (!c || !bgRefs || !bgEmbedder) return null;
  try {
    const v = bgVector(c);
    let best = 0;
    for (const r of bgRefs) { let d = 0; for (let i = 0; i < v.length; i++) d += v[i] * r[i]; if (d > best) best = d; }
    return Math.round(Math.max(0, Math.min(1, best)) * 1000) / 1000;
  } catch (e) { console.warn('Background score failed', e); return null; }
}


try { localStorage.removeItem('caipsd.lb'); localStorage.removeItem('caipsd.lbPeriod'); } catch (e) {}   // old leaderboard copy, no longer used

/* ---------- views ---------- */
function setMode(m) {
  mode = m; document.body.dataset.view = m;
  $('tabRecognize').classList.toggle('active', m !== 'enroll');
  $('tabEnroll').classList.toggle('active', m === 'enroll');
  $('enrollControls').classList.toggle('hidden', m !== 'enroll');
  if (m !== 'enroll') { cancelEnrollment(); clearTimeout(enrollIdleTimer); }
  tracks = []; stepsKey = ''; statusHoldUntil = 0; frameState = ''; frameFace = null;
}

/* ---------- warm-up: compile GPU shaders before the first real face ---------- */
function blankCanvas(size) { const c = document.createElement('canvas'); c.width = c.height = size; const g = c.getContext('2d'); g.fillStyle = '#808080'; g.fillRect(0, 0, size, size); return c; }
async function warmDetector() {
  try {
    await faceapi.detectAllFaces(blankCanvas(FAST_INPUT_SIZE), new faceapi.TinyFaceDetectorOptions({ inputSize: FAST_INPUT_SIZE, scoreThreshold: 0.5 }));
    await faceapi.detectFaceLandmarks(blankCanvas(112));
  } catch (e) {}
}
async function warmIdentity() {
  await timeout(50);
  if (engine === 'faceapi') { try { await faceapi.detectAllFaces(blankCanvas(320), new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 })); } catch (e) {} await timeout(30); }
  try { await faceapi.detectAllFaces(blankCanvas(ID_INPUT_SIZE), new faceapi.TinyFaceDetectorOptions({ inputSize: ID_INPUT_SIZE, scoreThreshold: 0.45 })); } catch (e) {}
  await timeout(30);
  try { await faceapi.detectFaceLandmarks(blankCanvas(112)); } catch (e) {}
  await timeout(30);
  await warmDescriptor();
}
async function warmDescriptor() { try { await faceapi.computeFaceDescriptor(blankCanvas(150)); } catch (e) {} }
const timeout = (ms) => new Promise(res => setTimeout(res, ms));

/* ---------- boot ---------- */
let engineReady = false;
async function init() {
  video = $('video'); overlay = $('overlay'); ctx = overlay.getContext('2d');
  const fontCss = $('fontCss'); if (fontCss) fontCss.media = 'all';   // font CSS no longer blocks first paint
  if (!window.crypto || !crypto.subtle) { $('splashStatus').textContent = 'Please open this page over HTTPS.'; return; }
  const t0 = performance.now();

  // face-api.js is deferred (so the splash paints instantly); it keeps loading in the background
  const libP = faceLibLoaded();
  libP.catch(() => {});   // handled below, once the app is on screen

  setProgress(30, 'Starting camera…');
  startCamera();                              // camera and stored data start together (the camera also starts the blink engine)
  const dataP = loadData();

  // Open the app as soon as the stored data is ready; the face engine finishes loading behind it.
  await dataP; dataVer++;
  setProgress(100, 'Ready');
  const minSplash = 450 - (performance.now() - t0);   // just long enough for the logo animation not to flicker
  if (minSplash > 0) await timeout(minSplash);
  renderEnrolledList(); renderLog();
  const tickClock = () => { const n = new Date(); $('clock').textContent = n.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); $('todayDate').textContent = n.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }); };
  tickClock(); setInterval(tickClock, 15000);
  const app = $('app'); app.classList.remove('hidden'); app.classList.add('enter');
  sizeOverlay();
  if (window.ResizeObserver) new ResizeObserver(sizeOverlay).observe($('ring')); else window.addEventListener('resize', sizeOverlay);
  $('splash').classList.add('out'); setTimeout(() => { $('splash').remove(); app.classList.remove('enter'); }, 700);
  unlockAudio();
  outboxReady = true; flushOutbox();   // send anything saved while the device was offline
  // ask the browser never to clear this app's data (enrolled faces, unsent check-ins) when the phone runs low on space
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persisted().then(p => p || navigator.storage.persist()).catch(() => {}); } catch (e) {}
  setTimeout(() => later(pruneOldPhotos), 20000);   // tidy old device photos once things are quiet
  requestAnimationFrame(render);
  if (!camError) setStatus('Starting face engine…', 'wait');

  // ---- face engine (background) ----
  // If the internet drops while it loads, it tries again by itself (instead of staying broken until someone reloads).
  let recogFile = null, backendSet = false;
  for (let attempt = 1; ; attempt++) {
    try {
      await (attempt === 1 ? libP : faceLibLoaded());
      if (!backendSet) { backendSet = true; try { await faceapi.tf.setBackend('webgl'); await faceapi.tf.ready(); } catch (e) { console.warn('WebGL unavailable', e); } }
      // Small models first (they're needed to see a face); the big recognition model is downloaded meanwhile
      // but only set up afterwards, so the two don't fight over the graphics chip.
      if (!recogFile) { recogFile = faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL); recogFile.catch(() => {}); }
      await Promise.all([
        faceapi.nets.tinyFaceDetector.isLoaded || faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68Net.isLoaded || faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL)
      ]);
      break;
    } catch (err) {
      console.warn(`Face engine did not load (try ${attempt})`, err);
      statusHoldUntil = 0;
      setStatus(navigator.onLine ? 'Face engine could not load. Trying again…' : 'No internet: the face engine will load as soon as it is back.', 'err', 600000);
      await retryPause(attempt);
    }
  }
  await Promise.race([warmDetector(), timeout(1500)]);
  engineReady = true;
  statusHoldUntil = 0;
  if (!tracks.length && !camError) setStatus('Look at the camera and blink once.', 'wait');
  else if (camError) setStatus(camError + ' Retrying…', 'err', 600000);
  faLoop();
  loadRecognition(recogFile);
  perfFrom = performance.now() + 6000;   // ignore start-up warm-up when judging speed
}

// The big recognition model: set up after the small ones; downloaded again if that failed.
async function loadRecognition(firstTry) {
  for (let attempt = 1; ; attempt++) {
    try {
      await (attempt === 1 && firstTry ? firstTry : faceapi.nets.faceRecognitionNet.isLoaded || faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL));
      await warmIdentity();   // prepares the exact recognition steps used at check-in, so the first person never hits a freeze
      recogFailed = false; recogReady = true; tracks.forEach(t => { t.name = null; });
      setTimeout(() => later(loadBackgroundCheck), 4000);
      return;
    } catch (err) {
      console.error(`Recognition model did not load (try ${attempt})`, err);
      recogFailed = true;
      await retryPause(attempt);
    }
  }
}
// wait before trying again: until the internet is back, then 5 s, 10 s, 20 s … at most a minute
async function retryPause(attempt) {
  if (!navigator.onLine) await new Promise(res => window.addEventListener('online', res, { once: true }));
  await timeout(Math.min(60000, 5000 * 2 ** Math.min(attempt - 1, 4)));
}
// face-api.js: the page's own script tag the first time; a fresh tag if that download failed
// (a failed script tag never loads again by itself).
let libTag = null;
function faceLibLoaded() {
  if (window.faceapi) return Promise.resolve();
  return new Promise((res, rej) => {
    const first = $('faceLib');
    let el = first;
    if (libTag === 'failed') {
      el = document.createElement('script');
      el.src = first.src; el.integrity = first.integrity; el.crossOrigin = 'anonymous';
      first.removeAttribute('id'); el.id = 'faceLib';
      document.head.appendChild(el);
    }
    libTag = 'loading';
    el.addEventListener('load', () => { libTag = 'ok'; if (window.faceapi) res(); else { libTag = 'failed'; rej(new Error('The face library did not start.')); } }, { once: true });
    el.addEventListener('error', () => { libTag = 'failed'; rej(new Error('Could not load the face library. Check your internet connection.')); }, { once: true });
  });
}

/* ---------- enrollment passcode ----------
   Enrolling (and deleting) students needs a passcode. The CAIPSD passcode is built in (stored only as a salted
   PBKDF2 hash); 'Change enrollment passcode' replaces it on one device. The enroll screen locks again when you leave it
   or after 3 minutes without use. */
const PIN_KEY = 'caipsd_enroll_pin', ENROLL_IDLE_MS = 3 * 60 * 1000;
let pinFails = 0, pinLockedUntil = 0, enrollIdleTimer = 0;
const DEFAULT_PIN = { salt: '61jLDqIKmo4QVbu/cbOJow==', hash: 'I1x/wMSVWixZ47WNrPNuV5U2SLjv0KkWqw5j9O8Os7s=' };   // the CAIPSD passcode, used until it is changed on a device
function loadPin() { try { const v = JSON.parse(localStorage.getItem(PIN_KEY) || 'null'); return v && v.salt && v.hash ? v : DEFAULT_PIN; } catch (e) { return DEFAULT_PIN; } }
async function hashPin(pin, saltB64) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(saltB64), iterations: 150000 }, base, 256);
  return toB64(bits);
}
async function savePin(pin) {
  const salt = toB64(crypto.getRandomValues(new Uint8Array(16)));
  localStorage.setItem(PIN_KEY, JSON.stringify({ salt, hash: await hashPin(pin, salt) }));
}
async function pinMatches(pin) {
  const v = loadPin(); if (!v) return false;
  const got = await hashPin(pin, v.salt);
  let diff = got.length ^ v.hash.length; for (let i = 0; i < got.length && i < v.hash.length; i++) diff |= got.charCodeAt(i) ^ v.hash.charCodeAt(i);
  return diff === 0;
}
function touchEnroll() {
  clearTimeout(enrollIdleTimer);
  if (mode === 'enroll') enrollIdleTimer = setTimeout(() => { if (mode === 'enroll') { setMode('recognize'); setStatus('Enroll screen locked.', 'wait', 2500); } }, ENROLL_IDLE_MS);
}
['pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, () => { if (mode === 'enroll') touchEnroll(); }, { passive: true }));
// kind: 'unlock' (enroll screen), 'clear' (Clear all records) or 'change'
function askPin(kind) {
  return new Promise(resolve => {
    const veil = $('pinVeil'), inp = $('pinInput'), inp2 = $('pinInput2'), msg = $('pinMsg');
    let step = loadPin() ? (kind === 'change' ? 'old' : 'check') : 'new', firstNew = '';
    const show = () => {
      const t = { check: kind === 'clear' ? ['Enter passcode', 'Clearing all attendance records needs the passcode.', 'Continue']
                                          : ['Enter passcode', 'Enrolling students needs the passcode.', 'Unlock'],
                  old: ['Change passcode', 'Enter the current passcode first.', 'Next'],
                  new: ['New passcode', 'Choose a 4–12 digit passcode. It will be needed every time someone enrolls or deletes a student on this device.', 'Save'] }[step];
      $('pinTitle').textContent = t[0]; $('pinText').textContent = t[1]; $('pinOk').textContent = t[2];
      inp.value = ''; inp2.value = ''; inp2.hidden = step !== 'new'; inp.placeholder = step === 'new' ? 'New passcode' : '';
      veil.hidden = false; setTimeout(() => inp.focus(), 30);
    };
    const finish = (ok) => { veil.hidden = true; msg.textContent = ''; $('pinForm').onsubmit = null; $('pinCancel').onclick = null; resolve(ok); };
    $('pinCancel').onclick = () => finish(false);
    $('pinForm').onsubmit = async (e) => {
      e.preventDefault();
      const pin = inp.value.trim();
      if (step === 'new') {
        if (!/^\d{4,12}$/.test(pin)) { msg.textContent = 'Use 4 to 12 digits.'; return; }
        if (inp2.value.trim() !== pin) { msg.textContent = "The two passcodes don't match."; inp2.value = ''; inp2.focus(); return; }
        try { await savePin(pin); } catch (er) { msg.textContent = 'Could not save the passcode.'; return; }
        setStatus(kind === 'change' ? 'Passcode changed.' : 'Passcode saved.', 'ok', 2000);
        finish(true); return;
      }
      const now = Date.now();
      if (now < pinLockedUntil) { msg.textContent = `Too many tries. Wait ${Math.ceil((pinLockedUntil - now) / 1000)} s.`; return; }
      if (!(await pinMatches(pin))) {
        pinFails++; inp.value = '';
        if (pinFails >= 5) { pinFails = 0; pinLockedUntil = Date.now() + 60000; msg.textContent = 'Too many tries. Wait 1 minute.'; }
        else msg.textContent = 'Wrong passcode.';
        return;
      }
      pinFails = 0; msg.textContent = '';
      if (step === 'old') { step = 'new'; show(); return; }
      finish(true);
    };
    msg.textContent = ''; show();
  });
}

$('tabRecognize').addEventListener('click', () => setMode('recognize'));
$('tabEnroll').addEventListener('click', () => { if (mode !== 'enroll') askPin('unlock').then(ok => { if (ok) { setMode('enroll'); touchEnroll(); } }); });
$('btnChangePin').addEventListener('click', () => askPin('change'));
$('btnFlip').addEventListener('click', flipCamera);
$('btnCapture').addEventListener('click', captureEnrollment);
$('btnSaveEnroll').addEventListener('click', saveEnrollmentName);
$('btnCancelEnroll').addEventListener('click', cancelEnrollment);
$('enrollName').addEventListener('keydown', e => { if (e.key === 'Enter') $('enrollSection').focus(); });
$('enrollSection').addEventListener('keydown', e => { if (e.key === 'Enter') saveEnrollmentName(); });
$('btnExport').addEventListener('click', exportCSV);
$('btnClear').addEventListener('click', clearRecords);
$('btnExportWeek').addEventListener('click', exportWeekCSV);
setInterval(() => { if (records && weekInfo().key !== lastWeekKey) renderLog(); }, 60000);   // rolls over at midnight and every Monday
document.addEventListener('pointerdown', unlockAudio, { passive: true });
window.addEventListener('online', flushOutbox);
window.addEventListener('offline', refreshSyncPill);
setInterval(flushOutbox, 60000);   // retry every minute in case the 'online' event is missed
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  lastFrameAt = performance.now();   // the video pauses while hidden; that is not a frozen camera
  if (!mediaStream || !mediaStream.active) startCamera();
});

// Extra deterrent on computers without the kiosk policy (the browser policy is the real lock).
document.addEventListener('contextmenu', e => { if (!e.target.closest('input')) e.preventDefault(); });
document.addEventListener('keydown', e => {
  const k = (e.key || '').toLowerCase(), mod = e.ctrlKey || e.metaKey;
  if (k === 'f12' || (mod && e.shiftKey && (k === 'i' || k === 'j' || k === 'c')) || (mod && (k === 'u' || k === 's'))) { e.preventDefault(); e.stopPropagation(); }
}, true);

// "Install CAIPSD Attendance" button: shown only when this device can install the app and it isn't installed yet
let installEvt = null;
const isInstalled = () => matchMedia('(display-mode: fullscreen)').matches || matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; if (!isInstalled()) $('btnInstall').hidden = false; });
window.addEventListener('appinstalled', () => { installEvt = null; $('btnInstall').hidden = true; setStatus('✓ CAIPSD Attendance installed. Open it from the CAIPSD icon.', 'ok', 4000); });
if (isIOS && !isInstalled()) $('btnInstall').hidden = false;   // iPhone/iPad have no install prompt; the button shows how
$('btnInstall').addEventListener('click', async () => {
  if (installEvt) {
    installEvt.prompt();
    const { outcome } = await installEvt.userChoice.catch(() => ({ outcome: 'dismissed' }));
    if (outcome === 'accepted') $('btnInstall').hidden = true;
    installEvt = null;
  } else if (isIOS) {
    setStatus('To install: tap the Share button, then "Add to Home Screen".', 'wait', 7000);
  } else {
    setStatus('To install: open the browser menu (⋮) and choose "Install CAIPSD Attendance".', 'wait', 7000);
  }
});

// keep the screen on while CAIPSD Attendance is open (re-acquired when the page comes back into view)
let wakeLock = null;
async function keepAwake() {
  if (!('wakeLock' in navigator) || document.hidden || wakeLock) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } catch (e) {}
}
document.addEventListener('visibilitychange', keepAwake);
document.addEventListener('pointerdown', keepAwake, { passive: true });
keepAwake();

// Watchdog: the face engine runs in a loop many times a second. If that loop ever stops (a crashed graphics
// driver, a hung model) while the camera is on screen, the page reloads itself when nobody is at the camera.
let loopBeat = performance.now(), loopSuspect = false;
setInterval(() => {
  const camOn = video && video.srcObject && video.srcObject.active;
  if (!engineReady || document.hidden || !camOn) { loopBeat = Math.max(loopBeat, performance.now() - 5000); loopSuspect = false; return; }
  if (performance.now() - loopBeat < 20000) { loopSuspect = false; return; }
  // seen stopped twice in a row (a phone that only froze for a moment has caught up by the second look)
  if (!loopSuspect) { loopSuspect = true; return; }
  loopSuspect = false; loopBeat = performance.now();
  if (!watchdogAllowed()) return;   // at most one watchdog reload every 10 minutes
  console.error('Face engine loop stopped, reloading');
  reloadWhenFree();
}, 5000);

// Recognition stuck: one recognition step has not finished for 20 s (a hung graphics driver). Faces would still be
// tracked but never named, so reload, even if someone is waiting at the camera (after at most 30 s more).
setInterval(() => {
  if (!idBusy || document.hidden || performance.now() - idStartedAt < 20000) return;
  if (!watchdogAllowed()) return;
  console.error('Face recognition is stuck, reloading');
  setStatus('Face recognition stopped responding. Restarting…', 'err', 15000);
  reloadWhenFree(30000);
}, 5000);

// Long days: the office device stays open for days. Every minute, check that the graphics memory used by the face
// engine is not slowly piling up, and after 12 hours give the app a fresh start when nobody has been at the camera
// for 10 minutes (only when online, so the fresh start can load everything).
const BOOT_AT = Date.now();
let tensorBase = 0;
setInterval(() => {
  if (reloading || mode === 'enroll' || document.hidden) return;
  if (recogReady && window.faceapi) {
    try {
      const n = faceapi.tf.memory().numTensors;
      if (!tensorBase) tensorBase = n;
      else if (n > tensorBase + 1500 && watchdogAllowed()) { console.warn(`Face engine memory grew (${tensorBase} → ${n} tensors), refreshing`); reloadWhenFree(); return; }
    } catch (e) {}
  }
  const quietFor = performance.now() - (Number.isFinite(lastFaceAt) ? lastFaceAt : 0);
  if (Date.now() - BOOT_AT > 12 * 3600e3 && navigator.onLine && quietFor > 10 * 60e3 && !tracks.length) {
    console.info('Running for 12 hours: fresh start while nobody is at the camera');
    reloadWhenFree();
  }
}, 60000);
// at most one automatic recovery reload every 10 minutes (so a device that keeps failing never reload-loops)
function watchdogAllowed() {
  let last = 0; try { last = Number(sessionStorage.getItem('watchdogAt')) || 0; } catch (e) {}
  if (Date.now() - last < 10 * 60 * 1000) return false;
  try { sessionStorage.setItem('watchdogAt', String(Date.now())); } catch (e) {}
  return true;
}
window.addEventListener('unhandledrejection', (e) => console.warn('Unhandled', e.reason));

// keep models and engines on this device after the first visit (faster start, opens offline)
// Auto-update: the office device stays open all day, so check GitHub for a new version every 15 minutes
// and reload into it when nobody is standing at the camera.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) reloadWhenFree(); });
  navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'page-updated') reloadWhenFree(); });
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
    // reg.update() only notices a changed sw.js; the page itself is checked by the service worker
    const checkForUpdate = () => {
      reg.update().catch(() => {});
      if (navigator.serviceWorker.controller && navigator.onLine) navigator.serviceWorker.controller.postMessage({ type: 'check-update', files: [location.pathname].concat(APP_SCRIPT ? [APP_SCRIPT.pathname + APP_SCRIPT.search] : []) });
    };
    setInterval(checkForUpdate, 15 * 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdate(); });
    window.addEventListener('online', checkForUpdate);
  }).catch(e => console.warn('Offline cache unavailable', e)));
}
// reload only when nobody is checking in, enrolling or typing (and the newest check-in has been saved).
// maxWaitMs: for a broken engine, don't wait for an empty camera longer than this (it can't check anyone in anyway).
let reloading = false, reloadTimer = 0, reloadSince = 0, reloadMaxWait = Infinity;
function reloadWhenFree(maxWaitMs) {
  if (reloading) return;
  if (!reloadSince) reloadSince = performance.now();
  if (maxWaitMs) reloadMaxWait = Math.min(reloadMaxWait, maxWaitMs);
  clearTimeout(reloadTimer);   // only one waiting check at a time
  const typing = document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
  const overdue = performance.now() - reloadSince > reloadMaxWait;
  if (mode === 'enroll' || typing || (hadFaceRecently() && !overdue)) { reloadTimer = setTimeout(reloadWhenFree, 5000); return; }
  reloading = true;
  // wait for saves to finish, plus a moment for the newest check-in to reach the on-device outbox
  saveQueue.then(() => timeout(400)).then(() => location.reload());
}
function hadFaceRecently() { return (typeof lastFaceAt === 'number' && performance.now() - lastFaceAt < 8000) || tracks.length > 0; }

init().catch(err => { console.error(err); const sp = $('splashStatus'); if (sp && document.body.contains(sp)) sp.textContent = 'Failed to load: ' + err.message; else setStatus('Face engine failed to load: ' + err.message + ' Reload the page.', 'err', 60000); });
})();
