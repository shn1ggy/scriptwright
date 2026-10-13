import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/shared/fountain';
import { paginate, wrap, parsePageRanges } from '../src/shared/paginate';
import { defaultExportSettings } from '../src/shared/types';
import { renderPdf } from '../src/main/pdfexport';

const S = () => ({ ...defaultExportSettings('Letter'), font: 'Courier', titleFont: 'Courier' });
const pag = (src: string, over = {}, scope?: any) => {
  const lines = src.split('\n');
  return paginate(lines, parse(lines), { ...S(), ...over }, scope);
};
const pageText = (p: any) => p.lines.map((l: any) => ' '.repeat(l.col) + l.runs.map((r: any) => r.text).join(''));

test('wrap respects width and hard-splits long words', () => {
  assert.deepEqual(wrap('aaa bbb ccc', 7), [[0, 7], [8, 11]]);
  assert.deepEqual(wrap('abcdefghij', 4), [[0, 4], [4, 8], [8, 10]]);
});

test('capacity: Letter, 12pt, 1in/1in margins → 54 lines, 60/35 chars', () => {
  const r = pag('INT. A - DAY');
  assert.equal(r.capacity.linesPerPage, 54);
  assert.equal(r.capacity.actionChars, 60);
  assert.equal(r.capacity.dialogueChars, 35);
  assert.deepEqual(r.warnings, []);
});

test('element positions follow screenplay conventions', () => {
  const r = pag('INT. HOUSE - DAY\n\nShe waits.\n\nLISA\n(softly)\nHello.\n\nCUT TO:');
  const p = r.pages[0];
  const kinds = p.lines.map((l) => [l.kind, l.col, l.row]);
  assert.deepEqual(kinds, [
    ['heading', 0, 0],
    ['action', 0, 2],
    ['character', 22, 4],
    ['parenthetical', 16, 5],
    ['dialogue', 10, 6],
    ['transition', 53, 8],
  ]);
});

test('heading is never the last thing on a page', () => {
  const action = Array.from({ length: 51 }, (_, i) => `Line ${i}.`).join('\n');
  // 51 action lines + blank + heading would put the heading on line 53/54 without room for content
  const r = pag(`${action}\n\nINT. NEXT - DAY\n\nMore action.`, { splitAction: false });
  const last = r.pages[0].lines[r.pages[0].lines.length - 1];
  assert.notEqual(last.kind, 'heading');
  assert.equal(r.pages[1].lines[0].kind, 'heading');
});

test('dialogue splits with MORE and CONT\'D at a sentence boundary', () => {
  const filler = Array.from({ length: 49 }, (_, i) => `Filler ${i}.`).join('\n');
  const speech = Array.from({ length: 10 }, (_, i) => `Sentence number ${i}.`).join(' ');
  const r = pag(`${filler}\n\nLISA\n${speech}`);
  const p1 = pageText(r.pages[0]);
  const p2 = pageText(r.pages[1]);
  assert.ok(p1[p1.length - 1].trim() === '(MORE)', p1.slice(-3).join('|'));
  assert.ok(p2[0].trim() === "LISA (CONT'D)", p2[0]);
  // No orphaned cue: at least two dialogue lines before the break
  const dlgOnP1 = r.pages[0].lines.filter((l) => l.kind === 'dialogue').length;
  assert.ok(dlgOnP1 >= 2);
});

test('cue and parenthetical are never orphaned at the bottom', () => {
  const filler = Array.from({ length: 50 }, (_, i) => `F${i}.`).join('\n');
  const r = pag(`${filler}\n\nLISA\n(beat)\nShort line.`);
  const lastKinds = r.pages[0].lines.slice(-1).map((l) => l.kind);
  assert.notEqual(lastKinds[0], 'character');
  assert.notEqual(lastKinds[0], 'parenthetical');
});

test('explicit page breaks and new-page scene starts', () => {
  const r = pag('A.\n\n===\n\nB.');
  assert.equal(r.pages.length, 2);
  const r2 = pag('INT. A - DAY\n\nx\n\nINT. B - DAY\n\ny', {}, { kind: 'scenesNewPage' });
  assert.equal(r2.pages.length, 2);
  assert.equal(r2.pages[1].lines[0].kind, 'heading');
});

test('an unbreakable huge paragraph still paginates without loss or endless pages', () => {
  const huge = 'word '.repeat(6000).trim();
  const r = pag(huge);
  const total = r.pages.reduce((n, p) => n + p.lines.length, 0);
  const text = r.pages.flatMap((p) => p.lines.map((l) => l.runs.map((x) => x.text).join(''))).join(' ');
  assert.equal(text.split(' ').filter(Boolean).length, 6000);
  assert.ok(r.pages.length < 20);
  assert.ok(total > 54);
});

test('huge dialogue block paginates and terminates', () => {
  const speech = 'Blah blah blah. '.repeat(1500);
  const r = pag(`\nLISA\n${speech}`);
  assert.ok(r.pages.length > 5 && r.pages.length < 60, String(r.pages.length));
});

test('scope: selected scenes, character, page ranges', () => {
  const src = 'INT. A - DAY\n\nLISA\nHi.\n\nINT. B - DAY\n\nTOM\nHey.\n\nINT. C - DAY\n\nLISA\nBye.';
  const lines = src.split('\n');
  const p = parse(lines);
  const onlyB = paginate(lines, p, S(), { kind: 'scenes', sceneLines: [p.scenes[1].line] });
  assert.deepEqual(onlyB.pages[0].lines.filter((l) => l.kind === 'heading').map((l) => l.runs[0].text), ['INT. B - DAY']);
  const lisa = paginate(lines, p, S(), { kind: 'character', name: 'LISA' });
  assert.deepEqual(lisa.pages[0].lines.filter((l) => l.kind === 'heading').map((l) => l.runs[0].text), ['INT. A - DAY', 'INT. C - DAY']);
  assert.deepEqual([...parsePageRanges('1-3, 5', 10)], [1, 2, 3, 5]);
});

test('notes, boneyard, sections and synopses are excluded by default', () => {
  const r = pag('# Act One\n\n= synopsis\n\nAction [[private]] here.\n\n/* cut */\n\nEnd.');
  const all = r.pages.flatMap(pageText).join('\n');
  assert.ok(!all.includes('private'));
  assert.ok(!all.includes('cut'));
  assert.ok(!all.includes('Act One'));
  assert.ok(!all.includes('synopsis'));
  assert.ok(all.includes('Action  here.'));
});

test('dual dialogue renders side by side', () => {
  const r = pag('\nBRICK\nScrew retirement.\n\nSTEEL ^\nScrew retirement.');
  const rows = r.pages[0].lines.filter((l) => l.row === 0);
  assert.equal(rows.length, 2);
  assert.ok(rows[1].col > rows[0].col);
});

test('title page is separate and numbered pages start at 1', () => {
  const r = pag('Title: Test\nAuthor: Me\n\nINT. A - DAY\n\nText.');
  assert.ok(r.pages[0].title);
  assert.equal(r.pages[1].number, 1);
  assert.equal(r.bodyPageCount, 1);
});

test('width validation warns when elements exceed the printable width', () => {
  const r = pag('x', { actionWidth: 80 });
  assert.ok(r.warnings.some((w) => w.includes('Action')));
});

test('PDF output is valid and contains the text', async () => {
  const src = 'Title: Grüße\nAuthor: Jörg\n\nINT. KÜCHE - TAG\n\nJörg isst **Brötchen** und _liest_.\n\nANNA\n„Schön!“ – sagt sie.';
  const lines = src.split('\n');
  const result = paginate(lines, parse(lines), S());
  const out = renderPdf(result, S(), { title: 'Grüße' });
  assert.ok(out.pdf.subarray(0, 8).toString('latin1').startsWith('%PDF-1.4'));
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(out.pdf), useSystemFonts: false, disableFontFace: true, verbosity: 0 }).promise;
  assert.equal(doc.numPages, 2);
  const page2 = await doc.getPage(2);
  const tc = await page2.getTextContent();
  const text = tc.items.map((i: any) => i.str).join('');
  assert.ok(text.includes('KÜCHE'), text);
  assert.ok(text.includes('Brötchen'), text);
  assert.ok(text.includes('„Schön!“'), text);
  assert.deepEqual(out.warnings, []);
});

test('PDF with an embedded TrueType font', async () => {
  const fs = await import('fs');
  const dir = '/tmp/sw-font-test';
  fs.mkdirSync(dir, { recursive: true });
  const src = '/usr/share/fonts/truetype/liberation/';
  const map: Record<string, string> = {
    'CourierPrime-Regular.ttf': 'LiberationMono-Regular.ttf',
    'CourierPrime-Bold.ttf': 'LiberationMono-Bold.ttf',
    'CourierPrime-Italic.ttf': 'LiberationMono-Italic.ttf',
    'CourierPrime-BoldItalic.ttf': 'LiberationMono-BoldItalic.ttf',
  };
  if (!fs.existsSync(src + 'LiberationMono-Regular.ttf')) return;
  for (const [k, v] of Object.entries(map)) fs.copyFileSync(src + v, `${dir}/${k}`);
  const lines = 'INT. ROOM - DAY\n\nÄrger über Öl.'.split('\n');
  const s = { ...S(), font: 'Courier Prime' as const };
  const out = renderPdf(paginate(lines, parse(lines), s), s, { fontsDir: dir });
  assert.equal(out.fontUsed, 'Courier Prime');
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(out.pdf), verbosity: 0 }).promise;
  const tc = await (await doc.getPage(1)).getTextContent();
  assert.ok(tc.items.map((i: any) => i.str).join('').includes('Ärger über Öl.'));
});

test('title page values are printed without markers but keep e-mail underscores', async () => {
  const { cleanTitleValue } = await import('../src/shared/paginate');
  assert.equal(cleanTitleValue('**THE LONG NIGHT**'), 'THE LONG NIGHT');
  assert.equal(cleanTitleValue('_Underlined_ title'), 'Underlined title');
  assert.equal(cleanTitleValue('first_last@example.com'), 'first_last@example.com');
  assert.equal(cleanTitleValue('> Centered <'), 'Centered');
});

test('dialogue-only scope: one character, with or without headings and action', () => {
  const src = 'INT. A - DAY\n\nShe enters.\n\nLISA\nHi.\n\nTOM\nHey.\n\nINT. B - DAY\n\nLISA\nBye.';
  const lines = src.split('\n');
  const p = parse(lines);
  const text = (scope: any) => paginate(lines, p, S(), scope).pages.flatMap(pageText).map((l: string) => l.trim()).join('|');
  assert.equal(text({ kind: 'dialogue', name: 'LISA', action: false, headings: false }), 'LISA|Hi.|LISA|Bye.');
  assert.equal(text({ kind: 'dialogue', name: 'LISA', action: true, headings: true }), 'INT. A - DAY|She enters.|LISA|Hi.|INT. B - DAY|LISA|Bye.');
  assert.ok(text({ kind: 'dialogue', name: '', action: false, headings: false }).includes('TOM'));
});

test('geometry in lines and characters, with warnings', () => {
  const r = pag('x', { linesPerPage: 70 });
  assert.ok(r.capacity.linesPerPage < 70);
  assert.ok(r.warnings.length);
  const a4 = paginate(['x'], parse(['x']), defaultExportSettings('A4'));
  assert.equal(a4.capacity.linesPerPage, 57);
  assert.ok(a4.capacity.bottomMarginLines >= 6);
  assert.deepEqual(a4.warnings, []);
});

test('options: left transitions, bold cues, stacked dual dialogue, scene number format', () => {
  const r = pag('INT. A - DAY\n\nBRICK\nScrew.\n\nSTEEL ^\nScrew.\n\nCUT TO:', { transitionAlign: 'left', boldCues: true, dualDialogue: 'stacked', sceneNumberFormat: '{n}.' });
  const p = r.pages[0];
  assert.equal(p.lines.find((l) => l.kind === 'transition')!.col, 45);
  assert.equal(p.lines.find((l) => l.kind === 'character')!.runs[0].style & 1, 1);
  assert.equal(p.lines.filter((l) => l.kind === 'character').length, 2);
  assert.ok(new Set(p.lines.map((l) => l.row)).size === p.lines.length, 'stacked dual should not share rows');
  assert.equal(p.lines.find((l) => l.kind === 'heading')!.sceneNumber, '1.');
});

test('system fonts are found and a title in a proportional font is centered', async () => {
  const { listFontFamilies } = await import('../src/main/fonts');
  const fams = listFontFamilies(undefined);
  const sans = fams.find((f) => f.family === 'DejaVu Sans');
  if (!sans) return;
  assert.ok(fams.find((f) => f.family === 'DejaVu Sans Mono')!.mono);
  const lines = 'Title: Wide Wonder\n\nINT. A - DAY'.split('\n');
  const s = { ...S(), titleFont: 'DejaVu Sans', titleSize: 24 };
  const out = renderPdf(paginate(lines, parse(lines), s), s, { families: () => fams });
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(out.pdf), verbosity: 0 }).promise;
  const tc = await (await doc.getPage(1)).getTextContent();
  const item = tc.items.find((i: any) => i.str.includes('WIDE WONDER'));
  const center = item.transform[4] + item.width / 2;
  assert.ok(Math.abs(center - 306) < 2, `title center ${center}`);
});
