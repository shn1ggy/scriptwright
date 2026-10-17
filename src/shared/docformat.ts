// Formatting in documents (exposé, treatment …): emphasis around words and paragraph kinds
// (heading levels, list items), written as the Markdown / Fountain markers the text keeps.

import { F_BOLD, F_ITALIC, F_MARKER, F_UNDERLINE, parse } from './fountain';

export type InlineKind = 'b' | 'i' | 'u';
export type BlockKind = 'p' | 'h1' | 'h2' | 'h3' | 'li';

const MARK: Record<InlineKind, string> = { b: '**', i: '*', u: '_' };
const FLAG: Record<InlineKind, number> = { b: F_BOLD, i: F_ITALIC, u: F_UNDERLINE };
const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}'’-]/u.test(c);

function flagsOf(text: string): Uint8Array | null {
  return parse([text], { prose: true }).lines[0].flags;
}

/** Whether every visible character in [a, b) carries the emphasis. */
export function hasInline(text: string, a: number, b: number, kind: InlineKind): boolean {
  const f = flagsOf(text);
  if (!f || a >= b) return false;
  let any = false;
  for (let k = a; k < b; k++) {
    if (f[k] & F_MARKER || text[k] === ' ') continue;
    if (!(f[k] & FLAG[kind])) return false;
    any = true;
  }
  return any;
}

/**
 * Turns emphasis on or off for [a, b) of one line. An empty range takes the word around it.
 * Returns the new text and the range of the same words in it.
 */
export function toggleInline(text: string, a: number, b: number, kind: InlineKind): { text: string; a: number; b: number } {
  if (a === b) {
    while (a > 0 && isWordChar(text[a - 1])) a--;
    while (b < text.length && isWordChar(text[b])) b++;
    if (a === b) return { text, a, b };
  }
  // Leave surrounding spaces outside the markers.
  while (a < b && text[a] === ' ') a++;
  while (b > a && text[b - 1] === ' ') b--;
  const mk = MARK[kind];
  const f = flagsOf(text);
  if (hasInline(text, a, b, kind) && f) {
    // Remove the markers that open before the range and close after it.
    let l = -1;
    for (let k = a - mk.length; k >= 0; k--) {
      if (text.startsWith(mk, k) && f[k] & F_MARKER && !(kind === 'i' && (text[k - 1] === '*' || text[k + 1] === '*') && !(text[k - 1] === '*' && text[k - 2] === '*'))) {
        l = k;
        break;
      }
    }
    let r = -1;
    for (let k = b; k <= text.length - mk.length; k++) {
      if (text.startsWith(mk, k) && f[k] & F_MARKER && !(kind === 'i' && (text[k + 1] === '*' || text[k - 1] === '*') && !(text[k + 1] === '*' && text[k + 2] === '*'))) {
        r = k;
        break;
      }
    }
    if (l >= 0 && r >= 0) {
      const out = text.slice(0, l) + text.slice(l + mk.length, r) + text.slice(r + mk.length);
      return { text: out, a: a - mk.length, b: b - mk.length };
    }
    return { text, a, b };
  }
  const out = text.slice(0, a) + mk + text.slice(a, b) + mk + text.slice(b);
  return { text: out, a: a + mk.length, b: b + mk.length };
}

const BLOCK_PREFIX = /^\s*(?:#{1,6}\s*|[-•]\s+)/;

export function blockKind(text: string): BlockKind {
  const m = /^\s*(#{1,6})/.exec(text);
  if (m) return m[1].length === 1 ? 'h1' : m[1].length === 2 ? 'h2' : 'h3';
  if (/^\s*[-•]\s/.test(text)) return 'li';
  return 'p';
}

/** Makes a line a heading, a list item or a plain paragraph. Returns the shift of its text. */
export function setBlock(text: string, kind: BlockKind): { text: string; shift: number } {
  const m = BLOCK_PREFIX.exec(text);
  const body = m ? text.slice(m[0].length) : text.replace(/^\s+/, '');
  const cut = text.length - body.length;
  const prefix = kind === 'h1' ? '# ' : kind === 'h2' ? '## ' : kind === 'h3' ? '### ' : kind === 'li' ? '- ' : '';
  return { text: prefix + body, shift: prefix.length - cut };
}
