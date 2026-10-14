import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/shared/fountain';
import { paginate } from '../src/shared/paginate';
import { defaultExportSettings } from '../src/shared/types';
import { followLines, lockStarts, pageLetters, pageStartLines, revisionColor } from '../src/shared/production';

function script(scenes = 24): string[] {
  const out: string[] = ['Title: Test', '', ''];
  for (let k = 1; k <= scenes; k++) {
    out.push(`INT. ROOM ${k} - DAY`, '', `Anna walks into room ${k} and looks around. The light is low and the air smells of rain and old paper.`, '');
    out.push('ANNA', `Is anyone here? I came about the flat in room ${k}. The door was open, so I let myself in.`, '');
    out.push('BEN (O.S.)', 'Upstairs. Mind the third step, it is loose.', '');
  }
  return out;
}

const s = { ...defaultExportSettings('Letter'), titlePage: false };
const body = (lines: string[], lock?: { starts: Array<{ line: number; page: number }> }) => paginate(lines, parse(lines), s, { kind: 'all' }, 0.6, undefined, lock).pages;

function locked(orig: string[]) {
  const starts = pageStartLines(body(orig));
  return (cur: string[]) => body(cur, { starts: lockStarts(orig, starts, cur, parse(cur).bodyStart) });
}

test('locking without changes keeps every page as it was', () => {
  const orig = script();
  const before = body(orig);
  const after = locked(orig)(orig);
  assert.equal(after.length, before.length);
  assert.deepEqual(after.map((p) => p.label), before.map((p) => String(p.number)));
  assert.deepEqual(pageStartLines(after), pageStartLines(before));
});

test('new material that does not fit makes A pages; later pages keep their numbers', () => {
  const orig = script();
  const lockedPages = locked(orig);
  const starts = pageStartLines(body(orig));
  const cur = orig.slice();
  // Add a long action paragraph near the end of page 3.
  const at = starts[3] - 2;
  const extra = Array.from({ length: 12 }, (_, k) => `A new line of action number ${k} that pushes the page over its end.`);
  cur.splice(at, 0, '', ...extra);
  const pages = lockedPages(cur);
  const labels = pages.map((p) => p.label);
  assert.ok(labels.includes('3A'), labels.join(' '));
  assert.equal(labels[labels.indexOf('3A') + 1], '4');
  assert.equal(labels[labels.length - 1], String(body(orig).length));
});

test('a page whose text is gone is joined to the page before', () => {
  const orig = script();
  const starts = pageStartLines(body(orig));
  const cur = orig.slice(0, starts[4]).concat(orig.slice(starts[5]));
  const labels = locked(orig)(cur).map((p) => p.label);
  assert.ok(labels.includes('4-5'), labels.join(' '));
  assert.ok(labels.includes('6'));
});

test('lines are followed to where they are now', () => {
  const m = followLines(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e']);
  assert.deepEqual([...m], [0, 1, 2, 3]);
  const m2 = followLines(['a', 'b', 'c'], ['a', 'c']);
  assert.deepEqual([...m2], [0, 1, 1]);
});

test('revision colours follow the usual order', () => {
  assert.equal(revisionColor(1).name, 'Blue');
  assert.equal(revisionColor(2).name, 'Pink');
  assert.equal(revisionColor(5).name, 'Goldenrod');
  assert.deepEqual([revisionColor(10).prefix, revisionColor(10).name], ['Double', 'Blue']);
  assert.equal(pageLetters(1), 'A');
  assert.equal(pageLetters(27), 'AA');
});

test('sides keep the real pages and strike the other scenes', () => {
  const lines = script();
  const p = parse(lines);
  const wanted = [p.scenes[5].line];
  const r = paginate(lines, p, s, { kind: 'sides', sceneLines: wanted, cover: true, title: 'Test', day: 'Day 3' });
  const [cover, ...pages] = r.pages;
  assert.ok(cover.title?.some((i) => i.text === 'SIDES'));
  assert.ok(cover.title?.some((i) => i.text.includes('ROOM 6')));
  assert.ok(pages.length >= 1 && pages.length <= 2);
  for (const pg of pages) {
    const scene = pg.lines.filter((l) => !l.struck);
    assert.ok(scene.length > 0);
    assert.ok(scene.every((l) => l.sourceLine >= p.scenes[5].line && l.sourceLine < p.scenes[5].end));
  }
  assert.ok(pages.some((pg) => pg.lines.some((l) => l.struck)));
});
