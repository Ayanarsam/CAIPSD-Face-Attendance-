'use strict';
/* CAIPSD Attendance: offline outbox and sending check-ins to the Google Sheet. */

/* ---------- offline sync: every check-in waits in an encrypted outbox until the Sheet receives it ---------- */
let outboxCount = 0, flushing = false, flushAgain = false, outboxReady = false;   // ready once the device key has loaded
function syncEnabled() { return GOOGLE_SHEET_WEB_APP_URL.startsWith('https://script.google.com/macros/s/'); }
function outboxTx(txMode, fn) {
  return openDB().then(db => new Promise((res, rej) => { const tx = db.transaction('outbox', txMode); const out = fn(tx.objectStore('outbox')); tx.oncomplete = () => res(out && out.result); tx.onerror = () => rej(tx.error); }));
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
function sendToSheet(payload) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), 20000);
  return fetch(GOOGLE_SHEET_WEB_APP_URL, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ ...payload, token: SYNC_TOKEN }), referrerPolicy: 'no-referrer', credentials: 'omit', signal: ac.signal })
    .finally(() => clearTimeout(t));
}
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
      try { await sendToSheet(payload); }          // resolves once the request reaches Google
      catch (e) { console.warn('Still offline, will retry', e); break; }
      await outboxTx('readwrite', s => s.delete(k));
      refreshSyncPill();
    }
  } catch (e) { console.error('Outbox flush failed', e); }
  flushing = false; refreshSyncPill();
  if (flushAgain) { flushAgain = false; flushOutbox(); }
}
