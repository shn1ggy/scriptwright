import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/shared/fountain';
import { planRename, matchCase } from '../src/shared/rename';

const run = (src: string, from: string, to: string) => {
  const lines = src.split('\n');
  const plan = planRename(lines, parse(lines), from, to);
  const out = lines.slice();
  for (const c of plan.changes) out[c.line] = c.text;
  return { text: out.join('\n'), plan };
};

test('case mapping', () => {
  assert.equal(matchCase('LISA', 'Anna'), 'ANNA');
  assert.equal(matchCase('Lisa', 'anna'), 'Anna');
  assert.equal(matchCase('lisa', 'Anna'), 'anna');
  assert.equal(matchCase('Lisa', 'McKenzie'), 'McKenzie');
  assert.equal(matchCase('Lisa', 'anna maria'), 'Anna Maria');
});

test('renames cues, action and dialogue mentions with casing', () => {
  const src = 'INT. HOUSE - DAY\n\nLisa enters. LISA is tired.\n\nLISA (V.O.)\nI am lisa.\n\nTOM\nHi, Lisa! Lisa\'s bag?';
  const { text, plan } = run(src, 'LISA', 'Anna');
  assert.equal(text, 'INT. HOUSE - DAY\n\nAnna enters. ANNA is tired.\n\nANNA (V.O.)\nI am anna.\n\nTOM\nHi, Anna! Anna\'s bag?');
  assert.equal(plan.summary.cues, 1);
  assert.equal(plan.summary.action, 2);
  assert.equal(plan.summary.dialogue, 3);
  assert.equal(plan.summary.merge, false);
});

test('does not touch longer words or names', () => {
  const src = '\nANN\nHi.\n\nANNA\nAnnabel and Ann went. Anne too.';
  const { text } = run(src, 'ANN', 'Eve');
  assert.equal(text, '\nEVE\nHi.\n\nANNA\nAnnabel and Eve went. Anne too.');
});

test('protects longer multi-word character names', () => {
  const src = '\nLISA\nHi.\n\nLISA MARIE\nHello Lisa and Lisa Marie.';
  const { text } = run(src, 'LISA', 'Anna');
  assert.equal(text, '\nANNA\nHi.\n\nLISA MARIE\nHello Anna and Lisa Marie.');
});

test('forced cue drops @ when the uppercase cue works, keeps extensions and dual marker', () => {
  const src = '\n@Lisa (O.S.)\nHi.\n\nTOM ^\nHey.';
  const lines = src.split('\n');
  const p = parse(lines);
  const plan = planRename(lines, p, 'LISA', 'anna');
  assert.equal(plan.changes[0].text, 'ANNA (O.S.)');
  const plan2 = planRename(lines, p, 'TOM', 'Ben');
  assert.equal(plan2.changes[0].text, 'BEN ^');
});

test('merge with existing character is reported', () => {
  const src = '\nLISA\nHi.\n\nTOM\nHey.';
  const { plan } = run(src, 'LISA', 'tom');
  assert.equal(plan.summary.merge, true);
});

test('German names', () => {
  const src = '\nJÖRG\nHallo.\n\nAction: Jörg lacht. Jörgs Hut.';
  const { text } = run(src, 'JÖRG', 'Jürgen');
  assert.equal(text, '\nJÜRGEN\nHallo.\n\nAction: Jürgen lacht. Jürgens Hut.');
});

test('German genitive forms', () => {
  const de = (src: string, a: string, b: string) => {
    const lines = src.split('\n');
    const plan = planRename(lines, parse(lines), a, b, [], 'de');
    const out = lines.slice();
    for (const c of plan.changes) out[c.line] = c.text;
    return out.join('\n');
  };
  assert.equal(de('\nANDREA\nHallo.\n\nAndreas Tasche liegt da. Das ist Andrea.', 'ANDREA', 'Lisa'), '\nLISA\nHallo.\n\nLisas Tasche liegt da. Das ist Lisa.');
  assert.equal(de('\nLISA\nHallo.\n\nLisas Tasche.', 'LISA', 'Andreas'), '\nANDREAS\nHallo.\n\nAndreas\' Tasche.');
  assert.equal(de('\nANDREAS\nHallo.\n\nAndreas\' Tasche.', 'ANDREAS', 'Lisa'), '\nLISA\nHallo.\n\nLisas Tasche.');
  assert.equal(de('\nLISA\nHallo.\n\nLISAS TASCHE.', 'LISA', 'Anna'), '\nANNA\nHallo.\n\nANNAS TASCHE.');
});

test('English possessive forms', () => {
  const en = (src: string, a: string, b: string) => {
    const lines = src.split('\n');
    const plan = planRename(lines, parse(lines), a, b, [], 'en');
    const out = lines.slice();
    for (const c of plan.changes) out[c.line] = c.text;
    return out.join('\n');
  };
  assert.equal(en("\nANDREA\nHi.\n\nAndrea's bag. Andrea’s coat.", 'ANDREA', 'Lisa'), "\nLISA\nHi.\n\nLisa's bag. Lisa’s coat.");
  assert.equal(en("\nJAMES\nHi.\n\nJames' bag.", 'JAMES', 'Lisa'), "\nLISA\nHi.\n\nLisa's bag.");
  assert.equal(en('\nMARK\nHi.\n\nHe marks the spot. Marks on the wall.', 'MARK', 'Paul'), '\nPAUL\nHi.\n\nHe marks the spot. Pauls on the wall.');
});

test('a character named like the genitive is protected', () => {
  const lines = '\nANDREA\nHi.\n\nANDREAS\nHey.\n\nAndrea and Andreas talk.'.split('\n');
  const plan = planRename(lines, parse(lines), 'ANDREA', 'Lisa', [], 'de');
  const out = lines.slice();
  for (const c of plan.changes) out[c.line] = c.text;
  assert.equal(out.join('\n'), '\nLISA\nHi.\n\nANDREAS\nHey.\n\nLisa and Andreas talk.');
});

test('language guess', async () => {
  const { guessLanguage } = await import('../src/shared/rename');
  assert.equal(guessLanguage(['INNEN. KÜCHE - NACHT', 'Sie sitzt und isst nicht.']), 'de');
  assert.equal(guessLanguage(['INT. KITCHEN - NIGHT', 'She sits and does not eat.']), 'en');
});
