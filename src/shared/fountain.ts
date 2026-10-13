// Fountain parser.
//
// Works line by line over the document so the editor can reinterpret text live while
// the writer types. The parser never changes text; it only classifies lines and marks
// which characters are formatting operators (hidden in clean mode) and how the
// remaining characters are styled.

export type ElementType =
  | 'title'
  | 'heading'
  | 'action'
  | 'character'
  | 'dialogue'
  | 'parenthetical'
  | 'lyric'
  | 'transition'
  | 'centered'
  | 'pageBreak'
  | 'section'
  | 'synopsis'
  | 'note'
  | 'boneyard'
  | 'blank';

// Per-character flags.
export const F_MARKER = 1; // formatting operator, hidden in clean mode
export const F_BOLD = 2;
export const F_ITALIC = 4;
export const F_UNDERLINE = 8;
export const F_NOTE = 16;
export const F_BONEYARD = 32;
export const F_ESCAPED = 64; // literal character that follows a backslash
export const F_LABEL = 128; // title page key ("Title:")

export interface ParsedLine {
  type: ElementType;
  /** Per-character flags, or null when the line is plain text without markers. */
  flags: Uint8Array | null;
  /** Dual dialogue side for character/dialogue/parenthetical lines. */
  dual?: 'left' | 'right';
  /** Production scene number written as #12A# on a heading. */
  sceneNumber?: string;
  /** Section depth (# = 1, ## = 2 …). */
  level?: number;
  /** Normalized character name on cue lines. */
  cue?: string;
  /** Title-page key on the first line of a title-page field (lowercase). */
  titleKey?: string;
  /** Dialogue block id shared by a cue and its dialogue lines. */
  block?: number;
  /** Lyric inside a dialogue block. */
  inDialogue?: boolean;
}

export interface SceneInfo {
  /** Line index of the heading. */
  line: number;
  /** Exclusive end line (next heading or end of document). */
  end: number;
  /** Clean heading text without operators or scene number. */
  heading: string;
  sceneNumber?: string;
  /** 1-based automatic order number. */
  order: number;
}

export interface DialogueBlock {
  id: number;
  cueLine: number;
  /** Exclusive end line of the block (first line after it). */
  end: number;
  cue: string;
  dual?: 'left' | 'right';
}

export interface ParseResult {
  lines: ParsedLine[];
  /** Number of lines belonging to the title page (0 if none). Includes the separating blank line. */
  titleEnd: number;
  /** Line where the screenplay body starts (after the title page). */
  bodyStart: number;
  scenes: SceneInfo[];
  blocks: DialogueBlock[];
}

export interface ParseOptions {
  /** Additional scene heading prefixes such as INNEN, AUSSEN. */
  extraPrefixes?: string[];
  /** Line index of the caret, used to tolerate incomplete writing (cue + Enter). */
  activeLine?: number;
  /** Parse a fragment that cannot contain a title page. */
  noTitle?: boolean;
}

const STANDARD_PREFIXES = ['INT./EXT', 'INT/EXT', 'INT', 'EXT', 'EST', 'I/E'];

const prefixCache = new Map<string, RegExp>();

export function headingRegex(extra: string[] = []): RegExp {
  const key = extra.join('\u0001');
  let re = prefixCache.get(key);
  if (!re) {
    const all = [...STANDARD_PREFIXES, ...extra.map((p) => p.trim()).filter(Boolean)];
    // Longest first so INT./EXT wins over INT.
    all.sort((a, b) => b.length - a.length);
    const alt = all.map((p) => escapeRegex(p.replace(/\.$/, ''))).join('|');
    re = new RegExp(`^(?:${alt})(?:\\.|\\s)`, 'iu');
    prefixCache.set(key, re);
  }
  return re;
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const TITLE_KEY_RE = /^([A-Za-z][A-Za-z0-9 _\-]*):(.*)$/;
const SCENE_NUMBER_RE = /(\s*)#([\p{L}\p{N}.\-]+)#\s*$/u;

/** Name part of a cue: removes forcing @, extensions in parentheses, dual caret. */
export function cueName(text: string): string {
  let t = text.trim();
  if (t.startsWith('@')) t = t.slice(1);
  if (t.endsWith('^')) t = t.slice(0, -1);
  t = t.replace(/\s*\(.*$/, '');
  return t.trim().toLocaleUpperCase();
}

/** Returns true if the trimmed line could be a character cue by itself (ignoring context). */
export function looksLikeCue(trimmed: string): boolean {
  if (!trimmed) return false;
  let t = trimmed;
  if (t.endsWith('^')) t = t.slice(0, -1).trimEnd();
  const name = t.replace(/\s*\(.*\)\s*$/, '').replace(/\s*\($/, '').trim();
  if (!name) return false;
  if (!/\p{L}/u.test(name)) return false;
  if (name !== name.toLocaleUpperCase()) return false;
  if (/TO:$/.test(t)) return false;
  // Lines ending with a colon are usually not names (e.g. "FADE IN:").
  if (/:$/.test(name)) return false;
  return true;
}

interface BlockRange {
  // Character offsets per line where multi-line constructs apply
  line: number;
  from: number;
  to: number;
  flag: number;
  markers: [number, number][];
}

/**
 * Finds boneyard (/* *\/) and note ([[ ]]) ranges, which may span lines.
 * Unclosed openers are treated as literal text.
 */
function findSpanningRanges(lines: string[]): BlockRange[] {
  const out: BlockRange[] = [];
  const covered: Array<Array<[number, number]>> = lines.map(() => []);

  // Boneyard: /* … */ possibly across lines. An opener without any later closer is literal.
  let lastCloseLine = -1;
  let lastCloseCh = -1;
  for (let li = lines.length - 1; li >= 0 && lastCloseLine < 0; li--) {
    const c = lines[li].lastIndexOf('*/');
    if (c >= 0) {
      lastCloseLine = li;
      lastCloseCh = c;
    }
  }
  const closeExistsAfter = (li: number, ch: number) =>
    lastCloseLine > li || (lastCloseLine === li && lastCloseCh >= ch);

  let inBone = false;
  for (let li = 0; li < lines.length; li++) {
    const text = lines[li];
    let k = 0;
    let start = 0;
    const markers: [number, number][] = [];
    const ranges: [number, number][] = [];
    while (k <= text.length) {
      if (!inBone) {
        const o = text.indexOf('/*', k);
        if (o < 0 || !closeExistsAfter(li, o + 2)) break;
        inBone = true;
        start = o;
        markers.push([o, o + 2]);
        k = o + 2;
      } else {
        const c = text.indexOf('*/', k);
        if (c < 0) break;
        markers.push([c, c + 2]);
        ranges.push([start, c + 2]);
        inBone = false;
        k = c + 2;
      }
    }
    if (inBone) ranges.push([start, text.length]);
    for (const [a, b] of ranges) {
      out.push({ line: li, from: a, to: b, flag: F_BONEYARD, markers: markers.filter(([m]) => m >= a && m < b) });
      covered[li].push([a, b]);
    }
    if (inBone) start = 0;
  }

  const insideBoneyard = (line: number, ch: number) => covered[line].some(([a, b]) => ch >= a && ch < b);

  // Notes: [[ … ]] possibly across lines, but never across an empty line.
  for (let li = 0; li < lines.length; li++) {
    const text = lines[li];
    let from = 0;
    while (true) {
      const open = text.indexOf('[[', from);
      if (open < 0) break;
      if (insideBoneyard(li, open)) {
        from = open + 2;
        continue;
      }
      const sameClose = text.indexOf(']]', open + 2);
      if (sameClose >= 0) {
        out.push({ line: li, from: open, to: sameClose + 2, flag: F_NOTE, markers: [[open, open + 2], [sameClose, sameClose + 2]] });
        from = sameClose + 2;
        continue;
      }
      let closeLine = -1;
      let closeCh = -1;
      for (let j = li + 1; j < lines.length; j++) {
        if (lines[j] === '') break;
        const c = lines[j].indexOf(']]');
        if (c >= 0) {
          closeLine = j;
          closeCh = c;
          break;
        }
      }
      if (closeLine < 0) break;
      out.push({ line: li, from: open, to: text.length, flag: F_NOTE, markers: [[open, open + 2]] });
      for (let j = li + 1; j < closeLine; j++) out.push({ line: j, from: 0, to: lines[j].length, flag: F_NOTE, markers: [] });
      out.push({ line: closeLine, from: 0, to: closeCh + 2, flag: F_NOTE, markers: [[closeCh, closeCh + 2]] });
      li = closeLine - 1;
      break;
    }
  }
  return out;
}

function ensureFlags(pl: ParsedLine, len: number): Uint8Array {
  if (!pl.flags) pl.flags = new Uint8Array(len);
  return pl.flags;
}

function markRange(flags: Uint8Array, from: number, to: number, flag: number) {
  for (let k = Math.max(0, from); k < Math.min(flags.length, to); k++) flags[k] |= flag;
}

// Emphasis results for plain lines (no other operators) are cached by text, since most
// lines are unchanged between keystrokes.
const inlineCache = new Map<string, Uint8Array | null>();
const INLINE_CACHE_MAX = 20000;

/** Applies emphasis, escapes. Skips characters flagged as notes/boneyard/markers. */
function applyInline(text: string, pl: ParsedLine, from = 0, to = text.length) {
  if (!/[*_\\]/.test(text)) return;
  const cacheable = !pl.flags && from === 0 && to === text.length;
  if (cacheable) {
    const hit = inlineCache.get(text);
    if (hit !== undefined) {
      if (hit) pl.flags = hit.slice();
      return;
    }
  }
  applyInlineRaw(text, pl, from, to);
  if (cacheable) {
    if (inlineCache.size > INLINE_CACHE_MAX) inlineCache.clear();
    inlineCache.set(text, pl.flags ? pl.flags.slice() : null);
  }
}

function applyInlineRaw(text: string, pl: ParsedLine, from: number, to: number) {
  const flags = ensureFlags(pl, text.length);
  // Masked copy: characters not available for emphasis become \u0000.
  const chars = text.split('');
  for (let k = 0; k < chars.length; k++) {
    if (k < from || k >= to || flags[k] & (F_NOTE | F_BONEYARD | F_MARKER)) chars[k] = '\u0000';
  }
  // Escapes
  for (let k = from; k < to - 1; k++) {
    if (chars[k] === '\\' && (chars[k + 1] === '*' || chars[k + 1] === '_' || chars[k + 1] === '\\')) {
      flags[k] |= F_MARKER;
      flags[k + 1] |= F_ESCAPED;
      chars[k] = '\u0000';
      chars[k + 1] = '\u0002'; // literal, never a delimiter
      k++;
    }
  }
  let masked = chars.join('');
  const rules: Array<{ re: RegExp; len: number; flag: number; word?: boolean }> = [
    { re: /\*\*\*(?=[^\s*\u0000])(.+?)(?<=[^\s\u0000])\*\*\*/gu, len: 3, flag: F_BOLD | F_ITALIC },
    { re: /\*\*(?=[^\s*\u0000])(.+?)(?<=[^\s\u0000])\*\*/gu, len: 2, flag: F_BOLD },
    { re: /\*(?=[^\s*\u0000])(.+?)(?<=[^\s\u0000*])\*/gu, len: 1, flag: F_ITALIC },
    { re: /(?<![\p{L}\p{N}])_(?=[^\s_\u0000])(.+?)(?<=[^\s\u0000])_(?![\p{L}\p{N}])/gu, len: 1, flag: F_UNDERLINE },
  ];
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    const hits: Array<[number, number]> = [];
    while ((m = rule.re.exec(masked))) {
      hits.push([m.index, m.index + m[0].length]);
    }
    if (!hits.length) continue;
    const arr = masked.split('');
    for (const [a, b] of hits) {
      for (let k = a; k < a + rule.len; k++) {
        flags[k] |= F_MARKER;
        arr[k] = '\u0001';
      }
      for (let k = b - rule.len; k < b; k++) {
        flags[k] |= F_MARKER;
        arr[k] = '\u0001';
      }
      markRange(flags, a + rule.len, b - rule.len, rule.flag);
    }
    masked = arr.join('');
  }
}

function addMarker(pl: ParsedLine, len: number, from: number, to: number) {
  if (to <= from) return;
  const flags = ensureFlags(pl, len);
  markRange(flags, from, to, F_MARKER);
}

function leadingSpaces(text: string): number {
  let k = 0;
  while (k < text.length && (text[k] === ' ' || text[k] === '\t')) k++;
  return k;
}

/** Marks an operator at the start of the (indented) line plus one directly following space. */
function markLeading(pl: ParsedLine, text: string, opLen: number, includeSpace: boolean) {
  const start = leadingSpaces(text);
  let end = start + opLen;
  if (includeSpace && text[end] === ' ') end++;
  addMarker(pl, text.length, start, end);
}

export function parse(lines: string[], opts: ParseOptions = {}): ParseResult {
  const n = lines.length;
  const result: ParsedLine[] = new Array(n);
  const headingRe = headingRegex(opts.extraPrefixes);
  const active = opts.activeLine ?? -1;

  // Title page
  let titleEnd = 0;
  if (!opts.noTitle && n > 0 && TITLE_KEY_RE.test(lines[0]) && !headingRe.test(lines[0])) {
    let i = 0;
    while (i < n && lines[i].trim() !== '') {
      const m = TITLE_KEY_RE.exec(lines[i]);
      const pl: ParsedLine = { type: 'title', flags: null };
      if (m && !/^\s/.test(lines[i])) {
        pl.titleKey = m[1].trim().toLowerCase();
        const flags = ensureFlags(pl, lines[i].length);
        markRange(flags, 0, m[1].length + 1, F_LABEL);
      }
      applyInline(lines[i], pl);
      result[i] = pl;
      i++;
    }
    titleEnd = i;
    // The blank line(s) after the title page belong to it.
    while (titleEnd < n && lines[titleEnd].trim() === '' && titleEnd === i) {
      result[titleEnd] = { type: 'blank', flags: null };
      titleEnd++;
    }
  }

  const spanning = findSpanningRanges(lines);
  const spanByLine = new Map<number, BlockRange[]>();
  for (const r of spanning) {
    if (r.line < titleEnd) continue;
    let arr = spanByLine.get(r.line);
    if (!arr) spanByLine.set(r.line, (arr = []));
    arr.push(r);
  }

  const scenes: SceneInfo[] = [];
  const blocks: DialogueBlock[] = [];
  let inDialogue = false;
  let currentBlock = null as DialogueBlock | null;
  let blockId = 0;

  const isBlankAt = (i: number) => i < 0 || i >= n || lines[i].trim() === '';
  const prevIsBlank = (i: number) => i === titleEnd || isBlankAt(i - 1);

  for (let i = titleEnd; i < n; i++) {
    const text = lines[i];
    const pl: ParsedLine = { type: 'action', flags: null };
    result[i] = pl;

    // Multi-line constructs
    const spans = spanByLine.get(i);
    let outsideText = text;
    if (spans) {
      const flags = ensureFlags(pl, text.length);
      for (const s of spans) {
        markRange(flags, s.from, s.to, s.flag);
        for (const [a, b] of s.markers) markRange(flags, a, b, F_MARKER);
      }
      const chars = text.split('');
      for (let k = 0; k < chars.length; k++) if (flags[k] & (F_NOTE | F_BONEYARD)) chars[k] = '';
      outsideText = chars.join('');
      if (outsideText.trim() === '' && text.trim() !== '') {
        const allBoneyard = spans.every((s) => s.flag === F_BONEYARD);
        pl.type = allBoneyard ? 'boneyard' : 'note';
        // Notes and boneyard inside dialogue keep the block going.
        if (inDialogue && currentBlock) pl.block = currentBlock.id;
        continue;
      }
    }

    const trimmed = text.trim();

    // Blank lines (two spaces inside dialogue keep the block together)
    if (trimmed === '') {
      if (inDialogue && text === '  ') {
        pl.type = 'dialogue';
        pl.block = currentBlock!.id;
        continue;
      }
      // A caret on an empty line right after a cue keeps dialogue writing possible.
      if (inDialogue && currentBlock && i === active && i === currentBlock.cueLine + 1) {
        pl.type = 'dialogue';
        pl.block = currentBlock.id;
        continue;
      }
      pl.type = 'blank';
      if (currentBlock) currentBlock.end = i;
      inDialogue = false;
      currentBlock = null;
      continue;
    }

    const lead = leadingSpaces(text);
    const first = text[lead];

    if (inDialogue && currentBlock) {
      if (first === '(') {
        pl.type = 'parenthetical';
      } else if (first === '~') {
        pl.type = 'lyric';
        pl.inDialogue = true;
        markLeading(pl, text, 1, true);
      } else {
        pl.type = 'dialogue';
      }
      pl.block = currentBlock.id;
      pl.dual = currentBlock.dual;
      applyInline(text, pl);
      continue;
    }

    const pb = prevIsBlank(i);

    // Page break
    if (/^\s*={3,}\s*$/.test(text)) {
      pl.type = 'pageBreak';
      addMarker(pl, text.length, 0, text.length);
      continue;
    }
    // Section
    if (first === '#') {
      let k = lead;
      while (text[k] === '#') k++;
      pl.type = 'section';
      pl.level = k - lead;
      addMarker(pl, text.length, lead, k + (text[k] === ' ' ? 1 : 0));
      continue;
    }
    // Synopsis
    if (first === '=' && text[lead + 1] !== '=') {
      pl.type = 'synopsis';
      markLeading(pl, text, 1, true);
      applyInline(text, pl);
      continue;
    }
    // Forced action
    if (first === '!' && text[lead + 1] !== '!') {
      pl.type = 'action';
      markLeading(pl, text, 1, false);
      applyInline(text, pl);
      continue;
    }
    // Centered text
    if (first === '>' && /<\s*$/.test(text) && trimmed.length >= 2) {
      pl.type = 'centered';
      const start = lead;
      let end = start + 1;
      if (text[end] === ' ') end++;
      addMarker(pl, text.length, start, end);
      const close = text.lastIndexOf('<');
      let cstart = close;
      if (text[cstart - 1] === ' ' && cstart - 1 >= end) cstart--;
      addMarker(pl, text.length, cstart, text.length);
      applyInline(text, pl, end, cstart);
      continue;
    }
    // Forced transition
    if (first === '>') {
      pl.type = 'transition';
      markLeading(pl, text, 1, true);
      applyInline(text, pl);
      continue;
    }
    // Lyrics
    if (first === '~') {
      pl.type = 'lyric';
      markLeading(pl, text, 1, true);
      applyInline(text, pl);
      continue;
    }
    // Forced scene heading
    if (first === '.' && pb && /^\.[^.\s]/u.test(text.slice(lead))) {
      pl.type = 'heading';
      markLeading(pl, text, 1, false);
      finishHeading(text, pl);
      scenes.push(makeScene(i, text, pl));
      continue;
    }
    // Scene heading
    if (pb && headingRe.test(text.slice(lead))) {
      pl.type = 'heading';
      finishHeading(text, pl);
      scenes.push(makeScene(i, text, pl));
      continue;
    }
    // Forced character
    if (first === '@') {
      const nextOk = canStartDialogue(i);
      if (nextOk) {
        pl.type = 'character';
        markLeading(pl, text, 1, false);
        startBlock(i, text, pl);
        continue;
      }
      // An @ cue without dialogue yet still shows as a cue while being written.
      pl.type = 'character';
      markLeading(pl, text, 1, false);
      pl.cue = cueName(text);
      markDual(text, pl);
      continue;
    }
    // Transition
    if (pb && trimmed === trimmed.toLocaleUpperCase() && /TO:$/.test(trimmed) && (isBlankAt(i + 1) || i + 1 === active)) {
      pl.type = 'transition';
      applyInline(text, pl);
      continue;
    }
    // Character cue
    if (pb && looksLikeCue(trimmed) && canStartDialogue(i)) {
      pl.type = 'character';
      startBlock(i, text, pl);
      continue;
    }
    pl.type = 'action';
    applyInline(text, pl);
  }
  if (currentBlock) currentBlock.end = n;

  // Close blocks that were not ended by a blank line
  for (const b of blocks) if (b.end <= b.cueLine) b.end = n;

  // Scene ends and order numbers
  for (let k = 0; k < scenes.length; k++) {
    let end = k + 1 < scenes.length ? scenes[k + 1].line : n;
    // An act or sequence (a section) after the last line of a scene opens what follows: it
    // and its synopsis are not part of the scene, so moving the scene leaves them in place.
    let j = end;
    let hasSection = false;
    while (j - 1 > scenes[k].line) {
      const t = result[j - 1].type;
      if (t === 'section') hasSection = true;
      else if (!(t === 'blank' || t === 'synopsis')) break;
      j--;
    }
    if (hasSection) end = j;
    scenes[k].end = end;
    scenes[k].order = k + 1;
  }

  // Dual dialogue: a right-hand block pairs with the immediately preceding block.
  for (let k = 0; k < blocks.length; k++) {
    const b = blocks[k];
    if (b.dual !== 'right') continue;
    const prev = blocks[k - 1];
    if (!prev) {
      b.dual = undefined;
      continue;
    }
    // Only blank lines between the two blocks.
    let onlyBlank = true;
    for (let j = prev.end; j < b.cueLine; j++) if (lines[j].trim() !== '') onlyBlank = false;
    if (!onlyBlank) {
      b.dual = undefined;
      for (let j = b.cueLine; j < b.end; j++) if (result[j]) result[j].dual = undefined;
      continue;
    }
    prev.dual = 'left';
    for (let j = prev.cueLine; j < prev.end; j++) if (result[j] && result[j].block === prev.id) result[j].dual = 'left';
  }

  return { lines: result, titleEnd, bodyStart: titleEnd, scenes, blocks };

  function canStartDialogue(i: number): boolean {
    if (i + 1 >= n) return false;
    const next = lines[i + 1];
    if (next.trim() !== '') return true;
    if (next === '  ') return true;
    return i + 1 === active && next === '';
  }

  function startBlock(i: number, text: string, pl: ParsedLine) {
    pl.cue = cueName(text);
    markDual(text, pl);
    const b: DialogueBlock = { id: ++blockId, cueLine: i, end: i + 1, cue: pl.cue, dual: pl.dual };
    pl.block = b.id;
    blocks.push(b);
    currentBlock = b;
    inDialogue = true;
    applyInline(text, pl);
  }

  function markDual(text: string, pl: ParsedLine) {
    const t = text.trimEnd();
    if (t.endsWith('^')) {
      pl.dual = 'right';
      let start = t.length - 1;
      while (start > 0 && text[start - 1] === ' ') start--;
      addMarker(pl, text.length, start, t.length);
    }
  }

  function finishHeading(text: string, pl: ParsedLine) {
    const m = SCENE_NUMBER_RE.exec(text);
    if (m) {
      pl.sceneNumber = m[2];
      addMarker(pl, text.length, m.index, text.length);
    }
    applyInline(text, pl);
  }

  function makeScene(i: number, text: string, pl: ParsedLine): SceneInfo {
    return { line: i, end: n, heading: cleanText(text, pl.flags), sceneNumber: pl.sceneNumber, order: 0 };
  }
}

/** Text with all operator characters (and notes/boneyard) removed. */
export function cleanText(text: string, flags: Uint8Array | null, keepNotes = false): string {
  if (!flags) return text.trim();
  let out = '';
  for (let k = 0; k < text.length; k++) {
    const f = flags[k];
    if (f & F_MARKER) continue;
    if (!keepNotes && f & (F_NOTE | F_BONEYARD)) continue;
    out += text[k];
  }
  return out.trim();
}

/** Returns the index of the scene containing a line, or -1 if before the first scene. */
export function sceneIndexAt(scenes: SceneInfo[], line: number): number {
  let lo = 0;
  let hi = scenes.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (scenes[mid].line <= line) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export interface CharacterCount {
  name: string;
  cues: number;
}

/** Characters sorted by cue count (descending), then name. */
export function characterList(parse: ParseResult, fromLine = 0, toLine = Infinity): CharacterCount[] {
  const counts = new Map<string, number>();
  for (const b of parse.blocks) {
    if (b.cueLine < fromLine || b.cueLine >= toLine) continue;
    if (!b.cue) continue;
    counts.set(b.cue, (counts.get(b.cue) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, cues]) => ({ name, cues }))
    .sort((a, b) => b.cues - a.cues || a.name.localeCompare(b.name));
}

export function characterLabel(c: CharacterCount): string {
  return `${c.name} (${c.cues} ${c.cues === 1 ? 'speech' : 'speeches'})`;
}

/** Title page fields as key → value (multi-line values joined with \n). */
export function titleFields(lines: string[], parse: ParseResult): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (let i = 0; i < parse.titleEnd; i++) {
    const pl = parse.lines[i];
    if (pl.type !== 'title') continue;
    if (pl.titleKey) {
      const m = TITLE_KEY_RE.exec(lines[i])!;
      out.push({ key: pl.titleKey, value: m[2].trim() });
    } else if (out.length) {
      const last = out[out.length - 1];
      last.value = last.value ? last.value + '\n' + lines[i].trim() : lines[i].trim();
    }
  }
  return out;
}

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu;

export function countWords(text: string): number {
  const m = text.match(WORD_RE);
  return m ? m.length : 0;
}

const SPANNING = /\/\*|\*\/|\[\[|\]\]/;

/**
 * Re-parses after a change confined to the text of one line, reusing the previous result
 * for everything else. Returns null when a full parse is needed (the change could affect
 * other lines), so callers fall back to `parse`.
 */
export function reparseLine(lines: string[], prev: ParseResult, line: number, oldText: string, opts: ParseOptions = {}): ParseResult | null {
  const n = lines.length;
  if (prev.lines.length !== n || line < prev.titleEnd || line <= 0) return null;
  const text = lines[line];
  if (text.trim() === '' || oldText.trim() === '') return null;
  if (SPANNING.test(text) || SPANNING.test(oldText) || text.includes('^') || oldText.includes('^')) return null;
  // Paragraph window bounded by blank lines (state resets at blank lines).
  let a = line;
  while (a > prev.titleEnd && lines[a - 1].trim() !== '') a--;
  if (a === prev.titleEnd && a > 0 && lines[a - 1].trim() !== '') return null;
  let b = line + 1;
  while (b < n && lines[b].trim() !== '') b++;
  if ((a > 0 && lines[a - 1] === '  ') || (b < n && lines[b] === '  ')) return null;
  for (let k = a; k < b; k++) {
    const t = prev.lines[k].type;
    if (t === 'note' || t === 'boneyard' || prev.lines[k].dual) return null;
    if (prev.lines[k].flags && k !== line && prev.lines[k].flags!.some((f) => f & (F_NOTE | F_BONEYARD))) return null;
  }
  const win = parse(lines.slice(a, b), { ...opts, noTitle: true, activeLine: opts.activeLine !== undefined ? opts.activeLine - a : undefined });
  for (let k = a; k < b; k++) {
    const o = prev.lines[k];
    const w = win.lines[k - a];
    if (o.type !== w.type || o.cue !== w.cue || !!o.dual !== !!w.dual || o.inDialogue !== w.inDialogue || o.level !== w.level || (o.block === undefined) !== (w.block === undefined)) return null;
    if (k !== line && o.sceneNumber !== w.sceneNumber) return null;
  }
  const nl = win.lines[line - a];
  const old = prev.lines[line];
  const merged: ParsedLine = { ...nl, block: old.block, dual: old.dual };
  const linesOut = prev.lines.slice();
  linesOut[line] = merged;
  let scenes = prev.scenes;
  if (merged.type === 'heading') {
    scenes = prev.scenes.map((sc) => (sc.line === line ? { ...sc, heading: cleanText(text, merged.flags), sceneNumber: merged.sceneNumber } : sc));
  }
  return { ...prev, lines: linesOut, scenes };
}

/**
 * A title page with every common Fountain key, so the writer only fills in values.
 * Empty fields are not printed.
 */
export function titlePageTemplate(title: string, date: string): string {
  return [`Title: ${title}`, 'Credit: Written by', 'Author: ', 'Source: ', `Draft date: ${date}`, 'Contact: ', 'Copyright: ', 'Notes: ', 'Revision: '].join('\n') + '\n';
}
