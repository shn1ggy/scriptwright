// Pattern building and replacement logic for Find & Replace. Matches never span lines.

import { escapeRegex } from './fountain';

export interface FindOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  /** When matching ignores case: adapt the replacement to the case of each match (ANDREA → MARIA, Andrea → Maria). */
  preserveCase: boolean;
}

export interface FindMatch {
  line: number;
  from: number;
  to: number;
}

const WORD = '[\\p{L}\\p{N}_]';

/** Builds a global regular expression, or returns an error message for an invalid pattern. */
export function buildPattern(query: string, o: Pick<FindOptions, 'caseSensitive' | 'wholeWord' | 'regex'>): RegExp | string {
  if (!query) return 'Empty search';
  let src = o.regex ? query : escapeRegex(query);
  if (o.wholeWord) src = `(?<!${WORD})(?:${src})(?!${WORD})`;
  try {
    return new RegExp(src, `gu${o.caseSensitive ? '' : 'i'}`);
  } catch (err: any) {
    // Plain-text queries are escaped, so only user-written patterns can fail.
    return 'Invalid pattern';
  }
}

/** Finds all non-empty matches, line by line. `include` limits the search to some lines. */
export function findMatches(lines: ReadonlyArray<{ text: string }>, re: RegExp, include?: (line: number) => boolean, limit = Infinity): FindMatch[] {
  const out: FindMatch[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (include && !include(i)) continue;
    const text = lines[i].text;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (!m[0].length) {
        re.lastIndex = m.index + 1;
        continue;
      }
      out.push({ line: i, from: m.index, to: m.index + m[0].length });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** Applies the case shape of `source` to `repl`. */
export function matchCase(source: string, repl: string): string {
  const letters = source.replace(/[^\p{L}]/gu, '');
  if (!letters || !repl) return repl;
  const upper = letters.toUpperCase();
  const lower = letters.toLowerCase();
  if (upper === lower) return repl;
  if (letters.length > 1 && letters === upper) return repl.toUpperCase();
  if (letters === lower) return repl.toLowerCase();
  const first = letters[0];
  const rest = letters.slice(1);
  if (first === first.toUpperCase() && rest === rest.toLowerCase()) {
    const i = repl.search(/\p{L}/u);
    if (i < 0) return repl;
    return repl.slice(0, i) + repl[i].toUpperCase() + repl.slice(i + 1);
  }
  return repl;
}

/**
 * The text that replaces one match. With regular expressions, `$1`, `$&` etc. refer to the
 * match's groups. `lineText` is the full line containing the match.
 */
export function replacementFor(lineText: string, m: FindMatch, re: RegExp, repl: string, o: FindOptions): string {
  const found = lineText.slice(m.from, m.to);
  let out = repl;
  if (o.regex) {
    // A sticky expression replaces exactly the match at `from`, with lookarounds seeing the whole line.
    const sticky = new RegExp(re.source, re.flags.replace('g', '').replace('y', '') + 'y');
    sticky.lastIndex = m.from;
    const probe = sticky.exec(lineText);
    if (probe && probe[0].length === found.length) {
      sticky.lastIndex = m.from;
      const whole = lineText.replace(sticky, repl);
      out = whole.slice(m.from, whole.length - (lineText.length - m.to));
    }
  }
  if (o.preserveCase && !o.caseSensitive) out = matchCase(found, out);
  return out;
}
