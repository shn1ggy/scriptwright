// Scene-by-scene comparison between two versions of a screenplay.
//
// Scenes are matched independently of their position: first by scene identity (ids kept
// by the app), then by heading and content. Moves are reported separately from text
// changes, so an unchanged scene that moved never looks like new writing. Matches that
// cannot be established unambiguously are reported as such instead of being guessed.

import { parse } from './fountain';
import { fingerprint, reconcile } from './scenes';

export interface CompareScene {
  id?: string;
  heading: string;
  /** Lines from the heading to the end of the scene. */
  lines: string[];
}

export type RowKind = 'same' | 'changed' | 'moved' | 'movedChanged' | 'added' | 'removed';

export interface CompareRow {
  kind: RowKind;
  oldIndex?: number;
  newIndex?: number;
  /** The match could not be established with certainty. */
  ambiguous?: boolean;
}

export function scenesOf(text: string, ids?: Array<string | undefined>, extraPrefixes: string[] = []): CompareScene[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const p = parse(lines, { extraPrefixes });
  return p.scenes.map((sc, i) => ({ id: ids?.[i], heading: sc.heading, lines: lines.slice(sc.line, sc.end) }));
}

function body(s: CompareScene): string {
  return s.lines
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\n+$/, '');
}

/** Longest increasing subsequence (indices into `seq`). */
function lis(seq: number[]): Set<number> {
  const tails: number[] = [];
  const prev: number[] = new Array(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (seq[tails[m]] < seq[i]) lo = m + 1;
      else hi = m;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const out = new Set<number>();
  let k = tails.length ? tails[tails.length - 1] : -1;
  while (k >= 0) {
    out.add(k);
    k = prev[k];
  }
  return out;
}

export function compareScenes(oldS: CompareScene[], newS: CompareScene[]): CompareRow[] {
  const matchNew = new Array<number>(newS.length).fill(-1);
  const usedOld = new Set<number>();
  // 1. Scene identity
  const oldById = new Map<string, number>();
  oldS.forEach((s, i) => s.id && oldById.set(s.id, i));
  newS.forEach((s, j) => {
    const i = s.id ? oldById.get(s.id) : undefined;
    if (i !== undefined && !usedOld.has(i)) {
      matchNew[j] = i;
      usedOld.add(i);
    }
  });
  // 2. Heading and content for the rest
  const restOld = oldS.map((s, i) => ({ s, i })).filter(({ i }) => !usedOld.has(i));
  const restNew = newS.map((s, j) => ({ s, j })).filter(({ j }) => matchNew[j] < 0);
  const records = restOld.map(({ s, i }) => ({ id: `o${i}`, heading: s.heading, fingerprint: fingerprint(s.lines.slice(1)), order: i }));
  const res = reconcile(
    records,
    restNew.map(({ s }) => ({ heading: s.heading, fingerprint: fingerprint(s.lines.slice(1)) })),
  );
  const ambiguousOld = new Set(res.ambiguous.map((r) => Number(r.id.slice(1))));
  restNew.forEach(({ j }, n) => {
    const id = res.ids[n];
    if (id) {
      const i = Number(id.slice(1));
      matchNew[j] = i;
      usedOld.add(i);
    }
  });
  // Scenes whose heading matches an ambiguous old scene are flagged.
  const ambiguousHeadings = new Set([...ambiguousOld].map((i) => oldS[i].heading.trim().toUpperCase()));

  // Moves: matched pairs outside the longest run that keeps its order.
  const pairs = newS.map((_, j) => ({ j, i: matchNew[j] })).filter((x) => x.i >= 0);
  const keep = lis(pairs.map((x) => x.i));
  const moved = new Set<number>();
  pairs.forEach((x, k) => {
    if (!keep.has(k)) moved.add(x.j);
  });

  const rows: CompareRow[] = [];
  const emittedOld = new Set<number>();
  // Removed old scenes are listed where they used to be (before the next surviving scene).
  const removedBefore = new Map<number, number[]>(); // old index of next matched scene -> removed old indices
  const removedAtEnd: number[] = [];
  for (let i = 0; i < oldS.length; i++) {
    if (usedOld.has(i)) continue;
    let k = i + 1;
    while (k < oldS.length && !usedOld.has(k)) k++;
    if (k < oldS.length) {
      const arr = removedBefore.get(k) ?? [];
      arr.push(i);
      removedBefore.set(k, arr);
    } else removedAtEnd.push(i);
  }
  for (let j = 0; j < newS.length; j++) {
    const i = matchNew[j];
    if (i >= 0 && !moved.has(j)) {
      for (const r of removedBefore.get(i) ?? []) {
        rows.push({ kind: 'removed', oldIndex: r, ambiguous: ambiguousOld.has(r) || undefined });
        emittedOld.add(r);
      }
    }
    if (i < 0) {
      rows.push({ kind: 'added', newIndex: j, ambiguous: ambiguousHeadings.has(newS[j].heading.trim().toUpperCase()) || undefined });
      continue;
    }
    const changed = body(oldS[i]) !== body(newS[j]);
    const kind: RowKind = moved.has(j) ? (changed ? 'movedChanged' : 'moved') : changed ? 'changed' : 'same';
    rows.push({ kind, oldIndex: i, newIndex: j });
  }
  for (let i = 0; i < oldS.length; i++) {
    if (!usedOld.has(i) && !emittedOld.has(i)) rows.push({ kind: 'removed', oldIndex: i, ambiguous: ambiguousOld.has(i) || undefined });
  }
  void removedAtEnd;
  return rows;
}

export const ROW_LABELS: Record<RowKind, string> = {
  same: 'Unchanged',
  changed: 'Changed',
  moved: 'Moved',
  movedChanged: 'Moved and changed',
  added: 'Added',
  removed: 'Removed',
};
