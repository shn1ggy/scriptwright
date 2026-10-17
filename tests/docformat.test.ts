import test from 'node:test';
import assert from 'node:assert/strict';
import { blockKind, hasInline, setBlock, toggleInline } from '../src/shared/docformat';

test('italic goes on and off around the selected words', () => {
  const on = toggleInline('one more time', 4, 8, 'i');
  assert.deepEqual(on, { text: 'one *more* time', a: 5, b: 9 });
  assert.ok(hasInline(on.text, on.a, on.b, 'i'));
  assert.deepEqual(toggleInline(on.text, on.a, on.b, 'i'), { text: 'one more time', a: 4, b: 8 });
});

test('the caret inside a word formats the whole word', () => {
  assert.equal(toggleInline('one more', 6, 6, 'b').text, 'one **more**');
});

test('bold and italic combine and come apart again', () => {
  const both = toggleInline('a **bold** b', 4, 8, 'i');
  assert.equal(both.text, 'a ***bold*** b');
  assert.ok(hasInline(both.text, both.a, both.b, 'b') && hasInline(both.text, both.a, both.b, 'i'));
  assert.equal(toggleInline(both.text, both.a, both.b, 'i').text, 'a **bold** b');
  assert.equal(toggleInline('a **bold** b', 4, 8, 'b').text, 'a bold b');
});

test('spaces at the edges of a selection stay outside the markers', () => {
  assert.equal(toggleInline('say it now', 3, 7, 'u').text, 'say _it_ now');
});

test('lines become headings, list items or paragraphs', () => {
  assert.deepEqual(setBlock('Logline', 'h1'), { text: '# Logline', shift: 2 });
  assert.equal(setBlock('# Logline', 'h2').text, '## Logline');
  assert.equal(setBlock('## Logline', 'p').text, 'Logline');
  assert.equal(setBlock('first point', 'li').text, '- first point');
  assert.equal(setBlock('- first point', 'h3').text, '### first point');
  assert.equal(blockKind('### x'), 'h3');
  assert.equal(blockKind('- x'), 'li');
  assert.equal(blockKind('x'), 'p');
});
