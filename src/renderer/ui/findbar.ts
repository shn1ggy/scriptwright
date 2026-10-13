// Search within the screenplay. Results are listed with their scene and can be walked
// with the keyboard; nothing in the text is modified.

import type { App } from '../app';
import { h, iconButton } from './dom';
import { pushEscape } from './overlay';
import { cursor } from '../../shared/doc';
import { escapeRegex } from '../../shared/fountain';

interface Match {
  line: number;
  from: number;
  to: number;
}

export class FindBar {
  el: HTMLElement;
  private input: HTMLInputElement;
  private count: HTMLElement;
  private results: HTMLElement;
  private caseBtn: HTMLButtonElement;
  private matches: Match[] = [];
  private current = -1;
  private caseSensitive = false;
  private popEsc: (() => void) | null = null;
  private recomputeTimer: any = null;

  constructor(private app: App) {
    this.input = h('input', { class: 'field', placeholder: 'Search in screenplay', 'aria-label': 'Search in screenplay', spellcheck: 'false' });
    this.input.addEventListener('input', () => {
      this.compute();
      this.current = this.matches.length ? this.nearestIndex() : -1;
      this.show(false);
    });
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.count = h('span', { class: 'dim', style: { minWidth: '64px', textAlign: 'right', fontSize: '11.5px' } });
    this.caseBtn = h('button', { class: 'icon-btn', title: 'Match case', tabindex: '-1', style: { fontSize: '11px', fontWeight: '600' }, onclick: () => this.toggleCase() }, 'Aa');
    this.results = h('div', { class: 'list', role: 'listbox', style: { maxHeight: '260px', borderTop: '1px solid var(--line)' } });
    this.el = h(
      'div',
      {
        class: 'findbar floating hidden',
        style: {
          position: 'absolute', top: '8px', right: '16px', zIndex: '30', width: '380px', background: 'var(--panel)', border: '1px solid var(--line-2)',
          borderRadius: '6px', boxShadow: 'var(--shadow)', display: 'flex', flexDirection: 'column',
        },
      },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '4px', padding: '6px' } },
        this.input,
        this.count,
        this.caseBtn,
        iconButton('up', 'Previous result', () => this.step(-1)),
        iconButton('down', 'Next result', () => this.step(1)),
        iconButton('close', 'Close (Esc)', () => this.close(true)),
      ),
      this.results,
    );
    this.input.style.flex = '1';
  }

  hasQuery() {
    return !this.el.classList.contains('hidden') && !!this.input.value;
  }

  open() {
    this.el.classList.remove('hidden');
    const selected = this.app.editor.selectedText();
    if (selected && !selected.includes('\n') && selected.length < 80) this.input.value = selected;
    this.input.focus();
    this.input.select();
    if (!this.popEsc) this.popEsc = pushEscape(() => this.close(true));
    this.compute();
    this.current = this.matches.length ? this.nearestIndex() : -1;
    this.show(false);
  }

  close(focusEditor: boolean) {
    if (this.el.classList.contains('hidden')) return;
    this.el.classList.add('hidden');
    this.popEsc?.();
    this.popEsc = null;
    this.app.editor.setHighlights([]);
    if (focusEditor) this.app.editor.focus();
  }

  private toggleCase() {
    this.caseSensitive = !this.caseSensitive;
    this.caseBtn.classList.toggle('on', this.caseSensitive);
    this.compute();
    this.current = this.matches.length ? this.nearestIndex() : -1;
    this.show(false);
    this.input.focus();
  }

  onDocChange() {
    if (this.el.classList.contains('hidden') || !this.input.value) return;
    clearTimeout(this.recomputeTimer);
    this.recomputeTimer = setTimeout(() => {
      this.compute();
      if (this.current >= this.matches.length) this.current = this.matches.length - 1;
      this.show(false);
    }, 150);
  }

  private compute() {
    const q = this.input.value;
    this.matches = [];
    if (!q) return;
    const re = new RegExp(escapeRegex(q), this.caseSensitive ? 'g' : 'gi');
    const L = this.app.editor.lines;
    const visible = this.app.view === 'dialogue' ? new Set(this.app.editor.displayedLines) : null;
    for (let i = 0; i < L.length; i++) {
      if (visible && !visible.has(i)) continue;
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(L[i].text))) {
        if (!m[0].length) {
          re.lastIndex++;
          continue;
        }
        this.matches.push({ line: i, from: m.index, to: m.index + m[0].length });
        if (this.matches.length > 5000) return;
      }
    }
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
    if (!this.matches.length) return;
    this.current = (this.current + dir + this.matches.length) % this.matches.length;
    this.show(true);
  }

  /** Updates highlights, the counter and the result list; optionally moves to the current match. */
  private show(go: boolean) {
    const n = this.matches.length;
    this.count.textContent = this.input.value ? (n ? `${this.current + 1} of ${n}${n > 5000 ? '+' : ''}` : 'No results') : '';
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
    const max = Math.min(this.matches.length, 300);
    for (let k = 0; k < max; k++) {
      const m = this.matches[k];
      const sc = this.app.sceneAt(m.line);
      const text = L[m.line].text;
      const a = Math.max(0, m.from - 24);
      const snippet = h('span', { class: 'label' }, (a > 0 ? '…' : '') + text.slice(a, m.from), h('strong', { style: { color: 'var(--text)' } }, text.slice(m.from, m.to)), text.slice(m.to, m.to + 40));
      const row = h(
        'div',
        { class: `row${k === this.current ? ' selected' : ''}`, role: 'option' },
        h('span', { class: 'num', style: { width: '34px' }, title: sc?.heading }, sc ? (sc.kind === 'scene' ? `Sc ${sc.order}` : sc.kind === 'title' ? 'Title' : 'Open') : ''),
        snippet,
      );
      row.addEventListener('mousedown', (e) => e.preventDefault());
      row.addEventListener('click', () => {
        this.current = k;
        this.show(false);
        this.goTo(k, true);
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
}

export { cursor };
