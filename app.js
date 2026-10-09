'use strict';
/* CAIPSD Attendance: check-in feedback, weekly view, enrollment, records, startup and app features. */

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
function showSuccess(rec, photo) {
  sayWelcome(rec.name.split(' ')[0]);   // first, so the voice starts together with the pop-up
  const box = $('success'), ring = $('ring');
  $('sTitle').textContent = `Thank you, ${rec.name.split(' ')[0]}!`;
  const tm = new Date(rec.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  $('sMeta').textContent = `Attendance marked at ${tm}` + (rec.late ? ' (late)' : '') + (rec.section ? `, ${rec.section}` : '');
  const st = weekStats().rows.find(r => r.name === rec.name);
  $('sWeek').textContent = st && st.pct !== null ? `This week: ${st.count} of ${st.denom} day${st.denom === 1 ? '' : 's'}, ${st.pct}%` : '';
  const run = streaks().get(rec.name) || 0;
  $('sStreak').textContent = run >= 2 ? `🔥 ${run} days in a row` + (run % 5 === 0 ? '. Great work!' : '') : '';
  box.classList.remove('show'); void box.offsetWidth; box.classList.add('show');
  ring.classList.add('flash', 'success-on');
  clearTimeout(successTimer);
  successTimer = setTimeout(() => { box.classList.remove('show'); ring.classList.remove('flash', 'success-on'); }, SUCCESS_HOLD_MS);
  if (navigator.vibrate) navigator.vibrate([60, 40, 90]);
  chime();
}

/* ---------- attendance streaks (consecutive weekdays present; weekends are skipped) ---------- */
let streakCache = { key: '', map: new Map() };
function prevWeekday(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1);
  while (x.getDay() === 0 || x.getDay() === 6) x.setDate(x.getDate() - 1);
  return x;
}
function streaks() {
  const now = new Date(), key = now.toDateString() + '|' + records.length;
  if (streakCache.key === key) return streakCache.map;
  const days = new Map();
  for (const r of records) { if (!days.has(r.name)) days.set(r.name, new Set()); days.get(r.name).add(new Date(r.ts).toDateString()); }
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()), weekend = today.getDay() === 0 || today.getDay() === 6;
  const map = new Map();
  for (const [name, set] of days) {
    // today only extends the streak once they check in; not checking in yet doesn't break it
    let d = (!weekend && set.has(today.toDateString())) ? today : prevWeekday(today), n = 0;
    while (set.has(d.toDateString())) { n++; d = prevWeekday(d); }
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
function weekStats() {
  const w = weekInfo(), seen = new Map(), daily = [0, 0, 0, 0, 0];
  for (const r of records) {
    if (r.ts < w.start || r.ts >= w.end) continue;
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

  // per-student rows
  const list = $('weekList'); list.replaceChildren();
  const runs = streaks();
  if (!st.rows.length) { list.appendChild(h('div', { class: 'empty', text: 'Enroll students to see their weekly attendance here.' })); return; }
  for (const r of st.rows) {
    const dots = h('div', { class: 'dots' });
    r.days.forEach((v, i) => dots.appendChild(h('span', { class: 'dot ' + v, text: DAY_LETTER[i], title: `${DAY_SHORT[i]}: ${{ p: 'Present', a: 'Absent', t: 'Not checked in yet', f: 'Upcoming' }[v]}` })));
    const tone = r.pct === null ? 'na' : r.pct >= 75 ? 'hi' : r.pct >= 50 ? 'mid' : 'lo';
    const row = h('div', { class: 'wrow' + (r.name === pulseName ? ' pulse' : '') },
      h('span', { class: 'avatar', text: r.name.charAt(0).toUpperCase() }),
      h('div', { class: 'wname-box' }, h('b', { text: r.name }), h('small', null, `${r.section ? r.section + ', ' : ''}${r.count} of ${r.denom || 0} day${r.denom === 1 ? '' : 's'}`,
        (runs.get(r.name) || 0) >= 2 ? h('span', { class: 'streak', text: `🔥 ${runs.get(r.name)}`, title: `${runs.get(r.name)} days in a row` }) : null)),
      dots,
      h('span', { class: 'pct ' + tone, text: r.pct === null ? '–' : r.pct + '%' }));
    list.appendChild(row);
  }
}
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
  capturedDescriptorForSave = null; $('nameSection').classList.add('hidden');
  tracks.forEach(t => { t.name = null; });
  renderEnrolledList(); renderLog(); setStatus(`${name} enrolled.`, 'ok', 1500);
  await persist();
}
function cancelEnrollment() { capturedDescriptorForSave = null; $('nameSection').classList.add('hidden'); }
async function deleteEnrollment(id) {
  const e = enrollments.find(x => x.id === id); if (!e) return;
  if (!confirm(`Remove ${e.name} and their face data?`)) return;
  enrollments = enrollments.filter(x => x.id !== id);
  tracks.forEach(t => { t.name = null; });
  renderEnrolledList(); renderLog(); await persist();
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
function presentToday() {
  const today = new Date().toLocaleDateString(), key = today + '|' + records.length;
  if (presentCache.key !== key) presentCache = { key, set: new Set(records.filter(r => r.date === today).map(r => r.name)) };
  return presentCache.set;
}
function capturePhoto() {
  try {
    const w = 320, ratio = (video.videoHeight / video.videoWidth) || 0.75;
    const c = document.createElement('canvas'); c.width = w; c.height = Math.round(w * ratio);
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.6);
  } catch (e) { return null; }
}
const later = (fn) => setTimeout(() => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 700 }) : fn()), 350);
function isLate(d) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(LATE_AFTER || ''); if (!m) return false;
  return d.getHours() * 60 + d.getMinutes() > (+m[1]) * 60 + (+m[2]);
}
function recordAttendance(name) {
  const now = new Date(), enr = enrollments.find(e => e.name === name);
  const photo = capturePhoto();
  const rec = { name, section: enr ? enr.section : '', date: now.toLocaleDateString(), time: now.toLocaleTimeString(), ts: now.getTime(), late: isLate(now) };
  records.push(rec); highlightTs = rec.ts; presentCache.key = '';
  later(() => { renderLog(); persist(); if (photo) putPhoto(rec.ts, photo); });   // after the thank-you animation starts; the photo stays on-device and goes to the Sheet
  if (syncEnabled()) {
    const payload = { ...rec, status: rec.late ? 'Late' : 'On time', token: SYNC_TOKEN }; if (photo) payload.image = photo;
    queueSync(payload);
  }
  return { rec, photo };
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
  const body = $('logBody'); body.replaceChildren();
  if (!records.length) { body.appendChild(h('tr', null, h('td', { colSpan: 5, class: 'empty-state' }, h('div', { class: 'empty-ico', text: '📋' }), h('div', { text: 'No attendance yet. Students appear here as soon as they blink to check in.' })))); return; }
  for (const r of records.slice().reverse().slice(0, 150)) {   // newest 150 rows on screen; CSV export has everything
    const av = h('div', { class: 'avatar', text: (r.name || '?').charAt(0).toUpperCase() });
    const row = h('tr', null, h('td', null, h('div', { class: 'namecell' }, av, h('span', { text: r.name }))), h('td', { text: r.section || '' }), h('td', { text: r.date }), h('td', { text: r.time }), h('td', null, r.late ? h('span', { class: 'chip-late', text: 'Late' }) : h('span', { class: 'chip-ok', text: 'Present' })));
    if (r.ts === highlightTs) row.className = 'new';
    body.appendChild(row);
  }
  highlightTs = 0;
}
async function clearRecords() {
  if (!confirm('Delete ALL attendance records on this device? This cannot be undone.')) return;
  records = []; presentCache.key = ''; streakCache.key = ''; renderLog(); await Promise.all([persist(), clearPhotos()]);
}
function exportCSV() {
  let csv = 'Name,Section,Date,Time,Status\n';
  records.forEach(r => { csv += [r.name, r.section, r.date, r.time, r.late ? 'Late' : 'On time'].map(csvCell).join(',') + '\n'; });
  downloadText(csv, 'attendance_' + localDate(new Date()) + '.csv', 'text/csv');
}

/* ---------- views ---------- */
function setMode(m) {
  mode = m; document.body.dataset.view = m;
  $('tabRecognize').classList.toggle('active', m !== 'enroll');
  $('tabEnroll').classList.toggle('active', m === 'enroll');
  $('enrollControls').classList.toggle('hidden', m !== 'enroll');
  if (m !== 'enroll') cancelEnrollment();
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
  const libEl = $('faceLib');
  const libP = new Promise((res, rej) => {
    if (window.faceapi) return res();
    libEl.addEventListener('load', () => res());
    libEl.addEventListener('error', () => rej(new Error('Could not load the face library. Check your internet connection.')));
  });
  libP.catch(() => {});   // handled below, once the app is on screen

  setProgress(30, 'Starting camera…');
  const camP = startCamera();                 // camera and stored data start together
  const dataP = loadData();
  camP.then(ok => { if (ok) loadMediapipe(); });   // fast blink engine (skipped if the camera is blocked)

  // Open the app as soon as the stored data is ready; the face engine finishes loading behind it.
  await dataP;
  setProgress(100, 'Ready');
  const minSplash = 450 - (performance.now() - t0);   // just long enough for the logo animation not to flicker
  if (minSplash > 0) await timeout(minSplash);
  renderEnrolledList(); renderLog();
  $('appVersion').textContent = 'v' + APP_VERSION;
  const tickClock = () => { const n = new Date(); $('clock').textContent = n.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); $('todayDate').textContent = n.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }); };
  tickClock(); setInterval(tickClock, 15000);
  const app = $('app'); app.classList.remove('hidden'); app.classList.add('enter');
  sizeOverlay();
  if (window.ResizeObserver) new ResizeObserver(sizeOverlay).observe($('ring')); else window.addEventListener('resize', sizeOverlay);
  $('splash').classList.add('out'); setTimeout(() => { $('splash').remove(); app.classList.remove('enter'); }, 700);
  unlockAudio();
  outboxReady = true; flushOutbox();   // send anything saved while the device was offline
  requestAnimationFrame(render);
  if (!camError) setStatus('Starting face engine…', 'wait');

  // ---- face engine (background) ----
  await libP;
  try { await faceapi.tf.setBackend('webgl'); await faceapi.tf.ready(); } catch (e) { console.warn('WebGL unavailable', e); }
  // Small models first (they're needed to see a face); the big recognition model is downloaded meanwhile
  // but only set up afterwards, so the two don't fight over the graphics chip.
  const recogFile = faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
  recogFile.catch(() => {});
  await Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
    faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL)
  ]);
  await Promise.race([warmDetector(), timeout(1500)]);
  engineReady = true;
  if (!tracks.length && !camError) setStatus('Look at the camera and blink once.', 'wait');
  faLoop();
  recogFile
    .then(warmIdentity)   // prepares the exact recognition steps used at check-in, so the first person never hits a freeze
    .then(() => { recogReady = true; tracks.forEach(t => { t.name = null; }); })
    .catch(err => { console.error('Recognition model failed', err); recogFailed = true; });
  perfFrom = performance.now() + 6000;   // ignore start-up warm-up when judging speed
}

$('tabRecognize').addEventListener('click', () => setMode('recognize'));
$('tabEnroll').addEventListener('click', () => setMode('enroll'));
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
document.addEventListener('visibilitychange', () => { if (!document.hidden && mediaStream && !mediaStream.active) startCamera(); });

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

// keep models and engines on this device after the first visit (faster start, opens offline)
// Auto-update: the office device stays open all day, so check GitHub for a new version every 15 minutes
// and reload into it when nobody is standing at the camera.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) reloadWhenFree(); });
  navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'page-updated') reloadWhenFree(); });
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
    setInterval(() => reg.update().catch(() => {}), 15 * 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  }).catch(e => console.warn('Offline cache unavailable', e)));
}
// reload only when nobody is checking in, enrolling or typing (and the newest check-in has been saved)
let reloading = false;
function reloadWhenFree() {
  if (reloading) return;
  const typing = document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
  if (hadFaceRecently() || mode === 'enroll' || typing) { setTimeout(reloadWhenFree, 5000); return; }
  reloading = true;
  saveQueue.then(() => location.reload());
}
function hadFaceRecently() { return (typeof lastFaceAt === 'number' && performance.now() - lastFaceAt < 8000) || tracks.length > 0; }

init().catch(err => { console.error(err); const sp = $('splashStatus'); if (sp && document.body.contains(sp)) sp.textContent = 'Failed to load: ' + err.message; else setStatus('Face engine failed to load: ' + err.message + ' Reload the page.', 'err', 60000); });
