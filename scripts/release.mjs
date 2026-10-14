// Release: builds for production and writes the update package the app installs from.
//
//   npm run release
//
// Produces release/scriptwright-<version>.zip (the project with a built dist/, without
// node_modules or .git) and release/scriptwright-<version>.zip.sha256. Attach both to a GitHub
// release tagged v<version>; the app's update check reads the newest release of that repository.
import { build } from 'esbuild';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import path from 'path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;

const b = spawnSync(process.execPath, [path.join(root, 'scripts', 'build.mjs'), '--prod'], { stdio: 'inherit', cwd: root });
if (b.status) process.exit(b.status);

// The app's own zip writer, so the package reads back exactly as the updater expects.
const bundled = await build({
  entryPoints: [path.join(root, 'src', 'main', 'zip.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'warning',
});
const { writeZip } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));

const SKIP = /^(node_modules|\.git|release|\.test-build|\.updated)(\/|$)|(^|\/)\.DS_Store$/;
const entries = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (SKIP.test(rel)) continue;
    const st = statSync(abs);
    if (st.isDirectory()) walk(abs);
    else entries.push({ name: `scriptwright/${rel}`, data: readFileSync(abs), mtime: st.mtime });
  }
})(root);

const outDir = path.join(root, 'release');
mkdirSync(outDir, { recursive: true });
const name = `scriptwright-${version}.zip`;
const zip = writeZip(entries);
writeFileSync(path.join(outDir, name), zip);
const hash = createHash('sha256').update(zip).digest('hex');
writeFileSync(path.join(outDir, `${name}.sha256`), `${hash}  ${name}\n`);

console.log(`\nrelease/${name}  (${entries.length} files, ${(zip.length / 1048576).toFixed(1)} MB)`);
console.log(`release/${name}.sha256`);
console.log(`\nPublish with the GitHub CLI:\n  gh release create v${version} release/${name} release/${name}.sha256 --title "Scriptwright ${version}" --notes "…"`);
