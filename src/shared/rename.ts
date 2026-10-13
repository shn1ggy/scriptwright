import { ParseResult, characterList, escapeRegex, headingRegex, looksLikeCue } from './fountain';

export interface RenameChange {
  line: number;
  text: string;
}

export interface RenameSummary {
  cues: number;
  action: number;
  dialogue: number;
  other: number;
  total: number;
  /** True when the new name already belongs to another character (a merge). */
  merge: boolean;
  newCue: string;
}

export interface RenamePlan {
  changes: RenameChange[];
  summary: RenameSummary;
}

/** Applies the casing of `sample` to `name`. */
export function matchCase(sample: string, name: string): string {
  const letters = sample.replace(/[^\p{L}]/gu, '');
  if (!letters) return name;
  if (letters === letters.toLocaleUpperCase() && letters !== letters.toLocaleLowerCase()) return name.toLocaleUpperCase();
  if (letters === letters.toLocaleLowerCase()) return name.toLocaleLowerCase();
  const first = letters[0];
  const rest = letters.slice(1);
  if (first === first.toLocaleUpperCase() && rest === rest.toLocaleLowerCase()) {
    // Title case: keep a deliberately mixed spelling (McKenzie), otherwise capitalize words.
    const nl = name.replace(/[^\p{L}]/gu, '');
    const typedMixed = nl !== nl.toLocaleUpperCase() && nl !== nl.toLocaleLowerCase();
    if (typedMixed) return name;
    return name.toLocaleLowerCase().replace(/(^|[\s\-'’.])(\p{L})/gu, (_m, sep, c) => sep + c.toLocaleUpperCase());
  }
  return name;
}

const B = '(?<![\\p{L}\\p{N}_])';
const A = '(?![\\p{L}\\p{N}_])';

export function planRename(
  lines: string[],
  parse: ParseResult,
  oldName: string,
  newName: string,
  extraPrefixes: string[] = [],
): RenamePlan {
  const oldUpper = oldName.trim().toLocaleUpperCase();
  const newTrim = newName.trim();
  const newUpper = newTrim.toLocaleUpperCase();
  const characters = characterList(parse).map((c) => c.name);
  const merge = characters.includes(newUpper) && newUpper !== oldUpper;
  const summary: RenameSummary = { cues: 0, action: 0, dialogue: 0, other: 0, total: 0, merge, newCue: newUpper };
  const changes: RenameChange[] = [];
  if (!oldUpper || !newTrim || newUpper === oldUpper && newTrim === oldName) return { changes, summary };

  // Longer names that contain the old name must not be touched (ANN inside ANNA is handled
  // by word boundaries; LISA inside LISA MARIE needs explicit protection).
  const longer = characters.filter((c) => c !== oldUpper && new RegExp(B + escapeRegex(oldUpper) + A, 'iu').test(c));
  const protectRe = longer.length
    ? new RegExp(B + '(?:' + longer.sort((a, b) => b.length - a.length).map(escapeRegex).join('|') + ')' + A, 'giu')
    : null;
  const nameRe = new RegExp(B + escapeRegex(oldUpper).replace(/ +/g, '\\s+') + A, 'giu');
  const headingRe = headingRegex(extraPrefixes);

  for (let i = parse.titleEnd; i < lines.length; i++) {
    const pl = parse.lines[i];
    const text = lines[i];
    if (pl.type === 'character' && pl.cue === oldUpper) {
      changes.push({ line: i, text: renameCue(text, newUpper, headingRe) });
      summary.cues++;
      continue;
    }
    // Mentions anywhere else.
    const protectedRanges: Array<[number, number]> = [];
    if (protectRe) {
      protectRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = protectRe.exec(text))) protectedRanges.push([m.index, m.index + m[0].length]);
    }
    let count = 0;
    nameRe.lastIndex = 0;
    const out = text.replace(nameRe, (match: string, offset: number) => {
      if (protectedRanges.some(([a, b]) => offset >= a && offset < b)) return match;
      count++;
      return matchCase(match, newTrim);
    });
    if (count) {
      changes.push({ line: i, text: out });
      if (pl.type === 'action') summary.action += count;
      else if (pl.type === 'dialogue' || pl.type === 'parenthetical' || (pl.type === 'lyric' && pl.inDialogue)) summary.dialogue += count;
      else summary.other += count;
    }
  }
  summary.total = summary.cues + summary.action + summary.dialogue + summary.other;
  return { changes, summary };
}

function renameCue(text: string, newUpper: string, headingRe: RegExp): string {
  const lead = /^\s*/.exec(text)![0];
  let body = text.slice(lead.length);
  const forced = body.startsWith('@');
  if (forced) body = body.slice(1);
  // Split name from extension / dual marker.
  const m = /^(.*?)(\s*(?:\(.*)?\s*\^?\s*)$/.exec(body)!;
  const rest = m[2];
  const candidate = newUpper + rest;
  const needsForce = !looksLikeCue(candidate.trim()) || headingRe.test(candidate.trim());
  return lead + (needsForce ? '@' : '') + candidate;
}
