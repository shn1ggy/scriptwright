// Supporting pane: project notes, scene information and history.

import type { App, SceneItem } from '../app';
import { bridge } from '../bridge';
import { h } from './dom';
import { confirmDialog, toast } from './overlay';
import { SCENE_COLORS, STATUS_LABELS } from './outline';
import { SceneStatus } from '../../shared/types';
import { renderReview } from './review';
import { renderShelf } from './shelf';
import { saveDraft } from './drafts';
import { historyEntries, kindToggles, shownKinds } from './history';

type Tab = 'notes' | 'scene' | 'comments' | 'shelf' | 'history';

export class RightPane {
  el: HTMLElement;
  private body: HTMLElement;
  private tabBtns: Record<Tab, HTMLButtonElement>;
  private tab: Tab = 'notes';
  private sceneFor: string | null = null;

  constructor(private app: App) {
    const mk = (t: Tab, label: string) => h('button', { class: 'tab', tabindex: '-1', onclick: () => this.switchTo(t) }, label);
    this.tabBtns = { notes: mk('notes', 'Notes'), scene: mk('scene', 'Scene'), comments: mk('comments', 'Review'), shelf: mk('shelf', 'Shelf'), history: mk('history', 'History') };
    this.body = h('div', { class: 'rp-body' });
    this.el = h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: '0' } },
      h('div', { class: 'rp-tabs' }, this.tabBtns.notes, this.tabBtns.scene, this.tabBtns.comments, this.tabBtns.shelf, this.tabBtns.history),
      this.body,
    );
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

  private reviewTimer: any = null;

  /** Annotations changed: re-render the Review tab (debounced while typing). */
  annotationsChanged() {
    this.updateBadges();
    if (this.tab !== 'comments' || !this.app.state.layout.rightVisible) return;
    // Only typing in the pane (a reply, an edited comment) holds the re-render back; a click
    // on a button (Delete, Resolve) shows its result at once.
    const ae = document.activeElement as HTMLElement | null;
    if (ae && this.body.contains(ae) && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
    clearTimeout(this.reviewTimer);
    this.reviewTimer = setTimeout(() => this.render(), 150);
  }

  shelfChanged() {
    this.updateBadges();
    if (this.tab === 'shelf') this.render();
  }

  private updateBadges() {
    const m = this.app.project?.meta;
    const open = m ? m.comments.filter((c) => !c.resolved && !c.detached).length : 0;
    const detached = m ? [...m.comments, ...m.highlights, ...m.passages].filter((r) => r.detached).length : 0;
    this.tabBtns.comments.replaceChildren('Review', ...(open || detached ? [h('span', { class: 'tab-count' }, String(open + detached))] : []));
    this.tabBtns.comments.classList.toggle('has-warn', detached > 0);
    this.tabBtns.comments.title = detached ? `${open} open comments, ${detached} detached items` : `${open} open comments`;
  }

  historyChanged() {
    if (this.tab === 'history' && this.app.state.layout.rightVisible) this.render();
  }

  /** Puts the caret in the scene summary (Scene tab). */
  focusSummary() {
    if (this.tab !== 'scene') return;
    this.render();
    const ta = this.body.querySelector<HTMLTextAreaElement>('textarea[aria-label="Scene summary"]');
    ta?.focus();
  }

  onActiveSceneChange() {
    if (this.tab !== 'scene') return;
    const s = this.currentScene();
    if ((s?.id ?? null) !== this.sceneFor) this.render();
  }

  private currentScene(): SceneItem | undefined {
    if (this.app.panel === 'cards') return this.app.cards.currentItem() ?? this.app.activeScene();
    return this.app.view === 'scene' ? this.app.focusedItem() ?? this.app.activeScene() : this.app.activeScene();
  }

  render() {
    this.body.textContent = '';
    this.body.classList.remove('rp-history');
    const p = this.app.project;
    if (!p) {
      this.body.append(h('div', { class: 'notice' }, 'Open a project to see its notes.'));
      return;
    }
    this.updateBadges();
    const rerender = () => {
      const st = this.body.scrollTop;
      this.render();
      this.body.scrollTop = st;
    };
    if (this.tab === 'notes') this.renderNotes();
    else if (this.tab === 'scene') this.renderScene();
    else if (this.tab === 'comments') renderReview(this.app, this.body, rerender);
    else if (this.tab === 'shelf') renderShelf(this.app, this.body, rerender);
    else {
      this.renderHistory();
    }
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
    // Always write to the live record (never a captured copy).
    const live = () => this.app.sceneRecord(item)!;
    const rec = live();
    const summary = h('textarea', { class: 'field', rows: 3, placeholder: 'One or two lines about the scene', 'aria-label': 'Scene summary', style: { minHeight: '60px' } });
    summary.value = rec.summary ?? '';
    summary.addEventListener('input', () => {
      live().summary = summary.value;
      this.app.markMetaDirty();
      this.app.outline.render();
      this.app.cards.render();
    });
    const status = h('select', { class: 'field', 'aria-label': 'Scene status' });
    for (const [k, label] of Object.entries(STATUS_LABELS)) status.append(h('option', { value: k }, label));
    status.value = rec.status ?? '';
    status.addEventListener('change', () => this.app.updateSceneRecord(item, { status: status.value as SceneStatus }));
    const sw = h('div', { class: 'swatches' });
    const drawSwatches = () => {
      sw.textContent = '';
      const cur = live().color;
      sw.append(h('button', { class: !cur ? 'on' : '', title: 'No color', 'aria-label': 'No color', style: { background: 'transparent' }, onclick: () => setColor(undefined) }));
      for (const c of SCENE_COLORS) sw.append(h('button', { class: cur === c.value ? 'on' : '', title: c.name, 'aria-label': c.name, style: { background: c.value }, onclick: () => setColor(c.value) }));
    };
    const setColor = (c: string | undefined) => {
      this.app.updateSceneRecord(item, { color: c });
      drawSwatches();
    };
    drawSwatches();
    const notes = h('textarea', { class: 'field grow', placeholder: 'Notes for this scene', 'aria-label': 'Scene notes' });
    notes.value = rec.notes ?? '';
    notes.addEventListener('input', () => {
      live().notes = notes.value;
      this.app.markMetaDirty();
    });
    this.body.append(
      h('div', { class: 'notice', title: item.heading }, h('strong', null, `${item.number}. `), item.heading),
      h('div', null, h('label', { class: 'cap' }, 'Summary'), summary),
      h('div', { style: { display: 'flex', gap: '10px', alignItems: 'flex-end' } }, h('div', { style: { flex: '1' } }, h('label', { class: 'cap' }, 'Status'), status), h('div', null, h('label', { class: 'cap' }, 'Color'), sw)),
      h('label', { class: 'cap', style: { marginBottom: '-6px' } }, 'Scene notes'),
      notes,
    );
  }

  /** Quick actions and the versions that fit; browsing and comparing happen in the History view. */
  private async renderHistory() {
    const k = this.app.commands.label('view.history');
    const list = h('div', { class: 'hist-recent' });
    const fill = async () => {
      const kinds = shownKinds(this.app);
      const all = (await historyEntries(this.app)).filter((e) => kinds.has(e.kind as 'draft' | 'export' | 'snapshot'));
      list.textContent = '';
      if (!all.length) {
        list.append(h('div', { class: 'notice' }, 'No versions of this kind yet.'));
        return;
      }
      // As many as the pane has room for; the list scrolls for the rest.
      for (const e of all) {
        const when = new Date(e.time).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
        list.append(
          h(
            'button',
            { class: 'history-row hist-mini', title: 'Show in History', onclick: () => this.app.openHistoryAt(e.key) },
            h('span', { class: `hist-kind k-${e.kind}` }),
            h('span', { class: 'label' }, e.kind === 'snapshot' ? 'Snapshot' : e.name),
            h('span', { class: 'dim' }, when),
          ),
        );
      }
    };
    this.body.classList.add('rp-history');
    this.body.append(
      h('div', { class: 'rv-actions' }, h('button', { class: 'btn', onclick: () => void saveDraft(this.app) }, 'Save as Draft…'), h('button', { class: 'btn', onclick: () => this.snapshotNow() }, 'Snapshot Now')),
      h('button', { class: 'btn hist-open', onclick: () => this.app.openHistoryAt() }, k ? `Open History (${k})` : 'Open History'),
      kindToggles(this.app, () => void fill()),
      list,
    );
    await fill();
  }

  private async snapshotNow() {
    const p = this.app.project!;
    await bridge.call('snapshotProject', p.rel, this.app.editor.getText(), 'manual');
    toast('Snapshot saved.');
    this.render();
  }

}
