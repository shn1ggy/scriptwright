// Application shell: project lifecycle, saving, views, scene organization and commands.

import { bridge, isMac } from './bridge';
import { Editor, Transaction } from './editor/editor';
import { CommandRegistry, comboFromEvent, formatCombo, hasModifier, isNavigationCombo, toAccelerator } from './commands';
import { h, icon, iconButton, debounce, fmtNum, uid } from './ui/dom';
import { alertDialog, choiceDialog, confirmDialog, handleEscape, openDialog, openMenu, overlayOpen, promptDialog, toast, MenuItem } from './ui/overlay';
import { applyHighlightColors, applyTheme } from './theme';
import { Line, Pos, Selection, Step, cursor, joinLines, makeLines, selEmpty, selFrom, selTo, newKey } from '../shared/doc';
import { ParseResult, characterLabel, characterList, cleanText, countWords, sceneIndexAt, titlePageTemplate } from '../shared/fountain';
import { AppState, ArchivedScene, ProjectMeta, ProjectSession, SceneRecord, Settings, ViewName, defaultAppState, defaultSettings } from '../shared/types';
import { detach, fingerprint, hasInfo, reconcile } from '../shared/scenes';
import type { ProjectEntry, ExternalEvent } from '../main/backend';
import { OutlinePane } from './ui/outline';
import { ProjectsPane } from './ui/projects';
import { RightPane } from './ui/rightpane';
import { FindBar } from './ui/findbar';
import { openPalette } from './ui/palette';
import { openSettings, Section as SettingsSection } from './ui/settings';
import { checkForUpdates, checkForUpdatesSoon } from './ui/about';
import { ExportPreset, FontEntry, loadFonts, loadPdfjs, openExport, projectExportSettings, scriptLanguage } from './ui/export';
import { pdfToFountain, readPdfText } from '../shared/pdfimport';
import { paginate } from '../shared/paginate';
import { openRename } from './ui/rename';
import { Documents } from './ui/documents';
import { compareDialog } from './ui/compare';
import { SceneCards } from './ui/cards';
import { CharactersPanel } from './ui/characters';
import { Annotations } from './annotations';
import { sceneNumberEdits } from '../shared/fountainout';
import { isOmittedHeading, omittedHeading, sceneNumberList } from '../shared/scenenumbers';
import { openRewrite, openRewriteFor, passageLabel } from './ui/rewrite';
import { openCommentDialog, deleteComment } from './ui/review';
import { toShelf } from './ui/shelf';
import { saveDraft } from './ui/drafts';
import { HistoryHandle, openHistory } from './ui/history';
import { exportFinalDraft, openFountainExport, openSceneNumbers } from './ui/fountaintools';
import { keyIndex } from '../shared/anchors';
import { sectionsOf } from '../shared/structure';
import { CommentRecord, HighlightColor, PassageRecord } from '../shared/types';
import { t, tn, uiLocale, uiLanguage, setUiLanguage, UiLanguage } from '../shared/i18n';

export interface SceneItem {
  kind: 'scene' | 'title' | 'opening';
  id: string;
  key: number;
  line: number;
  end: number;
  heading: string;
  order: number;
  sceneNumber?: string;
  /** Number shown for the scene: 1, 2, 3 … or the locked number (12, 12A). */
  number: string;
  record?: SceneRecord;
}

type FocusTarget = { kind: 'scene'; key: number } | { kind: 'title' } | { kind: 'opening' };

interface Project {
  rel: string;
  name: string;
  file: string;
  meta: ProjectMeta;
  baseHash: string;
  savedVersion: number;
  sceneIds: Map<number, string>;
  metaDirty: boolean;
  conflicts: string[];
  sceneCtx: Map<string, { anchor: { key: number; ch: number }; head: { key: number; ch: number }; scrollTop: number }>;
  missing: boolean;
  pendingExternal: string | null;
}

type SaveState = 'saved' | 'unsaved' | 'saving' | 'error' | 'conflict' | 'missing' | 'none';

const MIN_LEFT = 220;
/** Height of the header row in Scene and Dialogue view (matches .view-head in the CSS). */
const VIEW_HEAD_H = 40;

/** CSS color (hex, rgb() or a name the canvas understands) to #rrggbb. */
function toHex(c: string): string {
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return c;
  ctx.fillStyle = '#000';
  ctx.fillStyle = c;
  return ctx.fillStyle as string;
}
const MIN_RIGHT = 310;

export type PanelName = 'cards' | 'characters' | 'history' | 'export';

export class App {
  settings: Settings = defaultSettings();
  state: AppState = defaultAppState();
  readonly commands = new CommandRegistry();
  editor!: Editor;
  project: Project | null = null;
  projects: ProjectEntry[] = [];
  view: ViewName = 'script';
  focus: FocusTarget | null = null;
  scenes: SceneItem[] = [];
  dialogueCharacter = '';
  dialogueScope: 'all' | 'scene' = 'all';
  dialogueAction = false;
  minimal = false;
  ready = false;
  saveState: SaveState = 'none';
  saveError = '';
  private saving = false;
  private saveTimer: any = null;
  private retryTimer: any = null;
  private retryDelay = 3000;
  private recoveryTimer: any = null;
  private dialogueSceneKey: number | null = null;
  private lastScenesSig = '';

  // DOM
  root!: HTMLElement;
  private titleEl!: HTMLElement;
  private subEl!: HTMLElement;
  private tabs!: Record<ViewName | PanelName, HTMLButtonElement>;
  /** Cards and Characters cover the writing view as tabs of their own. */
  panel: PanelName | null = null;
  private alignStatus: () => void = () => {};
  private mainEl!: HTMLElement;
  /** Exposé, treatment … of the open project (the Documents section of the left pane). */
  docs!: Documents;
  private centerCol!: HTMLElement;
  private statusEl!: HTMLElement;
  private exportHandle: { close(): void } | null = null;
  private historyHandle: HistoryHandle | null = null;
  characters!: CharactersPanel;
  /** Scenes selected in the outline and on the cards (ids); the anchor is where Shift-ranges start. */
  sceneSel = new Set<string>();
  sceneSelAnchor: string | null = null;
  private viewControls!: HTMLElement;
  private leftPane!: HTMLElement;
  private rightPaneEl!: HTMLElement;
  private leftResizer!: HTMLElement;
  private rightResizer!: HTMLElement;
  center!: HTMLElement;
  private statusSave!: HTMLButtonElement;
  private statusCount!: HTMLElement;
  private statusScene!: HTMLElement;
  private statusView!: HTMLElement;
  private bannerEl: HTMLElement | null = null;
  private welcomeEl: HTMLElement | null = null;
  outline!: OutlinePane;
  projectsPane!: ProjectsPane;
  rightPane!: RightPane;
  findbar!: FindBar;
  cards!: SceneCards;
  // eslint-disable-next-line @typescript-eslint/no-this-alias
  annotations = new Annotations(((app: App) => ({
    get editor() {
      return app.editor;
    },
    store: () => app.project?.meta ?? null,
    undoable: <T>(fn: () => T, label: string) => app.undoable(fn, label),
    markDirty: () => app.markMetaDirty(),
    headingAt: (i: number) => app.sceneAt(i)?.heading,
    changed: () => app.rightPane?.annotationsChanged(),
    reveal: (a: Pos, b: Pos) => app.revealRange(a, b),
    scope: 'script' as const,
  }))(this));

  /** The comments, highlights and passages being worked on: the open document's, else the screenplay's. */
  get ann(): Annotations {
    return this.docs?.isOpen ? this.docs.annotations : this.annotations;
  }
  private leftToggle!: HTMLButtonElement;
  private tooltipButtons: Array<[HTMLButtonElement, string, string]> = [];

  /** Tooltips show the current shortcut, so they follow keymap changes. */
  updateTooltips() {
    for (const [b, title, id] of this.tooltipButtons) {
      const k = this.commands.label(id);
      b.title = k ? `${title} (${k})` : title;
      b.setAttribute('aria-label', title);
    }
    for (const [v, label] of [['script', t('Script view')], ['scene', t('Scene view')], ['cards', t('Cards view')], ['dialogue', t('Dialogue view')], ['characters', t('Characters view')], ['source', t('Source view')]] as const) {
      const k = this.commands.label(`view.${v}`);
      this.tabs[v].title = t('{0} · double-click to hide the side panes', k ? `${label} (${k})` : label);
    }
    const ek = this.commands.label('file.export');
    this.tabs.export.title = ek ? t("Export PDF ({0})", ek) : t("Export PDF");
    const hk = this.commands.label('view.history');
    this.tabs.history.title = hk ? t("Drafts, exports and snapshots ({0})", hk) : t("Drafts, exports and snapshots");
  }
  private rightToggle!: HTMLButtonElement;

  async start() {
    this.state = await bridge.call('loadState');
    // The default pane widths grew (DESIGN.md); widths still at the old defaults follow.
    if (this.state.layout.leftWidth === 260) this.state.layout.leftWidth = 280;
    if (this.state.layout.rightWidth === 300) this.state.layout.rightWidth = 320;
    // Settings can live in the workspace, so the workspace is selected before they are read.
    let wsOk = false;
    if (this.state.workspace) wsOk = (await bridge.call('setWorkspace', this.state.workspace)).ok;
    if (wsOk) this.adoptWorkspaceState(await bridge.call('loadWorkspaceState'));
    this.settings = await bridge.call('loadSettings');
    // The interface language is applied while the page loads (from local storage); if the
    // settings (e.g. from a synced workspace) ask for another one, the page loads once more.
    const lang: UiLanguage = this.settings.language === 'de' ? 'de' : 'en';
    if (lang !== uiLanguage()) {
      let stored = false;
      try {
        localStorage.setItem('scriptwright.uiLanguage', lang);
        stored = localStorage.getItem('scriptwright.uiLanguage') === lang && sessionStorage.getItem('scriptwright.langReload') !== lang;
        sessionStorage.setItem('scriptwright.langReload', lang);
      } catch {
        /* no storage */
      }
      setUiLanguage(lang);
      if (stored) {
        if (bridge.isElectron) void bridge.window('reload').catch(() => location.reload());
        else location.reload();
        return;
      }
    }
    this.commands.overrides = { ...this.settings.keymap };
    this.commands.onChange = () => {
      this.settings.keymap = { ...this.commands.overrides };
      this.saveSettings();
      this.updateMenu();
      this.updateTooltips();
      this.updateViewControls();
    };
    applyTheme(this.settings.appearance);
    applyHighlightColors(this.settings.highlights, this.settings.appearance.theme === 'light');
    await this.loadScriptFont();
    if (bridge.isElectron) {
      document.body.classList.add('frameless', `platform-${bridge.platform}`);
      bridge.on('fullscreen', (on: boolean) => document.body.classList.toggle('fullscreen', on));
      bridge.window('isFullScreen').then((on) => document.body.classList.toggle('fullscreen', !!on)).catch(() => {});
    }
    this.buildDom();
    this.registerCommands();
    this.updateTooltips();
    this.bindGlobal();
    this.applyLayout();
    this.updateMenu();
    this.setupSpell();
    if (this.state.workspace) {
      if (wsOk) {
        await this.refreshProjects();
        const last = this.state.lastProject;
        if (last && this.projects.some((p) => p.rel === last && !p.loose)) await this.openProject(last);
      } else {
        toast(t("The workspace folder {0} is not available.", this.state.workspace), { warn: true });
        this.state.workspace = undefined;
      }
    }
    this.projectsPane.render();
    this.renderWorkspaceBar();
    this.updateWelcome();
    this.updateChrome();
    this.ready = true;
    checkForUpdatesSoon(this);
  }

  // ---------------------------------------------------------------------------------
  // DOM

  private buildDom() {
    this.titleEl = h('span', { class: 'doc-title' }, t("Scriptwright"));
    this.subEl = h('span', { class: 'doc-sub' });
    this.leftToggle = iconButton('sidebarLeft', t("Toggle scene pane"), () => this.run('view.leftPane'));
    this.rightToggle = iconButton('sidebarRight', t("Toggle notes pane"), () => this.run('view.rightPane'));
    this.tooltipButtons.push([this.leftToggle, t('Toggle scene pane'), 'view.leftPane'], [this.rightToggle, t('Toggle notes pane'), 'view.rightPane']);
    const titlebar = h(
      'div',
      { class: 'titlebar' },
      this.leftToggle,
      this.titleEl,
      this.subEl,
      h('span', { class: 'spacer' }),
      this.rightToggle,
    );
    // A double-click opens the tab in focus: both panes are hidden.
    const focusOpen = (b: HTMLButtonElement) => {
      b.addEventListener('dblclick', () => this.hidePanes());
      return b;
    };
    const mkTab = (v: ViewName, label: string) => focusOpen(h('button', { class: 'tab', tabindex: '-1', onclick: () => this.setView(v) }, label));
    const mkPanelTab = (p: PanelName, label: string) => {
      const b = h('button', { class: 'tab', tabindex: '-1', onclick: () => this.openPanel(p) }, label);
      return p === 'export' || p === 'history' ? b : focusOpen(b);
    };
    this.tabs = {
      script: mkTab('script', t("Script")),
      scene: mkTab('scene', t("Scene")),
      cards: mkPanelTab('cards', t("Cards")),
      dialogue: mkTab('dialogue', t("Dialogue")),
      characters: mkPanelTab('characters', t("Characters")),
      source: mkTab('source', t("Source")),
      history: mkPanelTab('history', t("History")),
      export: mkPanelTab('export', t("Export")),
    };
    // Options of the Scene and Dialogue views live in the view itself, never in the tab bar.
    this.viewControls = h('div', { class: 'view-head hidden' });
    const tb = this.tabs;
    const viewbar = h('div', { class: 'viewbar' }, h('div', { class: 'tabs' }, tb.script, tb.scene, tb.cards, tb.dialogue, tb.characters), h('span', { class: 'spacer' }), h('div', { class: 'tabs' }, tb.source, tb.history, tb.export));

    this.leftPane = h('div', { class: 'pane pane-left' });
    this.rightPaneEl = h('div', { class: 'pane pane-right' });
    this.center = h('div', { class: 'center' });
    this.leftResizer = h('div', { class: 'resizer', title: t("Drag to resize") });
    this.rightResizer = h('div', { class: 'resizer', title: t("Drag to resize") });
    // The writing column: the text and, under it, the status line. The panes on either side
    // run the full height of the window.
    this.centerCol = h('div', { class: 'center-col' }, this.center);
    const main = h('div', { class: 'main' }, this.leftPane, this.leftResizer, this.centerCol, this.rightResizer, this.rightPaneEl);
    this.mainEl = main;

    this.statusSave = h('button', { class: 'save-state', tabindex: '-1', onclick: () => this.onSaveStateClick() });
    this.statusCount = h('span', { class: 'count' });
    this.statusScene = h('span');
    this.statusView = h('span');
    // Scene view: previous/next scene live in the status bar, beside "Scene 4 of 38".
    this.statusNav = h(
      'span',
      { class: 'status-nav hidden' },
      iconButton('left', t("Previous scene"), () => this.stepScene(-1)),
      iconButton('right', t("Next scene"), () => this.stepScene(1)),
    );
    const status = h('div', { class: 'statusbar' }, this.statusSave, this.statusCount, h('span', { class: 'spacer' }), this.statusView, this.statusScene, this.statusNav);
    this.statusEl = status;
    this.centerCol.append(status);
    const alignStatus = () => {
      if (!this.editor) return;
      const r = this.editor.dom.getBoundingClientRect();
      // The text column stays centred on the window (not on the space between the panes),
      // so it does not move when a pane opens or closes, as long as it fits.
      const col = this.editor.dom.querySelector<HTMLElement>('.ed-column');
      if (col && r.width) {
        const room = Math.max(0, (r.width - col.offsetWidth) / 2 - 8);
        const want = window.innerWidth / 2 - (r.left + r.width / 2);
        const shift = Math.round(Math.max(-room, Math.min(room, want)));
        this.editor.dom.style.setProperty('--center-shift', `${shift}px`);
      }
    };
    window.addEventListener('resize', alignStatus);
    this.alignStatus = alignStatus;

    this.root = h('div', { id: 'app' }, titlebar, viewbar, main);
    document.body.append(this.root);

    this.editor = new Editor(this.center, this.settings.editor);
    new ResizeObserver(() => this.alignStatus()).observe(this.editor.dom);
    this.editor.editKeysFromMenu = bridge.isElectron;
    this.editor.hooks = {
      onChange: (origin, steps) => this.onEditorChange(origin, steps),
      onSelection: () => this.onSelectionChange(),
      onScroll: () => this.onScroll(),
      onContextMenu: (e, pos) => this.editorContextMenu(e, pos),
      onModClick: (e, pos) => this.openAnnotationAt(e, pos),
      gapLabel: (a, b) => this.dialogueGapLabel(a, b),
      isMisspelled: bridge.spell ? (w) => this.isMisspelled(w) : undefined,
    };

    this.projectsPane = new ProjectsPane(this);
    this.outline = new OutlinePane(this);
    this.workspaceBar = h('div', { class: 'workspace-bar' });
    this.docs = new Documents(this);
    this.leftPane.append(this.projectsPane.el, this.outline.el, this.docs.el, this.workspaceBar);
    this.rightPane = new RightPane(this);
    this.rightPaneEl.append(this.rightPane.el);
    this.findbar = new FindBar(this);
    this.cards = new SceneCards(this);
    this.characters = new CharactersPanel(this);
    this.center.append(this.viewControls, this.findbar.el, this.cards.el, this.characters.el);

    this.makeResizer(this.leftResizer, 'left');
    this.makeResizer(this.rightResizer, 'right');
  }

  private makeResizer(el: HTMLElement, side: 'left' | 'right') {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const start = side === 'left' ? this.state.layout.leftWidth : this.state.layout.rightWidth;
      el.classList.add('dragging');
      const move = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        const w = Math.max(side === 'left' ? MIN_LEFT : MIN_RIGHT, Math.min(560, side === 'left' ? start + dx : start - dx));
        if (side === 'left') this.state.layout.leftWidth = w;
        else this.state.layout.rightWidth = w;
        this.applyLayout();
      };
      const up = () => {
        el.classList.remove('dragging');
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        this.saveStateSoon();
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  }

  applyLayout() {
    const l = this.state.layout;
    const caretOffset = this.editor.measureCaretOffset();
    // Narrower panes break buttons and tab labels.
    l.leftWidth = Math.max(MIN_LEFT, Math.min(560, l.leftWidth));
    l.rightWidth = Math.max(MIN_RIGHT, Math.min(560, l.rightWidth));
    this.leftPane.style.width = `${l.leftWidth}px`;
    this.rightPaneEl.style.width = `${l.rightWidth}px`;
    this.leftPane.classList.toggle('hidden', !l.leftVisible);
    this.leftResizer.classList.toggle('hidden', !l.leftVisible);
    this.rightPaneEl.classList.toggle('hidden', !l.rightVisible);
    this.rightResizer.classList.toggle('hidden', !l.rightVisible);
    this.leftToggle.classList.toggle('on', l.leftVisible);
    this.rightToggle.classList.toggle('on', l.rightVisible);
    this.projectsPane.setCollapsed(l.projectsCollapsed);
    this.outline.setCollapsed(!!l.scenesCollapsed);
    this.docs.setCollapsed(!!l.documentsCollapsed);
    this.rightPane.setTab(l.rightTab);
    // Keep the caret line steady when the writing column re-centers.
    this.editor.restoreCaretOffset(caretOffset);
  }

  // ---------------------------------------------------------------------------------
  // Settings & state persistence

  openSettings(section: SettingsSection = 'editor') {
    openSettings(this, section);
  }

  /** Switches the interface language: saved, then the window loads again in it. */
  async setInterfaceLanguage(lang: UiLanguage) {
    if (lang === uiLanguage()) return;
    this.settings.language = lang;
    try {
      localStorage.setItem('scriptwright.uiLanguage', lang);
    } catch {
      /* no storage */
    }
    try {
      await bridge.call('saveSettings', this.settings);
    } catch (e: any) {
      toast(t('Settings could not be saved: {0}', e?.message ?? e), { warn: true });
      return;
    }
    await this.flush().catch(() => false);
    await new Promise((r) => setTimeout(r, 150));
    // The desktop app reloads the window itself; location.reload alone did not always do it.
    if (bridge.isElectron) await bridge.window('reload').catch(() => location.reload());
    else location.reload();
  }

  saveSettings = debounce(() => {
    bridge.call('saveSettings', this.settings).catch((e) => toast(t("Settings could not be saved: {0}", e.message), { warn: true }));
  }, 300);

  saveStateSoon = debounce(() => this.saveStateNow(), 800);

  saveStateNow() {
    this.captureSession();
    return bridge.call('saveState', this.state).catch(() => {});
  }

  /** Reads settings again (another workspace brings its own) and applies them. */
  async reloadSettings() {
    const s = await bridge.call('loadSettings');
    this.settings = s;
    this.commands.overrides = { ...s.keymap };
    this.updateMenu();
    this.updateTooltips();
    this.applySettings();
  }

  /**
   * Registers the bundled Courier Prime from its data. The stylesheet also points at the font
   * files, but on Windows those file URLs did not load and the editor fell back to Courier New.
   */
  private async loadScriptFont() {
    try {
      const faces = await bridge.call('scriptFontFaces');
      for (const f of faces) {
        const face = new FontFace('Courier Prime', new Uint8Array(f.data).buffer as ArrayBuffer, { weight: f.weight, style: f.style });
        await face.load();
        document.fonts.add(face);
      }
    } catch {
      // The stylesheet's @font-face rules (or Courier) remain.
    }
  }

  private lookFrame = 0;

  /**
   * Colors only (theme, highlights, title bar), at most once per frame: used while a color
   * or slider is dragged, so the picker stays smooth. Full settings follow on release.
   */
  applyLookSoon() {
    if (this.lookFrame) return;
    this.lookFrame = requestAnimationFrame(() => {
      this.lookFrame = 0;
      applyTheme(this.settings.appearance);
      applyHighlightColors(this.settings.highlights, this.settings.appearance.theme === 'light');
      this.syncTitleBar();
      this.saveSettings();
    });
  }

  applySettings() {
    applyTheme(this.settings.appearance);
    applyHighlightColors(this.settings.highlights, this.settings.appearance.theme === 'light');
    this.syncTitleBar();
    const offset = this.editor.measureCaretOffset();
    this.editor.applySettings(this.settings.editor);
    this.docs?.applySettings(this.settings.editor);
    this.editor.restoreCaretOffset(offset);
    this.setupSpell();
    this.refreshDerived(true);
    this.updatePageMarkers.flush?.();
    this.saveSettings();
  }

  private spellCache = new Map<string, boolean>();
  private setupSpell() {
    this.spellCache.clear();
    if (!bridge.spell) return;
    bridge.spell.enable(this.settings.editor.spellcheck).catch(() => {});
    if (this.settings.editor.spellcheck) bridge.spell.languages(this.settings.editor.spellLanguages).catch(() => {});
    this.editor.refresh();
  }

  private isMisspelled(word: string): boolean {
    if (!bridge.spell || !this.settings.editor.spellcheck) return false;
    const dict = this.project?.meta.dictionary;
    if (dict && dict.includes(word)) return false;
    if (/^[\p{Lu}\d'\-]+$/u.test(word) && word.length > 1) return false; // all-caps: names, sluglines
    let v = this.spellCache.get(word);
    if (v === undefined) {
      v = bridge.spell.check([word])[0];
      this.spellCache.set(word, v);
    }
    return v;
  }

  // ---------------------------------------------------------------------------------
  // Workspace & projects

  async chooseWorkspace() {
    const dir = await bridge.dialog('folder', { title: t("Open a folder as workspace") });
    if (!dir) return;
    await this.setWorkspace(dir);
  }

  /** A new, empty workspace: a name and the folder it goes in. */
  async createWorkspace() {
    const name = await promptDialog(t("New workspace"), t("Name"), t("Screenplays"), { okLabel: t("Choose location…") });
    if (!name?.trim()) return;
    const parent = await bridge.dialog('folder', { title: t("Where should the workspace “{0}” be created?", name.trim()) });
    if (!parent) return;
    try {
      const dir = await bridge.call('createWorkspace', parent, name.trim());
      await this.setWorkspace(dir);
      toast(t("Workspace “{0}” created. Projects, settings and history for it are kept in its folder.", name.trim()));
    } catch (e: any) {
      alertDialog(t("Workspace not created"), e.message);
    }
  }

  revealPath(rel: string) {
    if (!this.state.workspace) return;
    bridge.window('reveal', rel ? `${this.state.workspace}/${rel}` : this.state.workspace);
  }

  private workspaceMenu(anchor: HTMLElement) {
    const cur = this.state.workspace;
    const base = (d: string) => d.split(/[\\/]/).filter(Boolean).pop() ?? d;
    const items: MenuItem[] = [{ head: t("Workspaces") }];
    for (const d of this.state.recentWorkspaces) items.push({ label: `${d === cur ? '✓' : '  '} ${base(d)}`, kbd: d === cur ? '' : undefined, run: () => d !== cur && this.setWorkspace(d) });
    items.push(
      { sep: true },
      { label: t("Connect to Workspace Folder…"), kbd: this.commands.label('project.openWorkspace'), run: () => this.chooseWorkspace() },
      { label: t("Create New Workspace…"), run: () => this.createWorkspace() },
    );
    if (cur && bridge.isElectron) items.push({ sep: true }, { label: t("Show Workspace in Folder"), run: () => this.revealPath('') });
    if (cur) items.push({ sep: true }, { label: t("Remove “{0}” from Scriptwright…", base(cur)), run: () => void this.removeWorkspace(cur) });
    if (this.state.recentWorkspaces.length > 1) items.push({ label: t("Clear List of Other Workspaces"), run: () => {
      this.state.recentWorkspaces = cur ? [cur] : [];
      this.saveStateSoon();
    } });
    openMenu(items, anchor.getBoundingClientRect());
  }

  /**
   * Takes a workspace out of the app's list. Nothing is deleted: the folder and its projects
   * stay where they are and can be connected again.
   */
  async removeWorkspace(dir: string) {
    const name = dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;
    const ok = await confirmDialog(
      t("Remove workspace"),
      h('div', null, h('p', null, t("“{0}” is removed from Scriptwright only. The folder and all projects in it stay on your computer, untouched; you can connect it again at any time.", name)), h('p', { class: 'dim', style: { userSelect: 'text', wordBreak: 'break-all' } }, dir)),
      t("Remove from Scriptwright"),
    );
    if (!ok) return;
    const rest = this.state.recentWorkspaces.filter((d) => d !== dir);
    this.state.recentWorkspaces = rest;
    if (this.state.workspace === dir) {
      if (rest.length) {
        await this.setWorkspace(rest[0]);
      } else {
        await this.closeProject();
        this.state.workspace = undefined;
        this.state.lastProject = undefined;
        await this.refreshProjects();
        this.renderWorkspaceBar();
        this.updateWelcome();
        this.updateChrome();
      }
    }
    this.saveStateSoon();
    toast(t("“{0}” was removed from Scriptwright. The folder is unchanged.", name));
  }

  private workspaceBar!: HTMLElement;

  renderWorkspaceBar() {
    const ws = this.state.workspace;
    const name = ws ? ws.split(/[\\/]/).filter(Boolean).pop() ?? ws : t('No workspace');
    const btn = h('button', { class: 'ws-switch', title: ws ? t("Workspace: {0}\nSwitch or create workspaces", ws) : t("Open or create a workspace") }, h('span', { class: 'ws-icon' }, icon('folder')), h('span', { class: 'ws-name' }, name), icon('chevronDown'));
    btn.addEventListener('click', () => this.workspaceMenu(btn));
    this.workspaceBar.replaceChildren(
      btn,
      h('span', { class: 'spacer' }),
      iconButton('command', t("Commands & shortcuts ({0})", this.commands.label('app.commands')), () => this.run('app.commands')),
      iconButton('settings', t("Settings ({0})", this.commands.label('app.settings')), () => this.run('app.settings')),
    );
  }

  async archiveProject(rel: string, archive: boolean) {
    const wasOpen = this.project?.rel === rel;
    if (wasOpen) await this.closeProject();
    try {
      const e = await bridge.call('archiveProject', rel, archive);
      await this.refreshProjects();
      if (wasOpen) await this.openProject(e.rel);
      toast(archive ? t("“{0}” moved to the archive.", e.name) : t("“{0}” moved out of the archive.", e.name), {
        actions: [{ label: t("Undo"), run: async () => {
          const again = this.project?.rel === e.rel;
          if (again) await this.closeProject();
          const back = await bridge.call('archiveProject', e.rel, !archive);
          await this.refreshProjects();
          if (again) await this.openProject(back.rel);
        } }],
      });
    } catch (err: any) {
      alertDialog(t("Not moved"), err.message);
      if (wasOpen) await this.openProject(rel);
    }
    this.updateWelcome();
  }

  async deleteProject(rel: string) {
    const entry = this.projects.find((p) => p.rel === rel);
    if (!entry) return;
    const where = bridge.isElectron ? (isMac ? t('the Trash') : t('the Recycle Bin')) : t('the workspace’s deleted items');
    const ok = await confirmDialog(
      t("Delete project"),
      t("Delete “{0}”? The project folder with its screenplay, history, drafts, comments and notes is moved to {1}.", entry.name, where),
      t("Delete"),
      { danger: true },
    );
    if (!ok) return;
    if (this.project?.rel === rel) await this.closeProject();
    try {
      await bridge.call('deleteProject', rel);
      if (this.state.lastProject === rel) this.state.lastProject = undefined;
      delete this.state.sessions[rel];
      this.saveStateSoon();
      toast(t("“{0}” moved to {1}.", entry.name, where));
    } catch (e: any) {
      alertDialog(t("Not deleted"), e.message);
    }
    await this.refreshProjects();
    this.updateWelcome();
    this.updateChrome();
  }

  async setWorkspace(dir: string) {
    // Pending settings belong to the workspace being left.
    this.saveSettings.flush?.();
    // The open project is saved and closed while the old workspace is still selected.
    await this.closeProject();
    const r = await bridge.call('setWorkspace', dir);
    if (!r.ok) {
      await alertDialog(t("Workspace unavailable"), r.message ?? t("The folder cannot be used."));
      if (this.state.workspace) await bridge.call('setWorkspace', this.state.workspace);
      return;
    }
    this.state.workspace = dir;
    this.state.recentWorkspaces = [dir, ...this.state.recentWorkspaces.filter((d) => d !== dir)].slice(0, 8);
    this.state.lastProject = undefined;
    // Another workspace brings its own layout and view options (when it has saved any).
    const ws = await bridge.call('loadWorkspaceState');
    if (ws) {
      this.adoptWorkspaceState(ws);
      this.applyLayout();
    }
    await this.reloadSettings();
    await this.refreshProjects();
    this.renderWorkspaceBar();
    this.saveStateSoon();
    this.updateWelcome();
    this.updateChrome();
  }

  /** Uses the layout, view options and positions saved in the workspace. */
  private adoptWorkspaceState(ws: Pick<AppState, 'layout' | 'sessions' | 'lastProject'> | null) {
    if (!ws) return;
    this.state.layout = { ...this.state.layout, ...ws.layout };
    this.state.sessions = { ...this.state.sessions, ...ws.sessions };
    if (ws.lastProject) this.state.lastProject = ws.lastProject;
  }

  async refreshProjects() {
    if (!this.state.workspace) {
      this.projects = [];
    } else {
      try {
        this.projects = await bridge.call('listProjects');
      } catch (e: any) {
        this.projects = [];
        toast(t("The workspace could not be read: {0}", e.message), { warn: true });
      }
    }
    this.projectsPane.render();
  }

  async newProject() {
    if (!this.state.workspace) {
      await this.chooseWorkspace();
      if (!this.state.workspace) return;
    }
    const name = await promptDialog(t("New project"), t("Name"), '', { okLabel: t("Create") });
    if (!name) return;
    const text = `${titlePageTemplate(name, new Date().toLocaleDateString(uiLocale()))}\n${this.settings.editor.defaultHeading}\n\n`;
    try {
      const p = await bridge.call('createProject', name, text);
      await this.refreshProjects();
      await this.openProject(p.rel);
    } catch (e: any) {
      alertDialog(t("Project not created"), e.message);
    }
  }

  async openProject(rel: string, opts: { keepView?: boolean } = {}) {
    if (this.project?.rel === rel) return;
    await this.closeProject();
    const entry = this.projects.find((p) => p.rel === rel);
    if (entry?.loose) {
      const ok = await confirmDialog(
        t("Open loose file"),
        t("\"{0}\" is not inside a project folder yet. Scriptwright will move it into its own folder \"{1}\" so notes and history can be kept beside it.", entry.file, entry.name),
        t("Move into project folder"),
      );
      if (!ok) return;
      try {
        const adopted = await bridge.call('adoptLooseFile', rel);
        await this.refreshProjects();
        rel = adopted.rel;
      } catch (e: any) {
        alertDialog(t("Could not move the file"), e.message);
        return;
      }
    }
    let r;
    try {
      r = await bridge.call('openProject', rel);
    } catch (e: any) {
      await alertDialog(t("Project could not be opened"), e.message);
      return;
    }
    const meta = r.meta;
    const p: Project = {
      rel,
      name: entry?.name ?? rel,
      file: r.file,
      meta,
      baseHash: r.hash,
      savedVersion: 0,
      sceneIds: new Map(),
      metaDirty: false,
      conflicts: entry?.conflicts ?? [],
      sceneCtx: new Map(),
      missing: false,
      pendingExternal: null,
    };
    this.project = p;
    this.state.lastProject = rel;
    const session = this.state.sessions[meta.id];
    this.editor.setText(r.text);
    p.savedVersion = this.editor.version;
    this.assignSceneIdsFromRecords();
    this.annotations.load();
    this.dialogueCharacter = session?.dialogueCharacter ?? '';
    this.dialogueScope = session?.dialogueScope ?? 'all';
    this.dialogueAction = session?.dialogueAction ?? false;
    this.refreshDerived(true);
    this.setSaveState('saved');
    // Restore view and caret
    if (session) {
      const caret = { line: session.caret.line, ch: session.caret.ch };
      this.editor.setSelection(cursor(caret), { scroll: false });
      if (session.view === 'scene') {
        const item = session.titleFocused ? this.scenes.find((s) => s.kind === 'title') : this.scenes.find((s) => s.id === session.focusedSceneId) ?? this.sceneAt(caret.line);
        if (item) this.enterScene(item, { restoreContext: false });
        else this.setView('script', { quiet: true });
      } else if (session.view === 'dialogue') {
        this.setView('dialogue', { quiet: true });
      } else if (session.view === 'source' || session.source) {
        this.setView('source', { quiet: true });
        this.editor.scrollToLine(Math.min(session.scrollLine, this.editor.lines.length - 1), 'top', 0);
      } else {
        this.setView('script', { quiet: true });
        this.editor.scrollToLine(Math.min(session.scrollLine, this.editor.lines.length - 1), 'top', 0);
      }
    } else {
      this.setView('script', { quiet: true });
      const first = this.scenes.find((s) => s.kind === 'scene');
      if (first) this.editor.setSelection(cursor({ line: first.line, ch: this.editor.lines[first.line].text.length }), { scroll: false });
    }
    this.updateWelcome();
    this.updateChrome();
    this.projectsPane.render();
    this.rightPane.render();
    this.editor.focus();
    // Warnings and recovery
    for (const w of r.warnings) toast(w, { warn: true, timeout: 12000 });
    if (r.otherInstance) {
      this.showBanner(t("This project also appears to be open on {0}. Changes are checked before saving, so nothing will be overwritten silently.", r.otherInstance.host), [{ label: t("OK"), run: () => this.hideBanner() }]);
    }
    if (p.conflicts.length) this.showConflictCopiesBanner();
    // Not awaited: the recovery question must not block startup.
    if (r.recovery) this.offerRecovery(r.recovery);
    this.saveStateSoon();
  }

  private async offerRecovery(rec: { text: string; savedAt: string }) {
    const when = new Date(rec.savedAt).toLocaleString(uiLocale());
    const choice = await choiceDialog(
      t("Unsaved work found"),
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('p', null, t("Scriptwright kept a recovery copy from {0} that differs from the saved screenplay. This usually means the app closed before it could save.", when)),
        h('p', null, t("Restoring replaces the editor text with the recovered version (you can undo). The current file is kept in history either way.")),
      ),
      [
        { label: t("Compare…"), value: 'compare' as const },
        { label: t("Discard recovery"), value: 'discard' as const, danger: true },
        { label: t("Restore"), value: 'restore' as const, primary: true },
      ],
    );
    const p = this.project!;
    if (choice === 'compare') {
      const use = await compareDialog(t("Recovered vs saved"), this.editor.getText(), rec.text, t("Saved file"), t("Recovered"), t("Use recovered"));
      if (use) await this.replaceAllText(rec.text, t("Recovered work restored"));
      else await this.offerRecovery(rec);
      return;
    }
    if (choice === 'restore') {
      await bridge.call('snapshotProject', p.rel, this.editor.getText(), 'before recovery');
      await this.replaceAllText(rec.text, t("Recovered work restored"));
    } else if (choice === 'discard') {
      await bridge.call('saveConflictCopy', p.rel, rec.text, 'discarded recovery');
      await bridge.call('clearRecovery', p.meta.id);
      toast(t("Recovery copy discarded (a copy was kept in the project’s conflicts folder)."));
    }
  }

  async closeProject() {
    const p = this.project;
    if (!p) return;
    await this.flush();
    await this.docs.reset();
    this.captureSession();
    try {
      await bridge.call('closeProject', p.rel);
    } catch {}
    this.closePanel(false);
    this.project = null;
    this.focus = null;
    this.findbar.close(false);
    this.hideBanner();
    this.editor.setFilter(null, null);
    this.annotations.live.clear();
    this.editor.setDecorations([]);
    this.editor.setText('');
    this.scenes = [];
    this.outline.render();
    this.rightPane.render();
    this.setSaveState('none');
    this.updateChrome();
  }

  /** Saves everything (screenplay, project information, session). */
  async flush(): Promise<boolean> {
    let ok = true;
    if (this.docs && !(await this.docs.flush())) ok = false;
    if (this.project) {
      clearTimeout(this.saveTimer);
      if (this.isDirty() && this.saveState !== 'conflict' && !this.project.missing) ok = await this.save();
      if (this.isDirty()) {
        // Could not save: make sure the work survives in recovery.
        await this.writeRecoveryNow();
        ok = false;
      }
      if (this.project.metaDirty) await this.saveMetaNow();
    }
    await this.saveStateNow();
    return ok;
  }

  captureSession() {
    const p = this.project;
    if (!p) return;
    const head = this.editor.sel.head;
    const s: ProjectSession = {
      view: this.view,
      caret: { line: head.line, ch: head.ch },
      scrollLine: this.isFullView() ? this.editor.topVisibleLine() : this.state.sessions[p.meta.id]?.scrollLine ?? 0,
      focusedSceneId: this.focus?.kind === 'scene' ? p.sceneIds.get(this.focus.key) : undefined,
      titleFocused: this.focus?.kind === 'title',
      dialogueCharacter: this.dialogueCharacter,
      dialogueScope: this.dialogueScope,
      dialogueAction: this.dialogueAction,
    };
    this.state.sessions[p.meta.id] = s;
  }

  // ---------------------------------------------------------------------------------
  // Saving

  isDirty() {
    return !!this.project && this.editor.version !== this.project.savedVersion;
  }

  private setSaveState(s: SaveState, err = '') {
    this.saveState = s;
    this.saveError = err;
    const label: Record<SaveState, string> = {
      none: '',
      saved: t('Saved'),
      unsaved: t('Unsaved changes'),
      saving: t('Saving…'),
      error: t('Not saved — retrying'),
      conflict: t('Changed outside Scriptwright — review'),
      missing: t('File missing'),
    };
    this.statusSave.textContent = label[s];
    this.statusSave.className = `save-state ${s === 'error' || s === 'conflict' || s === 'missing' ? 'error' : s === 'unsaved' || s === 'saving' ? 'unsaved' : ''}`;
    this.statusSave.title = err || (s === 'saved' ? t("All changes are saved to disk") : '');
  }

  private scheduleSave() {
    if (!this.project) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), this.settings.saving.autosaveDelayMs);
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = setTimeout(() => {
      if (this.isDirty()) this.writeRecoveryNow();
    }, 4000);
  }

  private async writeRecoveryNow() {
    const p = this.project;
    if (!p) return;
    try {
      await bridge.call('writeRecovery', p.meta.id, p.rel, this.editor.getText());
    } catch {}
  }

  /** Saves the screenplay. Changes made while saving stay pending until saved. */
  async save(): Promise<boolean> {
    const p = this.project;
    if (!p || p.missing || this.saveState === 'conflict') return false;
    if (this.saving) {
      // Another save is running: try again once it finishes.
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.save(), 200);
      return false;
    }
    if (!this.isDirty()) {
      if (this.saveState !== 'saved') this.setSaveState('saved');
      return true;
    }
    this.saving = true;
    const version = this.editor.version;
    const text = this.editor.getText();
    this.setSaveState('saving');
    let r;
    try {
      r = await bridge.call('saveScript', p.rel, text, p.baseHash, this.settings.saving.snapshotIntervalMin);
    } catch (e: any) {
      r = { ok: false as const, reason: 'error' as const, message: e?.message ?? String(e) };
    }
    this.saving = false;
    if (this.project !== p) return false;
    if (r.ok) {
      p.baseHash = r.hash;
      p.savedVersion = version;
      this.retryDelay = 3000;
      if (this.isDirty()) {
        this.setSaveState('unsaved');
        this.scheduleSave();
      } else {
        this.setSaveState('saved');
        bridge.call('clearRecovery', p.meta.id).catch(() => {});
      }
      if (p.metaDirty) this.saveMetaNow();
      if (r.snapshot) this.rightPane.historyChanged();
      return true;
    }
    if (r.reason === 'conflict') {
      this.setSaveState('conflict');
      await this.writeRecoveryNow();
      this.handleConflict(r.diskText, r.diskHash);
      return false;
    }
    if (r.reason === 'missing') {
      p.missing = true;
      this.setSaveState('missing');
      await this.writeRecoveryNow();
      this.showMissingBanner();
      return false;
    }
    this.setSaveState('error', r.message);
    await this.writeRecoveryNow();
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (this.saveState === 'error') {
        this.setSaveState('unsaved');
        this.save();
      }
    }, this.retryDelay);
    this.retryDelay = Math.min(60000, this.retryDelay * 2);
    return false;
  }

  private onSaveStateClick() {
    if (this.saveState === 'error') alertDialog(t("Saving failed"), t("{0}\n\nYour work is kept in a recovery copy and Scriptwright keeps retrying.", this.saveError));
    else if (this.saveState === 'conflict' && this.project?.pendingExternal !== null) this.reviewConflict();
    else if (this.saveState === 'missing') this.showMissingBanner();
    else if (this.saveState === 'unsaved') this.save();
  }

  private metaChangeDepth = 0;

  /**
   * Runs a change to comments, highlights, passages, the shelf or scene details as one step
   * in the undo history (Mod+Z undoes it like an edit of the text).
   */
  undoable<T>(fn: () => T, label = ''): T {
    if (!this.project || this.metaChangeDepth > 0) return fn();
    const before = this.metaSnapshot();
    this.metaChangeDepth++;
    let out: T;
    try {
      out = fn();
    } finally {
      this.metaChangeDepth--;
    }
    const after = this.metaSnapshot();
    if (after.json !== before.json || after.live !== before.live) {
      const project = this.project;
      const apply = (s: { json: string; anchors: Map<string, any> }) => {
        if (this.project !== project) return;
        this.restoreMetaSnapshot(s);
      };
      this.editor.pushCustom({ undo: () => apply(before), redo: () => apply(after) }, label);
    }
    return out;
  }

  private metaSnapshot() {
    const m = this.project!.meta;
    const json = JSON.stringify({ highlights: m.highlights, comments: m.comments, passages: m.passages, shelf: m.shelf, sceneArchive: m.sceneArchive, scenes: m.scenes, detached: m.detached, structure: m.structure ?? null });
    const anchors = new Map<string, any>();
    for (const [id, an] of this.annotations.live) anchors.set(id, { a: { ...an.a }, b: { ...an.b } });
    return { json, anchors, live: JSON.stringify([...anchors]) };
  }

  private restoreMetaSnapshot(s: { json: string; anchors: Map<string, any> }) {
    const m = this.project!.meta;
    const o = JSON.parse(s.json);
    if (o.structure === null) {
      delete o.structure;
      delete m.structure;
    }
    Object.assign(m, o);
    this.annotations.restoreLive(s.anchors);
    this.markMetaDirty();
    this.updateScenes();
    this.outline.render();
    this.cards.render();
    this.rightPane?.render?.();
  }

  markMetaDirty() {
    if (!this.project) return;
    this.project.metaDirty = true;
    this.saveMetaSoon();
  }

  private saveMetaSoon = debounce(() => this.saveMetaNow(), 1000);

  async saveMetaNow() {
    this.annotations.syncToMeta();
    this.docs?.annotations.syncToMeta();
    const p = this.project;
    if (!p || !p.metaDirty) return;
    this.syncSceneRecords();
    p.metaDirty = false;
    const r = await bridge.call('saveMeta', p.rel, p.meta);
    if (!r.ok) {
      p.metaDirty = true;
      toast(t("Project information could not be saved: {0}", r.message), { warn: true });
    } else if (r.preservedExternal) {
      toast(t("Project information was also changed elsewhere; that version was kept as {0}.", r.preservedExternal), { warn: true, timeout: 10000 });
    }
  }

  // ---------------------------------------------------------------------------------
  // External changes and conflicts

  async onExternal(ev: ExternalEvent) {
    const p = this.project;
    if (!p || ev.rel !== p.rel) {
      if (ev.kind === 'conflict-copies') this.refreshProjects();
      return;
    }
    if (ev.kind === 'deleted') {
      p.missing = true;
      this.setSaveState('missing');
      this.showMissingBanner();
      return;
    }
    if (ev.kind === 'restored') {
      if (p.missing) {
        p.missing = false;
        this.hideBanner();
        this.onExternal({ rel: ev.rel, kind: 'changed', hash: ev.hash });
      }
      return;
    }
    if (ev.kind === 'conflict-copies') {
      p.conflicts = ev.conflicts ?? [];
      await this.refreshProjects();
      if (p.conflicts.length) this.showConflictCopiesBanner();
      return;
    }
    if (ev.kind === 'meta') {
      if (p.metaDirty) return; // ours wins on save; theirs is preserved by the backend
      const m = await bridge.call('readMeta', p.rel);
      if (m) {
        p.meta = m.meta;
        this.assignSceneIdsFromRecords();
        this.annotations.load();
        this.refreshDerived(true);
        this.rightPane.render();
      }
      return;
    }
    if (ev.kind === 'changed') {
      if (ev.hash === p.baseHash) return;
      if (this.saving) {
        // Let the save's own conflict check decide.
        return;
      }
      const disk = await bridge.call('readScript', p.rel);
      if (!disk || disk.hash === p.baseHash) return;
      if (disk.text === this.editor.getText()) {
        p.baseHash = disk.hash;
        p.savedVersion = this.editor.version;
        this.setSaveState('saved');
        return;
      }
      if (!this.isDirty()) {
        await this.replaceAllText(disk.text, null, 'external');
        p.baseHash = disk.hash;
        p.savedVersion = this.editor.version;
        this.setSaveState('saved');
        toast(t("Reloaded changes made outside Scriptwright."), { actions: [{ label: t("Undo"), run: () => this.editor.undo() }] });
        return;
      }
      this.setSaveState('conflict');
      this.handleConflict(disk.text, disk.hash);
    }
  }

  private handleConflict(diskText: string, diskHash: string) {
    const p = this.project!;
    p.pendingExternal = diskText;
    (p as any).pendingExternalHash = diskHash;
    this.showBanner(t("The screenplay was changed outside Scriptwright while you had unsaved changes. Both versions are kept until you decide."), [
      { label: t("Review…"), run: () => this.reviewConflict() },
    ]);
  }

  async reviewConflict() {
    const p = this.project;
    if (!p || p.pendingExternal === null) return;
    const diskText = p.pendingExternal;
    const diskHash = (p as any).pendingExternalHash as string;
    const choice = await choiceDialog(
      t("Resolve conflicting changes"),
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('p', null, t("The file on disk no longer matches the version you started editing. Whichever version you choose, the other one is saved in the project’s conflicts folder.")),
      ),
      [
        { label: t("Compare…"), value: 'compare' as const },
        { label: t("Use the other version"), value: 'theirs' as const },
        { label: t("Keep my version"), value: 'mine' as const, primary: true },
      ],
    );
    if (!choice) return;
    if (choice === 'compare') {
      const useTheirs = await compareDialog(t("My version vs file on disk"), this.editor.getText(), diskText, t("My version"), t("File on disk"), t("Use file on disk"));
      if (useTheirs) await this.resolveConflict('theirs', diskText, diskHash);
      else await this.reviewConflict();
      return;
    }
    await this.resolveConflict(choice, diskText, diskHash);
  }

  private async resolveConflict(choice: 'mine' | 'theirs', diskText: string, diskHash: string) {
    const p = this.project!;
    if (choice === 'mine') {
      const saved = await bridge.call('saveConflictCopy', p.rel, diskText, 'other version');
      p.baseHash = diskHash;
      p.pendingExternal = null;
      await bridge.call('acknowledge', p.rel, diskHash);
      this.hideBanner();
      this.setSaveState('unsaved');
      await this.save();
      toast(t("Kept your version. The other version was saved as {0}.", saved), { timeout: 8000 });
    } else {
      const saved = await bridge.call('saveConflictCopy', p.rel, this.editor.getText(), 'my version');
      await this.replaceAllText(diskText, null, 'external');
      p.baseHash = diskHash;
      p.savedVersion = this.editor.version;
      p.pendingExternal = null;
      await bridge.call('acknowledge', p.rel, diskHash);
      this.hideBanner();
      this.setSaveState('saved');
      toast(t("Loaded the other version. Your version was saved as {0}.", saved), { timeout: 8000, actions: [{ label: t("Undo"), run: () => this.editor.undo() }] });
    }
  }

  private showMissingBanner() {
    this.showBanner(t("The screenplay file was moved, renamed or deleted outside Scriptwright. Your text is still here and in a recovery copy."), [
      {
        label: t("Save here again"),
        run: async () => {
          const p = this.project!;
          const r = await bridge.call('restoreScript', p.rel, this.editor.getText());
          if (r.ok) {
            p.missing = false;
            p.baseHash = r.hash;
            p.savedVersion = this.editor.version;
            this.setSaveState('saved');
            this.hideBanner();
            this.refreshProjects();
          } else alertDialog(t("Could not save"), (r as any).message ?? t("The folder is not available."));
        },
      },
      { label: t("Close project"), run: () => this.closeProject() },
    ]);
  }

  private showConflictCopiesBanner() {
    const p = this.project!;
    const n = p.conflicts.length;
    this.showBanner(tn(n, '{0} other screenplay copy found in this project folder (for example a sync conflict copy).', '{0} other screenplay copies found in this project folder (for example a sync conflict copy).'), [
      { label: t("Review…"), run: () => this.reviewConflictCopies() },
      { label: t("Later"), run: () => this.hideBanner() },
    ]);
  }

  async reviewConflictCopies() {
    const p = this.project;
    if (!p) return;
    for (const name of p.conflicts.slice()) {
      let text: string;
      try {
        text = await bridge.call('readProjectFile', p.rel, name);
      } catch {
        continue;
      }
      const choice = await choiceDialog(
        t("Other screenplay copy"),
        h('div', null, h('p', null, `"${name}"`), h('p', null, t("Compare it with the current screenplay, use it, or archive it into the project’s conflicts folder."))),
        [
          { label: t("Skip"), value: 'skip' as const },
          { label: t("Archive"), value: 'archive' as const },
          { label: t("Compare…"), value: 'compare' as const, primary: true },
        ],
      );
      if (choice === 'archive') {
        await bridge.call('archiveProjectFile', p.rel, name);
      } else if (choice === 'compare') {
        const use = await compareDialog(t("Current screenplay vs copy"), this.editor.getText(), text, t("Current"), name, t("Use this copy"));
        if (use) {
          await bridge.call('snapshotProject', p.rel, this.editor.getText(), 'before using copy');
          await this.replaceAllText(text, t("Using \"{0}\"", name));
          await bridge.call('archiveProjectFile', p.rel, name);
        }
      } else if (!choice) break;
    }
    const entries = await bridge.call('listProjects');
    this.projects = entries;
    p.conflicts = entries.find((e) => e.rel === p.rel)?.conflicts ?? [];
    this.projectsPane.render();
    this.hideBanner();
    if (p.conflicts.length) this.showConflictCopiesBanner();
  }

  showBanner(text: string, actions: Array<{ label: string; run: () => void }>) {
    this.hideBanner();
    const b = h('div', { class: 'banner floating', role: 'alert' }, h('span', { class: 'text' }, text));
    for (const a of actions) b.append(h('button', { class: 'btn', onclick: () => a.run() }, a.label));
    this.center.append(b);
    this.bannerEl = b;
  }

  hideBanner() {
    this.bannerEl?.remove();
    this.bannerEl = null;
  }

  /** Replaces the whole screenplay as one undoable change. */
  async replaceAllText(text: string, message: string | null, origin: 'command' | 'external' = 'command', sceneIds?: string[]) {
    const head = this.editor.sel.head;
    const newLines = makeLines(text);
    // Keep keys for lines that did not change at the same position, so scenes keep identity.
    const old = this.editor.lines;
    const matched = matchKeys(old, newLines);
    this.suspendScenes = true;
    try {
      this.editor.edit((tx) => {
        tx.replaceAll(matched);
        return cursor({ line: Math.min(head.line, matched.length - 1), ch: head.ch });
      }, origin === 'external' ? 'external' : 'command');
      // Scenes whose heading line changed are matched to stored information again.
      this.syncSceneRecordsFromKeys();
      if (sceneIds && this.project) {
        // A restored draft knows which scene is which.
        const used = new Set(this.project.sceneIds.values());
        this.editor.parsed.scenes.forEach((sc, i) => {
          const key = this.editor.lines[sc.line].key;
          const id = sceneIds[i];
          if (id && !this.project!.sceneIds.has(key) && !used.has(id)) {
            this.project!.sceneIds.set(key, id);
            used.add(id);
          }
        });
      }
      this.assignSceneIdsFromRecords(true);
    } finally {
      this.suspendScenes = false;
    }
    this.refreshDerived(true);
    if (message) toast(message, { actions: [{ label: t("Undo"), run: () => this.editor.undo() }] });
  }

  // ---------------------------------------------------------------------------------
  // Editor events

  private derivedTimer: any = null;

  /** While true, scene identity is being re-established and derived state waits. */
  private suspendScenes = false;

  private onEditorChange(origin: string, steps: Step[] = []) {
    if (!this.project) return;
    if (origin === 'load') return; // openProject assigns scene identity first
    this.annotations.onChange(origin, steps);
    if (origin !== 'load') {
      if (this.isDirty()) {
        if (this.saveState !== 'conflict' && this.saveState !== 'missing') this.setSaveState('unsaved');
        this.scheduleSave();
      } else if (this.saveState === 'unsaved') this.setSaveState('saved');
    }
    if (this.suspendScenes) return;
    this.refreshDerived(false);
    // Undo/redo can move the caret into text the current view hides: follow it.
    if ((origin === 'undo' || origin === 'redo') && !this.editor.isVisibleLine(this.editor.sel.head.line)) {
      const head = this.editor.sel.head;
      if (this.view === 'scene') {
        const item = this.sceneAt(head.line);
        if (item) this.enterScene(item, { caret: head });
      } else if (this.view === 'dialogue') {
        this.goToPassage();
      }
    }
  }

  /** Updates scenes, outline and counts after a change. */
  refreshDerived(force: boolean) {
    this.updateScenes();
    this.outline.render();
    if (force) this.cards.render();
    else this.cards.renderSoon();
    this.characters.renderSoon();
    if (this.view === 'dialogue' && force) this.applyDialogueFilter(false);
    this.updateViewControls();
    clearTimeout(this.derivedTimer);
    this.derivedTimer = setTimeout(() => this.updateCounts(), force ? 0 : 250);
    this.findbar.onDocChange();
    this.updatePageMarkers();
    this.updateTitleHiding();
  }

  /** Script view without the title page (setting): hides the title lines and the blank lines after them. */
  updateTitleHiding() {
    const ed = this.editor;
    const hide = !!this.project && this.view === 'script' && !this.settings.editor.titlePageInScript && ed.parsed.titleEnd > 0;
    if (!hide) return ed.setHidden(null);
    const keys = new Set<number>();
    let i = 0;
    for (; i < ed.parsed.titleEnd && i < ed.lines.length; i++) keys.add(ed.lines[i].key);
    for (; i < ed.lines.length - 1 && ed.lines[i].text.trim() === ''; i++) keys.add(ed.lines[i].key);
    ed.setHidden(keys);
  }

  private fonts: FontEntry[] | null = null;

  private paginationCache: { key: string; value: ReturnType<typeof paginate> } | null = null;

  /**
   * The screenplay paginated with the project's export settings (cached per version). Page
   * markers, card lengths and the timeline all use it, so they agree with the PDF. Null while
   * the metrics of a system font are still loading.
   */
  pagination(): ReturnType<typeof paginate> | null {
    const s = projectExportSettings(this);
    let adv = 0.6;
    if (s.font !== 'Courier' && s.font !== 'Courier Prime') {
      if (!this.fonts) {
        loadFonts().then((f) => {
          this.fonts = f;
          this.updatePageMarkers();
          this.cards.structureChanged();
        });
        return null;
      }
      adv = this.fonts.find((f) => f.family === s.font)?.advance ?? 0.6;
    }
    const key = `${this.editor.version}|${adv}|${JSON.stringify(s)}`;
    if (this.paginationCache?.key !== key) this.paginationCache = { key, value: paginate(this.editor.lineTexts, this.editor.parsed, s, { kind: 'all' }, adv) };
    return this.paginationCache.value;
  }

  /** Page break markers in Script/Source view, from the project's export settings. */
  updatePageMarkers = debounce(() => {
    const on = !!this.project && this.settings.editor.showPageBreaks && this.isFullView();
    if (!on) {
      this.editor.setPageMarkers([]);
      return;
    }
    const r = this.pagination();
    if (!r) return;
    const L = this.editor.lines;
    const pages = r.pages.filter((p) => !p.title);
    const markers: Array<{ key: number; frac: number; label: string }> = [];
    for (let i = 1; i < pages.length; i++) {
      const prev = pages[i - 1].lines.filter((l) => l.kind !== 'more');
      const lastSrc = prev.reduce((m, l) => Math.max(m, l.sourceLine), -1);
      const rows = pages[i].lines.slice().sort((a, b) => a.row - b.row);
      const first = rows.find((l) => l.kind !== 'more' && l.sourceLine >= lastSrc);
      if (!first || !L[first.sourceLine]) continue;
      const src = first.sourceLine;
      const before = new Set(prev.filter((l) => l.sourceLine === src).map((l) => l.row)).size;
      const after = new Set(rows.filter((l) => l.sourceLine === src).map((l) => l.row)).size;
      markers.push({ key: L[src].key, frac: before ? before / (before + after) : 0, label: String(pages[i].number) });
    }
    this.editor.setPageMarkers(markers);
  }, 350);

  private onSelectionChange() {
    // A scene clicked in the list stays marked only until writing moves to another scene.
    const act = this.activeScene();
    if (act && act.id !== this.lastActiveSceneId) {
      this.lastActiveSceneId = act.id;
      if (this.sceneSel.size === 1 && !this.sceneSel.has(act.id)) this.setSceneSelection([], null);
    }
    this.outline.updateActive();
    this.updateStatusScene();
    if (!selEmpty(this.editor.sel) || this.lastSelNonEmpty) {
      clearTimeout(this.derivedTimer);
      this.derivedTimer = setTimeout(() => this.updateCounts(), 120);
    }
    this.lastSelNonEmpty = !selEmpty(this.editor.sel);
    this.rightPane.onActiveSceneChange();
    this.saveStateSoon();
  }
  private lastSelNonEmpty = false;
  private lastActiveSceneId: string | null = null;

  private onScroll() {
    if (this.isFullView()) {
      this.saveStateSoon();
      this.outline.updateActive();
    }
  }

  // ---------------------------------------------------------------------------------
  // Scenes

  get parsed(): ParseResult {
    return this.editor.parsed;
  }

  /** Assigns scene ids from stored records (on open or after an external reload). */
  private assignSceneIdsFromRecords(keepExisting = false) {
    const p = this.project;
    if (!p) return;
    const lines = this.editor.lineTexts;
    const parsed = this.editor.parsed;
    const scenes = parsed.scenes;
    const sigs = scenes.map((s) => ({ heading: s.heading, fingerprint: fingerprint(lines.slice(s.line + 1, s.end)) }));
    if (keepExisting) {
      // Scenes whose heading line survived keep their id.
      const remaining = scenes.map((s, i) => ({ s, i })).filter(({ s }) => !p.sceneIds.has(this.editor.lines[s.line].key));
      const known = new Set(scenes.map((s) => p.sceneIds.get(this.editor.lines[s.line].key)).filter(Boolean));
      const recs = p.meta.scenes.filter((r) => !known.has(r.id));
      const res = reconcile(recs, remaining.map(({ i }) => sigs[i]));
      remaining.forEach(({ s }, n) => {
        const id = res.ids[n] ?? uid();
        p.sceneIds.set(this.editor.lines[s.line].key, id);
      });
      for (const r of res.unmatched) if (hasInfo(r)) this.addDetached(r, res.ambiguous.includes(r) ? t('Matches more than one scene after an external change') : t('Scene not found after an external change'));
    } else {
      p.sceneIds.clear();
      const res = reconcile(p.meta.scenes, sigs);
      scenes.forEach((s, i) => p.sceneIds.set(this.editor.lines[s.line].key, res.ids[i] ?? uid()));
      for (const r of res.unmatched) if (hasInfo(r)) this.addDetached(r, res.ambiguous.includes(r) ? t('Matches more than one scene') : t('Scene not found in the screenplay'));
      if (res.unmatched.length) this.markMetaDirty();
    }
    this.updateScenes();
  }

  /** Forgets heading keys that are no longer headings, so their records can be matched again. */
  private syncSceneRecordsFromKeys() {
    const p = this.project;
    if (!p) return;
    const headingKeys = new Set(this.editor.parsed.scenes.map((s) => this.editor.lines[s.line].key));
    for (const k of [...p.sceneIds.keys()]) if (!headingKeys.has(k)) p.sceneIds.delete(k);
  }

  private addDetached(r: SceneRecord, reason: string) {
    const p = this.project!;
    if (p.meta.detached.some((d) => d.id === r.id)) return;
    p.meta.detached.push(detach(r, reason));
    p.meta.scenes = p.meta.scenes.filter((x) => x.id !== r.id);
    this.markMetaDirty();
  }

  private updateScenes() {
    const p = this.project;
    const parsed = this.editor.parsed;
    const lines = this.editor.lines;
    const items: SceneItem[] = [];
    if (parsed.titleEnd > 0) items.push({ kind: 'title', id: 'title', key: lines[0].key, line: 0, end: parsed.titleEnd, heading: t('Title page'), order: 0, number: '' });
    const firstScene = parsed.scenes[0];
    const openingEnd = firstScene ? firstScene.line : lines.length;
    let openingHas = false;
    // Acts and sequences (sections) and their synopses before the first scene are structure,
    // not an opening: only real text (FADE IN:, a prologue) makes one.
    for (let i = parsed.bodyStart; i < openingEnd; i++) {
      const t = parsed.lines[i].type;
      if (lines[i].text.trim() && t !== 'section' && t !== 'synopsis') openingHas = true;
    }
    if (openingHas) items.push({ kind: 'opening', id: 'opening', key: lines[parsed.bodyStart].key, line: parsed.bodyStart, end: openingEnd, heading: t('Opening'), order: 0, number: '' });
    if (p) {
      let changed = false;
      const nums = sceneNumberList(parsed, this.numbersLocked);
      for (const [si, s] of parsed.scenes.entries()) {
        const key = lines[s.line].key;
        let id = p.sceneIds.get(key);
        if (!id) {
          id = uid();
          p.sceneIds.set(key, id);
          changed = true;
        }
        const record = p.meta.scenes.find((r) => r.id === id) ?? p.meta.detached.find((r) => r.id === id);
        items.push({ kind: 'scene', id, key, line: s.line, end: s.end, heading: s.heading, order: s.order, sceneNumber: s.sceneNumber, number: nums[si], record });
      }
      // Re-attach detached info whose scene came back (e.g. after undo).
      const present = new Set(items.map((i) => i.id));
      const back = p.meta.detached.filter((d) => present.has(d.id));
      if (back.length) {
        p.meta.detached = p.meta.detached.filter((d) => !present.has(d.id));
        for (const b of back) {
          const { detachedAt, reason, ...rec } = b;
          p.meta.scenes.push(rec);
        }
        changed = true;
      }
      // Records with info whose scene vanished become detached (reviewable, restorable by undo).
      const gone = p.meta.scenes.filter((r) => !present.has(r.id));
      if (gone.length) {
        for (const r of gone) {
          if (hasInfo(r)) p.meta.detached.push(detach(r, t('The scene heading was removed or changed into other text')));
        }
        p.meta.scenes = p.meta.scenes.filter((r) => present.has(r.id));
        changed = true;
      }
      const sig = items.map((i) => `${i.id}:${i.heading}`).join('|');
      if (sig !== this.lastScenesSig) {
        this.lastScenesSig = sig;
        changed = true;
      }
      if (changed) this.markMetaDirty();
    }
    this.scenes = items;
  }

  /** Writes current heading text, fingerprint and order into the scene records. */
  private syncSceneRecords() {
    const p = this.project;
    if (!p || this.suspendScenes) return;
    // Work from the current text so no record is dropped because of stale scene items.
    this.updateScenes();
    const lines = this.editor.lineTexts;
    const byId = new Map(p.meta.scenes.map((r) => [r.id, r]));
    const out: SceneRecord[] = [];
    for (const s of this.scenes) {
      if (s.kind !== 'scene') continue;
      // Records are updated in place so references held by panes stay valid.
      const rec: SceneRecord = byId.get(s.id) ?? { id: s.id, heading: '', fingerprint: '', order: 0 };
      rec.heading = s.heading;
      rec.fingerprint = fingerprint(lines.slice(s.line + 1, s.end));
      rec.order = s.order;
      out.push(rec);
    }
    p.meta.scenes = out;
  }

  sceneRecord(item: SceneItem): SceneRecord | undefined {
    const p = this.project;
    if (!p || item.kind !== 'scene') return undefined;
    let r = p.meta.scenes.find((x) => x.id === item.id);
    if (!r) {
      r = { id: item.id, heading: item.heading, fingerprint: '', order: item.order };
      p.meta.scenes.push(r);
    }
    // Lists read item.record; keep it pointing at the live record.
    item.record = r;
    const listed = this.scenes.find((s) => s.id === item.id);
    if (listed) listed.record = r;
    return r;
  }

  updateSceneRecord(item: SceneItem, patch: Partial<SceneRecord>) {
    if (!this.sceneRecord(item)) return;
    this.undoable(() => {
      Object.assign(this.sceneRecord(item)!, patch);
      this.markMetaDirty();
    }, t("Scene Details"));
    this.updateScenes();
    this.outline.render();
    this.cards.render();
  }

  /** Scene item containing a document line (title page and opening included). */
  sceneAt(line: number): SceneItem | undefined {
    let best: SceneItem | undefined;
    for (const s of this.scenes) if (line >= s.line && line < Math.max(s.end, s.line + 1)) best = s;
    // An act or sequence line between scenes belongs to the scene it opens.
    if (!best) best = this.scenes.find((s) => s.kind === 'scene' && s.line > line) ?? [...this.scenes].reverse().find((s) => s.kind === 'scene');
    return best;
  }

  /** The scene being written in (caret). */
  activeScene(): SceneItem | undefined {
    return this.sceneAt(this.editor.sel.head.line);
  }

  /** Scene at the reading position in Script view. */
  readingScene(): SceneItem | undefined {
    let item = this.editor.caretInView() ? this.activeScene() : this.sceneAt(this.editor.topVisibleLine());
    // At the top of the script (title page or opening) the first actual scene is used.
    if (!item || item.kind !== 'scene') item = this.scenes.find((s) => s.kind === 'scene') ?? this.scenes.find((s) => s.kind === 'opening');
    return item;
  }

  navigableScenes(): SceneItem[] {
    return this.scenes.filter((s) => s.kind !== 'title');
  }

  // ---------------------------------------------------------------------------------
  // Views

  private fullViewReturn: { line: number; ch: number; key: number; offset: number } | null = null;

  /** Script and Source show the whole screenplay. */
  isFullView(v: ViewName = this.view) {
    return v === 'script' || v === 'source';
  }

  /**
   * Switches views. Whenever the caret is on screen, it stays at the same screen position in
   * the new view (as far as the new view's content allows), so switching never jumps.
   */
  setView(v: ViewName, opts: { quiet?: boolean } = {}) {
    // Every view shows the screenplay: leave an open document.
    if (this.docs?.isOpen) {
      void this.docs.close(false);
      if (v === this.view && !this.panel) {
        this.updateChrome();
        if (!opts.quiet) this.editor.focus();
        return;
      }
    }
    // Only Script and Scene are written in minimal view; every other tab leaves it.
    if (this.minimal && v !== 'script' && v !== 'scene' && !opts.quiet) this.toggleMinimal();
    if (this.panel) {
      this.closePanel(false);
      if (v === this.view) {
        if (!opts.quiet) this.editor.focus();
        return;
      }
    }
    if (!this.project) {
      this.view = v;
      this.updateChrome();
      return;
    }
    const from = this.view;
    let offset = !opts.quiet && this.editor.caretInView() ? this.editor.measureCaretOffset() : null;
    // Scene and Dialogue have a header row above the text: keep the caret at the same height
    // on screen by showing/hiding it now and correcting the measured offset.
    const headH = (x: ViewName) => (x === 'dialogue' ? VIEW_HEAD_H : 0);
    if (offset !== null) offset += headH(from) - headH(v);
    this.center.classList.toggle('has-view-head', headH(v) > 0);
    if (from === 'scene') this.storeSceneContext();
    // Remember where the caret sat in Script/Source view: a shorter view (a single scene)
    // may not be able to show it at the same height, and returning should restore it exactly.
    const head = this.editor.sel.head;
    if (this.isFullView(from) && !this.isFullView(v) && offset !== null) this.fullViewReturn = { line: head.line, ch: head.ch, key: this.editor.lines[head.line].key, offset: offset + headH(v) - headH(from) };
    if (v === 'scene') {
      const item = this.isFullView(from) ? this.readingScene() : this.activeScene() ?? this.readingScene();
      this.editor.setSource(false);
      if (item) {
        const caretInItem = this.editor.sel.head.line >= item.line && this.editor.sel.head.line < Math.max(item.end, item.line + 1);
        this.enterScene(item, offset !== null && caretInItem ? { restoreContext: false, screenOffset: offset } : {});
      } else {
        this.view = 'scene';
        this.focus = null;
        this.editor.setFilter(new Set(), 'scene');
      }
    } else if (this.isFullView(v)) {
      const item = this.activeScene();
      this.view = v;
      this.focus = null;
      this.editor.setFilter(null, null);
      this.editor.setSource(v === 'source');
      // Hide (or show) the title page before restoring the caret position on screen.
      this.updateTitleHiding();
      if (from !== v && !opts.quiet) {
        const ret = this.fullViewReturn;
        const same = ret && ret.ch === head.ch && this.editor.lines[head.line]?.key === ret.key;
        if (same && !this.isFullView(from)) this.editor.restoreCaretOffset(ret!.offset);
        else if (offset !== null) this.editor.restoreCaretOffset(offset);
        else if (item && !this.isFullView(from)) this.editor.scrollToLine(item.line, 'top', 1);
      }
    } else {
      this.view = 'dialogue';
      this.focus = null;
      this.editor.setSource(false);
      this.dialogueSceneKey = this.activeScene()?.key ?? null;
      this.applyDialogueFilter(true, offset);
    }
    this.updateTitleHiding();
    this.updateChrome();
    this.outline.updateActive();
    this.updatePageMarkers();
    if (!opts.quiet) this.editor.focus();
    this.saveStateSoon();
  }

  /** Focuses one scene in Scene view, keeping per-scene caret and scroll context (the find bar follows). */
  enterScene(item: SceneItem, opts: { restoreContext?: boolean; caret?: Pos; screenOffset?: number | null } = {}) {
    const p = this.project;
    if (!p) return;
    if (this.docs.isOpen) void this.docs.close(false);
    this.storeSceneContext();
    this.view = 'scene';
    this.focus = item.kind === 'scene' ? { kind: 'scene', key: item.key } : item.kind === 'title' ? { kind: 'title' } : { kind: 'opening' };
    const keys = new Set<number>();
    for (let i = item.line; i < item.end; i++) keys.add(this.editor.lines[i].key);
    if (!keys.size) keys.add(this.editor.lines[item.line].key);
    // Trailing blank lines of a scene are hidden so every scene starts and ends cleanly.
    let last = item.end - 1;
    while (last > item.line && this.editor.lines[last].text.trim() === '' && last > item.line + 1) {
      if (this.editor.sel.head.line === last) break;
      keys.delete(this.editor.lines[last].key);
      last--;
    }
    this.editor.setHidden(null);
    this.editor.setFilter(keys, 'scene');
    const ctx = p.sceneCtx.get(item.id);
    let sel: Selection | null = null;
    if (opts.caret) sel = cursor(opts.caret);
    else if (opts.restoreContext !== false && ctx) {
      const a = this.lineOfKey(ctx.anchor.key);
      const hd = this.lineOfKey(ctx.head.key);
      if (a !== null && hd !== null && keys.has(ctx.anchor.key) && keys.has(ctx.head.key)) sel = { anchor: { line: a, ch: ctx.anchor.ch }, head: { line: hd, ch: ctx.head.ch } };
    }
    const head = this.editor.sel.head.line;
    if (!sel && head >= item.line && head < item.end && keys.has(this.editor.lines[head].key)) sel = this.editor.sel;
    if (!sel) {
      // Caret at the end of the heading, or at the start of the first written line.
      let line = item.line;
      for (let i = item.line + 1; i < item.end; i++) {
        if (keys.has(this.editor.lines[i].key) && this.editor.lines[i].text.trim()) {
          line = i;
          break;
        }
      }
      sel = cursor({ line, ch: line === item.line ? this.editor.lines[line].text.length : 0 });
    }
    this.editor.setSelection(sel, { scroll: false });
    if (opts.screenOffset != null) {
      this.editor.scrollTop = 0;
      this.editor.restoreCaretOffset(opts.screenOffset);
    } else if (ctx && opts.restoreContext !== false && !opts.caret) this.editor.scrollTop = ctx.scrollTop;
    else {
      this.editor.scrollTop = 0;
      this.editor.scrollToCaret('nearest');
    }
    this.updateChrome();
    this.outline.updateActive();
    this.rightPane.onActiveSceneChange();
    // In Scene view the find bar searches only the scene shown.
    this.findbar.onDocChange();
  }

  private storeSceneContext() {
    const p = this.project;
    if (!p || this.view !== 'scene' || !this.focus) return;
    const item = this.focusedItem();
    if (!item) return;
    const s = this.editor.sel;
    const L = this.editor.lines;
    p.sceneCtx.set(item.id, {
      anchor: { key: L[s.anchor.line].key, ch: s.anchor.ch },
      head: { key: L[s.head.line].key, ch: s.head.ch },
      scrollTop: this.editor.scrollTop,
    });
  }

  focusedItem(): SceneItem | undefined {
    const f = this.focus;
    if (!f) return undefined;
    if (f.kind === 'title') return this.scenes.find((s) => s.kind === 'title');
    if (f.kind === 'opening') return this.scenes.find((s) => s.kind === 'opening');
    return this.scenes.find((s) => s.kind === 'scene' && s.key === f.key);
  }

  lineOfKey(key: number): number | null {
    const L = this.editor.lines;
    for (let i = 0; i < L.length; i++) if (L[i].key === key) return i;
    return null;
  }

  toggleScriptScene() {
    if (!this.project) return;
    if (this.isFullView()) this.setView('scene');
    else this.setView('script');
  }

  /** Navigates to a scene: Script view scrolls, Scene view focuses it. */
  goToScene(item: SceneItem, opts: { focusEditor?: boolean } = {}) {
    if (!this.project) return;
    if (this.docs.isOpen) void this.docs.close(false);
    if (this.view === 'scene' || (item.kind === 'title' && !this.settings.editor.titlePageInScript)) {
      this.enterScene(item);
    } else {
      if (this.view === 'dialogue') this.setView('script', { quiet: true });
      const line = item.line;
      this.editor.setSelection(cursor({ line, ch: item.kind === 'scene' ? this.editor.lines[line].text.length : 0 }), { scroll: false });
      this.editor.scrollToLine(line, 'top', 1);
    }
    if (opts.focusEditor !== false) this.editor.focus();
  }

  stepScene(dir: number) {
    const list = this.navigableScenes();
    if (!list.length) return;
    let cur: SceneItem | undefined = this.view === 'scene' ? this.activeScene() ?? this.focusedItem() : this.activeScene();
    if (cur?.kind === 'title') cur = undefined;
    let idx = cur ? list.findIndex((s) => s.id === cur!.id) : -1;
    if (idx < 0) idx = dir > 0 ? -1 : list.length;
    const next = list[Math.max(0, Math.min(list.length - 1, idx + dir))];
    if (next && (next.id !== cur?.id || this.view === 'scene')) this.goToScene(next);
  }

  toggleTitlePage() {
    if (!this.project) return;
    const title = this.scenes.find((s) => s.kind === 'title');
    if (this.view === 'scene' && this.focus?.kind === 'title') {
      // Back to the first actual scene.
      const first = this.navigableScenes()[0];
      if (first) this.enterScene(first);
      return;
    }
    if (!title) {
      // Create a title page above the existing screenplay.
      const tpl = titlePageTemplate(this.project.name, new Date().toLocaleDateString(uiLocale()));
      const L = this.editor.lines;
      const needBlank = L.length > 0 && L[0].text.trim() !== '';
      this.editor.edit((tx) => {
        tx.insertLines(0, makeLines(tpl + (needBlank ? '\n' : '')));
        return cursor({ line: 0, ch: 7 + this.project!.name.length });
      });
      this.refreshDerived(true);
    }
    const t = this.scenes.find((s) => s.kind === 'title');
    if (t) {
      this.enterScene(t, { caret: !title ? { line: 0, ch: this.editor.lines[0].text.length } : undefined });
      this.editor.focus();
    }
  }

  /** Adds the common title page keys that are missing (empty ones are not printed). */
  addMissingTitleFields() {
    if (!this.project) return;
    const parsed = this.editor.parsed;
    if (parsed.titleEnd <= 0) return this.toggleTitlePage();
    const have = new Set<string>();
    let lastKeyLine = -1;
    for (let i = 0; i < parsed.titleEnd; i++) {
      const k = parsed.lines[i].titleKey;
      if (k) {
        have.add(k === 'authors' ? 'author' : k === 'date' ? 'draft date' : k);
      }
      if (parsed.lines[i].type === 'title' && this.editor.lines[i].text.trim()) lastKeyLine = i;
    }
    const missing = titlePageTemplate('', '')
      .split('\n')
      .filter((l) => l && !have.has(l.slice(0, l.indexOf(':')).toLowerCase()));
    if (!missing.length) {
      toast(t("The title page already has all common fields."));
      return;
    }
    const at = lastKeyLine + 1;
    this.editor.edit((tx) => {
      tx.insertLines(at, makeLines(missing.join('\n')));
      return cursor({ line: at, ch: missing[0].length });
    });
    toast(tn(missing.length, 'Added {0} title page field. Empty fields are not printed.', 'Added {0} title page fields. Empty fields are not printed.'));
  }

  // ---------------------------------------------------------------------------------
  // Dialogue view

  applyDialogueFilter(resetCaret: boolean, screenOffset: number | null = null) {
    const parsed = this.editor.parsed;
    const L = this.editor.lines;
    const keys = new Set<number>();
    let range: [number, number] = [0, L.length];
    if (this.dialogueScope === 'scene') {
      const key = this.dialogueSceneKey;
      const item = key !== null ? this.scenes.find((s) => s.key === key) : this.activeScene();
      if (item) range = [item.line, item.end];
    }
    const wanted = this.dialogueCharacter;
    const headingsShown = new Set<number>();
    for (const b of parsed.blocks) {
      if (b.cueLine < range[0] || b.cueLine >= range[1]) continue;
      if (wanted && b.cue !== wanted) continue;
      // Scene heading context
      const sIdx = sceneIndexAt(parsed.scenes, b.cueLine);
      if (sIdx >= 0 && !headingsShown.has(sIdx)) {
        headingsShown.add(sIdx);
        keys.add(L[parsed.scenes[sIdx].line].key);
      }
      if (this.dialogueAction) {
        // The action paragraph right before the block.
        let j = b.cueLine - 1;
        while (j >= 0 && parsed.lines[j].type === 'blank') j--;
        const actionEnd = j;
        while (j >= 0 && parsed.lines[j].type === 'action') j--;
        for (let k = j + 1; k <= actionEnd; k++) keys.add(L[k].key);
      }
      for (let k = b.cueLine; k < b.end; k++) if (parsed.lines[k].type !== 'blank') keys.add(L[k].key);
    }
    this.editor.setFilter(keys, 'dialogue');
    if (resetCaret && keys.size) {
      const head = this.editor.sel.head.line;
      if (!keys.has(L[head]?.key)) {
        const first = this.editor.displayedLines.find((i) => parsed.lines[i].type === 'dialogue') ?? this.editor.displayedLines[0];
        if (first !== undefined) this.editor.setSelection(cursor({ line: first, ch: L[first].text.length }), { scroll: 'top' });
      } else if (screenOffset !== null) {
        this.editor.scrollTop = 0;
        this.editor.restoreCaretOffset(screenOffset);
      } else this.editor.scrollToCaret('center');
    }
    this.updateViewControls();
  }

  private dialogueGapLabel(a: number, b: number): string | null {
    const parsed = this.editor.parsed;
    let action = false;
    let other = false;
    for (let i = a + 1; i < b; i++) {
      const ty = parsed.lines[i].type;
      if (ty === 'action' || ty === 'transition' || ty === 'centered' || ty === 'lyric') action = true;
      else if (ty === 'character' || ty === 'dialogue' || ty === 'parenthetical') other = true;
    }
    if (action && !this.dialogueAction) return t('action hidden');
    if (action) return t('more action hidden');
    if (other) return t('other dialogue hidden');
    return null;
  }

  goToPassage() {
    if (this.isFullView()) return;
    const caret = this.editor.sel.head;
    // Measured below the view header, which Script view does not have.
    const offset = this.editor.caretInView() ? (this.editor.measureCaretOffset() ?? 0) + VIEW_HEAD_H : null;
    if (this.view === 'scene') this.storeSceneContext();
    this.view = 'script';
    this.focus = null;
    this.center.classList.remove('has-view-head');
    this.editor.setFilter(null, null);
    this.updateTitleHiding();
    this.editor.setSelection(cursor(caret), { scroll: false });
    const ret = this.fullViewReturn;
    if (ret && ret.ch === caret.ch && this.editor.lines[caret.line]?.key === ret.key) this.editor.restoreCaretOffset(ret.offset);
    else if (offset !== null) this.editor.restoreCaretOffset(offset);
    else this.editor.scrollToCaret('center');
    this.updateChrome();
    this.updatePageMarkers();
    this.outline.updateActive();
    this.editor.focus();
  }

  // ---------------------------------------------------------------------------------
  // Scene operations (all undoable, keys preserved)

  /** Inserts a new scene directly after the scene being written in. */
  insertScene() {
    if (!this.project) return;
    const L = this.editor.lines;
    const active = this.activeScene();
    let at: number;
    if (!active || active.kind === 'title') {
      const first = this.scenes.find((s) => s.kind === 'scene');
      at = first ? first.line : L.length;
    } else at = active.end;
    const heading = this.settings.editor.defaultHeading.trim() || 'INT. LOCATION - DAY';
    const texts: string[] = [];
    if (at > 0 && L[at - 1].text.trim() !== '') texts.push('');
    const headingIdx = texts.length;
    texts.push(heading);
    if (this.settings.editor.blankAfterHeading) texts.push('');
    texts.push('');
    // Keep a blank line before the following heading even after the new scene gets text.
    if (at < L.length) texts.push('');
    const lines = texts.map((t) => ({ key: newKey(), text: t }));
    const headingKey = lines[headingIdx].key;
    this.editor.edit((tx) => {
      tx.insertLines(Math.min(at, tx.lines.length), lines);
      const hl = tx.lines.findIndex((l) => l.key === headingKey);
      return this.headingSelection(hl, tx.lines[hl].text);
    });
    this.refreshDerived(true);
    const item = this.scenes.find((s) => s.key === headingKey);
    if (item && this.view === 'scene') {
      this.enterScene(item, { restoreContext: false });
      this.editor.setSelection(this.headingSelection(item.line, this.editor.lines[item.line].text));
    } else if (item) {
      if (this.view === 'dialogue') this.setView('script', { quiet: true });
      this.editor.scrollToLine(item.line, 'top', 1);
    }
    this.editor.focus();
  }

  /** Selects the part of a heading after its prefix ("INT. |LOCATION - DAY|") for typing over. */
  private headingSelection(line: number, text: string): Selection {
    const m = /^(\S+\.?\s+)(.+)$/.exec(text);
    if (m) return { anchor: { line, ch: m[1].length }, head: { line, ch: text.length } };
    return cursor({ line, ch: text.length });
  }

  /** Moves a scene before (or after) another scene, preserving its lines and identity. */
  moveScene(item: SceneItem, target: SceneItem | null, after = false) {
    if (item.kind !== 'scene') return;
    if (target && target.id === item.id) return;
    const caret = this.editor.sel;
    const L = this.editor.lines;
    const caretKeys = { a: L[caret.anchor.line].key, ac: caret.anchor.ch, h: L[caret.head.line].key, hc: caret.head.ch };
    this.editor.edit((tx) => {
      const lines = tx.lines;
      const start = lines.findIndex((l) => l.key === item.key);
      const end = item.end - item.line + start;
      const block = tx.removeLines(start, end - start);
      // A moved scene always ends with a blank line so the next heading stays a heading.
      if (block[block.length - 1].text.trim() !== '') block.push({ key: newKey(), text: '' });
      let at: number;
      if (!target) at = lines.length;
      else {
        const tStart = lines.findIndex((l) => l.key === target.key);
        // The target's own lines are untouched by the removal, so its length is unchanged.
        at = after ? tStart + (target.end - target.line) : tStart;
      }
      at = Math.max(0, Math.min(lines.length, at));
      if (at > 0 && lines[at - 1].text.trim() !== '') block.unshift({ key: newKey(), text: '' });
      tx.insertLines(at, block);
      const find = (key: number) => lines.findIndex((l) => l.key === key);
      return { anchor: { line: find(caretKeys.a), ch: caretKeys.ac }, head: { line: find(caretKeys.h), ch: caretKeys.hc } };
    });
    this.refreshDerived(true);
    if (this.view === 'scene' && this.focus) {
      const f = this.focusedItem();
      if (f) this.enterScene(f, { restoreContext: true });
    }
    if (this.view === 'dialogue') this.applyDialogueFilter(false);
  }

  // ---------------------------------------------------------------------------------
  // Panels (Cards, Characters)

  openPanel(p: PanelName, preset: ExportPreset = {}) {
    if (!this.project) return;
    if (this.docs.isOpen) {
      // Export while writing a document exports the document.
      if (p === 'export') {
        void this.docs.exportPdf();
        return;
      }
      void this.docs.close(false);
    }
    if (this.panel === p) return;
    if (this.panel) this.closePanel(false);
    this.findbar.close(false);
    // Only Script and Scene are written in minimal view; every other tab leaves it.
    if (this.minimal) this.toggleMinimal();
    if (p === 'export') {
      // Export covers both panes as well; it starts below the tab bar like every tab.
      this.flush();
      this.exportHandle = openExport(this, this.mainEl, preset);
      if (!this.exportHandle) return;
    } else if (p === 'history') {
      this.flush();
      this.historyHandle = openHistory(this, this.mainEl, this.historyKey ?? undefined);
      this.historyKey = null;
      if (!this.historyHandle) return;
    }
    this.panel = p;
    if (p === 'cards') this.cards.open();
    else if (p === 'characters') this.characters.open();
    // Export and History cover both panes.
    document.body.classList.toggle('in-export', p === 'export' || p === 'history');
    this.placeStatus();
    this.alignStatus();
    this.updateChrome();
    this.saveStateSoon();
  }

  /** Back to the writing view underneath. */
  closePanel(focusEditor = true) {
    const p = this.panel;
    if (!p) return;
    this.panel = null;
    if (p === 'cards') this.cards.close(false);
    else if (p === 'characters') this.characters.close();
    else if (p === 'history') {
      this.historyHandle?.close();
      this.historyHandle = null;
    } else {
      this.exportHandle?.close();
      this.exportHandle = null;
    }
    document.body.classList.remove('in-export');
    this.placeStatus();
    this.alignStatus();
    this.updateChrome();
    if (focusEditor) this.editor.focus();
    this.saveStateSoon();
  }

  // ---------------------------------------------------------------------------------
  // Scene selection (several scenes at once)

  /** Scenes a command applies to: the whole selection when `it` is part of it, otherwise just `it`. */
  scenesFor(it: SceneItem): SceneItem[] {
    if (it.kind !== 'scene') return [it];
    if (this.sceneSel.size > 1 && this.sceneSel.has(it.id)) return this.scenes.filter((s) => s.kind === 'scene' && this.sceneSel.has(s.id));
    return [it];
  }

  /** Click handling shared by the outline and the cards. Returns true for a plain click. */
  clickSelect(it: SceneItem, e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }, order: SceneItem[]): boolean {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (e.shiftKey && this.sceneSelAnchor) {
      const a = order.findIndex((s) => s.id === this.sceneSelAnchor);
      const b = order.findIndex((s) => s.id === it.id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        this.setSceneSelection(order.slice(lo, hi + 1).filter((s) => s.kind === 'scene').map((s) => s.id), this.sceneSelAnchor);
        return false;
      }
    }
    if (mod) {
      const next = new Set(this.sceneSel);
      if (next.has(it.id)) next.delete(it.id);
      else next.add(it.id);
      this.setSceneSelection([...next], it.id);
      return false;
    }
    this.setSceneSelection([it.id], it.id);
    return true;
  }

  setSceneSelection(ids: string[], anchor: string | null) {
    this.sceneSel = new Set(ids);
    this.sceneSelAnchor = anchor;
    this.outline.applySelection();
    this.cards.applySelection();
    // While Cards is open, the notes pane follows the card with the cursor.
    if (this.panel === 'cards') this.rightPane?.onActiveSceneChange();
  }

  updateSceneRecords(items: SceneItem[], patch: Partial<SceneRecord>) {
    this.undoable(() => {
      for (const it of items) {
        const r = this.sceneRecord(it);
        if (r) Object.assign(r, patch);
      }
      this.markMetaDirty();
    }, t("Scene Details"));
    this.updateScenes();
    this.outline.render();
    this.cards.render();
  }

  /**
   * Moves several scenes together (in their current order) before or after `target`, as
   * one undoable change. Scenes that were apart end up next to each other.
   */
  moveScenes(items: SceneItem[], target: SceneItem | null, after = false) {
    const moving = items.filter((s) => s.kind === 'scene').sort((a, b) => a.line - b.line);
    if (!moving.length) return;
    if (moving.length === 1) return this.moveScene(moving[0], target, after);
    if (target && moving.some((m) => m.id === target.id)) return;
    const caret = this.editor.sel;
    const L = this.editor.lines;
    const caretKeys = { a: L[caret.anchor.line].key, ac: caret.anchor.ch, h: L[caret.head.line].key, hc: caret.head.ch };
    this.editor.edit((tx) => {
      const lines = tx.lines;
      const blocks: Line[][] = [];
      // Remove from the bottom up so earlier positions stay valid.
      for (const it of [...moving].reverse()) {
        const start = lines.findIndex((l) => l.key === it.key);
        const block = tx.removeLines(start, it.end - it.line);
        if (block[block.length - 1].text.trim() !== '') block.push({ key: newKey(), text: '' });
        blocks.unshift(block);
      }
      let at: number;
      if (!target) at = lines.length;
      else {
        const tStart = lines.findIndex((l) => l.key === target.key);
        at = after ? tStart + (target.end - target.line) : tStart;
      }
      at = Math.max(0, Math.min(lines.length, at));
      const all = blocks.flat();
      if (at > 0 && lines[at - 1].text.trim() !== '') all.unshift({ key: newKey(), text: '' });
      tx.insertLines(at, all);
      const find = (key: number) => lines.findIndex((l) => l.key === key);
      return { anchor: { line: find(caretKeys.a), ch: caretKeys.ac }, head: { line: find(caretKeys.h), ch: caretKeys.hc } };
    });
    this.refreshDerived(true);
    if (this.view === 'scene' && this.focus) {
      const f = this.focusedItem();
      if (f) this.enterScene(f, { restoreContext: true });
    }
    if (this.view === 'dialogue') this.applyDialogueFilter(false);
  }

  /**
   * Moves each selected scene one place up or down, past its unselected neighbour, as one
   * undoable change. A group that is together moves as a whole; at the top or bottom a
   * scene stays where it is.
   */
  moveScenesBy(items: SceneItem[], dir: number) {
    const moving = items.filter((s) => s.kind === 'scene');
    if (moving.length <= 1) return moving[0] && this.moveSceneBy(moving[0], dir);
    const order = this.scenes.filter((s) => s.kind === 'scene');
    const sel = new Set(moving.map((m) => m.id));
    const moves: Array<{ item: SceneItem; target: SceneItem; after: boolean }> = [];
    if (dir > 0) {
      for (let i = order.length - 2; i >= 0; i--) {
        if (sel.has(order[i].id) && !sel.has(order[i + 1].id)) {
          moves.push({ item: order[i], target: order[i + 1], after: true });
          [order[i], order[i + 1]] = [order[i + 1], order[i]];
        }
      }
    } else {
      for (let i = 1; i < order.length; i++) {
        if (sel.has(order[i].id) && !sel.has(order[i - 1].id)) {
          moves.push({ item: order[i], target: order[i - 1], after: false });
          [order[i], order[i - 1]] = [order[i - 1], order[i]];
        }
      }
    }
    if (!moves.length) return;
    const caret = this.editor.sel;
    const L = this.editor.lines;
    const caretKeys = { a: L[caret.anchor.line].key, ac: caret.anchor.ch, h: L[caret.head.line].key, hc: caret.head.ch };
    this.editor.edit((tx) => {
      const lines = tx.lines;
      // Block lengths are taken by key at move time: an earlier move may have added a blank line.
      const lengthOf = (it: SceneItem) => {
        const start = lines.findIndex((l) => l.key === it.key);
        let end = start + 1;
        const headingKeys = new Set(this.scenes.filter((x) => x.kind === 'scene').map((x) => x.key));
        while (end < lines.length && !headingKeys.has(lines[end].key)) end++;
        return { start, len: end - start };
      };
      for (const m of moves) {
        const src = lengthOf(m.item);
        const block = tx.removeLines(src.start, src.len);
        if (block[block.length - 1].text.trim() !== '') block.push({ key: newKey(), text: '' });
        const t = lengthOf(m.target);
        let at = m.after ? t.start + t.len : t.start;
        at = Math.max(0, Math.min(lines.length, at));
        if (at > 0 && lines[at - 1].text.trim() !== '') block.unshift({ key: newKey(), text: '' });
        tx.insertLines(at, block);
      }
      const find = (key: number) => lines.findIndex((l) => l.key === key);
      return { anchor: { line: find(caretKeys.a), ch: caretKeys.ac }, head: { line: find(caretKeys.h), ch: caretKeys.hc } };
    });
    this.refreshDerived(true);
    if (this.view === 'scene' && this.focus) {
      const f = this.focusedItem();
      if (f) this.enterScene(f, { restoreContext: true });
    }
    if (this.view === 'dialogue') this.applyDialogueFilter(false);
  }

  /**
   * Locks scene numbers for production: every heading gets its current number written into
   * the Fountain text (#12#). From then on new scenes take letters (12A) and removed scenes
   * stay as OMITTED, so numbers on pages already sent out never change.
   */
  lockSceneNumbers() {
    const parsed = this.editor.parsed;
    const nums = sceneNumberList(parsed, this.numbersLocked);
    const edits: Array<{ line: number; text: string }> = [];
    parsed.scenes.forEach((sc, i) => {
      if (sc.sceneNumber) return;
      const text = this.editor.lines[sc.line].text;
      edits.push({ line: sc.line, text: `${text.trimEnd()} #${nums[i]}#` });
    });
    this.undoable(() => {
      this.project!.meta.numbersLocked = true;
      this.markMetaDirty();
    }, t("Lock Scene Numbers"));
    if (edits.length)
      this.editor.edit((tx) => {
        for (const e of edits) tx.setLine(e.line, e.text);
        return this.editor.sel;
      });
    this.editor.history.seal();
    this.refreshDerived(true);
    this.outline.refresh();
    toast(t("Scene numbers locked. New scenes get letters such as {0}A; removed scenes stay as omitted.", nums[0]), { actions: [{ label: t("Undo"), run: () => this.unlockUndo(edits.length > 0) }] });
  }

  /**
   * With locked numbers, writes the letter numbers of new scenes (12A) into their headings,
   * e.g. after pages went out, so they cannot shift any more. Returns the numbers written.
   */
  writeNewSceneNumbers(): string[] {
    const parsed = this.editor.parsed;
    if (!this.numbersLocked) return [];
    const nums = sceneNumberList(parsed, this.numbersLocked);
    const edits = parsed.scenes.flatMap((sc, i) => (sc.sceneNumber ? [] : [{ line: sc.line, text: `${this.editor.lines[sc.line].text.trimEnd()} #${nums[i]}#`, num: nums[i] }]));
    if (!edits.length) return [];
    this.editor.history.seal();
    this.editor.edit((tx) => {
      for (const e of edits) tx.setLine(e.line, e.text);
      return this.editor.sel;
    });
    this.editor.history.seal();
    this.refreshDerived(true);
    return edits.map((e) => e.num);
  }

  async unlockSceneNumbers() {
    const parsed = this.editor.parsed;
    const omitted = parsed.scenes.filter((sc) => isOmittedHeading(this.editor.lines[sc.line].text));
    const msg = [
      t('Written numbers are removed from all headings and scenes are counted 1, 2, 3 … again.'),
      omitted.length ? tn(omitted.length, 'The omitted scene (only a number) is removed as well.', 'The {0} omitted scenes (only a number) are removed as well.') : '',
      t('You can undo this.'),
    ].filter(Boolean).join(' ');
    if (!(await confirmDialog(t("Unlock scene numbers"), msg, t("Unlock")))) return;
    const edits = sceneNumberEdits(this.editor.lineTexts, parsed, 'remove');
    const omit = omitted.map((sc) => ({ key: this.editor.lines[sc.line].key, len: sc.end - sc.line }));
    this.editor.edit((tx) => {
      for (const e of edits) tx.setLine(e.line, e.text);
      for (const o of omit) {
        const start = tx.lines.findIndex((l) => l.key === o.key);
        if (start >= 0) tx.removeLines(start, Math.min(o.len, tx.lines.length - start));
      }
      if (tx.lines.length === 0) tx.insertLines(0, [{ key: newKey(), text: '' }]);
      return cursor({ line: Math.min(this.editor.sel.head.line, tx.lines.length - 1), ch: 0 });
    });
    this.undoable(() => {
      this.project!.meta.numbersLocked = false;
      this.markMetaDirty();
    }, t("Unlock Scene Numbers"));
    this.editor.history.seal();
    this.refreshDerived(true);
    this.outline.refresh();
    toast(t("Scene numbers unlocked."), { actions: [{ label: t("Undo"), run: () => this.unlockUndo(true) }] });
  }

  get numbersLocked(): boolean {
    return !!this.project?.meta.numbersLocked;
  }

  /** Undoes a lock or unlock (a text change and the project flag). */
  private unlockUndo(withText: boolean) {
    this.run('edit.undo');
    if (withText) this.run('edit.undo');
    this.outline.refresh();
  }

  /** With locked numbers a removed scene leaves "OMITTED #12#" behind; returns the lines to keep. */
  private omittedLines(item: SceneItem): Array<{ key: number; text: string }> | null {
    if (!this.numbersLocked || isOmittedHeading(item.heading)) return null;
    return [
      { key: newKey(), text: omittedHeading(item.number, scriptLanguage(this)) },
      { key: newKey(), text: '' },
    ];
  }

  // ---------------------------------------------------------------------------------
  // Scene archive: scenes taken out of the screenplay but kept (text and details)

  /** Moves scenes out of the screenplay into the project's archive (one undo step). */
  archiveScenes(items: SceneItem[]) {
    const p = this.project;
    const arch = items.filter((s) => s.kind === 'scene').sort((a, b) => a.line - b.line);
    if (!p || !arch.length) return;
    const order = this.scenes.filter((s) => s.kind === 'scene');
    const ids = new Set(arch.map((a) => a.id));
    const L = this.editor.lines;
    const secs = sectionsOf(this.editor.parsed, this.editor.lineTexts);
    const now = new Date().toISOString();
    const entries: ArchivedScene[] = arch.map((it) => {
      const i = order.findIndex((s) => s.id === it.id);
      let prev: SceneItem | undefined;
      for (let k = i - 1; k >= 0; k--) if (!ids.has(order[k].id)) { prev = order[k]; break; }
      let next: SceneItem | undefined;
      for (let k = i + 1; k < order.length; k++) if (!ids.has(order[k].id)) { next = order[k]; break; }
      const opensSection = secs.some((x) => x.firstScene === i);
      const lines = L.slice(it.line, Math.max(it.end, it.line + 1)).map((l) => l.text);
      while (lines.length > 1 && lines[lines.length - 1].trim() === '') lines.pop();
      const r = it.record;
      return { id: it.id, heading: it.heading, number: it.number, lines, summary: r?.summary, status: r?.status, color: r?.color, notes: r?.notes, archivedAt: now, afterId: prev?.id, beforeId: next?.id, opensSection };
    });
    const wasFocused = this.view === 'scene' && this.focus?.kind === 'scene' && arch.some((a) => a.key === (this.focus as any).key);
    this.editor.history.seal();
    this.editor.edit((tx) => {
      for (const it of [...arch].reverse()) {
        const start = tx.lines.findIndex((l) => l.key === it.key);
        if (start < 0) continue;
        tx.removeLines(start, it.end - it.line);
        const keep = this.omittedLines(it);
        if (keep) tx.insertLines(start, keep);
      }
      if (tx.lines.length === 0) tx.insertLines(0, [{ key: newKey(), text: '' }]);
      return cursor({ line: Math.min(arch[0].line, tx.lines.length - 1), ch: 0 });
    });
    this.undoable(() => {
      p.meta.sceneArchive = [...entries.reverse(), ...(p.meta.sceneArchive ?? [])];
      this.markMetaDirty();
    }, arch.length === 1 ? t("Archive Scene") : t("Archive Scenes"));
    this.editor.history.joinLast();
    this.setSceneSelection([], null);
    this.refreshDerived(true);
    if (wasFocused) {
      const f = this.activeScene();
      if (f) this.enterScene(f);
    }
    this.outline.refresh();
    toast(arch.length === 1 ? t("“{0}” moved to the scene archive.", arch[0].heading) : t("{0} scenes moved to the scene archive.", arch.length), { actions: [{ label: t("Undo"), run: () => this.run('edit.undo') }] });
  }

  /**
   * Puts an archived scene back: where it was (after the scene it followed, or in place of its
   * omitted number when scene numbers are locked), or after the current scene.
   */
  restoreArchivedScene(id: string, where: 'original' | 'current' = 'original') {
    const p = this.project;
    const entry = p?.meta.sceneArchive?.find((x) => x.id === id);
    if (!p || !entry) return;
    const order = this.scenes.filter((s) => s.kind === 'scene');
    const lines = entry.lines.map((text) => ({ key: newKey(), text }));
    lines.push({ key: newKey(), text: '' });
    const headKey = lines[0].key;
    // With locked numbers, the omitted placeholder for its number is replaced.
    const numMatch = /#([^#]+)#\s*$/.exec(entry.lines[0] ?? '');
    const omitted = numMatch ? order.find((s) => isOmittedHeading(this.editor.lines[s.line].text) && s.sceneNumber === numMatch[1]) : undefined;
    let target: SceneItem | undefined;
    // The first scene of an act goes back in front of the scene that followed it (after the
    // act line); any other scene after the one it followed.
    const before = where === 'original' && (entry.opensSection || !entry.afterId) && entry.beforeId ? order.find((s) => s.id === entry.beforeId) : undefined;
    if (where === 'current') target = this.activeScene()?.kind === 'scene' ? this.activeScene() : order[order.length - 1];
    else if (!before) target = entry.afterId ? order.find((s) => s.id === entry.afterId) : undefined;
    this.editor.history.seal();
    this.editor.edit((tx) => {
      const T = tx.lines;
      let at: number;
      if (where === 'original' && omitted) {
        at = T.findIndex((l) => l.key === omitted.key);
        tx.removeLines(at, omitted.end - omitted.line);
      } else if (before) {
        at = T.findIndex((l) => l.key === before.key);
      } else if (target) {
        const t = T.findIndex((l) => l.key === target!.key);
        at = t + (target.end - target.line);
      } else {
        // It was the first scene: before the first one now (after the title page and opening).
        const first = order[0];
        at = first ? T.findIndex((l) => l.key === first.key) : T.length;
      }
      at = Math.max(0, Math.min(T.length, at));
      const ins = [...lines];
      if (at > 0 && T[at - 1].text.trim() !== '') ins.unshift({ key: newKey(), text: '' });
      tx.insertLines(at, ins);
      const hl = T.findIndex((l) => l.key === headKey);
      return cursor({ line: hl, ch: 0 });
    });
    this.refreshDerived(true);
    const item = this.scenes.find((s) => s.key === headKey);
    this.undoable(() => {
      p.meta.sceneArchive = p.meta.sceneArchive.filter((x) => x.id !== id);
      if (item) {
        const r = this.sceneRecord(item);
        if (r) Object.assign(r, { summary: entry.summary, status: entry.status, color: entry.color, notes: entry.notes });
      }
      this.markMetaDirty();
    }, t("Restore Scene"));
    this.editor.history.joinLast();
    this.updateScenes();
    this.outline.refresh();
    this.cards.render();
    if (item) this.goToScene(item);
    toast(t("“{0}” is back in the screenplay.", entry.heading), { actions: [{ label: t("Undo"), run: () => this.run('edit.undo') }] });
  }

  async deleteArchivedScene(id: string) {
    const p = this.project;
    const entry = p?.meta.sceneArchive?.find((x) => x.id === id);
    if (!p || !entry) return;
    if (!(await confirmDialog(t("Delete archived scene"), t("Delete “{0}” from the archive? You can undo this.", entry.heading), t("Delete"), { danger: true }))) return;
    this.undoable(() => {
      p.meta.sceneArchive = p.meta.sceneArchive.filter((x) => x.id !== id);
      this.markMetaDirty();
    }, t("Delete Archived Scene"));
    this.outline.refresh();
    toast(t("Archived scene deleted."), { actions: [{ label: t("Undo"), run: () => this.run('edit.undo') }] });
  }

  async deleteScenes(items: SceneItem[]) {
    const del = items.filter((s) => s.kind === 'scene');
    if (del.length <= 1) return del[0] && this.deleteScene(del[0]);
    const locked = this.numbersLocked;
    const ok = await confirmDialog(t("Remove scenes"), [t('Remove {0} scenes and their text?', del.length), locked ? t('Scene numbers are locked, so each keeps its number as omitted.') : '', t('You can undo this.')].filter(Boolean).join(' '), t("Remove"), { danger: true });
    if (!ok) return;
    this.editor.edit((tx) => {
      for (const it of [...del].sort((a, b) => b.line - a.line)) {
        const start = tx.lines.findIndex((l) => l.key === it.key);
        tx.removeLines(start, it.end - it.line);
        const keep = this.omittedLines(it);
        if (keep) tx.insertLines(start, keep);
      }
      if (tx.lines.length === 0) tx.insertLines(0, [{ key: newKey(), text: '' }]);
      const first = Math.min(...del.map((d) => d.line));
      return cursor({ line: Math.min(first, tx.lines.length - 1), ch: 0 });
    });
    this.setSceneSelection([], null);
    this.refreshDerived(true);
    if (this.view === 'scene') {
      const f = this.activeScene();
      if (f) this.enterScene(f);
    }
  }

  moveSceneBy(item: SceneItem, dir: number) {
    const list = this.scenes.filter((s) => s.kind === 'scene');
    const i = list.findIndex((s) => s.id === item.id);
    if (i < 0) return;
    if (dir < 0 && i > 0) this.moveScene(item, list[i - 1], false);
    else if (dir > 0 && i < list.length - 1) this.moveScene(item, list[i + 1], true);
  }

  duplicateScene(item: SceneItem) {
    if (item.kind !== 'scene') return;
    const copy = this.editor.lines.slice(item.line, item.end).map((l) => ({ key: newKey(), text: l.text }));
    if (copy[copy.length - 1].text.trim() !== '') copy.push({ key: newKey(), text: '' });
    const headingKey = copy[0].key;
    this.editor.edit((tx) => {
      const start = tx.lines.findIndex((l) => l.key === item.key);
      const at = start + (item.end - item.line);
      if (at > 0 && tx.lines[at - 1].text.trim() !== '') copy.unshift({ key: newKey(), text: '' });
      tx.insertLines(at, copy);
      const hl = tx.lines.findIndex((l) => l.key === headingKey);
      return cursor({ line: hl, ch: tx.lines[hl].text.length });
    });
    // Copy scene information
    const rec = this.project?.meta.scenes.find((r) => r.id === item.id);
    this.refreshDerived(true);
    const dup = this.scenes.find((s) => s.key === headingKey);
    if (dup && rec) this.updateSceneRecord(dup, { summary: rec.summary, status: rec.status, color: rec.color, notes: rec.notes });
    if (dup) this.goToScene(dup);
  }

  async deleteScene(item: SceneItem) {
    if (item.kind !== 'scene') return;
    const keep = this.omittedLines(item);
    const ok = await confirmDialog(t("Remove scene"), [t('Remove “{0}” and its text?', item.heading), keep ? t('Scene numbers are locked, so {0} stays as omitted.', item.number) : '', t('You can undo this.')].filter(Boolean).join(' '), t("Remove"), { danger: true });
    if (!ok) return;
    const wasFocused = this.view === 'scene' && this.focus?.kind === 'scene' && this.focus.key === item.key;
    const list = this.navigableScenes();
    const idx = list.findIndex((s) => s.id === item.id);
    this.editor.edit((tx) => {
      const start = tx.lines.findIndex((l) => l.key === item.key);
      tx.removeLines(start, item.end - item.line);
      if (keep) tx.insertLines(start, keep);
      if (tx.lines.length === 0) tx.insertLines(0, [{ key: newKey(), text: '' }]);
      const line = Math.min(start, tx.lines.length - 1);
      return cursor({ line, ch: 0 });
    });
    this.refreshDerived(true);
    if (wasFocused) {
      const next = this.navigableScenes()[Math.min(idx, this.navigableScenes().length - 1)];
      if (next) this.enterScene(next);
    }
    toast(t("Scene removed."), { actions: [{ label: t("Undo"), run: () => this.run('edit.undo') }] });
  }

  // ---------------------------------------------------------------------------------
  // Chrome updates

  updateChrome() {
    const p = this.project;
    this.titleEl.textContent = p ? p.name : t("Scriptwright");
    this.subEl.textContent = p ? (this.docs?.isOpen ? this.docs.title : p.file) : '';
    this.docs?.render();
    bridge.window('setTitle', p ? `${p.name} — Scriptwright` : 'Scriptwright');
    for (const [v, b] of Object.entries(this.tabs)) {
      b.classList.toggle('on', !this.docs?.isOpen && (this.panel ? v === this.panel : v === this.view));
      b.disabled = !p;
    }
    // The panes are hidden under Export, so their toggles rest.
    this.leftToggle.disabled = this.panel === 'export' || this.panel === 'history';
    this.rightToggle.disabled = this.panel === 'export' || this.panel === 'history';
    this.updateViewControls();
    this.updateStatusScene();
    this.updateCounts();
  }

  private viewHeadScene: HTMLElement | null = null;
  private statusNav!: HTMLElement;

  updateViewControls() {
    const c = this.viewControls;
    c.textContent = '';
    this.viewHeadScene = null;
    const showNav = !!this.project && !this.panel && this.view === 'scene';
    this.statusNav.classList.toggle('hidden', !showNav);
    if (showNav) {
      const [prev, next] = Array.from(this.statusNav.children) as HTMLElement[];
      prev.title = t("Previous scene ({0})", this.commands.label('scene.prev'));
      next.title = t("Next scene ({0})", this.commands.label('scene.next'));
    }
    // Only Dialogue view has a header row (title, info and its options), like Cards and Characters.
    const show = !!this.project && !this.panel && this.view === 'dialogue';
    c.classList.toggle('hidden', !show);
    this.center.classList.toggle('has-view-head', show);
    if (!show) return;
    const chars = characterList(this.editor.parsed);
    const total = chars.reduce((n, x) => n + x.cues, 0);
    const who = chars.find((x) => x.name === this.dialogueCharacter);
    const info = this.dialogueCharacter
      ? this.dialogueScope === 'scene'
        ? tn(who?.cues ?? 0, '{0} speech in this scene', '{0} speeches in this scene')
        : tn(who?.cues ?? 0, '{0} speech', '{0} speeches')
      : [tn(chars.length, '{0} character', '{0} characters'), tn(total, '{0} speech', '{0} speeches')].join(' · ');
    const sel = h('select', { class: 'field', 'aria-label': t("Character"), title: t("Character") }, h('option', { value: '' }, t("All characters")));
    for (const ch of chars) sel.append(h('option', { value: ch.name }, characterLabel(ch)));
    if (this.dialogueCharacter && !chars.some((c2) => c2.name === this.dialogueCharacter)) sel.append(h('option', { value: this.dialogueCharacter }, t("{0} (0 speeches)", this.dialogueCharacter)));
    sel.value = this.dialogueCharacter;
    sel.addEventListener('change', () => {
      this.dialogueCharacter = sel.value;
      this.applyDialogueFilter(true);
      this.updateViewControls();
      this.editor.focus();
      this.saveStateSoon();
    });
    const scope = h('select', { class: 'field', 'aria-label': t("Scope") }, h('option', { value: 'all' }, t("Whole screenplay")), h('option', { value: 'scene' }, t("Current scene")));
    scope.value = this.dialogueScope;
    scope.addEventListener('change', () => {
      this.dialogueScope = scope.value as any;
      this.dialogueSceneKey = this.activeScene()?.key ?? this.dialogueSceneKey;
      this.applyDialogueFilter(true);
      this.updateViewControls();
      this.editor.focus();
      this.saveStateSoon();
    });
    const action = h('input', { type: 'checkbox', checked: this.dialogueAction });
    action.addEventListener('change', () => {
      this.dialogueAction = action.checked;
      this.applyDialogueFilter(false);
      this.editor.focus();
      this.saveStateSoon();
    });
    c.append(
      h('span', { class: 'doc-title view-head-title' }, t("Dialogue")),
      h('span', { class: 'dim view-head-info' }, info),
      h('span', { class: 'spacer' }),
      sel,
      scope,
      h('label', null, action, h('span', null, t("Nearby action"))),
      h('button', { class: 'btn', title: this.commands.label('dialogue.goToPassage'), onclick: () => this.goToPassage() }, t("Go to passage in Script")),
      h('button', {
        class: 'btn',
        title: t("Export this dialogue as PDF"),
        onclick: () => this.openPanel('export', { dialogue: { character: this.dialogueCharacter, action: this.dialogueAction } }),
      }, t("Export")),
    );
  }

  /** "Scene 4 of 38 · HEADING" in the Scene view header. */
  private updateViewHeadScene() {
    if (!this.viewHeadScene) return;
    const list = this.scenes.filter((s) => s.kind === 'scene');
    const f = this.focusedItem() ?? this.activeScene();
    this.viewHeadScene.textContent = !f ? '' : f.kind === 'scene' ? t("Scene {0} of {1}", f.order, list.length) : f.kind === 'title' ? t("Title page") : t("Opening");
  }

  private updateStatusScene() {
    this.updateViewHeadScene();
    const p = this.project;
    if (!p || this.docs?.isOpen) {
      this.statusScene.textContent = '';
      this.statusView.textContent = '';
      return;
    }
    const list = this.scenes.filter((s) => s.kind === 'scene');
    const a = this.activeScene();
    if (a?.kind === 'scene') this.statusScene.textContent = t("Scene {0} of {1}", a.order, list.length);
    else if (a?.kind === 'title') this.statusScene.textContent = t("Title page · {0} scenes", list.length);
    else this.statusScene.textContent = t("{0} scenes", list.length);
    this.statusView.textContent = '';
  }

  updateCounts() {
    if (!this.project) {
      this.statusCount.textContent = '';
      return;
    }
    if (this.docs?.isOpen) {
      this.statusCount.textContent = this.docs.countText();
      this.statusCount.title = '';
      return;
    }
    const parsed = this.editor.parsed;
    const L = this.editor.lines;
    let from = parsed.bodyStart;
    let to = L.length;
    let label = t('Screenplay');
    let isSel = false;
    let fromCh = -1;
    let toCh = -1;
    const sel = this.editor.sel;
    // Cards and Characters cover the whole screenplay: count all of it.
    if (this.panel) {
      // keep the defaults
    } else if (!selEmpty(sel)) {
      const a = selFrom(sel);
      const b = selTo(sel);
      from = a.line;
      to = b.line + 1;
      fromCh = a.ch;
      toCh = b.ch;
      label = t('Selection');
      isSel = true;
    } else if (this.view === 'scene') {
      const it = this.focusedItem();
      if (it) {
        from = it.line;
        to = it.end;
        label = it.kind === 'scene' ? t('Scene {0}', it.order) : it.heading;
      }
    } else if (this.view === 'dialogue') {
      label = t('Dialogue view');
    }
    let words = 0;
    let chars = 0;
    const filter = this.view === 'dialogue' && !this.panel ? this.editor.filterKeys : null;
    for (let i = from; i < to; i++) {
      if (filter && !filter.has(L[i].key)) continue;
      let text = L[i].text;
      const pl = parsed.lines[i];
      if (isSel) {
        const a = i === from ? fromCh : 0;
        const b = i === to - 1 ? toCh : text.length;
        text = text.slice(a, b);
        words += countWords(text);
        chars += text.length;
        continue;
      }
      if (pl.type === 'boneyard' || pl.type === 'note' || pl.type === 'section' || pl.type === 'synopsis') continue;
      const clean = cleanText(text, pl.flags);
      words += countWords(clean);
      chars += clean.length;
    }
    this.statusCount.textContent = t("{0} · {1} words · {2} characters", label, fmtNum(words), fmtNum(chars));
    this.statusCount.title = isSel ? t("Counts for the selected text") : t("Counts exclude notes, omitted text, sections and synopses");
  }

  updateWelcome() {
    const show = !this.project;
    if (!show) {
      this.welcomeEl?.remove();
      this.welcomeEl = null;
      this.editor.dom.classList.remove('hidden');
      return;
    }
    this.editor.dom.classList.add('hidden');
    this.welcomeEl?.remove();
    const box = h('div', { class: 'box' });
    if (!this.state.workspace) {
      box.append(
        h('h1', null, t("Choose a workspace")),
        h('p', null, t("A workspace is a folder that holds your screenplay projects. It can be inside a synced folder.")),
        h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => this.chooseWorkspace() }, t("Connect to workspace folder…"))),
      );
      if (this.state.recentWorkspaces.length) {
        const rec = h('div', { class: 'recent' }, h('div', { class: 'section-head', style: { padding: '0' } }, t("Recent")));
        for (const d of this.state.recentWorkspaces) rec.append(h('button', { class: 'row', onclick: () => this.setWorkspace(d) }, h('span', { class: 'label' }, d)));
        box.append(rec);
      }
    } else {
      box.append(
        h('h1', null, this.projects.length ? t("Open a project") : t("No projects yet")),
        h('p', null, this.projects.length ? t("Choose a project in the left pane, or create a new one.") : t("Create a project to start writing.")),
        h(
          'div',
          { class: 'actions' },
          h('button', { class: 'btn primary', onclick: () => this.newProject() }, t("New project…")),
          h('button', { class: 'btn', onclick: () => this.run('project.importFountain') }, t("Import Screenplay…")),
          h('button', { class: 'btn', onclick: () => this.chooseWorkspace() }, t("Change workspace…")),
        ),
      );
    }
    this.welcomeEl = h('div', { class: 'welcome' }, box);
    this.center.append(this.welcomeEl);
  }

  // ---------------------------------------------------------------------------------
  // Context menu

  private editorContextMenu(e: MouseEvent, pos: Pos | null) {
    const items: MenuItem[] = [];
    const ed = this.editor;
    const hasSel = !selEmpty(ed.sel);
    if (pos && bridge.spell && this.settings.editor.spellcheck && !hasSel) {
      const w = ed.wordAtPos(pos);
      if (w.text && this.isMisspelled(w.text)) {
        const sugg = bridge.spell.suggest(w.text).slice(0, 6);
        for (const s of sugg) items.push({ label: s, run: () => ed.replaceRange(w.from, w.to, s) });
        if (!sugg.length) items.push({ label: t("No suggestions"), disabled: true });
        items.push({
          label: t("Add to project dictionary"),
          run: () => {
            this.project?.meta.dictionary.push(w.text);
            this.markMetaDirty();
            ed.refresh();
          },
        });
        items.push({
          label: t("Add to personal dictionary"),
          run: () => {
            bridge.spell?.add(w.text);
            this.spellCache.set(w.text, false);
            ed.refresh();
          },
        });
        items.push({ sep: true });
      }
    }
    items.push({ label: t("Cut"), kbd: formatCombo('Mod+X'), disabled: !hasSel, run: () => this.clipboardCut() });
    items.push({ label: t("Copy"), kbd: formatCombo('Mod+C'), disabled: !hasSel, run: () => this.clipboardCopy() });
    items.push({ label: t("Paste"), kbd: formatCombo('Mod+V'), run: () => this.clipboardPaste() });
    items.push({ label: t("Select All"), kbd: formatCombo('Mod+A'), run: () => ed.selectAll() });
    items.push({ sep: true });
    items.push({ label: t("Rewrite…"), kbd: this.commands.label('edit.rewrite'), run: () => openRewrite(this, this.annotations) });
    items.push({ label: t("Comment…"), kbd: this.commands.label('edit.comment'), disabled: !hasSel, run: () => this.addComment() });
    items.push({ head: t("Highlight") });
    for (const c of ['yellow', 'green', 'blue', 'pink'] as const) items.push({ label: this.settings.highlights[c].label, dot: this.settings.highlights[c].color, disabled: !hasSel, run: () => this.highlight(c) });
    items.push({ label: t("Remove highlight"), disabled: !hasSel && !(pos && this.annotations.at(pos).some((r) => r.kind === 'highlight')), run: () => this.highlight(null, pos) });
    items.push({ sep: true });
    items.push({ label: t("Cut to shelf"), kbd: this.commands.label('shelf.cut'), disabled: !hasSel, run: () => toShelf(this, true) });
    items.push({ label: t("Copy to shelf"), kbd: this.commands.label('shelf.copy'), disabled: !hasSel, run: () => toShelf(this, false) });
    if (pos) {
      const ann = this.annotations;
      const { comments, passages } = this.annotationsAt(pos, ann);
      if (comments.length || passages.length) items.push({ sep: true });
      for (const c of comments) {
        const label = comments.length > 1 ? ` “${c.text.slice(0, 24)}${c.text.length > 24 ? '…' : ''}”` : '';
        items.push({ label: t("Open comment{0}…", label), kbd: formatCombo('Mod+Click'), run: () => openCommentDialog(this, ann, c.id) });
        items.push({ label: t("Delete comment{0}", label), run: () => deleteComment(ann, c.id) });
      }
      for (const p of passages) items.push({ label: passages.length > 1 ? t("Versions of {0}…", passageLabel(ann, p as PassageRecord, 30)) : t("Passage versions…"), kbd: comments.length ? undefined : formatCombo('Mod+Click'), run: () => openRewriteFor(this, ann, p.id) });
    }
    const pl = pos ? ed.parsed.lines[pos.line] : null;
    if (pl?.type === 'character' && pl.cue) {
      items.push({ sep: true }, { label: t("Rename {0}…", pl.cue), run: () => openRename(this, pl.cue) });
    }
    if (!this.isFullView()) items.push({ sep: true }, { label: t("Go to passage in Script"), kbd: this.commands.label('dialogue.goToPassage'), run: () => this.goToPassage() });
    openMenu(items, { x: e.clientX, y: e.clientY });
  }

  async clipboardCopy() {
    const t = this.editor.selectedText();
    if (t) await bridge.clipboard.writeText(t);
  }
  async clipboardCut() {
    const t = this.editor.selectedText();
    if (!t) return;
    await bridge.clipboard.writeText(t);
    this.editor.insertText('', 'other');
  }
  async clipboardPaste() {
    const t = await bridge.clipboard.readText();
    if (t) this.editor.paste(t);
  }

  // ---------------------------------------------------------------------------------
  // Commands

  run(id: string) {
    const c = this.commands.get(id);
    if (!c) return;
    if (c.enabled && !c.enabled()) return;
    Promise.resolve(c.run()).catch((e) => alertDialog(t("Something went wrong"), e?.message ?? String(e)));
  }

  private registerCommands() {
    const C = this.commands;
    const hasProject = () => !!this.project;
    const reg = (id: string, title: string, category: string, keys: string[], run: () => any, extra: Partial<Parameters<CommandRegistry['register']>[0]> = {}) =>
      C.register({ id, title, category, keys, run, ...extra });

    reg('app.commands', t("Commands & Shortcuts…"), t("App"), ['Mod+K'], () => openPalette(this), { inFields: true, menu: 'Help' });
    reg('app.about', t('About Scriptwright'), t('App'), [], () => this.openSettings('about'), { inFields: true, menu: isMac ? undefined : 'Help' });
    reg('app.updates', t('Check for Updates…'), t('App'), [], () => void checkForUpdates(this, false).then((r) => r?.available && this.openSettings('about')), { inFields: true, menu: isMac ? undefined : 'Help' });
    reg('app.settings', t("Settings…"), t("App"), ['Mod+P', 'Mod+,'], () => openSettings(this), { inFields: true, menu: isMac ? undefined : 'File' });
    reg('app.quit', t("Quit"), t("App"), ['Mod+Q'], () => this.quit(), { inFields: true, menu: isMac ? undefined : 'File' });
    reg('file.save', t("Save"), t("File"), ['Mod+S'], async () => {
      await this.flush();
      if (this.saveState === 'saved') toast(t("Saved."));
    }, { inFields: true, enabled: hasProject, menu: 'File' });
    reg('view.history', t("History"), t("View"), [isMac ? 'Mod+Y' : 'Mod+Shift+H'], () => (this.panel === 'history' ? this.closePanel() : this.openPanel('history')), { inFields: true, enabled: hasProject, menu: 'View' });
    reg('file.export', t("Export PDF…"), t("File"), ['Mod+E'], () => (this.panel === 'export' ? this.closePanel() : this.openPanel('export')), { inFields: true, enabled: hasProject, menu: 'File' });
    reg('project.new', t("New Project…"), t("File"), ['Mod+Shift+N'], () => this.newProject(), { menu: 'File' });
    reg('project.openWorkspace', t("Connect to Workspace Folder…"), t("File"), ['Mod+O'], () => this.chooseWorkspace(), { menu: 'File' });
    reg('workspace.create', t("Create New Workspace…"), t("File"), [], () => this.createWorkspace(), { menu: 'File' });
    reg('project.importFountain', t("Import Screenplay (Fountain, Final Draft, PDF)…"), t("File"), ['Mod+I'], () => this.importFountain(), { menu: 'File' });
    reg('project.backup', t("Back Up Project…"), t("File"), ['Mod+Shift+S'], () => this.backupProject(), { enabled: hasProject, menu: 'File' });
    reg('project.importBackup', t("Import Project Backup…"), t("File"), ['Mod+Shift+I'], () => this.importBackup(), { menu: 'File' });
    reg('project.rename', t("Rename Project…"), t("File"), ['Mod+Shift+R'], () => this.renameProject(), { enabled: hasProject, menu: 'File' });
    reg('project.close', t("Close Project"), t("File"), [], () => this.closeProject().then(() => this.updateWelcome()), { enabled: hasProject, menu: 'File' });
    if (bridge.isElectron) reg('project.reveal', t("Show Project Folder"), t("File"), [], () => this.revealProject(), { enabled: hasProject, menu: 'File' });
    reg('project.reviewCopies', t("Review Other Screenplay Copies…"), t("File"), [], () => this.reviewConflictCopies(), { enabled: () => !!this.project?.conflicts.length });

    reg('edit.undo', t("Undo"), t("Edit"), [], () => this.undoRedo('undo'), { inFields: true });
    reg('edit.redo', t("Redo"), t("Edit"), [], () => this.undoRedo('redo'), { inFields: true });
    reg('edit.selectAll', t("Select All"), t("Edit"), [], () => this.selectAll(), { inFields: true });
    reg('search.script', t("Find in Screenplay"), t("Search"), ['Mod+F'], () => this.findbar.open(), { inFields: true, enabled: () => hasProject() && !this.docs.isOpen, menu: 'Edit' });
    reg('search.replace', t("Find and Replace"), t("Search"), ['Mod+Alt+F'], () => this.findbar.open(true), { inFields: true, enabled: hasProject, menu: 'Edit' });
    reg('search.scenes', t("Search Scenes"), t("Search"), ['Mod+Shift+F'], () => this.outline.focusSearch(), { inFields: true, enabled: hasProject, menu: 'Edit' });
    reg('search.next', t("Find Next"), t("Search"), ['F3', 'Mod+G'], () => this.findbar.step(1), { enabled: () => this.findbar.hasQuery() });
    reg('search.prev', t("Find Previous"), t("Search"), ['Shift+F3', 'Mod+Shift+G'], () => this.findbar.step(-1), { enabled: () => this.findbar.hasQuery() });
    reg('character.rename', t("Rename Character…"), t("Edit"), ['Mod+R'], () => openRename(this), { inFields: true, enabled: hasProject, menu: 'Edit' });

    reg('view.toggleScriptScene', t("Switch Script / Scene"), t("View"), [], () => this.toggleScriptScene(), { enabled: hasProject, menu: 'View' });
    reg('view.script', t("Script View"), t("View"), ['Mod+1'], () => this.setView('script'), { enabled: hasProject, menu: 'View' });
    reg('view.scene', t("Scene View"), t("View"), ['Mod+2'], () => this.setView('scene'), { enabled: hasProject, menu: 'View' });
    reg('view.cards', t("Scene Cards"), t("View"), ['Mod+3', 'Mod+Shift+O'], () => (this.panel === 'cards' ? this.closePanel() : this.openPanel('cards')), { inFields: true, enabled: hasProject, menu: 'View' });
    reg('view.dialogue', t("Dialogue View"), t("View"), ['Mod+4'], () => this.setView('dialogue'), { enabled: hasProject, menu: 'View' });
    reg('view.characters', t("Characters"), t("View"), ['Mod+5'], () => (this.panel === 'characters' ? this.closePanel() : this.openPanel('characters')), { inFields: true, enabled: hasProject, menu: 'View' });
    reg('title.addFields', t("Add Missing Title Page Fields"), t("Edit"), [], () => this.addMissingTitleFields(), { enabled: hasProject, menu: 'Edit' });
    reg('view.titlePage', t("Title Page"), t("View"), ['Mod+T'], () => this.toggleTitlePage(), { inFields: true, enabled: hasProject, menu: 'View' });
    reg('view.source', t("Source View"), t("View"), ['Mod+6'], () => this.setView('source'), { enabled: hasProject, menu: 'View' });
    reg('view.minimal', t("Minimal View"), t("View"), ['Mod+M'], () => this.toggleMinimal(), { inFields: true, menu: 'View' });
    reg('view.fullScreen', t("Full Screen"), t("View"), [isMac ? 'Ctrl+Mod+F' : 'F11'], () => void bridge.window('fullscreen'), { inFields: true, enabled: () => bridge.isElectron, menu: 'View' });
    reg('view.toggleMaximize', t("Maximize / Restore Window"), t("View"), ['Mod+Ö'], () => bridge.window('toggleMaximize'), { inFields: true, menu: 'View' });
    reg('view.leftPane', t("Toggle Scene Pane"), t("View"), ['Mod+0'], () => this.togglePane('left'), { inFields: true, menu: 'View', enabled: () => this.panel !== 'export' });
    reg('view.rightPane', t("Toggle Notes Pane"), t("View"), ['Mod+Shift+0'], () => this.togglePane('right'), { inFields: true, menu: 'View', enabled: () => this.panel !== 'export' });
    reg('view.zoomIn', t("Larger Text"), t("View"), ['Mod+='], () => this.zoom(1), { inFields: true, menu: 'View' });
    reg('view.zoomOut', t("Smaller Text"), t("View"), ['Mod+-'], () => this.zoom(-1), { inFields: true, menu: 'View' });

    reg('scene.prev', t("Previous Scene"), t("Scenes"), ['Alt+ArrowLeft'], () => this.stepScene(-1), { enabled: hasProject, menu: 'Scene' });
    reg('scene.next', t("Next Scene"), t("Scenes"), ['Alt+ArrowRight'], () => this.stepScene(1), { enabled: hasProject, menu: 'Scene' });
    reg('scene.new', t("New Scene After Current"), t("Scenes"), ['Mod+N'], () => this.insertScene(), { inFields: true, enabled: hasProject, menu: 'Scene' });
    reg('scene.duplicate', t("Duplicate Scene"), t("Scenes"), [], () => {
      const a = this.activeScene();
      if (a) this.duplicateScene(a);
    }, { enabled: () => this.activeScene()?.kind === 'scene', menu: 'Scene' });
    reg('scene.archive', t("Move Scene to Archive"), t("Scenes"), [], () => {
      const a = this.activeScene();
      if (a) this.archiveScenes(this.sceneSel.has(a.id) ? this.scenesFor(a) : [a]);
    }, { enabled: () => this.activeScene()?.kind === 'scene', menu: 'Scene' });
    reg('scene.delete', t("Remove Scene…"), t("Scenes"), [], () => {
      const a = this.activeScene();
      if (a) this.deleteScene(a);
    }, { enabled: () => this.activeScene()?.kind === 'scene', menu: 'Scene' });
    reg('scene.moveUp', t("Move Scene Up"), t("Scenes"), ['Alt+Shift+ArrowUp'], () => {
      const a = this.activeScene();
      if (a) this.moveSceneBy(a, -1);
    }, { enabled: () => this.activeScene()?.kind === 'scene', menu: 'Scene' });
    reg('scene.moveDown', t("Move Scene Down"), t("Scenes"), ['Alt+Shift+ArrowDown'], () => {
      const a = this.activeScene();
      if (a) this.moveSceneBy(a, 1);
    }, { enabled: () => this.activeScene()?.kind === 'scene', menu: 'Scene' });
    reg('dialogue.goToPassage', t("Go to Passage in Script"), t("Scenes"), ['Mod+Enter'], () => this.goToPassage(), { enabled: () => !this.isFullView(), menu: 'Scene' });
    reg('edit.rewrite', t("Rewrite…"), t("Edit"), ['Alt+A'], () => openRewrite(this, this.ann), { enabled: hasProject, menu: 'Edit' });
    reg('edit.highlight', t("Highlight…"), t("Edit"), ['Mod+H'], () => this.highlightMenu(), { enabled: hasProject, menu: 'Edit' });
    reg('edit.comment', t("Comment…"), t("Edit"), ['Mod+Shift+M'], () => this.addComment(), { enabled: hasProject, menu: 'Edit' });
    reg('shelf.cut', t("Cut to Shelf"), t("Edit"), ['Mod+Shift+X'], () => toShelf(this, true), { enabled: hasProject, menu: 'Edit' });
    reg('shelf.copy', t("Copy to Shelf"), t("Edit"), ['Mod+Shift+C'], () => toShelf(this, false), { enabled: hasProject, menu: 'Edit' });
    reg('draft.save', t("Save Named Draft…"), t("File"), ['Mod+Shift+D'], () => saveDraft(this).then(() => undefined), { inFields: true, enabled: hasProject, menu: 'File' });
    reg('project.exportFountain', t("Export Fountain File…"), t("File"), ['Mod+Shift+E'], () => openFountainExport(this), { inFields: true, enabled: hasProject, menu: 'File' });
    reg('project.exportFdx', t("Export Final Draft File…"), t("File"), ['Mod+Alt+E'], () => void exportFinalDraft(this), { inFields: true, enabled: hasProject, menu: 'File' });
    reg('scene.lockNumbers', t("Lock Scene Numbers"), t("Scenes"), [], () => this.lockSceneNumbers(), { enabled: () => !!this.project && !this.numbersLocked && this.editor.parsed.scenes.length > 0, menu: 'Scene' });
    reg('scene.unlockNumbers', t("Unlock Scene Numbers…"), t("Scenes"), [], () => void this.unlockSceneNumbers(), { enabled: () => !!this.project && this.numbersLocked, menu: 'Scene' });
    reg('scene.writtenNumbers', t("Scene Numbers in Fountain Text…"), t("Scenes"), [], () => openSceneNumbers(this), { enabled: hasProject, menu: 'Scene' });
    reg('project.review', t("Review: Comments & Alternatives"), t("Scenes"), [], () => this.showRightTab('comments'), { enabled: hasProject, menu: 'Scene' });
    reg('project.shelf', t("Shelf"), t("Scenes"), [], () => this.showRightTab('shelf'), { enabled: hasProject, menu: 'Scene' });
    reg('scene.notes', t("Scene Notes"), t("Scenes"), [], () => this.showRightTab('scene'), { enabled: hasProject, menu: 'Scene' });
    reg('project.notes', t("Project Notes"), t("Scenes"), [], () => this.showRightTab('notes'), { enabled: hasProject, menu: 'Scene' });
    reg('project.history', t("History"), t("Scenes"), [], () => this.showRightTab('history'), { enabled: hasProject, menu: 'Scene' });
  }

  /** Acts, sequences, beats or the story model changed: redraw what shows them. */
  structureChanged() {
    this.cards.structureChanged();
  }

  undoRedo(which: 'undo' | 'redo') {
    const a = document.activeElement as HTMLElement | null;
    // Text fields undo their own typing; everywhere else (buttons, lists, panes) undo goes to
    // the screenplay history, which also holds comments, highlights, the shelf and scene details.
    const typing = !!a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button'].includes((a as HTMLInputElement).type)) || a.isContentEditable);
    const doc = this.docs?.hasFocus() ? this.docs.docEditor : null;
    if (doc) {
      if (which === 'undo') {
        doc.history.seal();
        doc.undo();
      } else doc.redo();
      return;
    }
    if (this.editor.hasFocus() || !typing) {
      if (which === 'undo') {
        this.editor.history.seal();
        this.editor.undo();
      } else this.editor.redo();
    } else document.execCommand(which);
  }

  private selectAll() {
    if (this.docs?.hasFocus()) {
      this.docs.docEditor!.selectAll();
      return;
    }
    const a = document.activeElement as HTMLElement | null;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && !this.editor.hasFocus()) (a as HTMLInputElement).select();
    else this.editor.selectAll();
  }

  highlight(color: HighlightColor | null, pos?: Pos | null) {
    const ann = this.ann;
    if (!ann.selectionAnchor()) {
      // Remove the highlight under the caret / pointer.
      const at = pos ?? ann.editor.sel.head;
      const hl = ann.at(at).find((r) => r.kind === 'highlight');
      if (color === null && hl) {
        const an = ann.live.get(hl.rec.id) ?? null;
        ann.removeRecord(hl.rec.id);
        toast(t("Highlight removed."), { actions: [{ label: t("Undo"), run: () => ann.restoreRecord('highlight', hl.rec, an) }] });
      } else toast(t("Select the text to highlight."));
      return;
    }
    ann.highlight(color);
  }

  /** Highlight colors at the caret (Mod+H). */
  /** Comments (visible ones) and alternative passages covering a position. */
  annotationsAt(pos: Pos, ann = this.ann) {
    const here = ann.at(pos);
    const comments = here.filter((r) => r.kind === 'comment' && (!(r.rec as CommentRecord).resolved || ann.showResolved)).map((r) => r.rec as CommentRecord);
    const passages = here.filter((r) => r.kind === 'passage').map((r) => r.rec as PassageRecord);
    return { comments, passages };
  }

  /** Cmd/Ctrl-click: opens the comment or the versions of the passage under the pointer. */
  openAnnotationAt(e: MouseEvent, pos: Pos): boolean {
    const ann = this.ann;
    const { comments, passages } = this.annotationsAt(pos, ann);
    const n = comments.length + passages.length;
    if (!n) return false;
    if (n === 1) {
      if (comments.length) openCommentDialog(this, ann, comments[0].id);
      else openRewriteFor(this, ann, passages[0].id);
      return true;
    }
    openMenu(
      [
        ...comments.map((c) => ({ label: t("Comment: “{0}{1}”", c.text.slice(0, 40), c.text.length > 40 ? '…' : ''), dot: 'var(--comment)', run: () => openCommentDialog(this, ann, c.id) })),
        ...passages.map((p) => ({ label: t("Versions: {0}", passageLabel(ann, p as PassageRecord, 30)), dot: 'var(--passage)', run: () => openRewriteFor(this, ann, p.id) })),
      ],
      { x: e.clientX, y: e.clientY },
    );
    return true;
  }

  private highlightMenu() {
    const ed = this.ann.editor;
    const c = ed.coordsAtPos(ed.sel.head);
    const at = c ? { x: c.left, y: c.bottom + 4 } : { x: 200, y: 200 };
    openMenu(
      [
        ...(['yellow', 'green', 'blue', 'pink'] as const).map((k) => ({ label: this.settings.highlights[k].label, dot: this.settings.highlights[k].color, run: () => this.highlight(k) })),
        { sep: true },
        { label: t("Remove highlight"), run: () => this.highlight(null) },
      ],
      at,
    );
  }

  async addComment() {
    const ann = this.ann;
    const ed = ann.editor;
    const an = ann.selectionAnchor();
    if (!an) {
      toast(t("Select the text to comment on."));
      return;
    }
    const ta = h('textarea', { class: 'field', rows: 4, placeholder: t("Comment"), 'aria-label': t("Comment") });
    openDialog({
      title: t("Comment"),
      body: [h('div', { class: 'notice' }, `“${ed.selectedText().slice(0, 120)}”`), ta],
      buttons: [
        { label: t("Cancel") },
        {
          label: t("Add comment"),
          primary: true,
          run: () => {
            if (!ta.value.trim()) return false;
            ann.addComment(ta.value.trim(), an);
            this.showRightTab('comments');
            ed.focus();
          },
        },
      ],
      initialFocus: ta,
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        // Handled here, so the native menu does not also run its Mod+Enter command.
        e.preventDefault();
        e.stopPropagation();
        (ta.closest('.dialog')?.querySelector('.btn.primary') as HTMLElement | null)?.click();
      }
    });
  }

  /** Shows an annotation's text in the editor (switching to Script view if it is hidden). */
  revealAnnotation(id: string, ann = this.ann) {
    if (!ann.reveal(id)) toast(t("This item is detached from the text."));
  }

  /** Selects a range in the editor, switching scene or view when the current view hides it. */
  revealRange(a: Pos, b: Pos, focus = true) {
    if (!this.editor.isVisibleLine(a.line)) {
      if (this.view === 'scene') {
        const item = this.sceneAt(a.line);
        if (item) this.enterScene(item, { caret: a });
      } else this.setView('script', { quiet: true });
    }
    this.editor.setSelection({ anchor: a, head: b }, { scroll: 'center' });
    if (focus) this.editor.focus();
  }

  showRightTab(tab: 'notes' | 'scene' | 'comments' | 'shelf' | 'history') {
    this.state.layout.rightVisible = true;
    this.state.layout.rightTab = tab;
    this.applyLayout();
    this.rightPane.focusTab();
    this.saveStateSoon();
  }

  private historyKey: string | null = null;

  /** Opens the History view on one version (e.g. 'draft:<id>', 'export:<id>', 'snap:<file>'). */
  openHistoryAt(key?: string) {
    if (this.panel === 'history') {
      if (key) this.historyHandle?.select(key);
      return;
    }
    this.historyKey = key ?? null;
    this.openPanel('history');
  }

  /** Hides both side panes (focus on the open tab), or shows them again when both are hidden. */
  hidePanes() {
    const l = this.state.layout;
    // Double-click again (panes already hidden): both panes come back.
    const show = !l.leftVisible && !l.rightVisible;
    l.leftVisible = show;
    l.rightVisible = show;
    this.applyLayout();
    this.saveStateSoon();
    if (!this.panel) this.editor.focus();
  }

  togglePane(side: 'left' | 'right') {
    const l = this.state.layout;
    if (side === 'left') l.leftVisible = !l.leftVisible;
    else l.rightVisible = !l.rightVisible;
    this.applyLayout();
    this.saveStateSoon();
    if (this.minimal) this.toggleMinimal();
  }


  toggleMinimal() {
    const offset = this.editor.measureCaretOffset();
    this.minimal = !this.minimal;
    document.body.classList.toggle('minimal', this.minimal);
    this.syncTitleBar();
    this.editor.restoreCaretOffset(offset);
    if (this.minimal) this.editor.focus();
  }

  /**
   * The window buttons sit on the app's top bar: match its colors. In minimal view they stay
   * (to maximise or go full screen) on a quiet strip in the writing area's colour.
   */
  syncTitleBar() {
    if (!bridge.isElectron) return;
    const cs = getComputedStyle(document.body);
    const color = cs.getPropertyValue(this.minimal ? '--bg' : '--panel').trim();
    const symbolColor = cs.getPropertyValue('--text-2').trim();
    bridge.window('titleBar', { color: toHex(color), symbolColor: toHex(symbolColor), buttons: true }).catch(() => {});
  }

  private zoom(dir: number) {
    const e = this.settings.editor;
    const size = Math.max(10, Math.min(32, e.fontSize + dir));
    const ratio = e.lineHeight / e.fontSize;
    e.fontSize = size;
    e.lineHeight = Math.round(size * ratio);
    this.applySettings();
  }

  /** The spell checker for other editors (documents). */
  spellHook(): ((w: string) => boolean) | undefined {
    return bridge.spell ? (w) => this.isMisspelled(w) : undefined;
  }

  /** A document opens: panels and the find bar belong to the screenplay and close. */
  leaveForDocument() {
    if (this.panel) this.closePanel(false);
    this.findbar.close(false);
  }

  /** Full-window views (Export, History) show the status line across the whole window. */
  private placeStatus() {
    const full = document.body.classList.contains('in-export');
    if (full && this.statusEl.parentElement !== this.root) this.root.append(this.statusEl);
    else if (!full && this.statusEl.parentElement !== this.centerCol) this.centerCol.append(this.statusEl);
  }

  async quit() {
    await this.flush();
    await bridge.window('quit');
  }

  async onRequestClose() {
    await this.flush();
    if (this.project) {
      try {
        await bridge.call('closeProject', this.project.rel);
      } catch {}
    }
    await bridge.window('closeReady');
  }

  /** Reads a screenplay PDF into a new project (see shared/pdfimport.ts). */
  private async importPdf(file: string): Promise<ProjectEntry | null> {
    const bytes: Uint8Array = await bridge.call('readBinaryFile', file);
    const pdfjs = await loadPdfjs();
    const r = pdfToFountain(await readPdfText(pdfjs, bytes));
    if (!r.stats.scenes && !r.stats.cues) {
      await alertDialog(t("Nothing to import"), t("No screenplay text was found in this PDF. It may be a scan (pictures of the pages), which cannot be read as text."));
      return null;
    }
    const name = (file.split(/[\\/]/).pop() ?? 'Screenplay').replace(/\.pdf$/i, '');
    const p = await bridge.call('createProject', name, r.text);
    toast(
      [
        tn(r.stats.pages, 'Read {0} page:', 'Read {0} pages:'),
        tn(r.stats.scenes, '{0} scene', '{0} scenes') + ',',
        tn(r.stats.cues, '{0} speech.', '{0} speeches.'),
        t('A PDF only keeps the page layout, so look the result over: bold, italics and underlining are not carried over.'),
      ].join(' '),
      { timeout: 14000 },
    );
    return p;
  }

  private async importFountain() {
    if (!this.state.workspace) {
      await this.chooseWorkspace();
      if (!this.state.workspace) return;
    }
    const file = await bridge.dialog('open', { title: t("Import a screenplay (Fountain, Final Draft or PDF)"), filters: [{ name: 'Screenplay', extensions: ['fountain', 'fdx', 'pdf', 'txt', 'spmd'] }] });
    if (!file) return;
    try {
      const p = /\.pdf$/i.test(file) ? await this.importPdf(file) : await bridge.call('importFountain', file);
      if (!p) return;
      await this.refreshProjects();
      await this.openProject(p.rel);
      const numbered = this.editor.parsed.scenes.filter((sc) => sc.sceneNumber).length;
      if (numbered) {
        const remove = await choiceDialog(
          t("Written scene numbers"),
          t("{0} of {1} scene headings in this file carry written numbers such as #4#. Scriptwright numbers scenes automatically while writing and in the PDF. Remove the written numbers? (Keep them only for locked production numbering.)", numbered, this.editor.parsed.scenes.length),
          [
            { label: t("Keep"), value: false },
            { label: t("Remove numbers"), value: true, primary: true },
          ],
        );
        if (!remove && numbered === this.editor.parsed.scenes.length) {
          // Every heading has its number: treat them as locked production numbers.
          this.project!.meta.numbersLocked = true;
          this.markMetaDirty();
          this.refreshDerived(true);
          this.outline.refresh();
        }
        if (remove) {
          const edits = sceneNumberEdits(this.editor.lineTexts, this.editor.parsed, 'remove');
          this.editor.edit((tx) => {
            for (const e of edits) tx.setLine(e.line, e.text);
            return this.editor.sel;
          });
          this.refreshDerived(true);
        }
      }
      toast(t("Imported into the new project \"{0}\". The original file was not changed.", p.name));
    } catch (e: any) {
      alertDialog(t("Import failed"), e.message);
    }
  }

  private async backupProject() {
    const p = this.project;
    if (!p) return;
    await this.flush();
    const date = new Date().toISOString().slice(0, 10);
    const dest = await bridge.dialog('save', { title: t("Back up project"), defaultPath: `${p.name} ${date}.scriptwright.zip`, filters: [{ name: 'Project backup', extensions: ['zip'] }] });
    if (!dest) return;
    try {
      const r = await bridge.call('backupProject', p.rel, dest);
      toast(t("Backup saved: {0} files including notes, scene information and history.", r.files));
    } catch (e: any) {
      alertDialog(t("Backup failed"), e.message);
    }
  }

  private async importBackup() {
    if (!this.state.workspace) {
      await this.chooseWorkspace();
      if (!this.state.workspace) return;
    }
    const file = await bridge.dialog('open', { title: t("Import project backup"), filters: [{ name: 'Project backup', extensions: ['zip'] }] });
    if (!file) return;
    try {
      const p = await bridge.call('importBackup', file);
      await this.refreshProjects();
      await this.openProject(p.rel);
      toast(t("Imported \"{0}\".", p.name));
    } catch (e: any) {
      alertDialog(t("Import failed"), e.message);
    }
  }

  async renameProject() {
    const p = this.project;
    if (!p) return;
    const name = await promptDialog(t("Rename project"), t("Name"), p.name, { okLabel: t("Rename") });
    if (!name || name === p.name) return;
    await this.flush();
    const rel = p.rel;
    await this.closeProject();
    try {
      const r = await bridge.call('renameProject', rel, name);
      await this.refreshProjects();
      await this.openProject(r.rel);
    } catch (e: any) {
      alertDialog(t("Rename failed"), e.message);
      await this.refreshProjects();
      await this.openProject(rel);
    }
  }

  private revealProject() {
    if (!this.project || !this.state.workspace) return;
    bridge.window('reveal', `${this.state.workspace}/${this.project.rel}/${this.project.file}`);
  }

  updateMenu() {
    if (!bridge.setMenu) return;
    // The application menus, grouped: a separator goes between groups. Commands not placed
    // here but marked for a menu are added at the end of it, so nothing goes missing.
    const layout: Array<[string, string[][]]> = [
      ['File', [
        ['project.new', 'workspace.create', 'project.openWorkspace'],
        ['file.save', 'draft.save'],
        ['file.export', 'project.exportFountain', 'project.exportFdx'],
        ['project.importFountain', 'project.importBackup', 'project.backup'],
        ['project.rename', 'project.reveal', 'project.close'],
        ['app.settings'],
        ['app.quit'],
      ]],
      ['Edit', [
        ['search.script', 'search.replace', 'search.scenes'],
        ['edit.comment', 'edit.highlight', 'edit.rewrite'],
        ['shelf.cut', 'shelf.copy'],
        ['character.rename', 'title.addFields'],
      ]],
      ['View', [
        ['view.script', 'view.scene', 'view.cards', 'view.dialogue', 'view.characters'],
        ['view.source', 'view.history', 'view.titlePage', 'view.toggleScriptScene'],
        ['project.notes', 'scene.notes', 'project.review', 'project.shelf'],
        ['view.leftPane', 'view.rightPane', 'view.minimal', 'view.fullScreen'],
        ['view.zoomIn', 'view.zoomOut'],
      ]],
      ['Scene', [
        ['scene.prev', 'scene.next', 'dialogue.goToPassage'],
        ['scene.new', 'scene.duplicate', 'scene.moveUp', 'scene.moveDown'],
        ['scene.archive', 'scene.delete'],
        ['scene.lockNumbers', 'scene.unlockNumbers', 'scene.writtenNumbers'],
      ]],
      ['Help', [['app.commands'], ['app.updates', 'app.about']]],
    ];
    // Shown elsewhere: the Window menu has Maximize; History has its tab in View.
    const skip = new Set(['view.toggleMaximize', 'project.history']);
    const all = this.commands.all();
    const item = (id: string) => {
      const c = all.find((x) => x.id === id);
      if (!c || !c.menu) return null;
      const k = this.commands.keysFor(c.id)[0];
      return { id: c.id, label: c.title, accelerator: k ? toAccelerator(k) : undefined };
    };
    const model = layout.map(([menu, groups]) => {
      const placed = new Set(groups.flat());
      const rest = all.filter((c) => c.menu === menu && !placed.has(c.id) && !skip.has(c.id)).map((c) => c.id);
      const items: Array<{ id?: string; label?: string; accelerator?: string; type?: 'separator' }> = [];
      for (const g of rest.length ? [...groups, rest] : groups) {
        const list = g.map(item).filter(Boolean) as Array<{ id: string; label: string; accelerator?: string }>;
        if (!list.length) continue;
        if (items.length) items.push({ type: 'separator' });
        items.push(...list);
      }
      return { key: menu, label: t(menu), items };
    });
    // Items the main process adds itself (app menu, standard Edit and Window entries).
    const labels: Record<string, string> = {
      about: t('About {app}'),
      updates: t('Check for Updates…'),
      settings: t('Settings…'),
      services: t('Services'),
      hide: t('Hide {app}'),
      hideOthers: t('Hide Others'),
      showAll: t('Show All'),
      quit: t('Quit {app}'),
      edit: t('Edit'),
      undo: t('Undo'),
      redo: t('Redo'),
      cut: t('Cut'),
      copy: t('Copy'),
      paste: t('Paste'),
      selectAll: t('Select All'),
      window: t('Window'),
      minimize: t('Minimize'),
      zoom: t('Zoom'),
      maximize: t('Maximize / Restore'),
      closeWindow: t('Close Window'),
      front: t('Bring All to Front'),
    };
    // Rebuilding the native menu is not free (macOS logs warnings): only when it changed.
    const sig = JSON.stringify(model);
    if (sig === this.menuSig) return;
    this.menuSig = sig;
    bridge.setMenu({ menus: model, labels }).catch(() => {});
  }
  private menuSig = '';

  // ---------------------------------------------------------------------------------
  // Global keyboard handling

  recording: ((e: KeyboardEvent) => void) | null = null;

  private bindGlobal() {
    window.addEventListener('keydown', (e) => this.onGlobalKey(e), true);
    bridge.on('external', (ev) => this.onExternal(ev));
    bridge.on('request-close', () => this.onRequestClose());
    // Menu items (and their shortcuts on macOS) do nothing while a dialog or the export is open,
    // except the editing keys that act on the dialog's own fields.
    bridge.on('command', (id: string) => {
      if (overlayOpen() && !['edit.undo', 'edit.redo', 'edit.selectAll', 'app.quit'].includes(id)) return;
      this.run(id);
    });
    window.addEventListener('beforeunload', () => {
      // Browser harness only: best effort.
      if (this.isDirty()) this.writeRecoveryNow();
    });
  }

  private onGlobalKey(e: KeyboardEvent) {
    if (this.recording) {
      this.recording(e);
      return;
    }
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') {
      // Fields that handle Escape themselves (search fields) get it first unless a modal is open.
      const ae = document.activeElement as HTMLElement | null;
      if (!overlayOpen() && ae?.dataset.esc === 'self') return;
      if (handleEscape()) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (this.minimal) {
        this.toggleMinimal();
        e.preventDefault();
        return;
      }
      const a = document.activeElement as HTMLElement | null;
      if (a && !this.editor.hasFocus() && !this.docs?.hasFocus() && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.classList.contains('list'))) {
        this.editor.focus();
        e.preventDefault();
      }
      return;
    }
    const combo = comboFromEvent(e);
    if (!combo) return;
    // Electron: edit keys go through the menu (so they work in every text field too).
    const editorFocused = this.editor.hasFocus();
    const active = document.activeElement as HTMLElement | null;
    const inField = !editorFocused && !!active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.isContentEditable);
    // Keyboard-navigable lists (outline, cards) keep their own arrow keys.
    if (!editorFocused && active?.getAttribute('role') === 'listbox' && isNavigationCombo(combo)) return;
    const inDialog = overlayOpen() || !!active?.closest('.dialog, .menu');
    // Undo and redo are handled here on every system (not left to the menu or the hidden
    // input's own undo, which on Windows swallowed Ctrl+Z most of the time). Other text fields
    // keep their native undo for their own typing.
    const isUndo = combo === 'Mod+Z';
    const isRedo = combo === 'Mod+Shift+Z' || (!isMac && combo === 'Mod+Y');
    if (isUndo || isRedo) {
      if (inField || (inDialog && !editorFocused)) return;
      e.preventDefault();
      e.stopPropagation();
      this.undoRedo(isUndo ? 'undo' : 'redo');
      return;
    }
    // The Export tab handles its own zoom keys (Mod+= / Mod+- / Mod+0).
    if (this.panel === 'export' && /^Mod\+(=|-|0)$/.test(combo)) return;
    const matches = this.commands.lookup(combo);
    if (!matches.length) return;
    // Writing a document: the view keys (Mod+1 Script, Mod+2 Scene …) lead back to the screenplay;
    // comments, highlights and rewrites work on the document.
    if (!inDialog && this.docs.hasFocus() && (matches[0].id.startsWith('view.') || ['edit.comment', 'edit.highlight', 'edit.rewrite'].includes(matches[0].id))) {
      e.preventDefault();
      e.stopPropagation();
      this.run(matches[0].id);
      return;
    }
    if (inDialog) {
      // Inside dialogs only a few global commands work; Tab keeps its normal meaning.
      return;
    }
    const cmd = matches[0];
    if (cmd.editorOnly && !editorFocused) return;
    if (inField) {
      if (!cmd.inFields) return;
      if (isNavigationCombo(combo) || !hasModifier(combo)) return;
      if (/^Mod\+(C|V|X|Z|Y|A)$/.test(combo) || combo === 'Mod+Shift+Z') return;
    }
    if (cmd.enabled && !cmd.enabled()) {
      if (combo === 'Tab') e.preventDefault();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    this.run(cmd.id);
  }
}

/** Reuses keys of old lines for identical new lines (in order) to keep scene identity across reloads. */
function matchKeys(old: Line[], next: Line[]): Line[] {
  const byText = new Map<string, Line[]>();
  for (const l of old) {
    const arr = byText.get(l.text) ?? [];
    arr.push(l);
    byText.set(l.text, arr);
  }
  const used = new Set<number>();
  return next.map((l) => {
    const cands = byText.get(l.text);
    if (cands) {
      while (cands.length) {
        const c = cands.shift()!;
        if (!used.has(c.key)) {
          used.add(c.key);
          return c;
        }
      }
    }
    return l;
  });
}

export { joinLines, Transaction };

