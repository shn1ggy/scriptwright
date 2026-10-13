// Project list for the current workspace.

import type { App } from '../app';
import { bridge } from '../bridge';
import { h, icon, iconButton } from './dom';
import { openMenu } from './overlay';

export class ProjectsPane {
  el: HTMLElement;
  private list: HTMLElement;
  private collapser: HTMLButtonElement;
  private chevron: HTMLElement;
  private collapsed = false;

  constructor(private app: App) {
    this.chevron = h('span', { style: { display: 'inline-flex' } }, icon('chevronDown'));
    this.collapser = h('button', { class: 'collapser', tabindex: '-1', onclick: () => this.toggle() }, this.chevron, 'Projects');
    this.list = h('div', { class: 'list', role: 'listbox', 'aria-label': 'Projects' });
    const more = iconButton('more', 'Project actions', (e) => this.moreMenu(e.currentTarget as HTMLElement));
    this.el = h(
      'div',
      { class: 'projects' },
      h('div', { class: 'section-head' }, this.collapser, h('span', { class: 'spacer' }), iconButton('plus', 'New project', () => this.app.newProject()), more),
      this.list,
    );
  }

  setCollapsed(c: boolean) {
    this.collapsed = c;
    this.list.classList.toggle('hidden', c);
    this.chevron.replaceChildren(icon(c ? 'chevronRight' : 'chevronDown'));
  }

  private toggle() {
    this.app.state.layout.projectsCollapsed = !this.collapsed;
    this.setCollapsed(!this.collapsed);
    this.app.saveStateSoon();
  }

  /** Actions for one project (right-click); other projects are opened first. */
  private projectMenu(rel: string, at: { x: number; y: number }) {
    const isOpen = this.app.project?.rel === rel;
    const entry = this.app.projects.find((x) => x.rel === rel);
    const withProject = (cmd: string) => async () => {
      if (!isOpen) await this.app.openProject(rel);
      if (this.app.project?.rel === rel) this.app.run(cmd);
    };
    openMenu(
      [
        ...(isOpen ? [] : [{ label: 'Open', run: () => this.app.openProject(rel) }, { sep: true }]),
        { label: 'Rename Project…', kbd: this.app.commands.label('project.rename'), disabled: entry?.loose, run: withProject('project.rename') },
        { label: 'Back Up Project…', kbd: this.app.commands.label('project.backup'), disabled: entry?.loose, run: withProject('project.backup') },
        ...(bridge.isElectron ? [{ label: 'Show Project Folder', run: withProject('project.reveal') }] : []),
        ...(isOpen ? [{ sep: true }, { label: 'Close Project', run: () => this.app.run('project.close') }] : []),
      ],
      at,
    );
  }

  private moreMenu(anchor: HTMLElement) {
    const has = !!this.app.project;
    openMenu(
      [
        { label: 'New Project…', run: () => this.app.newProject() },
        { label: 'Import Fountain File…', run: () => this.app.run('project.importFountain') },
        { label: 'Import Project Backup…', run: () => this.app.run('project.importBackup') },
        { sep: true },
        { label: 'Back Up Project…', disabled: !has, run: () => this.app.run('project.backup') },
        { label: 'Rename Project…', disabled: !has, run: () => this.app.run('project.rename') },
        ...(bridge.isElectron ? [{ label: 'Show Project Folder', disabled: !has, run: () => this.app.run('project.reveal') }] : []),
        { label: 'Close Project', disabled: !has, run: () => this.app.run('project.close') },
        { sep: true },
        { label: 'Open Workspace Folder…', run: () => this.app.chooseWorkspace() },
        { label: 'Reload Project List', run: () => this.app.refreshProjects() },
      ],
      anchor.getBoundingClientRect(),
    );
  }

  render() {
    this.list.textContent = '';
    const ws = this.app.state.workspace;
    this.el.title = ws ? `Workspace: ${ws}` : '';
    if (!ws) {
      this.list.append(h('div', { class: 'empty-note' }, 'No workspace selected.'));
      return;
    }
    if (!this.app.projects.length) {
      this.list.append(h('div', { class: 'empty-note' }, 'No projects in this workspace.'));
      return;
    }
    for (const p of this.app.projects) {
      const open = this.app.project?.rel === p.rel;
      const row = h(
        'div',
        { class: `row${open ? ' active selected' : ''}`, role: 'option', title: p.loose ? `${p.file} (not in a project folder yet)` : `${p.rel}/${p.file ?? ''}` },
        h('span', { class: 'label' }, p.name),
        p.loose ? h('span', { class: 'meta' }, 'file') : null,
        p.conflicts.length ? h('span', { class: 'meta warn', title: `Other screenplay copies: ${p.conflicts.join(', ')}` }, '⚠') : null,
      );
      row.addEventListener('click', () => this.app.openProject(p.rel));
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.projectMenu(p.rel, { x: e.clientX, y: e.clientY });
      });
      this.list.append(row);
    }
  }
}
