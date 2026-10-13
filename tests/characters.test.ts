import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/shared/fountain';
import { analyzeCharacters } from '../src/shared/characters';

const text = `INT. KITCHEN - DAY

LISA (60s) cleans. TOM (40s) watches. A POSTMAN (30) drops a letter.

LISA
Where were you?

TOM
(quietly)
Out. Looking for Lisa's cat.

LISA
Again?

EXT. GARDEN - NIGHT

Tom waits alone.

TOM
Nobody.

INT. HALL - NIGHT

Lisas Mantel hängt am Haken.
`;

test('speaking characters: cues, words, scenes, mentions and shared scenes', () => {
  const lines = text.split('\n');
  const p = parse(lines);
  const scenes = p.scenes.map((s) => ({ line: s.line, end: s.end }));
  const r = analyzeCharacters(lines, p, scenes);
  const lisa = r.find((c) => c.name === 'LISA')!;
  const tom = r.find((c) => c.name === 'TOM')!;
  assert.equal(lisa.cues, 2);
  assert.equal(lisa.words, 4);
  assert.deepEqual(lisa.speaksIn, [0]);
  assert.deepEqual(lisa.mentionedIn, [2], 'German possessive in scene 3');
  assert.equal(tom.cues, 2);
  assert.equal(tom.parentheticals, 1);
  assert.deepEqual(tom.speaksIn, [0, 1]);
  assert.equal(tom.firstScene, 0);
  assert.equal(tom.lastScene, 1);
  assert.deepEqual(lisa.sharedWith, [{ name: 'TOM', scenes: 1 }]);
  assert.ok(Math.abs(lisa.share + tom.share - 1) < 1e-9);
});

test('characters introduced in action who never speak are listed as silent', () => {
  const lines = text.split('\n');
  const p = parse(lines);
  const r = analyzeCharacters(lines, p, p.scenes.map((s) => ({ line: s.line, end: s.end })));
  const postman = r.find((c) => c.name === 'POSTMAN');
  assert.ok(postman && postman.silent && postman.cues === 0, JSON.stringify(r.map((c) => c.name)));
  assert.ok(!r.find((c) => c.name === 'LISA')!.silent);
});
