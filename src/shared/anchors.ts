// Anchors for annotations (highlights, comments, alternative passages).
//
// While the app runs an anchor is a pair of positions {line key, character}. Keys survive
// edits and moves; characters are mapped through every edit. On disk an anchor is stored
// as the quoted text with a little context around it, so it can be found again after the
// file was edited elsewhere. An anchor that cannot be found unambiguously is "detached":
// it is kept for review and never attached to other text.

import { Line, Step } from './doc';

export interface KeyPos {
  key: number;
  ch: number;
}

export interface LiveAnchor {
  a: KeyPos;
  b: KeyPos;
}

export interface StoredAnchor {
  quote: string;
  prefix: string;
  suffix: string;
  /** Line index when saved (tie-breaker only). */
  line: number;
}

const CONTEXT = 40;

/** Maps anchors through one step. Pure removals keep their keys (the lines may be moved). */
export function mapAnchorsThroughStep(step: Step, anchors: Iterable<LiveAnchor>) {
  if (!step.removed.length || !step.inserted.length) return;
  const removedIndex = new Map<number, number>();
  step.removed.forEach((l, i) => removedIndex.set(l.key, i));
  // Lines that came back unchanged (same key, same text) need no mapping: this keeps anchors
  // exact through large replacements such as reloading or restoring a version.
  const unchanged = new Set<number>();
  const insertedText = new Map<number, string>();
  for (const l of step.inserted) insertedText.set(l.key, l.text);
  for (const l of step.removed) if (insertedText.get(l.key) === l.text) unchanged.add(l.key);
  const touched: Array<{ anchor: LiveAnchor; end: 'a' | 'b' }> = [];
  for (const an of anchors) {
    if (removedIndex.has(an.a.key) && !unchanged.has(an.a.key)) touched.push({ anchor: an, end: 'a' });
    if (removedIndex.has(an.b.key) && !unchanged.has(an.b.key)) touched.push({ anchor: an, end: 'b' });
  }
  if (!touched.length) return;
  const rem = step.removed.map((l) => l.text).join('\n');
  const ins = step.inserted.map((l) => l.text).join('\n');
  let p = 0;
  const max = Math.min(rem.length, ins.length);
  while (p < max && rem.charCodeAt(p) === ins.charCodeAt(p)) p++;
  let sfx = 0;
  while (sfx < rem.length - p && sfx < ins.length - p && rem.charCodeAt(rem.length - 1 - sfx) === ins.charCodeAt(ins.length - 1 - sfx)) sfx++;
  const delta = ins.length - rem.length;
  const remStarts: number[] = [];
  let acc = 0;
  for (const l of step.removed) {
    remStarts.push(acc);
    acc += l.text.length + 1;
  }
  const insStarts: number[] = [];
  acc = 0;
  for (const l of step.inserted) {
    insStarts.push(acc);
    acc += l.text.length + 1;
  }
  const toPos = (off: number): KeyPos => {
    let i = insStarts.length - 1;
    while (i > 0 && insStarts[i] > off) i--;
    return { key: step.inserted[i].key, ch: Math.max(0, Math.min(step.inserted[i].text.length, off - insStarts[i])) };
  };
  for (const t of touched) {
    const pos = t.anchor[t.end];
    const idx = removedIndex.get(pos.key)!;
    const off = remStarts[idx] + Math.min(pos.ch, step.removed[idx].text.length);
    let next: number;
    // In a bulk replacement a position inside changed text cannot be placed reliably.
    const inside = off >= p && off < rem.length - sfx && !(t.end === 'b' && off === p);
    if (inside && step.removed.length > 20) {
      t.anchor[t.end] = { key: -1, ch: 0 };
      continue;
    }
    if (t.end === 'a') {
      if (off < p) next = off;
      else if (off >= rem.length - sfx) next = off + delta;
      else next = p; // inside replaced text: the anchor starts where the new text starts
    } else {
      if (off <= p) next = off;
      else if (off >= rem.length - sfx) next = off + delta;
      else next = ins.length - sfx; // inside replaced text: ends where the new text ends
    }
    t.anchor[t.end] = toPos(next);
  }
}

/** Index of each line key. */
export function keyIndex(lines: readonly Line[]): Map<number, number> {
  const m = new Map<number, number>();
  lines.forEach((l, i) => m.set(l.key, i));
  return m;
}

/** Why an anchor is no longer valid, or null when it is fine. */
export function anchorProblem(an: LiveAnchor, idx: Map<number, number>): string | null {
  const a = idx.get(an.a.key);
  const b = idx.get(an.b.key);
  if (a === undefined || b === undefined) return 'The text was deleted.';
  if (a > b || (a === b && an.a.ch >= an.b.ch)) return 'The text was deleted.';
  return null;
}

export function anchorText(an: LiveAnchor, lines: readonly Line[], idx: Map<number, number>): string {
  const a = idx.get(an.a.key);
  const b = idx.get(an.b.key);
  if (a === undefined || b === undefined) return '';
  if (a === b) return lines[a].text.slice(an.a.ch, an.b.ch);
  let out = lines[a].text.slice(an.a.ch);
  for (let i = a + 1; i < b; i++) out += '\n' + lines[i].text;
  return out + '\n' + lines[b].text.slice(0, an.b.ch);
}

function absOffsets(lines: readonly Line[]): number[] {
  const out: number[] = [];
  let acc = 0;
  for (const l of lines) {
    out.push(acc);
    acc += l.text.length + 1;
  }
  return out;
}

export function toStored(an: LiveAnchor, lines: readonly Line[], idx: Map<number, number>, full?: { text: string; starts: number[] }): StoredAnchor | null {
  const a = idx.get(an.a.key);
  const b = idx.get(an.b.key);
  if (a === undefined || b === undefined) return null;
  const f = full ?? { text: lines.map((l) => l.text).join('\n'), starts: absOffsets(lines) };
  const s = f.starts[a] + an.a.ch;
  const e = f.starts[b] + an.b.ch;
  return { quote: f.text.slice(s, e), prefix: f.text.slice(Math.max(0, s - CONTEXT), s), suffix: f.text.slice(e, e + CONTEXT), line: a };
}

export function fullText(lines: readonly Line[]) {
  return { text: lines.map((l) => l.text).join('\n'), starts: absOffsets(lines) };
}

function commonSuffix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}
function commonPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

export type ResolveResult = { ok: true; anchor: LiveAnchor } | { ok: false; reason: string };

/** Finds a stored anchor in the text. Never guesses between equally good matches. */
export function resolveStored(st: StoredAnchor, lines: readonly Line[], full = fullText(lines)): ResolveResult {
  if (!st || !st.quote) return { ok: false, reason: 'The anchored text is empty.' };
  const text = full.text;
  const hits: number[] = [];
  let from = 0;
  while (hits.length < 2000) {
    const i = text.indexOf(st.quote, from);
    if (i < 0) break;
    hits.push(i);
    from = i + 1;
  }
  if (!hits.length) return { ok: false, reason: 'The anchored text was changed or deleted.' };
  const lineOf = (off: number) => {
    let lo = 0;
    let hi = full.starts.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (full.starts[m] <= off) lo = m;
      else hi = m - 1;
    }
    return lo;
  };
  const scored = hits.map((off) => {
    const ctx = commonSuffix(text.slice(Math.max(0, off - CONTEXT), off), st.prefix) + commonPrefix(text.slice(off + st.quote.length, off + st.quote.length + CONTEXT), st.suffix);
    return { off, ctx, line: lineOf(off) };
  });
  scored.sort((x, y) => y.ctx - x.ctx);
  let best = scored[0];
  if (scored.length > 1 && scored[1].ctx === best.ctx) {
    // Equally good: the saved line decides only if exactly one candidate sits on it.
    const onLine = scored.filter((s) => s.ctx === best.ctx && s.line === st.line);
    if (onLine.length !== 1) return { ok: false, reason: 'The text appears in more than one place.' };
    best = onLine[0];
  }
  // Weak context and several candidates: refuse rather than guess.
  if (scored.length > 1 && best.ctx < Math.min(8, st.prefix.length + st.suffix.length)) return { ok: false, reason: 'The text appears in more than one place.' };
  const end = best.off + st.quote.length;
  const la = lineOf(best.off);
  const lb = lineOf(end);
  return { ok: true, anchor: { a: { key: lines[la].key, ch: best.off - full.starts[la] }, b: { key: lines[lb].key, ch: end - full.starts[lb] } } };
}

export function cloneAnchor(an: LiveAnchor): LiveAnchor {
  return { a: { ...an.a }, b: { ...an.b } };
}

/** True when two anchors overlap (share at least one character). */
export function overlaps(x: LiveAnchor, y: LiveAnchor, idx: Map<number, number>): boolean {
  const pos = (p: KeyPos) => [idx.get(p.key) ?? -1, p.ch] as const;
  const lt = (p: readonly [number, number], q: readonly [number, number]) => p[0] < q[0] || (p[0] === q[0] && p[1] < q[1]);
  return lt(pos(x.a), pos(y.b)) && lt(pos(y.a), pos(x.b));
}
