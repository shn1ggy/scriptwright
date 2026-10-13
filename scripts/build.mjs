// Build: bundles the Electron main process, preload, renderer and the dev harness.
import { build, context } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, copyFileSync } from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const out = path.join(root, 'dist');
const watch = process.argv.includes('--watch');
const prod = process.argv.includes('--prod');

rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, 'renderer', 'fonts'), { recursive: true });

const common = { bundle: true, sourcemap: prod ? false : 'inline', minify: prod, logLevel: 'warning', target: 'es2022' };

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
