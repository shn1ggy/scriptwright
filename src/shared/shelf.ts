// Finding the place a shelf item came from, by the text that surrounded it.

import { ShelfOrigin } from './types';

const CONTEXT = 60;

/** Records the surroundings of [from, to) in `text` (offsets). For a cut, call with the text before cutting. */
export function makeOrigin(text: string, from: number, to: number): ShelfOrigin {
  return { before: text.slice(Math.max(0, from - CONTEXT), from), after: text.slice(to, to + CONTEXT), offset: from };
}

function allIndexes(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
}

function nearest(list: number[], target: number): number {
  return list.reduce((best, x) => (Math.abs(x - target) < Math.abs(best - target) ? x : best), list[0]);
}

export interface OriginMatch {
  from: number;
  to: number;
  /** 'exact': before and after both still match; 'partial': only one side does. */
  quality: 'exact' | 'partial';
}

/**
 * Locates the origin in the current text. `inner` is the text expected between the
 * surroundings: '' for cut material (it is gone) or the item's text for copied material.
 */
export function locateOrigin(text: string, o: ShelfOrigin, inner: string): OriginMatch | null {
  const { before, after } = o;
  if (!before && !after) return text === inner || !text ? { from: 0, to: inner && text ? inner.length : 0, quality: 'exact' } : null;
  const whole = before + inner + after;
  const hits = allIndexes(text, whole);
  if (hits.length) {
    const at = nearest(hits, o.offset - before.length) + before.length;
    return { from: at, to: at + inner.length, quality: 'exact' };
  }
  // Start/end of the screenplay: one side of the context is legitimately empty.
  if (!before && text.startsWith(inner + after)) return { from: 0, to: inner.length, quality: 'exact' };
  if (!after && text.endsWith(before + inner)) return { from: text.length - inner.length, to: text.length, quality: 'exact' };
  // One side changed: use the other only if it is unambiguous and reasonably long.
  const minSide = 12;
  if (before.length >= minSide) {
    const b = allIndexes(text, before + inner);
    if (b.length === 1) return { from: b[0] + before.length, to: b[0] + before.length + inner.length, quality: 'partial' };
  }
  if (after.length >= minSide) {
    const a = allIndexes(text, inner + after);
    if (a.length === 1) return { from: a[0], to: a[0] + inner.length, quality: 'partial' };
  }
  return null;
}
