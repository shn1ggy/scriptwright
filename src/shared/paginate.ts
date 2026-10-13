// Screenplay pagination. Produces positioned lines per page from parsed Fountain.
// The same result drives the PDF writer, so the preview is the real output.

import {
  F_BOLD,
  F_BONEYARD,
  F_ITALIC,
  F_MARKER,
  F_NOTE,
  F_UNDERLINE,
  ParseResult,
  cleanText,
  titleFields,
} from './fountain';
import { sceneNumberList } from './scenenumbers';
import { ExportScope, ExportSettings, paperDims } from './types';

export const S_BOLD = 1;
export const S_ITALIC = 2;
export const S_UNDERLINE = 4;
/** Changed since the compared version (revision marks). */
export const S_CHANGED = 8;

export interface Run {
  text: string;
  style: number;
}

export type LineKind =
  | 'heading'
  | 'action'
  | 'character'
  | 'dialogue'
  | 'parenthetical'
  | 'transition'
  | 'centered'
  | 'lyric'
  | 'more'
  | 'section'
  | 'synopsis'
  | 'note';

export interface PageLine {
  /** Line slot on the page (0 = first content line). */
  row: number;
  /** Horizontal start in character cells from the left margin. */
  col: number;
  runs: Run[];
  kind: LineKind;
  sceneNumber?: string;
  sourceLine: number;
  /** Revision mark in the margin. */
  mark?: boolean;
}

export interface TitleItem {
  text: string;
  /** y in points from the top of the page. */
  y: number;
  align: 'center' | 'left' | 'right';
  title?: boolean;
}

export interface Page {
  /** Printed page number (1-based within the full script). */
  number: number;
  lines: PageLine[];
  title?: TitleItem[];
  /** Index of scenes (heading lines) that start on this page. */
  sceneLines: number[];
  /** Contains revision marks. */
  changed?: boolean;
}

export interface Capacity {
  linesPerPage: number;
  actionChars: number;
  dialogueChars: number;
  parentheticalChars: number;
  characterCol: number;
  dialogueCol: number;
  parentheticalCol: number;
  /** Points per character and per line. */
  charWidth: number;
  lineHeight: number;
  /** Left edge of the action column, top of the first line's letters, bottom of the text area (points). */
  left: number;
  top: number;
  textBottom: number;
  pageWidth: number;
  pageHeight: number;
  totalLines: number;
  totalChars: number;
  /** Points between the bottom of the text area and the paper edge. */
  bottomMarginPt: number;
  rightMarginChars: number;
}

export interface PaginationResult {
  pages: Page[];
  capacity: Capacity;
  warnings: string[];
  /** Pages of the script body (excluding the title page). */
  bodyPageCount: number;
}

interface OutLine {
  col: number;
  runs: Run[];
  kind: LineKind;
  /** A page break is acceptable after this line. */
  breakAfter: boolean;
  sceneNumber?: string;
  sourceLine: number;
  /** Second column for dual dialogue rows. */
  dual?: OutLine;
}

interface Raw {
  text: string;
  styles: number[];
  source: number;
}

/** A paragraph of one element type; hard lines in `raw`, soft-wrapped at layout time. */
interface Para {
  kind: LineKind;
  raw: Raw[];
  width: number;
  col: number;
  extra: number;
  align: 'left' | 'right' | 'center';
  alignWidth: number;
  /** May be split inside (at sentence ends, or anywhere when forced). */
  splittable: boolean;
  sceneNumber?: string;
}

interface Unit {
  kind: 'heading' | 'dialogue' | 'action' | 'other' | 'pageBreak' | 'dual';
  paras: Para[];
  /** Pre-built lines (dual dialogue only). */
  fixed?: OutLine[];
  spaceBefore: number;
  /** Lines of the following unit that must stay with this one. */
  keepNext: number;
  splittable: boolean;
  sceneLine: number;
  sourceLine: number;
  newPage?: boolean;
  dualParts?: [Para[], Para[]];
}

function flagsToStyle(f: number): number {
  return (f & F_BOLD ? S_BOLD : 0) | (f & F_ITALIC ? S_ITALIC : 0) | (f & F_UNDERLINE ? S_UNDERLINE : 0);
}

/** Visible characters and their styles for export (operators, notes and boneyard removed). */
export function styledText(text: string, flags: Uint8Array | null, keepNotes = false, changed?: Uint8Array): { text: string; styles: number[] } {
  let out = '';
  const styles: number[] = [];
  for (let k = 0; k < text.length; k++) {
    const f = flags ? flags[k] : 0;
    if (f & F_MARKER) continue;
    if (f & F_BONEYARD) continue;
    if (f & F_NOTE && !keepNotes) continue;
    out += text[k];
    styles.push(flagsToStyle(f) | (changed && changed[k] ? S_CHANGED : 0));
  }
  return { text: out, styles };
}

/** Spaces between two changed words count as changed, so marks run on without gaps. */
function bridgeChangedSpaces(runs: Run[]): Run[] {
  if (runs.length < 3) return runs;
  return runs.map((r, i) =>
    i > 0 && i < runs.length - 1 && !(r.style & S_CHANGED) && /^\s+$/.test(r.text) && runs[i - 1].style & S_CHANGED && runs[i + 1].style & S_CHANGED ? { ...r, style: r.style | S_CHANGED } : r,
  );
}

function toRuns(text: string, styles: number[], from: number, to: number, extra = 0): Run[] {
  const runs: Run[] = [];
  let cur: Run | null = null;
  for (let k = from; k < to; k++) {
    const st = (styles[k] ?? 0) | extra;
    if (!cur || cur.style !== st) {
      cur = { text: '', style: st };
      runs.push(cur);
    }
    cur.text += text[k];
  }
  return runs;
}

/** Word wrap returning [start, end) ranges. Long words are hard-split. */
export function wrap(text: string, width: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (width < 1) width = 1;
  if (text.length === 0) return [[0, 0]];
  let start = 0;
  while (start < text.length) {
    if (text.length - start <= width) {
      out.push([start, text.length]);
      break;
    }
    let end = start + width;
    // find last space within [start, end]
    let brk = -1;
    for (let k = end; k > start; k--) {
      if (text[k] === ' ') {
        brk = k;
        break;
      }
    }
    if (brk <= start) {
      out.push([start, end]);
      start = end;
    } else {
      let e = brk;
      while (e > start && text[e - 1] === ' ') e--;
      out.push([start, e]);
      start = brk;
    }
    while (start < text.length && text[start] === ' ') start++;
  }
  return out;
}

function layoutPara(p: Para): OutLine[] {
  const out: OutLine[] = [];
  for (let r = 0; r < p.raw.length; r++) {
    const { text, styles, source } = p.raw[r];
    const ranges = wrap(text, p.width);
    for (let i = 0; i < ranges.length; i++) {
      const [a, b] = ranges[i];
      const seg = text.slice(a, b);
      let c = p.col;
      if (p.align === 'right') c = p.col + Math.max(0, p.alignWidth - seg.length);
      else if (p.align === 'center') c = p.col + Math.max(0, (p.alignWidth - seg.length) / 2); // centred on the page
      out.push({ col: c, runs: toRuns(text, styles, a, b, p.extra), kind: p.kind, breakAfter: false, sourceLine: source });
    }
  }
  if (p.sceneNumber && out[0]) out[0].sceneNumber = p.sceneNumber;
  return out;
}

function layoutParas(paras: Para[]): OutLine[] {
  const out: OutLine[] = [];
  for (const p of paras) out.push(...layoutPara(p));
  return out;
}

function countLines(paras: Para[]): number {
  let n = 0;
  for (const p of paras) for (const r of p.raw) n += wrap(r.text, p.width).length;
  return n;
}

function para(kind: LineKind, raw: Raw[], width: number, col: number, opts: Partial<Para> = {}): Para {
  return { kind, raw, width, col, extra: 0, align: 'left', alignWidth: 0, splittable: false, ...opts };
}

const SENTENCE_END_AT = /[.!?…]["'”’)\]]*(?=\s|$)/g;

/** Offsets inside a hard line where a sentence ends (after punctuation). */
function sentenceEnds(text: string): number[] {
  const out: number[] = [];
  SENTENCE_END_AT.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SENTENCE_END_AT.exec(text))) out.push(m.index + m[0].length);
  return out;
}

/**
 * Page geometry in points from the settings (which are in lines and characters).
 * `advanceEm` is the script font's character width (0.6 for Courier).
 */
export function capacity(s: ExportSettings, advanceEm = 0.6): { cap: Capacity; warnings: string[] } {
  const dims = paperDims(s.paper);
  const charW = s.fontSize * advanceEm;
  const lineH = Math.max(4, s.lineHeight);
  const warnings: string[] = [];
  const top = Math.max(0, s.topMarginPt);
  const totalLines = Math.floor(dims.height / lineH + 1e-6);
  const totalChars = Math.floor(dims.width / charW + 1e-6);
  let lpp = Math.max(1, Math.round(s.linesPerPage));
  // Space below the last line (its letters reach about one line below its top).
  const below = (n: number) => dims.height - top - n * lineH;
  if (below(lpp) < lineH) {
    lpp = Math.max(1, Math.floor((dims.height - top - lineH) / lineH));
    warnings.push(`${s.linesPerPage} lines do not fit below a ${fmt(top)} pt top margin; ${lpp} lines are used.`);
  } else if (below(lpp) < 2.5 * lineH) warnings.push(`Only ${fmt(below(lpp))} pt remain below the text for page numbers and footers.`);
  const check = (name: string, indent: number, width: number) => {
    const right = totalChars - s.leftMargin - indent - width;
    if (right < 0) warnings.push(`${name} extends ${fmt(-right)} character${right === -1 ? '' : 's'} past the edge of the page.`);
    else if (right < 4) warnings.push(`${name} leaves only ${fmt(right)} character${right === 1 ? '' : 's'} of right margin.`);
  };
  check('Action', 0, s.actionWidth);
  check('Dialogue', s.dialogueIndent, s.dialogueWidth);
  check('Parenthetical', s.parentheticalIndent, s.parentheticalWidth);
  if (s.characterIndent >= s.actionWidth) warnings.push('Character indent is wider than the action width.');
  // Indents may use half characters (as on many printed screenplays).
  const half = (v: number) => Math.max(0, Math.round(v * 2) / 2);
  const cap: Capacity = {
    linesPerPage: lpp,
    actionChars: Math.max(10, Math.round(s.actionWidth)),
    dialogueChars: Math.max(8, Math.round(s.dialogueWidth)),
    parentheticalChars: Math.max(6, Math.round(s.parentheticalWidth)),
    characterCol: half(s.characterIndent),
    dialogueCol: half(s.dialogueIndent),
    parentheticalCol: half(s.parentheticalIndent),
    charWidth: charW,
    lineHeight: lineH,
    left: half(s.leftMargin) * charW,
    top,
    textBottom: top + lpp * lineH,
    pageWidth: dims.width,
    pageHeight: dims.height,
    totalLines,
    totalChars,
    bottomMarginPt: below(lpp),
    rightMarginChars: totalChars - s.leftMargin - s.actionWidth,
  };
  return { cap, warnings };
}

function fmt(n: number): string {
  return String(Math.round(n * 10) / 10);
}

export interface RevisionMarks {
  chars: Map<number, Uint8Array>;
  marked: Set<number>;
  /** Keep only pages that contain a change. */
  changedPagesOnly?: boolean;
}

export function paginate(
  lines: string[],
  parse: ParseResult,
  s: ExportSettings,
  scope: ExportScope = { kind: 'all' },
  advanceEm = 0.6,
  revisions?: RevisionMarks,
): PaginationResult {
  const { cap, warnings } = capacity(s, advanceEm);
  const sty = (i: number, keepNotes = false) => styledText(lines[i], parse.lines[i].flags, keepNotes, revisions?.chars.get(i));
  const dialCol = cap.dialogueCol;
  const parCol = cap.parentheticalCol;
  const units: Unit[] = [];

  // Which scenes are included
  let includeLine: (line: number) => boolean = () => true;
  const sceneOfLine = new Int32Array(lines.length).fill(-1);
  for (const sc of parse.scenes) for (let i = sc.line; i < sc.end; i++) sceneOfLine[i] = sc.line;
  if (scope.kind === 'scenes') {
    const set = new Set(scope.sceneLines);
    includeLine = (l) => set.has(sceneOfLine[l]);
  } else if (scope.kind === 'character') {
    const set = new Set<number>();
    const name = scope.name.toUpperCase();
    for (const b of parse.blocks) if (b.cue === name && sceneOfLine[b.cueLine] >= 0) set.add(sceneOfLine[b.cueLine]);
    includeLine = (l) => set.has(sceneOfLine[l]);
  } else if (scope.kind === 'dialogue') {
    // Dialogue only: the blocks (of one character or all), optionally with scene headings
    // and the action paragraph right before each block.
    const keep = new Uint8Array(lines.length);
    const name = scope.name.toUpperCase();
    for (const b of parse.blocks) {
      if (name && b.cue !== name) continue;
      for (let k = b.cueLine; k < b.end; k++) keep[k] = 1;
      if (scope.headings && sceneOfLine[b.cueLine] >= 0) keep[sceneOfLine[b.cueLine]] = 1;
      if (scope.action) {
        let j = b.cueLine - 1;
        while (j >= 0 && parse.lines[j].type === 'blank') j--;
        const end = j;
        while (j >= 0 && parse.lines[j].type === 'action') j--;
        for (let k = j + 1; k <= end; k++) keep[k] = 1;
      }
    }
    includeLine = (l) => keep[l] === 1;
  }
  const newPageScenes = s.sceneStartsNewPage || scope.kind === 'scenesNewPage';

  // Scene numbers
  // Locked numbers (written on the headings) always print; new scenes get letters (12A).
  const sceneNum = new Map<number, string>();
  const locked = !!s.numbersLocked;
  const nums = sceneNumberList(parse, locked);
  parse.scenes.forEach((sc, i) => {
    if (locked || s.autoSceneNumbers || sc.sceneNumber) sceneNum.set(sc.line, (s.sceneNumberFormat || '{n}').replace('{n}', nums[i]));
  });

  const trimRaw = (st: { text: string; styles: number[] }, source: number): Raw => {
    const start = st.text.length - st.text.trimStart().length;
    const text = st.text.trim();
    return { text, styles: st.styles.slice(start, start + text.length), source };
  };

  let i = parse.bodyStart;
  let blankRun = 0;
  let lastCue = null as { cue: string; scene: number; sawAction: boolean } | null;
  const pushUnit = (u: Unit) => {
    if (s.preserveBlankLines && blankRun > 1 && units.length) u.spaceBefore += blankRun - 1;
    units.push(u);
    blankRun = 0;
  };
  const unit = (kind: Unit['kind'], paras: Para[], scene: number, source: number, over: Partial<Unit> = {}): Unit => ({
    kind,
    paras,
    spaceBefore: s.elementSpacing,
    keepNext: 0,
    splittable: false,
    sceneLine: scene,
    sourceLine: source,
    ...over,
  });

  while (i < lines.length) {
    const pl = parse.lines[i];
    if (!includeLine(i)) {
      i++;
      continue;
    }
    const t = pl.type;
    if (t === 'blank') {
      blankRun++;
      i++;
      continue;
    }
    if (t === 'boneyard' || (t === 'note' && !s.includeNotes)) {
      i++;
      continue;
    }
    const scene = sceneOfLine[i];
    if (t === 'pageBreak') {
      units.push(unit('pageBreak', [], scene, i, { spaceBefore: 0 }));
      blankRun = 0;
      i++;
      continue;
    }
    if (t === 'section' || t === 'synopsis') {
      if (t === 'section' ? s.includeSections : s.includeSynopses) {
        const raw = trimRaw(sty(i), i);
        pushUnit(unit('other', [para(t, [raw], cap.actionChars, 0, { extra: t === 'section' ? S_BOLD : S_ITALIC })], scene, i, { keepNext: 1 }));
      }
      i++;
      continue;
    }
    if (t === 'heading') {
      const st = sty(i);
      const raw = trimRaw({ text: st.text.toUpperCase(), styles: st.styles }, i);
      const extra = (s.boldHeadings ? S_BOLD : 0) | (s.underlineHeadings ? S_UNDERLINE : 0);
      pushUnit(
        unit('heading', [para('heading', [raw], cap.actionChars, 0, { extra, sceneNumber: sceneNum.get(i) })], i, i, {
          spaceBefore: s.elementSpacing + s.headingSpacingBefore,
          keepNext: s.headingKeepLines,
          newPage: newPageScenes,
        }),
      );
      lastCue = null;
      i++;
      continue;
    }
    if (t === 'character') {
      const block = pl.block;
      let j = i + 1;
      while (j < lines.length && parse.lines[j].block === block && parse.lines[j].type !== 'character') j++;
      const left = buildDialogue(i, j, scene);
      if (pl.dual === 'left' && s.dualDialogue === 'side') {
        let k = j;
        while (k < lines.length && parse.lines[k].type === 'blank') k++;
        if (k < lines.length && parse.lines[k].type === 'character' && parse.lines[k].dual === 'right' && includeLine(k)) {
          const rb = parse.lines[k].block;
          let e = k + 1;
          while (e < lines.length && parse.lines[e].block === rb && parse.lines[e].type !== 'character') e++;
          const right = buildDialogue(k, e, scene);
          pushUnit(makeDual(left, right, scene, i));
          i = e;
          continue;
        }
      }
      pushUnit(unit('dialogue', left, scene, i, { splittable: s.splitDialogue }));
      i = j;
      continue;
    }
    if (t === 'transition') {
      const raw = trimRaw(sty(i), i);
      raw.text = raw.text.toUpperCase();
      const tp =
        s.transitionAlign === 'left'
          ? para('transition', [raw], Math.max(8, cap.actionChars - s.transitionIndent), Math.min(s.transitionIndent, cap.actionChars - 8))
          : para('transition', [raw], cap.actionChars, 0, { align: 'right', alignWidth: cap.actionChars });
      pushUnit(unit('other', [tp], scene, i));
      i++;
      continue;
    }
    if (t === 'centered') {
      const raws: Raw[] = [];
      let j = i;
      while (j < lines.length && parse.lines[j].type === 'centered') {
        raws.push(trimRaw(sty(j), j));
        j++;
      }
      pushUnit(unit('other', [para('centered', raws, cap.actionChars, -cap.left / cap.charWidth, { align: 'center', alignWidth: cap.pageWidth / cap.charWidth })], scene, i));
      i = j;
      continue;
    }
    if (t === 'lyric') {
      const raws: Raw[] = [];
      let j = i;
      while (j < lines.length && parse.lines[j].type === 'lyric' && !parse.lines[j].inDialogue) {
        raws.push({ ...sty(j), source: j });
        j++;
      }
      pushUnit(unit('action', [para('lyric', raws, cap.actionChars, 0, { extra: S_ITALIC, splittable: true })], scene, i, { splittable: s.splitAction }));
      i = Math.max(j, i + 1);
      continue;
    }
    if (t === 'note') {
      const raw = { ...sty(i, true), source: i };
      pushUnit(unit('other', [para('note', [raw], cap.actionChars, 0, { extra: S_ITALIC, splittable: true })], scene, i, { splittable: true }));
      i++;
      continue;
    }
    // Action paragraph: consecutive action lines
    const raws: Raw[] = [];
    let j = i;
    while (j < lines.length && includeLine(j) && (parse.lines[j].type === 'action' || (parse.lines[j].type === 'note' && !s.includeNotes))) {
      if (parse.lines[j].type === 'action') {
        const st = sty(j, s.includeNotes);
        const text = st.text.replace(/\t/g, '    ');
        const styles = st.text.includes('\t') ? expandTabStyles(st.text, st.styles) : st.styles;
        const trimmedEnd = text.trimEnd();
        raws.push({ text: trimmedEnd, styles: styles.slice(0, trimmedEnd.length), source: j });
      }
      j++;
    }
    if (raws.length) {
      pushUnit(unit('action', [para('action', raws, cap.actionChars, 0, { splittable: true })], scene, i, { splittable: s.splitAction }));
      if (lastCue && lastCue.scene === scene) lastCue.sawAction = true;
    }
    i = Math.max(j, i + 1);
  }

  function buildDialogue(cueLine: number, end: number, scene: number): Para[] {
    const pl = parse.lines[cueLine];
    const st = sty(cueLine);
    const cueStart = st.text.length - st.text.trimStart().length;
    let cueText = st.text.trim().replace(/\s*\^$/, '').toUpperCase();
    const cueStyles = st.styles.slice(cueStart, cueStart + cueText.length).map((x) => x & S_CHANGED);
    if (s.contdAfterAction && s.contdLabel.trim() && lastCue && lastCue.scene === scene && lastCue.cue === pl.cue && lastCue.sawAction && !/CONT/i.test(cueText)) {
      cueText += ' ' + s.contdLabel;
    }
    lastCue = { cue: pl.cue ?? '', scene, sawAction: false };
    const out: Para[] = [
      para('character', [{ text: cueText, styles: cueStyles.concat(new Array(Math.max(0, cueText.length - cueStyles.length)).fill(0)), source: cueLine }], Math.floor(cap.actionChars - cap.characterCol), cap.characterCol, { extra: s.boldCues ? S_BOLD : 0 }),
    ];
    let k = cueLine + 1;
    while (k < end) {
      const p = parse.lines[k];
      if (p.type === 'note' || p.type === 'boneyard') {
        k++;
        continue;
      }
      if (p.type === 'parenthetical') {
        out.push(para('parenthetical', [trimRaw(sty(k), k)], cap.parentheticalChars, parCol));
        k++;
        continue;
      }
      const lyric = p.type === 'lyric';
      const raws: Raw[] = [];
      while (k < end && (parse.lines[k].type === 'dialogue' || parse.lines[k].type === 'lyric') && (parse.lines[k].type === 'lyric') === lyric) {
        raws.push(trimRaw(sty(k), k));
        k++;
      }
      if (!raws.length) {
        k++;
        continue;
      }
      out.push(para(lyric ? 'lyric' : 'dialogue', raws, cap.dialogueChars, dialCol, { extra: lyric ? S_ITALIC : 0, splittable: true }));
    }
    return out;
  }

  function makeDual(left: Para[], right: Para[], scene: number, source: number): Unit {
    const colW = Math.floor(cap.actionChars / 2) - 1;
    const column = (ps: Para[], offset: number): OutLine[] =>
      layoutParas(
        ps.map((p) => {
          let col = offset;
          let width = colW - 2;
          if (p.kind === 'character') {
            col = offset + Math.max(0, Math.floor(colW * 0.3));
            width = colW - (col - offset);
          } else if (p.kind === 'parenthetical') {
            col = offset + 3;
            width = colW - 6;
          }
          return { ...p, col, width };
        }),
      );
    const L = column(left, 0);
    const R = column(right, colW + 2);
    const rows = Math.max(L.length, R.length);
    const merged: OutLine[] = [];
    for (let r = 0; r < rows; r++) {
      const base = L[r] ?? { col: 0, runs: [], kind: 'dialogue' as LineKind, breakAfter: false, sourceLine: source };
      merged.push({ ...base, dual: R[r] });
    }
    return unit('dual', [], scene, source, { fixed: merged, dualParts: [left, right] });
  }

  // ---------------------------------------------------------------------------------
  // Page filling

  const LPP = cap.linesPerPage;
  const pages: Page[] = [];
  let cur: Page = { number: 1, lines: [], sceneLines: [] };
  let used = 0;
  pages.push(cur);
  const newPage = () => {
    cur = { number: pages.length + 1, lines: [], sceneLines: [] };
    pages.push(cur);
    used = 0;
  };
  // Margin marks: rows with changed text, plus the first row of lines marked for removed text.
  const markedRowDone = new Set<number>();
  const rowMark = (ol: OutLine): boolean => {
    if (!revisions) return false;
    if (ol.runs.some((r) => r.style & S_CHANGED)) {
      markedRowDone.add(ol.sourceLine);
      return true;
    }
    if (revisions.marked.has(ol.sourceLine) && !markedRowDone.has(ol.sourceLine) && ol.kind !== 'more') {
      markedRowDone.add(ol.sourceLine);
      return true;
    }
    return false;
  };
  const place = (ol: OutLine) => {
    ol.runs = bridgeChangedSpaces(ol.runs);
    const mark = rowMark(ol) || (ol.dual ? rowMark(ol.dual) : false);
    cur.lines.push({ row: used, col: ol.col, runs: ol.runs, kind: ol.kind, sceneNumber: ol.sceneNumber, sourceLine: ol.sourceLine, mark: mark || undefined });
    if (ol.dual) cur.lines.push({ row: used, col: ol.dual.col, runs: ol.dual.runs, kind: ol.dual.kind, sourceLine: ol.dual.sourceLine });
    if (mark) cur.changed = true;
    used++;
  };
  const unitLines = (u: Unit) => u.fixed ?? layoutParas(u.paras);
  const unitCount = (u: Unit) => (u.fixed ? u.fixed.length : countLines(u.paras));
  const moreLabel = (u: Unit) => u.kind === 'dialogue' && s.useMoreContd;

  const queue = units.slice();
  let guard = 0;
  for (let u = 0; u < queue.length; u++) {
    if (++guard > 500000) {
      warnings.push('Pagination stopped early: content could not be placed.');
      break;
    }
    const un = queue[u];
    if (un.kind === 'pageBreak') {
      if (used > 0) newPage();
      continue;
    }
    if (un.newPage && used > 0) newPage();
    const count = unitCount(un);
    if (un.kind === 'dual' && count > LPP) {
      const [left, right] = un.dualParts!;
      queue.splice(
        u + 1,
        0,
        unit('dialogue', left, un.sceneLine, un.sourceLine, { spaceBefore: un.spaceBefore, splittable: true }),
        unit('dialogue', right, un.sceneLine, un.sourceLine, { splittable: true }),
      );
      continue;
    }
    const space = used > 0 ? un.spaceBefore : 0;
    const avail = LPP - used - space;
    let keep = 0;
    if (un.keepNext > 0) {
      const next = queue[u + 1];
      if (next && next.kind !== 'pageBreak' && !next.newPage) keep = next.spaceBefore + Math.min(un.keepNext, unitCount(next));
    }
    if (count + keep <= avail) {
      used += space;
      if (un.kind === 'heading') cur.sceneLines.push(un.sceneLine);
      for (const ol of unitLines(un)) place(ol);
      continue;
    }
    if (un.splittable && used > 0) {
      const split = findSplit(un, avail, false);
      if (split) {
        used += space;
        emitSplit(un, split, u);
        continue;
      }
    }
    if (used > 0) {
      newPage();
      u--;
      continue;
    }
    // Empty page
    if (count <= LPP) {
      if (un.kind === 'heading') cur.sceneLines.push(un.sceneLine);
      for (const ol of unitLines(un)) place(ol);
      continue;
    }
    // Taller than a page: split at a sentence if possible, otherwise at any line.
    const split = findSplit(un, LPP, false) ?? findSplit(un, LPP, true);
    if (split) {
      emitSplit(un, split, u);
      continue;
    }
    // Last resort: place everything that fits line by line.
    const all = unitLines(un);
    for (let k = 0; k < all.length; k++) {
      if (used >= LPP) newPage();
      place(all[k]);
    }
  }

  interface Split {
    first: Para[];
    rest: Para[];
  }

  /**
   * Finds the latest acceptable split so that the first part fits into `avail` lines.
   * Candidates: paragraph boundaries and sentence ends (or every soft line when forced).
   */
  function findSplit(un: Unit, avail: number, forced: boolean): Split | null {
    if (un.fixed) return null;
    const ps = un.paras;
    const more = moreLabel(un) ? 1 : 0;
    const maxFirst = avail - more;
    if (maxFirst < 1) return null;
    const isDialogue = un.kind === 'dialogue';
    const minBefore = forced ? 1 : s.minLinesBeforeBreak;
    const minAfter = forced ? 1 : s.minLinesAfterBreak;
    let best: Split | null = null;
    let bestLines = -1;
    for (let pi = 0; pi < ps.length; pi++) {
      const p = ps[pi];
      const before = ps.slice(0, pi);
      const after = ps.slice(pi + 1);
      // Boundary before this paragraph (not right after a cue or parenthetical)
      if (pi > 0 && ps[pi - 1].kind !== 'parenthetical' && ps[pi - 1].kind !== 'character') {
        consider(before, ps.slice(pi));
      }
      if (!p.splittable) continue;
      for (let r = 0; r < p.raw.length; r++) {
        const raw = p.raw[r];
        const offsets = new Set<number>();
        if (r > 0) offsets.add(-1); // boundary between hard lines
        for (const off of sentenceEnds(raw.text)) if (off < raw.text.length) offsets.add(off);
        // Dialogue may break at any line unless only sentence ends are allowed.
        if (forced || (isDialogue && !s.dialogueSentenceBreaks)) for (const [, b] of wrap(raw.text, p.width)) if (b < raw.text.length) offsets.add(b);
        for (const off of offsets) {
          let firstRaw: Raw[];
          let restRaw: Raw[];
          if (off === -1) {
            firstRaw = p.raw.slice(0, r);
            restRaw = p.raw.slice(r);
          } else {
            const headText = raw.text.slice(0, off).trimEnd();
            let tailStart = off;
            while (tailStart < raw.text.length && raw.text[tailStart] === ' ') tailStart++;
            if (!headText || tailStart >= raw.text.length) continue;
            firstRaw = [...p.raw.slice(0, r), { text: headText, styles: raw.styles.slice(0, headText.length), source: raw.source }];
            restRaw = [{ text: raw.text.slice(tailStart), styles: raw.styles.slice(tailStart), source: raw.source }, ...p.raw.slice(r + 1)];
          }
          if (!firstRaw.length || !restRaw.length) continue;
          consider([...before, { ...p, raw: firstRaw }], [{ ...p, raw: restRaw, sceneNumber: undefined }, ...after]);
        }
      }
    }
    return best;

    function consider(first: Para[], rest: Para[]) {
      const fl = countLines(first);
      if (fl > maxFirst || fl <= bestLines) return;
      const spoken = (q: Para) => q.kind === 'dialogue' || q.kind === 'lyric';
      const content = isDialogue ? countLines(first.filter(spoken)) : fl;
      if (content < minBefore) return;
      if (isDialogue && first[first.length - 1].kind === 'parenthetical') return;
      const restContent = isDialogue ? countLines(rest.filter(spoken)) : countLines(rest);
      if (restContent < minAfter) return;
      best = { first, rest };
      bestLines = fl;
    }
  }

  function emitSplit(un: Unit, split: Split, u: number) {
    if (un.kind === 'heading') cur.sceneLines.push(un.sceneLine);
    for (const ol of layoutParas(split.first)) place(ol);
    const isDialogue = un.kind === 'dialogue';
    if (moreLabel(un)) {
      place({ col: cap.parentheticalCol, runs: [{ text: s.moreLabel, style: 0 }], kind: 'more', breakAfter: false, sourceLine: un.sourceLine });
    }
    newPage();
    let rest = split.rest;
    if (isDialogue) {
      const cue = un.paras[0];
      if (s.useMoreContd) {
        let cueText = cue.raw[0].text;
        if (s.contdLabel.trim() && !cueText.includes(s.contdLabel)) cueText = cueText + ' ' + s.contdLabel;
        rest = [{ ...cue, raw: [{ text: cueText, styles: new Array(cueText.length).fill(0), source: cue.raw[0].source }] }, ...rest];
      } else {
        rest = [cue, ...rest];
      }
    }
    queue.splice(u + 1, 0, { ...un, paras: rest, spaceBefore: 0, newPage: false, keepNext: 0, kind: un.kind === 'heading' ? 'other' : un.kind });
  }

  if (pages.length > 1 && pages[pages.length - 1].lines.length === 0) pages.pop();

  let result = pages;
  if (scope.kind === 'pages') {
    const wanted = parsePageRanges(scope.pages, pages.length);
    result = pages.filter((p) => wanted.has(p.number));
  }
  if (revisions?.changedPagesOnly) result = result.filter((p) => p.changed);

  const out: Page[] = [];
  if (s.titlePage && parse.titleEnd > 0 && scope.kind !== 'pages' && !revisions?.changedPagesOnly) out.push(buildTitlePage(lines, parse, s, cap));
  out.push(...result);
  return { pages: out, capacity: cap, warnings, bodyPageCount: result.length };
}

function expandTabStyles(text: string, styles: number[]): number[] {
  const out: number[] = [];
  for (let k = 0; k < text.length; k++) {
    if (text[k] === '\t') out.push(styles[k], styles[k], styles[k], styles[k]);
    else out.push(styles[k]);
  }
  return out;
}

export function parsePageRanges(spec: string, max: number): Set<number> {
  const set = new Set<number>();
  for (const part of spec.split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d+)?\s*-\s*(\d+)?$/.exec(part);
    if (m) {
      const a = m[1] ? parseInt(m[1], 10) : 1;
      const b = m[2] ? parseInt(m[2], 10) : max;
      for (let k = Math.max(1, a); k <= Math.min(max, b); k++) set.add(k);
    } else if (/^\d+$/.test(part)) {
      const n = parseInt(part, 10);
      if (n >= 1 && n <= max) set.add(n);
    }
  }
  return set;
}

function buildTitlePage(lines: string[], parse: ParseResult, s: ExportSettings, cap: Capacity): Page {
  const fields = titleFields(lines, parse);
  // Empty fields (placeholders like "Contact:") print nothing.
  const get = (...keys: string[]) => fields.filter((f) => keys.includes(f.key)).map((f) => strip(f.value)).filter((v) => v.trim() !== '');
  const items: TitleItem[] = [];
  // Title page details are set in 12 pt with single (12 pt) spacing; positions are baselines.
  const lh = 12;
  let y = Math.max(s.titleSize, s.titleBaseline);
  const titles = get('title');
  let first = true;
  for (const t of titles) {
    for (const part of t.split('\n')) {
      if (!first) y += s.titleSize * 1.15;
      first = false;
      items.push({ text: s.titleUppercase ? part.toUpperCase() : part, y, align: 'center', title: true });
    }
  }
  // Credit ("written by", "von") about five lines below the title, the author a blank line below.
  y += titles.length ? 67.5 : 0;
  const centerBlock = (vals: string[], gapAfter: number) => {
    for (const v of vals)
      for (const part of v.split('\n')) {
        items.push({ text: part, y, align: 'center' });
        y += lh;
      }
    if (vals.length) y += lh * gapAfter;
  };
  centerBlock(get('credit'), 1);
  centerBlock(get('author', 'authors', 'writer', 'writers'), 1);
  centerBlock(get('source'), 1);
  // Bottom corners: the same distance from the left, right and bottom edges of the paper.
  // Notes (e.g. a project number) stand above the contact details, two lines apart; the date
  // closes the other corner on the same line as the last contact line.
  const notes = get('notes');
  const contact = get('contact', 'address', 'phone', 'email', 'agent');
  const titleDates = get('draft date', 'date');
  // The export draft date is used on the title page only when the title page has none.
  const dates = titleDates.length ? titleDates : s.draftDate ? [s.draftDate] : [];
  const other = [...get('revision', 'copyright'), ...dates];
  const bottom = cap.pageHeight - Math.max(24, s.titleInset);
  const split = (vals: string[]) => vals.flatMap((v) => v.split('\n'));
  const place = (linesOut: Array<string | null>, align: 'left' | 'right') => {
    let yy = bottom - (linesOut.length - 1) * lh;
    for (const l of linesOut) {
      if (l !== null) items.push({ text: l, y: yy, align });
      yy += lh;
    }
  };
  const contactLines: Array<string | null> = split(notes);
  if (notes.length && contact.length) contactLines.push(null, null);
  contactLines.push(...split(contact));
  const contactAlign = s.contactPosition === 'bottom-right' ? 'right' : 'left';
  place(contactLines, contactAlign);
  place(split(other), contactAlign === 'left' ? 'right' : 'left');
  return { number: 0, lines: [], title: items, sceneLines: [] };
}

function strip(v: string): string {
  // Title values may contain emphasis or centering markers; print them clean.
  // Underscores are only removed when they pair up as underline markers (keeps e-mail addresses).
  return v
    .replace(/\*{1,3}(?=\S)(.+?)(?<=\S)\*{1,3}/g, '$1')
    .replace(/(^|[^\p{L}\p{N}])_(?=\S)(.+?)(?<=\S)_(?![\p{L}\p{N}])/gu, '$1$2')
    .replace(/\\([*_])/g, '$1')
    .replace(/^>\s*|\s*<$/gm, '')
    .trim();
}

export { strip as cleanTitleValue };

export { cleanText };
