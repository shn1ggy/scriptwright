import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPattern, findMatches, matchCase, replacementFor, FindOptions } from '../src/shared/findreplace';

const opts = (o: Partial<FindOptions> = {}): FindOptions => ({ caseSensitive: false, wholeWord: false, regex: false, preserveCase: true, ...o });
const lines = (s: string) => s.split('\n').map((text) => ({ text }));

function replaceAllIn(text: string, q: string, repl: string, o: FindOptions) {
  const L = lines(text);
  const re = buildPattern(q, o) as RegExp;
  const ms = findMatches(L, re);
  for (let k = ms.length - 1; k >= 0; k--) {
    const m = ms[k];
    const t = L[m.line].text;
    L[m.line].text = t.slice(0, m.from) + replacementFor(t, m, re, repl, o) + t.slice(m.to);
  }
  return L.map((l) => l.text).join('\n');
}

test('plain text is escaped and case-insensitive by default', () => {
  const re = buildPattern('a.b', opts()) as RegExp;
  assert.equal(findMatches(lines('A.B axb a.b'), re).length, 2);
});

test('whole word respects umlauts and other letters', () => {
  const re = buildPattern('Tür', opts({ wholeWord: true })) as RegExp;
  const ms = findMatches(lines('Tür Türen Haustür tür.'), re);
  assert.deepEqual(ms.map((m) => m.from), [0, 18]);
});

test('invalid regex reports an error instead of throwing', () => {
  assert.equal(typeof buildPattern('(', opts({ regex: true })), 'string');
  assert.equal(typeof buildPattern('(', opts()), 'object');
});

test('matchCase follows upper, lower and capitalised shapes', () => {
  assert.equal(matchCase('ANDREA', 'Maria'), 'MARIA');
  assert.equal(matchCase('Andrea', 'maria'), 'Maria');
  assert.equal(matchCase('andrea', 'Maria'), 'maria');
  assert.equal(matchCase('AnDrea', 'Maria'), 'Maria');
  assert.equal(matchCase("ANDREA'S", 'Maria'), 'MARIA');
});

test('replace all with preserved case touches cues and action alike', () => {
  const out = replaceAllIn('ANDREA\nHi.\n\nAndrea waves. andrea!', 'andrea', 'Maria', opts());
  assert.equal(out, 'MARIA\nHi.\n\nMaria waves. maria!');
});

test('case-sensitive replace leaves other spellings alone', () => {
  const out = replaceAllIn('Ben BEN ben', 'Ben', 'Tom', opts({ caseSensitive: true }));
  assert.equal(out, 'Tom BEN ben');
});

test('regex groups and lookbehind see the whole line', () => {
  const out = replaceAllIn('INT. HOUSE - DAY\nEXT. PARK - NIGHT', '^(INT|EXT)\\. (.*) - (DAY|NIGHT)$', '$1. $2 -- $3', opts({ regex: true, preserveCase: false }));
  assert.equal(out, 'INT. HOUSE -- DAY\nEXT. PARK -- NIGHT');
  const out2 = replaceAllIn('xa ya', '(?<=y)a', 'b', opts({ regex: true }));
  assert.equal(out2, 'xa yb');
});

test('zero-length regex matches are skipped', () => {
  const re = buildPattern('x*', opts({ regex: true })) as RegExp;
  assert.deepEqual(findMatches(lines('abxxc'), re), [{ line: 0, from: 2, to: 4 }]);
});

test('include filter and limit', () => {
  const re = buildPattern('a', opts()) as RegExp;
  assert.equal(findMatches(lines('a\na\na'), re, (i) => i !== 1).length, 2);
  assert.equal(findMatches(lines('aaaa'), re, undefined, 2).length, 2);
});
