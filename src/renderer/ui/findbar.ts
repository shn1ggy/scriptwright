// Find & Replace within the screenplay. Results are listed with their scene and can be
// walked with the keyboard. Replacing is a normal edit: one undo step per Replace or
// Replace All, and comments/highlights follow the text as with typing.

import type { App } from '../app';
import { h, icon, iconButton } from './dom';
import { pushEscape, toast } from './overlay';
import { cursor } from '../../shared/doc';
import { buildPattern, findMatches, replacementFor, FindMatch, FindOptions } from '../../shared/findreplace';

const LIST_LIMIT = 5000;

export class FindBar {
  el: HTMLElement;
  private input: HTMLInputElement;
  private replaceInput: HTMLInputElement;
  private replaceRow: HTMLElement;
  private toggleBtn: HTMLButtonElement;
  private count: HTMLElement;
  private results: HTMLElement;
  private optBtns: Record<'caseSensitive' | 'wholeWord' | 'regex' | 'preserveCase', HTMLButtonElement>;
  private matches: FindMatch[] = [];
  private re: RegExp | null = null;
  private error = '';
  private current = -1;
  private opts: FindOptions = { caseSensitive: false, wholeWord: false, regex: false, preserveCase: true };
  private popEsc: (() => void) | null = null;
  private recomputeTimer: any = null;
  private dirty = false;

  constructor(private app: App) {
    this.input = h('input', { class: 'field', placeholder: 'Find', 'aria-label': 'Find in screenplay', spellcheck: 'false' });
    this.input.dataset.esc = 'self';
    this.input.addEventListener('input', () => {
      this.compute();
      this.current = this.matches.length ? this.nearestIndex() : -1;
      this.show(false);
    });
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.replaceInput = h('input', { class: 'field', placeholder: 'Replace with', 'aria-label': 'Replace with', spellcheck: 'false' });
    this.replaceInput.dataset.esc = 'self';
    this.replaceInput.addEventListener('keydown', (e) => this.onReplaceKey(e));
    this.replaceInput.addEventListener('input', () => this.renderResults());

    this.count = h('span', { class: 'dim findbar-count' });
    const opt = (key: keyof FindBar['optBtns'], label: string, title: string) => {
      const b = h('button', { class: `icon-btn findbar-opt${this.opts[key] ? ' on' : ''}`, title, 'aria-label': title, 'aria-pressed': String(this.opts[key]), tabindex: '-1', onclick: () => this.toggleOpt(key) }, label);
      b.addEventListener('mousedown', (e) => e.preventDefault());
      return b;
    };
    this.optBtns = {
      caseSensitive: opt('caseSensitive', 'Aa', 'Match case'),
      wholeWord: opt('wholeWord', 'W', 'Whole words only'),
      regex: opt('regex', '.*', 'Regular expression ($1 etc. in the replacement)'),
      preserveCase: opt('preserveCase', 'AB', 'Preserve case: ANDREA → MARIA, Andrea → Maria (when not matching case)'),
    };
    this.toggleBtn = h('button', { class: 'icon-btn findbar-toggle', title: 'Toggle Replace (Mod+Alt+F)', 'aria-label': 'Toggle Replace', 'aria-expanded': 'false', tabindex: '-1', onclick: () => this.setReplaceVisible(this.replaceRow.classList.contains('hidden'), true) }, icon('chevronRight'));
    this.results = h('div', { class: 'list findbar-results', role: 'listbox' });

    const replaceOne = h('button', { class: 'btn sm', title: 'Replace this result (Enter)', onclick: () => this.replaceCurrent() }, 'Replace');
    const replaceAll = h('button', { class: 'btn sm', title: 'Replace all results (Mod+Enter)', onclick: () => this.replaceAll() }, 'All');
    for (const b of [replaceOne, replaceAll]) b.addEventListener('mousedown', (e) => e.preventDefault());
    this.replaceRow = h('div', { class: 'findbar-row hidden' }, this.replaceInput, this.optBtns.preserveCase, replaceOne, replaceAll);

    this.el = h(
      'div',
      { class: 'findbar floating hidden' },
      h(
        'div',
        { class: 'findbar-main' },
        this.toggleBtn,
        h(
          'div',
          { class: 'findbar-rows' },
          h(
            'div',
            { class: 'findbar-row' },
            this.input,
            this.count,
            this.optBtns.caseSensitive,
            this.optBtns.wholeWord,
            this.optBtns.regex,
            iconButton('up', 'Previous result (Shift+Enter)', () => this.step(-1)),
            iconButton('down', 'Next result (Enter)', () => this.step(1)),
            iconButton('close', 'Close (Esc)', () => this.close(true)),
          ),
          this.replaceRow,
        ),
      ),
      this.results,
    );
  }

  hasQuery() {
    return !this.el.classList.contains('hidden') && !!this.input.value;
  }

  get replaceVisible() {
    return !this.replaceRow.classList.contains('hidden');
  }

  open(withReplace = false) {
    const wasHidden = this.el.classList.contains('hidden');
    this.el.classList.remove('hidden');
    const selected = this.app.editor.selectedText();
    if (selected && !selected.includes('\n') && selected.length < 80) this.input.value = this.opts.regex ? selected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : selected;
    if (withReplace) this.setReplaceVisible(true, false);
    else if (wasHidden) this.setReplaceVisible(false, false);
    const target = withReplace && this.input.value ? this.replaceInput : this.input;
    target.focus();
    target.select();
    if (!this.popEsc) this.popEsc = pushEscape(() => this.close(true), false);
    this.compute();
    this.current = this.matches.length ? this.nearestIndex() : -1;
    this.show(false);
  }

  private setReplaceVisible(on: boolean, focus: boolean) {
    this.replaceRow.classList.toggle('hidden', !on);
    this.toggleBtn.classList.toggle('open', on);
    this.toggleBtn.setAttribute('aria-expanded', String(on));
    if (focus) (on ? this.replaceInput : this.input).focus();
  }

  close(focusEditor: boolean) {
    if (this.el.classList.contains('hidden')) return;
    this.el.classList.add('hidden');
    this.popEsc?.();
    this.popEsc = null;
    this.app.editor.setHighlights([]);
    if (focusEditor) this.app.editor.focus();
  }

  private toggleOpt(key: keyof FindBar['optBtns']) {
    this.opts[key] = !this.opts[key];
    const b = this.optBtns[key];
    b.classList.toggle('on', this.opts[key]);
    b.setAttribute('aria-pressed', String(this.opts[key]));
    this.compute();
    this.current = this.matches.length ? this.nearestIndex() : -1;
    this.show(false);
    if (key !== 'preserveCase') this.input.focus();
  }

  onDocChange() {
    if (this.el.classList.contains('hidden') || !this.input.value) return;
    this.dirty = true;
    clearTimeout(this.recomputeTimer);
    this.recomputeTimer = setTimeout(() => {
      this.compute();
      if (this.current >= this.matches.length) this.current = this.matches.length - 1;
      this.show(false);
    }, 150);
  }

  /** Lines a search may touch: in Dialogue view only the lines on screen. */
  private includeFn(): ((i: number) => boolean) | undefined {
    if (this.app.view !== 'dialogue') return undefined;
    const visible = new Set(this.app.editor.displayedLines);
    return (i) => visible.has(i);
  }

  private compute(limit = LIST_LIMIT + 1) {
    clearTimeout(this.recomputeTimer);
    this.dirty = false;
    this.matches = [];
    this.error = '';
    this.re = null;
    const q = this.input.value;
    if (!q) return;
    const re = buildPattern(q, this.opts);
    if (typeof re === 'string') {
      this.error = re;
      return;
    }
    this.re = re;
    this.matches = findMatches(this.app.editor.lines, re, this.includeFn(), limit);
  }

  private nearestIndex(): number {
    const head = this.app.editor.sel.head;
    const i = this.matches.findIndex((m) => m.line > head.line || (m.line === head.line && m.from >= head.ch));
    return i < 0 ? 0 : i;
  }

  step(dir: number) {
    if (this.el.classList.contains('hidden')) {
      this.open();
      return;
    }
    if (this.dirty) this.compute();
    if (!this.matches.length) return;
    this.current = (this.current + dir + this.matches.length) % this.matches.length;
    this.show(true);
  }

  /** Replaces the current result and moves on to the next one. */
  replaceCurrent() {
    if (this.dirty) this.compute();
    if (!this.re || !this.matches.length) return;
    // If the caret is not on a result yet, the first press only selects the nearest one.
    const sel = this.app.editor.sel;
    let k = this.current < 0 ? this.nearestIndex() : this.current;
    const m = this.matches[k];
    const onIt = sel.anchor.line === m.line && sel.head.line === m.line && Math.min(sel.anchor.ch, sel.head.ch) === m.from && Math.max(sel.anchor.ch, sel.head.ch) === m.to;
    if (!onIt) {
      this.current = k;
      this.show(true);
      return;
    }
    const text = this.app.editor.lines[m.line].text;
    const repl = replacementFor(text, m, this.re, this.replaceInput.value, this.opts);
    const end = { line: m.line, ch: m.from + repl.length };
    this.app.editor.edit((tx) => {
      tx.replace({ line: m.line, ch: m.from }, { line: m.line, ch: m.to }, repl);
      return cursor(end);
    });
    this.compute();
    if (!this.matches.length) {
      this.current = -1;
      this.show(false);
      return;
    }
    // Continue after the inserted text so a replacement containing the query is not hit again.
    k = this.matches.findIndex((x) => x.line > end.line || (x.line === end.line && x.from >= end.ch));
    this.current = k < 0 ? 0 : k;
    this.show(true);
  }

  /** Replaces every result as one undoable change. */
  replaceAll() {
    this.compute(Infinity);
    const re = this.re;
    const ms = this.matches;
    if (!re || !ms.length) return;
    const repl = this.replaceInput.value;
    const L = this.app.editor.lines;
    const lineSet = new Set(ms.map((m) => m.line));
    const scenes = new Set<string>();
    for (const i of lineSet) {
      const sc = this.app.sceneAt(i);
      if (sc) scenes.add(sc.id);
    }
    // One step per result, last first, so earlier positions stay valid and comments or
    // highlights around each result move exactly as they would with typing.
    const head = this.app.editor.sel.head;
    // Replacements are worked out on the original text before anything changes.
    const reps = ms.map((m) => replacementFor(L[m.line].text, m, re, repl, this.opts));
    this.app.editor.edit((tx) => {
      for (let k = ms.length - 1; k >= 0; k--) {
        const m = ms[k];
        if (reps[k] !== L[m.line].text.slice(m.from, m.to)) tx.replace({ line: m.line, ch: m.from }, { line: m.line, ch: m.to }, reps[k]);
      }
      return cursor({ line: head.line, ch: Math.min(head.ch, L[head.line]?.text.length ?? 0) });
    });
    const n = ms.length;
    this.compute();
    this.current = this.matches.length ? this.nearestIndex() : -1;
    this.show(false);
    const where = this.app.view === 'dialogue' ? ' in this dialogue view' : scenes.size > 1 ? ` in ${scenes.size} scenes` : '';
    toast(`Replaced ${n} occurrence${n === 1 ? '' : 's'}${where}.`, {
      actions: [
        {
          label: 'Undo',
          run: () => {
            this.app.editor.history.seal();
            this.app.editor.undo();
          },
        },
      ],
    });
  }

  /** Updates highlights, the counter and the result list; optionally moves to the current match. */
  private show(go: boolean) {
    const n = this.matches.length;
    this.count.textContent = this.error ? this.error : this.input.value ? (n ? `${this.current + 1} of ${n > LIST_LIMIT ? LIST_LIMIT + '+' : n}` : 'No results') : '';
    this.count.classList.toggle('warn', !!this.error);
    this.renderResults();
    if (go && this.current >= 0) this.goTo(this.current, false);
    this.app.editor.setHighlights(this.matches, this.current);
  }

  private renderResults() {
    this.results.textContent = '';
    if (!this.input.value || !this.matches.length) {
      this.results.classList.add('hidden');
      return;
    }
    this.results.classList.remove('hidden');
    const L = this.app.editor.lines;
    const showRepl = this.replaceVisible && this.re;
    const max = Math.min(this.matches.length, 300);
    for (let k = 0; k < max; k++) {
      const m = this.matches[k];
      const sc = this.app.sceneAt(m.line);
      const text = L[m.line]?.text ?? '';
      const a = Math.max(0, m.from - 24);
      const found = text.slice(m.from, m.to);
      const parts: (Node | string)[] = [(a > 0 ? '…' : '') + text.slice(a, m.from)];
      if (showRepl) {
        parts.push(h('s', { class: 'findbar-old' }, found), h('strong', { class: 'findbar-new' }, replacementFor(text, m, this.re!, this.replaceInput.value, this.opts)));
      } else parts.push(h('strong', { style: { color: 'var(--text)' } }, found));
      parts.push(text.slice(m.to, m.to + 40));
      const row = h(
        'div',
        { class: `row${k === this.current ? ' selected' : ''}`, role: 'option' },
        h('span', { class: 'num', style: { width: '34px' }, title: sc?.heading }, sc ? (sc.kind === 'scene' ? `Sc ${sc.order}` : sc.kind === 'title' ? 'Title' : 'Open') : ''),
        h('span', { class: 'label' }, ...parts),
      );
      row.addEventListener('mousedown', (e) => e.preventDefault());
      row.addEventListener('click', () => {
        this.current = k;
        this.show(false);
        this.goTo(k, !this.replaceVisible);
      });
      this.results.append(row);
    }
    this.results.querySelector('.row.selected')?.scrollIntoView({ block: 'nearest' });
  }

  private goTo(k: number, focusEditor: boolean) {
    const m = this.matches[k];
    if (!m) return;
    const app = this.app;
    if (app.view === 'scene') {
      const item = app.sceneAt(m.line);
      const f = app.focusedItem();
      if (item && (!f || f.id !== item.id || !app.editor.isVisibleLine(m.line))) app.enterScene(item, { caret: { line: m.line, ch: m.from } });
    }
    app.editor.setSelection({ anchor: { line: m.line, ch: m.from }, head: { line: m.line, ch: m.to } }, { scroll: 'center' });
    app.editor.setHighlights(this.matches, this.current);
    if (focusEditor) {
      this.close(false);
      app.editor.focus();
    }
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) {
        if (this.current >= 0) this.goTo(this.current, true);
        return;
      }
      this.step(e.shiftKey ? -1 : 1);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this.step(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close(true);
    }
  }

  private onReplaceKey(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) this.replaceAll();
      else if (e.shiftKey) this.step(-1);
      else this.replaceCurrent();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this.step(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close(true);
    }
  }
}
