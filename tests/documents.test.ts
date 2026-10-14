import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Backend } from '../src/main/backend';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-docs-'));
  const ws = path.join(root, 'ws');
  fs.mkdirSync(ws);
  const b = new Backend({ userDataDir: path.join(root, 'ud'), fontsDir: path.join(process.cwd(), 'resources', 'fonts') });
  b.setWorkspace(ws);
  const p = b.createProject('DRUCK', 'INT. COPYSHOP - DAY\n\nLisa.\n');
  return { root, b, rel: p.rel, dir: path.join(ws, p.rel) };
}

test('documents are Markdown files beside the screenplay, with unique names', () => {
  const { root, b, rel, dir } = setup();
  const a = b.createDocument(rel, 'Exposé');
  const c = b.createDocument(rel, 'Exposé');
  assert.equal(a.file, 'Exposé.md');
  assert.equal(c.file, 'Exposé 2.md');
  assert.ok(fs.existsSync(path.join(dir, 'Exposé.md')));
  const saved = b.saveDocument(rel, a.file, '# Logline\n\nText.\n', a.hash);
  assert.ok(saved.ok);
  assert.equal(b.readDocument(rel, a.file)?.text, '# Logline\n\nText.\n');
  // The screenplay is untouched.
  assert.equal(b.readScript(rel)?.text, 'INT. COPYSHOP - DAY\n\nLisa.\n');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a document changed on disk meanwhile is not overwritten', () => {
  const { root, b, rel, dir } = setup();
  const a = b.createDocument(rel, 'Treatment', 'one');
  fs.writeFileSync(path.join(dir, a.file), 'changed elsewhere');
  const r = b.saveDocument(rel, a.file, 'mine', a.hash);
  assert.equal(r.ok, false);
  assert.equal(fs.readFileSync(path.join(dir, a.file), 'utf8'), 'changed elsewhere');
  fs.rmSync(root, { recursive: true, force: true });
});

test('rename follows the title; delete keeps a copy; paths outside the project are refused', async () => {
  const { root, b, rel, dir } = setup();
  const a = b.createDocument(rel, 'Notes', 'x');
  const renamed = b.renameDocument(rel, a.file, 'Character notes');
  assert.equal(renamed, 'Character notes.md');
  assert.ok(!fs.existsSync(path.join(dir, 'Notes.md')));
  await b.deleteDocument(rel, renamed);
  assert.ok(!fs.existsSync(path.join(dir, renamed)));
  const kept = fs.readdirSync(path.join(dir, '.scriptwright', 'deleted'));
  assert.ok(kept.some((f) => f.endsWith('Character notes.md')));
  assert.throws(() => b.readDocument(rel, '../outside.md'));
  assert.throws(() => b.readDocument(rel, 'DRUCK.fountain'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('a document exports as a PDF', () => {
  const { root, b } = setup();
  const pdf = b.exportDocumentPdf('# Logline\n\nLisa, 41, sends out *one more* application.\n\n- a point\n', { paper: 'A4', title: 'DRUCK', author: 'Nico Sanft', docTitle: 'Exposé' });
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  fs.rmSync(root, { recursive: true, force: true });
});
