// Scene cards: an overview of the same scene order as the outline, with summaries,
// status and color. Reordering here moves the scenes in the screenplay.

import type { App, SceneItem } from '../app';
import { h, iconButton } from './dom';
import { openMenu, pushEscape } from './overlay';
import { SCENE_COLORS, STATUS_LABELS, sceneGroupMenu } from './outline';
import { isMac } from '../bridge';
import { SceneStatus } from '../../shared/types';
import { cleanText, countWords } from '../../shared/fountain';
import { Timeline, beatsOn, moveSection, sceneStructureMenu, sectionMenu, sectionRange, sections, positions } from './structure';
import type { StorySection } from '../../shared/structure';
import { t, tn } from '../../shared/i18n';

/** Scene length in pages and eighths, e.g. "1 3/8". */
function eighths(pages: number): string {
  const e = Math.max(1, Math.round(pages * 8));
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
  /** An act or sequence divider being dragged to another card. */
  private dragSec: StorySection | null = null;
  /** The single card currently showing a drop line, and which side. Dragover fires far more
   * often than the screen repaints; coalescing to one DOM write per frame (and skipping it when
   * nothing changed) is what keeps dragging smooth, especially on Windows. */
  private dropEl: HTMLElement | null = null;
  private dropSide: 'before' | 'after' | null = null;
  private dropRaf = 0;
  private lastSig = '';
  readonly timeline: Timeline;
  private modeSeg: HTMLElement;
  private hint: HTMLElement;

  constructor(private app: App) {
    this.grid = h('div', { class: 'cards-grid', tabindex: '0', role: 'listbox', 'aria-label': t("Scene cards") });
    this.grid.addEventListener('keydown', (e) => this.onKey(e));
    // A click on the empty space between cards clears the selection.
    this.grid.addEventListener('click', (e) => {
      if (e.target === this.grid && this.app.sceneSel.size) this.app.setSceneSelection([], null);
    });
    this.countEl = h('span', { class: 'dim' });
    this.timeline = new Timeline(app, {
      cursor: () => this.selected,
      setCursor: (id) => {
        this.selected = id;
        this.app.rightPane?.render?.();
      },
      menu: (it, x, y) => this.menu(it, x, y),
      open: (it) => this.openScene(it),
    });
    this.modeSeg = h('span', { class: 'seg', role: 'group', 'aria-label': t("Show as") });
    this.hint = h('span', { class: 'dim', style: { fontSize: '11px' } });
    this.el = h(
      'div',
      { class: 'cards floating hidden' },
      h(
        'div',
        { class: 'cards-head' },
        this.modeSeg,
        this.countEl,
        h('span', { class: 'spacer' }),
        this.hint,
        iconButton('settings', t("Card display"), (e) => this.optionsMenu(e.currentTarget as HTMLElement)),
      ),
      this.grid,
      this.timeline.el,
    );
    this.renderMode();
  }

  get mode(): 'cards' | 'timeline' {
    return this.app.state.layout.cardsMode ?? 'cards';
  }

  setMode(m: 'cards' | 'timeline') {
    this.app.state.layout.cardsMode = m;
    this.app.saveStateSoon();
    this.renderMode();
    this.lastSig = '';
    this.render();
    if (m === 'cards') this.grid.focus();
    else this.timeline.focus();
  }

  private renderMode() {
    const m = this.mode;
    const seg = (v: 'cards' | 'timeline', label: string) => h('button', { class: `seg-btn${m === v ? ' on' : ''}`, 'aria-pressed': String(m === v), 'data-mode': v, onclick: () => this.setMode(v) }, label);
    this.modeSeg.replaceChildren(seg('cards', t("Cards")), seg('timeline', t("Timeline")));
    this.grid.classList.toggle('hidden', m !== 'cards');
    this.timeline.el.classList.toggle('hidden', m !== 'timeline');
    this.hint.textContent =
      m === 'cards'
        ? t("↵ open · {0}click / ⇧click select several · ⌥⇧ arrows move · drag to reorder · right-click for acts and beats", isMac ? '⌘' : 'Ctrl+')
        : t("Scene widths are their length in pages · drag a beat’s marker onto a scene · right-click a scene for acts and beats");
  }

  /** Acts, beats or the model changed. */
  structureChanged() {
    this.lastSig = '';
    this.render();
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
    // Esc clears the selection; Cards stays open (another tab or Mod+3 leaves it).
    if (!this.popEsc)
      this.popEsc = pushEscape(() => {
        if (this.app.sceneSel.size) this.app.setSceneSelection([], null);
        if (this.mode === 'timeline') this.timeline.focus();
        else this.grid.focus();
      }, false);
    if (this.mode === 'timeline') this.timeline.show(true);
    else {
      this.grid.focus();
      this.cardEl(this.selected)?.scrollIntoView({ block: 'nearest' });
    }
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
    this.timeline.applySelection();
    this.grid.querySelectorAll<HTMLElement>('.card').forEach((c) => {
      const on = this.app.sceneSel.has(c.dataset.id!);
      c.classList.toggle('selected', on);
      c.classList.toggle('cursor', c.dataset.id === this.selected);
      c.setAttribute('aria-selected', String(on));
    });
  }

  /** Shows the drop line on at most one card, skipping the DOM write when nothing changed. */
  private setDrop(el: HTMLElement | null, side: 'before' | 'after' | null) {
    if (el === this.dropEl && side === this.dropSide) return;
    if (this.dropEl) this.dropEl.classList.remove('drop-before', 'drop-after');
    this.dropEl = el;
    this.dropSide = side;
    if (el && side) el.classList.add(side === 'before' ? 'drop-before' : 'drop-after');
  }

  /** Coalesces a run of dragover events into one drop-line update per frame. */
  private scheduleDrop(el: HTMLElement, side: 'before' | 'after') {
    cancelAnimationFrame(this.dropRaf);
    this.dropRaf = requestAnimationFrame(() => this.setDrop(el, side));
  }

  private clearDrop() {
    cancelAnimationFrame(this.dropRaf);
    this.setDrop(null, null);
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
    const sig = items.map((s) => `${s.id}|${s.number}|${s.heading}|${s.end - s.line}|${s.record?.summary ?? ''}|${s.record?.status ?? ''}|${s.record?.color ?? ''}`).join('\n') + '|' + JSON.stringify(this.app.settings.cards) + '|' + this.app.editor.version + '|' + JSON.stringify(this.app.project?.meta.structure ?? null) + '|' + this.mode;
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    if (this.mode === 'timeline') {
      const pg = Math.max(1, Math.round(positions(this.app).total));
      this.countEl.textContent = `${tn(items.length, '{0} scene', '{0} scenes')} · ${tn(pg, '{0} page', '{0} pages')}`;
      this.timeline.render();
      return;
    }
    this.countEl.textContent = tn(items.length, '{0} scene', '{0} scenes');
    this.grid.textContent = '';
    const o = this.app.settings.cards;
    this.grid.dataset.size = o.size;
    const info = this.sceneInfo();
    const secs = sections(this.app);
    const divider = (k: number) => {
      for (const sec of secs.filter((x) => x.firstScene === k)) {
        const n = sec.endScene - sec.firstScene;
        const d = h(
          'div',
          { class: `cards-divider lvl-${Math.min(3, sec.level)}`, title: t("Drag onto a card to begin here at another scene · right-click to rename or remove"), draggable: true },
          h('span', { class: 'cd-title' }, sec.title),
          h('span', { class: 'cd-meta' }, tn(n, '{0} scene', '{0} scenes')),
        );
        d.addEventListener('click', () => this.app.setSceneSelection(items.slice(sec.firstScene, sec.endScene).map((s) => s.id), items[sec.firstScene]?.id ?? null));
        d.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          openMenu(sectionMenu(this.app, sec), { x: e.clientX, y: e.clientY });
        });
        d.addEventListener('dragstart', (e) => {
          this.dragSec = sec;
          e.dataTransfer!.effectAllowed = 'move';
          e.dataTransfer!.setData('text/plain', sec.title);
          // Changing style before the browser has captured its native drag image is what makes
          // dragging stutter badly on Windows; deferring it a tick keeps the capture fast.
          setTimeout(() => d.classList.add('dragging'), 0);
        });
        d.addEventListener('dragend', () => {
          this.dragSec = null;
          d.classList.remove('dragging');
          this.clearDrop();
        });
        this.grid.append(d);
      }
    };
    for (const [k, it] of items.entries()) {
      divider(k);
      const rec = it.record;
      const beats = beatsOn(this.app, it.id);
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
        h('div', { class: 'card-top' }, h('span', { class: 'card-num' }, it.number), h('span', { class: 'card-heading' }, it.heading || t("(empty heading)"))),
        beats.length ? h('div', { class: 'card-beats' }, ...beats.map((b) => h('span', { class: 'card-beat' }, b.name))) : null,
        o.showSummary ? h('div', { class: `card-summary${rec?.summary ? '' : ' dim'}` }, rec?.summary || t("No summary")) : null,
        o.showCharacters && meta?.characters.length ? h('div', { class: 'card-chars' }, meta.characters.join(', ')) : null,
        h(
          'div',
          { class: 'card-foot' },
          o.showStatus && rec?.status ? h('span', { class: `card-status st-${rec.status}` }, STATUS_LABELS[rec.status]) : null,
          h('span', { class: 'spacer' }),
          o.showLength && meta ? h('span', { class: 'card-len', title: t("{0} words · {1} pages", meta.words, meta.length) }, t("{0} pg", meta.length)) : null,
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
        e.dataTransfer!.effectAllowed = 'move';
        e.dataTransfer!.setData('text/plain', it.heading);
        // Changing style before the browser has captured its native drag image is what makes
        // dragging stutter badly on Windows; deferring it a tick keeps the capture fast.
        const ids = this.app.scenesFor(it).map((m) => m.id);
        setTimeout(() => { for (const id of ids) this.cardEl(id)?.classList.add('dragging'); }, 0);
      });
      card.addEventListener('dragend', () => {
        this.dragId = null;
        this.grid.querySelectorAll('.dragging').forEach((x) => x.classList.remove('dragging'));
        this.clearDrop();
      });
      card.addEventListener('dragover', (e) => {
        if (this.dragSec) {
          const [lo, hi] = sectionRange(this.app, this.dragSec);
          if (k < lo || k > hi) return;
          e.preventDefault();
          this.scheduleDrop(card, 'before');
          return;
        }
        if (!this.dragId || this.dragId === it.id || (this.app.sceneSel.size > 1 && this.app.sceneSel.has(it.id) && this.app.sceneSel.has(this.dragId))) return;
        e.preventDefault();
        const r = card.getBoundingClientRect();
        const after = e.clientX > r.left + r.width / 2;
        this.scheduleDrop(card, after ? 'after' : 'before');
      });
      card.addEventListener('drop', (e) => {
        e.preventDefault();
        this.clearDrop();
        if (this.dragSec) {
          const sec = this.dragSec;
          this.dragSec = null;
          moveSection(this.app, sec, k);
          return;
        }
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
    divider(items.length);
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
    // Lengths come from the real pagination (shared with the timeline).
    const pos = o.showLength ? positions(this.app).scenes : [];
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
      out.set(it.id, { characters: characters.slice(0, 5).concat(characters.length > 5 ? [`+${characters.length - 5}`] : []), words, length: eighths(pos[idx]?.length ?? 0) });
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
        { head: t("Card size") },
        ...(['small', 'medium', 'large'] as const).map((v) => ({ label: mark(o.size === v, t(v[0].toUpperCase() + v.slice(1))), run: () => set({ size: v }) })),
        { head: t("Scene color") },
        ...([
          ['stripe', 'Stripe'],
          ['tint', 'Tinted card'],
          ['header', 'Colored header'],
          ['full', 'Filled card'],
        ] as const).map(([v, l]) => ({ label: mark(o.colorStyle === v, t(l)), run: () => set({ colorStyle: v }) })),
        { head: t("Show") },
        { label: mark(o.showSummary, t("Summary")), run: () => set({ showSummary: !o.showSummary }) },
        { label: mark(o.showCharacters, t("Characters")), run: () => set({ showCharacters: !o.showCharacters }) },
        { label: mark(o.showStatus, t("Status")), run: () => set({ showStatus: !o.showStatus }) },
        { label: mark(o.showLength, t("Length in pages")), run: () => set({ showLength: !o.showLength }) },
        { sep: true },
        { label: mark(o.tintOutline, t("Tint scene rows in the outline")), run: () => set({ tintOutline: !o.tintOutline }) },
        { label: mark(o.actsInOutline, t("Acts and sequences in the scene list")), run: () => set({ actsInOutline: !o.actsInOutline }) },
      ],
      anchor.getBoundingClientRect(),
    );
  }

  /** The card with the keyboard cursor (shown in the notes pane while Cards is open). */
  currentItem(): SceneItem | undefined {
    return this.app.scenes.find((s) => s.id === this.selected && s.kind === 'scene');
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
    const cards = Array.from(this.grid.querySelectorAll<HTMLElement>('.card'));
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
      { label: t("Open scene"), run: () => this.openScene(it) },
      { label: t("Edit summary & notes…"), run: () => {
        // Stays in Cards: the notes pane shows this scene and takes the typing.
        this.select(it.id);
        this.app.showRightTab('scene');
        this.app.rightPane.focusSummary();
      } },
      { label: t("Move to Archive"), run: () => this.app.archiveScenes([it]) },
      { sep: true },
      { head: t("Status") },
      ...Object.entries(STATUS_LABELS).map(([k, label]) => ({ label: (rec?.status ?? '') === k ? `✓ ${label}` : `   ${label}`, run: () => this.app.updateSceneRecord(it, { status: k as SceneStatus }) })),
      { head: t("Color") },
      ...SCENE_COLORS.map((c) => ({ label: c.name, dot: c.value, run: () => this.app.updateSceneRecord(it, { color: c.value }) })),
      { label: t("No color"), run: () => this.app.updateSceneRecord(it, { color: undefined }) },
      ...sceneStructureMenu(this.app, it),
    ];
    openMenu(items, { x, y });
  }
}
