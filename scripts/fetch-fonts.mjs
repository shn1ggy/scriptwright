// Downloads Courier Prime (SIL Open Font License) into resources/fonts.
// Runs after `npm install`; safe to re-run. Without the fonts the app falls back to Courier.
import { createWriteStream, existsSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import https from 'https';
import path from 'path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const dir = path.join(root, 'resources', 'fonts');
const base = 'https://raw.githubusercontent.com/google/fonts/main/ofl/courierprime/';
const files = ['CourierPrime-Regular.ttf', 'CourierPrime-Bold.ttf', 'CourierPrime-Italic.ttf', 'CourierPrime-BoldItalic.ttf', 'OFL.txt'];

function get(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          return resolve(get(new URL(res.headers.location, url).href, dest, redirects - 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const tmp = dest + '.part';
        const out = createWriteStream(tmp);
        res.pipe(out);
        out.on('finish', () => out.close(() => (renameSync(tmp, dest), resolve())));
        out.on('error', (e) => {
          try { unlinkSync(tmp); } catch {}
          reject(e);
        });
      })
      .on('error', reject);
  });
}

mkdirSync(dir, { recursive: true });
let missing = files.filter((f) => !existsSync(path.join(dir, f)));
if (!missing.length) {
  console.log('Courier Prime is already present.');
  process.exit(0);
}
try {
  for (const f of missing) await get(base + f, path.join(dir, f));
  console.log('Courier Prime downloaded to resources/fonts.');
} catch (e) {
  console.warn(`Could not download Courier Prime (${e.message}).`);
  console.warn('The app will use Courier until the fonts are placed in resources/fonts:');
  console.warn('  ' + files.join(', '));
  console.warn('  from https://fonts.google.com/specimen/Courier+Prime');
}
