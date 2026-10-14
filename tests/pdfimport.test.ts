import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Backend } from '../src/main/backend';
import { defaultExportSettings } from '../src/shared/types';
import { pdfToFountain, readPdfText } from '../src/shared/pdfimport';

const words = (s: string) => s.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);

async function roundTrip(src: string, paper: 'Letter' | 'A4' = 'Letter', extra: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-pdfimp-'));
  const b = new Backend({ userDataDir: root, fontsDir: path.join(process.cwd(), 'resources', 'fonts') });
  const r = b.exportPdf(src, { ...defaultExportSettings(paper), ...extra } as any, { kind: 'all' }, { title: 'T' } as any);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const res = pdfToFountain(await readPdfText(pdfjs, new Uint8Array(r.pdf)));
  fs.rmSync(root, { recursive: true, force: true });
  return res;
}

test('a long screenplay comes back from its PDF scene by scene, split speeches joined', async () => {
  const out = ['Title: Langer Test', 'Author: Nico', ''];
  for (let k = 1; k <= 12; k++) {
    out.push(`INNEN/AUSSEN. WOHNUNG ${k} - NACHT`, '', `Lisa geht in Zimmer ${k}. Regen am Fenster, eine flackernde Lampe.`, '');
    out.push('LISA', '(leise)', Array.from({ length: 12 }, (_, i) => `Satz ${i + 1} in Zimmer ${k} geht weiter und weiter.`).join(' '), '');
    out.push('TOM (O.S.)', 'Hier oben. Vorsicht, Treppe.', '', 'SCHNITT AUF:', '');
  }
  const src = out.join('\n');
  const res = await roundTrip(src, 'A4', { header: 'Blue Revision 14.10.26' });
  assert.equal(res.stats.scenes, 12);
  assert.equal(res.stats.cues, 24);
  assert.ok(res.stats.pages > 5);
  const body = (s: string) => words(s).filter((l) => !/^(Title|Author):/.test(l) && !/^#\d+#$/.test(l)).map((l) => l.replace(/ #\d+#$/, ''));
  assert.deepEqual(body(res.text), body(src));
  assert.match(res.text, /^Title: LANGER TEST\nAuthor: Nico/);
  assert.ok(!res.text.includes('Blue Revision'), 'page header was taken as text');
});

test('the sample screenplay keeps its title page, transitions, dual dialogue and centred text', async () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'e2e/fixtures/sample.fountain'), 'utf8');
  const res = await roundTrip(src);
  assert.match(res.text, /Credit: Written by\nAuthor: Mara Lindqvist/);
  assert.match(res.text, /\nCUT TO:\n/);
  assert.match(res.text, /\nSTEEL \^\nScrew retirement\./);
  assert.match(res.text, /\n> THE END <\n/);
  assert.match(res.text, /\nLISA\n\(to herself\)\nOne more night\. Just one more\.\n/);
});
