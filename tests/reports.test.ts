import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/shared/fountain';
import { paginate } from '../src/shared/paginate';
import { defaultExportSettings } from '../src/shared/types';
import { buildReports, headingParts, toCsv } from '../src/shared/reports';

test('scene headings split into int./ext., location and time', () => {
  assert.deepEqual(headingParts('INT. KITCHEN - NIGHT'), { intExt: 'INT.', location: 'KITCHEN', time: 'NIGHT' });
  assert.deepEqual(headingParts('EXT. FARM - BARN - DAY #12#'), { intExt: 'EXT.', location: 'FARM – BARN', time: 'DAY' });
  assert.deepEqual(headingParts('INNEN/TAG — COPYSHOP'), { intExt: 'INNEN', location: 'COPYSHOP', time: 'TAG' });
  assert.deepEqual(headingParts('AUSSEN/DÄMMERUNG — STRASSE'), { intExt: 'AUSSEN', location: 'STRASSE', time: 'DÄMMERUNG' });
  assert.deepEqual(headingParts('INT. NIGHT CLUB - DAY'), { intExt: 'INT.', location: 'NIGHT CLUB', time: 'DAY' });
  assert.deepEqual(headingParts('INT./EXT. CAR - CONTINUOUS'), { intExt: 'INT./EXT.', location: 'CAR', time: 'CONTINUOUS' });
});

test('reports: scenes with pages and eighths, cast, locations and breakdown', () => {
  const lines = [
    'INT. KITCHEN - NIGHT',
    '',
    'LISA (30s) stirs a pot. TOM watches from the door with a GUN.',
    '',
    'LISA',
    'Dinner is ready.',
    '',
    'EXT. GARDEN - DAY',
    '',
    'Rain.',
    '',
    'INT. KITCHEN - DAY',
    '',
    'TOM',
    'Where is everyone?',
    '',
  ];
  const p = parse(lines);
  const s = { ...defaultExportSettings('Letter'), titlePage: false };
  const r = paginate(lines, p, s);
  const rep = buildReports(lines, p, ['1', '2', '3'], r.pages, r.capacity.linesPerPage, [{ category: 'props', name: 'gun', line: 2 }, { category: 'props', name: 'Gun', line: 2 }]);
  assert.equal(rep.scenes.length, 3);
  assert.equal(rep.scenes[0].page, '1');
  assert.ok(rep.scenes.every((x) => x.eighths >= 1));
  assert.deepEqual(rep.scenes[0].speaking, ['LISA']);
  assert.deepEqual(rep.scenes[0].tags.props, ['gun']);
  assert.deepEqual(rep.locations.map((l) => [l.location, l.scenes.join(',')]), [['KITCHEN', '1,3'], ['GARDEN', '2']]);
  assert.deepEqual(rep.locations[0].times, ['NIGHT', 'DAY']);
  const lisa = rep.cast.find((c) => c.name === 'LISA')!;
  assert.equal(lisa.speeches, 1);
  assert.deepEqual(rep.cast.find((c) => c.name === 'TOM')!.scenes, ['1', '3']);
});

test('CSV quotes cells that need it', () => {
  assert.equal(toCsv([['a', 'b,c', 'say "hi"']]), '﻿a,"b,c","say ""hi"""\r\n');
});
