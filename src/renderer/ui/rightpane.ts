// Supporting pane: project notes, scene information and history.

import type { App, SceneItem } from '../app';
import { bridge } from '../bridge';
import { h } from './dom';
import { confirmDialog, openDialog, toast } from './overlay';
import { SCENE_COLORS, STATUS_LABELS } from './outline';
import { SceneStatus } from '../../shared/types';

type Tab = 'notes' | 'scene' | 'history';

export class RightPane {
  el: HTMLElement;
  private body: HTMLElement;
  private tabBtns: Record<Tab, HTMLButtonElement>;
  private tab: Tab = 'notes';
  private sceneFor: string | null = null;
  private historyStale = true;

  constructor(private app: App) {
    const mk = (t: Tab, label: string) => h('button', { class: 'tab', tabindex: '-1', onclick: () => this.switchTo(t) }, label);
    this.tabBtns = { notes: mk('notes', 'Notes'), scene: mk('scene', 'Scene'), history: mk('history', 'History') };
    this.body = h('div', { class: 'rp-body' });
    this.el = h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: '0' } }, h('div', { class: 'rp-tabs' }, this.tabBtns.notes, this.tabBtns.scene, this.tabBtns.history), this.body);
  }

  private switchTo(t: Tab) {
    this.app.state.layout.rightTab = t;
    this.setTab(t);
    this.app.saveStateSoon();
  }

  setTab(t: Tab) {
    if (this.tab === t && this.body.childElementCount) return;
    this.tab = t;
    for (const [k, b] of Object.entries(this.tabBtns)) b.classList.toggle('on', k === t);
    this.render();
  }

  focusTab() {
    const f = this.body.querySelector<HTMLElement>('textarea, input');
    f?.focus();
  }

  historyChanged() {
    this.historyStale = true;
    if (this.tab === 'history' && this.app.state.layout.rightVisible) this.render();
  }

  onActiveSceneChange() {
    if (this.tab !== 'scene') return;
    const s = this.currentScene();
    if ((s?.id ?? null) !== this.sceneFor) this.render();
  }

  private currentScene(): SceneItem | undefined {
    return this.app.view === 'scene' ? this.app.focusedItem() ?? this.app.activeScene() : this.app.activeScene();
  }

  render() {
    this.body.textContent = '';
    const p = this.app.project;
    if (!p) {
      this.body.append(h('div', { class: 'notice' }, 'Open a project to see its notes.'));
      return;
    }
    if (this.tab === 'notes') this.renderNotes();
    else if (this.tab === 'scene') this.renderScene();
    else this.renderHistory();
  }

  private renderNotes() {
    const p = this.app.project!;
    const ta = h('textarea', { class: 'field grow', placeholder: 'Notes for the whole project', 'aria-label': 'Project notes', spellcheck: 'true' });
    ta.value = p.meta.notes;
    ta.addEventListener('input', () => {
      p.meta.notes = ta.value;
      this.app.markMetaDirty();
    });
    this.body.append(h('label', { class: 'cap' }, 'Project notes'), ta);
    if (p.meta.detached.length) {
      const box = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, h('label', { class: 'cap' }, `Detached scene information (${p.meta.detached.length})`));
      box.append(h('div', { class: 'notice' }, 'Information whose scene could not be identified. Attach it to the current scene or delete it.'));
      for (const d of p.meta.detached.slice()) {
        const bits = [d.summary, d.notes].filter(Boolean).join(' — ');
        box.append(
          h(
            'div',
            { class: 'history-row' },
            h('span', { class: 'label', title: `${d.reason}\n${bits}` }, `${d.heading || '(no heading)'}${bits ? ' · ' + bits.slice(0, 60) : ''}`),
            h('button', {
              class: 'btn sm',
              onclick: () => {
                const cur = this.app.activeScene();
                if (!cur || cur.kind !== 'scene') {
                  toast('Place the caret in a scene first.');
                  return;
                }
                p.meta.detached = p.meta.detached.filter((x) => x.id !== d.id);
                this.app.updateSceneRecord(cur, { summary: [cur.record?.summary, d.summary].filter(Boolean).join('\n'), notes: [cur.record?.notes, d.notes].filter(Boolean).join('\n\n'), status: cur.record?.status || d.status, color: cur.record?.color || d.color });
                this.render();
              },
            }, 'Attach'),
            h('button', {
              class: 'btn sm',
              onclick: async () => {
                if (!(await confirmDialog('Delete detached information', 'Delete this scene information permanently?', 'Delete', { danger: true }))) return;
                p.meta.detached = p.meta.detached.filter((x) => x.id !== d.id);
                this.app.markMetaDirty();
                this.render();
              },
            }, 'Delete'),
          ),
        );
      }
      this.body.append(box);
    }
  }

  private renderScene() {
    const item = this.currentScene();
    this.sceneFor = item?.id ?? null;
    if (!item || item.kind !== 'scene') {
      this.body.append(h('div', { class: 'notice' }, 'Place the caret in a scene to add its summary, status, color and notes.'));
      return;
    }
    const rec = this.app.sceneRecord(item)!;
    const summary = h('textarea', { class: 'field', rows: 3, placeholder: 'One or two lines about the scene', 'aria-label': 'Scene summary', style: { minHeight: '60px' } });
    summary.value = rec.summary ?? '';
    summary.addEventListener('input', () => {
      rec.summary = summary.value;
      this.app.markMetaDirty();
      this.app.outline.render();
    });
    const status = h('select', { class: 'field', 'aria-label': 'Scene status' });
    for (const [k, label] of Object.entries(STATUS_LABELS)) status.append(h('option', { value: k }, label));
    status.value = rec.status ?? '';
    status.addEventListener('change', () => this.app.updateSceneRecord(item, { status: status.value as SceneStatus }));
    const sw = h('div', { class: 'swatches' });
    const drawSwatches = () => {
      sw.textContent = '';
      sw.append(h('button', { class: !rec.color ? 'on' : '', title: 'No color', style: { background: 'transparent' }, onclick: () => setColor(undefined) }));
      for (const c of SCENE_COLORS) sw.append(h('button', { class: rec.color === c.value ? 'on' : '', title: c.name, style: { background: c.value }, onclick: () => setColor(c.value) }));
    };
    const setColor = (c: string | undefined) => {
      this.app.updateSceneRecord(item, { color: c });
      drawSwatches();
    };
    drawSwatches();
    const notes = h('textarea', { class: 'field grow', placeholder: 'Notes for this scene', 'aria-label': 'Scene notes' });
    notes.value = rec.notes ?? '';
    notes.addEventListener('input', () => {
      rec.notes = notes.value;
      this.app.markMetaDirty();
    });
    this.body.append(
      h('div', { class: 'notice', title: item.heading }, h('strong', null, `${item.order}. `), item.heading),
      h('div', null, h('label', { class: 'cap' }, 'Summary'), summary),
      h('div', { style: { display: 'flex', gap: '10px', alignItems: 'flex-end' } }, h('div', { style: { flex: '1' } }, h('label', { class: 'cap' }, 'Status'), status), h('div', null, h('label', { class: 'cap' }, 'Color'), sw)),
      h('label', { class: 'cap', style: { marginBottom: '-6px' } }, 'Scene notes'),
      notes,
    );
  }

  private async renderHistory() {
    const p = this.app.project!;
    const wrap = h('div', { style: { display: 'flex', flexDirection: 'column' } });
    this.body.append(
      h('div', { class: 'notice' }, 'Automatic snapshots while you write (at most every few minutes). All from the last 24 hours are kept, then one per day for 30 days.'),
      h('div', { style: { display: 'flex', gap: '6px' } }, h('button', { class: 'btn', onclick: () => this.snapshotNow() }, 'Save snapshot now')),
      wrap,
    );
    const list = await bridge.call('listHistory', p.rel);
    this.historyStale = false;
    if (!list.length) {
      wrap.append(h('div', { class: 'notice' }, 'No snapshots yet.'));
      return;
    }
    for (const it of list) {
      const label = it.name.replace(/^\d{4}-\d{2}-\d{2}_\d{6}\s*/, '').replace(/\.fountain$/, '');
      const when = new Date(it.time).toLocaleString();
      wrap.append(
        h(
          'div',
          { class: 'history-row' },
          h('span', { class: 'label' }, when, label && label !== 'auto' ? h('span', { class: 'dim' }, ` · ${label}`) : null),
          h('button', { class: 'btn sm', onclick: () => this.preview(it.name, when) }, 'Preview'),
        ),
      );
    }
  }

  private async snapshotNow() {
    const p = this.app.project!;
    await bridge.call('snapshotProject', p.rel, this.app.editor.getText(), 'manual');
    toast('Snapshot saved.');
    this.render();
  }

  private async preview(name: string, when: string) {
    const p = this.app.project!;
    const text = await bridge.call('readHistory', p.rel, name);
    const pre = h('div', { class: 'preview-text' }, text);
    openDialog({
      title: `Snapshot from ${when}`,
      width: 720,
      body: [pre],
      buttons: [
        { label: 'Close' },
        {
          label: 'Restore this version',
          primary: true,
          run: async () => {
            await bridge.call('snapshotProject', p.rel, this.app.editor.getText(), 'before restore');
            await this.app.replaceAllText(text, `Restored the snapshot from ${when}. The previous text was kept in history.`);
            this.render();
          },
        },
      ],
    });
  }
}
