// Story structure in the app: acts and sequences (Fountain sections in the text), story beats
// placed on scenes, and the timeline that shows both against a story model.

import type { App, SceneItem } from '../app';
import { h, uid } from './dom';
import { MenuItem, openMenu, promptDialog, toast } from './overlay';
import { newKey } from '../../shared/doc';
import { paginate } from '../../shared/paginate';
import { StructureState } from '../../shared/types';
import {
  CUSTOM_MODEL_ID,
  STORY_MODELS,
  ScenePosition,
  StorySection,
  StoryModel,
  deltaLabel,
  modelFor,
  pageNumberAt,
  placeBeats,
  scenePositions,
  sectionsOf,
} from '../../shared/structure';
import { projectExportSettings } from './export';

// ------------------------------------------------------------------------------------
// State

export function structureState(app: App): StructureState {
  const m = app.project!.meta;
  if (!m.structure) m.structure = { model: 'three-act', beats: {}, custom: [] };
  m.structure.beats ??= {};
  m.structure.custom ??= [];
  return m.structure;
}

export function currentModel(app: App): StoryModel {
  const st = app.project?.meta.structure;
  return modelFor(st?.model ?? 'three-act', st?.custom ?? []);
}

export function sceneItems(app: App): SceneItem[] {
  return app.scenes.filter((s) => s.kind === 'scene');
}

/** Beats of the current model that are placed on this scene. */
export function beatsOn(app: App, sceneId: string) {
  const st = app.project?.meta.structure;
  if (!st) return [];
  return currentModel(app).beats.filter((b) => st.beats[b.id] === sceneId);
}

export function setBeat(app: App, beatId: string, sceneId: string | undefined, name = '') {
  app.undoable(() => {
    const st = structureState(app);
    if (sceneId) st.beats[beatId] = sceneId;
    else delete st.beats[beatId];
    app.markMetaDirty();
  }, sceneId ? `Place ${name || 'Beat'}` : `Remove ${name || 'Beat'}`);
  app.structureChanged();
}

export function setModel(app: App, id: string) {
  app.undoable(() => {
    structureState(app).model = id;
    app.markMetaDirty();
  }, 'Story Model');
  app.structureChanged();
}

export function sections(app: App): StorySection[] {
  return sectionsOf(app.editor.parsed, app.editor.lineTexts);
}

// ------------------------------------------------------------------------------------
// Acts and sequences: lines in the screenplay ("# Act Two", "## The heist")

const levelName = (level: number) => (level === 1 ? 'act' : level === 2 ? 'sequence' : 'section');

/** The section that starts at this scene (same level), if any. */
export function sectionAt(app: App, it: SceneItem, level: number): StorySection | undefined {
  const idx = sceneItems(app).findIndex((s) => s.id === it.id);
  return sections(app).find((s) => s.level === level && s.firstScene === idx);
}

export async function startSection(app: App, it: SceneItem, level: 1 | 2) {
  const existing = sectionAt(app, it, level);
  if (existing) return renameSection(app, existing);
  const idx = sceneItems(app).findIndex((s) => s.id === it.id);
  const before = sections(app).filter((s) => s.level === level && s.firstScene <= idx).length;
  const kind = levelName(level);
  const title = (await promptDialog(level === 1 ? 'Start an act here' : 'Start a sequence here', 'Title', level === 1 ? `Act ${before + 1}` : `Sequence ${before + 1}`, { okLabel: 'Start' }))?.trim();
  if (!title) return;
  const ed = app.editor;
  ed.history.seal();
  ed.edit((tx) => {
    const at = tx.lines.findIndex((l) => l.key === it.key);
    if (at < 0) return;
    const ins = [{ key: newKey(), text: `${'#'.repeat(level)} ${title}` }, { key: newKey(), text: '' }];
    if (at > 0 && tx.lines[at - 1].text.trim() !== '') ins.unshift({ key: newKey(), text: '' });
    tx.insertLines(at, ins);
    return ed.sel;
  });
  ed.history.seal();
  app.refreshDerived(true);
  app.structureChanged();
  toast(`The ${kind} “${title}” starts at scene ${it.number}.`, { actions: [{ label: 'Undo', run: () => app.undoRedo('undo') }] });
}

export async function renameSection(app: App, sec: StorySection) {
  const title = (await promptDialog(`Rename ${levelName(sec.level)}`, 'Title', sec.title, { okLabel: 'Rename' }))?.trim();
  if (!title || title === sec.title) return;
  const key = app.editor.lines[sec.line].key;
  app.editor.edit((tx) => {
    const i = tx.lines.findIndex((l) => l.key === key);
    if (i >= 0) tx.setLine(i, `${'#'.repeat(sec.level)} ${title}`);
    return app.editor.sel;
  });
  app.refreshDerived(true);
  app.structureChanged();
}

export function removeSection(app: App, sec: StorySection) {
  const key = app.editor.lines[sec.line].key;
  app.editor.edit((tx) => {
    const i = tx.lines.findIndex((l) => l.key === key);
    if (i < 0) return;
    // Take one blank line with it, so no double gap is left behind.
    const nextBlank = i + 1 < tx.lines.length && tx.lines[i + 1].text.trim() === '';
    const prevBlank = i > 0 && tx.lines[i - 1].text.trim() === '';
    if (nextBlank && (prevBlank || i === 0)) tx.removeLines(i, 2);
    else if (prevBlank) tx.removeLines(i - 1, 2);
    else tx.removeLines(i, 1);
    if (!tx.lines.length) tx.insertLines(0, [{ key: newKey(), text: '' }]);
    const sel = app.editor.sel;
    const clamp = (p: { line: number; ch: number }) => ({ line: Math.min(p.line, tx.lines.length - 1), ch: p.ch });
    return { anchor: clamp(sel.anchor), head: clamp(sel.head) };
  });
  app.refreshDerived(true);
  app.structureChanged();
  toast(`The ${levelName(sec.level)} “${sec.title}” was removed; its scenes stay.`, { actions: [{ label: 'Undo', run: () => app.undoRedo('undo') }] });
}

export function sectionMenu(app: App, sec: StorySection): MenuItem[] {
  const items = sceneItems(app);
  const first = items[sec.firstScene];
  return [
    { head: `${sec.level === 1 ? 'Act' : 'Sequence'}: ${sec.title}` },
    ...(first ? [{ label: 'Go to its first scene', run: () => { app.closePanel(false); app.goToScene(first); } }] : []),
    { label: 'Select its scenes', run: () => app.setSceneSelection(items.slice(sec.firstScene, sec.endScene).map((s) => s.id), first?.id ?? null) },
    { sep: true },
    { label: 'Rename…', run: () => void renameSection(app, sec) },
    { label: `Remove this ${levelName(sec.level)} (scenes stay)`, run: () => removeSection(app, sec) },
  ];
}

/** Structure items for a card's or a scene's context menu. */
export function sceneStructureMenu(app: App, it: SceneItem, opts: { beats?: boolean } = {}): MenuItem[] {
  const model = currentModel(app);
  const st = app.project!.meta.structure;
  const act = sectionAt(app, it, 1);
  const seq = sectionAt(app, it, 2);
  const beatItems: MenuItem[] = opts.beats === false ? [] : [
    { head: `Story beat · ${model.name}` },
    ...model.beats.map((b) => {
      const here = st?.beats[b.id] === it.id;
      return { label: `${here ? '✓' : '  '} ${b.name}`, run: () => setBeat(app, b.id, here ? undefined : it.id, b.name) };
    }),
    ...(model.beats.length ? [] : [{ label: 'This model has no beats yet', disabled: true }]),
  ];
  return [
    ...beatItems,
    { head: 'Acts and sequences' },
    act ? { label: `Rename act “${act.title}”…`, run: () => void renameSection(app, act) } : { label: 'Start an act here…', run: () => void startSection(app, it, 1) },
    seq ? { label: `Rename sequence “${seq.title}”…`, run: () => void renameSection(app, seq) } : { label: 'Start a sequence here…', run: () => void startSection(app, it, 2) },
    ...(act ? [{ label: `Remove act “${act.title}”`, run: () => removeSection(app, act) }] : []),
    ...(seq ? [{ label: `Remove sequence “${seq.title}”`, run: () => removeSection(app, seq) }] : []),
  ];
}

// ------------------------------------------------------------------------------------
// Own model

async function askPosition(current?: number): Promise<number | null> {
  const v = await promptDialog('Typical position', 'Where the beat typically lands, in % of the running time', current != null ? String(Math.round(current * 100)) : '', {
    okLabel: 'OK',
    placeholder: 'e.g. 25',
    validate: (s) => {
      const n = Number(s.replace('%', '').replace(',', '.').trim());
      return Number.isFinite(n) && n >= 0 && n <= 100 ? null : 'A number from 0 to 100.';
    },
  });
  if (v == null) return null;
  return Number(v.replace('%', '').replace(',', '.').trim()) / 100;
}

export async function addCustomBeat(app: App) {
  const name = (await promptDialog('Add a beat', 'Name', '', { okLabel: 'Next', placeholder: 'e.g. Point of no return' }))?.trim();
  if (!name) return;
  const at = await askPosition();
  if (at == null) return;
  app.undoable(() => {
    structureState(app).custom.push({ id: uid(), name, at });
    app.markMetaDirty();
  }, 'Add Beat');
  app.structureChanged();
}

async function editCustomBeat(app: App, id: string) {
  const b = structureState(app).custom.find((x) => x.id === id);
  if (!b) return;
  const name = (await promptDialog('Rename beat', 'Name', b.name, { okLabel: 'Next' }))?.trim();
  if (!name) return;
  const at = await askPosition(b.at);
  if (at == null) return;
  app.undoable(() => {
    b.name = name;
    b.at = at;
    app.markMetaDirty();
  }, 'Edit Beat');
  app.structureChanged();
}

function deleteCustomBeat(app: App, id: string) {
  app.undoable(() => {
    const st = structureState(app);
    st.custom = st.custom.filter((x) => x.id !== id);
    delete st.beats[id];
    app.markMetaDirty();
  }, 'Delete Beat');
  app.structureChanged();
}

// ------------------------------------------------------------------------------------
// Positions (from the real pagination)

let posCache: { key: string; value: { scenes: ScenePosition[]; total: number } } | null = null;

export function positions(app: App): { scenes: ScenePosition[]; total: number } {
  const ed = app.editor;
  const key = `${ed.version}|${JSON.stringify(app.project?.meta.exportSettings ?? null)}`;
  if (posCache?.key === key) return posCache.value;
  const s = projectExportSettings(app);
  const r = paginate(ed.lineTexts, ed.parsed, { ...s, titlePage: false }, { kind: 'all' });
  const value = scenePositions(r.pages, r.capacity.linesPerPage, ed.parsed.scenes.map((sc) => sc.line));
  posCache = { key, value };
  return value;
}

// ------------------------------------------------------------------------------------
// Timeline

const GUTTER = 188;

export class Timeline {
  el: HTMLElement;
  private scroll: HTMLElement;
  private head: HTMLElement;
  /** Pixels per page; null = fit the width. */
  private ppp: number | null = null;
  private ro: ResizeObserver;
  private lastWidth = 0;

  constructor(
    private app: App,
    private hooks: { cursor(): string | null; setCursor(id: string): void; menu(it: SceneItem, x: number, y: number): void; open(it: SceneItem): void },
  ) {
    this.head = h('div', { class: 'tl-head' });
    this.scroll = h('div', { class: 'tl-scroll', tabindex: '0', 'aria-label': 'Timeline' });
    this.scroll.addEventListener('keydown', (e) => this.onKey(e));
    this.el = h('div', { class: 'timeline hidden' }, this.head, this.scroll);
    this.ro = new ResizeObserver(() => {
      const w = this.scroll.clientWidth;
      if (this.ppp == null && Math.abs(w - this.lastWidth) > 2 && !this.el.classList.contains('hidden')) this.render();
    });
    this.ro.observe(this.scroll);
  }

  show(on: boolean) {
    this.el.classList.toggle('hidden', !on);
    if (on) {
      this.render();
      this.scroll.focus();
    }
  }

  focus() {
    this.scroll.focus();
  }

  private zoomBy(f: number) {
    const cur = this.ppp ?? this.fitPpp();
    this.ppp = Math.max(4, Math.min(80, cur * f));
    this.render();
  }

  private fitPpp(): number {
    const { total } = positions(this.app);
    const w = Math.max(200, this.scroll.clientWidth - GUTTER - 28);
    return total > 0 ? w / total : 10;
  }

  render() {
    if (!this.app.project || this.el.classList.contains('hidden')) return;
    const app = this.app;
    const st = app.project!.meta.structure;
    const model = currentModel(app);
    const items = sceneItems(app);
    const { scenes: pos, total } = positions(app);
    this.lastWidth = this.scroll.clientWidth;
    const ppp = this.ppp ?? this.fitPpp();
    const W = Math.max(100, Math.round(total * ppp));
    const x = (p: number) => Math.round(p * ppp);
    const scrollLeft = this.scroll.scrollLeft;
    const scrollTop = this.scroll.scrollTop;

    // Head: the model and zoom ------------------------------------------------------
    const modelSel = h('select', { class: 'field', 'aria-label': 'Story model' });
    for (const m of STORY_MODELS) modelSel.append(h('option', { value: m.id }, m.name));
    modelSel.append(h('option', { value: CUSTOM_MODEL_ID }, 'Own model'));
    modelSel.value = model.id;
    modelSel.addEventListener('change', () => setModel(app, modelSel.value));
    this.head.replaceChildren(
      h('label', { class: 'tl-model' }, h('span', { class: 'dim' }, 'Story model'), modelSel),
      h('span', { class: 'tl-about dim' }, model.about),
      h('span', { class: 'spacer' }),
      ...(model.id === CUSTOM_MODEL_ID ? [h('button', { class: 'btn sm', onclick: () => void addCustomBeat(app) }, 'Add beat…')] : []),
      h(
        'span',
        { class: 'zoom-bar inline' },
        h('button', { class: 'icon-btn', title: 'Zoom out', 'aria-label': 'Zoom out', onclick: () => this.zoomBy(1 / 1.4) }, '−'),
        h('button', { class: 'btn sm zoom-label', title: 'Fit to width', onclick: () => { this.ppp = null; this.render(); } }, this.ppp == null ? 'Fit' : `${Math.round(ppp)} px/page`),
        h('button', { class: 'icon-btn', title: 'Zoom in', 'aria-label': 'Zoom in', onclick: () => this.zoomBy(1.4) }, '+'),
      ),
    );

    const lanes: HTMLElement[] = [];
    const lane = (label: Node | string, track: HTMLElement, cls = '') => {
      const row = h('div', { class: `tl-lane ${cls}` }, h('div', { class: 'tl-label' }, label), track);
      track.classList.add('tl-track');
      track.style.width = `${W}px`;
      lanes.push(row);
      return row;
    };

    // Ruler ------------------------------------------------------------------------
    const ruler = h('div', { class: 'tl-ruler' });
    const step = [1, 2, 5, 10, 20, 50].find((s) => s * ppp >= 44) ?? 100;
    // A tick marks the top of a page, labelled with its page number (1, 5, 10 …).
    ruler.append(h('span', { class: 'tl-tick', style: { left: '0px' } }, '1'));
    for (let n = step; n < total; n += step) ruler.append(h('span', { class: 'tl-tick', style: { left: `${x(n - 1)}px` } }, String(n)));
    const pagesTotal = Math.max(1, Math.round(total));
    lane(h('span', { class: 'dim' }, `${pagesTotal} ${pagesTotal === 1 ? 'page' : 'pages'}`), ruler, 'ruler');

    // The model's parts ---------------------------------------------------------------
    if (model.phases.length) {
      const t = h('div');
      model.phases.forEach((ph, i) =>
        t.append(h('div', { class: `tl-band model${i % 2 ? ' alt' : ''}`, style: { left: `${x(ph.from * total)}px`, width: `${Math.max(1, x((ph.to - ph.from) * total))}px` }, title: `${ph.name} (typical: pages ${Math.round(ph.from * total) || 1}–${Math.round(ph.to * total)})` }, h('span', null, ph.name))),
      );
      lane(h('span', null, model.name, h('span', { class: 'tl-sub' }, 'typical')), t, 'model');
    }

    // Your acts and sequences -----------------------------------------------------------
    const secs = sections(app);
    for (const level of [1, 2]) {
      const list = secs.filter((s) => s.level === level);
      if (level === 2 && !list.length) continue;
      const t = h('div');
      list.forEach((sec, i) => {
        const from = pos[sec.firstScene]?.start ?? total;
        const to = sec.endScene < pos.length ? pos[sec.endScene].start : total;
        const band = h('div', { class: `tl-band act${i % 2 ? ' alt' : ''}`, style: { left: `${x(from)}px`, width: `${Math.max(2, x(to - from))}px` }, title: `${sec.title} · pages ${pageNumberAt(from)}–${Math.max(pageNumberAt(from), Math.ceil(to))}` }, h('span', null, sec.title));
        band.addEventListener('click', () => app.setSceneSelection(items.slice(sec.firstScene, sec.endScene).map((s) => s.id), items[sec.firstScene]?.id ?? null));
        band.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          openMenu(sectionMenu(app, sec), { x: e.clientX, y: e.clientY });
        });
        t.append(band);
      });
      if (!list.length) t.append(h('div', { class: 'tl-empty' }, 'No acts yet. Right-click a scene to start an act there. Acts are sections in the text (# Act Two).'));
      lane(level === 1 ? 'Your acts' : 'Sequences', t, 'acts');
    }

    // Scenes -------------------------------------------------------------------------------
    const scenesTrack = h('div');
    const cur = this.hooks.cursor();
    items.forEach((it, i) => {
      const p = pos[i];
      if (!p) return;
      const color = it.record?.color;
      const w = Math.max(2, x(p.length) - 1);
      const block = h(
        'div',
        {
          class: `tl-scene${color ? ' has-color' : ''}${app.sceneSel.has(it.id) ? ' selected' : ''}${cur === it.id ? ' cursor' : ''}`,
          style: { left: `${x(p.start)}px`, width: `${w}px` },
          dataset: { id: it.id },
          title: `${it.number}  ${it.heading}\npage ${pageNumberAt(p.start)} · ${Math.round(p.length * 8) / 8} pages`,
        },
        w > 18 ? h('span', null, it.number) : null,
      );
      if (color) block.style.setProperty('--scene', color);
      block.addEventListener('click', (e) => {
        this.hooks.setCursor(it.id);
        app.clickSelect(it, e, items);
        this.scroll.focus();
      });
      block.addEventListener('dblclick', () => this.hooks.open(it));
      block.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (!app.sceneSel.has(it.id)) {
          this.hooks.setCursor(it.id);
          app.setSceneSelection([it.id], it.id);
        }
        this.hooks.menu(it, e.clientX, e.clientY);
      });
      scenesTrack.append(block);
    });
    lane('Scenes', scenesTrack, 'scenes');

    // Beats: typical place (hollow) and where the beat is in this script (filled) ------------
    const idxOf = new Map(items.map((it, i) => [it.id, i]));
    const placed = placeBeats(
      model,
      Object.fromEntries(Object.entries(st?.beats ?? {}).map(([b, id]) => [b, idxOf.get(id)])),
      pos,
      total,
    );
    for (const bp of placed) {
      const t = h('div');
      if (bp.beat.to != null) t.append(h('div', { class: 'tl-stretch', style: { left: `${x(bp.typical)}px`, width: `${Math.max(2, x((bp.beat.to - bp.beat.at) * total))}px` } }));
      if (bp.actual != null) {
        const a = x(bp.actual);
        const tp = x(bp.typical);
        t.append(h('div', { class: 'tl-link', style: { left: `${Math.min(a, tp)}px`, width: `${Math.abs(a - tp)}px` } }));
      }
      const typ = h('div', { class: 'tl-mark typical', style: { left: `${x(bp.typical)}px` }, title: `${bp.beat.name}: typically around page ${Math.round(bp.typical) || 1}${bp.actual == null ? ' · drag onto a scene to place it' : ''}` });
      t.append(typ);
      let act: HTMLElement | null = null;
      if (bp.actual != null) {
        act = h('div', { class: 'tl-mark actual', style: { left: `${x(bp.actual)}px` }, title: `${bp.beat.name}: scene ${items[bp.scene!].number}, page ${pageNumberAt(bp.actual)} · ${deltaLabel(bp.delta!)} · drag to another scene` });
        t.append(act);
      }
      this.dragMarker(act ?? typ, t, bp.beat.id, bp.beat.name, pos, ppp);
      const name = h('span', { class: 'tl-beat-name' }, bp.beat.name);
      const detail = h(
        'span',
        { class: 'tl-sub' },
        bp.actual != null ? `p. ${pageNumberAt(bp.actual)} · ${deltaLabel(bp.delta!)}` : `typical p. ${Math.round(bp.typical) || 1} · not placed`,
      );
      const label = h('button', { class: `tl-beat${bp.actual == null ? ' unplaced' : ''}`, title: bp.beat.hint ?? '' }, name, detail);
      label.addEventListener('click', (e) => this.beatMenu(bp.beat.id, bp.beat.name, bp.scene, e));
      label.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.beatMenu(bp.beat.id, bp.beat.name, bp.scene, e);
      });
      lane(label, t, 'beat');
    }
    if (!placed.length) lane(h('span', { class: 'dim' }, 'No beats'), h('div', null, h('div', { class: 'tl-empty' }, model.id === CUSTOM_MODEL_ID ? 'Add the beats of your own model with “Add beat…”.' : '')), 'beat');

    const canvas = h('div', { class: 'tl-canvas' }, ...lanes);
    canvas.style.setProperty('--gutter', `${GUTTER}px`);
    this.scroll.replaceChildren(canvas);
    this.scroll.scrollLeft = scrollLeft;
    this.scroll.scrollTop = scrollTop;
  }

  /** Drag a beat marker along its row; it lands on the scene under the pointer. */
  private dragMarker(mark: HTMLElement, track: HTMLElement, beatId: string, name: string, pos: ScenePosition[], ppp: number) {
    mark.classList.add('draggable');
    mark.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      mark.setPointerCapture(e.pointerId);
      const ghost = h('div', { class: 'tl-mark actual ghost' });
      track.append(ghost);
      const sceneAt = (clientX: number) => {
        const r = track.getBoundingClientRect();
        const p = (clientX - r.left) / ppp;
        let k = pos.findIndex((s) => p >= s.start && p < s.start + s.length);
        if (k < 0) k = p < 0 ? 0 : pos.length - 1;
        return k;
      };
      const move = (ev: PointerEvent) => {
        const k = sceneAt(ev.clientX);
        if (k >= 0) ghost.style.left = `${Math.round(pos[k].start * ppp)}px`;
      };
      move(e);
      const up = (ev: PointerEvent) => {
        mark.removeEventListener('pointermove', move);
        mark.removeEventListener('pointerup', up);
        ghost.remove();
        const k = sceneAt(ev.clientX);
        const it = sceneItems(this.app)[k];
        if (it && this.app.project?.meta.structure?.beats[beatId] !== it.id) setBeat(this.app, beatId, it.id, name);
      };
      mark.addEventListener('pointermove', move);
      mark.addEventListener('pointerup', up);
    });
  }

  private beatMenu(beatId: string, name: string, scene: number | undefined, e: MouseEvent) {
    const app = this.app;
    const items = sceneItems(app);
    const placedOn = scene != null ? items[scene] : undefined;
    const sel = items.filter((s) => app.sceneSel.has(s.id));
    const target = sel.length === 1 ? sel[0] : undefined;
    const model = currentModel(app);
    const hint = model.beats.find((b) => b.id === beatId)?.hint;
    const menu: MenuItem[] = [
      { head: name },
      ...(hint ? [{ label: hint, disabled: true }] : []),
      ...(target && target !== placedOn ? [{ label: `Place on scene ${target.number}`, run: () => setBeat(app, beatId, target.id, name) }] : []),
      ...(placedOn
        ? [
            { label: `Show scene ${placedOn.number}`, run: () => { this.hooks.setCursor(placedOn.id); app.setSceneSelection([placedOn.id], placedOn.id); } },
            { label: 'Remove from the scene', run: () => setBeat(app, beatId, undefined, name) },
          ]
        : []),
      ...(!target && !placedOn ? [{ label: 'Select a scene, or drag the marker onto one', disabled: true }] : []),
      ...(model.id === CUSTOM_MODEL_ID
        ? [{ sep: true }, { label: 'Edit beat…', run: () => void editCustomBeat(app, beatId) }, { label: 'Delete beat', run: () => deleteCustomBeat(app, beatId) }]
        : []),
    ];
    openMenu(menu, { x: e.clientX, y: e.clientY });
  }

  private onKey(e: KeyboardEvent) {
    const items = sceneItems(this.app);
    if (!items.length) return;
    let i = Math.max(0, items.findIndex((s) => s.id === this.hooks.cursor()));
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      i = Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowLeft' ? -1 : 1)));
      this.hooks.setCursor(items[i].id);
      if (e.shiftKey && this.app.sceneSelAnchor) {
        const a = items.findIndex((s) => s.id === this.app.sceneSelAnchor);
        const [lo, hi] = a < i ? [a, i] : [i, a];
        this.app.setSceneSelection(items.slice(lo, hi + 1).map((s) => s.id), this.app.sceneSelAnchor);
      } else this.app.setSceneSelection([items[i].id], items[i].id);
      this.scroll.querySelector(`.tl-scene[data-id="${items[i].id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } else if (e.key === 'Enter') this.hooks.open(items[i]);
    else if (e.key === '+' || e.key === '=') this.zoomBy(1.4);
    else if (e.key === '-') this.zoomBy(1 / 1.4);
    else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      const r = this.scroll.querySelector(`.tl-scene[data-id="${items[i].id}"]`)?.getBoundingClientRect();
      if (r) this.hooks.menu(items[i], r.left + 4, r.bottom);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }

  /** Marks selection without rebuilding. */
  applySelection() {
    const cur = this.hooks.cursor();
    this.scroll.querySelectorAll<HTMLElement>('.tl-scene').forEach((b) => {
      b.classList.toggle('selected', this.app.sceneSel.has(b.dataset.id!));
      b.classList.toggle('cursor', b.dataset.id === cur);
    });
  }
}

