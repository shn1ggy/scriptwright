// The screenplay editor view.
//
// A custom view over the line model: text input goes through a hidden textarea, lines
// are rendered as plain DOM with formatting operators removed from layout on inactive
// lines, and caret/selection are painted from measured text rectangles. Script, Scene
// and Dialogue views are filters over the same document — never copies.

import {
  Line,
  Pos,
  Selection,
  Step,
  applyStep,
  clampPos,
  cmpPos,
  cursor,
  eqPos,
  invertStep,
  isWordChar,
  joinLines,
  makeLines,
  maxPos,
  minPos,
  nextCh,
  posAfterInsert,
  prevCh,
  replaceStep,
  selEmpty,
  selFrom,
  selTo,
  textBetween,
  wordAt,
  wordLeft,
  wordRight,
} from '../../shared/doc';
import {
  F_BOLD,
  F_BONEYARD,
  F_ESCAPED,
  F_ITALIC,
  F_LABEL,
  F_MARKER,
  F_NOTE,
  F_UNDERLINE,
  ParseResult,
  ParsedLine,
  looksLikeCue,
  parse,
  reparseLine,
} from '../../shared/fountain';
import { EditorSettings } from '../../shared/types';
import { EditKind, History } from './history';

export interface Highlight {
  line: number;
  from: number;
  to: number;
}

export type ChangeOrigin = 'input' | 'undo' | 'redo' | 'command' | 'load' | 'external';

export interface EditorHooks {
  onChange?(origin: ChangeOrigin, steps: Step[]): void;
  onSelection?(): void;
  onScroll?(): void;
  onFocusChange?(focused: boolean): void;
  onContextMenu?(e: MouseEvent, pos: Pos | null): void;
  /** Cmd-click (macOS) / Ctrl-click: return true when the click was used (e.g. to open a comment). */
  onModClick?(e: MouseEvent, pos: Pos): boolean;
  /** Label for a gap between two displayed lines in filtered views (null = plain gap). */
  gapLabel?(prevLine: number, nextLine: number): string | null;
  /** Spellchecking: returns true for misspelled words. */
  isMisspelled?(word: string): boolean;
}

interface Seg {
  node: Text;
  src: number;
  len: number;
}

interface LineView {
  el: HTMLElement;
  sig: string;
  segs: Seg[];
  zw: Text | null;
  line: number;
  /** What was rendered last time (compared field by field to skip unchanged lines). */
  prev?: { text: string; p: ParsedLine; active: boolean; miss: string; sn: string };
}

interface DragState {
  x: number;
  y: number;
  moved: boolean;
  mode: 'char' | 'word' | 'line';
  anchorFrom: Pos;
  anchorTo: Pos;
}

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

export class Editor {
  readonly dom: HTMLElement;
  private column: HTMLElement;
  private content: HTMLElement;
  private selLayer: HTMLElement;
  private hlLayer: HTMLElement;
  private pbLayer: HTMLElement;
  private decoLayer: HTMLElement;
  private decorations: Array<{ a: { key: number; ch: number }; b: { key: number; ch: number }; cls: string }> = [];
  pageMarkers: Array<{ key: number; frac: number; label: string }> = [];
  private caretEl: HTMLElement;
  private input: HTMLTextAreaElement;

  lines: Line[] = [{ key: 0, text: '' }];
  parsed: ParseResult;
  sel: Selection = cursor({ line: 0, ch: 0 });
  version = 0;
  history = new History();
  settings: EditorSettings;
  hooks: EditorHooks = {};
  /** Electron handles undo/redo/select-all through the menu. */
  editKeysFromMenu = false;

  /** Visible line keys in filtered views; null shows everything. */
  private filter: Set<number> | null = null;
  private filterKind: 'scene' | 'dialogue' | null = null;
  private hidden: Set<number> | null = null;
  private sourceMode = false;
  private focused = false;
  private composing = false;
  private views = new Map<number | string, LineView>();
  private displayed: number[] = [];
  private displayedPos = new Map<number, number>(); // line index -> position in displayed
  private goalX: number | null = null;
  private drag: DragState | null = null;
  private lastClick: { x: number; y: number; time: number; pos: Pos } | null = null;
  private autoScroll: number | null = null;
  private highlights: Highlight[] = [];
  private currentHighlight = -1;
  private extraPrefixes: string[] = [];
  private paintQueued = false;
  private renderedActive = -2;

  constructor(host: HTMLElement, settings: EditorSettings) {
    this.settings = settings;
    this.extraPrefixes = settings.extraPrefixes;
    this.dom = el('div', 'ed-scroller');
    this.dom.tabIndex = -1;
    this.column = el('div', 'ed-column');
    this.hlLayer = el('div', 'ed-layer ed-hl');
    this.pbLayer = el('div', 'ed-layer ed-pb');
    this.decoLayer = el('div', 'ed-layer ed-deco');
    this.selLayer = el('div', 'ed-layer ed-sel');
    this.content = el('div', 'ed-content');
    this.caretEl = el('div', 'ed-caret');
    this.input = document.createElement('textarea');
    this.input.className = 'ed-input';
    this.input.setAttribute('autocomplete', 'off');
    this.input.setAttribute('autocorrect', 'off');
    this.input.setAttribute('autocapitalize', 'off');
    this.input.setAttribute('spellcheck', 'false');
    this.input.setAttribute('aria-label', 'Screenplay');
    this.input.wrap = 'off';
    this.column.append(this.pbLayer, this.decoLayer, this.hlLayer, this.selLayer, this.content, this.caretEl, this.input);
    this.dom.append(this.column);
    host.append(this.dom);
    this.parsed = parse(['']);
    this.applySettings(settings);
    this.bind();
    this.render();
  }

  // ---------------------------------------------------------------------------------
  // Public API

  setText(text: string, sel?: Selection) {
    this.lines = makeLines(text);
    this.sel = sel ? this.clampSel(sel) : cursor({ line: 0, ch: 0 });
    this.history.clear();
    this.version++;
    this.reparse();
    this.views.clear();
    this.content.textContent = '';
    this.render();
    this.hooks.onChange?.('load', []);
  }

  getText(): string {
    return joinLines(this.lines);
  }

  get lineTexts(): string[] {
    return this.lines.map((l) => l.text);
  }

  applySettings(s: EditorSettings) {
    this.settings = s;
    this.extraPrefixes = s.extraPrefixes;
    const st = this.dom.style;
    st.setProperty('--ed-font', `'${s.fontFamily}', 'Courier Prime', 'Courier New', Courier, monospace`);
    st.setProperty('--ed-size', `${s.fontSize}px`);
    st.setProperty('--ed-lh', `${s.lineHeight}px`);
    st.setProperty('--ed-measure', String(s.measure));
    // Screenplay geometry scaled from the classic 60-character page.
    const k = s.measure / 60;
    st.setProperty('--ed-cue', `${Math.round(20 * k)}ch`);
    st.setProperty('--ed-dlg-l', `${Math.round(10 * k)}ch`);
    st.setProperty('--ed-dlg-r', `${Math.round(15 * k)}ch`);
    st.setProperty('--ed-par-l', `${Math.round(15 * k)}ch`);
    st.setProperty('--ed-par-r', `${Math.round(20 * k)}ch`);
    this.reparse();
    this.views.clear();
    this.content.textContent = '';
    this.render();
  }

  setSource(on: boolean) {
    if (this.sourceMode === on) return;
    this.sourceMode = on;
    this.dom.classList.toggle('ed-source', on);
    this.render();
  }

  get source() {
    return this.sourceMode;
  }

  /** Shows only lines whose keys are in `keys` (Scene and Dialogue views). */
  setFilter(keys: Set<number> | null, kind: 'scene' | 'dialogue' | null) {
    this.filter = keys ? new Set(keys) : null;
    this.filterKind = keys ? kind : null;
    this.dom.classList.toggle('ed-filtered', !!keys);
    this.render();
    // Keep the caret on a visible line.
    if (this.filter && !this.isVisibleLine(this.sel.head.line)) {
      const first = this.displayed[0];
      if (first !== undefined) this.setSelection(cursor({ line: first, ch: 0 }), { scroll: false });
    }
  }

  get filterKeys(): Set<number> | null {
    return this.filter;
  }

  isVisibleLine(i: number): boolean {
    const k = this.lines[i]?.key;
    return (!this.filter || this.filter.has(k)) && !(this.hidden && this.hidden.has(k));
  }

  /**
   * Lines hidden in addition to any view filter (the title page in Script view). Unlike a
   * filter, new lines stay visible; only these keys are hidden.
   */
  setHidden(keys: Set<number> | null) {
    const next = keys && keys.size ? keys : null;
    const cur = this.hidden;
    if (!next && !cur) return;
    if (next && cur && next.size === cur.size && [...next].every((k) => cur.has(k))) return;
    this.hidden = next ? new Set(next) : null;
    this.render();
    if (this.hidden && !this.isVisibleLine(this.sel.head.line)) {
      const first = this.displayed[0];
      if (first !== undefined) this.setSelection(cursor({ line: first, ch: 0 }), { scroll: false });
    }
  }

  get displayedLines(): readonly number[] {
    return this.displayed;
  }

  focus() {
    this.input.focus({ preventScroll: true });
  }

  hasFocus() {
    return document.activeElement === this.input;
  }

  blur() {
    this.input.blur();
  }

  setHighlights(h: Highlight[], current = -1) {
    this.highlights = h;
    this.currentHighlight = current;
    this.paintSoon();
  }

  /** Persistent ranges (highlights, comments, passages) painted behind the text. */
  setDecorations(decos: Array<{ a: { key: number; ch: number }; b: { key: number; ch: number }; cls: string }>) {
    this.decorations = decos;
    this.paintSoon();
  }

  /**
   * Page break markers: before the line with `key`, `frac` of the way into it (a page can
   * break inside a long paragraph). Labels are page numbers.
   */
  setPageMarkers(markers: Array<{ key: number; frac: number; label: string }>) {
    this.pageMarkers = markers;
    this.paintSoon();
  }

  setSelection(sel: Selection, opts: { scroll?: boolean | 'center' | 'top'; keepGoal?: boolean } = {}) {
    const next = this.clampSel(sel);
    const prevLine = this.sel.head.line;
    const lineChanged = next.head.line !== prevLine;
    this.sel = next;
    if (!opts.keepGoal) this.goalX = null;
    let full = true;
    if (lineChanged) {
      // The caret line only affects interpretation for an empty line after a cue.
      if (this.activeMatters(prevLine) || this.activeMatters(next.head.line)) this.reparse();
      else {
        this.parsedActive = next.head.line;
        full = false;
      }
    } else full = false;
    if (full) this.render();
    else this.renderLines(lineChanged ? [prevLine, next.head.line] : [next.head.line]);
    if (opts.scroll !== false) this.scrollToCaret(opts.scroll === 'center' ? 'center' : opts.scroll === 'top' ? 'top' : 'nearest');
    this.syncInput();
    this.hooks.onSelection?.();
  }

  /** Replaces a range with text as one undoable edit. */
  replaceRange(from: Pos, to: Pos, text: string, kind: EditKind = 'other', origin: ChangeOrigin = 'command', selAfter?: Selection) {
    const step = replaceStep(this.lines, from, to, text);
    const end = posAfterInsert(from, text);
    this.commit([step], selAfter ?? cursor(end), kind, origin);
  }

  /**
   * Runs several structural edits as one undoable change. The callback receives a
   * transaction whose operations apply immediately; it returns the selection to use after.
   */
  edit(fn: (tx: Transaction) => Selection | void, origin: ChangeOrigin = 'command'): boolean {
    const before = this.sel;
    const tx = new Transaction(this.lines);
    let selAfter: Selection | void;
    try {
      selAfter = fn(tx);
    } catch (err) {
      // Roll back anything already applied, then rethrow.
      for (let i = tx.steps.length - 1; i >= 0; i--) applyStep(this.lines, invertStep(tx.steps[i]));
      throw err;
    }
    if (!tx.steps.length) return false;
    this.version++;
    const after = this.clampSel(selAfter ?? this.sel);
    this.history.push({ steps: tx.steps, selBefore: before, selAfter: after, kind: 'other', time: Date.now() });
    this.history.seal();
    this.sel = after;
    this.afterChange(tx.steps, origin);
    return true;
  }

  undo() {
    const e = this.history.done.pop();
    if (!e) return false;
    for (let i = e.steps.length - 1; i >= 0; i--) applyStep(this.lines, invertStep(e.steps[i]));
    this.history.undone.push(e);
    this.version++;
    this.sel = this.clampSel(e.selBefore);
    this.afterChange(e.steps.map(invertStep).reverse(), 'undo');
    return true;
  }

  redo() {
    const e = this.history.undone.pop();
    if (!e) return false;
    for (const st of e.steps) applyStep(this.lines, st);
    this.history.done.push(e);
    this.version++;
    this.sel = this.clampSel(e.selAfter);
    this.afterChange(e.steps, 'redo');
    return true;
  }

  selectedText(): string {
    const from = selFrom(this.sel);
    const to = selTo(this.sel);
    if (!this.filter) return textBetween(this.lines, from, to);
    // In filtered views only visible text is copied.
    const parts: string[] = [];
    for (let i = from.line; i <= to.line; i++) {
      if (!this.isVisibleLine(i)) continue;
      const t = this.lines[i].text;
      const a = i === from.line ? from.ch : 0;
      const b = i === to.line ? to.ch : t.length;
      parts.push(t.slice(a, b));
    }
    return parts.join('\n');
  }

  /** Inserts text at the selection, protecting hidden lines in filtered views. */
  insertText(text: string, kind: EditKind = 'type') {
    this.replaceSelection(text, kind);
  }

  selectAll() {
    if (this.displayed.length === 0) return;
    const first = this.displayed[0];
    const last = this.displayed[this.displayed.length - 1];
    this.setSelection({ anchor: { line: first, ch: 0 }, head: { line: last, ch: this.lines[last].text.length } }, { scroll: false });
  }

  scrollToLine(line: number, mode: 'top' | 'center' | 'nearest' = 'top', marginLines = 1) {
    const v = this.viewForLine(line);
    if (!v) return;
    const lh = this.settings.lineHeight;
    const top = this.offsetInScroller(v.el);
    if (mode === 'top') this.dom.scrollTop = Math.max(0, top - marginLines * lh);
    else if (mode === 'center') this.dom.scrollTop = Math.max(0, top - this.dom.clientHeight / 2);
    else this.ensureRectVisible(top, top + v.el.offsetHeight);
    this.paintSoon();
  }

  /** First displayed document line at the top of the viewport. */
  topVisibleLine(): number {
    const st = this.dom.scrollTop;
    let lo = 0;
    let hi = this.displayed.length - 1;
    let ans = this.displayed[0] ?? 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = this.views.get(this.lines[this.displayed[mid]].key);
      if (!v) break;
      const bottom = this.offsetInScroller(v.el) + v.el.offsetHeight;
      if (bottom > st + 2) {
        ans = this.displayed[mid];
        hi = mid - 1;
      } else lo = mid + 1;
    }
    return ans;
  }

  /** Whether the caret is currently inside the viewport. */
  caretInView(): boolean {
    const c = this.coordsAtPos(this.sel.head);
    if (!c) return false;
    const r = this.dom.getBoundingClientRect();
    return c.top >= r.top - 2 && c.bottom <= r.bottom + 2;
  }

  get scrollTop() {
    return this.dom.scrollTop;
  }
  set scrollTop(v: number) {
    this.dom.scrollTop = v;
  }

  /** Keeps the caret at the same screen position while the layout above changes. */
  measureCaretOffset(): number | null {
    const c = this.coordsAtPos(this.sel.head);
    if (!c) return null;
    return c.top - this.dom.getBoundingClientRect().top;
  }

  restoreCaretOffset(offset: number | null) {
    if (offset === null) return;
    const c = this.coordsAtPos(this.sel.head);
    if (!c) return;
    const now = c.top - this.dom.getBoundingClientRect().top;
    this.dom.scrollTop += now - offset;
  }

  // ---------------------------------------------------------------------------------
  // Change pipeline

  private commit(steps: Step[], selAfter: Selection, kind: EditKind, origin: ChangeOrigin) {
    const before = this.sel;
    for (const st of steps) applyStep(this.lines, st);
    this.version++;
    this.history.push({ steps, selBefore: before, selAfter, kind, time: Date.now() });
    this.sel = this.clampSel(selAfter);
    this.afterChange(steps, origin);
  }

  private afterChange(steps: Step[], origin: ChangeOrigin) {
    // New lines created while editing in a filtered view stay visible until the view changes.
    if (this.filter && (origin === 'input' || origin === 'undo' || origin === 'redo' || origin === 'command')) {
      for (const st of steps) {
        const removedKeys = new Set(st.removed.map((l) => l.key));
        const touchesVisible = st.removed.some((l) => this.filter!.has(l.key)) || st.removed.length === 0;
        if (!touchesVisible) continue;
        for (const l of st.inserted) if (!removedKeys.has(l.key)) this.filter.add(l.key);
      }
    }
    this.goalX = null;
    const changed = this.reparseAfter(steps);
    if (changed >= 0 && !this.filterChangedBy(steps)) this.renderLines([changed, this.activeLine()]);
    else this.render();
    this.scrollToCaret('nearest');
    this.syncInput();
    this.hooks.onChange?.(origin, steps);
    this.hooks.onSelection?.();
  }

  private parsedActive = -1;

  private reparse() {
    this.parsed = parse(this.lineTexts, { extraPrefixes: this.extraPrefixes, activeLine: this.sel.head.line });
    this.parsedActive = this.sel.head.line;
  }

  /** Re-parses after steps; uses the single-line fast path when possible. Returns the changed line or -1. */
  private reparseAfter(steps: Step[]): number {
    if (steps.length >= 1 && this.parsedActive === this.sel.head.line) {
      // All steps edit the same single line in place?
      const st = steps[steps.length - 1];
      const first = steps[0];
      const sameLine = steps.every((x) => x.removed.length === 1 && x.inserted.length === 1 && x.removed[0].key === x.inserted[0].key && x.at === first.at);
      if (sameLine) {
        const fast = reparseLine(this.lineTexts, this.parsed, st.at, first.removed[0].text, { extraPrefixes: this.extraPrefixes, activeLine: this.sel.head.line });
        if (fast) {
          this.parsed = fast;
          return st.at;
        }
      }
    }
    this.reparse();
    return -1;
  }

  /** Whether moving the caret between these lines can change how the text is interpreted. */
  private activeMatters(line: number): boolean {
    const L = this.lines;
    if (line < 1 || line >= L.length) return false;
    return L[line].text === '' && looksLikeCue(L[line - 1].text.trim().replace(/^@/, 'X'));
  }

  private clampSel(s: Selection): Selection {
    return { anchor: clampPos(this.lines, s.anchor), head: clampPos(this.lines, s.head) };
  }

  /** Replaces the selection; in filtered views hidden lines inside the range are kept. */
  private replaceSelection(text: string, kind: EditKind) {
    const from = selFrom(this.sel);
    const to = selTo(this.sel);
    const runs = this.visibleRuns(from.line, to.line);
    if (!this.filter || runs.length <= 1) {
      this.replaceRange(from, to, text, kind, 'input');
      return;
    }
    const before = this.sel;
    const steps: Step[] = [];
    // Bottom-up so earlier indices stay valid.
    for (let r = runs.length - 1; r >= 0; r--) {
      const run = runs[r];
      const s = run[0];
      const e = run[run.length - 1];
      let st: Step;
      if (r === 0) st = replaceStep(this.lines, from, { line: e, ch: this.lines[e].text.length }, '');
      else if (r === runs.length - 1) st = replaceStep(this.lines, { line: s, ch: 0 }, to, '');
      else st = { at: s, removed: this.lines.slice(s, e + 1), inserted: [] };
      applyStep(this.lines, st);
      steps.push(st);
    }
    if (text) {
      const st = replaceStep(this.lines, from, from, text);
      applyStep(this.lines, st);
      steps.push(st);
    }
    const selAfter = cursor(posAfterInsert(from, text));
    this.version++;
    this.history.push({ steps, selBefore: before, selAfter, kind: 'other', time: Date.now() });
    this.history.seal();
    this.sel = this.clampSel(selAfter);
    this.afterChange(steps, 'input');
  }

  private visibleRuns(a: number, b: number): number[][] {
    const runs: number[][] = [];
    let cur: number[] = [];
    for (let i = a; i <= b; i++) {
      if (this.isVisibleLine(i)) cur.push(i);
      else if (cur.length) {
        runs.push(cur);
        cur = [];
      }
    }
    if (cur.length) runs.push(cur);
    return runs;
  }

  // ---------------------------------------------------------------------------------
  // Rendering

  private activeLine(): number {
    return this.focused || this.composing ? this.sel.head.line : -1;
  }

  /** True when steps added or removed displayed lines (structure changed). */
  private filterChangedBy(steps: Step[]): boolean {
    return steps.some((st) => st.removed.length !== st.inserted.length || st.removed.some((l, k) => l.key !== st.inserted[k].key));
  }

  /** Re-renders only the given document lines (no structural change). */
  private renderLines(indices: number[]) {
    const active = this.activeLine();
    if (this.renderedActive !== active && this.renderedActive >= 0) indices = [...indices, this.renderedActive];
    this.renderedActive = active;
    const done = new Set<number>();
    for (const i of indices) {
      if (i < 0 || i >= this.lines.length || done.has(i)) continue;
      done.add(i);
      const line = this.lines[i];
      const v = this.views.get(line.key);
      if (!v || v.line !== i) continue;
      const p = this.parsed.lines[i];
      const isActive = i === active || this.sourceMode;
      const misspelled = this.hooks.isMisspelled && this.settings.spellcheck && p.type !== 'boneyard' ? this.misspellings(line.text, p, i === active) : '';
      const sn = this.sceneLabel(i, p);
      if (!sameRender(v.prev, line.text, p, isActive, misspelled, sn)) {
        this.renderLine(v, line.text, p, isActive, misspelled, sn);
        v.prev = { text: line.text, p, active: isActive, miss: misspelled, sn };
      } else v.prev!.p = p;
    }
    this.paint();
  }

  render() {
    const lines = this.lines;
    const pl = this.parsed.lines;
    const active = this.activeLine();
    this.renderedActive = active;
    const displayed: number[] = [];
    const hidden = this.hidden;
    for (let i = 0; i < lines.length; i++) if ((!this.filter || this.filter.has(lines[i].key)) && !(hidden && hidden.has(lines[i].key))) displayed.push(i);
    this.displayed = displayed;
    this.displayedPos.clear();
    displayed.forEach((d, k) => this.displayedPos.set(d, k));

    const wanted: HTMLElement[] = [];
    const seen = new Set<number | string>();
    for (let k = 0; k < displayed.length; k++) {
      const i = displayed[k];
      if (k > 0 && displayed[k - 1] !== i - 1) {
        const gapKey = `g${lines[displayed[k - 1]].key}`;
        const label = this.filterKind === 'dialogue' ? this.hooks.gapLabel?.(displayed[k - 1], i) ?? null : null;
        const sig = `gap|${label}`;
        let gv = this.views.get(gapKey);
        if (!gv || gv.sig !== sig) {
          const g = el('div', 'ln-gap');
          if (label) g.append(el('span', 'ln-gap-label', label));
          gv = { el: g, sig, segs: [], zw: null, line: -1 };
          this.views.set(gapKey, gv);
        }
        seen.add(gapKey);
        wanted.push(gv.el);
      }
      const line = lines[i];
      const p = pl[i];
      const isActive = i === active || this.sourceMode;
      const misspelled = this.hooks.isMisspelled && this.settings.spellcheck && p.type !== 'boneyard' ? this.misspellings(line.text, p, i === active) : '';
      const sn = this.sceneLabel(i, p);
      let v = this.views.get(line.key);
      if (!v || v.sig === '' || !sameRender(v.prev, line.text, p, isActive, misspelled, sn)) {
        if (!v) v = { el: el('div', 'ln'), sig: '', segs: [], zw: null, line: i };
        this.renderLine(v, line.text, p, isActive, misspelled, sn);
        v.sig = 'r';
        v.prev = { text: line.text, p, active: isActive, miss: misspelled, sn };
        this.views.set(line.key, v);
      } else v.prev!.p = p;
      v.line = i;
      seen.add(line.key);
      wanted.push(v.el);
    }
    // Drop views that are no longer displayed
    for (const [k, v] of this.views) {
      if (!seen.has(k)) {
        v.el.remove();
        this.views.delete(k);
      }
    }
    // Reconcile order with minimal DOM moves
    let cursorNode = this.content.firstChild;
    for (const w of wanted) {
      if (cursorNode === w) {
        cursorNode = cursorNode.nextSibling;
      } else {
        this.content.insertBefore(w, cursorNode);
      }
    }
    while (cursorNode) {
      const next = cursorNode.nextSibling;
      this.content.removeChild(cursorNode);
      cursorNode = next;
    }
    this.paint();
  }

  private misspellings(text: string, p: ParsedLine, active: boolean): string {
    const out: string[] = [];
    const re = /[\p{L}][\p{L}'’\-]*[\p{L}]|[\p{L}]/gu;
    let m: RegExpExecArray | null;
    const caretCh = active ? this.sel.head.ch : -1;
    while ((m = re.exec(text))) {
      const a = m.index;
      const b = a + m[0].length;
      if (caretCh >= a && caretCh <= b) continue; // don't flag the word being typed
      if (p.flags && p.flags[a] & (F_MARKER | F_LABEL)) continue;
      if (this.hooks.isMisspelled!(m[0].replace(/[’]/g, "'"))) out.push(`${a}-${b}`);
    }
    return out.join(',');
  }

  private labelsFor: ParseResult | null = null;
  private labels = new Map<number, string>();

  /**
   * Scene number shown beside a heading: the written #12A# number, otherwise the scene's
   * position in the outline (as if #n# had been written). Returns "mode:label" or ''.
   */
  private sceneLabel(i: number, p: ParsedLine): string {
    const mode = this.settings.sceneNumbers;
    if (p.type !== 'heading' || mode === 'off') return '';
    if (this.labelsFor !== this.parsed) {
      this.labels.clear();
      for (const sc of this.parsed.scenes) this.labels.set(sc.line, sc.sceneNumber ?? String(sc.order));
      this.labelsFor = this.parsed;
    }
    const label = p.sceneNumber ?? this.labels.get(i);
    return label ? `${mode}:${label}` : '';
  }

  private renderLine(v: LineView, text: string, p: ParsedLine, active: boolean, misspelled: string, snLabel = '') {
    const e = v.el;
    let cls = `ln el-${p.type}`;
    if (active) cls += ' is-active';
    if (p.dual) cls += ` dual-${p.dual}`;
    if (p.inDialogue) cls += ' in-dialogue';
    if (p.type === 'section') cls += ` lvl-${Math.min(3, p.level ?? 1)}`;
    e.className = cls;
    e.textContent = '';
    v.segs = [];
    v.zw = null;
    const flags = p.flags;
    const miss: Array<[number, number]> = misspelled
      ? misspelled.split(',').map((r) => r.split('-').map(Number) as [number, number])
      : [];
    const isMiss = (k: number) => miss.some(([a, b]) => k >= a && k < b);
    let k = 0;
    const n = text.length;
    while (k < n) {
      const f = flags ? flags[k] : 0;
      const hidden = !active && f & F_MARKER;
      if (hidden) {
        k++;
        continue;
      }
      const ms = miss.length ? isMiss(k) : false;
      let j = k + 1;
      while (j < n) {
        const f2 = flags ? flags[j] : 0;
        if (f2 !== f) break;
        if (miss.length && isMiss(j) !== ms) break;
        j++;
      }
      const span = document.createElement('span');
      let c = '';
      if (f & F_MARKER) c += ' mk';
      if (f & F_BOLD) c += ' b';
      if (f & F_ITALIC) c += ' i';
      if (f & F_UNDERLINE) c += ' u';
      if (f & F_NOTE) c += ' note';
      if (f & F_BONEYARD) c += ' bone';
      if (f & F_LABEL) c += ' lbl';
      if (f & F_ESCAPED) c += ' esc';
      if (ms) c += ' sp';
      if (c) span.className = c.slice(1);
      const node = document.createTextNode(text.slice(k, j));
      span.append(node);
      e.append(span);
      v.segs.push({ node, src: k, len: j - k });
      k = j;
    }
    if (!v.segs.length) {
      const node = document.createTextNode('​');
      const span = document.createElement('span');
      span.className = 'zw';
      span.append(node);
      e.append(span);
      v.zw = node;
    }
    if (snLabel) {
      const [mode, label] = [snLabel.slice(0, snLabel.indexOf(':')), snLabel.slice(snLabel.indexOf(':') + 1)];
      for (const side of mode === 'both' ? ['l', 'r'] : [mode === 'left' ? 'l' : 'r']) {
        const sn = el('span', `sn sn-${side}`, label);
        sn.setAttribute('aria-hidden', 'true');
        e.append(sn);
      }
    }
  }

  // ---------------------------------------------------------------------------------
  // Measuring

  private viewForLine(i: number): LineView | null {
    const line = this.lines[i];
    if (!line) return null;
    const v = this.views.get(line.key);
    return v && v.line === i ? v : null;
  }

  private offsetInScroller(e: HTMLElement): number {
    return e.getBoundingClientRect().top - this.dom.getBoundingClientRect().top + this.dom.scrollTop;
  }

  private domPoint(v: LineView, ch: number, preferBefore = false): { node: Text; offset: number } {
    if (v.zw || !v.segs.length) return { node: v.zw!, offset: 0 };
    // Exact segment containing ch (char after), or the boundary.
    for (let s = 0; s < v.segs.length; s++) {
      const seg = v.segs[s];
      if (ch < seg.src) {
        // ch is inside hidden markers before this segment
        if (preferBefore && s > 0) {
          const prev = v.segs[s - 1];
          return { node: prev.node, offset: prev.len };
        }
        return { node: seg.node, offset: 0 };
      }
      if (ch <= seg.src + seg.len) {
        if (ch === seg.src + seg.len && !preferBefore && s + 1 < v.segs.length && v.segs[s + 1].src === ch) {
          return { node: v.segs[s + 1].node, offset: 0 };
        }
        return { node: seg.node, offset: ch - seg.src };
      }
    }
    const last = v.segs[v.segs.length - 1];
    return { node: last.node, offset: last.len };
  }

  /** Client rect of the caret position, or null if the line is not displayed. */
  coordsAtPos(pos: Pos): { left: number; top: number; bottom: number } | null {
    const v = this.viewForLine(pos.line);
    if (!v) return null;
    const range = document.createRange();
    if (v.zw) {
      range.setStart(v.zw, 0);
      range.setEnd(v.zw, 1);
      const r = range.getClientRects()[0] ?? v.el.getBoundingClientRect();
      return { left: r.left, top: r.top, bottom: r.top + this.settings.lineHeight };
    }
    const { node, offset } = this.domPoint(v, pos.ch);
    const len = node.length;
    let rect: DOMRect | undefined;
    let useRight = false;
    if (offset < len) {
      range.setStart(node, offset);
      range.setEnd(node, offset + 1);
      const rects = range.getClientRects();
      rect = rects[0];
    }
    if (!rect && len > 0) {
      range.setStart(node, Math.max(0, offset - 1));
      range.setEnd(node, Math.max(1, offset));
      const rects = range.getClientRects();
      rect = rects[rects.length - 1];
      useRight = true;
    }
    if (!rect) {
      const r = v.el.getBoundingClientRect();
      return { left: r.left, top: r.top, bottom: r.top + this.settings.lineHeight };
    }
    const top = this.lineTopFor(rect, v.el);
    return { left: useRight ? rect.right : rect.left, top, bottom: top + this.settings.lineHeight };
  }

  /** Snaps a text rect to the line box it belongs to. */
  private lineTopFor(rect: DOMRect, lineEl: HTMLElement): number {
    const lh = this.settings.lineHeight;
    const base = lineEl.getBoundingClientRect().top;
    const mid = (rect.top + rect.bottom) / 2;
    const row = Math.max(0, Math.floor((mid - base) / lh));
    return base + row * lh;
  }

  /** Document position nearest to the client point. */
  posAtCoords(x: number, y: number): Pos | null {
    if (!this.displayed.length) return null;
    const v = this.lineViewAtY(y);
    if (!v) return null;
    const r = v.el.getBoundingClientRect();
    const lh = this.settings.lineHeight;
    const yy = Math.min(Math.max(y, r.top + 1), r.bottom - 1);
    // Constrain x to the text area of the line (padding is part of other elements' indent).
    const cs = getComputedStyle(v.el);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    const xx = Math.min(Math.max(x, r.left + padL + 0.5), r.right - padR - 0.5);
    if (v.zw) return { line: v.line, ch: 0 };
    const hit = caretFromPoint(xx, yy);
    if (hit) {
      const seg = v.segs.find((s) => s.node === hit.node);
      if (seg) {
        let ch = seg.src + Math.min(hit.offset, seg.len);
        // Clicking past the end of a visual row maps to the row end (before a soft wrap space)
        return { line: v.line, ch };
      }
    }
    // Fallback: compare with first/last character rows.
    const row = Math.floor((yy - r.top) / lh);
    const rows = Math.max(1, Math.round(r.height / lh));
    if (row <= 0 && x < r.left + padL + 2) return { line: v.line, ch: this.firstVisibleCh(v) };
    if (row >= rows - 1) return { line: v.line, ch: this.lines[v.line].text.length };
    return { line: v.line, ch: this.firstVisibleCh(v) };
  }

  private firstVisibleCh(v: LineView): number {
    return v.segs.length ? v.segs[0].src : 0;
  }

  private lineViewAtY(y: number): LineView | null {
    const d = this.displayed;
    let lo = 0;
    let hi = d.length - 1;
    let best: LineView | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = this.views.get(this.lines[d[mid]].key)!;
      const r = v.el.getBoundingClientRect();
      if (y < r.top) hi = mid - 1;
      else if (y >= r.bottom) {
        lo = mid + 1;
        best = v;
      } else return v;
    }
    // y is above the first line, below the last line, or in a gap: pick the nearest line.
    if (lo < d.length) {
      const below = this.views.get(this.lines[d[lo]].key)!;
      if (!best) return below;
      const rb = below.el.getBoundingClientRect();
      const ra = best.el.getBoundingClientRect();
      return y - ra.bottom < rb.top - y ? best : below;
    }
    return best;
  }

  // ---------------------------------------------------------------------------------
  // Painting caret, selection and highlights

  private paintSoon() {
    if (this.paintQueued) return;
    this.paintQueued = true;
    requestAnimationFrame(() => {
      this.paintQueued = false;
      this.paint();
    });
  }

  private paint() {
    const colRect = this.column.getBoundingClientRect();
    const scRect = this.dom.getBoundingClientRect();
    const lh = this.settings.lineHeight;
    // Caret
    const empty = selEmpty(this.sel);
    const c = this.coordsAtPos(this.sel.head);
    if (c && (this.focused || this.composing)) {
      this.caretEl.style.display = 'block';
      this.caretEl.style.transform = `translate(${Math.round(c.left - colRect.left)}px, ${Math.round(c.top - colRect.top)}px)`;
      this.caretEl.style.height = `${lh}px`;
      // Restart the blink so the caret is visible right after it moves (no forced reflow).
      if (!this.caretEl.classList.contains('blink')) this.caretEl.classList.add('blink');
      for (const a of this.caretEl.getAnimations()) a.currentTime = 0;
      this.input.style.transform = `translate(${Math.round(c.left - colRect.left)}px, ${Math.round(c.top - colRect.top)}px)`;
    } else {
      this.caretEl.style.display = 'none';
    }
    // Only paint rows near the viewport.
    const viewTop = scRect.top - 400;
    const viewBottom = scRect.bottom + 400;

    // Selection
    const selFrag = document.createDocumentFragment();
    if (!empty) {
      const from = selFrom(this.sel);
      const to = selTo(this.sel);
      for (let i = from.line; i <= to.line; i++) {
        const v = this.viewForLine(i);
        if (!v) continue;
        const lr = v.el.getBoundingClientRect();
        if (lr.bottom < viewTop || lr.top > viewBottom) continue;
        const a = i === from.line ? from.ch : 0;
        const b = i === to.line ? to.ch : this.lines[i].text.length;
        const rects = this.rangeRects(v, a, b);
        const spansNewline = i < to.line;
        if (!rects.length && spansNewline) {
          // Empty or fully hidden line inside the selection: a small mark shows it is included.
          const p = this.coordsAtPos({ line: i, ch: a });
          if (p) rects.push(new DOMRect(p.left, p.top, lh * 0.35, lh));
        } else if (spansNewline && rects.length) {
          const last = rects[rects.length - 1];
          rects[rects.length - 1] = new DOMRect(last.left, last.top, last.width + lh * 0.25, last.height);
        }
        for (const r of rects) selFrag.append(box(r, colRect, 'sel-box'));
      }
    }
    this.selLayer.replaceChildren(selFrag);

    // Search highlights
    const hlFrag = document.createDocumentFragment();
    this.highlights.forEach((h, idx) => {
      const v = this.viewForLine(h.line);
      if (!v) return;
      const lr = v.el.getBoundingClientRect();
      if (lr.bottom < viewTop || lr.top > viewBottom) return;
      for (const r of this.rangeRects(v, h.from, h.to)) hlFrag.append(box(r, colRect, idx === this.currentHighlight ? 'hl-box current' : 'hl-box'));
    });
    this.hlLayer.replaceChildren(hlFrag);

    // Decorations
    const decoFrag = document.createDocumentFragment();
    if (this.decorations.length) {
      const idx = new Map<number, number>();
      for (const d of this.decorations) {
        idx.set(d.a.key, -1);
        idx.set(d.b.key, -1);
      }
      this.lines.forEach((l, i) => idx.has(l.key) && idx.set(l.key, i));
      for (const d of this.decorations) {
        const a = idx.get(d.a.key)!;
        const b = idx.get(d.b.key)!;
        if (a < 0 || b < 0) continue;
        for (let i = a; i <= b; i++) {
          const v = this.viewForLine(i);
          if (!v) continue;
          const lr = v.el.getBoundingClientRect();
          if (lr.bottom < viewTop || lr.top > viewBottom) continue;
          const from = i === a ? d.a.ch : 0;
          const to = i === b ? d.b.ch : this.lines[i].text.length;
          for (const r of this.rangeRects(v, from, to)) decoFrag.append(box(r, colRect, `deco ${d.cls}`));
        }
      }
    }
    this.decoLayer.replaceChildren(decoFrag);

    // Page break markers
    const pbFrag = document.createDocumentFragment();
    if (this.pageMarkers.length && !this.filter) {
      const contentRect = this.content.getBoundingClientRect();
      for (const m of this.pageMarkers) {
        const v = this.views.get(m.key);
        if (!v) continue;
        const r = v.el.getBoundingClientRect();
        if (r.bottom < viewTop || r.top > viewBottom) continue;
        const rows = Math.max(1, Math.round(r.height / lh));
        let y = r.top + Math.round(m.frac * rows) * lh;
        // Between paragraphs the rule sits in the middle of the blank line, not on the text.
        if (m.frac === 0) {
          const prev = v.line > 0 ? this.prevDisplayed(v.line) : null;
          if (prev !== null && this.lines[prev].text.trim() === '') y -= lh / 2;
        }
        const mark = el('div', 'pb-mark');
        mark.style.transform = `translate(${Math.round(contentRect.left - colRect.left)}px, ${Math.round(y - colRect.top)}px)`;
        mark.style.width = `${Math.round(contentRect.width)}px`;
        mark.append(el('span', '', m.label));
        mark.title = `Page ${m.label} starts here`;
        pbFrag.append(mark);
      }
    }
    this.pbLayer.replaceChildren(pbFrag);
  }

  /** Rects of the text between a and b on one line, merged per visual row. */
  private rangeRects(v: LineView, a: number, b: number): DOMRect[] {
    if (a >= b || v.zw) return [];
    const range = document.createRange();
    const start = this.domPoint(v, a);
    const end = this.domPoint(v, b, true);
    try {
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
    } catch {
      return [];
    }
    if (range.collapsed) return [];
    const lh = this.settings.lineHeight;
    const rows = new Map<number, DOMRect>();
    for (const r of Array.from(range.getClientRects())) {
      if (r.width < 0.5) continue;
      const top = this.lineTopFor(r, v.el);
      const prev = rows.get(top);
      if (!prev) rows.set(top, new DOMRect(r.left, top, r.width, lh));
      else {
        const left = Math.min(prev.left, r.left);
        const right = Math.max(prev.right, r.right);
        rows.set(top, new DOMRect(left, top, right - left, lh));
      }
    }
    return [...rows.values()].sort((p, q) => p.top - q.top);
  }

  // ---------------------------------------------------------------------------------
  // Scrolling

  private ensureRectVisible(top: number, bottom: number) {
    const margin = this.settings.lineHeight * 2;
    const st = this.dom.scrollTop;
    const h = this.dom.clientHeight;
    if (top - margin < st) this.dom.scrollTop = Math.max(0, top - margin);
    else if (bottom + margin > st + h) this.dom.scrollTop = bottom + margin - h;
  }

  scrollToCaret(mode: 'nearest' | 'center' | 'top' = 'nearest') {
    const c = this.coordsAtPos(this.sel.head);
    if (!c) return;
    const base = this.dom.getBoundingClientRect().top - this.dom.scrollTop;
    const top = c.top - base;
    if (this.settings.typewriter && this.focused) {
      this.dom.scrollTop = Math.max(0, top - this.dom.clientHeight * 0.45);
    } else if (mode === 'center') this.dom.scrollTop = Math.max(0, top - this.dom.clientHeight / 2);
    else if (mode === 'top') this.dom.scrollTop = Math.max(0, top - this.settings.lineHeight);
    else this.ensureRectVisible(top, top + this.settings.lineHeight);
    this.paintSoon();
  }

  // ---------------------------------------------------------------------------------
  // Input handling

  private bind() {
    const inp = this.input;
    inp.addEventListener('focus', () => {
      this.focused = true;
      if (inp.value) inp.select();
      this.dom.classList.add('ed-focused');
      if (this.renderedActive !== this.activeLine()) this.renderKeepingCaret();
      this.paint();
      this.hooks.onFocusChange?.(true);
    });
    inp.addEventListener('blur', () => {
      this.focused = false;
      this.dom.classList.remove('ed-focused');
      this.endDrag();
      if (!this.composing && this.renderedActive !== this.activeLine()) this.renderKeepingCaret();
      this.paint();
      this.hooks.onFocusChange?.(false);
    });
    inp.addEventListener('keydown', (e) => this.onKeyDown(e));
    inp.addEventListener('input', (e) => this.onInput(e as InputEvent));
    inp.addEventListener('compositionstart', () => {
      this.composing = true;
      inp.value = '';
      inp.classList.add('composing');
    });
    inp.addEventListener('compositionend', (e) => {
      this.composing = false;
      inp.classList.remove('composing');
      const data = (e as CompositionEvent).data;
      inp.value = '';
      if (data) this.insertText(data, 'type');
      else this.syncInput();
    });
    inp.addEventListener('copy', (e) => {
      if (selEmpty(this.sel)) return;
      e.preventDefault();
      e.clipboardData?.setData('text/plain', this.selectedText());
    });
    inp.addEventListener('cut', (e) => {
      if (selEmpty(this.sel)) return;
      e.preventDefault();
      e.clipboardData?.setData('text/plain', this.selectedText());
      this.replaceSelection('', 'other');
    });
    inp.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = e.clipboardData?.getData('text/plain');
      if (text) this.paste(text);
    });

    this.dom.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.dom.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const pos = this.posAtCoords(e.clientX, e.clientY);
      if (pos) {
        const inSel = !selEmpty(this.sel) && cmpPos(pos, selFrom(this.sel)) >= 0 && cmpPos(pos, selTo(this.sel)) <= 0;
        if (!inSel) this.setSelection(cursor(pos), { scroll: false });
      }
      this.focus();
      this.hooks.onContextMenu?.(e, pos);
    });
    this.dom.addEventListener('scroll', () => {
      this.paintSoon();
      this.hooks.onScroll?.();
    });
    new ResizeObserver(() => this.paintSoon()).observe(this.dom);
  }

  /** Re-render when only the active line changes, keeping the caret's screen position. */
  private renderKeepingCaret() {
    this.reparse();
    this.render();
  }

  paste(text: string) {
    this.insertText(text.replace(/\r\n?/g, '\n'), 'other');
    this.history.seal();
  }

  private syncInput() {
    if (this.composing) return;
    const inp = this.input;
    if (!selEmpty(this.sel)) {
      const t = this.selectedText();
      inp.value = t.length <= 20000 ? t : ' ';
      // select() would also take focus away from a find field; selecting on focus covers that case.
      if (document.activeElement === inp) inp.select();
    } else if (inp.value) {
      inp.value = '';
    }
  }

  private onInput(e: InputEvent) {
    if (this.composing || e.isComposing) return;
    const inp = this.input;
    if (e.inputType && e.inputType.startsWith('insert') && e.data != null && e.inputType !== 'insertFromPaste') {
      inp.value = '';
      this.insertText(e.data, 'type');
      return;
    }
    if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') {
      inp.value = '';
      this.newline();
      return;
    }
    // Anything else changed the textarea in a way we didn't expect: restore it.
    this.syncInput();
  }

  private onKeyDown(e: KeyboardEvent) {
    if (this.composing || e.isComposing || e.keyCode === 229) return;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const shift = e.shiftKey;
    const alt = e.altKey;
    const key = e.key;
    let handled = true;
    switch (key) {
      case 'ArrowLeft':
      case 'ArrowRight': {
        const dir = key === 'ArrowLeft' ? -1 : 1;
        if (isMac && e.metaKey) this.moveLineEdge(dir, shift);
        else if ((isMac && alt) || (!isMac && e.ctrlKey)) this.moveWord(dir, shift);
        else this.moveChar(dir, shift);
        break;
      }
      case 'ArrowUp':
      case 'ArrowDown': {
        const dir = key === 'ArrowUp' ? -1 : 1;
        if (isMac && e.metaKey) this.moveDocEdge(dir, shift);
        else this.moveVertical(dir, shift);
        break;
      }
      case 'Home':
      case 'End': {
        const dir = key === 'Home' ? -1 : 1;
        if (e.ctrlKey || e.metaKey) this.moveDocEdge(dir, shift);
        else this.moveLineEdge(dir, shift);
        break;
      }
      case 'PageUp':
      case 'PageDown':
        this.movePage(key === 'PageUp' ? -1 : 1, shift);
        break;
      case 'Backspace':
        if (isMac && e.metaKey) this.deleteToLineEdge(-1);
        else if ((isMac && alt) || (!isMac && e.ctrlKey)) this.deleteWord(-1);
        else this.deleteChar(-1);
        break;
      case 'Delete':
        if ((isMac && alt) || (!isMac && e.ctrlKey)) this.deleteWord(1);
        else this.deleteChar(1);
        break;
      case 'Enter':
        if (mod || alt) {
          handled = false;
          break;
        }
        this.newline();
        break;
      case 'Tab':
        // Tab is reserved for view switching (handled by the command system).
        break;
      default:
        handled = false;
        if (mod && !alt && !this.editKeysFromMenu) {
          const k = key.toLowerCase();
          if (k === 'z' && !shift) {
            this.history.seal();
            this.undo();
            handled = true;
          } else if ((k === 'z' && shift) || (k === 'y' && !isMac)) {
            this.redo();
            handled = true;
          } else if (k === 'a') {
            this.selectAll();
            handled = true;
          }
        }
    }
    if (handled) {
      e.preventDefault();
    }
  }

  // ---------------------------------------------------------------------------------
  // Commands: movement

  private moveTo(pos: Pos, extend: boolean, keepGoal = false) {
    const sel = extend ? { anchor: this.sel.anchor, head: pos } : cursor(pos);
    this.history.seal();
    this.setSelection(sel, { keepGoal });
  }

  private moveChar(dir: number, extend: boolean) {
    if (!extend && !selEmpty(this.sel)) {
      this.moveTo(dir < 0 ? selFrom(this.sel) : selTo(this.sel), false);
      return;
    }
    const h = this.sel.head;
    const text = this.lines[h.line].text;
    if (dir < 0) {
      if (h.ch > 0) this.moveTo({ line: h.line, ch: prevCh(text, h.ch) }, extend);
      else {
        const p = this.prevDisplayed(h.line);
        if (p !== null) this.moveTo({ line: p, ch: this.lines[p].text.length }, extend);
      }
    } else {
      if (h.ch < text.length) this.moveTo({ line: h.line, ch: nextCh(text, h.ch) }, extend);
      else {
        const n = this.nextDisplayed(h.line);
        if (n !== null) this.moveTo({ line: n, ch: 0 }, extend);
      }
    }
  }

  private moveWord(dir: number, extend: boolean) {
    const h = this.sel.head;
    const text = this.lines[h.line].text;
    if (dir < 0) {
      if (h.ch === 0) return this.moveChar(-1, extend);
      this.moveTo({ line: h.line, ch: wordLeft(text, h.ch) }, extend);
    } else {
      if (h.ch === text.length) return this.moveChar(1, extend);
      this.moveTo({ line: h.line, ch: wordRight(text, h.ch) }, extend);
    }
  }

  private prevDisplayed(line: number): number | null {
    const k = this.displayedPos.get(line);
    if (k === undefined || k === 0) return null;
    return this.displayed[k - 1];
  }

  private nextDisplayed(line: number): number | null {
    const k = this.displayedPos.get(line);
    if (k === undefined || k >= this.displayed.length - 1) return null;
    return this.displayed[k + 1];
  }

  private moveLineEdge(dir: number, extend: boolean) {
    const h = this.sel.head;
    const c = this.coordsAtPos(h);
    const v = this.viewForLine(h.line);
    if (!c || !v) return;
    const r = v.el.getBoundingClientRect();
    const y = (c.top + c.bottom) / 2;
    let pos = this.posAtCoords(dir < 0 ? r.left - 1000 : r.right + 1000, y);
    if (!pos) return;
    if (dir > 0) {
      // At a soft wrap the row end sits before the wrapping space.
      const text = this.lines[h.line].text;
      if (pos.ch < text.length && text[pos.ch - 1] === ' ' && pos.ch > h.ch) pos = { line: h.line, ch: pos.ch - 1 };
      if (pos.ch < h.ch) pos = { line: h.line, ch: text.length };
    }
    if (dir < 0 && pos.ch === h.ch && h.ch > 0) pos = { line: h.line, ch: 0 };
    this.moveTo(pos, extend);
  }

  private moveDocEdge(dir: number, extend: boolean) {
    if (!this.displayed.length) return;
    const line = dir < 0 ? this.displayed[0] : this.displayed[this.displayed.length - 1];
    this.moveTo({ line, ch: dir < 0 ? 0 : this.lines[line].text.length }, extend);
  }

  private moveVertical(dir: number, extend: boolean) {
    const h = this.sel.head;
    const c = this.coordsAtPos(h);
    if (!c) return;
    if (this.goalX === null) this.goalX = c.left;
    const lh = this.settings.lineHeight;
    const y = dir < 0 ? c.top - lh / 2 : c.bottom + lh / 2;
    const v = this.viewForLine(h.line)!;
    const vr = v.el.getBoundingClientRect();
    let target: Pos | null;
    if (y >= vr.top && y < vr.bottom) {
      target = this.posAtCoords(this.goalX, y);
    } else {
      const nl = dir < 0 ? this.prevDisplayed(h.line) : this.nextDisplayed(h.line);
      if (nl === null) {
        target = dir < 0 ? { line: h.line, ch: 0 } : { line: h.line, ch: this.lines[h.line].text.length };
      } else {
        const nv = this.viewForLine(nl)!;
        const nr = nv.el.getBoundingClientRect();
        const ty = dir < 0 ? nr.bottom - lh / 2 : nr.top + lh / 2;
        target = this.posAtCoords(this.goalX, ty);
      }
    }
    if (!target) return;
    this.moveTo(target, extend, true);
  }

  private movePage(dir: number, extend: boolean) {
    const c = this.coordsAtPos(this.sel.head);
    if (!c) return;
    const h = this.dom.clientHeight - this.settings.lineHeight * 2;
    if (this.goalX === null) this.goalX = c.left;
    this.dom.scrollTop += dir * h;
    const target = this.posAtCoords(this.goalX, c.top + dir * h + 2);
    if (target) this.moveTo(target, extend, true);
  }

  // ---------------------------------------------------------------------------------
  // Commands: editing

  newline() {
    const h = selFrom(this.sel);
    const p = this.parsed.lines[h.line];
    const text = this.lines[h.line].text;
    // Optional extra blank line after a scene heading (at the end of the heading only).
    if (selEmpty(this.sel) && p?.type === 'heading' && h.ch === text.length && this.settings.blankAfterHeading) {
      const next = this.lines[h.line + 1];
      if (!next || next.text.trim() !== '') {
        this.history.seal();
        this.insertText('\n\n', 'enter');
        this.history.seal();
        return;
      }
    }
    this.history.seal();
    this.insertText('\n', 'enter');
    this.history.seal();
  }

  private deleteChar(dir: number) {
    if (!selEmpty(this.sel)) {
      this.replaceSelection('', 'delete');
      return;
    }
    const h = this.sel.head;
    const text = this.lines[h.line].text;
    if (dir < 0) {
      if (h.ch > 0) {
        this.replaceRange({ line: h.line, ch: prevCh(text, h.ch) }, h, '', 'delete', 'input');
        return;
      }
      if (h.line === 0) return;
      // Never merge into a hidden line.
      if (!this.isVisibleLine(h.line - 1)) return;
      this.replaceRange({ line: h.line - 1, ch: this.lines[h.line - 1].text.length }, h, '', 'delete', 'input');
    } else {
      if (h.ch < text.length) {
        this.replaceRange(h, { line: h.line, ch: nextCh(text, h.ch) }, '', 'delete', 'input', cursor(h));
        return;
      }
      if (h.line >= this.lines.length - 1) return;
      if (!this.isVisibleLine(h.line + 1)) return;
      this.replaceRange(h, { line: h.line + 1, ch: 0 }, '', 'delete', 'input', cursor(h));
    }
  }

  private deleteWord(dir: number) {
    if (!selEmpty(this.sel)) return this.replaceSelection('', 'delete');
    const h = this.sel.head;
    const text = this.lines[h.line].text;
    if (dir < 0) {
      if (h.ch === 0) return this.deleteChar(-1);
      this.history.seal();
      this.replaceRange({ line: h.line, ch: wordLeft(text, h.ch) }, h, '', 'other', 'input');
    } else {
      if (h.ch === text.length) return this.deleteChar(1);
      this.history.seal();
      this.replaceRange(h, { line: h.line, ch: wordRight(text, h.ch) }, '', 'other', 'input', cursor(h));
    }
  }

  private deleteToLineEdge(dir: number) {
    if (!selEmpty(this.sel)) return this.replaceSelection('', 'delete');
    const h = this.sel.head;
    if (dir < 0) {
      if (h.ch === 0) return this.deleteChar(-1);
      this.history.seal();
      this.replaceRange({ line: h.line, ch: 0 }, h, '', 'other', 'input');
    }
  }

  // ---------------------------------------------------------------------------------
  // Mouse

  private onMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    // Clicks on the scrollbar are left alone.
    if (e.target === this.dom && e.offsetX > this.dom.clientWidth) return;
    e.preventDefault();
    this.focus();
    let pos = this.posAtCoords(e.clientX, e.clientY);
    if (!pos) return;
    const mod = /Mac/.test(navigator.platform) ? e.metaKey : e.ctrlKey;
    if (mod && e.detail === 1 && !e.shiftKey && !e.altKey && this.hooks.onModClick?.(e, pos)) return;
    const now = Date.now();
    // A double/triple click reuses the position resolved by the first click, because
    // revealing syntax after that click may have moved the text under the pointer.
    if (e.detail > 1 && this.lastClick && Math.abs(this.lastClick.x - e.clientX) < 5 && Math.abs(this.lastClick.y - e.clientY) < 5 && now - this.lastClick.time < 800) {
      pos = this.lastClick.pos;
    } else {
      this.lastClick = { x: e.clientX, y: e.clientY, time: now, pos };
    }
    this.lastClick.time = now;
    this.history.seal();
    if (e.detail === 2) {
      const [a, b] = wordAt(this.lines[pos.line].text, pos.ch);
      const from = { line: pos.line, ch: a };
      const to = { line: pos.line, ch: b };
      this.drag = { x: e.clientX, y: e.clientY, moved: true, mode: 'word', anchorFrom: from, anchorTo: to };
      this.setSelection({ anchor: from, head: to }, { scroll: false });
    } else if (e.detail >= 3) {
      // A triple click selects the line's text only, never the line break after it.
      const from = { line: pos.line, ch: 0 };
      const to = { line: pos.line, ch: this.lines[pos.line].text.length };
      this.drag = { x: e.clientX, y: e.clientY, moved: true, mode: 'line', anchorFrom: from, anchorTo: to };
      this.setSelection({ anchor: from, head: to }, { scroll: false });
    } else {
      if (e.shiftKey) this.setSelection({ anchor: this.sel.anchor, head: pos }, { scroll: false });
      else this.setSelection(cursor(pos), { scroll: false });
      this.drag = { x: e.clientX, y: e.clientY, moved: false, mode: 'char', anchorFrom: this.sel.anchor, anchorTo: this.sel.anchor };
    }
    const move = (ev: MouseEvent) => this.onDragMove(ev);
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      this.endDrag();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  private onDragMove(e: MouseEvent) {
    const d = this.drag;
    if (!d) return;
    if (!d.moved) {
      if (Math.abs(e.clientX - d.x) < 4 && Math.abs(e.clientY - d.y) < 4) return;
      d.moved = true;
    }
    this.extendDragTo(e.clientX, e.clientY);
    // Auto-scroll near the edges
    const r = this.dom.getBoundingClientRect();
    const edge = 24;
    let speed = 0;
    if (e.clientY < r.top + edge) speed = -Math.ceil((r.top + edge - e.clientY) / 3);
    else if (e.clientY > r.bottom - edge) speed = Math.ceil((e.clientY - (r.bottom - edge)) / 3);
    if (this.autoScroll !== null) {
      cancelAnimationFrame(this.autoScroll);
      this.autoScroll = null;
    }
    if (speed) {
      const x = e.clientX;
      const y = e.clientY;
      const step = () => {
        this.dom.scrollTop += speed;
        this.extendDragTo(x, y);
        this.autoScroll = requestAnimationFrame(step);
      };
      this.autoScroll = requestAnimationFrame(step);
    }
  }

  private extendDragTo(x: number, y: number) {
    const d = this.drag;
    if (!d) return;
    const pos = this.posAtCoords(x, y);
    if (!pos) return;
    if (d.mode === 'char') {
      this.setSelection({ anchor: d.anchorFrom, head: pos }, { scroll: false });
    } else if (d.mode === 'word') {
      const [a, b] = wordAt(this.lines[pos.line].text, pos.ch);
      if (cmpPos(pos, d.anchorFrom) < 0) this.setSelection({ anchor: d.anchorTo, head: { line: pos.line, ch: a } }, { scroll: false });
      else this.setSelection({ anchor: d.anchorFrom, head: maxPos({ line: pos.line, ch: b }, d.anchorTo) }, { scroll: false });
    } else {
      if (cmpPos(pos, d.anchorFrom) < 0) this.setSelection({ anchor: d.anchorTo, head: { line: pos.line, ch: 0 } }, { scroll: false });
      else this.setSelection({ anchor: d.anchorFrom, head: { line: pos.line, ch: this.lines[pos.line].text.length } }, { scroll: false });
    }
  }

  private endDrag() {
    this.drag = null;
    if (this.autoScroll !== null) {
      cancelAnimationFrame(this.autoScroll);
      this.autoScroll = null;
    }
  }

  // Utilities used by the app ---------------------------------------------------------

  wordAtPos(pos: Pos): { from: Pos; to: Pos; text: string } {
    const text = this.lines[pos.line].text;
    const [a, b] = wordAt(text, pos.ch);
    return { from: { line: pos.line, ch: a }, to: { line: pos.line, ch: b }, text: text.slice(a, b) };
  }

  isWordCharAt(pos: Pos) {
    return isWordChar(this.lines[pos.line]?.text[pos.ch]);
  }

  /** Forces a re-render (e.g. after the spell dictionary changed). */
  refresh() {
    for (const v of this.views.values()) v.sig = '';
    this.render();
  }

  eqSel(a: Selection, b: Selection) {
    return eqPos(a.anchor, b.anchor) && eqPos(a.head, b.head);
  }

  minPos = minPos;
}

function sameRender(prev: LineView['prev'], text: string, p: ParsedLine, active: boolean, miss: string, sn: string): boolean {
  if (!prev) return false;
  const q = prev.p;
  if (prev.text !== text || prev.active !== active || prev.miss !== miss || prev.sn !== sn) return false;
  if (q.type !== p.type || q.dual !== p.dual || q.level !== p.level || q.inDialogue !== p.inDialogue || q.sceneNumber !== p.sceneNumber) return false;
  const a = q.flags;
  const b = p.flags;
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false;
  return true;
}

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function box(r: DOMRect, base: DOMRect, cls: string): HTMLElement {
  const b = document.createElement('div');
  b.className = cls;
  b.style.transform = `translate(${Math.round(r.left - base.left)}px, ${Math.round(r.top - base.top)}px)`;
  b.style.width = `${Math.max(1, Math.round(r.width))}px`;
  b.style.height = `${Math.round(r.height)}px`;
  return b;
}

function caretFromPoint(x: number, y: number): { node: Node; offset: number } | null {
  const d = document as any;
  if (d.caretPositionFromPoint) {
    const p = d.caretPositionFromPoint(x, y);
    if (p) return { node: p.offsetNode, offset: p.offset };
  }
  if (d.caretRangeFromPoint) {
    const r = d.caretRangeFromPoint(x, y);
    if (r) return { node: r.startContainer, offset: r.startOffset };
  }
  return null;
}

export class Transaction {
  steps: Step[] = [];
  constructor(readonly lines: Line[]) {}

  replace(from: Pos, to: Pos, text: string) {
    const st = replaceStep(this.lines, from, to, text);
    applyStep(this.lines, st);
    this.steps.push(st);
    return st;
  }

  /** Replaces the text of a whole line, keeping its key. */
  setLine(i: number, text: string) {
    if (this.lines[i].text === text) return;
    const st: Step = { at: i, removed: [this.lines[i]], inserted: [{ key: this.lines[i].key, text }] };
    applyStep(this.lines, st);
    this.steps.push(st);
  }

  /** Removes whole lines and returns them (keys preserved for re-insertion). */
  removeLines(at: number, count: number): Line[] {
    const removed = this.lines.slice(at, at + count);
    const st: Step = { at, removed, inserted: [] };
    applyStep(this.lines, st);
    this.steps.push(st);
    return removed;
  }

  insertLines(at: number, lines: Line[]) {
    const st: Step = { at, removed: [], inserted: lines };
    applyStep(this.lines, st);
    this.steps.push(st);
  }

  /** Replaces all lines (used for restoring a draft); keeps keys of identical lines in place. */
  replaceAll(lines: Line[]) {
    const st: Step = { at: 0, removed: this.lines.slice(), inserted: lines };
    applyStep(this.lines, st);
    this.steps.push(st);
  }
}
