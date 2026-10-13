// Scene cards: an overview of the same scene order as the outline, with summaries,
// status and color. Reordering here moves the scenes in the screenplay.

import type { App, SceneItem } from '../app';
import { h, iconButton } from './dom';
import { openMenu, pushEscape } from './overlay';
import { SCENE_COLORS, STATUS_LABELS, sceneGroupMenu } from './outline';
import { isMac } from '../bridge';
import { SceneStatus } from '../../shared/types';
import { paginate } from '../../shared/paginate';
import { cleanText, countWords } from '../../shared/fountain';
import { projectExportSettings } from './export';

/** Scene length in pages and eighths, e.g. "1 3/8". */
export function eighths(rows: number, lpp: number): string {
  const e = Math.max(1, Math.round((rows / lpp) * 8));
  const whole = Math.floor(e / 8);
  const rest = e % 8;
  const frac = rest ? `${rest}/8` : '';
  return whole ? (frac ? `${whole} ${frac}` : `${whole}`) : frac;
}

export class SceneCards {
  el: HTMLElement;
  private grid: HTMLElement;
  private countEl: HTMLElement;
  /** Keyboard position; the selection itself lives in app.sceneSel. */
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
      h(
        'div',
        { class: 'cards-head' },
        h('span', { class: 'doc-title', style: { padding: '0' } }, 'Scene cards'),
        this.countEl,
        h('span', { class: 'spacer' }),
        h('span', { class: 'dim', style: { fontSize: '11px' } }, `↵ open · ${isMac ? '⌘' : 'Ctrl+'}click / ⇧click select several · ⌥⇧ arrows move · drag to reorder`),
        iconButton('settings', 'Card display', (e) => this.optionsMenu(e.currentTarget as HTMLElement)),
      ),
      this.grid,
    );
  }

  get isOpen() {
    return !this.el.classList.contains('hidden');
  }

  /** Shown by app.openPanel('cards'). */
  open() {
    if (!this.app.project) return;
    this.el.classList.remove('hidden');
    const active = this.app.activeScene();
    this.selected = active?.kind === 'scene' ? active.id : this.items()[0]?.id ?? null;
    if (this.selected && !this.app.sceneSel.has(this.selected)) this.app.setSceneSelection([this.selected], this.selected);
    this.lastSig = '';
    this.render();
    if (!this.popEsc) this.popEsc = pushEscape(() => this.app.closePanel(), false);
    this.grid.focus();
    this.cardEl(this.selected)?.scrollIntoView({ block: 'nearest' });
  }

  /** Hidden by app.closePanel(). */
  close(focusEditor = true) {
    if (!this.isOpen) return;
    this.el.classList.add('hidden');
    this.popEsc?.();
    this.popEsc = null;
    if (focusEditor) this.app.editor.focus();
  }

  /** Marks the selected cards without rebuilding them. */
  applySelection() {
    if (!this.isOpen) return;
    this.grid.querySelectorAll<HTMLElement>('.card').forEach((c) => {
      const on = this.app.sceneSel.has(c.dataset.id!);
      c.classList.toggle('selected', on);
      c.classList.toggle('cursor', c.dataset.id === this.selected);
      c.setAttribute('aria-selected', String(on));
    });
  }

  private items(): SceneItem[] {
    return this.app.scenes.filter((s) => s.kind === 'scene');
  }

  private cardEl(id: string | null): HTMLElement | null {
    return id ? (this.grid.querySelector(`[data-id="${id}"]`) as HTMLElement | null) : null;
  }

  private renderTimer: any = null;

  /** Debounced render for document changes (typing stays fast with cards open). */
  renderSoon() {
    if (!this.isOpen) return;
    clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => this.render(), 200);
  }

  render() {
    if (!this.isOpen) return;
    clearTimeout(this.renderTimer);
    const items = this.items();
    const sig = items.map((s) => `${s.id}|${s.order}|${s.heading}|${s.end - s.line}|${s.record?.summary ?? ''}|${s.record?.status ?? ''}|${s.record?.color ?? ''}`).join('\n') + '|' + JSON.stringify(this.app.settings.cards) + '|' + this.app.editor.version;
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    this.countEl.textContent = `${items.length} scenes`;
    this.grid.textContent = '';
    const o = this.app.settings.cards;
    this.grid.dataset.size = o.size;
    const info = this.sceneInfo();
    for (const it of items) {
      const rec = it.record;
      const color = rec?.color;
      const meta = info.get(it.id);
      const card = h(
        'div',
        {
          class: `card style-${o.colorStyle}${color ? ' has-color' : ''}`,
          role: 'option',
          dataset: { id: it.id },
          draggable: true,
          title: it.heading,
          style: color ? { '--scene': color } : undefined,
        },
        h('div', { class: 'card-top' }, h('span', { class: 'card-num' }, String(it.order)), h('span', { class: 'card-heading' }, it.heading || '(empty heading)')),
        o.showSummary ? h('div', { class: `card-summary${rec?.summary ? '' : ' dim'}` }, rec?.summary || 'No summary') : null,
        o.showCharacters && meta?.characters.length ? h('div', { class: 'card-chars' }, meta.characters.join(', ')) : null,
        h(
          'div',
          { class: 'card-foot' },
          o.showStatus && rec?.status ? h('span', { class: `card-status st-${rec.status}` }, STATUS_LABELS[rec.status]) : null,
          h('span', { class: 'spacer' }),
          o.showLength && meta ? h('span', { class: 'card-len', title: `${meta.words} words · ${meta.length} pages` }, `${meta.length} pg`) : null,
        ),
      );
      if (color) card.style.setProperty('--scene', color);
      card.addEventListener('click', (e) => {
        this.selected = it.id;
        this.app.clickSelect(it, e, this.items());
        this.grid.focus();
      });
      card.addEventListener('dblclick', () => this.openScene(it));
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (!this.app.sceneSel.has(it.id)) this.select(it.id);
        this.menu(it, e.clientX, e.clientY);
      });
      card.addEventListener('dragstart', (e) => {
        this.dragId = it.id;
        if (!this.app.sceneSel.has(it.id)) this.select(it.id);
        for (const m of this.app.scenesFor(it)) this.cardEl(m.id)?.classList.add('dragging');
        e.dataTransfer!.effectAllowed = 'move';
        e.dataTransfer!.setData('text/plain', it.heading);
      });
      card.addEventListener('dragend', () => {
        this.dragId = null;
        this.grid.querySelectorAll('.dragging').forEach((x) => x.classList.remove('dragging'));
        this.grid.querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
      });
      card.addEventListener('dragover', (e) => {
        if (!this.dragId || this.dragId === it.id || (this.app.sceneSel.size > 1 && this.app.sceneSel.has(it.id) && this.app.sceneSel.has(this.dragId))) return;
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
          this.app.moveScenes(this.app.scenesFor(src), it, after);
          this.selected = src.id;
          this.lastSig = '';
          this.render();
        }
      });
      this.grid.append(card);
    }
    this.applySelection();
  }

  /** Characters and length (in pages and eighths, from the real pagination) per scene. */
  private infoCache: { key: string; value: Map<string, { characters: string[]; words: number; length: string }> } | null = null;

  private sceneInfo(): Map<string, { characters: string[]; words: number; length: string }> {
    const o = this.app.settings.cards;
    const key = `${this.app.editor.version}|${o.showCharacters}|${o.showLength}|${JSON.stringify(this.app.project?.meta.exportSettings ?? null)}|${this.items().map((i) => i.id).join(',')}`;
    if (this.infoCache?.key === key) return this.infoCache.value;
    const out = new Map<string, { characters: string[]; words: number; length: string }>();
    this.infoCache = { key, value: out };
    if (!o.showCharacters && !o.showLength) return out;
    const ed = this.app.editor;
    const parsed = ed.parsed;
    const texts = ed.lineTexts;
    const rowsByScene = new Map<number, number>();
    let lpp = 54;
    if (o.showLength) {
      const s = projectExportSettings(this.app);
      const r = paginate(texts, parsed, { ...s, titlePage: false }, { kind: 'all' });
      lpp = r.capacity.linesPerPage;
      const sceneStarts = parsed.scenes.map((sc) => sc.line);
      const sceneOf = (line: number) => {
        let lo = 0;
        let hi = sceneStarts.length - 1;
        let ans = -1;
        while (lo <= hi) {
          const m = (lo + hi) >> 1;
          if (sceneStarts[m] <= line) {
            ans = m;
            lo = m + 1;
          } else hi = m - 1;
        }
        return ans;
      };
      for (const page of r.pages) {
        const seen = new Set<number>();
        for (const l of page.lines) {
          if (seen.has(l.row)) continue;
          seen.add(l.row);
          const sc = sceneOf(l.sourceLine);
          if (sc >= 0) rowsByScene.set(sc, (rowsByScene.get(sc) ?? 0) + 1);
        }
      }
    }
    for (const it of this.items()) {
      const idx = parsed.scenes.findIndex((sc) => sc.line === it.line);
      const counts = new Map<string, number>();
      let words = 0;
      for (const b of parsed.blocks) if (b.cueLine >= it.line && b.cueLine < it.end) counts.set(b.cue, (counts.get(b.cue) ?? 0) + 1);
      for (let i = it.line + 1; i < it.end; i++) {
        const t = parsed.lines[i].type;
        if (t !== 'note' && t !== 'boneyard') words += countWords(cleanText(texts[i], parsed.lines[i].flags));
      }
      const characters = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
      // Spacing lines count too, roughly one per element; the row count covers text lines.
      const rows = (rowsByScene.get(idx) ?? 0) * 1.25;
      out.set(it.id, { characters: characters.slice(0, 5).concat(characters.length > 5 ? [`+${characters.length - 5}`] : []), words, length: eighths(rows, lpp) });
    }
    return out;
  }

  private optionsMenu(anchor: HTMLElement) {
    const o = this.app.settings.cards;
    const set = (patch: Partial<typeof o>) => {
      Object.assign(o, patch);
      this.app.saveSettings();
      this.lastSig = '';
      this.render();
      this.app.outline.refresh();
      this.grid.focus();
    };
    const mark = (on: boolean, label: string) => `${on ? '✓' : '  '} ${label}`;
    openMenu(
      [
        { head: 'Card size' },
        ...(['small', 'medium', 'large'] as const).map((v) => ({ label: mark(o.size === v, v[0].toUpperCase() + v.slice(1)), run: () => set({ size: v }) })),
        { head: 'Scene color' },
        ...([
          ['stripe', 'Stripe'],
          ['tint', 'Tinted card'],
          ['header', 'Colored header'],
          ['full', 'Filled card'],
        ] as const).map(([v, l]) => ({ label: mark(o.colorStyle === v, l), run: () => set({ colorStyle: v }) })),
        { head: 'Show' },
        { label: mark(o.showSummary, 'Summary'), run: () => set({ showSummary: !o.showSummary }) },
        { label: mark(o.showCharacters, 'Characters'), run: () => set({ showCharacters: !o.showCharacters }) },
        { label: mark(o.showStatus, 'Status'), run: () => set({ showStatus: !o.showStatus }) },
        { label: mark(o.showLength, 'Length in pages'), run: () => set({ showLength: !o.showLength }) },
        { sep: true },
        { label: mark(o.tintOutline, 'Tint scene rows in the outline'), run: () => set({ tintOutline: !o.tintOutline }) },
      ],
      anchor.getBoundingClientRect(),
    );
  }

  private select(id: string, extend = false) {
    this.selected = id;
    if (extend && this.app.sceneSelAnchor) {
      const items = this.items();
      const a = items.findIndex((s) => s.id === this.app.sceneSelAnchor);
      const b = items.findIndex((s) => s.id === id);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      this.app.setSceneSelection(items.slice(lo, hi + 1).map((s) => s.id), this.app.sceneSelAnchor);
    } else this.app.setSceneSelection([id], id);
    this.cardEl(id)?.scrollIntoView({ block: 'nearest' });
  }

  private openScene(it: SceneItem) {
    this.app.closePanel(false);
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
      const group = this.app.scenesFor(it);
      if (group.length > 1) {
        // A group moves one place at a time (left/right and up/down alike).
        this.app.moveScenesBy(group, moveBy < 0 ? -1 : 1);
      } else {
        const target = Math.max(0, Math.min(items.length - 1, i + moveBy));
        if (target !== i) this.app.moveScene(it, items[target], target > i);
      }
      this.lastSig = '';
      this.render();
    } else if (moveBy) {
      i = Math.max(0, Math.min(items.length - 1, i + moveBy));
      this.select(items[i].id, e.shiftKey);
    } else if ((e.key === 'a' || e.key === 'A') && (isMac ? e.metaKey : e.ctrlKey)) {
      this.app.setSceneSelection(items.map((s) => s.id), items[0].id);
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
    const group = this.app.scenesFor(it);
    if (group.length > 1) return openMenu(sceneGroupMenu(this.app, group), { x, y });
    const rec = it.record;
    const items = [
      { label: 'Open scene', run: () => this.openScene(it) },
      { label: 'Edit summary & notes…', run: () => {
        this.app.closePanel(false);
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
