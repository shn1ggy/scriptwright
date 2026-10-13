import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/shared/fountain';
import { computeChanges } from '../src/shared/revisions';

const OPTS = { ignoreOrder: true, ignoreSceneNumbers: true, markDeletions: true, markMoved: false };
const run = (base: string, cur: string, opts = OPTS, baseIds?: string[], curIds?: string[]) => {
  const lines = cur.split('\n');
  const p = parse(lines);
  const ch = computeChanges(lines, p, curIds ?? p.scenes.map(() => undefined), base, baseIds, opts);
  const changedWords = (i: number) => {
    const m = ch.chars.get(i);
    if (!m) return '';
    return lines[i].split('').filter((_, k) => m[k]).join('');
  };
  return { ch, lines, changedWords };
};

const BASE = 'INT. A - DAY\n\nAnna walks in.\n\nANNA\nHello there.\n\nINT. B - DAY\n\nBen waits.\n\nINT. C - DAY\n\nCarla sleeps.';

test('only changed words are marked', () => {
  const { ch, changedWords, lines } = run(BASE, BASE.replace('Hello there.', 'Hello again there.'));
  const i = lines.indexOf('Hello again there.');
  assert.equal(changedWords(i), 'again');
  assert.deepEqual([...ch.marked], [i]);
});

test('reordered scenes are not marked when ignoring order', () => {
  const moved = 'INT. C - DAY\n\nCarla sleeps.\n\nINT. A - DAY\n\nAnna walks in.\n\nANNA\nHello there.\n\nINT. B - DAY\n\nBen waits.';
  const { ch } = run(BASE, moved);
  assert.equal(ch.marked.size, 0);
  assert.equal(ch.stats.movedScenes, 1);
  const strict = run(BASE, moved, { ...OPTS, ignoreOrder: false });
  assert.ok(strict.ch.marked.size > 0);
  const markMoved = run(BASE, moved, { ...OPTS, markMoved: true });
  assert.equal(markMoved.ch.marked.size, 1);
});

test('deleting a scene marks only the place where it was', () => {
  const del = BASE.replace('INT. B - DAY\n\nBen waits.\n\n', '');
  const { ch, lines } = run(BASE, del);
  assert.deepEqual([...ch.marked], [lines.indexOf('INT. C - DAY')]);
  assert.equal(ch.chars.size, 0);
  assert.equal(ch.stats.removedScenes, 1);
});

test('written scene numbers can be ignored', () => {
  const numbered = BASE.replace('INT. A - DAY', 'INT. A - DAY #1#').replace('INT. B - DAY', 'INT. B - DAY #2#');
  assert.equal(run(BASE, numbered).ch.marked.size, 0);
  assert.ok(run(BASE, numbered, { ...OPTS, ignoreSceneNumbers: false }).ch.marked.size > 0);
});

test('added scene is marked completely; removed words mark the line', () => {
  const add = BASE + '\n\nINT. D - DAY\n\nNew things.';
  const r = run(BASE, add);
  assert.equal(r.changedWords(r.lines.indexOf('New things.')), 'Newthings.');
  const rem = run(BASE, BASE.replace('Ben waits.', 'Ben.'));
  const i = rem.lines.indexOf('Ben.');
  assert.ok(rem.ch.marked.has(i));
});

test('renamed heading with scene ids still matches', () => {
  const cur = BASE.replace('INT. B - DAY', 'EXT. B - NIGHT');
  const r = run(BASE, cur, OPTS, ['a', 'b', 'c'], ['a', 'b', 'c']);
  assert.equal(r.changedWords(r.lines.indexOf('EXT. B - NIGHT')), 'EXT.NIGHT');
  assert.equal(r.ch.stats.addedScenes, 0);
});
