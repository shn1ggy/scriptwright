// Scene outline: compact single-line rows with order numbers, search, keyboard
// navigation, drag-and-drop and keyboard reordering.

import type { App, SceneItem } from '../app';
import { h, iconButton } from './dom';
import { MenuItem, openMenu } from './overlay';
import { SceneStatus } from '../../shared/types';

export const SCENE_COLORS: Array<{ name: string; value: string }> = [
  { name: 'Red', value: '#E5706B' },
  { name: 'Orange', value: '#E39B5B' },
  { name: 'Yellow', value: '#E3C566' },
  { name: 'Green', value: '#7FC48D' },
  { name: 'Blue', value: '#6FA8E8' },
  { name: 'Purple', value: '#B48DE0' },
];

export const STATUS_LABELS: Record<SceneStatus, string> = { '': 'No status', draft: 'Draft', revise: 'Needs work', done: 'Done' };

export class OutlinePane {
  el: HTMLElement;
  private list: HTMLElement;
  private search: HTMLInputElement;
  private countEl: HTMLElement;
  private rows = new Map<string, HTMLElement>();
  private selectedId: string | null = null;
  private lastSig = '';
  private dragId: string | null = null;

  constructor(private app: App) {
    this.search = h('input', { class: 'field', placeholder: 'Search scenes', 'aria-label': 'Search scenes', spellcheck: 'false' });
    this.search.dataset.esc = 'self';
    this.search.addEventListener('input', () => {
      this.lastSig = '';
      this.render();
    });
    this.search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.search.value = '';
        this.lastSig = '';
        this.render();
        this.app.editor.focus();
      } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
        e.preventDefault();
        const first = this.visibleItems()[0];
        if (first) {
          if (e.key === 'Enter') {
            this.app.goToScene(first);
          } else {
            this.select(first.id);
            this.list.focus();
          }
        }
      }
    });
    this.countEl = h('span', { class: 'dim' });
    this.list = h('div', { class: 'list', tabindex: '0', role: 'listbox', 'aria-label': 'Scenes' });
    this.list.addEventListener('keydown', (e) => this.onKey(e));
    this.el = h(
      'div',
      { class: 'outline' },
      h('div', { class: 'section-head' }, h('span', null, 'Scenes'), this.countEl, h('span', { class: 'spacer' }), iconButton('cards', 'Scene cards', () => this.app.run('scene.cards')), iconButton('plus', 'New scene after current', () => this.app.run('scene.new'))),
      h('div', { class: 'outline-search' }, this.search),
      this.list,
    );
  }

  /** Re-renders even when the scenes did not change (display settings changed). */
  refresh() {
    this.lastSig = '';
    this.render();
  }

  focusSearch() {
    if (!this.app.state.layout.leftVisible) this.app.togglePane('left');
    this.search.focus();
    this.search.select();
  }

  private visibleItems(): SceneItem[] {
    const q = this.search.value.trim().toLowerCase();
    if (!q) return this.app.scenes;
    return this.app.scenes.filter((s) => {
      const hay = `${s.order || ''} ${s.heading} ${s.record?.summary ?? ''} ${s.sceneNumber ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
  }

  render() {
    const items = this.visibleItems();
    const sig = items.map((s) => `${s.id}|${s.order}|${s.heading}|${s.record?.color ?? ''}|${s.record?.status ?? ''}|${s.record?.summary ?? ''}`).join('\n');
    const total = this.app.scenes.filter((s) => s.kind === 'scene').length;
    this.countEl.textContent = this.app.project ? String(total) : '';
    if (sig === this.lastSig) {
      this.updateActive();
      return;
    }
    this.lastSig = sig;
    const scroll = this.list.scrollTop;
    this.list.textContent = '';
    this.rows.clear();
    if (!this.app.project) return;
    if (!items.length) {
      this.list.append(h('div', { class: 'empty-note' }, this.search.value ? 'No matching scenes' : 'No scenes yet. Write a heading such as INT. HOUSE - DAY, or use New Scene.'));
    }
    for (const it of items) {
      const row = h(
        'div',
        { class: `row${it.kind !== 'scene' ? ' title-row' : ''}`, role: 'option', title: this.tooltip(it), dataset: { id: it.id } },
        h('span', { class: 'num' }, it.kind === 'scene' ? String(it.order) : ''),
        it.record?.color ? h('span', { class: 'swatch', style: { background: it.record.color } }) : null,
        h('span', { class: 'label' }, it.heading || '(empty heading)'),
        it.record?.status ? h('span', { class: 'meta' }, it.record.status === 'done' ? '✓' : it.record.status === 'revise' ? '!' : '·') : null,
      );
      row.addEventListener('click', () => {
        this.select(it.id);
        this.app.goToScene(it);
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.select(it.id);
        this.contextMenu(it, e);
      });
      if (it.kind === 'scene') {
        row.draggable = true;
        row.addEventListener('dragstart', (e) => {
          this.dragId = it.id;
          row.classList.add('dragging');
          e.dataTransfer!.effectAllowed = 'move';
          e.dataTransfer!.setData('text/plain', it.heading);
        });
        row.addEventListener('dragend', () => {
          this.dragId = null;
          row.classList.remove('dragging');
          this.clearDrop();
        });
        row.addEventListener('dragover', (e) => {
          if (!this.dragId || this.dragId === it.id) return;
          e.preventDefault();
          const r = row.getBoundingClientRect();
          const after = e.clientY > r.top + r.height / 2;
          this.clearDrop();
          row.classList.add(after ? 'drop-after' : 'drop-before');
        });
        row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
        row.addEventListener('drop', (e) => {
          e.preventDefault();
          const r = row.getBoundingClientRect();
          const after = e.clientY > r.top + r.height / 2;
          const src = this.app.scenes.find((s) => s.id === this.dragId);
          this.clearDrop();
          if (src) this.app.moveScene(src, it, after);
        });
      }
      if (it.record?.color && this.app.settings.cards.tintOutline) {
        row.classList.add('tinted');
        row.style.setProperty('--scene', it.record.color);
      }
      this.rows.set(it.id, row);
      this.list.append(row);
    }
    this.list.scrollTop = scroll;
    this.updateActive();
  }

  private tooltip(it: SceneItem): string {
    const parts = [it.kind === 'scene' ? `${it.order}. ${it.heading}` : it.heading];
    if (it.sceneNumber) parts.push(`Scene number ${it.sceneNumber}`);
    if (it.record?.summary) parts.push(it.record.summary);
    return parts.join('\n');
  }

  private clearDrop() {
    for (const r of this.rows.values()) r.classList.remove('drop-before', 'drop-after');
  }

  updateActive() {
    const active = this.app.view === 'scene' ? this.app.activeScene() ?? this.app.focusedItem() : this.app.activeScene();
    // In Script view the scene at the reading position gets a quieter marker.
    const reading = this.app.isFullView() && this.app.project ? this.app.sceneAt(this.app.editor.topVisibleLine()) : undefined;
    for (const [id, row] of this.rows) {
      row.classList.toggle('reading', !!reading && reading.id === id && (!active || active.id !== id));
      const on = !!active && active.id === id;
      if (row.classList.contains('active') !== on) {
        row.classList.toggle('active', on);
        if (on && document.activeElement !== this.list) row.scrollIntoView({ block: 'nearest' });
      }
      row.setAttribute('aria-selected', String(this.selectedId === id));
    }
  }

  private select(id: string | null) {
    this.selectedId = id;
    for (const [rid, row] of this.rows) row.classList.toggle('selected', rid === id);
    if (id) this.rows.get(id)?.scrollIntoView({ block: 'nearest' });
  }

  private onKey(e: KeyboardEvent) {
    const items = this.visibleItems();
    if (!items.length) return;
    let idx = items.findIndex((s) => s.id === this.selectedId);
    const cur = items[idx];
    const mod = this.app.commands; // for labels only
    void mod;
    if (e.altKey && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      if (cur?.kind === 'scene') {
        this.app.moveSceneBy(cur, e.key === 'ArrowUp' ? -1 : 1);
        this.select(cur.id);
        this.list.focus();
      }
    } else if (e.key === 'ArrowDown') {
      this.select(items[Math.min(items.length - 1, idx + 1)].id);
    } else if (e.key === 'ArrowUp') {
      if (idx <= 0) {
        this.search.focus();
      } else this.select(items[idx - 1].id);
    } else if (e.key === 'Home') {
      this.select(items[0].id);
    } else if (e.key === 'End') {
      this.select(items[items.length - 1].id);
    } else if (e.key === 'Enter' || e.key === ' ') {
      if (cur) this.app.goToScene(cur);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && cur?.kind === 'scene') {
      this.app.deleteScene(cur).then(() => this.list.focus());
    } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      if (cur) {
        const r = this.rows.get(cur.id)!.getBoundingClientRect();
        this.contextMenu(cur, { clientX: r.left + 30, clientY: r.bottom } as MouseEvent);
      }
    } else return;
    e.preventDefault();
    e.stopPropagation();
    void idx;
  }

  private contextMenu(it: SceneItem, e: { clientX: number; clientY: number }) {
    const items: MenuItem[] = [{ label: 'Go to scene', run: () => this.app.goToScene(it) }];
    if (it.kind === 'scene') {
      const rec = it.record;
      items.push(
        { label: 'Duplicate', run: () => this.app.duplicateScene(it) },
        { label: 'Move up', kbd: this.app.commands.label('scene.moveUp'), run: () => this.app.moveSceneBy(it, -1) },
        { label: 'Move down', kbd: this.app.commands.label('scene.moveDown'), run: () => this.app.moveSceneBy(it, 1) },
        { label: 'Remove…', run: () => this.app.deleteScene(it) },
        { sep: true },
        { label: 'Summary & notes…', run: () => {
          this.app.goToScene(it, { focusEditor: false });
          this.app.showRightTab('scene');
        } },
        { head: 'Status' },
      );
      for (const [k, label] of Object.entries(STATUS_LABELS)) {
        items.push({ label: (rec?.status ?? '') === k ? `✓ ${label}` : `   ${label}`, run: () => this.app.updateSceneRecord(it, { status: k as SceneStatus }) });
      }
      items.push({ head: 'Color' });
      for (const c of SCENE_COLORS) items.push({ label: c.name, dot: c.value, run: () => this.app.updateSceneRecord(it, { color: c.value }) });
      items.push({ label: 'No color', run: () => this.app.updateSceneRecord(it, { color: undefined }) });
    }
    openMenu(items, { x: e.clientX, y: e.clientY });
  }
}
