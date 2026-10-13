// Scene cards: an overview of the same scene order as the outline, with summaries,
// status and color. Reordering here moves the scenes in the screenplay.

import type { App, SceneItem } from '../app';
import { h, iconButton } from './dom';
import { openMenu, pushEscape } from './overlay';
import { SCENE_COLORS, STATUS_LABELS } from './outline';
import { SceneStatus } from '../../shared/types';

export class SceneCards {
  el: HTMLElement;
  private grid: HTMLElement;
  private countEl: HTMLElement;
  private selected: string | null = null;
  private popEsc: (() => void) | null = null;
  private dragId: string | null = null;
  private lastSig = '';

  constructor(private app: App) {
    this.grid = h('div', { class: 'cards-grid', tabindex: '0', role: 'listbox', 'aria-label': 'Scene cards' });
    this.grid.addEventListener('keydown', (e) => this.onKey(e));
    this.countEl = h('span', { class: 'dim' });
    this.el = h(
      'div',
      { class: 'cards floating hidden' },
      h('div', { class: 'cards-head' }, h('span', { class: 'doc-title', style: { padding: '0' } }, 'Scene cards'), this.countEl, h('span', { class: 'spacer' }), h('span', { class: 'dim', style: { fontSize: '11px' } }, '↵ open · ⌥⇧ arrows move · drag to reorder'), iconButton('close', 'Close (Esc)', () => this.close())),
      this.grid,
    );
  }

  get isOpen() {
    return !this.el.classList.contains('hidden');
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  open() {
    if (!this.app.project) return;
    this.el.classList.remove('hidden');
    this.selected = this.app.activeScene()?.kind === 'scene' ? this.app.activeScene()!.id : this.items()[0]?.id ?? null;
    this.lastSig = '';
    this.render();
    if (!this.popEsc) this.popEsc = pushEscape(() => this.close(), false);
    this.grid.focus();
    this.cardEl(this.selected)?.scrollIntoView({ block: 'nearest' });
  }

  close(focusEditor = true) {
    if (!this.isOpen) return;
    this.el.classList.add('hidden');
    this.popEsc?.();
    this.popEsc = null;
    if (focusEditor) this.app.editor.focus();
  }

  private items(): SceneItem[] {
    return this.app.scenes.filter((s) => s.kind === 'scene');
  }

  private cardEl(id: string | null): HTMLElement | null {
    return id ? (this.grid.querySelector(`[data-id="${id}"]`) as HTMLElement | null) : null;
  }

  render() {
    if (!this.isOpen) return;
    const items = this.items();
    const sig = items.map((s) => `${s.id}|${s.order}|${s.heading}|${s.record?.summary ?? ''}|${s.record?.status ?? ''}|${s.record?.color ?? ''}`).join('\n') + '|' + this.selected;
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    this.countEl.textContent = `${items.length} scenes`;
    this.grid.textContent = '';
    for (const it of items) {
      const rec = it.record;
      const card = h(
        'div',
        { class: `card${it.id === this.selected ? ' selected' : ''}`, role: 'option', 'aria-selected': String(it.id === this.selected), dataset: { id: it.id }, draggable: true, title: it.heading },
        rec?.color ? h('span', { class: 'card-color', style: { background: rec.color } }) : null,
        h('div', { class: 'card-top' }, h('span', { class: 'card-num' }, String(it.order)), h('span', { class: 'card-heading' }, it.heading || '(empty heading)')),
        h('div', { class: `card-summary${rec?.summary ? '' : ' dim'}` }, rec?.summary || 'No summary'),
        rec?.status ? h('div', { class: 'card-status' }, STATUS_LABELS[rec.status]) : null,
      );
      card.addEventListener('click', () => this.select(it.id));
      card.addEventListener('dblclick', () => this.openScene(it));
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.select(it.id);
        this.menu(it, e.clientX, e.clientY);
      });
      card.addEventListener('dragstart', (e) => {
        this.dragId = it.id;
        card.classList.add('dragging');
        e.dataTransfer!.effectAllowed = 'move';
        e.dataTransfer!.setData('text/plain', it.heading);
      });
      card.addEventListener('dragend', () => {
        this.dragId = null;
        card.classList.remove('dragging');
        this.grid.querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
      });
      card.addEventListener('dragover', (e) => {
        if (!this.dragId || this.dragId === it.id) return;
        e.preventDefault();
        const r = card.getBoundingClientRect();
        const after = e.clientX > r.left + r.width / 2;
        this.grid.querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
        card.classList.add(after ? 'drop-after' : 'drop-before');
      });
      card.addEventListener('drop', (e) => {
        e.preventDefault();
        const r = card.getBoundingClientRect();
        const after = e.clientX > r.left + r.width / 2;
        const src = this.items().find((s) => s.id === this.dragId);
        if (src) {
          this.app.moveScene(src, it, after);
          this.selected = src.id;
          this.lastSig = '';
          this.render();
        }
      });
      this.grid.append(card);
    }
  }

  private select(id: string) {
    this.selected = id;
    this.grid.querySelectorAll('.card').forEach((c) => {
      const on = (c as HTMLElement).dataset.id === id;
      c.classList.toggle('selected', on);
      c.setAttribute('aria-selected', String(on));
    });
    this.cardEl(id)?.scrollIntoView({ block: 'nearest' });
  }

  private openScene(it: SceneItem) {
    this.close(false);
    this.app.goToScene(it);
  }

  private columns(): number {
    const cards = Array.from(this.grid.children) as HTMLElement[];
    if (cards.length < 2) return 1;
    const top = cards[0].offsetTop;
    let n = 0;
    for (const c of cards) {
      if (c.offsetTop !== top) break;
      n++;
    }
    return Math.max(1, n);
  }

  private onKey(e: KeyboardEvent) {
    const items = this.items();
    if (!items.length) return;
    let i = Math.max(0, items.findIndex((s) => s.id === this.selected));
    const cols = this.columns();
    const moveBy = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' ? -cols : e.key === 'ArrowDown' ? cols : 0;
    if (moveBy && e.altKey && e.shiftKey) {
      const it = items[i];
      const target = Math.max(0, Math.min(items.length - 1, i + moveBy));
      if (target !== i) {
        this.app.moveScene(it, items[target], target > i);
        this.lastSig = '';
        this.render();
      }
    } else if (moveBy) {
      i = Math.max(0, Math.min(items.length - 1, i + moveBy));
      this.select(items[i].id);
    } else if (e.key === 'Enter') {
      this.openScene(items[i]);
    } else if (e.key === 'Home') this.select(items[0].id);
    else if (e.key === 'End') this.select(items[items.length - 1].id);
    else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      const r = this.cardEl(items[i].id)!.getBoundingClientRect();
      this.menu(items[i], r.left + 20, r.top + 20);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }

  private menu(it: SceneItem, x: number, y: number) {
    const rec = it.record;
    const items = [
      { label: 'Open scene', run: () => this.openScene(it) },
      { label: 'Edit summary & notes…', run: () => {
        this.close(false);
        this.app.goToScene(it, { focusEditor: false });
        this.app.showRightTab('scene');
      } },
      { sep: true },
      { head: 'Status' },
      ...Object.entries(STATUS_LABELS).map(([k, label]) => ({ label: (rec?.status ?? '') === k ? `✓ ${label}` : `   ${label}`, run: () => this.app.updateSceneRecord(it, { status: k as SceneStatus }) })),
      { head: 'Color' },
      ...SCENE_COLORS.map((c) => ({ label: c.name, dot: c.value, run: () => this.app.updateSceneRecord(it, { color: c.value }) })),
      { label: 'No color', run: () => this.app.updateSceneRecord(it, { color: undefined }) },
    ];
    openMenu(items, { x, y });
  }
}
