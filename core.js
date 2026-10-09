'use strict';
/* CAIPSD Attendance: shared state, helpers and encrypted on-device storage. */

let mode = 'recognize';                 // 'recognize' | 'enroll'
let enrollments = [];                   // [{id, name, section, descriptor: Float32Array}]
let records = [];
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
    .map(r => ({ name: clean(r.name, 60), section: clean(r.section, 20), date: clean(r.date, 40), time: clean(r.time, 40), ts: r.ts, late: r.late === true }))
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
function openDB() {
  return dbP || (dbP = new Promise((res, rej) => {
    const r = indexedDB.open('caipsd', 3);
    r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('k')) d.createObjectStore('k'); if (!d.objectStoreNames.contains('photos')) d.createObjectStore('photos'); if (!d.objectStoreNames.contains('outbox')) d.createObjectStore('outbox'); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
}
// Check-in photos live in IndexedDB (big quota), each one encrypted with the device key.
const photoCache = new Map();
async function putPhoto(ts, dataUrl) {
  try {
    const db = await openDB(), val = await seal({ img: dataUrl });
    await new Promise((res, rej) => { const tx = db.transaction('photos', 'readwrite'); tx.objectStore('photos').put(val, ts); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    photoCache.set(ts, dataUrl);
  } catch (e) { console.warn('Photo save failed', e); }
}
async function clearPhotos() {
  photoCache.clear();
  try { const db = await openDB(); await new Promise((res, rej) => { const tx = db.transaction('photos', 'readwrite'); tx.objectStore('photos').clear(); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); } catch (e) {}
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

function persist() {
  saveQueue = saveQueue.then(async () => {
    localStorage.setItem(KEY.enr, await seal(enrollments.map(x => ({ id: x.id, name: x.name, section: x.section, descriptor: Array.from(x.descriptor) }))));
    localStorage.setItem(KEY.rec, await seal(records));
  }).catch(err => {
    console.error('Save failed', err);
    if (err && (err.name === 'QuotaExceededError' || /quota/i.test(err.message || ''))) setStatus('This device’s storage is full. Export the CSV, then use Clear all to free space (the Google Sheet keeps everything).', 'err', 30000);
  });
  return saveQueue;
}
async function loadData() {
  deviceKey = await getDeviceKey();
  let e = null, r = null;
  try { e = await unseal(localStorage.getItem(KEY.enr)); r = await unseal(localStorage.getItem(KEY.rec)); } catch (err) { console.warn('Stored data unreadable', err); }
  if (!e && !r && (localStorage.getItem(KEY.oldEnr) || localStorage.getItem(KEY.oldRec))) {
    // migrate data from the original version (drop stored photos), then delete the plaintext copy
    try {
      e = JSON.parse(localStorage.getItem(KEY.oldEnr) || '[]');
      const oldRecs = JSON.parse(localStorage.getItem(KEY.oldRec) || '[]');
      for (const x of oldRecs) if (safeImg(x.image) && Number.isFinite(x.ts)) await putPhoto(x.ts, x.image);
      r = oldRecs.map(x => ({ name: x.name, section: x.section, date: x.date, time: x.time, ts: x.ts }));
      enrollments = sanitizeEnrollments(e); records = sanitizeRecords(r);
      await persist();
      localStorage.removeItem(KEY.oldEnr); localStorage.removeItem(KEY.oldRec);
      return;
    } catch (err) { console.warn('Migration failed', err); }
  }
  enrollments = sanitizeEnrollments(e); records = sanitizeRecords(r);
}
