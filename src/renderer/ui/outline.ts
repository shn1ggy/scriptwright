// Scene outline: compact single-line rows with order numbers, search, keyboard
// navigation, drag-and-drop and keyboard reordering.

import { sceneStructureMenu, sectionMenu, sections } from './structure';
import { archivedSceneMenu, openArchivedScene } from './scenearchive';
import type { StorySection } from '../../shared/structure';
import type { App, SceneItem } from '../app';
import { h, icon, iconButton, withClear } from './dom';
import { MenuItem, openMenu } from './overlay';
import { SceneStatus } from '../../shared/types';
import { isMac } from '../bridge';
import { t, tn, uiLocale } from '../../shared/i18n';

export const SCENE_COLORS: Array<{ name: string; value: string }> = [
  { name: t('Red'), value: '#E5706B' },
  { name: t('Orange'), value: '#E39B5B' },
  { name: t('Yellow'), value: '#E3C566' },
  { name: t('Green'), value: '#7FC48D' },
  { name: t('Blue'), value: '#6FA8E8' },
  { name: t('Purple'), value: '#B48DE0' },
];

export const STATUS_LABELS: Record<SceneStatus, string> = { '': t('No status'), draft: t('Draft'), revise: t('Needs work'), done: t('Done') };

export class OutlinePane {
  el: HTMLElement;
  private list: HTMLElement;
  private search: HTMLInputElement;
  private countEl: HTMLElement;
  private lockEl: HTMLElement;
  private collapser: HTMLButtonElement;
  private chevron: HTMLElement;
  private searchBox: HTMLElement;
  private collapsed = false;
  private rows = new Map<string, HTMLElement>();
  private selectedId: string | null = null;
  private lastSig = '';
  private dragId: string | null = null;
  /** Act and sequence rows with the scenes they hold (for marking a folded one as current). */
  private actRows: Array<{ row: HTMLElement; first: number; end: number }> = [];

  constructor(private app: App) {
    this.search = h('input', { class: 'field', placeholder: t("Search scenes (text, names, notes)"), 'aria-label': t("Search scenes"), spellcheck: 'false' });
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
        this.search.dispatchEvent(new Event('input'));
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
    this.chevron = h('span', { class: 'collapse-mark', 'aria-hidden': 'true' }, icon('chevronDown'));
    this.collapser = h('button', { class: 'collapser', tabindex: '-1', title: t("Show or hide the scenes"), 'aria-expanded': 'true', onclick: () => this.toggleCollapsed() }, t("Scenes"), this.chevron);
    this.searchBox = h('div', { class: 'outline-search' }, withClear(this.search));
    this.lockEl = h('span', { class: 'lock-mark hidden', title: t("Scene numbers are locked: new scenes get letters (12A), removed scenes stay as omitted.") }, icon('lock'));
    this.list = h('div', { class: 'list', tabindex: '0', role: 'listbox', 'aria-label': t("Scenes") });
    this.list.addEventListener('keydown', (e) => this.onKey(e));
    this.el = h(
      'div',
      { class: 'outline' },
      h('div', { class: 'section-head' }, this.collapser, this.countEl, this.lockEl, h('span', { class: 'spacer' }), iconButton('plus', t("New scene after current"), () => this.app.run('scene.new')), iconButton('more', t("Scene actions"), (e) => this.moreMenu(e.currentTarget as HTMLElement))),
      this.searchBox,
      this.list,
    );
  }

  /** Folds the scene list away (like Projects), leaving only its header. */
  setCollapsed(c: boolean) {
    this.collapsed = c;
    this.el.classList.toggle('collapsed', c);
    this.searchBox.classList.toggle('hidden', c);
    this.list.classList.toggle('hidden', c);
    this.chevron.replaceChildren(icon(c ? 'chevronRight' : 'chevronDown'));
    this.collapser.setAttribute('aria-expanded', String(!c));
  }

  private toggleCollapsed() {
    this.app.state.layout.scenesCollapsed = !this.collapsed;
    this.setCollapsed(!this.collapsed);
    this.app.saveStateSoon();
  }

  private moreMenu(anchor: HTMLElement) {
    const has = !!this.app.project;
    const cmd = (id: string, label: string) => ({ label, kbd: this.app.commands.label(id), disabled: !has, run: () => this.app.run(id) });
    openMenu(
      [
        cmd('scene.new', t("New Scene After Current")),
        cmd('search.scenes', t("Search Scenes")),
        { sep: true },
        cmd('view.cards', t("Scene Cards")),
        { label: t("Select All Scenes"), disabled: !has, run: () => {
          const sc = this.app.scenes.filter((s) => s.kind === 'scene');
          this.app.setSceneSelection(sc.map((s) => s.id), sc[0]?.id ?? null);
          this.list.focus();
        } },
        { sep: true },
        { label: t("{0} Show Acts and Sequences", this.app.settings.cards.actsInOutline ? '✓' : '  '), run: () => {
          this.app.settings.cards.actsInOutline = !this.app.settings.cards.actsInOutline;
          this.app.saveSettings();
          this.refresh();
        } },
        { sep: true },
        this.app.numbersLocked ? cmd('scene.unlockNumbers', t("Unlock Scene Numbers…")) : cmd('scene.lockNumbers', t("Lock Scene Numbers")),
        cmd('scene.writtenNumbers', t("Scene Numbers in Fountain Text…")),
      ],
      anchor.getBoundingClientRect(),
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

  private textCache: { version: number; map: Map<string, string> } = { version: -1, map: new Map() };

  /** The scene's whole text in lower case (cached per document version). */
  private sceneText(it: SceneItem): string {
    const ed = this.app.editor;
    if (this.textCache.version !== ed.version) this.textCache = { version: ed.version, map: new Map() };
    let t = this.textCache.map.get(it.id);
    if (t === undefined) {
      t = ed.lines.slice(it.line, Math.max(it.end, it.line + 1)).map((l) => l.text).join('\n').toLowerCase();
      this.textCache.map.set(it.id, t);
    }
    return t;
  }

  /** How often the search occurs in the scene's text, summary and notes. */
  private matchCount(it: SceneItem, q: string): number {
    const hay = `${this.sceneText(it)}\n${it.record?.summary ?? ''}\n${it.record?.notes ?? ''}`.toLowerCase();
    let n = 0;
    for (let i = hay.indexOf(q); i >= 0; i = hay.indexOf(q, i + q.length)) n++;
    return n;
  }

  /**
   * Scene search looks at everything that belongs to a scene: heading, number, summary,
   * notes and the full text (action, dialogue, character names).
   */
  private visibleItems(): SceneItem[] {
    const q = this.search.value.trim().toLowerCase();
    if (!q) {
      const hidden = this.foldedScenes();
      return hidden.size ? this.app.scenes.filter((s) => !hidden.has(s.id)) : this.app.scenes;
    }
    return this.app.scenes.filter((s) => {
      const meta = `${s.number || ''} ${s.sceneNumber ?? ''}`.toLowerCase();
      return meta.split(' ').includes(q) || this.matchCount(s, q) > 0;
    });
  }

  private actsShown(): boolean {
    return !!this.app.project && this.app.settings.cards.actsInOutline && !this.search.value.trim();
  }

  private foldKey(sec: StorySection): string {
    return `${sec.level}:${sec.title}`;
  }

  /** Scenes inside a folded act or sequence (not listed while it is folded). */
  private foldedScenes(): Set<string> {
    const out = new Set<string>();
    if (!this.actsShown()) return out;
    const folded = new Set(this.app.state.layout.outlineFolded ?? []);
    if (!folded.size) return out;
    const scenes = this.app.scenes.filter((s) => s.kind === 'scene');
    for (const sec of sections(this.app)) if (folded.has(this.foldKey(sec))) for (const s of scenes.slice(sec.firstScene, sec.endScene)) out.add(s.id);
    return out;
  }

  private toggleFold(sec: StorySection) {
    const l = this.app.state.layout;
    const f = new Set(l.outlineFolded ?? []);
    const k = this.foldKey(sec);
    if (f.has(k)) f.delete(k);
    else f.add(k);
    l.outlineFolded = [...f];
    this.app.saveStateSoon();
    this.refresh();
  }

  render() {
    const items = this.visibleItems();
    const secs = this.actsShown() ? sections(this.app) : [];
    const q = this.search.value.trim().toLowerCase();
    const sig = (q ? `${q}|${this.app.editor.version}|` : '') + JSON.stringify((this.app.project?.meta.sceneArchive ?? []).map((a) => a.id)) + (this.app.state.layout.sceneArchiveOpen ? 'A' : '') + secs.map((x) => `${x.level}${x.title}${x.firstScene}-${x.endScene}`).join(',') + JSON.stringify(this.app.state.layout.outlineFolded ?? []) + items.map((s) => `${s.id}|${s.number}|${s.heading}|${s.record?.color ?? ''}|${s.record?.status ?? ''}|${s.record?.summary ?? ''}`).join('\n');
    const total = this.app.scenes.filter((s) => s.kind === 'scene').length;
    this.countEl.textContent = this.app.project ? String(total) : '';
    this.lockEl.classList.toggle('hidden', !this.app.project || !this.app.numbersLocked);
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
      this.list.append(h('div', { class: 'empty-note' }, this.search.value ? t("No scene contains this text") : t("No scenes yet. Write a heading such as INT. HOUSE - DAY, or use New Scene.")));
    }
    const sceneIdx = new Map(this.app.scenes.filter((s) => s.kind === 'scene').map((s, i) => [s.id, i]));
    const folded = new Set(this.app.state.layout.outlineFolded ?? []);
    const headed = new Set<StorySection>();
    this.actRows = [];
    // Headers of every act or sequence that starts at or before scene k and is not shown yet.
    const groupRows = (k: number) => {
      for (const sec of secs) {
        if (sec.firstScene > k || headed.has(sec)) continue;
        // Inside a folded act its sequences are hidden too.
        if (secs.some((o) => o !== sec && o.level < sec.level && folded.has(this.foldKey(o)) && o.firstScene <= sec.firstScene && sec.firstScene < o.endScene)) continue;
        headed.add(sec);
        const isOpen = !folded.has(this.foldKey(sec));
        const n = sec.endScene - sec.firstScene;
        const head = h(
          'div',
          { class: `row act-row lvl-${Math.min(2, sec.level)}`, role: 'button', 'aria-expanded': String(isOpen), title: `${sec.title} · ${tn(n, '{0} scene', '{0} scenes')}`, dataset: { act: this.foldKey(sec) } },
          h('span', { class: 'label' }, sec.title),
          h('span', { class: 'meta' }, String(n)),
          h('span', { class: 'collapse-mark' }, icon(isOpen ? 'chevronDown' : 'chevronRight')),
        );
        if (!isOpen) this.actRows.push({ row: head, first: sec.firstScene, end: sec.endScene });
        head.addEventListener('click', () => this.toggleFold(sec));
        head.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          openMenu(sectionMenu(this.app, sec), { x: e.clientX, y: e.clientY });
        });
        this.list.append(head);
      }
    };
    for (const it of items) {
      if (secs.length && it.kind === 'scene') groupRows(sceneIdx.get(it.id) ?? -1);
      const row = h(
        'div',
        { class: `row${it.kind !== 'scene' ? ' title-row' : ''}`, role: 'option', title: this.tooltip(it), dataset: { id: it.id } },
        // The scene colour shows as the colour of its number, so headings always line up.
        h('span', { class: `num${it.record?.color ? ' colored' : ''}`, style: it.record?.color ? { color: it.record.color } : undefined }, it.kind === 'scene' ? it.number : ''),
        h('span', { class: 'label' }, it.heading || t("(empty heading)")),
        it.record?.status ? h('span', { class: 'meta' }, it.record.status === 'done' ? '✓' : it.record.status === 'revise' ? '!' : '·') : null,
        q ? h('span', { class: 'meta match-count', title: t("Matches in this scene") }, String(this.matchCount(it, q) || '')) : null,
      );
      row.addEventListener('click', (e) => {
        this.selectedId = it.id;
        // Cmd/Ctrl-click and Shift-click only select (several scenes); a plain click also goes there.
        if (this.app.clickSelect(it, e, this.visibleItems())) this.app.goToScene(it);
        else this.list.focus();
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (!this.app.sceneSel.has(it.id)) this.select(it.id);
        this.contextMenu(it, e);
      });
      if (it.kind === 'scene') {
        row.draggable = true;
        row.addEventListener('dragstart', (e) => {
          this.dragId = it.id;
          if (!this.app.sceneSel.has(it.id)) this.select(it.id);
          for (const m of this.app.scenesFor(it)) this.rows.get(m.id)?.classList.add('dragging');
          e.dataTransfer!.effectAllowed = 'move';
          e.dataTransfer!.setData('text/plain', it.heading);
        });
        row.addEventListener('dragend', () => {
          this.dragId = null;
          for (const r of this.rows.values()) r.classList.remove('dragging');
          this.clearDrop();
        });
        row.addEventListener('dragover', (e) => {
          if (!this.dragId || this.dragId === it.id || (this.app.sceneSel.size > 1 && this.app.sceneSel.has(it.id) && this.app.sceneSel.has(this.dragId))) return;
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
          if (src) this.app.moveScenes(this.app.scenesFor(src), it, after);
        });
      }
      if (it.record?.color && this.app.settings.cards.tintOutline) {
        row.classList.add('tinted');
        row.style.setProperty('--scene', it.record.color);
      }
      this.rows.set(it.id, row);
      this.list.append(row);
    }
    if (secs.length) groupRows(sceneIdx.size);
    if (!q) this.renderArchive();
    this.list.scrollTop = scroll;
    this.updateActive();
  }

  /** Archived scenes: a foldable group at the end of the list, like the projects archive. */
  private renderArchive() {
    const arch = this.app.project?.meta.sceneArchive ?? [];
    if (!arch.length) return;
    const l = this.app.state.layout;
    const open = !!l.sceneArchiveOpen;
    const head = h(
      'div',
      { class: 'row archive-head act-row', role: 'button', 'aria-expanded': String(open), title: t("Scenes taken out of the screenplay but kept") },
      h('span', { class: 'label' }, t("Archive")),
      h('span', { class: 'meta' }, String(arch.length)),
      h('span', { class: 'collapse-mark' }, icon(open ? 'chevronDown' : 'chevronRight')),
    );
    head.addEventListener('click', () => {
      l.sceneArchiveOpen = !open;
      this.app.saveStateSoon();
      this.refresh();
    });
    this.list.append(head);
    if (!open) return;
    for (const a of arch) {
      const row = h(
        'div',
        { class: 'row archived', role: 'option', title: [a.heading, a.summary, t('Archived {0}', new Date(a.archivedAt).toLocaleDateString(uiLocale()))].filter(Boolean).join('\n') },
        h('span', { class: 'num', style: a.color ? { color: a.color } : undefined }, a.number),
        h('span', { class: 'label' }, a.heading || t("(empty heading)")),
      );
      row.addEventListener('click', () => void openArchivedScene(this.app, a.id));
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openMenu(archivedSceneMenu(this.app, a.id), { x: e.clientX, y: e.clientY });
      });
      this.list.append(row);
    }
  }

  private tooltip(it: SceneItem): string {
    const parts = [it.kind === 'scene' ? `${it.number}. ${it.heading}` : it.heading];
    if (it.sceneNumber) parts.push(t('Scene number {0}', it.sceneNumber));
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
    }
    // A folded act holding the current scene is marked instead.
    const idx = active?.kind === 'scene' ? this.app.scenes.filter((s) => s.kind === 'scene').findIndex((s) => s.id === active.id) : -1;
    for (const a of this.actRows) a.row.classList.toggle('active', idx >= a.first && idx < a.end);
    this.applySelection();
  }

  /** Marks selected rows (several when Cmd/Ctrl- or Shift-clicked). */
  applySelection() {
    for (const [id, row] of this.rows) {
      const on = this.app.sceneSel.has(id);
      row.classList.toggle('selected', on);
      row.classList.toggle('multi', on && this.app.sceneSel.size > 1);
      row.setAttribute('aria-selected', String(on));
    }
  }

  private select(id: string | null, extend = false) {
    this.selectedId = id;
    if (id && extend && this.app.sceneSelAnchor) {
      const items = this.visibleItems();
      const a = items.findIndex((s) => s.id === this.app.sceneSelAnchor);
      const b = items.findIndex((s) => s.id === id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        this.app.setSceneSelection(items.slice(lo, hi + 1).filter((s) => s.kind === 'scene').map((s) => s.id), this.app.sceneSelAnchor);
      }
    } else this.app.setSceneSelection(id ? [id] : [], id);
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
        const group = this.app.scenesFor(cur);
        const keep = [...this.app.sceneSel];
        this.app.moveScenesBy(group, e.key === 'ArrowUp' ? -1 : 1);
        this.selectedId = cur.id;
        this.app.setSceneSelection(keep, this.app.sceneSelAnchor);
        this.list.focus();
      }
    } else if (e.key === 'ArrowDown') {
      this.select(items[Math.min(items.length - 1, idx + 1)].id, e.shiftKey);
    } else if (e.key === 'ArrowUp') {
      if (idx <= 0) {
        this.search.focus();
      } else this.select(items[idx - 1].id, e.shiftKey);
    } else if ((e.key === 'a' || e.key === 'A') && (isMac ? e.metaKey : e.ctrlKey)) {
      const sc = items.filter((s) => s.kind === 'scene');
      this.app.setSceneSelection(sc.map((s) => s.id), sc[0]?.id ?? null);
    } else if (e.key === 'Home') {
      this.select(items[0].id);
    } else if (e.key === 'End') {
      this.select(items[items.length - 1].id);
    } else if (e.key === 'Enter' || e.key === ' ') {
      if (cur) this.app.goToScene(cur);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && (isMac ? e.metaKey : e.ctrlKey) && cur?.kind === 'scene') {
      // Only with Mod: a plain Delete or Backspace (e.g. while still typing) never removes scenes.
      this.app.deleteScenes(this.app.scenesFor(cur)).then(() => this.list.focus());
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
    const group = this.app.scenesFor(it);
    if (group.length > 1) return openMenu(sceneGroupMenu(this.app, group), { x: e.clientX, y: e.clientY });
    const items: MenuItem[] = [{ label: t("Go to scene"), run: () => this.app.goToScene(it) }];
    if (it.kind === 'scene') {
      const rec = it.record;
      items.push(
        { label: t("Duplicate"), run: () => this.app.duplicateScene(it) },
        { label: t("Move up"), kbd: this.app.commands.label('scene.moveUp'), run: () => this.app.moveSceneBy(it, -1) },
        { label: t("Move down"), kbd: this.app.commands.label('scene.moveDown'), run: () => this.app.moveSceneBy(it, 1) },
        { label: t("Move to Archive"), run: () => this.app.archiveScenes([it]) },
        { label: t("Remove…"), run: () => this.app.deleteScene(it) },
        { sep: true },
        { label: t("Summary & notes…"), run: () => {
          this.app.goToScene(it, { focusEditor: false });
          this.app.showRightTab('scene');
        } },
        { head: t("Status") },
      );
      for (const [k, label] of Object.entries(STATUS_LABELS)) {
        items.push({ label: (rec?.status ?? '') === k ? `✓ ${label}` : `   ${label}`, run: () => this.app.updateSceneRecord(it, { status: k as SceneStatus }) });
      }
      items.push({ head: t("Color") });
      for (const c of SCENE_COLORS) items.push({ label: c.name, dot: c.value, run: () => this.app.updateSceneRecord(it, { color: c.value }) });
      items.push({ label: t("No color"), run: () => this.app.updateSceneRecord(it, { color: undefined }) });
      items.push(...sceneStructureMenu(this.app, it, { beats: false }));
    }
    openMenu(items, { x: e.clientX, y: e.clientY });
  }
}

/** Menu for several selected scenes: status, color, move and remove for all of them. */
export function sceneGroupMenu(app: App, group: SceneItem[]): MenuItem[] {
  const n = group.length;
  const items: MenuItem[] = [
    { head: t("{0} scenes selected", n) },
    { label: t("Move up"), kbd: app.commands.label('scene.moveUp'), run: () => app.moveScenesBy(group, -1) },
    { label: t("Move down"), kbd: app.commands.label('scene.moveDown'), run: () => app.moveScenesBy(group, 1) },
    { label: t("Move to Archive"), run: () => app.archiveScenes(group) },
    { label: t("Remove…"), run: () => app.deleteScenes(group) },
    { head: t("Status") },
  ];
  const statuses = new Set(group.map((g) => g.record?.status ?? ''));
  for (const [k, label] of Object.entries(STATUS_LABELS)) {
    items.push({ label: statuses.size === 1 && statuses.has(k as SceneStatus) ? `✓ ${label}` : `   ${label}`, run: () => app.updateSceneRecords(group, { status: k as SceneStatus }) });
  }
  items.push({ head: t("Color") });
  for (const c of SCENE_COLORS) items.push({ label: c.name, dot: c.value, run: () => app.updateSceneRecords(group, { color: c.value }) });
  items.push({ label: t("No color"), run: () => app.updateSceneRecords(group, { color: undefined }) });
  return items;
}
