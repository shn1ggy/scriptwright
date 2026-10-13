// Document model: an array of lines with stable keys.
//
// Keys let scenes, scroll context and (later) annotations follow text through edits and
// reordering. Lines are immutable values: an edit replaces a line with a new object that
// keeps the key, so undo can restore the exact previous objects.

export interface Line {
  readonly key: number;
  readonly text: string;
}

export interface Pos {
  line: number;
  ch: number;
}

export interface Selection {
  anchor: Pos;
  head: Pos;
}

let nextKey = 1;
export function newKey(): number {
  return nextKey++;
}
export function ensureKeyAbove(k: number) {
  if (nextKey <= k) nextKey = k + 1;
}

export function makeLines(text: string): Line[] {
  return splitLines(text).map((t) => ({ key: newKey(), text: t }));
}

export function splitLines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

export function joinLines(lines: readonly Line[]): string {
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    if (i) out += '\n';
    out += lines[i].text;
  }
  return out;
}

export function cmpPos(a: Pos, b: Pos): number {
  return a.line - b.line || a.ch - b.ch;
}
export function minPos(a: Pos, b: Pos): Pos {
  return cmpPos(a, b) <= 0 ? a : b;
}
export function maxPos(a: Pos, b: Pos): Pos {
  return cmpPos(a, b) >= 0 ? a : b;
}
export function eqPos(a: Pos, b: Pos): boolean {
  return a.line === b.line && a.ch === b.ch;
}
export function selFrom(s: Selection): Pos {
  return minPos(s.anchor, s.head);
}
export function selTo(s: Selection): Pos {
  return maxPos(s.anchor, s.head);
}
export function selEmpty(s: Selection): boolean {
  return eqPos(s.anchor, s.head);
}
export function cursor(p: Pos): Selection {
  return { anchor: { ...p }, head: { ...p } };
}

/** One structural step: replace `deleteCount` lines starting at `at` with `insert`. */
export interface Step {
  at: number;
  removed: Line[];
  inserted: Line[];
}

export function applyStep(lines: Line[], step: Step) {
  lines.splice(step.at, step.removed.length, ...step.inserted);
}

export function invertStep(step: Step): Step {
  return { at: step.at, removed: step.inserted, inserted: step.removed };
}

/**
 * Builds a step that replaces the text between `from` and `to` with `text`.
 * Key assignment keeps identity with the part of the original line that survives:
 * inserting a newline at the start of a heading keeps the heading's key on the heading.
 */
export function replaceStep(lines: readonly Line[], from: Pos, to: Pos, text: string): Step {
  const a = lines[from.line];
  const b = lines[to.line];
  const prefix = a.text.slice(0, from.ch);
  const suffix = b.text.slice(to.ch);
  const parts = splitLines(text);
  const texts = parts.slice();
  texts[0] = prefix + texts[0];
  texts[texts.length - 1] = texts[texts.length - 1] + suffix;
  const removed = lines.slice(from.line, to.line + 1);
  const keys: number[] = new Array(texts.length).fill(0);
  const last = texts.length - 1;
  if (from.line === to.line) {
    if (last === 0) keys[0] = a.key;
    else if (prefix.length > 0 || suffix.length === 0) {
      keys[0] = a.key;
    } else {
      keys[last] = a.key;
    }
  } else {
    if (last === 0) {
      keys[0] = prefix.length > 0 || suffix.length === 0 ? a.key : b.key;
    } else {
      keys[0] = a.key;
      if (suffix.length > 0 || to.ch === 0) keys[last] = b.key;
    }
  }
  const inserted: Line[] = texts.map((t, i) => {
    const key = keys[i] || newKey();
    const orig = removed.find((l) => l.key === key);
    if (orig && orig.text === t) return orig;
    return { key, text: t };
  });
  return { at: from.line, removed, inserted };
}

/** Position after inserting `text` at `from` (used to place the caret). */
export function posAfterInsert(from: Pos, text: string): Pos {
  const parts = splitLines(text);
  if (parts.length === 1) return { line: from.line, ch: from.ch + parts[0].length };
  return { line: from.line + parts.length - 1, ch: parts[parts.length - 1].length };
}

/** Maps a position through a step (assoc: -1 sticks before inserted content, 1 after). */
export function mapPos(p: Pos, step: Step, assoc = 1): Pos {
  const end = step.at + step.removed.length;
  const delta = step.inserted.length - step.removed.length;
  if (p.line < step.at) return p;
  if (p.line >= end) return { line: p.line + delta, ch: p.ch };
  // Inside the replaced range: follow the key if the line survived.
  const key = step.removed[p.line - step.at]?.key;
  const idx = step.inserted.findIndex((l) => l.key === key);
  if (idx >= 0) {
    const l = step.inserted[idx];
    return { line: step.at + idx, ch: Math.min(p.ch, l.text.length) };
  }
  if (assoc < 0 || step.inserted.length === 0) {
    const line = Math.max(0, Math.min(step.at, step.at + step.inserted.length - 1));
    return { line, ch: 0 };
  }
  const lastIdx = step.at + step.inserted.length - 1;
  return { line: lastIdx, ch: step.inserted[step.inserted.length - 1].text.length };
}

export function textBetween(lines: readonly Line[], from: Pos, to: Pos): string {
  if (from.line === to.line) return lines[from.line].text.slice(from.ch, to.ch);
  let out = lines[from.line].text.slice(from.ch);
  for (let i = from.line + 1; i < to.line; i++) out += '\n' + lines[i].text;
  out += '\n' + lines[to.line].text.slice(0, to.ch);
  return out;
}

export function clampPos(lines: readonly Line[], p: Pos): Pos {
  const line = Math.max(0, Math.min(lines.length - 1, p.line));
  const ch = Math.max(0, Math.min(lines[line].text.length, p.ch));
  return { line, ch };
}

// Word boundaries --------------------------------------------------------------------

const WORD_CH = /[\p{L}\p{N}_'’]/u;
export function isWordChar(c: string | undefined): boolean {
  return !!c && WORD_CH.test(c);
}

export function wordAt(text: string, ch: number): [number, number] {
  let a = ch;
  let b = ch;
  if (!isWordChar(text[ch]) && isWordChar(text[ch - 1])) {
    a = ch - 1;
    b = ch - 1;
  }
  if (!isWordChar(text[a])) {
    // Select a run of whitespace or a single punctuation character.
    if (/\s/.test(text[a] ?? '')) {
      while (a > 0 && /\s/.test(text[a - 1])) a--;
      while (b < text.length && /\s/.test(text[b])) b++;
      return [a, b];
    }
    return [a, Math.min(text.length, a + 1)];
  }
  while (a > 0 && isWordChar(text[a - 1])) a--;
  while (b < text.length && isWordChar(text[b])) b++;
  return [a, b];
}

export function wordLeft(text: string, ch: number): number {
  let k = ch;
  while (k > 0 && !isWordChar(text[k - 1])) k--;
  while (k > 0 && isWordChar(text[k - 1])) k--;
  return k;
}
export function wordRight(text: string, ch: number): number {
  let k = ch;
  while (k < text.length && !isWordChar(text[k])) k++;
  while (k < text.length && isWordChar(text[k])) k++;
  return k;
}

/** Grapheme-safe previous/next caret position within a line. */
const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new (Intl as any).Segmenter(undefined, { granularity: 'grapheme' }) : null;
export function prevCh(text: string, ch: number): number {
  if (ch <= 0) return 0;
  if (segmenter) {
    let last = 0;
    for (const s of segmenter.segment(text.slice(0, ch))) last = s.index;
    return last;
  }
  const c = text.charCodeAt(ch - 1);
  return c >= 0xdc00 && c < 0xe000 && ch >= 2 ? ch - 2 : ch - 1;
}
export function nextCh(text: string, ch: number): number {
  if (ch >= text.length) return text.length;
  if (segmenter) {
    const it = segmenter.segment(text.slice(ch))[Symbol.iterator]();
    const first = it.next();
    if (!first.done) return ch + first.value.segment.length;
  }
  const c = text.charCodeAt(ch);
  return c >= 0xd800 && c < 0xdc00 ? ch + 2 : ch + 1;
}

/** Simple, fast 32-bit FNV-1a hash as hex (used for fingerprints and conflict checks). */
export function hash32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
