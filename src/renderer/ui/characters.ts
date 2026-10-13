// Characters: who speaks how much, where in the story, and with whom.

import type { App, SceneItem } from '../app';
import { h } from './dom';
import { pushEscape } from './overlay';
import { analyzeCharacters, CharacterStats } from '../../shared/characters';
import { openRename } from './rename';

type SortKey = 'cues' | 'words' | 'scenes' | 'first' | 'name';

export class CharactersPanel {
  el: HTMLElement;
  private list: HTMLElement;
  private detail: HTMLElement;
  private countEl: HTMLElement;
  private search: HTMLInputElement;
  private sortSel: HTMLSelectElement;
  private selected: string | null = null;
  private popEsc: (() => void) | null = null;
  private cache: { version: number; scenes: SceneItem[]; stats: CharacterStats[] } | null = null;

  constructor(private app: App) {
    this.countEl = h('span', { class: 'dim' });
    this.search = h('input', { class: 'field', placeholder: 'Filter', 'aria-label': 'Filter characters', spellcheck: 'false' });
    this.search.dataset.esc = 'self';
    this.search.addEventListener('input', () => this.render());
    this.search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (this.search.value) {
          this.search.value = '';
          this.render();
        } else this.app.closePanel();
      }
    });
    this.sortSel = h(
      'select',
      { class: 'field', 'aria-label': 'Sort by' },
      h('option', { value: 'cues' }, 'Most speeches'),
      h('option', { value: 'words' }, 'Most words'),
      h('option', { value: 'scenes' }, 'Most scenes'),
      h('option', { value: 'first' }, 'First appearance'),
      h('option', { value: 'name' }, 'Name'),
    );
    this.sortSel.addEventListener('change', () => this.render());
    this.list = h('div', { class: 'ch-list', role: 'listbox', tabindex: '0', 'aria-label': 'Characters' });
    this.list.addEventListener('keydown', (e) => this.onKey(e));
    this.detail = h('div', { class: 'ch-detail' });
    this.el = h(
      'div',
      { class: 'characters floating hidden' },
      h(
        'div',
        { class: 'cards-head' },
        h('span', { class: 'doc-title', style: { padding: '0' } }, 'Characters'),
        this.countEl,
        h('span', { class: 'spacer' }),
        this.sortSel,
        this.search,
      ),
      h('div', { class: 'ch-body' }, this.list, this.detail),
    );
  }

  get isOpen() {
    return !this.el.classList.contains('hidden');
  }

  open() {
    this.el.classList.remove('hidden');
    if (!this.popEsc) this.popEsc = pushEscape(() => this.app.closePanel(), false);
    this.render();
    this.list.focus();
  }

  close() {
    this.el.classList.add('hidden');
    this.popEsc?.();
    this.popEsc = null;
  }

  /** Called after document changes (cheap when closed). */
  renderSoon() {
    if (this.isOpen) this.render();
  }

  private data() {
    const ed = this.app.editor;
    if (this.cache && this.cache.version === ed.version) return this.cache;
    const scenes = this.app.scenes.filter((s) => s.kind === 'scene');
    const stats = analyzeCharacters(ed.lineTexts as string[], ed.parsed, scenes.map((s) => ({ line: s.line, end: Math.max(s.end, s.line + 1) })));
    this.cache = { version: ed.version, scenes, stats };
    return this.cache;
  }

  private visible(): CharacterStats[] {
    const { stats } = this.data();
    const q = this.search.value.trim().toLowerCase();
    const sort = this.sortSel.value as SortKey;
    const list = stats.filter((c) => !c.silent && (!q || c.name.toLowerCase().includes(q)));
    const by: Record<SortKey, (a: CharacterStats, b: CharacterStats) => number> = {
      cues: (a, b) => b.cues - a.cues || b.words - a.words,
      words: (a, b) => b.words - a.words || b.cues - a.cues,
      scenes: (a, b) => b.speaksIn.length - a.speaksIn.length || b.cues - a.cues,
      first: (a, b) => (a.firstScene < 0 ? 1e9 : a.firstScene) - (b.firstScene < 0 ? 1e9 : b.firstScene) || b.cues - a.cues,
      name: (a, b) => a.name.localeCompare(b.name),
    };
    return list.sort(by[sort]);
  }

  render() {
    if (!this.isOpen || !this.app.project) return;
    const { scenes, stats } = this.data();
    const speaking = stats.filter((c) => c.cues > 0).length;
    this.countEl.textContent = `${speaking} characters · ${scenes.length} scenes`;
    const list = this.visible();
    if (!this.selected || !list.some((c) => c.name === this.selected)) this.selected = list[0]?.name ?? null;
    this.list.textContent = '';
    const n = Math.max(1, scenes.length);
    this.list.append(
      h('div', { class: 'ch-row ch-header' }, h('span', { class: 'ch-name' }, 'Character'), h('span', { class: 'ch-num' }, 'Speeches'), h('span', { class: 'ch-num' }, 'Words'), h('span', { class: 'ch-num' }, 'Share'), h('span', { class: 'ch-num' }, 'Scenes'), h('span', { class: 'ch-strip-head' }, 'Through the story')),
    );
    if (!list.length) this.list.append(h('div', { class: 'empty-note' }, stats.length ? 'No matching characters.' : 'No dialogue yet.'));
    for (const c of list) {
      const strip = h('span', { class: 'ch-strip', style: { gridTemplateColumns: `repeat(${n}, 1fr)` }, title: 'Each cell is a scene: filled where the character speaks, outlined where only mentioned' });
      const speaks = new Set(c.speaksIn);
      const mentioned = new Set(c.mentionedIn);
      for (let i = 0; i < scenes.length; i++) strip.append(h('i', { class: speaks.has(i) ? 'on' : mentioned.has(i) ? 'mention' : '' }));
      const row = h(
        'div',
        { class: `ch-row${c.name === this.selected ? ' selected' : ''}${c.silent ? ' silent' : ''}`, role: 'option', dataset: { name: c.name } },
        h('span', { class: 'ch-name', title: c.name }, c.name),
        h('span', { class: 'ch-num' }, c.cues ? String(c.cues) : '–'),
        h('span', { class: 'ch-num' }, c.words ? String(c.words) : '–'),
        h('span', { class: 'ch-num' }, c.words ? `${Math.round(c.share * 100)}%` : '–'),
        h('span', { class: 'ch-num' }, String(c.speaksIn.length || '–')),
        strip,
      );
      row.addEventListener('click', () => this.select(c.name));
      row.addEventListener('dblclick', () => this.showDialogue(c.name));
      this.list.append(row);
    }
    this.renderDetail();
  }

  private select(name: string) {
    this.selected = name;
    this.list.querySelectorAll<HTMLElement>('.ch-row').forEach((r) => r.classList.toggle('selected', r.dataset.name === name));
    this.list.querySelector('.ch-row.selected')?.scrollIntoView({ block: 'nearest' });
    this.renderDetail();
  }

  private renderDetail() {
    const d = this.detail;
    d.textContent = '';
    const { scenes, stats } = this.data();
    const c = stats.find((x) => x.name === this.selected);
    if (!c) {
      d.append(h('div', { class: 'empty-note' }, 'Choose a character.'));
      return;
    }
    const sceneLabel = (i: number) => (i >= 0 && scenes[i] ? `${scenes[i].order}. ${scenes[i].heading}` : '–');
    const fact = (label: string, value: string) => h('div', { class: 'ch-fact' }, h('span', { class: 'dim' }, label), h('span', null, value));
    d.append(
      h('div', { class: 'ch-detail-head' }, h('span', { class: 'ch-detail-name' }, c.name), c.silent ? h('span', { class: 'meta dim' }, 'no dialogue') : null),
      h(
        'div',
        { class: 'ch-actions' },
        c.cues ? h('button', { class: 'btn sm', onclick: () => this.showDialogue(c.name) }, 'Show dialogue') : null,
        h('button', { class: 'btn sm', onclick: () => openRename(this.app, c.name) }, 'Rename…'),
      ),
      h(
        'div',
        { class: 'ch-facts' },
        fact('Speeches', String(c.cues)),
        fact('Words spoken', `${c.words}${c.words ? ` (${Math.round(c.share * 100)}% of all dialogue)` : ''}`),
        fact('Average speech', c.cues ? `${Math.round(c.words / c.cues)} words` : '–'),
        fact('Longest speech', c.longest ? `${c.longest} words` : '–'),
        fact('Parentheticals', String(c.parentheticals)),
        fact('Speaks in', `${c.speaksIn.length} of ${scenes.length} scenes`),
        fact('Only mentioned in', `${c.mentionedIn.length} scenes`),
        fact('First appearance', sceneLabel(c.firstScene)),
        fact('Last appearance', sceneLabel(c.lastScene)),
      ),
    );
    if (c.sharedWith.length) {
      d.append(h('h4', null, 'Shares scenes with'));
      const max = c.sharedWith[0].scenes;
      const box = h('div', { class: 'ch-shared' });
      for (const o of c.sharedWith.slice(0, 8)) {
        const b = h('button', { class: 'ch-shared-row', title: `Show ${o.name}`, onclick: () => this.select(o.name) }, h('span', { class: 'ch-name' }, o.name), h('span', { class: 'ch-bar' }, h('i', { style: { width: `${(o.scenes / max) * 100}%` } })), h('span', { class: 'dim' }, String(o.scenes)));
        box.append(b);
      }
      d.append(box);
    }
    const all = [...new Set([...c.speaksIn, ...c.mentionedIn])].sort((a, b) => a - b);
    if (all.length) {
      d.append(h('h4', null, 'Scenes'));
      const box = h('div', { class: 'ch-scenes' });
      for (const i of all) {
        const sc = scenes[i];
        const cues = c.cuesByScene.get(i) ?? 0;
        const b = h(
          'button',
          { class: 'ch-scene-row', title: 'Open the scene', onclick: () => this.openScene(sc) },
          h('span', { class: 'num' }, String(sc.order)),
          sc.record?.color ? h('span', { class: 'swatch', style: { background: sc.record.color } }) : null,
          h('span', { class: 'label' }, sc.heading),
          h('span', { class: 'dim' }, cues ? `${cues} ${cues === 1 ? 'speech' : 'speeches'}` : 'mentioned'),
        );
        box.append(b);
      }
      d.append(box);
    }
  }

  private openScene(sc: SceneItem) {
    this.app.closePanel(false);
    if (this.app.view === 'dialogue') this.app.setView('scene', { quiet: true });
    this.app.goToScene(sc);
  }

  private showDialogue(name: string) {
    this.app.closePanel(false);
    this.app.dialogueCharacter = name;
    this.app.dialogueScope = 'all';
    if (this.app.view === 'dialogue') this.app.applyDialogueFilter(true);
    else this.app.setView('dialogue');
    this.app.updateViewControls();
    this.app.editor.focus();
  }

  private onKey(e: KeyboardEvent) {
    const list = this.visible();
    if (!list.length) return;
    let i = Math.max(0, list.findIndex((c) => c.name === this.selected));
    if (e.key === 'ArrowDown') i = Math.min(list.length - 1, i + 1);
    else if (e.key === 'ArrowUp') i = Math.max(0, i - 1);
    else if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = list.length - 1;
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (list[i].cues) this.showDialogue(list[i].name);
      return;
    } else return;
    e.preventDefault();
    this.select(list[i].name);
  }
}
