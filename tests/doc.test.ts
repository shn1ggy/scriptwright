import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLines, replaceStep, applyStep, invertStep, joinLines, mapPos, wordAt, posAfterInsert } from '../src/shared/doc';

test('typing within a line keeps the key', () => {
  const lines = makeLines('INT. HOUSE\n\nAction');
  const key = lines[0].key;
  const step = replaceStep(lines, { line: 0, ch: 10 }, { line: 0, ch: 10 }, ' - DAY');
  applyStep(lines, step);
  assert.equal(lines[0].text, 'INT. HOUSE - DAY');
  assert.equal(lines[0].key, key);
});

test('Enter at the start of a heading keeps the heading key on the heading', () => {
  const lines = makeLines('INT. HOUSE');
  const key = lines[0].key;
  applyStep(lines, replaceStep(lines, { line: 0, ch: 0 }, { line: 0, ch: 0 }, '\n'));
  assert.equal(lines[1].text, 'INT. HOUSE');
  assert.equal(lines[1].key, key);
  assert.notEqual(lines[0].key, key);
});

test('Enter at end keeps the key on the first line', () => {
  const lines = makeLines('LISA');
  const key = lines[0].key;
  applyStep(lines, replaceStep(lines, { line: 0, ch: 4 }, { line: 0, ch: 4 }, '\n'));
  assert.equal(lines[0].key, key);
  assert.equal(joinLines(lines), 'LISA\n');
});

test('deleting an empty line before a heading keeps the heading key', () => {
  const lines = makeLines('\nINT. HOUSE');
  const key = lines[1].key;
  applyStep(lines, replaceStep(lines, { line: 0, ch: 0 }, { line: 1, ch: 0 }, ''));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].key, key);
});

test('undo restores the exact lines and keys', () => {
  const lines = makeLines('A\nB\nC');
  const before = lines.slice();
  const step = replaceStep(lines, { line: 0, ch: 1 }, { line: 2, ch: 0 }, 'xx\nyy');
  applyStep(lines, step);
  assert.equal(joinLines(lines), 'Axx\nyyC');
  applyStep(lines, invertStep(step));
  assert.deepEqual(lines, before);
});

test('mapPos follows surviving lines', () => {
  const lines = makeLines('one\ntwo\nthree');
  const step = replaceStep(lines, { line: 0, ch: 0 }, { line: 0, ch: 0 }, 'zero\n');
  assert.deepEqual(mapPos({ line: 2, ch: 3 }, step), { line: 3, ch: 3 });
});

test('wordAt and posAfterInsert', () => {
  assert.deepEqual(wordAt('Hello wörld!', 8), [6, 11]);
  assert.deepEqual(posAfterInsert({ line: 2, ch: 3 }, 'a\nbc'), { line: 3, ch: 2 });
});
