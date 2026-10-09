// Checks every app file for mistakes (undefined names, duplicates, unreachable code).
// The files share one scope in the browser, so they are checked together in load order.
import { ESLint } from 'eslint';
import fs from 'fs';

const order = ['config', 'core', 'engine', 'sync', 'app'];
const html = fs.readFileSync('index.html', 'utf8');
for (const n of order) if (!html.includes(`src="${n}.js?v=`)) { console.error(`index.html does not load ${n}.js`); process.exit(1); }

const parts = order.map(n => ({ n, src: fs.readFileSync(`${n}.js`, 'utf8') }));
const all = parts.map(p => p.src).join('\n');
const eslint = new ESLint({
  useEslintrc: false,
  overrideConfig: {
    env: { browser: true, es2022: true }, parserOptions: { ecmaVersion: 2022, sourceType: 'script' },
    globals: { faceapi: 'readonly' },
    rules: { 'no-undef': 'error', 'no-redeclare': 'error', 'no-dupe-keys': 'error', 'no-unreachable': 'error', 'no-self-assign': 'error',
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^APP_VERSION$' }] }
  }
});
const [res] = await eslint.lintText(all, { filePath: 'app-bundle.js' });
const sw = (await new ESLint({ useEslintrc: false, overrideConfig: { env: { serviceworker: true, es2022: true }, parserOptions: { ecmaVersion: 2022 }, rules: { 'no-undef': 'error' } } }).lintFiles(['sw.js']))[0];

// map bundle line numbers back to files
const starts = []; let line = 1; for (const p of parts) { starts.push({ n: p.n, line }); line += p.src.split('\n').length; }
const where = (l) => { let f = starts[0]; for (const s of starts) if (s.line <= l) f = s; return `${f.n}.js:${l - f.line + 1}`; };
let errors = 0;
for (const m of res.messages) { console.log(`${m.severity === 2 ? 'ERROR' : 'warn '} ${where(m.line)}  ${m.message}`); if (m.severity === 2) errors++; }
for (const m of sw.messages) { console.log(`${m.severity === 2 ? 'ERROR' : 'warn '} sw.js:${m.line}  ${m.message}`); if (m.severity === 2) errors++; }

// every code file must carry the same release version as config.js
const ver = /APP_VERSION = '([^']+)'/.exec(parts[0].src)[1];
for (const n of [...order, 'style']) {
  const ext = n === 'style' ? 'css' : 'js';
  if (!html.includes(`${n}.${ext}?v=${ver}`)) { console.log(`ERROR index.html: ${n}.${ext} is not loaded with ?v=${ver} (run: npm run release ${ver})`); errors++; }
}
console.log(errors ? `\n${errors} error(s)` : '\nLint OK');
process.exit(errors ? 1 : 0);
