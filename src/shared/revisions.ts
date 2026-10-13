// Revision marks: which characters and lines of the current screenplay changed compared
// with an earlier version (an export copy or a named draft).
//
// With "ignore scene order", scenes are matched by identity and content regardless of
// position, so moving a scene (or deleting one, which renumbers the rest) marks nothing that
// did not actually change. Within matched scenes, lines are compared and changed lines are
// compared word by word, so only the changed words are marked.

import { ParseResult, parse } from './fountain';
import { compareScenes, CompareScene } from './scenecompare';

export interface RevisionOptions {
  ignoreOrder: boolean;
  ignoreSceneNumbers: boolean;
  markDeletions: boolean;
  markMoved: boolean;
}

export interface ChangeMap {
  /** Changed characters per line (1 = changed), by line index of the current text. */
  chars: Map<number, Uint8Array>;
  /** Lines that get a margin mark (changed, or where text was removed). */
  marked: Set<number>;
  stats: { changedLines: number; addedScenes: number; removedScenes: number; movedScenes: number; deletions: number };
}

const NUM_RE = /\s*#[\p{L}\p{N}.\-]+#\s*$/u;

type Op = { kind: 'same' | 'add' | 'del'; a?: number; b?: number };

/** Sequence diff (common prefix/suffix + LCS; falls back to replace-all for huge inputs). */
export function diffSeq<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean = (x, y) => x === y): Op[] {
  let s = 0;
  while (s < a.length && s < b.length && eq(a[s], b[s])) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && eq(a[ea - 1], b[eb - 1])) {
    ea--;
    eb--;
  }
  const ops: Op[] = [];
  for (let i = 0; i < s; i++) ops.push({ kind: 'same', a: i, b: i });
  const n = ea - s;
  const m = eb - s;
  if (n * m > 6_000_000) {
    for (let i = s; i < ea; i++) ops.push({ kind: 'del', a: i });
    for (let j = s; j < eb; j++) ops.push({ kind: 'add', b: j });
  } else if (n || m) {
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = eq(a[s + i], b[s + j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (eq(a[s + i], b[s + j])) {
        ops.push({ kind: 'same', a: s + i, b: s + j });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ kind: 'del', a: s + i++ });
      else ops.push({ kind: 'add', b: s + j++ });
    }
    while (i < n) ops.push({ kind: 'del', a: s + i++ });
    while (j < m) ops.push({ kind: 'add', b: s + j++ });
  }
  for (let k = 0; k < a.length - ea; k++) ops.push({ kind: 'same', a: ea + k, b: eb + k });
  return ops;
}

interface Segment {
  /** Line index of the first line in the full text. */
  start: number;
  lines: string[];
  isHeading: boolean[];
}

function segmentsOf(lines: string[], p: ParseResult) {
  const body = p.bodyStart;
  const firstScene = p.scenes[0]?.line ?? lines.length;
  const heading = new Set(p.scenes.map((s) => s.line));
  const seg = (a: number, b: number): Segment => ({ start: a, lines: lines.slice(a, b), isHeading: lines.slice(a, b).map((_, k) => heading.has(a + k)) });
  return {
    opening: seg(body, firstScene),
    scenes: p.scenes.map((s) => seg(s.line, s.end)),
    body: seg(body, lines.length),
  };
}

export function computeChanges(
  curLines: string[],
  curParse: ParseResult,
  curIds: Array<string | undefined>,
  baseText: string,
  baseIds: Array<string | undefined> | undefined,
  opts: RevisionOptions,
  extraPrefixes: string[] = [],
): ChangeMap {
  const baseLines = baseText.replace(/\r\n?/g, '\n').split('\n');
  const baseParse = parse(baseLines, { extraPrefixes });
  const out: ChangeMap = { chars: new Map(), marked: new Set(), stats: { changedLines: 0, addedScenes: 0, removedScenes: 0, movedScenes: 0, deletions: 0 } };
  const cur = segmentsOf(curLines, curParse);
  const base = segmentsOf(baseLines, baseParse);

  const norm = (seg: Segment, k: number) => {
    let t = seg.lines[k].replace(/\s+$/, '');
    if (opts.ignoreSceneNumbers && seg.isHeading[k]) t = t.replace(NUM_RE, '');
    return t;
  };

  const markAll = (line: number, text: string) => {
    if (!text.trim()) return;
    const m = new Uint8Array(text.length);
    for (let k = 0; k < text.length; k++) if (!/\s/.test(text[k])) m[k] = 1;
    out.chars.set(line, m);
    out.marked.add(line);
  };
  const markDeletionAt = (line: number) => {
    if (!opts.markDeletions || line < 0 || line >= curLines.length) return;
    // Removed text is marked on the next line with content.
    let l = line;
    while (l < curLines.length - 1 && !curLines[l].trim()) l++;
    out.marked.add(l);
    out.stats.deletions++;
  };

  const diffSegments = (o: Segment, n: Segment) => {
    const a = o.lines.map((_, k) => norm(o, k));
    const b = n.lines.map((_, k) => norm(n, k));
    const ops = diffSeq(a, b);
    let k = 0;
    while (k < ops.length) {
      if (ops[k].kind === 'same') {
        k++;
        continue;
      }
      const dels: number[] = [];
      const adds: number[] = [];
      while (k < ops.length && ops[k].kind !== 'same') {
        if (ops[k].kind === 'del') dels.push(ops[k].a!);
        else adds.push(ops[k].b!);
        k++;
      }
      const realDels = dels.filter((i) => a[i].trim());
      const realAdds = adds.filter((j) => b[j].trim());
      // Pair changed lines and compare them word by word.
      const pairs = Math.min(realDels.length, realAdds.length);
      for (let q = 0; q < pairs; q++) markWords(a[realDels[q]], n.lines[realAdds[q]], n.start + realAdds[q]);
      for (let q = pairs; q < realAdds.length; q++) markAll(n.start + realAdds[q], n.lines[realAdds[q]]);
      if (realDels.length > pairs) {
        const next = k < ops.length ? ops[k].b! : n.lines.length;
        markDeletionAt(realAdds.length ? n.start + realAdds[realAdds.length - 1] : n.start + Math.min(next, n.lines.length - 1));
      }
    }
  };

  const markWords = (oldText: string, newText: string, line: number) => {
    const ta = oldText.match(/\s+|[^\s]+/g) ?? [];
    const tb = newText.match(/\s+|[^\s]+/g) ?? [];
    const ops = diffSeq(ta, tb);
    const m = new Uint8Array(newText.length);
    const starts: number[] = [];
    let acc = 0;
    for (const t of tb) {
      starts.push(acc);
      acc += t.length;
    }
    let any = false;
    let removedOnly = false;
    for (const op of ops) {
      if (op.kind === 'add' && /\S/.test(tb[op.b!])) {
        for (let c = 0; c < tb[op.b!].length; c++) m[starts[op.b!] + c] = 1;
        any = true;
      } else if (op.kind === 'del' && /\S/.test(ta[op.a!])) removedOnly = true;
    }
    if (any) out.chars.set(line, m);
    if (any || (removedOnly && opts.markDeletions)) out.marked.add(line);
  };

  if (!opts.ignoreOrder) {
    diffSegments(base.body, cur.body);
  } else {
    diffSegments(base.opening, cur.opening);
    const toCompare = (segs: Segment[], ids: Array<string | undefined> | undefined, p: ParseResult): CompareScene[] =>
      segs.map((s, i) => ({ id: ids?.[i], heading: p.scenes[i].heading, lines: s.lines.map((_, k) => norm(s, k)) }));
    const rows = compareScenes(toCompare(base.scenes, baseIds, baseParse), toCompare(cur.scenes, curIds, curParse));
    const matchedOldToNew = new Map<number, number>();
    for (const r of rows) if (r.oldIndex !== undefined && r.newIndex !== undefined) matchedOldToNew.set(r.oldIndex, r.newIndex);
    for (const r of rows) {
      if (r.kind === 'added') {
        out.stats.addedScenes++;
        const s = cur.scenes[r.newIndex!];
        s.lines.forEach((t, k) => markAll(s.start + k, t));
      } else if (r.kind === 'removed') {
        out.stats.removedScenes++;
        // Mark where the scene used to be: after the nearest earlier scene that still exists.
        let prev = r.oldIndex! - 1;
        while (prev >= 0 && !matchedOldToNew.has(prev)) prev--;
        if (prev >= 0) {
          const ns = cur.scenes[matchedOldToNew.get(prev)!];
          markDeletionAt(Math.min(curLines.length - 1, ns.start + ns.lines.length));
        } else markDeletionAt(cur.scenes[0]?.start ?? cur.opening.start);
      } else if (r.oldIndex !== undefined && r.newIndex !== undefined) {
        if (r.kind === 'moved' || r.kind === 'movedChanged') {
          out.stats.movedScenes++;
          if (opts.markMoved) out.marked.add(cur.scenes[r.newIndex].start);
        }
        if (r.kind !== 'same' && r.kind !== 'moved') diffSegments(base.scenes[r.oldIndex], cur.scenes[r.newIndex]);
      }
    }
  }
  out.stats.changedLines = out.marked.size;
  return out;
}
