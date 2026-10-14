import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { applyPackage, compareVersions, detectInstall, normalizeRepo, packageAssets, parseRelease, sha256, verifyChecksum } from '../src/main/updates';
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
