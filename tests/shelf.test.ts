import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeOrigin, locateOrigin } from '../src/shared/shelf';

const script = 'INT. ROOM - DAY\n\nAnna sits.\n\nANNA\nHello.\n\nShe leaves.\n';
const cutText = 'ANNA\nHello.\n\n';

test('cut material finds its gap while the surroundings are unchanged', () => {
  const from = script.indexOf(cutText);
  const o = makeOrigin(script, from, from + cutText.length);
  const after = script.slice(0, from) + script.slice(from + cutText.length);
  const m = locateOrigin(after, o, '')!;
  assert.equal(m.quality, 'exact');
  assert.equal(after.slice(0, m.from) + cutText + after.slice(m.from), script);
});

test('edits elsewhere shift the place but still find it', () => {
  const from = script.indexOf(cutText);
  const o = makeOrigin(script, from, from + cutText.length);
  const after = 'Title: Test\n\n' + script.slice(0, from) + script.slice(from + cutText.length);
  const m = locateOrigin(after, o, '')!;
  assert.equal(m.quality, 'exact');
  assert.ok(after.slice(m.from).startsWith('She leaves.'));
});

test('one changed side still finds the place when the other side is unique', () => {
  const from = script.indexOf(cutText);
  const o = makeOrigin(script, from, from + cutText.length);
  const after = script.slice(0, from) + 'He leaves.\n';
  const m = locateOrigin(after, o, '')!;
  assert.equal(m.quality, 'partial');
  assert.equal(m.from, from);
});

test('both sides changed: not found', () => {
  const from = script.indexOf(cutText);
  const o = makeOrigin(script, from, from + cutText.length);
  assert.equal(locateOrigin('Something else entirely.', o, ''), null);
});

test('copied material is found as a range', () => {
  const from = script.indexOf('Hello.');
  const o = makeOrigin(script, from, from + 6);
  const m = locateOrigin(script, o, 'Hello.')!;
  assert.deepEqual([m.from, m.to], [from, from + 6]);
});

test('ambiguous context picks the occurrence nearest the old offset', () => {
  const rep = 'A.\n\nB.\n\nA.\n\nB.\n';
  const from = rep.lastIndexOf('B.');
  const o = makeOrigin(rep, from, from + 2);
  const m = locateOrigin(rep, o, 'B.')!;
  assert.equal(m.from, from);
});
