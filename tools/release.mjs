// Sets the release version everywhere: config.js and the ?v= on every file in index.html.
// Usage: npm run release 2.1
import fs from 'fs';
const v = process.argv[2];
if (!v || !/^[\w.-]+$/.test(v)) { console.error('Usage: npm run release <version>, e.g. npm run release 2.1'); process.exit(1); }
const cfg = fs.readFileSync('config.js', 'utf8').replace(/APP_VERSION = '[^']+'/, `APP_VERSION = '${v}'`);
fs.writeFileSync('config.js', cfg);
const html = fs.readFileSync('index.html', 'utf8').replace(/((?:config|core|engine|sync|app)\.js|style\.css)\?v=[\w.-]+/g, `$1?v=${v}`);
fs.writeFileSync('index.html', html);
console.log(`Release version set to ${v}. Commit and push to publish.`);
