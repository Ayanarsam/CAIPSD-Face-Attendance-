// Browser tests for CAIPSD Attendance. Run with: npm test
// Uses the real app files, the real face engine (from node_modules) and a test camera video made from tests/face.png.
// The Google Sheet is replaced by a fake that records what it receives. Nothing is sent anywhere real.
import { chromium } from 'playwright';
import http from 'http'; import fs from 'fs'; import path from 'path'; import os from 'os';
import { PNG } from 'pngjs';

const ROOT = path.resolve('.'), NM = path.resolve('node_modules');
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

// ---- static server for the repo ----
let serverDelay = 0;
const server = http.createServer(async (req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end(); }
  if (serverDelay && p === '/index.html') await new Promise(r => setTimeout(r, serverDelay));
  res.setHeader('content-type', TYPES[path.extname(f)] || 'application/octet-stream');
  res.end(fs.readFileSync(f));
}).listen(0);
const BASE = `http://localhost:${server.address().port}/`;

// ---- test camera video (Y4M) from tests/face.png ----
function makeVideo() {
  const png = PNG.sync.read(fs.readFileSync(path.join(ROOT, 'tests/face.png')));
  const W = png.width, H = png.height, Y = Buffer.alloc(W * H), U = Buffer.alloc(W * H / 4), V = Buffer.alloc(W * H / 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    Y[y * W + x] = Math.max(0, Math.min(255, 0.257 * r + 0.504 * g + 0.098 * b + 16));
    if (y % 2 === 0 && x % 2 === 0) { const j = (y / 2) * (W / 2) + x / 2; U[j] = Math.max(0, Math.min(255, -0.148 * r - 0.291 * g + 0.439 * b + 128)); V[j] = Math.max(0, Math.min(255, 0.439 * r - 0.368 * g - 0.071 * b + 128)); }
  }
  const file = path.join(os.tmpdir(), 'caipsd-test-face.y4m'), out = fs.openSync(file, 'w');
  fs.writeSync(out, `YUV4MPEG2 W${W} H${H} F30:1 Ip A1:1 C420jpeg\n`);
  for (let k = 0; k < 30; k++) { fs.writeSync(out, 'FRAME\n'); fs.writeSync(out, Y); fs.writeSync(out, U); fs.writeSync(out, V); }
  fs.closeSync(out); return file;
}
const video = makeVideo();

// ---- browser ----
const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM || undefined,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
});
// engine: load the real face engine (slow without a graphics card, so only the recognition test uses it)
// offlineCache: let the app's service worker run (only the offline test needs it)
async function newPage({ camera = true, sheet = [], sheetDelay = 0, engine = false, offlineCache = false } = {}) {
  const ctx = await browser.newContext({ permissions: camera ? ['camera'] : [], viewport: { width: 1200, height: 900 }, serviceWorkers: offlineCache ? 'allow' : 'block' });
  // face library and models come from node_modules (same versions as the live site); MediaPipe and fonts are blocked
  await ctx.route('https://cdn.jsdelivr.net/**', r => {
    const u = r.request().url(); let f = null;
    if (u.includes('/face-api.js@0.22.2/dist/face-api.min.js')) f = path.join(NM, 'face-api.js/dist/face-api.min.js');
    else if (u.includes('/@vladmandic/face-api@1.7.13/model/')) f = path.join(NM, '@vladmandic/face-api/model', u.split('/model/')[1]);
    if (engine && f && fs.existsSync(f)) return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': f.endsWith('.js') ? 'application/javascript' : 'application/octet-stream' }, body: fs.readFileSync(f) });
    return r.abort();
  });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com|storage\.googleapis\.com/, r => r.abort());
  await ctx.route('https://script.google.com/**', async r => { if (sheetDelay) await new Promise(x => setTimeout(x, sheetDelay)); try { sheet.push(JSON.parse(r.request().postData())); } catch (e) {} r.fulfill({ status: 200, body: 'ok' }); });
  const page = await ctx.newPage();
  page.errors = []; page.on('pageerror', e => { if (!/Could not load the face library/.test(e.message)) page.errors.push(e.message); });
  page.on('console', m => { if (/Refused to|Content Security Policy/i.test(m.text())) page.errors.push(m.text()); });
  return { ctx, page };
}
const appVisible = (page, ms = 15000) => page.waitForFunction(() => !document.getElementById('app').classList.contains('hidden'), null, { timeout: ms });
const status = (page) => page.textContent('#statusText');

// ---- tests ----
const results = []; let failed = 0;
async function test(name, fn) {
  const t0 = Date.now();
  try { await fn(); results.push(`  ✓ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); }
  catch (e) { failed++; results.push(`  ✗ ${name}\n      ${e.message.split('\n')[0]}`); }
  console.log(results[results.length - 1]);
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

await test('opens quickly with the security rule on, no errors, version shown', async () => {
  const { ctx, page } = await newPage();
  const t0 = Date.now(); await page.goto(BASE, { waitUntil: 'commit' }); await appVisible(page);
  const ms = Date.now() - t0; await page.waitForTimeout(1500);
  const ver = await page.evaluate(() => APP_VERSION), shown = await page.textContent('#appVersion');
  assert(shown === 'v' + ver, `version badge shows "${shown}", expected "v${ver}"`);
  assert(ms < 8000, `app took ${ms} ms to appear`);
  assert(!page.errors.length, 'page errors: ' + page.errors.join(' | '));
  await ctx.close();
});

await test('camera blocked: the message stays on screen', async () => {
  const { ctx, page } = await newPage();
  await page.addInitScript(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })); });
  await page.goto(BASE); await appVisible(page); await page.waitForTimeout(2500);
  const s = await status(page); assert(/Camera blocked/.test(s), `status was "${s}"`);
  await ctx.close();
});

await test('check-ins reach the Google Sheet, even two in a row while it is slow', async () => {
  const sheet = []; const { ctx, page } = await newPage({ sheet, sheetDelay: 1500 });
  await page.goto(BASE); await appVisible(page); await page.waitForTimeout(800);
  await page.evaluate(() => { recordAttendance('Test Student A'); setTimeout(() => recordAttendance('Test Student B'), 300); });
  await page.waitForTimeout(6000);
  const names = sheet.map(x => x.name), left = await page.evaluate(() => outboxTx('readonly', s => s.count()));
  assert(names.includes('Test Student A') && names.includes('Test Student B'), 'Sheet received: ' + JSON.stringify(names));
  assert(sheet.every(x => x.token && x.status && x.date && x.time), 'a check-in was missing fields');
  assert(left === 0, `${left} check-in(s) still waiting`);
  await ctx.close();
});

await test('works offline: reopens without internet, saves check-ins, sends them when back online', async () => {
  const sheet = []; const { ctx, page } = await newPage({ sheet, offlineCache: true });
  await page.goto(BASE); await appVisible(page);
  await page.evaluate(() => navigator.serviceWorker.ready); await page.reload(); await appVisible(page); await page.waitForTimeout(1500);
  await ctx.setOffline(true);
  await page.reload({ waitUntil: 'commit' }); await appVisible(page, 15000);
  await page.waitForTimeout(800);
  await page.evaluate(() => recordAttendance('Offline Student')); await page.waitForTimeout(1500);
  const pill = await page.textContent('#syncPill');
  assert(/Offline · 1 saved/.test(pill), `sync pill said "${pill}"`);
  assert(!sheet.length, 'something was sent while offline');
  await ctx.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online'))); await page.waitForTimeout(2500);
  assert(sheet.some(x => x.name === 'Offline Student'), 'offline check-in was not sent after reconnecting');
  await ctx.close();
});

await test('restarts itself if the face engine keeps failing', async () => {
  const { ctx, page } = await newPage();
  await page.goto(BASE); await appVisible(page); await page.waitForTimeout(9000);   // past the 'someone just arrived' window
  let reloaded = false; page.on('framenavigated', () => { reloaded = true; });
  await page.evaluate(() => { for (let i = 0; i < 40; i++) engineFailed(new Error('simulated GPU reset')); });
  await page.waitForTimeout(2500);
  assert(reloaded, 'the app did not restart');
  await ctx.close();
});

await test('recognises an enrolled face standing at normal distance and asks for a blink', async () => {
  const { ctx, page } = await newPage({ engine: true });
  await page.goto(BASE); await appVisible(page);
  await page.waitForFunction(() => typeof recogReady !== 'undefined' && recogReady, null, { timeout: 180000 });
  const n = await page.evaluate(async () => {
    const d = await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.45 })).withFaceLandmarks().withFaceDescriptors();
    if (!d.length) return 0;
    enrollments = [{ id: 't1', name: 'Test Face', section: '', descriptor: d[0].descriptor }, { id: 't2', name: 'Someone Else', section: '', descriptor: d[0].descriptor.map((x, i) => x + (i % 2 ? 0.09 : -0.09)) }];
    tracks.forEach(t => { t.name = null; }); return d.length;
  });
  assert(n === 1, 'the test face was not found for enrolling');
  await page.waitForFunction(() => tracks.some(t => t.name === 'Test Face'), null, { timeout: 90000 });
  try { await page.waitForFunction(() => /Test Face, blink once/.test(document.getElementById('statusText').textContent), null, { timeout: 15000 }); }
  catch (e) { throw new Error(`recognised, but the screen said "${await status(page)}"`); }
  assert(!page.errors.length, 'page errors: ' + page.errors.join(' | '));
  await ctx.close();
});

await browser.close(); server.close();
console.log(failed ? `\n${failed} test(s) FAILED` : `\nAll ${results.length} tests passed`);
process.exit(failed ? 1 : 0);
