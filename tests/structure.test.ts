import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/shared/fountain';
import { STORY_MODELS, deltaLabel, modelFor, placeBeats, scenePositions, sectionsOf } from '../src/shared/structure';

const T = '# Act One\n\nINT. A - DAY\n\nx\n\nEXT. B - NIGHT\n\ny\n\n# Act Two\n\n## The chase\n\n= They run.\n\nINT. C - DAY\n\nz\n\nINT. D - DAY\n\nw';
const lines = T.split('\n');
const P = parse(lines);

test('acts and sequences come from sections', () => {
  const s = sectionsOf(P, lines);
  assert.deepEqual(s.map((x) => [x.level, x.title, x.firstScene, x.endScene]), [
    [1, 'Act One', 0, 2],
    [1, 'Act Two', 2, 4],
    [2, 'The chase', 2, 4],
  ]);
});

test('a scene ends before an act that follows it', () => {
  const b = P.scenes[1];
  assert.equal(lines[b.line], 'EXT. B - NIGHT');
  assert.ok(b.end <= lines.indexOf('# Act Two'));
  assert.ok(lines.slice(b.line, b.end).includes('y'));
  // A section inside a scene (followed by more of the scene) does not cut it.
  const q = parse('INT. A - DAY\n\n# note\n\nx\n\nINT. B - DAY'.split('\n'));
  assert.equal(q.scenes[0].end, 6);
});

test('scene positions follow the pages', () => {
  const pages = [
    { lines: [{ row: 0, sourceLine: 10 }, { row: 30, sourceLine: 20 }] },
    { lines: [{ row: 0, sourceLine: 21 }, { row: 27, sourceLine: 30 }, { row: 53, sourceLine: 31 }] },
  ];
  const r = scenePositions(pages, 54, [10, 20, 30]);
  assert.equal(r.total, 2);
  assert.equal(r.scenes[0].start, 0);
  assert.ok(Math.abs(r.scenes[1].start - 30 / 54) < 1e-9);
  assert.ok(Math.abs(r.scenes[2].start - 1.5) < 1e-9);
  assert.ok(Math.abs(r.scenes[2].length - 0.5) < 1e-9);
});

test('beats compare typical and actual pages', () => {
  const m = modelFor('three-act');
  const pos = [0, 25, 50, 75].map((s) => ({ start: s, length: 25 }));
  const placed = placeBeats(m, { midpoint: 1 }, pos, 100);
  const mid = placed.find((p) => p.beat.id === 'midpoint')!;
  assert.equal(mid.typical, 50);
  assert.equal(mid.actual, 25);
  assert.equal(deltaLabel(mid.delta!), '25 pages earlier');
  assert.equal(deltaLabel(0.3), 'as typical');
  assert.equal(deltaLabel(1), '1 page later');
  assert.equal(placed.filter((p) => p.actual == null).length, m.beats.length - 1);
});

test('every model has ordered parts and beats within the script', () => {
  for (const m of STORY_MODELS) {
    assert.ok(m.beats.length > 0, m.id);
    for (const b of m.beats) assert.ok(b.at >= 0 && b.at <= 1 && (b.to == null || b.to >= b.at), `${m.id}/${b.id}`);
    for (let i = 1; i < m.phases.length; i++) assert.ok(Math.abs(m.phases[i].from - m.phases[i - 1].to) < 1e-9, m.id);
    assert.equal(new Set(m.beats.map((b) => b.id)).size, m.beats.length, m.id);
  }
  assert.equal(modelFor('custom', [{ id: 'x', name: 'X', at: 0.4 }, { id: 'y', name: 'Y', at: 0.1 }]).beats[0].id, 'y');
});
