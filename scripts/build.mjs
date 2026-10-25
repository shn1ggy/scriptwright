// Build: bundles the Electron main process, preload, renderer and the dev harness.
import { build, context } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, copyFileSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist');
const watch = process.argv.includes('--watch');
const prod = process.argv.includes('--prod');

rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, 'renderer', 'fonts'), { recursive: true });

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
let commit = '';
try {
  commit = execSync('git rev-parse --short HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
} catch {}
const define = {
  __APP_VERSION__: JSON.stringify(pkg.version),
  __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  __COMMIT__: JSON.stringify(commit),
  __UPDATE_REPO__: JSON.stringify(pkg.scriptwright?.updateRepo ?? ''),
};
const common = { bundle: true, sourcemap: prod ? false : 'inline', minify: prod, logLevel: 'warning', target: 'es2022', define };

const configs = [
  { ...common, entryPoints: [path.join(root, 'src/main/main.ts')], outfile: path.join(out, 'main.js'), platform: 'node', format: 'cjs', external: ['electron'] },
  { ...common, entryPoints: [path.join(root, 'src/preload/preload.ts')], outfile: path.join(out, 'preload.js'), platform: 'node', format: 'cjs', external: ['electron'] },
  {
    ...common,
    entryPoints: [path.join(root, 'src/renderer/main.ts')],
    outfile: path.join(out, 'renderer', 'app.js'),
    platform: 'browser',
    format: 'esm',
    // pdf.js is loaded on demand from its own files.
    external: ['./pdfjs/*'],
  },
  {
    ...common,
    entryPoints: [path.join(root, 'dev/harness.ts')],
    outfile: path.join(out, 'harness.js'),
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  },
];

// Static files
cpSync(path.join(root, 'src/renderer/index.html'), path.join(out, 'renderer', 'index.html'));
cpSync(path.join(root, 'src/renderer/styles.css'), path.join(out, 'renderer', 'styles.css'));
cpSync(path.join(root, 'assets/icon.svg'), path.join(out, 'renderer', 'icon.svg'));
cpSync(path.join(root, 'assets/icon.png'), path.join(out, 'icon.png'));
const fontsDir = path.join(root, 'resources', 'fonts');
if (existsSync(fontsDir)) {
  for (const f of readdirSync(fontsDir)) if (/\.(ttf|txt)$/i.test(f)) copyFileSync(path.join(fontsDir, f), path.join(out, 'renderer', 'fonts', f));
}
// pdf.js for the export preview
try {
  const pdfjsRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
  mkdirSync(path.join(out, 'renderer', 'pdfjs'), { recursive: true });
  copyFileSync(path.join(pdfjsRoot, 'legacy', 'build', 'pdf.min.mjs'), path.join(out, 'renderer', 'pdfjs', 'pdf.min.mjs'));
  copyFileSync(path.join(pdfjsRoot, 'legacy', 'build', 'pdf.worker.min.mjs'), path.join(out, 'renderer', 'pdfjs', 'pdf.worker.min.mjs'));
} catch (e) {
  console.warn('pdfjs-dist not found: the export preview will be unavailable.', e.message);
}

if (watch) {
  for (const c of configs) (await context(c)).watch();
  console.log('Watching…');
} else {
  await Promise.all(configs.map((c) => build(c)));
  console.log('Built to dist/');
}
