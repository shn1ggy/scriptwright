import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Backend, sha } from '../src/main/backend';
import { defaultExportSettings } from '../src/shared/types';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-'));
  const ws = path.join(root, 'ws');
  fs.mkdirSync(ws);
  const b = new Backend({ userDataDir: path.join(root, 'ud'), fontsDir: path.join(root, 'fonts') });
  assert.ok(b.setWorkspace(ws).ok);
  return { root, ws, b };
}

test('create, list, open, save with conflict protection', () => {
  const { ws, b } = setup();
  const p = b.createProject('My Film', 'INT. A - DAY\n');
  assert.equal(p.file, 'My Film.fountain');
  assert.deepEqual(b.listProjects().map((x) => x.name), ['My Film']);
  const o = b.openProject(p.rel);
  assert.equal(o.text, 'INT. A - DAY\n');
  const r1 = b.saveScript(p.rel, 'INT. A - DAY\n\nMore.', o.hash);
  assert.ok(r1.ok);
  // External edit, then a save based on the old hash must not overwrite it.
  fs.writeFileSync(path.join(ws, 'My Film', 'My Film.fountain'), 'EXTERNAL');
  const r2 = b.saveScript(p.rel, 'MINE', (r1 as any).hash);
  assert.equal(r2.ok, false);
  assert.equal((r2 as any).reason, 'conflict');
  assert.equal((r2 as any).diskText, 'EXTERNAL');
  assert.equal(fs.readFileSync(path.join(ws, 'My Film', 'My Film.fountain'), 'utf8'), 'EXTERNAL');
  b.dispose();
});

test('damaged project information does not block the screenplay', () => {
  const { ws, b } = setup();
  const p = b.createProject('Film', 'Text');
  fs.writeFileSync(path.join(ws, 'Film', '.scriptwright', 'project.json'), '{ broken');
  const o = b.openProject(p.rel);
  assert.equal(o.text, 'Text');
  assert.equal(o.warnings.length, 1);
  assert.ok(fs.readdirSync(path.join(ws, 'Film', '.scriptwright')).some((f) => f.startsWith('project.json.damaged-')));
  b.dispose();
});

test('missing project information is recreated', () => {
  const { ws, b } = setup();
  fs.mkdirSync(path.join(ws, 'Plain'));
  fs.writeFileSync(path.join(ws, 'Plain', 'Plain.fountain'), 'Hello');
  const o = b.openProject('Plain');
  assert.equal(o.text, 'Hello');
  assert.ok(o.meta.id);
  b.dispose();
});

test('renamed project folder keeps information', () => {
  const { b } = setup();
  const p = b.createProject('Old', 'Text');
  const o = b.openProject(p.rel);
  o.meta.notes = 'keep me';
  b.saveMeta(p.rel, o.meta);
  const r = b.renameProject(p.rel, 'New');
  assert.equal(r.file, 'New.fountain');
  const o2 = b.openProject(r.rel);
  assert.equal(o2.meta.notes, 'keep me');
  assert.equal(o2.meta.id, o.meta.id);
  b.dispose();
});

test('missing file is reported instead of silently recreated', () => {
  const { ws, b } = setup();
  const p = b.createProject('Gone', 'Text');
  const o = b.openProject(p.rel);
  fs.unlinkSync(path.join(ws, 'Gone', 'Gone.fountain'));
  const r = b.saveScript(p.rel, 'Text 2', o.hash);
  assert.equal((r as any).reason, 'missing');
  assert.ok(b.restoreScript(p.rel, 'Text 2').ok);
  assert.equal(fs.readFileSync(path.join(ws, 'Gone', 'Gone.fountain'), 'utf8'), 'Text 2');
  b.dispose();
});

test('external meta change is preserved when we save ours', () => {
  const { ws, b } = setup();
  const p = b.createProject('Film', 'Text');
  const o = b.openProject(p.rel);
  const mp = path.join(ws, 'Film', '.scriptwright', 'project.json');
  const ext = JSON.parse(fs.readFileSync(mp, 'utf8'));
  ext.notes = 'from other computer';
  fs.writeFileSync(mp, JSON.stringify(ext));
  const r = b.saveMeta(p.rel, { ...o.meta, notes: 'local' });
  assert.ok(r.preservedExternal);
  assert.ok(fs.readFileSync(path.join(ws, 'Film', r.preservedExternal!), 'utf8').includes('from other computer'));
  b.dispose();
});

test('sync conflict copies are detected', () => {
  const { ws, b } = setup();
  b.createProject('Film', 'A');
  fs.writeFileSync(path.join(ws, 'Film', "Film (Nico's conflicted copy 2026-01-01).fountain"), 'B');
  const p = b.listProjects()[0];
  assert.equal(p.file, 'Film.fountain');
  assert.equal(p.conflicts.length, 1);
  b.dispose();
});

test('recovery is offered when it differs from disk', () => {
  const { b } = setup();
  const p = b.createProject('Film', 'A');
  const o = b.openProject(p.rel);
  b.writeRecovery(o.meta.id, p.rel, 'A plus unsaved');
  b.closeProject(p.rel);
  const o2 = b.openProject(p.rel);
  assert.equal(o2.recovery?.text, 'A plus unsaved');
  b.dispose();
});

test('backup and import round trip with all project information', () => {
  const { root, b } = setup();
  const p = b.createProject('Film', 'INT. A - DAY');
  const o = b.openProject(p.rel);
  b.saveMeta(p.rel, { ...o.meta, notes: 'Notes ✓' });
  b.snapshotProject(p.rel, 'old', 'before');
  const zip = path.join(root, 'film.zip');
  const info = b.backupProject(p.rel, zip);
  assert.ok(info.files >= 3);
  const imported = b.importBackup(zip);
  assert.equal(imported.rel, 'Film (imported 2)');
  const o2 = b.openProject(imported.rel);
  assert.equal(o2.text, 'INT. A - DAY');
  assert.equal(o2.meta.notes, 'Notes ✓');
  assert.notEqual(o2.meta.id, o.meta.id);
  assert.equal(b.listHistory(imported.rel).length, 1);
  b.dispose();
});

test('history snapshots respect the interval and retention', () => {
  const { ws, b } = setup();
  const p = b.createProject('Film', 'A');
  const o = b.openProject(p.rel);
  const r1 = b.saveScript(p.rel, 'B', o.hash, 10) as any;
  assert.ok(r1.snapshot);
  const r2 = b.saveScript(p.rel, 'C', r1.hash, 10) as any;
  assert.equal(r2.snapshot, undefined);
  const hdir = path.join(ws, 'Film', '.scriptwright', 'history');
  // Old snapshots: two on the same day 5 days ago, one 40 days ago
  const d = (daysAgo: number, h: number) => {
    const t = new Date(Date.now() - daysAgo * 86400000);
    const p2 = (n: number) => String(n).padStart(2, '0');
    return `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())}_${p2(h)}0000 auto.fountain`;
  };
  fs.writeFileSync(path.join(hdir, d(5, 9)), 'x');
  fs.writeFileSync(path.join(hdir, d(5, 15)), 'y');
  fs.writeFileSync(path.join(hdir, d(40, 9)), 'z');
  b.pruneHistory(hdir);
  const left = fs.readdirSync(hdir);
  assert.ok(left.includes(d(5, 15)));
  assert.ok(!left.includes(d(5, 9)));
  assert.ok(!left.includes(d(40, 9)));
  b.dispose();
});

test('external change event is emitted', async () => {
  const { ws, b } = setup();
  const p = b.createProject('Film', 'A');
  b.openProject(p.rel);
  const got = new Promise<any>((res) => b.once('external', res));
  // Production watchers are deliberately unreferenced. Keep this test alive
  // until the notification arrives, including the polling fallback on macOS.
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error('External change was not detected within 5 seconds')), 5000);
  });
  try {
    fs.writeFileSync(path.join(ws, 'Film', 'Film.fountain'), 'Changed elsewhere');
    const ev = await Promise.race([got, deadline]);
    assert.equal(ev.kind, 'changed');
    assert.equal(ev.hash, sha('Changed elsewhere'));
  } finally {
    clearTimeout(timeout);
    b.dispose();
  }
});

test('loose fountain files can be adopted into a project', () => {
  const { ws, b } = setup();
  fs.writeFileSync(path.join(ws, 'Loose.fountain'), 'Text');
  const list = b.listProjects();
  assert.equal(list[0].loose, true);
  const p = b.adoptLooseFile('Loose.fountain');
  assert.equal(fs.readFileSync(path.join(ws, p.rel, 'Loose.fountain'), 'utf8'), 'Text');
  b.dispose();
});

test('PDF export through the backend', () => {
  const { b } = setup();
  const r = b.exportPdf('INT. A - DAY\n\nHello.', { ...defaultExportSettings(), font: 'Courier' }, { kind: 'all' }, {});
  assert.equal(r.pages, 1);
  assert.ok(r.pdf.length > 500);
  b.dispose();
});
