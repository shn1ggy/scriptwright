// Bundles each tests/*.test.ts with esbuild and runs it with Node's built-in test runner.
import { build } from 'esbuild';
import { readdirSync, rmSync, mkdirSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const out = path.join(root, '.test-build');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const filter = process.argv[2];
const files = readdirSync(path.join(root, 'tests')).filter((f) => f.endsWith('.test.ts') && (!filter || f.includes(filter)));
await build({
  entryPoints: files.map((f) => path.join(root, 'tests', f)),
  outdir: out,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outExtension: { '.js': '.mjs' },
  external: ['pdfjs-dist', 'electron'],
  sourcemap: 'inline',
  logLevel: 'warning',
});
const res = spawnSync(process.execPath, ['--test', '--enable-source-maps', ...files.map((f) => path.join(out, f.replace(/\.ts$/, '.mjs')))], {
  stdio: 'inherit',
  cwd: root,
});
process.exit(res.status ?? 1);
