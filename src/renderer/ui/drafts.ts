// Named drafts and version comparison (complete screenplay or scene by scene).

import type { App } from '../app';
import { bridge } from '../bridge';
import { h, uid } from './dom';
import { confirmDialog, openDialog, promptDialog, toast } from './overlay';
import { diffLines } from './compare';
import { DraftInfo } from '../../shared/types';
import { compareScenes, scenesOf, ROW_LABELS, CompareRow, CompareScene } from '../../shared/scenecompare';
import { countWords } from '../../shared/fountain';

export async function saveDraft(app: App, name?: string): Promise<DraftInfo | null> {
  const p = app.project;
  if (!p) return null;
  const n = name ?? (await promptDialog('Save named draft', 'Name', '', { okLabel: 'Save draft', placeholder: 'e.g. Before feedback' }));
  if (!n) return null;
  const text = app.editor.getText();
  const info: DraftInfo = {
    id: uid(),
    name: n,
    created: new Date().toISOString(),
    words: countWords(text),
    sceneIds: app.scenes.filter((s) => s.kind === 'scene').map((s) => s.id),
  };
  await bridge.call('saveDraft', p.rel, info.id, text);
  p.meta.drafts.unshift(info);
  app.markMetaDirty();
  await app.saveMetaNow();
  app.rightPane.historyChanged();
  if (!name) toast(`Draft “${n}” saved.`);
  return info;
}

/** Restores a version after saving the current writing as a draft. Undoable. */
export async function restoreVersion(app: App, text: string, label: string, sceneIds?: string[]) {
  const before = await saveDraft(app, `Before restoring “${label}”`);
  if (!before) return;
  await app.replaceAllText(text, `Restored “${label}”. Your previous text was saved as the draft “${before.name}”.`, 'command', sceneIds);
  app.rightPane.historyChanged();
}

export function renderDrafts(app: App, body: HTMLElement, rerender: () => void) {
  const p = app.project!;
  body.append(
    h('div', { class: 'rv-head' }, h('span', null, `Named drafts (${p.meta.drafts.length})`), h('span', { class: 'spacer' }), h('button', { class: 'btn sm', onclick: () => saveDraft(app) }, 'Save draft…')),
  );
  if (!p.meta.drafts.length) body.append(h('div', { class: 'notice' }, 'Named drafts keep a complete version of the screenplay until you delete them.'));
  for (const d of p.meta.drafts) {
    body.append(
      h(
        'div',
        { class: 'rv-item' },
        h('div', { class: 'rv-label' }, d.name),
        h('div', { class: 'rv-meta' }, `${new Date(d.created).toLocaleString()} · ${d.words.toLocaleString()} words`),
        h(
          'div',
          { class: 'rv-actions' },
          h('button', { class: 'btn sm', onclick: () => openDraft(app, d) }, 'Preview & compare…'),
          h('button', {
            class: 'btn sm',
            onclick: async () => {
              const n = await promptDialog('Rename draft', 'Name', d.name, { okLabel: 'Rename' });
              if (!n) return;
              d.name = n;
              app.markMetaDirty();
              rerender();
            },
          }, 'Rename'),
          h('button', {
            class: 'btn sm',
            onclick: async () => {
              if (!(await confirmDialog('Delete draft', `Delete the draft “${d.name}” permanently?`, 'Delete', { danger: true }))) return;
              await bridge.call('deleteDraft', p.rel, d.id);
              p.meta.drafts = p.meta.drafts.filter((x) => x.id !== d.id);
              app.markMetaDirty();
              rerender();
            },
          }, 'Delete'),
        ),
      ),
    );
  }
}

async function openDraft(app: App, d: DraftInfo) {
  const p = app.project!;
  let text: string;
  try {
    text = await bridge.call('readDraft', p.rel, d.id);
  } catch (e: any) {
    toast(`The draft file could not be read: ${e.message}`, { warn: true });
    return;
  }
  openComparison(app, { title: `Draft “${d.name}”`, text, sceneIds: d.sceneIds, label: d.name });
}

/**
 * Preview of an older version with comparison against the current screenplay. Scenes are
 * matched independently of their order; moves are shown separately from changes.
 */
export function openComparison(app: App, v: { title: string; text: string; sceneIds?: string[]; label: string }) {
  const extra = app.settings.editor.extraPrefixes;
  const cur = app.editor.getText();
  const curIds = app.scenes.filter((s) => s.kind === 'scene').map((s) => s.id);
  const oldS = scenesOf(v.text, v.sceneIds, extra);
  const newS = scenesOf(cur, curIds, extra);
  const rows = compareScenes(oldS, newS);
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
  const ambiguous = rows.filter((r) => r.ambiguous).length;

  const list = h('div', { class: 'cmp-list', role: 'listbox', tabindex: '0' });
  const detail = h('div', { class: 'cmp-detail diff preview-text' });
  const tabs = h('div', { class: 'cmp-tabs' });
  let mode: 'scenes' | 'full' | 'preview' = 'scenes';
  let sel = rows.findIndex((r) => r.kind !== 'same');
  if (sel < 0) sel = 0;
  const showOnlyChanges = h('input', { type: 'checkbox', checked: true });

  const sceneLabel = (s: CompareScene | undefined, i: number | undefined) => (s && i !== undefined ? `${i + 1}. ${s.heading}` : '');
  const renderList = () => {
    list.textContent = '';
    rows.forEach((r, k) => {
      if (showOnlyChanges.checked && r.kind === 'same') return;
      const o = r.oldIndex !== undefined ? oldS[r.oldIndex] : undefined;
      const n = r.newIndex !== undefined ? newS[r.newIndex] : undefined;
      const row = h(
        'div',
        { class: `row cmp-row${k === sel ? ' selected' : ''}`, role: 'option' },
        h('span', { class: `chip chip-${r.kind}` }, ROW_LABELS[r.kind] + (r.ambiguous ? '?' : '')),
        h('span', { class: 'label' }, (n ?? o)!.heading),
        h('span', { class: 'meta' }, r.oldIndex !== undefined && r.newIndex !== undefined ? (r.oldIndex !== r.newIndex ? `${r.oldIndex + 1} → ${r.newIndex + 1}` : `${r.newIndex + 1}`) : r.newIndex !== undefined ? `new ${r.newIndex + 1}` : `was ${r.oldIndex! + 1}`),
      );
      row.title = [sceneLabel(o, r.oldIndex) && `Draft: ${sceneLabel(o, r.oldIndex)}`, sceneLabel(n, r.newIndex) && `Now: ${sceneLabel(n, r.newIndex)}`, r.ambiguous ? 'The match could not be established with certainty.' : ''].filter(Boolean).join('\n');
      row.addEventListener('click', () => {
        sel = k;
        renderList();
        renderDetail();
      });
      list.append(row);
    });
    if (!list.childElementCount) list.append(h('div', { class: 'notice', style: { padding: '8px' } }, 'No scene differs.'));
  };
  const renderDiff = (a: string[], b: string[]) => {
    detail.textContent = '';
    const ops = diffLines(a, b);
    for (const op of ops) detail.append(h('div', { class: op.kind === 'same' ? '' : op.kind }, (op.kind === 'add' ? '+ ' : op.kind === 'del' ? '− ' : '  ') + (op.text || ' ')));
  };
  const renderDetail = () => {
    if (mode === 'full') return renderDiff(v.text.split('\n'), cur.split('\n'));
    if (mode === 'preview') {
      detail.textContent = v.text;
      return;
    }
    const r: CompareRow | undefined = rows[sel];
    if (!r) {
      detail.textContent = '';
      return;
    }
    const a = r.oldIndex !== undefined ? oldS[r.oldIndex].lines : [];
    const b = r.newIndex !== undefined ? newS[r.newIndex].lines : [];
    renderDiff(a, b);
    if (r.kind === 'moved') detail.prepend(h('div', { class: 'notice' }, `Moved from position ${r.oldIndex! + 1} to ${r.newIndex! + 1}. The text is unchanged.`));
    if (r.ambiguous) detail.prepend(h('div', { class: 'notice warn' }, 'This scene could not be matched with certainty (several scenes look alike).'));
  };
  const tabBtn = (m: typeof mode, label: string) => {
    const b = h('button', { class: `tab${mode === m ? ' on' : ''}`, onclick: () => setMode(m) }, label);
    return b;
  };
  const setMode = (m: typeof mode) => {
    mode = m;
    tabs.replaceChildren(tabBtn('scenes', 'Scenes'), tabBtn('full', 'Full text'), tabBtn('preview', 'Preview'));
    list.classList.toggle('hidden', m !== 'scenes');
    filter.classList.toggle('hidden', m !== 'scenes');
    renderDetail();
  };
  const filter = h('label', { class: 'rv-toggle' }, showOnlyChanges, 'Only differences');
  showOnlyChanges.addEventListener('change', renderList);
  const summary = h(
    'div',
    { class: 'notice' },
    `Compared with the current screenplay: ${counts.changed ?? 0} changed, ${(counts.moved ?? 0) + (counts.movedChanged ?? 0)} moved${counts.movedChanged ? ` (${counts.movedChanged} also changed)` : ''}, ${counts.added ?? 0} added, ${counts.removed ?? 0} removed, ${counts.same ?? 0} unchanged.` +
      (ambiguous ? ` ${ambiguous} could not be matched with certainty.` : ''),
  );
  renderList();
  setMode('scenes');
  openDialog({
    title: v.title,
    cls: 'compare-dialog',
    body: [summary, h('div', { class: 'cmp-bar' }, tabs, h('span', { class: 'spacer' }), filter), h('div', { class: 'cmp-split' }, list, detail)],
    buttons: [
      { label: 'Close' },
      {
        label: 'Restore this version…',
        primary: true,
        run: async () => {
          const ok = await confirmDialog('Restore version', `Replace the screenplay with “${v.label}”? Your current text is saved as a named draft first, and you can undo the restore.`, 'Restore');
          if (!ok) return false;
          await restoreVersion(app, v.text, v.label, v.sceneIds);
        },
      },
    ],
  });
}
