// Production: locked pages and coloured revisions.
//
// When a script goes into production its pages are locked: the page numbers the crew has
// printed never change again. New material that no longer fits on its page continues on
// A pages (12A, 12B …); a page whose content was removed completely is joined to the page
// before it ("12-13"). Each round of changes after the lock gets the next colour in the
// usual order (blue, pink, yellow …); changed lines carry an asterisk and each revised page
// names its colour and date in the header.
//
// The lock is a copy of the screenplay plus the line on which each page began. To find those
// pages in today's text, the copy is compared line by line with the current screenplay and
// every page start is followed to where that line (or what replaced it) is now.

import { diffSeq } from './revisions';

export interface RevisionColor {
  /** English key, also the label (translated in the interface). */
  name: string;
  /** Paper colour, for tinted pages on screen. */
  tint: string;
}

/** The usual order of revision colours (WGA). White is the locked script itself. */
export const REVISION_COLORS: RevisionColor[] = [
  { name: 'White', tint: '#FFFFFF' },
  { name: 'Blue', tint: '#D7E6FB' },
  { name: 'Pink', tint: '#FBDCE7' },
  { name: 'Yellow', tint: '#FBF3BE' },
  { name: 'Green', tint: '#DCF2D9' },
  { name: 'Goldenrod', tint: '#F4DE9A' },
  { name: 'Buff', tint: '#F1E5C8' },
  { name: 'Salmon', tint: '#FBD2C2' },
  { name: 'Cherry', tint: '#F6B9C4' },
];

/**
 * The colour of a revision round. Level 0 is the locked white script, 1 is blue … After
 * cherry the order starts again as "Double White", "Double Blue" … then "Triple …".
 */
export function revisionColor(level: number): { name: string; tint: string; prefix: '' | 'Double' | 'Triple' } {
  const n = REVISION_COLORS.length;
  const cycle = Math.floor(Math.max(0, level) / n);
  const c = REVISION_COLORS[Math.max(0, level) % n];
  return { name: c.name, tint: c.tint, prefix: cycle === 0 ? '' : cycle === 1 ? 'Double' : 'Triple' };
}

/** A page start of the locked script, in the current text. */
export interface LockStart {
  /** Line of the current text where this page begins. */
  line: number;
  /** Locked page number. */
  page: number;
}

export interface PageLock {
  starts: LockStart[];
}

/**
 * For every line of `oldLines`, the line of `newLines` now at its place: the same line if it
 * is still there, otherwise the next line that took its position.
 */
export function followLines(oldLines: string[], newLines: string[]): Int32Array {
  const norm = (s: string) => s.replace(/\s+$/, '');
  const ops = diffSeq(oldLines.map(norm), newLines.map(norm));
  const map = new Int32Array(oldLines.length).fill(-1);
  let j = 0;
  for (const op of ops) {
    if (op.kind === 'same') {
      map[op.a!] = op.b!;
      j = op.b! + 1;
    } else if (op.kind === 'add') {
      j = Math.max(j, op.b!);
    } else {
      // Removed or rewritten: whatever now stands at this point (an inserted replacement
      // comes later in the ops; fixed up below).
      map[op.a!] = -2 - j;
    }
  }
  // A removed line points at the first line after it that exists in the new text:
  // either an added replacement at that position or the next unchanged line.
  for (let i = 0; i < map.length; i++) {
    if (map[i] <= -2) map[i] = Math.min(newLines.length, -2 - map[i]);
  }
  return map;
}

/**
 * Where the locked pages begin in the current text. `starts[k]` is the line (of the locked
 * copy) on which page k + 1 began. Pages whose content is gone map to the same line as the
 * next page; the paginator joins them ("12-13").
 */
export function lockStarts(lockedLines: string[], starts: number[], curLines: string[], firstBodyLine = 0): LockStart[] {
  const map = followLines(lockedLines, curLines);
  const out: LockStart[] = [];
  let last = -1;
  starts.forEach((l, k) => {
    let line = k === 0 ? firstBodyLine : l >= 0 && l < map.length ? map[l] : curLines.length;
    // Page starts stay in order even if scenes were moved around.
    if (line < last) line = last;
    last = line;
    out.push({ line, page: k + 1 });
  });
  return out;
}

/** Letters for pages after a locked page: A … Z, AA … */
export function pageLetters(n: number): string {
  let s = '';
  let k = n;
  while (k > 0) {
    const r = (k - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    k = Math.floor((k - 1) / 26);
  }
  return s;
}

/**
 * The first line of every body page of a pagination, as stored when pages are locked: the
 * first line that starts on the page (a line split across a break counts for the new page).
 */
export function pageStartLines(pages: Array<{ title?: unknown; lines: Array<{ sourceLine: number; kind: string; row: number }> }>): number[] {
  const body = pages.filter((p) => !p.title);
  const out: number[] = [];
  let lastSrc = -1;
  for (const pg of body) {
    const rows = pg.lines.filter((l) => l.kind !== 'more').slice().sort((a, b) => a.row - b.row);
    // A (CONT'D) cue repeats a line from the page before; the page begins with the first
    // line at or after the last line of the previous page.
    const first = rows.find((l) => l.sourceLine >= lastSrc);
    out.push(first ? first.sourceLine : lastSrc + 1);
    lastSrc = rows.reduce((m, l) => Math.max(m, l.sourceLine), lastSrc);
  }
  return out;
}
