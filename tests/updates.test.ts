import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { applyPackage, compareVersions, detectInstall, macAppProblem, macSwapScript, normalizeRepo, packageAssets, parseRelease, sha256, verifyChecksum } from '../src/main/updates';
import { spawnSync } from 'child_process';
import { writeZip } from '../src/main/zip';

test('versions compare numerically, pre-releases before the release', () => {
  assert.ok(compareVersions('0.18.0', '0.17.9') > 0);
  assert.ok(compareVersions('v0.10.0', '0.9.0') > 0);
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.ok(compareVersions('1.0.0-beta.1', '1.0.0') < 0);
  assert.ok(compareVersions('1.0.0', '1.0.0-beta.2') > 0);
});

test('repository names are read from URLs and owner/name', () => {
  assert.equal(normalizeRepo('https://github.com/nico/scriptwright'), 'nico/scriptwright');
  assert.equal(normalizeRepo('git@github.com:nico/scriptwright.git'), 'nico/scriptwright');
  assert.equal(normalizeRepo(' nico/scriptwright/ '), 'nico/scriptwright');
  assert.equal(normalizeRepo('scriptwright'), '');
});

test('a release names its package and checksum', () => {
  const r = parseRelease({
    tag_name: 'v0.18.0',
    html_url: 'https://github.com/x/y/releases/tag/v0.18.0',
    assets: [
      { name: 'scriptwright-0.18.0.zip', browser_download_url: 'u1', size: 10 },
      { name: 'scriptwright-0.18.0.zip.sha256', browser_download_url: 'u2', size: 1 },
      { name: 'Other.dmg', browser_download_url: 'u3', size: 1 },
    ],
  });
  assert.equal(r.version, '0.18.0');
  const { zip, sha } = packageAssets(r);
  assert.equal(zip?.url, 'u1');
  assert.equal(sha?.url, 'u2');
  const buf = Buffer.from('abc');
  assert.ok(verifyChecksum(buf, `${sha256(buf)}  scriptwright-0.18.0.zip`));
  assert.ok(!verifyChecksum(buf, `${'0'.repeat(64)}  x`));
});

function pkgZip(extra: Record<string, string> = {}) {
  const files: Record<string, string> = {
    'package.json': '{"version":"0.18.0"}',
    'dist/renderer/app.js': 'new',
    'src/main/main.ts': 'src',
    'node_modules/x/index.js': 'never',
    'Run Scriptwright.command': '#!/bin/sh',
    ...extra,
  };
  return writeZip(Object.entries(files).map(([n, d]) => ({ name: `scriptwright/${n}`, data: Buffer.from(d) })));
}

test('a source install takes the whole package but keeps node_modules', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-up-'));
  fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'index.js'), 'mine');
  applyPackage(pkgZip(), 'source', dir);
  assert.equal(fs.readFileSync(path.join(dir, 'dist/renderer/app.js'), 'utf8'), 'new');
  assert.equal(fs.readFileSync(path.join(dir, 'node_modules/x/index.js'), 'utf8'), 'mine');
  if (process.platform !== 'win32') assert.ok(fs.statSync(path.join(dir, 'Run Scriptwright.command')).mode & 0o100);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'dist/renderer')), ['app.js']);
  fs.rmSync(dir, { recursive: true });
});

test('a portable install only takes dist and package.json into app/', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-up-'));
  fs.mkdirSync(path.join(dir, 'app'));
  fs.writeFileSync(path.join(dir, 'app', 'package.json'), '{}');
  fs.writeFileSync(path.join(dir, 'Run Scriptwright.cmd'), '');
  const res = path.join(dir, 'runtime', 'resources');
  fs.mkdirSync(res, { recursive: true });
  assert.equal(detectInstall(path.join(res, 'app'), res).kind, 'portable');
  applyPackage(pkgZip(), 'portable', dir);
  assert.equal(fs.readFileSync(path.join(dir, 'app/dist/renderer/app.js'), 'utf8'), 'new');
  assert.ok(!fs.existsSync(path.join(dir, 'app/src')));
  fs.rmSync(dir, { recursive: true });
});

test('an incomplete package is refused and nothing is written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-up-'));
  const bad = writeZip([{ name: 'scriptwright/package.json', data: Buffer.from('{}') }]);
  assert.throws(() => applyPackage(bad, 'source', dir), /incomplete/);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.throws(() => applyPackage(pkgZip(), 'none', dir));
  fs.rmSync(dir, { recursive: true });
});

test('each kind of installation picks its own asset', () => {
  const names = [
    'scriptwright-0.18.0.zip',
    'Scriptwright-0.18.0-mac-arm64.zip',
    'Scriptwright-0.18.0-mac-x64.zip',
    'Scriptwright-0.18.0-mac-arm64.dmg',
    'Scriptwright-Setup-0.18.0.exe',
  ];
  const r = parseRelease({ tag_name: 'v0.18.0', assets: [...names, ...names.map((n) => `${n}.sha256`)].map((n) => ({ name: n, browser_download_url: n })) });
  assert.equal(packageAssets(r, 'source').zip?.name, 'scriptwright-0.18.0.zip');
  assert.equal(packageAssets(r, 'portable').zip?.name, 'scriptwright-0.18.0.zip');
  assert.equal(packageAssets(r, 'mac-app', 'arm64').zip?.name, 'Scriptwright-0.18.0-mac-arm64.zip');
  assert.equal(packageAssets(r, 'mac-app', 'x64').sha?.name, 'Scriptwright-0.18.0-mac-x64.zip.sha256');
  assert.equal(packageAssets(r, 'win-installer').zip?.name, 'Scriptwright-Setup-0.18.0.exe');
});

test('packaged apps are recognised from their executable', () => {
  const none = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-up-'));
  const mac = detectInstall(path.join(none, 'app.asar'), none, { packaged: true, platform: 'darwin', execPath: '/Applications/Scriptwright.app/Contents/MacOS/Scriptwright' });
  assert.deepEqual(mac, { kind: 'mac-app', root: '/Applications/Scriptwright.app' });
  const win = detectInstall(path.join(none, 'app.asar'), none, { packaged: true, platform: 'win32', execPath: path.join(none, 'Scriptwright.exe') });
  assert.equal(win.kind, 'win-installer');
  assert.equal(detectInstall(path.join(none, 'app.asar'), none, { packaged: false, platform: 'darwin', execPath: '/x/Electron.app/Contents/MacOS/Electron' }).kind, 'none');
  fs.rmSync(none, { recursive: true });
});

test('a Mac app run from a download or a disk image is asked to move first', () => {
  const yes = () => true;
  assert.equal(macAppProblem('/private/var/folders/x/AppTranslocation/ABC/d/Scriptwright.app', yes), 'translocated');
  assert.equal(macAppProblem('/Volumes/Scriptwright/Scriptwright.app', yes), 'translocated');
  assert.equal(macAppProblem('/Applications/Scriptwright.app', () => false), 'readonly');
  assert.equal(macAppProblem('/Applications/Scriptwright.app', yes), '');
});

test('the Mac swap script replaces the bundle and keeps the old one if the move fails', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sw it's "));
  const bundle = path.join(dir, 'Scriptwright.app');
  const fresh = path.join(dir, '.Scriptwright-0.18.0.app');
  fs.mkdirSync(bundle);
  fs.writeFileSync(path.join(bundle, 'v'), 'old');
  fs.mkdirSync(fresh);
  fs.writeFileSync(path.join(fresh, 'v'), 'new');
  // A pid that is not running, and "open" replaced by a no-op.
  const script = macSwapScript(999999, bundle, fresh, path.join(dir, 'previous.app')).replace(/^open .*$/m, 'true');
  const r = spawnSync('/bin/sh', ['-c', script]);
  assert.equal(r.status, 0, String(r.stderr));
  assert.equal(fs.readFileSync(path.join(bundle, 'v'), 'utf8'), 'new');
  assert.ok(!fs.existsSync(fresh));
  assert.ok(!fs.existsSync(path.join(dir, 'previous.app')));
  // The new bundle is missing: the old one stays in place.
  const again = macSwapScript(999999, bundle, path.join(dir, 'missing.app'), path.join(dir, 'previous.app')).replace(/^open .*$/m, 'true');
  spawnSync('/bin/sh', ['-c', again]);
  assert.equal(fs.readFileSync(path.join(bundle, 'v'), 'utf8'), 'new');
  fs.rmSync(dir, { recursive: true });
});
