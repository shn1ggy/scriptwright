import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/shared/fountain';
import { insertedNumber, isOmittedHeading, omittedHeading, sceneNumberList } from '../src/shared/scenenumbers';
import { paginate } from '../src/shared/paginate';
import { defaultExportSettings } from '../src/shared/types';

const P = (t: string) => parse(t.split('\n'));

test('unlocked scripts count 1, 2, 3', () => {
  const p = P('INT. A - DAY\n\nx\n\nEXT. B - NIGHT\n\ny');
  assert.deepEqual(sceneNumberList(p, false), ['1', '2']);
  assert.deepEqual(sceneNumberList(P('INT. A #7#\n\nINT. B'), false), ['7', '2']);
});

test('locked scripts keep written numbers; new scenes take letters', () => {
  const p = P('.NEW FIRST\n\nINT. A - DAY #1#\n\nINT. NEW - DAY\n\nINT. NEWER - DAY\n\nEXT. B - NIGHT #2#\n\nINT. C #2A#\n\nINT. D');
  assert.deepEqual(sceneNumberList(p, true), ['A1', '1', '1A', '1B', '2', '2A', '2B']);
});

test('letters roll over and taken numbers are skipped', () => {
  assert.equal(insertedNumber('12'), '12A');
  assert.equal(insertedNumber('12Z'), '12AA');
  const p = P('INT. A #3#\n\nINT. NEW\n\nINT. B #3A#');
  assert.deepEqual(sceneNumberList(p, true), ['3', '3B', '3A']);
});

test('omitted scenes keep their number in the PDF', () => {
  const h = omittedHeading('12', 'de');
  assert.equal(h, '.ENTFÄLLT #12#');
  assert.ok(isOmittedHeading(h) && isOmittedHeading('.OMITTED #4#') && !isOmittedHeading('INT. OMITTED HOUSE'));
  const lines = ['INT. A #11#', '', 'x', '', h, '', 'INT. NEW', '', 'y'];
  const r = paginate(lines, parse(lines), { ...defaultExportSettings('A4'), font: 'Courier', numbersLocked: true });
  const nums = r.pages.flatMap((pg) => pg.lines.filter((l) => l.sceneNumber).map((l) => l.sceneNumber));
  assert.deepEqual(nums, ['11', '12', '12A']);
});
