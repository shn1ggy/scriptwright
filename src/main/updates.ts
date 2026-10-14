// Updates from GitHub releases.
//
// A release carries one source package, `scriptwright-<version>.zip` (the project with a built
// `dist/`, without node_modules), and its checksum `scriptwright-<version>.zip.sha256`. Two kinds
// of installation can take it in place:
//
//   source    – the project folder run with `npm start` (macOS, Linux): the package is unpacked
//               over the folder (node_modules, .git and local files stay).
//   portable  – the Windows folder with "Run Scriptwright.cmd": the package's dist/ and
//               package.json become the new "app" folder, copied into the runtime on the next start.
//
//   mac-app       – Scriptwright.app built by electron-builder: the release's
//                   Scriptwright-<version>-mac-<arch>.zip is unpacked next to the app and swapped
//                   in after the app has quit.
//   win-installer – the installed Windows app: the release's Scriptwright-Setup-<version>.exe runs
//                   silently after the app has quit and starts it again.
//
// Anything else is pointed to the release page.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { readZip } from './zip';

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
}

export interface ReleaseInfo {
  version: string;
  name: string;
  notes: string;
  page: string;
  publishedAt: string;
  assets: ReleaseAsset[];
}

export type InstallKind = 'source' | 'portable' | 'mac-app' | 'win-installer' | 'none';

/** "v1.2.3" / "1.2.3-beta.1" → comparable parts. */
function parts(v: string): { nums: number[]; pre: string } {
  const m = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?/.exec(v.trim());
  if (!m) return { nums: [0], pre: '' };
  return { nums: m[1].split('.').map(Number), pre: m[2] ?? '' };
}

/** > 0 when a is newer than b. A pre-release is older than the same plain version. */
export function compareVersions(a: string, b: string): number {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** "owner/name" from what someone typed: a GitHub URL, git URL or owner/name. */
export function normalizeRepo(input: string): string {
  const s = input.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const m = /github\.com[/:]([^/\s]+)\/([^/\s]+)/i.exec(s) ?? /^([\w.-]+)\/([\w.-]+)$/.exec(s);
  return m ? `${m[1]}/${m[2]}` : '';
}

/** The GitHub API's "latest release" answer, reduced to what the app needs. */
export function parseRelease(json: any): ReleaseInfo {
  return {
    version: String(json.tag_name ?? '').replace(/^v/, ''),
    name: String(json.name || json.tag_name || ''),
    notes: String(json.body ?? ''),
    page: String(json.html_url ?? ''),
    publishedAt: String(json.published_at ?? ''),
    assets: Array.isArray(json.assets) ? json.assets.map((a: any) => ({ name: String(a.name), url: String(a.browser_download_url), size: Number(a.size) || 0 })) : [],
  };
}

/** The asset of a release this kind of installation takes, and its checksum file. */
export function packageAssets(r: ReleaseInfo, kind: InstallKind = 'source', arch = 'x64'): { zip?: ReleaseAsset; sha?: ReleaseAsset } {
  const v = '-v?\\d+(?:\\.\\d+)*(?:-[0-9A-Za-z.]+)?';
  const pattern =
    kind === 'mac-app'
      ? new RegExp(`^Scriptwright${v}-mac-${arch}\\.zip$`)
      : kind === 'win-installer'
        ? new RegExp(`^Scriptwright-Setup${v}\\.exe$`)
        : new RegExp(`^scriptwright${v}\\.zip$`);
  const zip = r.assets.find((a) => pattern.test(a.name));
  const sha = zip ? r.assets.find((a) => a.name.toLowerCase() === `${zip.name.toLowerCase()}.sha256`) : undefined;
  return { zip, sha };
}

/**
 * How this copy of the app is installed. `appPath` is the folder with package.json and dist/;
 * `resourcesPath` is Electron's resources folder.
 */
export function detectInstall(
  appPath: string,
  resourcesPath: string,
  env: { packaged?: boolean; platform?: string; execPath?: string } = {},
): { kind: InstallKind; root: string } {
  // Source checkout run with npm start: package.json, src/ and scripts/build.mjs side by side.
  if (fs.existsSync(path.join(appPath, 'src')) && fs.existsSync(path.join(appPath, 'scripts', 'build.mjs')) && fs.existsSync(path.join(appPath, 'package.json'))) {
    return { kind: 'source', root: appPath };
  }
  // Portable Windows folder: <root>/runtime/resources/app is the running copy, <root>/app the source of it.
  const root = path.resolve(resourcesPath, '..', '..');
  if (fs.existsSync(path.join(root, 'Run Scriptwright.cmd')) && fs.existsSync(path.join(root, 'app', 'package.json'))) {
    return { kind: 'portable', root };
  }
  if (env.packaged && env.execPath) {
    if (env.platform === 'darwin') {
      const m = /^(.*?\.app)\/Contents\/MacOS\//.exec(env.execPath);
      if (m) return { kind: 'mac-app', root: m[1] };
    }
    if (env.platform === 'win32') return { kind: 'win-installer', root: path.dirname(env.execPath) };
  }
  return { kind: 'none', root: '' };
}

/** Why a Mac app cannot replace itself where it is, or '' when it can. */
export function macAppProblem(bundle: string, canWrite: (dir: string) => boolean): '' | 'translocated' | 'readonly' {
  // Started straight from a download or a disk image: macOS runs it from a hidden read-only copy.
  if (bundle.includes('/AppTranslocation/') || bundle.startsWith('/Volumes/')) return 'translocated';
  if (!canWrite(path.dirname(bundle))) return 'readonly';
  return '';
}

/** Shell script that waits for the app to quit, puts the new bundle in place and starts it. */
export function macSwapScript(pid: number, bundle: string, fresh: string, backup: string): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return [
    '#!/bin/sh',
    `while kill -0 ${pid} 2>/dev/null; do sleep 0.3; done`,
    `rm -rf ${q(backup)}`,
    `if mv ${q(bundle)} ${q(backup)}; then`,
    `  if mv ${q(fresh)} ${q(bundle)}; then rm -rf ${q(backup)}; else mv ${q(backup)} ${q(bundle)}; fi`,
    'fi',
    `open ${q(bundle)}`,
    '',
  ].join('\n');
}

export function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Checks a downloaded package against the release's checksum file ("<hex>  <name>"). */
export function verifyChecksum(buf: Buffer, shaText: string): boolean {
  const want = /\b([0-9a-f]{64})\b/i.exec(shaText)?.[1]?.toLowerCase();
  return !!want && want === sha256(buf);
}

const KEEP = /^(node_modules|\.git|release|\.test-build|\.updated)(\/|$)/;

/**
 * Writes a release package into this installation. Files are written next to their target and
 * then renamed over it, so a failure leaves the old version in place. Returns the files written.
 */
export function applyPackage(zipBuf: Buffer, kind: InstallKind, root: string): number {
  if (kind === 'none') throw new Error('This installation cannot be updated in place.');
  const entries = readZip(zipBuf);
  // The package has one top folder (scriptwright/); paths below it are relative to the project.
  const top = entries.length && entries.every((e) => e.name.split('/')[0] === entries[0].name.split('/')[0]) ? entries[0].name.split('/')[0] + '/' : '';
  if (!entries.some((e) => e.name === `${top}package.json`) || !entries.some((e) => e.name.startsWith(`${top}dist/`))) {
    throw new Error('The update package is incomplete (package.json or dist/ is missing).');
  }
  const writes: Array<{ target: string; data: Buffer }> = [];
  for (const e of entries) {
    const rel = e.name.slice(top.length);
    if (!rel || rel.includes('..') || path.isAbsolute(rel) || KEEP.test(rel)) continue;
    if (kind === 'source') writes.push({ target: path.join(root, rel), data: e.data });
    else if (rel === 'package.json' || rel.startsWith('dist/')) writes.push({ target: path.join(root, 'app', rel), data: e.data });
  }
  // Stage everything first, then swap in.
  const staged: Array<{ tmp: string; target: string }> = [];
  try {
    for (const w of writes) {
      fs.mkdirSync(path.dirname(w.target), { recursive: true });
      const tmp = `${w.target}.update-${process.pid}`;
      fs.writeFileSync(tmp, w.data);
      staged.push({ tmp, target: w.target });
    }
  } catch (e) {
    for (const s of staged) fs.rmSync(s.tmp, { force: true });
    throw e;
  }
  for (const s of staged) fs.renameSync(s.tmp, s.target);
  // Launchers must stay executable.
  for (const s of staged) if (/\.(command|sh)$/.test(s.target)) fs.chmodSync(s.target, 0o755);
  return staged.length;
}
