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

export type PossessiveStyle = 'de' | 'en';

/** Guesses whether the screenplay is written in German or English. */
export function guessLanguage(lines: string[]): PossessiveStyle {
  let de = 0;
  let en = 0;
  const DE = /\b(und|der|die|das|nicht|ist|ich|du|sie|ein|eine|mit|auf|zu|sich|auch|aber|INNEN|AUSSEN|TAG|NACHT)\b/g;
  const EN = /\b(the|and|is|not|you|it|of|to|with|on|but|this|that|INT|EXT|DAY|NIGHT)\b/g;
  for (const l of lines) {
    de += (l.match(DE) ?? []).length;
    en += (l.match(EN) ?? []).length;
  }
  return de > en ? 'de' : 'en';
}

const SIBILANT = /(s|ß|x|z|ce)$/i;

/**
 * Builds the possessive/genitive form of `name` from the suffix found after the old name.
 * German: Lisas, Andreas'   English: Lisa's, James'
 */
export function possessive(name: string, suffix: string, style: PossessiveStyle, upper: boolean): string {
  const apo = /’/.test(suffix) ? '’' : "'";
  const s = upper ? 'S' : 's';
  const sib = SIBILANT.test(name);
  const lower = suffix.toLowerCase();
  if (lower === apo + 's' || lower === "'s" || lower === '’s') {
    // Apostrophe-s: keep it (English, or German writers who use it), except German after a sibilant.
    return style === 'de' && sib ? name + apo : name + apo + s;
  }
  if (lower === 's') return style === 'de' && sib ? name + apo : name + s;
  // A bare apostrophe after an old name ending in s.
  if (sib) return name + apo;
  return style === 'de' ? name + s : name + apo + s;
}

export function planRename(
  lines: string[],
  parse: ParseResult,
  oldName: string,
  newName: string,
  extraPrefixes: string[] = [],
  style: PossessiveStyle = guessLanguage(lines),
): RenamePlan {
  const oldUpper = oldName.trim().toLocaleUpperCase();
  const newTrim = newName.trim();
  const newUpper = newTrim.toLocaleUpperCase();
  const characters = characterList(parse).map((c) => c.name);
  const merge = characters.includes(newUpper) && newUpper !== oldUpper;
  const summary: RenameSummary = { cues: 0, action: 0, dialogue: 0, other: 0, total: 0, merge, newCue: newUpper };
  const changes: RenameChange[] = [];
  if (!oldUpper || !newTrim || (newUpper === oldUpper && newTrim === oldName)) return { changes, summary };

  const oldPat = escapeRegex(oldUpper).replace(/ +/g, '\\s+');
  // Other characters whose names contain the old name (LISA MARIE) or are its plain
  // genitive form (ANDREA → ANDREAS) are never touched.
  const longer = characters.filter((c) => c !== oldUpper && (new RegExp(B + oldPat + A, 'iu').test(c) || new RegExp('^' + oldPat + "s$", 'iu').test(c)));
  const protectRe = longer.length
    ? new RegExp(B + '(?:' + longer.sort((a, b) => b.length - a.length).map(escapeRegex).join('|') + ')' + A, 'giu')
    : null;
  // Name, optionally followed by a possessive/genitive ending: 's ’s s '
  const nameRe = new RegExp(B + '(' + oldPat + ")((?:['’]s|s|['’])?)" + A, 'giu');
  const oldSib = SIBILANT.test(oldUpper);
  const headingRe = headingRegex(extraPrefixes);

  for (let i = parse.titleEnd; i < lines.length; i++) {
    const pl = parse.lines[i];
    const text = lines[i];
    if (pl.type === 'character' && pl.cue === oldUpper) {
      changes.push({ line: i, text: renameCue(text, newUpper, headingRe) });
      summary.cues++;
      continue;
    }
    const protectedRanges: Array<[number, number]> = [];
    if (protectRe) {
      protectRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = protectRe.exec(text))) protectedRanges.push([m.index, m.index + m[0].length]);
    }
    let count = 0;
    nameRe.lastIndex = 0;
    const out = text.replace(nameRe, (match: string, base: string, suffix: string, offset: number) => {
      if (protectedRanges.some(([a, b]) => offset >= a && offset < b)) return match;
      const renamed = matchCase(base, newTrim);
      if (!suffix) {
        count++;
        return renamed;
      }
      const letters = base.replace(/[^\p{L}]/gu, '');
      const isLower = letters === letters.toLocaleLowerCase();
      // Endings only count for capitalized names ("marks" is a verb, not Mark's).
      // A bare apostrophe only follows names ending in s.
      if (isLower || (suffix.length === 1 && suffix !== 's' && !oldSib)) {
        if (isLower && suffix) return match;
        count++;
        return renamed + suffix;
      }
      const upper = letters === letters.toLocaleUpperCase() && suffix.toUpperCase() === suffix && /S/.test(suffix);
      count++;
      return possessive(renamed, suffix, style, upper || (letters.length > 1 && letters === letters.toLocaleUpperCase()));
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
