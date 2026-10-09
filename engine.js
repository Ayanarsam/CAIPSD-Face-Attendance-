'use strict';
/* CAIPSD Attendance: camera, face tracking, blink detection, recognition and the on-screen overlay. */

/* ---------- camera ---------- */
async function startCamera() {
  stopCamera();
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } }, audio: false });
    video.srcObject = mediaStream;
    video.classList.toggle('mirror', facing === 'user');
    await new Promise(res => { if (video.readyState >= 1) res(); else video.onloadedmetadata = res; });
    video.play().catch(() => {});
    camError = '';
    setStatus(engineReady ? 'Camera ready. Look at the camera.' : 'Starting face engine…', 'wait');
    return true;
  } catch (err) {
    camError = err.name === 'NotAllowedError' ? 'Camera blocked. Allow camera access in the browser settings, then reload.' : 'Camera error: ' + err.message;
    setStatus(camError, 'err', 600000);   // stays on screen until fixed
    return false;
  }
}
let camError = '';
function stopCamera() { if (mediaStream) mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
async function flipCamera() { facing = facing === 'user' ? 'environment' : 'user'; tracks = []; if (await startCamera() && !faceLandmarker) loadMediapipe(); }

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
async function loadMediapipe() {
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
}

/* Engine A (until MediaPipe is ready): face-api box + 68 landmarks every frame.
   Identity is computed in the same pass only when a face actually needs it. */
let hadFace = false, faScan = 0, faWide = false, faMiss = 0;
async function faLoop() {
  if (engine !== 'faceapi') return;
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
function needsIdentity(t) {
  if (mode === 'enroll') return tracks.length > 0 && t - lastEnrollIdAt > 250;
  return tracks.some(tr => t - tr.lastSeen < 300 && (tr.name === null || (tr.name === 'Unknown' && t - tr.lastIdAt > (tr.unknownHits >= 3 ? 1200 : ID_RETRY_MS)) || t - tr.lastIdAt > ID_REVERIFY_MS));
}
let engineFails = 0;
function engineOk() { engineFails = 0; }
function engineFailed(e) {
  if (++engineFails === 40) {   // ~40 failures in a row: the engine is broken, not just one bad frame
    console.error('Face engine keeps failing, restarting', e);
    setStatus('Face engine stopped working. Restarting…', 'err', 15000);
    reloadWhenFree();
  }
}
let idCost = 120, idNextAt = 0;
async function runIdentity() {
  if (performance.now() < idNextAt) return;
  idBusy = true; const t0 = performance.now();
  try {
    const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: idInputSize(), scoreThreshold: 0.45 });
    // Close-up first: the blink engine already knows where the face is, so recognise a crop around it.
    // The face then fills the picture: found reliably from further away, and the result matches enrollments.
    let done = false;
    const tr = pickIdentityTrack(performance.now());
    if (tr && cropFace(tr)) {
      const cd = await faceapi.detectAllFaces(idCanvas, opts).withFaceLandmarks().withFaceDescriptors();
      if (cd.length) {
        let big = cd[0]; for (const d of cd) if (d.detection.box.width > big.detection.box.width) big = d;
        if (mode === 'enroll') { lastEnrollIdAt = performance.now(); pendingEnrollDescriptor = big.descriptor; }
        identifyTrack(tr, big.descriptor, performance.now());
        done = true;
      }
    }
    if (!done) {   // no close-up result: fall back to the whole picture, as before
      const dets = await faceapi.detectAllFaces(video, opts).withFaceLandmarks().withFaceDescriptors();
      applyIdentity(dets, performance.now());
    }
    engineOk();
  } catch (e) { console.warn('Identity pass failed', e); engineFailed(e); }
  idCost = idCost * 0.7 + (performance.now() - t0) * 0.3;
  idNextAt = performance.now() + Math.min(600, idCost * 0.8);   // let the blink engine breathe between identity passes
  idBusy = false;
}
// the face that most needs identifying (unknown first, then the biggest)
function pickIdentityTrack(t) {
  let best = null;
  for (const tr of tracks) {
    if (!tr.target || t - tr.lastSeen > 300) continue;
    const due = mode === 'enroll' || tr.name === null || (tr.name === 'Unknown' && t - tr.lastIdAt > (tr.unknownHits >= 3 ? 1200 : ID_RETRY_MS)) || t - tr.lastIdAt > ID_REVERIFY_MS;
    if (!due) continue;
    if (!best || (best.name !== null && tr.name === null) || ((best.name === null) === (tr.name === null) && tr.target.w > best.target.w)) best = tr;
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
  // an identified face keeps its name through one bad re-check
  if (cand === 'Unknown' && tr.name && tr.name !== 'Unknown' && tr.unknownHits < 1) { tr.unknownHits++; tr.lastIdAt = t; return; }
  tr.unknownHits = cand === 'Unknown' ? tr.unknownHits + 1 : 0;
  tr.name = cand; tr.lastIdAt = t;
}
function applyIdentity(dets, t) {
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
    identifyTrack(tr, det.descriptor, t);
  }
}

/* Shared: follow faces across frames, read both eyes, latch blinks, decide what to show. */
function updateTracks(faces, t) {
  const used = new Set();
  let primary = null;
  for (const f of faces) {
    const ob = f.ob, bx = ob.cx, by = ob.cy;
    let tr = null, best = Math.max(60, ob.w * TRACK_MATCH_RATIO);
    for (const c of tracks) { if (used.has(c)) continue; const d = Math.hypot(c.bx - bx, c.by - by); if (d < best) { best = d; tr = c; } }
    if (!tr && faces.length === 1 && tracks.length === 1 && !used.has(tracks[0])) tr = tracks[0];   // one person: never lose them on a fast move
    if (!tr) { tr = { id: ++trackSeq, name: null, unknownHits: 0, lastIdAt: 0, seenOpen: false, closed: false, blinkAt: 0, flashAt: -1e9, base: 0, alpha: 0.35, disp: null, vx: 0, vy: 0, tT: 0 }; tracks.push(tr); }
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
      tr.closed = true;
      if (tr.seenOpen) { tr.blinkAt = t; tr.flashAt = t; }   // counted the moment the eyes close
    } else if (tr.closed && blink < openT) tr.closed = false;

    // what this face should show
    let tone = 'scan', label = 'Identifying…', state = 'scan';
    if (!recogReady) { label = recogFailed ? 'Model error' : 'Loading…'; state = 'loading'; }
    else if (mode === 'enroll') { tone = 'enroll'; label = tr.name && tr.name !== 'Unknown' ? tr.name + ' (enrolled)' : 'New face'; state = 'enroll'; }
    else if (tr.name === 'Unknown' && tr.unknownHits >= 2) { tone = 'unknown'; label = 'Not enrolled'; state = 'unknown'; }
    else if (tr.name && tr.name !== 'Unknown') {
      tone = 'ok'; label = tr.name;
      if (presentToday().has(tr.name)) { state = 'done'; label = tr.name + '  ✓'; }
      else if (tr.blinkAt && t - tr.blinkAt < BLINK_WINDOW_MS) {
        if (tr.closed && t - tr.blinkAt < PHOTO_WAIT_MS) state = 'blinked';   // wait a moment so the photo has open eyes
        else {
          const { rec, photo } = recordAttendance(tr.name);
          tr.blinkAt = 0; state = 'recorded'; label = tr.name + '  ✓';
          showSuccess(rec, photo);
        }
      } else state = 'blink';
    }
    const ci = 0, cj = f.src === 'mp' ? 8 : 3;
    tr.target = { cx: ob.cx, cy: ob.cy, w: ob.w, h: ob.h, a: ob.a, tone, label, prompt: state === 'blink' || state === 'scan', eyes: [eyeRect(f.lp, sL, ci, cj), eyeRect(f.rp, sR, ci, cj)], outline: f.outline, closedOutline: f.closed };
    tr.state = state;
    if (!primary || ob.w > primary.w) primary = { w: ob.w, tr };
  }
  tracks = tracks.filter(c => t - c.lastSeen < TRACK_TTL_MS);

  if (!primary) {
    setFrameState('idle', false);
    if (mode === 'enroll') pendingEnrollDescriptor = null;
    setSteps('on', '', '');
    setStatus(mode === 'enroll' ? 'Show your face to the camera.' : 'Look at the camera and blink once.', 'wait');
    return;
  }
  const p = primary.tr, blinked = p.blinkAt && t - p.blinkAt < BLINK_WINDOW_MS ? 'done' : 'on';
  setFrameState({ done: 'ok', recorded: 'ok', blinked: 'ok', enroll: 'ok', unknown: 'err' }[p.state] || 'scan', true);
  switch (p.state) {
    case 'loading': setSteps('done', 'on', blinked); setStatus(recogFailed ? 'Recognition model failed to load. Reload the page.' : 'Loading face recognition…', recogFailed ? 'err' : 'wait'); break;
    case 'enroll': setStatus('Face detected. Ready to capture.', 'ok'); break;
    case 'scan': setSteps('done', 'on', blinked); setStatus(blinked === 'done' ? 'Blink received. Identifying…' : 'Identifying… you can blink now.', 'wait'); break;
    case 'unknown': setSteps('done', 'on', ''); setStatus('Face not recognised. Ask an admin to enroll you.', 'err'); break;
    case 'blink': setSteps('done', 'done', 'on'); setStatus(`${p.name}, blink once to confirm.`, 'wait'); break;
    case 'blinked': setSteps('done', 'done', 'done'); setStatus(`Blink received, ${p.name}…`, 'ok'); break;
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
