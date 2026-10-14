// Project list for the current workspace, with an Archive section for old projects.

import type { App } from '../app';
import { bridge } from '../bridge';
import { h, icon, iconButton } from './dom';
import { openMenu } from './overlay';
import { t } from '../../shared/i18n';

export class ProjectsPane {
  el: HTMLElement;
  private list: HTMLElement;
  private collapser: HTMLButtonElement;
  private chevron: HTMLElement;
  private collapsed = false;
  private archiveOpen = false;

  constructor(private app: App) {
    this.chevron = h('span', { class: 'collapse-mark', 'aria-hidden': 'true' }, icon('chevronDown'));
    this.collapser = h('button', { class: 'collapser', tabindex: '-1', title: t("Show or hide the projects"), 'aria-expanded': 'true', onclick: () => this.toggle() }, t("Projects"), this.chevron);
    this.list = h('div', { class: 'list', role: 'listbox', 'aria-label': t("Projects") });
    const more = iconButton('more', t("Project actions"), (e) => this.moreMenu(e.currentTarget as HTMLElement));
    this.el = h(
      'div',
      { class: 'projects' },
      h('div', { class: 'section-head' }, this.collapser, h('span', { class: 'spacer' }), iconButton('plus', t("New project"), () => this.app.newProject()), more),
      this.list,
    );
  }

  setCollapsed(c: boolean) {
    this.collapsed = c;
    this.list.classList.toggle('hidden', c);
    this.chevron.replaceChildren(icon(c ? 'chevronRight' : 'chevronDown'));
    this.collapser.setAttribute('aria-expanded', String(!c));
  }

  private toggle() {
    this.app.state.layout.projectsCollapsed = !this.collapsed;
    this.setCollapsed(!this.collapsed);
    this.app.saveStateSoon();
  }

  private moreMenu(anchor: HTMLElement) {
    const archived = this.app.projects.filter((p) => p.archived).length;
    openMenu(
      [
        { label: t("New Project…"), kbd: this.app.commands.label('project.new'), run: () => this.app.newProject() },
        { label: t("Import Fountain File…"), kbd: this.app.commands.label('project.importFountain'), run: () => this.app.run('project.importFountain') },
        { label: t("Import Project Backup…"), kbd: this.app.commands.label('project.importBackup'), run: () => this.app.run('project.importBackup') },
        { sep: true },
        { label: this.archiveOpen ? t("Hide Archive") : t("Show Archive ({0})", archived), disabled: !archived, run: () => this.setArchiveOpen(!this.archiveOpen) },
        { label: t("Reload Project List"), run: () => this.app.refreshProjects() },
      ],
      anchor.getBoundingClientRect(),
    );
  }

  private setArchiveOpen(on: boolean) {
    this.archiveOpen = on;
    this.render();
  }

  /** Actions for one project (right-click); other projects are opened first where needed. */
  private projectMenu(rel: string, at: { x: number; y: number }) {
    const isOpen = this.app.project?.rel === rel;
    const entry = this.app.projects.find((x) => x.rel === rel);
    if (!entry) return;
    const withProject = (cmd: string) => async () => {
      if (!isOpen) await this.app.openProject(rel);
      if (this.app.project?.rel === rel) this.app.run(cmd);
    };
    openMenu(
      [
        ...(isOpen ? [] : [{ label: t("Open"), run: () => this.app.openProject(rel) }, { sep: true }]),
        { label: t("Rename Project…"), kbd: this.app.commands.label('project.rename'), disabled: entry.loose, run: withProject('project.rename') },
        { label: t("Back Up Project…"), kbd: this.app.commands.label('project.backup'), disabled: entry.loose, run: withProject('project.backup') },
        ...(bridge.isElectron ? [{ label: t("Show in Folder"), run: () => this.app.revealPath(entry.loose ? entry.rel : `${entry.rel}/${entry.file ?? ''}`) }] : []),
        { sep: true },
        entry.archived
          ? { label: t("Move Out of Archive"), run: () => this.app.archiveProject(rel, false) }
          : { label: t("Move to Archive"), disabled: entry.loose, run: () => this.app.archiveProject(rel, true) },
        { label: t("Delete Project…"), run: () => this.app.deleteProject(rel) },
        ...(isOpen ? [{ sep: true }, { label: t("Close Project"), run: () => this.app.run('project.close') }] : []),
      ],
      at,
    );
  }

  private row(p: (typeof this.app.projects)[number]) {
    const open = this.app.project?.rel === p.rel;
    const row = h(
      'div',
      { class: `row project-row${open ? ' active selected' : ''}${p.archived ? ' archived' : ''}`, role: 'option', title: p.loose ? t("{0} (not in a project folder yet)", p.file) : `${p.rel}/${p.file ?? ''}` },
      h('span', { class: 'label' }, p.name),
      p.loose ? h('span', { class: 'meta' }, t("file")) : null,
      p.conflicts.length ? h('span', { class: 'meta warn', title: t("Other screenplay copies: {0}", p.conflicts.join(', ')) }, '⚠') : null,
    );
    row.addEventListener('click', () => this.app.openProject(p.rel));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.projectMenu(p.rel, { x: e.clientX, y: e.clientY });
    });
    return row;
  }

  render() {
    this.list.textContent = '';
    const ws = this.app.state.workspace;
    if (!ws) {
      this.list.append(h('div', { class: 'empty-note' }, t("No workspace selected.")));
      return;
    }
    const active = this.app.projects.filter((p) => !p.archived);
    const archived = this.app.projects.filter((p) => p.archived);
    if (!active.length) this.list.append(h('div', { class: 'empty-note' }, archived.length ? t("All projects are archived.") : t("No projects in this workspace.")));
    for (const p of active) this.list.append(this.row(p));
    // The open project is always visible, even when it is archived.
    const showArchive = this.archiveOpen || archived.some((p) => p.rel === this.app.project?.rel);
    if (archived.length) {
      const head = h(
        'button',
        { class: `row archive-head${showArchive ? ' open' : ''}`, tabindex: '-1', title: showArchive ? t("Hide the archive") : t("Show the archived projects"), onclick: () => this.setArchiveOpen(!showArchive) },
        h('span', { class: 'label' }, t("Archive")),
        h('span', { class: 'meta' }, String(archived.length)),
      );
      this.list.append(head);
      if (showArchive) for (const p of archived) this.list.append(this.row(p));
    }
  }
}
