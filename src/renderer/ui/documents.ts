// Documents beside the screenplay: exposé, treatment, synopsis … as Markdown files in the
// project folder. They are listed in their own section of the left pane (Projects → Scenes →
// Documents) and open in a second editor in prose mode, so the screenplay, its scenes and its
// notes stay exactly as they are while a document is being written.

import type { App } from '../app';
import { bridge } from '../bridge';
import { h, icon, iconButton, uid } from './dom';
import { MenuItem, alertDialog, confirmDialog, openMenu, promptDialog, toast } from './overlay';
import { Editor } from '../editor/editor';
import { SCENE_COLORS } from './outline';
import { projectExportSettings } from './export';
import { DocumentRecord, EditorSettings } from '../../shared/types';
import { cleanText, titleFields } from '../../shared/fountain';
import { t, tn } from '../../shared/i18n';

const countWords = (s: string) => (s.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []).length;

interface OpenDoc {
  rec: DocumentRecord;
  hash: string | null;
  /** Editor version last written to disk. */
  saved: number;
}

export class Documents {
  el: HTMLElement;
  private list: HTMLElement;
  private countEl: HTMLElement;
  private collapser: HTMLButtonElement;
  private chevron: HTMLElement;
  private collapsed = false;
  private archiveOpen = false;
  private editor: Editor | null = null;
  private cur: OpenDoc | null = null;
  private saveTimer: any = null;

  constructor(private app: App) {
    this.chevron = h('span', { class: 'collapse-mark', 'aria-hidden': 'true' }, icon('chevronDown'));
    this.collapser = h('button', { class: 'collapser', tabindex: '-1', title: t('Show or hide the documents'), 'aria-expanded': 'true', onclick: () => this.toggleCollapsed() }, t('Documents'), this.chevron);
    this.countEl = h('span', { class: 'dim' });
    this.list = h('div', { class: 'list', role: 'listbox', 'aria-label': t('Documents') });
    this.el = h(
      'div',
      { class: 'documents' },
      h('div', { class: 'section-head' }, this.collapser, this.countEl, h('span', { class: 'spacer' }), iconButton('plus', t('New document'), (e) => this.newMenu(e.currentTarget as HTMLElement))),
      this.list,
    );
  }

  // ---------------------------------------------------------------------------------
  // State

  get isOpen(): boolean {
    return !!this.cur;
  }

  get title(): string {
    return this.cur?.rec.title ?? '';
  }

  hasFocus(): boolean {
    return !!this.cur && !!this.editor?.hasFocus();
  }

  get docEditor(): Editor | null {
    return this.cur ? this.editor : null;
  }

  private records(): DocumentRecord[] {
    const m = this.app.project?.meta;
    if (!m) return [];
    m.documents ??= [];
    return m.documents;
  }

  setCollapsed(c: boolean) {
    this.collapsed = c;
    this.el.classList.toggle('collapsed', c);
    this.list.classList.toggle('hidden', c);
    this.chevron.replaceChildren(icon(c ? 'chevronRight' : 'chevronDown'));
    this.collapser.setAttribute('aria-expanded', String(!c));
  }

  private toggleCollapsed() {
    this.app.state.layout.documentsCollapsed = !this.collapsed;
    this.setCollapsed(!this.collapsed);
    this.app.saveStateSoon();
  }

  // ---------------------------------------------------------------------------------
  // The list

  render() {
    const all = this.records();
    const live = all.filter((d) => !d.archived);
    const archived = all.filter((d) => d.archived);
    this.countEl.textContent = live.length ? String(live.length) : '';
    this.list.textContent = '';
    if (!this.app.project) return;
    if (!all.length) {
      this.list.append(h('div', { class: 'docs-empty' }, t('An exposé, a treatment or notes for this project: add them with +.')));
      return;
    }
    const row = (d: DocumentRecord) => {
      const r = h(
        'button',
        { class: `row doc-row${this.cur?.rec.id === d.id ? ' active selected' : ''}${d.archived ? ' archived' : ''}`, role: 'option', dataset: { id: d.id }, title: d.file },
        h('span', { class: 'doc-icon', 'aria-hidden': 'true' }, icon('document')),
        h('span', { class: 'label' }, d.title),
      );
      if (d.color) {
        r.classList.add('tinted');
        r.style.setProperty('--scene', d.color);
      }
      r.addEventListener('click', () => void this.open(d.id));
      r.addEventListener('dblclick', () => void this.rename(d));
      r.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.menu(d, { x: e.clientX, y: e.clientY });
      });
      return r;
    };
    for (const d of live) this.list.append(row(d));
    if (archived.length) {
      const head = h(
        'button',
        { class: 'row archive-head', onclick: () => {
          this.archiveOpen = !this.archiveOpen;
          this.render();
        } },
        h('span', { class: 'collapse-mark', 'aria-hidden': 'true' }, icon(this.archiveOpen ? 'chevronDown' : 'chevronRight')),
        h('span', { class: 'label' }, t('Archive ({0})', archived.length)),
      );
      this.list.append(head);
      if (this.archiveOpen) for (const d of archived) this.list.append(row(d));
    }
  }

  private newMenu(anchor: HTMLElement) {
    if (!this.app.project) return;
    const make = (title: string) => () => void this.create(title);
    const items: MenuItem[] = [
      { head: t('New document') },
      { label: t('Exposé'), run: make(t('Exposé')) },
      { label: t('Treatment'), run: make(t('Treatment')) },
      { label: t('Synopsis'), run: make(t('Synopsis')) },
      { label: t('Outline'), run: make(t('Outline')) },
      { label: t('Notes'), run: make(t('Notes')) },
      { sep: true },
      { label: t('Other…'), run: async () => {
        const name = (await promptDialog(t('New document'), t('Name'), '', { okLabel: t('Create'), placeholder: t('e.g. Character notes') }))?.trim();
        if (name) await this.create(name);
      } },
    ];
    openMenu(items, anchor.getBoundingClientRect());
  }

  private menu(d: DocumentRecord, at: { x: number; y: number }) {
    const items: MenuItem[] = [
      { label: t('Open'), run: () => void this.open(d.id) },
      { label: t('Rename…'), run: () => void this.rename(d) },
      { label: t('Export as PDF…'), run: async () => {
        await this.open(d.id);
        await this.exportPdf();
      } },
      { head: t('Color') },
      ...SCENE_COLORS.map((c) => ({ label: c.name, dot: c.value, run: () => this.update(d, { color: c.value }) })),
      { label: t('No color'), run: () => this.update(d, { color: undefined }) },
      { sep: true },
      d.archived ? { label: t('Restore from archive'), run: () => this.update(d, { archived: false }) } : { label: t('Move to archive'), run: () => void this.archive(d) },
      { label: t('Delete…'), run: () => void this.remove(d) },
    ];
    openMenu(items, at);
  }

  private update(d: DocumentRecord, patch: Partial<DocumentRecord>) {
    Object.assign(d, patch);
    if (patch.color === undefined && 'color' in patch) delete d.color;
    if (patch.archived === false) delete d.archived;
    this.app.markMetaDirty();
    this.render();
  }

  // ---------------------------------------------------------------------------------
  // Files

  async create(title: string) {
    const p = this.app.project;
    if (!p) return;
    try {
      const r: { file: string; hash: string } = await bridge.call('createDocument', p.rel, title, '');
      const rec: DocumentRecord = { id: uid(), title, file: r.file, created: new Date().toISOString() };
      this.records().push(rec);
      this.app.markMetaDirty();
      if (this.collapsed) {
        this.app.state.layout.documentsCollapsed = false;
        this.setCollapsed(false);
      }
      await this.open(rec.id);
    } catch (e: any) {
      alertDialog(t('Document not created'), e?.message ?? String(e));
    }
  }

  private async rename(d: DocumentRecord) {
    const p = this.app.project;
    if (!p) return;
    const name = (await promptDialog(t('Rename document'), t('Name'), d.title, { okLabel: t('Rename') }))?.trim();
    if (!name || name === d.title) return;
    if (this.cur?.rec.id === d.id) await this.flush();
    try {
      d.file = await bridge.call('renameDocument', p.rel, d.file, name);
      d.title = name;
      this.app.markMetaDirty();
      this.render();
      this.app.updateChrome();
    } catch (e: any) {
      alertDialog(t('Not renamed'), e?.message ?? String(e));
    }
  }

  private async archive(d: DocumentRecord) {
    if (this.cur?.rec.id === d.id) await this.close();
    this.update(d, { archived: true });
    toast(t('“{0}” moved to the archive.', d.title), { actions: [{ label: t('Undo'), run: () => this.update(d, { archived: false }) }] });
  }

  private async remove(d: DocumentRecord) {
    const p = this.app.project;
    if (!p) return;
    const where = bridge.isElectron ? t('the Trash') : t('the project’s deleted files');
    if (!(await confirmDialog(t('Delete document'), t('Delete “{0}”? The file {1} is moved to {2}.', d.title, d.file, where), t('Delete'), { danger: true }))) return;
    if (this.cur?.rec.id === d.id) await this.close();
    try {
      await bridge.call('deleteDocument', p.rel, d.file);
      const m = p.meta;
      m.documents = (m.documents ?? []).filter((x) => x.id !== d.id);
      this.app.markMetaDirty();
      this.render();
    } catch (e: any) {
      alertDialog(t('Not deleted'), e?.message ?? String(e));
    }
  }

  // ---------------------------------------------------------------------------------
  // Writing

  private ensureEditor(): Editor {
    if (this.editor) return this.editor;
    const ed = new Editor(this.app.center, this.app.settings.editor);
    ed.setProse(true);
    // The document editor handles its own undo and select-all keys.
    ed.editKeysFromMenu = false;
    ed.hooks = {
      onChange: (origin) => {
        if (origin === 'load') return;
        this.scheduleSave();
        this.app.updateCounts();
      },
      onSelection: () => this.app.updateCounts(),
      onContextMenu: (e) => this.editorMenu(e),
      isMisspelled: this.app.spellHook(),
    };
    this.editor = ed;
    return ed;
  }

  applySettings(s: EditorSettings) {
    if (this.editor) this.editor.applySettings(s);
  }

  /** Opens a document in place of the screenplay. */
  async open(id: string) {
    const p = this.app.project;
    const rec = this.records().find((d) => d.id === id);
    if (!p || !rec) return;
    if (this.cur?.rec.id === id) {
      this.editor?.focus();
      return;
    }
    await this.flush();
    let r: { text: string; hash: string } | null;
    try {
      r = await bridge.call('readDocument', p.rel, rec.file);
    } catch (e: any) {
      alertDialog(t('Document not opened'), e?.message ?? String(e));
      return;
    }
    if (!r) {
      const ok = await confirmDialog(t('Document missing'), t('The file {0} is no longer in the project folder. Remove “{1}” from the list?', rec.file, rec.title), t('Remove from list'));
      if (ok) {
        p.meta.documents = this.records().filter((d) => d.id !== id);
        this.app.markMetaDirty();
        this.render();
      }
      return;
    }
    this.app.leaveForDocument();
    const ed = this.ensureEditor();
    ed.setText(r.text);
    this.cur = { rec, hash: r.hash, saved: ed.version };
    this.app.center.classList.add('doc-open');
    this.render();
    this.app.updateChrome();
    this.app.updateCounts();
    ed.focus();
  }

  /** Back to the screenplay (saves the document first). */
  async close(focusScript = true) {
    if (!this.cur) return;
    await this.flush();
    this.cur = null;
    this.app.center.classList.remove('doc-open');
    this.render();
    this.app.updateChrome();
    this.app.updateCounts();
    if (focusScript) this.app.editor.focus();
  }

  private scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), this.app.settings.saving.autosaveDelayMs);
  }

  /** Writes the open document if it changed. */
  async flush(): Promise<boolean> {
    clearTimeout(this.saveTimer);
    const c = this.cur;
    const p = this.app.project;
    if (!c || !p || !this.editor || c.saved === this.editor.version) return true;
    const version = this.editor.version;
    const text = this.editor.getText();
    const r = await bridge.call('saveDocument', p.rel, c.rec.file, text, c.hash);
    if (r.ok) {
      c.hash = r.hash;
      c.saved = version;
      return true;
    }
    if (r.reason === 'conflict') {
      // Changed on another computer meanwhile: keep both, nothing is lost.
      const copy: { file: string; hash: string } = await bridge.call('createDocument', p.rel, `${c.rec.title} (${t('this computer')})`, text);
      const rec: DocumentRecord = { id: uid(), title: `${c.rec.title} (${t('this computer')})`, file: copy.file, created: new Date().toISOString() };
      this.records().push(rec);
      this.app.markMetaDirty();
      c.hash = r.diskHash ?? null;
      c.saved = version;
      this.editor.setText(r.diskText ?? '');
      c.saved = this.editor.version;
      this.render();
      alertDialog(t('Document changed elsewhere'), t('“{0}” was changed on another computer while you wrote. That version is shown now; yours was kept as “{1}”.', c.rec.title, rec.title));
      return false;
    }
    toast(t('The document could not be saved: {0}', 'message' in r ? r.message : r.reason), { warn: true });
    return false;
  }

  /** Words and characters for the status line. */
  countText(): string {
    const ed = this.editor;
    if (!ed || !this.cur) return '';
    let words = 0;
    let chars = 0;
    const sel = ed.selectedText();
    if (sel) {
      words = countWords(sel);
      chars = sel.length;
      return t('{0} · {1} words · {2} characters', t('Selection'), words.toLocaleString(), chars.toLocaleString());
    }
    ed.lines.forEach((l, i) => {
      const pl = ed.parsed.lines[i];
      if (pl.type === 'note' || pl.type === 'boneyard') return;
      const clean = cleanText(l.text, pl.flags);
      words += countWords(clean);
      chars += clean.length;
    });
    // About 300 words make a typed page of an exposé or treatment.
    const pages = Math.max(1, Math.round(words / 300));
    return t('{0} · {1} words · {2} characters · about {3}', this.cur.rec.title, words.toLocaleString(), chars.toLocaleString(), tn(pages, '{0} page', '{0} pages'));
  }

  private editorMenu(e: MouseEvent) {
    const ed = this.editor;
    if (!ed) return;
    const has = !!ed.selectedText();
    openMenu(
      [
        { label: t('Cut'), disabled: !has, run: async () => {
          await bridge.clipboard.writeText(ed.selectedText());
          ed.insertText('', 'other');
        } },
        { label: t('Copy'), disabled: !has, run: () => void bridge.clipboard.writeText(ed.selectedText()) },
        { label: t('Paste'), run: async () => {
          const s = await bridge.clipboard.readText();
          if (s) ed.paste(s);
        } },
        { label: t('Select All'), run: () => ed.selectAll() },
        { sep: true },
        { label: t('Export as PDF…'), run: () => void this.exportPdf() },
      ],
      { x: e.clientX, y: e.clientY },
    );
  }

  /** The open document as PDF, with the project's title and author above it. */
  async exportPdf() {
    const c = this.cur;
    const p = this.app.project;
    if (!c || !p || !this.editor) return;
    await this.flush();
    const lines = this.app.editor.lineTexts;
    const fields = titleFields(lines, this.app.editor.parsed);
    const title = fields.find((f) => f.key === 'title')?.value.replace(/[*_]/g, '') || p.name;
    const author = fields.find((f) => f.key === 'author' || f.key === 'authors')?.value.replace(/[*_]/g, '') ?? '';
    const safe = `${p.name} - ${c.rec.title}`.replace(/[\\/:*?"<>|]/g, '-');
    const dest = await bridge.dialog('save', { title: t('Export PDF'), defaultPath: `${safe}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (!dest) return;
    try {
      const paper = projectExportSettings(this.app).paper;
      const pdf = await bridge.call('exportDocumentPdf', this.editor.getText(), { paper, title, author, docTitle: c.rec.title });
      const file = dest.toLowerCase().endsWith('.pdf') ? dest : dest + '.pdf';
      await bridge.call('writeFile', file, pdf as unknown as Uint8Array);
      toast(t('Saved as {0}.', file.split(/[\\/]/).pop() ?? file), bridge.isElectron ? { actions: [{ label: t('Show in folder'), run: () => void bridge.window('reveal', file) }] } : {});
    } catch (e: any) {
      alertDialog(t('Export failed'), e?.message ?? String(e));
    }
  }

  /** A project closes: forget the open document (after saving it). */
  async reset() {
    if (this.cur) await this.flush();
    this.cur = null;
    this.app.center.classList.remove('doc-open');
    this.archiveOpen = false;
    this.render();
  }
}
