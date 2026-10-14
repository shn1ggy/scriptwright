import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, cleanText, characterList, characterLabel, F_MARKER, F_BOLD, F_ITALIC, F_UNDERLINE, titleFields } from '../src/shared/fountain';

const L = (s: string) => s.split('\n');
const types = (s: string, opts = {}) => parse(L(s), opts).lines.map((l) => l.type);

test('scene headings, standard and configured prefixes', () => {
  const r = parse(L('INT. HOUSE - DAY\n\nAction.\n\nINNEN. KÜCHE - NACHT\n\nEXT/INT nope\n\nint. lower - day'), { extraPrefixes: ['INNEN'] });
  assert.equal(r.lines[0].type, 'heading');
  assert.equal(r.lines[4].type, 'heading');
  assert.equal(r.lines[8].type, 'heading');
  assert.equal(r.lines[6].type, 'action');
  assert.deepEqual(r.scenes.map((s) => s.heading), ['INT. HOUSE - DAY', 'INNEN. KÜCHE - NACHT', 'int. lower - day']);
  assert.deepEqual(r.scenes.map((s) => s.order), [1, 2, 3]);
});

test('heading needs a blank line before it', () => {
  assert.deepEqual(types('Some action\nINT. HOUSE - DAY'), ['action', 'action']);
});

test('forced heading hides the dot; ellipsis is not a heading', () => {
  const r = parse(L('.FLASHBACK\n\n...and then'));
  assert.equal(r.lines[0].type, 'heading');
  assert.ok(r.lines[0].flags![0] & F_MARKER);
  assert.equal(r.scenes[0].heading, 'FLASHBACK');
  assert.equal(r.lines[2].type, 'action');
});

test('scene numbers are parsed and hidden', () => {
  const r = parse(L('INT. HOUSE - DAY #12A#'));
  assert.equal(r.lines[0].sceneNumber, '12A');
  assert.equal(r.scenes[0].heading, 'INT. HOUSE - DAY');
});

test('character cue, parenthetical, dialogue, blank ends block', () => {
  const t = types('\nLISA (V.O.)\n(quietly)\nHello there.\n\nAfter.');
  assert.deepEqual(t, ['blank', 'character', 'parenthetical', 'dialogue', 'blank', 'action']);
  const r = parse(L('\nLISA (V.O.)\nHi.'));
  assert.equal(r.lines[1].cue, 'LISA');
});

test('uppercase line followed by blank is action, not a cue', () => {
  assert.deepEqual(types('\nBOOM\n\nText'), ['blank', 'action', 'blank', 'action']);
});

test('uppercase line inside an action paragraph is not a cue', () => {
  assert.deepEqual(types('He shouts.\nSTOP\nHe stops.'), ['action', 'action', 'action']);
});

test('cue + Enter: empty caret line allows dialogue writing', () => {
  const r = parse(L('\nLISA\n'), { activeLine: 2 });
  assert.equal(r.lines[1].type, 'character');
  assert.equal(r.lines[2].type, 'dialogue');
  // Without the caret there, it is just action.
  assert.equal(parse(L('\nLISA\n')).lines[1].type, 'action');
});

test('forced character with @ and mixed case', () => {
  const r = parse(L('\n@McCLANE\nYippee.'));
  assert.equal(r.lines[1].type, 'character');
  assert.equal(r.lines[1].cue, 'MCCLANE');
  assert.ok(r.lines[1].flags![0] & F_MARKER);
});

test('forced action with ! keeps uppercase as action', () => {
  const r = parse(L('\n!SCREAMING\nMore'));
  assert.equal(r.lines[1].type, 'action');
});

test('transitions: TO: with blank lines, forced >', () => {
  assert.deepEqual(types('\nCUT TO:\n\n> FADE OUT.'), ['blank', 'transition', 'blank', 'transition']);
});

test('centered text hides > and <', () => {
  const r = parse(L('> THE END <'));
  assert.equal(r.lines[0].type, 'centered');
  assert.equal(cleanText('> THE END <', r.lines[0].flags), 'THE END');
});

test('lyrics, page break, section, synopsis', () => {
  assert.deepEqual(types('~La la\n\n===\n\n# Act One\n\n= Synopsis here'), ['lyric', 'blank', 'pageBreak', 'blank', 'section', 'blank', 'synopsis']);
  const r = parse(L('## Sequence'));
  assert.equal(r.lines[0].level, 2);
});

test('emphasis: bold, italic, bold italic, underline, escapes', () => {
  const s = 'A **bold** and *it* and ***both*** and _under_ and \\*not\\*.';
  const r = parse(L(s));
  const f = r.lines[0].flags!;
  const at = (sub: string) => s.indexOf(sub);
  assert.ok(f[at('bold')] & F_BOLD);
  assert.ok(!(f[at('bold')] & F_ITALIC));
  assert.ok(f[at('it*')] & F_ITALIC);
  assert.ok(f[at('both')] & F_BOLD && f[at('both')] & F_ITALIC);
  assert.ok(f[at('under')] & F_UNDERLINE);
  assert.ok(f[at('\\*not')] & F_MARKER);
  assert.ok(!(f[at('not')] & F_ITALIC));
  assert.equal(cleanText(s, f), 'A bold and it and both and under and *not*.');
});

test('incomplete emphasis stays literal', () => {
  const s = 'This is **unfinished';
  const r = parse(L(s));
  assert.equal(cleanText(s, r.lines[0].flags), s);
});

test('underscore inside words is not underline', () => {
  const s = 'file_name_here';
  const r = parse(L(s));
  assert.equal(cleanText(s, r.lines[0].flags), s);
});

test('notes and boneyard, also across lines', () => {
  const r = parse(L('Action [[a note]] here.\n\n/* omitted\nstill omitted */\n\nVisible'));
  assert.equal(cleanText('Action [[a note]] here.', r.lines[0].flags), 'Action  here.');
  assert.equal(r.lines[2].type, 'boneyard');
  assert.equal(r.lines[3].type, 'boneyard');
  assert.equal(r.lines[5].type, 'action');
  const r2 = parse(L('[[multi\nline note]]'));
  assert.deepEqual(r2.lines.map((l) => l.type), ['note', 'note']);
});

test('unclosed boneyard is literal', () => {
  assert.deepEqual(types('/* not closed\n\nText'), ['action', 'blank', 'action']);
});

test('title page fields and body start', () => {
  const src = 'Title: Big Fish\nCredit: written by\nAuthor: John August\nDraft date: 1.1.2026\nContact:\n    Agency\n    Street 1\n\nINT. HOUSE - DAY';
  const r = parse(L(src));
  assert.equal(r.titleEnd, 8);
  assert.equal(r.lines[8].type, 'heading');
  const f = titleFields(L(src), r);
  assert.equal(f.find((x) => x.key === 'title')!.value, 'Big Fish');
  assert.equal(f.find((x) => x.key === 'contact')!.value, 'Agency\nStreet 1');
  assert.equal(r.scenes.length, 1);
});

test('dual dialogue pairs blocks', () => {
  const r = parse(L('\nBRICK\nScrew retirement.\n\nSTEEL ^\nScrew retirement.'));
  assert.equal(r.lines[1].dual, 'left');
  assert.equal(r.lines[2].dual, 'left');
  assert.equal(r.lines[4].dual, 'right');
  assert.equal(r.lines[4].cue, 'STEEL');
});

test('two spaces keep a dialogue block together', () => {
  assert.deepEqual(types('\nLISA\nLine one.\n  \nLine two.'), ['blank', 'character', 'dialogue', 'dialogue', 'dialogue']);
});

test('character list sorted by cue count with labels', () => {
  const r = parse(L('\nLISA\nHi.\n\nTOM\nHey.\n\nLISA\nHow are you?\n\nLISA (CONT\'D)\nOkay.'));
  const list = characterList(r);
  assert.deepEqual(list.map(characterLabel), ['LISA (3 speeches)', 'TOM (1 speech)']);
});

test('reinterpretation: heading typed into an action line becomes heading when context allows', () => {
  assert.deepEqual(types('\nINT'), ['blank', 'action']);
  assert.deepEqual(types('\nINT. '), ['blank', 'heading']);
});

test('German characters and umlauts in cues', () => {
  const r = parse(L('\nJÜRGEN\nGrüß dich.'));
  assert.equal(r.lines[1].type, 'character');
  assert.equal(r.lines[1].cue, 'JÜRGEN');
});

test('large document parses quickly', () => {
  const chunk = 'INT. ROOM - DAY\n\nSomething **happens** here and goes on for a while.\n\nLISA\n(beat)\nWords, *many* words.\n\nTOM\nReply.\n\n';
  const big = chunk.repeat(800);
  const lines = L(big);
  const t0 = performance.now();
  const r = parse(lines);
  const dt = performance.now() - t0;
  assert.equal(r.scenes.length, 800);
  assert.ok(dt < 250, `parse took ${dt}ms for ${lines.length} lines`);
});

test('prose documents: headings, paragraphs, list items and emphasis, never screenplay elements', () => {
  const lines = ['# Logline', '', 'INT. KITCHEN - NIGHT is just a sentence here.', 'LISA', '- a *point*', '## Figuren', '[[a note]]'];
  const p = parse(lines, { prose: true });
  assert.deepEqual(p.lines.map((l) => l.type), ['section', 'blank', 'action', 'action', 'listItem', 'section', 'note']);
  assert.equal(p.lines[5].level, 2);
  assert.equal(p.scenes.length, 0);
  assert.ok(p.lines[4].flags);
});
