import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { parse, titleFields } from '../src/shared/fountain';
import { exportFdx, importFdx } from '../src/shared/fdx';
import { styledText } from '../src/shared/paginate';

/** Element sequence with clean text, as the PDF would print it. */
function elements(text: string) {
  const lines = text.replace(/\r/g, '').split('\n');
  const p = parse(lines);
  const out: string[] = [];
  for (let i = p.titleEnd; i < lines.length; i++) {
    const pl = p.lines[i];
    if (['blank', 'note', 'section', 'synopsis', 'boneyard'].includes(pl.type)) continue;
    const t = styledText(lines[i], pl.flags).text.trim();
    out.push(`${pl.type}${pl.dual ? ':' + pl.dual : ''}|${pl.sceneNumber ?? ''}|${t}`);
  }
  return out;
}

const roundTrip = (src: string, nums?: string[]) => {
  const lines = src.replace(/\r/g, '').split('\n');
  return importFdx(exportFdx(lines, parse(lines), { sceneNumbers: nums }));
};

test('a screenplay survives Fountain → Final Draft → Fountain', () => {
  const extra = process.env.FDX_EXTRA ? [process.env.FDX_EXTRA] : [];
  for (const f of ['e2e/fixtures/sample.fountain', 'e2e/fixtures/long.fountain', ...extra]) {
    const src = fs.readFileSync(path.resolve(f), 'utf8');
    const back = roundTrip(src);
    assert.deepEqual(elements(back), elements(src).map((e) => e.replace(/^(heading[^|]*)\|[^|]*\|/, '$1||')), f);
  }
});

test('emphasis, dual dialogue, page breaks, scene numbers and the title page', () => {
  const src = [
    'Title: The Long Night',
    'Credit: written by',
    'Author: Mara Lindqvist',
    'Draft date: 1 May 2026',
    'Contact: mara@example.com',
    '',
    'INT. HOUSE - NIGHT #4A#',
    '',
    'She **really** *means* it. _Now._',
    '',
    'BRICK',
    'Screw.',
    '',
    'STEEL ^',
    'Retirement.',
    '',
    '===',
    '',
    '.FLASHBACK',
    '',
    '> THE END <',
    '',
    'CUT TO:',
  ].join('\n');
  const lines = src.split('\n');
  const xml = exportFdx(lines, parse(lines), { sceneNumbers: ['4A', '5'] });
  assert.match(xml, /<Paragraph Type="Scene Heading" Number="4A"><Text>INT\. HOUSE - NIGHT<\/Text>/);
  assert.match(xml, /<Text Style="Bold">really<\/Text>/);
  assert.match(xml, /<DualDialogue>/);
  assert.match(xml, /StartsNewPage="Yes"/);
  assert.match(xml, /Alignment="Center"/);
  const back = importFdx(xml);
  assert.deepEqual(elements(back), elements(src).map((e) => e.replace('heading|5|', 'heading|5|')).map((e, i) => (i === 0 ? e : e)).map((e) => (e.startsWith('heading||FLASHBACK') ? 'heading|5|FLASHBACK' : e)));
  assert.match(back, /\*\*really\*\*/);
  const bl = back.split('\n');
  const tf = titleFields(bl, parse(bl));
  const get = (k: string) => tf.find((f) => f.key === k)?.value;
  assert.equal(get('title'), 'THE LONG NIGHT');
  assert.equal(get('credit'), 'written by');
  assert.equal(get('author'), 'Mara Lindqvist');
  assert.equal(get('contact'), 'mara@example.com');
  assert.equal(get('draft date'), '1 May 2026');
});

test('reads a Final Draft file written by Final Draft', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<FinalDraft DocumentType="Script" Template="No" Version="5">
<Content>
<Paragraph Number="1" Type="Scene Heading"><SceneProperties Length="1" Page="1" Title=""/><Text>INT. KITCHEN - DAY</Text></Paragraph>
<Paragraph Type="Action"><Text>Ana stirs the soup. </Text><Text Style="Italic">Slowly.</Text></Paragraph>
<Paragraph Type="Character"><Text>Ana</Text></Paragraph>
<Paragraph Type="Parenthetical"><Text>(quiet)</Text></Paragraph>
<Paragraph Type="Dialogue"><Text>It needs salt &amp; time.</Text></Paragraph>
<Paragraph Type="Transition"><Text>FADE OUT.</Text></Paragraph>
</Content>
</FinalDraft>`;
  const f = importFdx(xml);
  assert.deepEqual(elements(f), [
    'heading||INT. KITCHEN - DAY'.replace('||', '|1|'),
    'action||Ana stirs the soup. Slowly.',
    'character||Ana',
    'parenthetical||(quiet)',
    'dialogue||It needs salt & time.',
    'transition||FADE OUT.',
  ]);
  assert.match(f, /\*Slowly\.\*/);
});
