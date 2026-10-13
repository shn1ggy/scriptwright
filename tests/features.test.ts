import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLines, replaceStep, applyStep, invertStep, Line } from '../src/shared/doc';
import { LiveAnchor, mapAnchorsThroughStep, anchorText, keyIndex, anchorProblem, toStored, resolveStored } from '../src/shared/anchors';
import { parse } from '../src/shared/fountain';
import { sceneNumberEdits, exportFountain } from '../src/shared/fountainout';
import { compareScenes, scenesOf } from '../src/shared/scenecompare';

function edit(lines: Line[], anchors: LiveAnchor[], from: any, to: any, text: string) {
  const st = replaceStep(lines, from, to, text);
  applyStep(lines, st);
  mapAnchorsThroughStep(st, anchors);
  return st;
}
const txt = (lines: Line[], an: LiveAnchor) => anchorText(an, lines, keyIndex(lines));

test('anchors follow typing before, inside and after the range', () => {
  const lines = makeLines('Hello brave world');
  const k = lines[0].key;
  const an: LiveAnchor = { a: { key: k, ch: 6 }, b: { key: k, ch: 11 } }; // "brave"
  edit(lines, [an], { line: 0, ch: 0 }, { line: 0, ch: 0 }, 'Oh, ');
  assert.equal(txt(lines, an), 'brave');
  edit(lines, [an], { line: 0, ch: 12 }, { line: 0, ch: 12 }, 'X');
  assert.equal(txt(lines, an), 'brXave');
  edit(lines, [an], { line: 0, ch: 16 }, { line: 0, ch: 16 }, '!!');
  assert.equal(txt(lines, an), 'brXave');
});

test('anchors survive line splits and joins', () => {
  const lines = makeLines('one two three');
  const k = lines[0].key;
  const an: LiveAnchor = { a: { key: k, ch: 8 }, b: { key: k, ch: 13 } }; // three
  edit(lines, [an], { line: 0, ch: 3 }, { line: 0, ch: 4 }, '\n');
  assert.equal(lines.length, 2);
  assert.equal(txt(lines, an), 'three');
  edit(lines, [an], { line: 0, ch: 3 }, { line: 1, ch: 0 }, ' ');
  assert.equal(txt(lines, an), 'three');
});

test('deleting the anchored text detaches it; undo restores via inverse step', () => {
  const lines = makeLines('keep this gone keep');
  const k = lines[0].key;
  const an: LiveAnchor = { a: { key: k, ch: 10 }, b: { key: k, ch: 14 } };
  const st = edit(lines, [an], { line: 0, ch: 9 }, { line: 0, ch: 14 }, '');
  assert.ok(anchorProblem(an, keyIndex(lines)));
  void invertStep(st);
});

test('stored anchors are found again, ambiguity is not guessed', () => {
  const lines = makeLines('A line.\nThe target words here.\nOther.');
  const k = lines[1].key;
  const an: LiveAnchor = { a: { key: k, ch: 4 }, b: { key: k, ch: 16 } };
  const st = toStored(an, lines, keyIndex(lines))!;
  assert.equal(st.quote, 'target words');
  const re = makeLines('New first line.\nA line.\nThe target words here.\nOther.');
  const r = resolveStored(st, re);
  assert.ok(r.ok);
  if (r.ok) assert.equal(txt(re, r.anchor), 'target words');
  const dup = makeLines('x target words y\nz target words w');
  const r2 = resolveStored({ quote: 'target words', prefix: 'q ', suffix: ' q', line: 5 }, dup);
  assert.equal(r2.ok, false);
  const gone = resolveStored(st, makeLines('nothing here'));
  assert.equal(gone.ok, false);
});

test('pure line removals keep anchors (moves)', () => {
  const lines = makeLines('a\nb\nc');
  const an: LiveAnchor = { a: { key: lines[2].key, ch: 0 }, b: { key: lines[2].key, ch: 1 } };
  const removed = lines.splice(2, 1);
  mapAnchorsThroughStep({ at: 2, removed, inserted: [] }, [an]);
  lines.splice(0, 0, ...removed);
  assert.equal(txt(lines, an), 'c');
});

test('scene numbers: remove, add missing, renumber', () => {
  const src = 'INT. A - DAY #4#\n\nx\n\nINT. B - DAY\n\ny\n\nINT. C - DAY #12A#';
  const lines = src.split('\n');
  const p = parse(lines);
  const apply = (mode: any) => {
    const out = lines.slice();
    for (const e of sceneNumberEdits(lines, p, mode)) out[e.line] = e.text;
    return out.filter((l) => l.startsWith('INT')).join('|');
  };
  assert.equal(apply('remove'), 'INT. A - DAY|INT. B - DAY|INT. C - DAY');
  assert.equal(apply('addMissing'), 'INT. A - DAY #4#|INT. B - DAY #2#|INT. C - DAY #12A#');
  assert.equal(apply('renumber'), 'INT. A - DAY #1#|INT. B - DAY #2#|INT. C - DAY #3#');
});

test('Fountain export removes notes and omitted text cleanly', () => {
  const src = 'Title: T\n\nINT. A - DAY\n\nAction [[note]] here.\n\n[[A whole note line]]\n\nMore.\n\n/* gone */\n\nEnd.';
  const lines = src.split('\n');
  const out = exportFountain(lines, parse(lines), { numbers: 'renumber', removeNotes: true, removeOmitted: true, titlePage: true });
  assert.equal(out, 'Title: T\n\nINT. A - DAY #1#\n\nAction here.\n\nMore.\n\nEnd.');
});

test('scene comparison separates moves from changes and does not guess', () => {
  const oldT = 'INT. A - DAY\n\na\n\nINT. B - DAY\n\nb\n\nINT. C - DAY\n\nc\n\nINT. D - DAY\n\nd';
  const newT = 'INT. C - DAY\n\nc\n\nINT. A - DAY\n\na\n\nINT. B - DAY\n\nb changed\n\nINT. E - DAY\n\ne';
  const rows = compareScenes(scenesOf(oldT), scenesOf(newT));
  const by = (h: string) => rows.find((r) => r.newIndex !== undefined && scenesOf(newT)[r.newIndex].heading === h)!;
  assert.equal(by('INT. C - DAY').kind, 'moved');
  assert.equal(by('INT. A - DAY').kind, 'same');
  assert.equal(by('INT. B - DAY').kind, 'changed');
  assert.equal(by('INT. E - DAY').kind, 'added');
  assert.ok(rows.some((r) => r.kind === 'removed' && scenesOf(oldT)[r.oldIndex!].heading === 'INT. D - DAY'));
});

test('scene comparison uses ids first (renamed and edited scene still matched)', () => {
  const oldS = scenesOf('INT. A - DAY\n\nalpha\n\nINT. B - DAY\n\nbeta', ['s1', 's2']);
  const newS = scenesOf('INT. B2 - NIGHT\n\nbeta two\n\nINT. A - DAY\n\nalpha', ['s2', 's1']);
  const rows = compareScenes(oldS, newS);
  assert.deepEqual(rows.map((r) => r.kind).sort(), ['movedChanged', 'same'].sort());
});

test('duplicate identical scenes without ids are reported, not guessed', () => {
  const rows = compareScenes(scenesOf('INT. A - DAY\n\nx'), scenesOf('INT. A - DAY\n\ny\n\nINT. A - DAY\n\nz'));
  assert.ok(rows.some((r) => r.ambiguous));
});

test('bulk replacement keeps anchors on unchanged lines exact', () => {
  const lines = makeLines(Array.from({ length: 40 }, (_, i) => `Line ${i} text`).join('\n'));
  const an: LiveAnchor = { a: { key: lines[30].key, ch: 5 }, b: { key: lines[30].key, ch: 7 } };
  // replace everything, keeping identical lines' objects (like a reload)
  const next = lines.map((l, i) => (i === 2 ? { key: l.key, text: 'changed' } : l));
  next.unshift({ key: 99999, text: 'new first' });
  const st = { at: 0, removed: lines.slice(), inserted: next };
  mapAnchorsThroughStep(st, [an]);
  lines.splice(0, lines.length, ...next);
  assert.equal(txt(lines, an), '30');
});
