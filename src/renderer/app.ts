// Application shell: project lifecycle, saving, views, scene organization and commands.

import { bridge, isMac } from './bridge';
import { Editor, Transaction } from './editor/editor';
import { CommandRegistry, comboFromEvent, formatCombo, hasModifier, isNavigationCombo, toAccelerator } from './commands';
import { h, icon, iconButton, debounce, fmtNum, uid } from './ui/dom';
import { alertDialog, choiceDialog, confirmDialog, handleEscape, openDialog, openMenu, overlayOpen, promptDialog, toast, MenuItem } from './ui/overlay';
import { applyTheme } from './theme';
import { Line, Pos, Selection, cursor, joinLines, makeLines, selEmpty, selFrom, selTo, newKey } from '../shared/doc';
import { ParseResult, SceneInfo, characterLabel, characterList, cleanText, countWords, sceneIndexAt } from '../shared/fountain';
import { AppState, ProjectMeta, ProjectSession, SceneRecord, Settings, ViewName, defaultAppState, defaultSettings } from '../shared/types';
import { detach, fingerprint, hasInfo, reconcile } from '../shared/scenes';
import type { ProjectEntry, ExternalEvent } from '../main/backend';
import { OutlinePane } from './ui/outline';
import { ProjectsPane } from './ui/projects';
import { RightPane } from './ui/rightpane';
import { FindBar } from './ui/findbar';
import { openPalette } from './ui/palette';
import { openSettings } from './ui/settings';
import { openExport } from './ui/export';
import { openRename } from './ui/rename';
import { compareDialog } from './ui/compare';

export interface SceneItem {
  kind: 'scene' | 'title' | 'opening';
  id: string;
  key: number;
  line: number;
  end: number;
  heading: string;
  order: number;
  sceneNumber?: string;
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
  private tabs!: Record<ViewName, HTMLButtonElement>;
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
  private leftToggle!: HTMLButtonElement;
  private rightToggle!: HTMLButtonElement;

  async start() {
    this.settings = await bridge.call('loadSettings');
    this.state = await bridge.call('loadState');
    this.commands.overrides = { ...this.settings.keymap };
    this.commands.onChange = () => {
      this.settings.keymap = { ...this.commands.overrides };
      this.saveSettings();
      this.updateMenu();
    };
    applyTheme(this.settings.appearance);
    this.buildDom();
    this.registerCommands();
    this.bindGlobal();
    this.applyLayout();
    this.updateMenu();
    this.setupSpell();
    if (this.state.workspace) {
      const r = await bridge.call('setWorkspace', this.state.workspace);
      if (r.ok) {
        await this.refreshProjects();
        const last = this.state.lastProject;
        if (last && this.projects.some((p) => p.rel === last && !p.loose)) await this.openProject(last);
      } else {
        toast(`The workspace folder ${this.state.workspace} is not available.`, { warn: true });
        this.state.workspace = undefined;
      }
    }
    this.updateWelcome();
    this.updateChrome();
    this.ready = true;
  }

  // ---------------------------------------------------------------------------------
  // DOM

  private buildDom() {
    this.titleEl = h('span', { class: 'doc-title' }, 'Scriptwright');
    this.subEl = h('span', { class: 'doc-sub' });
    this.leftToggle = iconButton('sidebarLeft', 'Toggle scene pane', () => this.run('view.leftPane'));
    this.rightToggle = iconButton('sidebarRight', 'Toggle notes pane', () => this.run('view.rightPane'));
    const titlebar = h(
      'div',
      { class: 'titlebar' },
      this.leftToggle,
      this.titleEl,
      this.subEl,
      h('span', { class: 'spacer' }),
      iconButton('search', 'Search in screenplay', () => this.run('search.script')),
      iconButton('export', 'Export PDF', () => this.run('file.export')),
      iconButton('command', 'Commands & shortcuts', () => this.run('app.commands')),
      iconButton('settings', 'Settings', () => this.run('app.settings')),
      this.rightToggle,
    );
    const mkTab = (v: ViewName, label: string) => {
      const b = h('button', { class: 'tab', tabindex: '-1', onclick: () => this.setView(v) }, label);
      return b;
    };
    this.tabs = { script: mkTab('script', 'Script'), scene: mkTab('scene', 'Scene'), dialogue: mkTab('dialogue', 'Dialogue') };
    this.viewControls = h('div', { class: 'view-controls' });
    const viewbar = h('div', { class: 'viewbar' }, h('div', { class: 'tabs' }, this.tabs.script, this.tabs.scene, this.tabs.dialogue), this.viewControls);

    this.leftPane = h('div', { class: 'pane pane-left' });
    this.rightPaneEl = h('div', { class: 'pane pane-right' });
    this.center = h('div', { class: 'center' });
    this.leftResizer = h('div', { class: 'resizer', title: 'Drag to resize' });
    this.rightResizer = h('div', { class: 'resizer', title: 'Drag to resize' });
    const main = h('div', { class: 'main' }, this.leftPane, this.leftResizer, this.center, this.rightResizer, this.rightPaneEl);

    this.statusSave = h('button', { class: 'save-state', tabindex: '-1', onclick: () => this.onSaveStateClick() });
    this.statusCount = h('span', { class: 'count' });
    this.statusScene = h('span');
    this.statusView = h('span');
    const status = h('div', { class: 'statusbar' }, this.statusSave, this.statusCount, h('span', { class: 'spacer' }), this.statusView, this.statusScene);

    this.root = h('div', { id: 'app' }, titlebar, viewbar, main, status);
    document.body.append(this.root);

    this.editor = new Editor(this.center, this.settings.editor);
    this.editor.editKeysFromMenu = bridge.isElectron;
    this.editor.hooks = {
      onChange: (origin, steps) => this.onEditorChange(origin),
      onSelection: () => this.onSelectionChange(),
      onScroll: () => this.onScroll(),
      onContextMenu: (e, pos) => this.editorContextMenu(e, pos),
      gapLabel: (a, b) => this.dialogueGapLabel(a, b),
      isMisspelled: bridge.spell ? (w) => this.isMisspelled(w) : undefined,
    };

    this.projectsPane = new ProjectsPane(this);
    this.outline = new OutlinePane(this);
    this.leftPane.append(this.projectsPane.el, this.outline.el);
    this.rightPane = new RightPane(this);
    this.rightPaneEl.append(this.rightPane.el);
    this.findbar = new FindBar(this);
    this.center.append(this.findbar.el);

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
        const w = Math.max(180, Math.min(560, side === 'left' ? start + dx : start - dx));
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
    this.leftPane.style.width = `${l.leftWidth}px`;
    this.rightPaneEl.style.width = `${l.rightWidth}px`;
    this.leftPane.classList.toggle('hidden', !l.leftVisible);
    this.leftResizer.classList.toggle('hidden', !l.leftVisible);
    this.rightPaneEl.classList.toggle('hidden', !l.rightVisible);
    this.rightResizer.classList.toggle('hidden', !l.rightVisible);
    this.leftToggle.classList.toggle('on', l.leftVisible);
    this.rightToggle.classList.toggle('on', l.rightVisible);
    this.projectsPane.setCollapsed(l.projectsCollapsed);
    this.rightPane.setTab(l.rightTab);
    // Keep the caret line steady when the writing column re-centers.
    this.editor.restoreCaretOffset(caretOffset);
  }

  // ---------------------------------------------------------------------------------
  // Settings & state persistence

  saveSettings = debounce(() => {
    bridge.call('saveSettings', this.settings).catch((e) => toast(`Settings could not be saved: ${e.message}`, { warn: true }));
  }, 300);

  saveStateSoon = debounce(() => this.saveStateNow(), 800);

  saveStateNow() {
    this.captureSession();
    return bridge.call('saveState', this.state).catch(() => {});
  }

  applySettings() {
    applyTheme(this.settings.appearance);
    const offset = this.editor.measureCaretOffset();
    this.editor.applySettings(this.settings.editor);
    this.editor.restoreCaretOffset(offset);
    this.setupSpell();
    this.refreshDerived(true);
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
    const dir = await bridge.dialog('folder', { title: 'Choose a workspace folder' });
    if (!dir) return;
    await this.setWorkspace(dir);
  }

  async setWorkspace(dir: string) {
    const r = await bridge.call('setWorkspace', dir);
    if (!r.ok) {
      await alertDialog('Workspace unavailable', r.message ?? 'The folder cannot be used.');
      return;
    }
    await this.closeProject();
    this.state.workspace = dir;
    this.state.recentWorkspaces = [dir, ...this.state.recentWorkspaces.filter((d) => d !== dir)].slice(0, 8);
    this.state.lastProject = undefined;
    await this.refreshProjects();
    this.saveStateSoon();
    this.updateWelcome();
    this.updateChrome();
  }

  async refreshProjects() {
    if (!this.state.workspace) {
      this.projects = [];
    } else {
      try {
        this.projects = await bridge.call('listProjects');
      } catch (e: any) {
        this.projects = [];
        toast(`The workspace could not be read: ${e.message}`, { warn: true });
      }
    }
    this.projectsPane.render();
  }

  async newProject() {
    if (!this.state.workspace) {
      await this.chooseWorkspace();
      if (!this.state.workspace) return;
    }
    const name = await promptDialog('New project', 'Name', '', { okLabel: 'Create' });
    if (!name) return;
    const text = `Title: ${name}\nCredit: Written by\nAuthor: \nDraft date: ${new Date().toLocaleDateString()}\n\n${this.settings.editor.defaultHeading}\n\n`;
    try {
      const p = await bridge.call('createProject', name, text);
      await this.refreshProjects();
      await this.openProject(p.rel);
    } catch (e: any) {
      alertDialog('Project not created', e.message);
    }
  }

  async openProject(rel: string, opts: { keepView?: boolean } = {}) {
    if (this.project?.rel === rel) return;
    await this.closeProject();
    const entry = this.projects.find((p) => p.rel === rel);
    if (entry?.loose) {
      const ok = await confirmDialog(
        'Open loose file',
        `"${entry.file}" is not inside a project folder yet. Scriptwright will move it into its own folder "${entry.name}" so notes and history can be kept beside it.`,
        'Move into project folder',
      );
      if (!ok) return;
      try {
        const adopted = await bridge.call('adoptLooseFile', rel);
        await this.refreshProjects();
        rel = adopted.rel;
      } catch (e: any) {
        alertDialog('Could not move the file', e.message);
        return;
      }
    }
    let r;
    try {
      r = await bridge.call('openProject', rel);
    } catch (e: any) {
      await alertDialog('Project could not be opened', e.message);
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
    this.dialogueCharacter = session?.dialogueCharacter ?? '';
    this.dialogueScope = session?.dialogueScope ?? 'all';
    this.dialogueAction = session?.dialogueAction ?? false;
    this.editor.setSource(!!session?.source);
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
      this.showBanner(`This project also appears to be open on ${r.otherInstance.host}. Changes are checked before saving, so nothing will be overwritten silently.`, [{ label: 'OK', run: () => this.hideBanner() }]);
    }
    if (p.conflicts.length) this.showConflictCopiesBanner();
    // Not awaited: the recovery question must not block startup.
    if (r.recovery) this.offerRecovery(r.recovery);
    this.saveStateSoon();
  }

  private async offerRecovery(rec: { text: string; savedAt: string }) {
    const when = new Date(rec.savedAt).toLocaleString();
    const choice = await choiceDialog(
      'Unsaved work found',
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('p', null, `Scriptwright kept a recovery copy from ${when} that differs from the saved screenplay. This usually means the app closed before it could save.`),
        h('p', null, 'Restoring replaces the editor text with the recovered version (you can undo). The current file is kept in history either way.'),
      ),
      [
        { label: 'Compare…', value: 'compare' as const },
        { label: 'Discard recovery', value: 'discard' as const, danger: true },
        { label: 'Restore', value: 'restore' as const, primary: true },
      ],
    );
    const p = this.project!;
    if (choice === 'compare') {
      const use = await compareDialog('Recovered vs saved', this.editor.getText(), rec.text, 'Saved file', 'Recovered', 'Use recovered');
      if (use) await this.replaceAllText(rec.text, 'Recovered work restored');
      else await this.offerRecovery(rec);
      return;
    }
    if (choice === 'restore') {
      await bridge.call('snapshotProject', p.rel, this.editor.getText(), 'before recovery');
      await this.replaceAllText(rec.text, 'Recovered work restored');
    } else if (choice === 'discard') {
      await bridge.call('saveConflictCopy', p.rel, rec.text, 'discarded recovery');
      await bridge.call('clearRecovery', p.meta.id);
      toast('Recovery copy discarded (a copy was kept in the project’s conflicts folder).');
    }
  }

  async closeProject() {
    const p = this.project;
    if (!p) return;
    await this.flush();
    this.captureSession();
    try {
      await bridge.call('closeProject', p.rel);
    } catch {}
    this.project = null;
    this.focus = null;
    this.findbar.close(false);
    this.hideBanner();
    this.editor.setFilter(null, null);
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
      scrollLine: this.view === 'script' ? this.editor.topVisibleLine() : this.state.sessions[p.meta.id]?.scrollLine ?? 0,
      focusedSceneId: this.focus?.kind === 'scene' ? p.sceneIds.get(this.focus.key) : undefined,
      titleFocused: this.focus?.kind === 'title',
      dialogueCharacter: this.dialogueCharacter,
      dialogueScope: this.dialogueScope,
      dialogueAction: this.dialogueAction,
      source: this.editor.source,
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
      saved: 'Saved',
      unsaved: 'Unsaved changes',
      saving: 'Saving…',
      error: 'Not saved — retrying',
      conflict: 'Changed outside Scriptwright — review',
      missing: 'File missing',
    };
    this.statusSave.textContent = label[s];
    this.statusSave.className = `save-state ${s === 'error' || s === 'conflict' || s === 'missing' ? 'error' : s === 'unsaved' || s === 'saving' ? 'unsaved' : ''}`;
    this.statusSave.title = err || (s === 'saved' ? 'All changes are saved to disk' : '');
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
    if (this.saveState === 'error') alertDialog('Saving failed', `${this.saveError}\n\nYour work is kept in a recovery copy and Scriptwright keeps retrying.`);
    else if (this.saveState === 'conflict' && this.project?.pendingExternal !== null) this.reviewConflict();
    else if (this.saveState === 'missing') this.showMissingBanner();
    else if (this.saveState === 'unsaved') this.save();
  }

  markMetaDirty() {
    if (!this.project) return;
    this.project.metaDirty = true;
    this.saveMetaSoon();
  }

  private saveMetaSoon = debounce(() => this.saveMetaNow(), 1000);

  async saveMetaNow() {
    const p = this.project;
    if (!p || !p.metaDirty) return;
    this.syncSceneRecords();
    p.metaDirty = false;
    const r = await bridge.call('saveMeta', p.rel, p.meta);
    if (!r.ok) {
      p.metaDirty = true;
      toast(`Project information could not be saved: ${r.message}`, { warn: true });
    } else if (r.preservedExternal) {
      toast(`Project information was also changed elsewhere; that version was kept as ${r.preservedExternal}.`, { warn: true, timeout: 10000 });
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
        toast('Reloaded changes made outside Scriptwright.', { actions: [{ label: 'Undo', run: () => this.editor.undo() }] });
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
    this.showBanner('The screenplay was changed outside Scriptwright while you had unsaved changes. Both versions are kept until you decide.', [
      { label: 'Review…', run: () => this.reviewConflict() },
    ]);
  }

  async reviewConflict() {
    const p = this.project;
    if (!p || p.pendingExternal === null) return;
    const diskText = p.pendingExternal;
    const diskHash = (p as any).pendingExternalHash as string;
    const choice = await choiceDialog(
      'Resolve conflicting changes',
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('p', null, 'The file on disk no longer matches the version you started editing. Whichever version you choose, the other one is saved in the project’s conflicts folder.'),
      ),
      [
        { label: 'Compare…', value: 'compare' as const },
        { label: 'Use the other version', value: 'theirs' as const },
        { label: 'Keep my version', value: 'mine' as const, primary: true },
      ],
    );
    if (!choice) return;
    if (choice === 'compare') {
      const useTheirs = await compareDialog('My version vs file on disk', this.editor.getText(), diskText, 'My version', 'File on disk', 'Use file on disk');
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
      toast(`Kept your version. The other version was saved as ${saved}.`, { timeout: 8000 });
    } else {
      const saved = await bridge.call('saveConflictCopy', p.rel, this.editor.getText(), 'my version');
      await this.replaceAllText(diskText, null, 'external');
      p.baseHash = diskHash;
      p.savedVersion = this.editor.version;
      p.pendingExternal = null;
      await bridge.call('acknowledge', p.rel, diskHash);
      this.hideBanner();
      this.setSaveState('saved');
      toast(`Loaded the other version. Your version was saved as ${saved}.`, { timeout: 8000, actions: [{ label: 'Undo', run: () => this.editor.undo() }] });
    }
  }

  private showMissingBanner() {
    this.showBanner('The screenplay file was moved, renamed or deleted outside Scriptwright. Your text is still here and in a recovery copy.', [
      {
        label: 'Save here again',
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
          } else alertDialog('Could not save', (r as any).message ?? 'The folder is not available.');
        },
      },
      { label: 'Close project', run: () => this.closeProject() },
    ]);
  }

  private showConflictCopiesBanner() {
    const p = this.project!;
    const n = p.conflicts.length;
    this.showBanner(`${n} other screenplay ${n === 1 ? 'copy' : 'copies'} found in this project folder (for example a sync conflict copy).`, [
      { label: 'Review…', run: () => this.reviewConflictCopies() },
      { label: 'Later', run: () => this.hideBanner() },
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
        'Other screenplay copy',
        h('div', null, h('p', null, `"${name}"`), h('p', null, 'Compare it with the current screenplay, use it, or archive it into the project’s conflicts folder.')),
        [
          { label: 'Skip', value: 'skip' as const },
          { label: 'Archive', value: 'archive' as const },
          { label: 'Compare…', value: 'compare' as const, primary: true },
        ],
      );
      if (choice === 'archive') {
        await bridge.call('archiveProjectFile', p.rel, name);
      } else if (choice === 'compare') {
        const use = await compareDialog('Current screenplay vs copy', this.editor.getText(), text, 'Current', name, 'Use this copy');
        if (use) {
          await bridge.call('snapshotProject', p.rel, this.editor.getText(), 'before using copy');
          await this.replaceAllText(text, `Using "${name}"`);
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
  async replaceAllText(text: string, message: string | null, origin: 'command' | 'external' = 'command') {
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
      this.assignSceneIdsFromRecords(true);
    } finally {
      this.suspendScenes = false;
    }
    this.refreshDerived(true);
    if (message) toast(message, { actions: [{ label: 'Undo', run: () => this.editor.undo() }] });
  }

  // ---------------------------------------------------------------------------------
  // Editor events

  private derivedTimer: any = null;

  /** While true, scene identity is being re-established and derived state waits. */
  private suspendScenes = false;

  private onEditorChange(origin: string) {
    if (!this.project) return;
    if (origin === 'load') return; // openProject assigns scene identity first
    if (origin !== 'load') {
      if (this.isDirty()) {
        if (this.saveState !== 'conflict' && this.saveState !== 'missing') this.setSaveState('unsaved');
        this.scheduleSave();
      } else if (this.saveState === 'unsaved') this.setSaveState('saved');
    }
    if (this.suspendScenes) return;
    this.refreshDerived(false);
  }

  /** Updates scenes, outline and counts after a change. */
  refreshDerived(force: boolean) {
    this.updateScenes();
    this.outline.render();
    if (this.view === 'dialogue' && force) this.applyDialogueFilter(false);
    this.updateViewControls();
    clearTimeout(this.derivedTimer);
    this.derivedTimer = setTimeout(() => this.updateCounts(), force ? 0 : 250);
    this.findbar.onDocChange();
  }

  private onSelectionChange() {
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

  private onScroll() {
    if (this.view === 'script') this.saveStateSoon();
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
      for (const r of res.unmatched) if (hasInfo(r)) this.addDetached(r, res.ambiguous.includes(r) ? 'Matches more than one scene after an external change' : 'Scene not found after an external change');
    } else {
      p.sceneIds.clear();
      const res = reconcile(p.meta.scenes, sigs);
      scenes.forEach((s, i) => p.sceneIds.set(this.editor.lines[s.line].key, res.ids[i] ?? uid()));
      for (const r of res.unmatched) if (hasInfo(r)) this.addDetached(r, res.ambiguous.includes(r) ? 'Matches more than one scene' : 'Scene not found in the screenplay');
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
    if (parsed.titleEnd > 0) items.push({ kind: 'title', id: 'title', key: lines[0].key, line: 0, end: parsed.titleEnd, heading: 'Title page', order: 0 });
    const firstScene = parsed.scenes[0];
    const openingEnd = firstScene ? firstScene.line : lines.length;
    let openingHas = false;
    for (let i = parsed.bodyStart; i < openingEnd; i++) if (lines[i].text.trim()) openingHas = true;
    if (openingHas) items.push({ kind: 'opening', id: 'opening', key: lines[parsed.bodyStart].key, line: parsed.bodyStart, end: openingEnd, heading: 'Opening', order: 0 });
    if (p) {
      let changed = false;
      for (const s of parsed.scenes) {
        const key = lines[s.line].key;
        let id = p.sceneIds.get(key);
        if (!id) {
          id = uid();
          p.sceneIds.set(key, id);
          changed = true;
        }
        const record = p.meta.scenes.find((r) => r.id === id) ?? p.meta.detached.find((r) => r.id === id);
        items.push({ kind: 'scene', id, key, line: s.line, end: s.end, heading: s.heading, order: s.order, sceneNumber: s.sceneNumber, record });
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
          if (hasInfo(r)) p.meta.detached.push(detach(r, 'The scene heading was removed or changed into other text'));
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
      const prev = byId.get(s.id);
      out.push({
        ...(prev ?? {}),
        id: s.id,
        heading: s.heading,
        fingerprint: fingerprint(lines.slice(s.line + 1, s.end)),
        order: s.order,
      });
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
    return r;
  }

  updateSceneRecord(item: SceneItem, patch: Partial<SceneRecord>) {
    const r = this.sceneRecord(item);
    if (!r) return;
    Object.assign(r, patch);
    this.markMetaDirty();
    this.updateScenes();
    this.outline.render();
  }

  /** Scene item containing a document line (title page and opening included). */
  sceneAt(line: number): SceneItem | undefined {
    let best: SceneItem | undefined;
    for (const s of this.scenes) if (line >= s.line && line < Math.max(s.end, s.line + 1)) best = s;
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

  setView(v: ViewName, opts: { quiet?: boolean } = {}) {
    if (!this.project) {
      this.view = v;
      this.updateChrome();
      return;
    }
    if (v === 'scene') {
      const item = this.view === 'script' ? this.readingScene() : this.activeScene() ?? this.readingScene();
      if (item) this.enterScene(item);
      else {
        this.view = 'scene';
        this.focus = null;
        this.editor.setFilter(new Set(), 'scene');
      }
    } else if (v === 'script') {
      const from = this.view;
      const item = this.activeScene();
      this.view = 'script';
      this.focus = null;
      this.editor.setFilter(null, null);
      if (from !== 'script' && item && !opts.quiet) {
        // Follow the scene that was being edited: heading near the top, one line above.
        this.editor.scrollToLine(item.line, 'top', 1);
      }
    } else {
      this.view = 'dialogue';
      this.focus = null;
      this.dialogueSceneKey = this.activeScene()?.key ?? null;
      this.applyDialogueFilter(true);
    }
    this.updateChrome();
    this.outline.updateActive();
    if (!opts.quiet) this.editor.focus();
    this.saveStateSoon();
  }

  /** Focuses one scene in Scene view, keeping per-scene caret and scroll context. */
  enterScene(item: SceneItem, opts: { restoreContext?: boolean; caret?: Pos } = {}) {
    const p = this.project;
    if (!p) return;
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
    if (ctx && opts.restoreContext !== false && !opts.caret) this.editor.scrollTop = ctx.scrollTop;
    else {
      this.editor.scrollTop = 0;
      this.editor.scrollToCaret('nearest');
    }
    this.updateChrome();
    this.outline.updateActive();
    this.rightPane.onActiveSceneChange();
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
    if (this.view === 'script') this.setView('scene');
    else this.setView('script');
  }

  /** Navigates to a scene: Script view scrolls, Scene view focuses it. */
  goToScene(item: SceneItem, opts: { focusEditor?: boolean } = {}) {
    if (!this.project) return;
    if (this.view === 'scene') {
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
      const tpl = `Title: ${this.project.name}\nCredit: Written by\nAuthor: \nDraft date: ${new Date().toLocaleDateString()}\n`;
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

  // ---------------------------------------------------------------------------------
  // Dialogue view

  applyDialogueFilter(resetCaret: boolean) {
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
      } else this.editor.scrollToCaret('center');
    }
    this.updateViewControls();
  }

  private dialogueGapLabel(a: number, b: number): string | null {
    const parsed = this.editor.parsed;
    let action = false;
    let other = false;
    for (let i = a + 1; i < b; i++) {
      const t = parsed.lines[i].type;
      if (t === 'action' || t === 'transition' || t === 'centered' || t === 'lyric') action = true;
      else if (t === 'character' || t === 'dialogue' || t === 'parenthetical') other = true;
    }
    if (action && !this.dialogueAction) return 'action hidden';
    if (action) return 'more action hidden';
    if (other) return 'other dialogue hidden';
    return null;
  }

  goToPassage() {
    if (this.view === 'script') return;
    const caret = this.editor.sel.head;
    this.view = 'script';
    this.focus = null;
    this.editor.setFilter(null, null);
    this.editor.setSelection(cursor(caret), { scroll: false });
    this.editor.scrollToCaret('center');
    this.updateChrome();
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
    const ok = await confirmDialog('Remove scene', `Remove "${item.heading}" and its text? You can undo this.`, 'Remove', { danger: true });
    if (!ok) return;
    const wasFocused = this.view === 'scene' && this.focus?.kind === 'scene' && this.focus.key === item.key;
    const list = this.navigableScenes();
    const idx = list.findIndex((s) => s.id === item.id);
    this.editor.edit((tx) => {
      const start = tx.lines.findIndex((l) => l.key === item.key);
      tx.removeLines(start, item.end - item.line);
      if (tx.lines.length === 0) tx.insertLines(0, [{ key: newKey(), text: '' }]);
      const line = Math.min(start, tx.lines.length - 1);
      return cursor({ line, ch: 0 });
    });
    this.refreshDerived(true);
    if (wasFocused) {
      const next = this.navigableScenes()[Math.min(idx, this.navigableScenes().length - 1)];
      if (next) this.enterScene(next);
    }
    toast('Scene removed.', { actions: [{ label: 'Undo', run: () => this.run('edit.undo') }] });
  }

  // ---------------------------------------------------------------------------------
  // Chrome updates

  updateChrome() {
    const p = this.project;
    this.titleEl.textContent = p ? p.name : 'Scriptwright';
    this.subEl.textContent = p ? p.file : '';
    bridge.window('setTitle', p ? `${p.name} — Scriptwright` : 'Scriptwright');
    for (const [v, b] of Object.entries(this.tabs)) {
      b.classList.toggle('on', v === this.view);
      b.disabled = !p;
    }
    this.updateViewControls();
    this.updateStatusScene();
    this.updateCounts();
  }

  updateViewControls() {
    const c = this.viewControls;
    c.textContent = '';
    if (!this.project) return;
    if (this.view === 'scene') {
      c.append(iconButton('left', `Previous scene (${this.commands.label('scene.prev')})`, () => this.stepScene(-1)), iconButton('right', `Next scene (${this.commands.label('scene.next')})`, () => this.stepScene(1)));
    } else if (this.view === 'dialogue') {
      const chars = characterList(this.editor.parsed);
      const sel = h('select', { class: 'field', 'aria-label': 'Character', title: 'Character' }, h('option', { value: '' }, 'All characters'));
      for (const ch of chars) sel.append(h('option', { value: ch.name }, characterLabel(ch)));
      if (this.dialogueCharacter && !chars.some((c2) => c2.name === this.dialogueCharacter)) sel.append(h('option', { value: this.dialogueCharacter }, `${this.dialogueCharacter} (0 cues)`));
      sel.value = this.dialogueCharacter;
      sel.addEventListener('change', () => {
        this.dialogueCharacter = sel.value;
        this.applyDialogueFilter(true);
        this.editor.focus();
        this.saveStateSoon();
      });
      const scope = h('select', { class: 'field', 'aria-label': 'Scope' }, h('option', { value: 'all' }, 'Whole screenplay'), h('option', { value: 'scene' }, 'Current scene'));
      scope.value = this.dialogueScope;
      scope.addEventListener('change', () => {
        this.dialogueScope = scope.value as any;
        this.dialogueSceneKey = this.activeScene()?.key ?? this.dialogueSceneKey;
        this.applyDialogueFilter(true);
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
      c.append(sel, scope, h('label', null, action, 'Nearby action'));
      if (!this.dialogueAction) c.append(h('span', { class: 'view-note', title: 'Action lines are not shown in this view' }, 'Action hidden'));
      c.append(h('button', { class: 'btn', style: { height: '22px' }, title: this.commands.label('dialogue.goToPassage'), onclick: () => this.goToPassage() }, 'Go to passage'));
    }
    if (this.editor.source) c.append(h('span', { class: 'view-note', style: { color: 'var(--text-2)' } }, 'Fountain source'));
  }

  private updateStatusScene() {
    const p = this.project;
    if (!p) {
      this.statusScene.textContent = '';
      this.statusView.textContent = '';
      return;
    }
    const list = this.scenes.filter((s) => s.kind === 'scene');
    const a = this.activeScene();
    if (a?.kind === 'scene') this.statusScene.textContent = `Scene ${a.order} of ${list.length}`;
    else if (a?.kind === 'title') this.statusScene.textContent = `Title page · ${list.length} scenes`;
    else this.statusScene.textContent = `${list.length} scenes`;
    this.statusView.textContent = this.editor.source ? 'Source' : '';
  }

  updateCounts() {
    if (!this.project) {
      this.statusCount.textContent = '';
      return;
    }
    const parsed = this.editor.parsed;
    const L = this.editor.lines;
    let from = parsed.bodyStart;
    let to = L.length;
    let label = 'Screenplay';
    let fromCh = -1;
    let toCh = -1;
    const sel = this.editor.sel;
    if (!selEmpty(sel)) {
      const a = selFrom(sel);
      const b = selTo(sel);
      from = a.line;
      to = b.line + 1;
      fromCh = a.ch;
      toCh = b.ch;
      label = 'Selection';
    } else if (this.view === 'scene') {
      const it = this.focusedItem();
      if (it) {
        from = it.line;
        to = it.end;
        label = it.kind === 'scene' ? `Scene ${it.order}` : it.heading;
      }
    } else if (this.view === 'dialogue') {
      label = 'Dialogue view';
    }
    let words = 0;
    let chars = 0;
    const filter = this.view === 'dialogue' ? this.editor.filterKeys : null;
    for (let i = from; i < to; i++) {
      if (filter && !filter.has(L[i].key)) continue;
      let text = L[i].text;
      const pl = parsed.lines[i];
      if (label === 'Selection') {
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
    this.statusCount.textContent = `${label} · ${fmtNum(words)} words · ${fmtNum(chars)} characters`;
    this.statusCount.title = label === 'Selection' ? 'Counts for the selected text' : 'Counts exclude notes, omitted text, sections and synopses';
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
        h('h1', null, 'Choose a workspace'),
        h('p', null, 'A workspace is a folder that holds your screenplay projects. It can be inside a synced folder.'),
        h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => this.chooseWorkspace() }, 'Choose folder…')),
      );
      if (this.state.recentWorkspaces.length) {
        const rec = h('div', { class: 'recent' }, h('div', { class: 'section-head', style: { padding: '0' } }, 'Recent'));
        for (const d of this.state.recentWorkspaces) rec.append(h('button', { class: 'row', onclick: () => this.setWorkspace(d) }, h('span', { class: 'label' }, d)));
        box.append(rec);
      }
    } else {
      box.append(
        h('h1', null, this.projects.length ? 'Open a project' : 'No projects yet'),
        h('p', null, this.projects.length ? 'Choose a project in the left pane, or create a new one.' : 'Create a project to start writing.'),
        h(
          'div',
          { class: 'actions' },
          h('button', { class: 'btn primary', onclick: () => this.newProject() }, 'New project…'),
          h('button', { class: 'btn', onclick: () => this.run('project.importFountain') }, 'Import Fountain…'),
          h('button', { class: 'btn', onclick: () => this.chooseWorkspace() }, 'Change workspace…'),
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
        if (!sugg.length) items.push({ label: 'No suggestions', disabled: true });
        items.push({
          label: 'Add to project dictionary',
          run: () => {
            this.project?.meta.dictionary.push(w.text);
            this.markMetaDirty();
            ed.refresh();
          },
        });
        items.push({
          label: 'Add to personal dictionary',
          run: () => {
            bridge.spell?.add(w.text);
            this.spellCache.set(w.text, false);
            ed.refresh();
          },
        });
        items.push({ sep: true });
      }
    }
    items.push({ label: 'Cut', kbd: formatCombo('Mod+X'), disabled: !hasSel, run: () => this.clipboardCut() });
    items.push({ label: 'Copy', kbd: formatCombo('Mod+C'), disabled: !hasSel, run: () => this.clipboardCopy() });
    items.push({ label: 'Paste', kbd: formatCombo('Mod+V'), run: () => this.clipboardPaste() });
    items.push({ label: 'Select All', kbd: formatCombo('Mod+A'), run: () => ed.selectAll() });
    const pl = pos ? ed.parsed.lines[pos.line] : null;
    if (pl?.type === 'character' && pl.cue) {
      items.push({ sep: true }, { label: `Rename ${pl.cue}…`, run: () => openRename(this, pl.cue) });
    }
    if (this.view !== 'script') items.push({ sep: true }, { label: 'Go to passage in Script', kbd: this.commands.label('dialogue.goToPassage'), run: () => this.goToPassage() });
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
    Promise.resolve(c.run()).catch((e) => alertDialog('Something went wrong', e?.message ?? String(e)));
  }

  private registerCommands() {
    const C = this.commands;
    const hasProject = () => !!this.project;
    const reg = (id: string, title: string, category: string, keys: string[], run: () => any, extra: Partial<Parameters<CommandRegistry['register']>[0]> = {}) =>
      C.register({ id, title, category, keys, run, ...extra });

    reg('app.commands', 'Commands & Shortcuts…', 'App', ['Mod+K'], () => openPalette(this), { inFields: true, menu: 'Help' });
    reg('app.settings', 'Settings…', 'App', ['Mod+P'], () => openSettings(this), { inFields: true, menu: isMac ? undefined : 'File' });
    reg('app.quit', 'Quit', 'App', ['Mod+Q'], () => this.quit(), { inFields: true, menu: isMac ? undefined : 'File' });
    reg('file.save', 'Save', 'File', ['Mod+S'], async () => {
      await this.flush();
      if (this.saveState === 'saved') toast('Saved.');
    }, { inFields: true, enabled: hasProject, menu: 'File' });
    reg('file.export', 'Export PDF…', 'File', ['Mod+E'], () => openExport(this), { inFields: true, enabled: hasProject, menu: 'File' });
    reg('project.new', 'New Project…', 'File', [], () => this.newProject(), { menu: 'File' });
    reg('project.openWorkspace', 'Open Workspace Folder…', 'File', [], () => this.chooseWorkspace(), { menu: 'File' });
    reg('project.importFountain', 'Import Fountain File…', 'File', [], () => this.importFountain(), { menu: 'File' });
    reg('project.backup', 'Back Up Project…', 'File', [], () => this.backupProject(), { enabled: hasProject, menu: 'File' });
    reg('project.importBackup', 'Import Project Backup…', 'File', [], () => this.importBackup(), { menu: 'File' });
    reg('project.rename', 'Rename Project…', 'File', [], () => this.renameProject(), { enabled: hasProject, menu: 'File' });
    reg('project.close', 'Close Project', 'File', [], () => this.closeProject().then(() => this.updateWelcome()), { enabled: hasProject, menu: 'File' });
    if (bridge.isElectron) reg('project.reveal', 'Show Project Folder', 'File', [], () => this.revealProject(), { enabled: hasProject, menu: 'File' });
    reg('project.reviewCopies', 'Review Other Screenplay Copies…', 'File', [], () => this.reviewConflictCopies(), { enabled: () => !!this.project?.conflicts.length });

    reg('edit.undo', 'Undo', 'Edit', [], () => this.undoRedo('undo'), { inFields: true });
    reg('edit.redo', 'Redo', 'Edit', [], () => this.undoRedo('redo'), { inFields: true });
    reg('edit.selectAll', 'Select All', 'Edit', [], () => this.selectAll(), { inFields: true });
    reg('search.script', 'Search in Screenplay', 'Search', ['Mod+Shift+F'], () => this.findbar.open(), { inFields: true, enabled: hasProject, menu: 'Edit' });
    reg('search.scenes', 'Search Scenes', 'Search', ['Mod+F'], () => this.outline.focusSearch(), { inFields: true, enabled: hasProject, menu: 'Edit' });
    reg('search.next', 'Find Next', 'Search', ['F3', 'Mod+G'], () => this.findbar.step(1), { enabled: () => this.findbar.hasQuery() });
    reg('search.prev', 'Find Previous', 'Search', ['Shift+F3', 'Mod+Shift+G'], () => this.findbar.step(-1), { enabled: () => this.findbar.hasQuery() });
    reg('character.rename', 'Rename Character…', 'Edit', [], () => openRename(this), { enabled: hasProject, menu: 'Edit' });

    reg('view.toggleScriptScene', 'Switch Script / Scene', 'View', ['Tab'], () => this.toggleScriptScene(), { editorOnly: true, enabled: hasProject, menu: 'View' });
    reg('view.script', 'Script View', 'View', ['Mod+1'], () => this.setView('script'), { enabled: hasProject, menu: 'View' });
    reg('view.scene', 'Scene View', 'View', ['Mod+2'], () => this.setView('scene'), { enabled: hasProject, menu: 'View' });
    reg('view.dialogue', 'Dialogue View', 'View', ['Mod+3'], () => this.setView('dialogue'), { enabled: hasProject, menu: 'View' });
    reg('view.titlePage', 'Title Page', 'View', ['Mod+T'], () => this.toggleTitlePage(), { inFields: true, enabled: hasProject, menu: 'View' });
    reg('view.source', 'Show Fountain Source', 'View', [], () => this.toggleSource(), { enabled: hasProject, menu: 'View' });
    reg('view.minimal', 'Minimal View', 'View', ['Mod+M'], () => this.toggleMinimal(), { inFields: true, menu: 'View' });
    reg('view.toggleMaximize', 'Maximize / Restore Window', 'View', ['Mod+Ö'], () => bridge.window('toggleMaximize'), { inFields: true, menu: 'View' });
    reg('view.leftPane', 'Toggle Scene Pane', 'View', ['Mod+Alt+1'], () => this.togglePane('left'), { inFields: true, menu: 'View' });
    reg('view.rightPane', 'Toggle Notes Pane', 'View', ['Mod+Alt+2'], () => this.togglePane('right'), { inFields: true, menu: 'View' });
    reg('view.zoomIn', 'Larger Text', 'View', ['Mod+='], () => this.zoom(1), { inFields: true, menu: 'View' });
    reg('view.zoomOut', 'Smaller Text', 'View', ['Mod+-'], () => this.zoom(-1), { inFields: true, menu: 'View' });

    reg('scene.prev', 'Previous Scene', 'Scenes', ['Alt+ArrowLeft'], () => this.stepScene(-1), { enabled: hasProject, menu: 'Scene' });
    reg('scene.next', 'Next Scene', 'Scenes', ['Alt+ArrowRight'], () => this.stepScene(1), { enabled: hasProject, menu: 'Scene' });
    reg('scene.new', 'New Scene After Current', 'Scenes', ['Mod+N'], () => this.insertScene(), { inFields: true, enabled: hasProject, menu: 'Scene' });
    reg('scene.duplicate', 'Duplicate Scene', 'Scenes', [], () => {
      const a = this.activeScene();
      if (a) this.duplicateScene(a);
    }, { enabled: () => this.activeScene()?.kind === 'scene', menu: 'Scene' });
    reg('scene.delete', 'Remove Scene…', 'Scenes', [], () => {
      const a = this.activeScene();
      if (a) this.deleteScene(a);
    }, { enabled: () => this.activeScene()?.kind === 'scene', menu: 'Scene' });
    reg('scene.moveUp', 'Move Scene Up', 'Scenes', ['Alt+Shift+ArrowUp'], () => {
      const a = this.activeScene();
      if (a) this.moveSceneBy(a, -1);
    }, { enabled: () => this.activeScene()?.kind === 'scene', menu: 'Scene' });
    reg('scene.moveDown', 'Move Scene Down', 'Scenes', ['Alt+Shift+ArrowDown'], () => {
      const a = this.activeScene();
      if (a) this.moveSceneBy(a, 1);
    }, { enabled: () => this.activeScene()?.kind === 'scene', menu: 'Scene' });
    reg('dialogue.goToPassage', 'Go to Passage in Script', 'Scenes', ['Mod+Enter'], () => this.goToPassage(), { enabled: () => this.view !== 'script', menu: 'Scene' });
    reg('scene.notes', 'Scene Notes', 'Scenes', [], () => this.showRightTab('scene'), { enabled: hasProject, menu: 'Scene' });
    reg('project.notes', 'Project Notes', 'Scenes', [], () => this.showRightTab('notes'), { enabled: hasProject, menu: 'Scene' });
    reg('project.history', 'History', 'Scenes', [], () => this.showRightTab('history'), { enabled: hasProject, menu: 'Scene' });
  }

  private undoRedo(which: 'undo' | 'redo') {
    const a = document.activeElement as HTMLElement | null;
    if (this.editor.hasFocus() || !a || a === document.body) {
      if (which === 'undo') {
        this.editor.history.seal();
        this.editor.undo();
      } else this.editor.redo();
    } else document.execCommand(which);
  }

  private selectAll() {
    const a = document.activeElement as HTMLElement | null;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && !this.editor.hasFocus()) (a as HTMLInputElement).select();
    else this.editor.selectAll();
  }

  showRightTab(tab: 'notes' | 'scene' | 'history') {
    this.state.layout.rightVisible = true;
    this.state.layout.rightTab = tab;
    this.applyLayout();
    this.rightPane.focusTab();
    this.saveStateSoon();
  }

  togglePane(side: 'left' | 'right') {
    const l = this.state.layout;
    if (side === 'left') l.leftVisible = !l.leftVisible;
    else l.rightVisible = !l.rightVisible;
    this.applyLayout();
    this.saveStateSoon();
    if (this.minimal) this.toggleMinimal();
  }

  toggleSource() {
    this.editor.setSource(!this.editor.source);
    this.updateChrome();
    this.saveStateSoon();
  }

  toggleMinimal() {
    const offset = this.editor.measureCaretOffset();
    this.minimal = !this.minimal;
    document.body.classList.toggle('minimal', this.minimal);
    this.editor.restoreCaretOffset(offset);
    if (this.minimal) this.editor.focus();
  }

  private zoom(dir: number) {
    const e = this.settings.editor;
    const size = Math.max(10, Math.min(32, e.fontSize + dir));
    const ratio = e.lineHeight / e.fontSize;
    e.fontSize = size;
    e.lineHeight = Math.round(size * ratio);
    this.applySettings();
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

  private async importFountain() {
    if (!this.state.workspace) {
      await this.chooseWorkspace();
      if (!this.state.workspace) return;
    }
    const file = await bridge.dialog('open', { title: 'Import Fountain file', filters: [{ name: 'Fountain', extensions: ['fountain', 'txt', 'spmd'] }] });
    if (!file) return;
    try {
      const p = await bridge.call('importFountain', file);
      await this.refreshProjects();
      await this.openProject(p.rel);
      toast(`Imported into the new project "${p.name}". The original file was not changed.`);
    } catch (e: any) {
      alertDialog('Import failed', e.message);
    }
  }

  private async backupProject() {
    const p = this.project;
    if (!p) return;
    await this.flush();
    const date = new Date().toISOString().slice(0, 10);
    const dest = await bridge.dialog('save', { title: 'Back up project', defaultPath: `${p.name} ${date}.scriptwright.zip`, filters: [{ name: 'Project backup', extensions: ['zip'] }] });
    if (!dest) return;
    try {
      const r = await bridge.call('backupProject', p.rel, dest);
      toast(`Backup saved: ${r.files} files including notes, scene information and history.`);
    } catch (e: any) {
      alertDialog('Backup failed', e.message);
    }
  }

  private async importBackup() {
    if (!this.state.workspace) {
      await this.chooseWorkspace();
      if (!this.state.workspace) return;
    }
    const file = await bridge.dialog('open', { title: 'Import project backup', filters: [{ name: 'Project backup', extensions: ['zip'] }] });
    if (!file) return;
    try {
      const p = await bridge.call('importBackup', file);
      await this.refreshProjects();
      await this.openProject(p.rel);
      toast(`Imported "${p.name}".`);
    } catch (e: any) {
      alertDialog('Import failed', e.message);
    }
  }

  async renameProject() {
    const p = this.project;
    if (!p) return;
    const name = await promptDialog('Rename project', 'Name', p.name, { okLabel: 'Rename' });
    if (!name || name === p.name) return;
    await this.flush();
    const rel = p.rel;
    await this.closeProject();
    try {
      const r = await bridge.call('renameProject', rel, name);
      await this.refreshProjects();
      await this.openProject(r.rel);
    } catch (e: any) {
      alertDialog('Rename failed', e.message);
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
    const groups = ['File', 'Edit', 'View', 'Scene', 'Help'];
    const model = groups.map((g) => ({
      label: g,
      items: this.commands
        .all()
        .filter((c) => c.menu === g)
        .map((c) => {
          const k = this.commands.keysFor(c.id)[0];
          return { id: c.id, label: c.title, accelerator: k ? toAccelerator(k) : undefined };
        }),
    }));
    bridge.setMenu(model).catch(() => {});
  }

  // ---------------------------------------------------------------------------------
  // Global keyboard handling

  recording: ((e: KeyboardEvent) => void) | null = null;

  private bindGlobal() {
    window.addEventListener('keydown', (e) => this.onGlobalKey(e), true);
    bridge.on('external', (ev) => this.onExternal(ev));
    bridge.on('request-close', () => this.onRequestClose());
    bridge.on('command', (id: string) => this.run(id));
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
      if (a && !this.editor.hasFocus() && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.classList.contains('list'))) {
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
    const inDialog = overlayOpen() || !!active?.closest('.dialog, .menu, .export');
    const matches = this.commands.lookup(combo);
    if (!matches.length) return;
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
