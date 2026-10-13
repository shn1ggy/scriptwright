// Rewrite: several named versions of one passage, exactly one of them in the screenplay.

import type { App } from '../app';
import { h, uid } from './dom';
import { confirmDialog, openDialog, promptDialog, toast } from './overlay';
import { diffLines } from './compare';
import { PassageRecord } from '../../shared/types';
import { keyIndex } from '../../shared/anchors';

/**
 * The name a writer gave a passage, or '' when it has none. Names made automatically by
 * earlier versions (the first words in quotes, or "Passage") count as no name.
 */
export function passageName(p: PassageRecord): string {
  const n = (p.name ?? '').trim();
  if (!n || n === 'Passage' || /^“.*”$/s.test(n)) return '';
  return n;
}

/** Text of a passage as it is in the screenplay now (the last known text when detached). */
export function passageText(app: App, p: PassageRecord, max = 90): string {
  const t = (app.annotations.live.has(p.id) ? app.annotations.textOf(p.id) : p.anchor.quote).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** Short label: the name if there is one, else the current text in quotes. */
export function passageLabel(app: App, p: PassageRecord, max = 50): string {
  return passageName(p) || `“${passageText(app, p, max)}”`;
}

/** Gives a passage a name (or removes it with an empty name); undoable. */
export async function namePassage(app: App, passageId: string) {
  const p = app.project?.meta.passages.find((x) => x.id === passageId);
  if (!p) return;
  const n = await promptDialog('Name passage', 'Name (optional)', passageName(p), { okLabel: 'Save' });
  if (n === null || n === undefined) return;
  app.undoable(() => {
    const q = app.project!.meta.passages.find((x) => x.id === passageId);
    if (!q) return;
    q.name = n.trim();
    app.markMetaDirty();
  }, 'Name Passage');
  app.rightPane.annotationsChanged();
}

/** Opens the rewrite tool for the selection (or the passage at the caret). */
export function openRewrite(app: App) {
  const ann = app.annotations;
  const sel = ann.selectionAnchor();
  if (!sel) {
    const here = ann.at(app.editor.sel.head).find((r) => r.kind === 'passage');
    if (here) return openRewriteFor(app, here.rec.id);
    toast('Select the passage you want to rewrite.');
    return;
  }
  const idx = keyIndex(app.editor.lines);
  const over = ann.overlapping(sel, 'passage');
  if (over.length) {
    // Reuse the record when the selection lies within (or equals) an existing passage.
    const p = over[0];
    const an = ann.live.get(p.rec.id)!;
    const pa = [idx.get(an.a.key)!, an.a.ch];
    const pb = [idx.get(an.b.key)!, an.b.ch];
    const sa = [idx.get(sel.a.key)!, sel.a.ch];
    const sb = [idx.get(sel.b.key)!, sel.b.ch];
    const le = (x: number[], y: number[]) => x[0] < y[0] || (x[0] === y[0] && x[1] <= y[1]);
    if (over.length === 1 && le(pa, sa) && le(sb, pb)) return openRewriteFor(app, p.rec.id);
    toast(`The selection overlaps the passage ${passageLabel(app, p.rec as PassageRecord)}. Select it exactly, or text outside it.`, {
      warn: true,
      actions: [{ label: 'Open that passage', run: () => openRewriteFor(app, p.rec.id) }],
    });
    return;
  }
  // Passages have no name unless the writer gives one; lists show their current text.
  const rec = ann.addPassage(sel, '');
  openRewriteFor(app, rec.id, true);
}

export function openRewriteFor(app: App, passageId: string, isNew = false) {
  const ann = app.annotations;
  const find = () => app.project!.meta.passages.find((p) => p.id === passageId);
  let p = find();
  if (!p) return;
  let selected = isNew ? '' : p.activeId;
  const list = h('div', { class: 'rw-list', role: 'listbox' });
  const editor = h('textarea', { class: 'field rw-text', spellcheck: 'true', 'aria-label': 'Version text' });
  // Versions read like the screenplay: the editor's font, size and line height.
  const es = app.settings.editor;
  editor.style.fontFamily = `'${es.fontFamily}', 'Courier Prime', 'Courier New', monospace`;
  editor.style.fontSize = `${es.fontSize}px`;
  editor.style.lineHeight = `${es.lineHeight}px`;
  const info = h('div', { class: 'notice' });
  const buttons = h('div', { class: 'rw-buttons' });

  const activeText = () => ann.textOf(passageId);

  // A new passage starts with a second version to write in.
  if (isNew) {
    const alt = { id: uid(), name: 'Version 2', text: activeText(), created: new Date().toISOString() };
    p.alternatives.push(alt);
    selected = alt.id;
    app.markMetaDirty();
  }

  const render = () => {
    p = find();
    if (!p) {
      dlg.close();
      return;
    }
    list.textContent = '';
    for (const a of p.alternatives) {
      const isActive = a.id === p.activeId;
      const row = h(
        'div',
        { class: `row${a.id === selected ? ' selected' : ''}`, role: 'option' },
        h('span', { class: 'label' }, a.name),
        isActive ? h('span', { class: 'chip chip-same' }, 'in script') : null,
      );
      row.addEventListener('click', () => {
        selected = a.id;
        render();
      });
      row.addEventListener('dblclick', async () => {
        const n = await promptDialog('Rename version', 'Name', a.name, { okLabel: 'Rename' });
        if (n) {
          app.undoable(() => {
            a.name = n;
            app.markMetaDirty();
          }, 'Rename Version');
          render();
        }
      });
      list.append(row);
    }
    const a = p.alternatives.find((x) => x.id === selected) ?? p.alternatives[0];
    selected = a.id;
    const isActive = a.id === p.activeId;
    const detached = !!p.detached;
    editor.value = isActive && !detached ? activeText() : a.text;
    editor.readOnly = isActive && !detached;
    info.textContent = detached
      ? `This passage is detached (${p.detached}). Versions are kept; select text in the screenplay and use “Attach to selection” in the Review pane to use them again.`
      : isActive
        ? 'This version is in the screenplay. Edit it there, or select another version to edit it here.'
        : 'Edits here are saved immediately. “Use this version” swaps it into the screenplay; the current text is kept as its own version.';
    buttons.textContent = '';
    buttons.append(
      h('button', { class: 'btn', onclick: () => newVersion(a.id) }, 'New version from this'),
      h('button', { class: 'btn', disabled: isActive || detached, onclick: () => compare(a.id) }, 'Compare with script'),
      h('button', {
        class: 'btn',
        onclick: async () => {
          const n = await promptDialog('Rename version', 'Name', a.name, { okLabel: 'Rename' });
          if (n) {
            app.undoable(() => {
              a.name = n;
              app.markMetaDirty();
            }, 'Rename Version');
            render();
          }
        },
      }, 'Rename'),
      h('button', { class: 'btn danger', disabled: isActive || p.alternatives.length < 2, onclick: () => deleteVersion(a.id) }, 'Delete'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary', disabled: isActive || detached || !a.text, onclick: () => activate(a.id) }, 'Use this version'),
    );
  };

  editor.addEventListener('input', () => {
    const q = find();
    const a = q?.alternatives.find((x) => x.id === selected);
    if (!q || !a || (a.id === q.activeId && !q.detached)) return;
    a.text = editor.value;
    app.markMetaDirty();
  });

  const newVersion = (fromId: string) => {
    const q = find()!;
    const src = q.alternatives.find((x) => x.id === fromId)!;
    const text = src.id === q.activeId && !q.detached ? activeText() : src.text;
    const alt = { id: uid(), name: `Version ${q.alternatives.length + 1}`, text, created: new Date().toISOString() };
    app.undoable(() => {
      q.alternatives.push(alt);
      app.markMetaDirty();
    }, 'New Version');
    selected = alt.id;
    render();
    editor.focus();
  };

  const deleteVersion = async (id: string) => {
    const q = find()!;
    const a = q.alternatives.find((x) => x.id === id)!;
    if (!(await confirmDialog('Delete version', `Delete the version “${a.name}”?`, 'Delete', { danger: true }))) return;
    app.undoable(() => {
      q.alternatives = q.alternatives.filter((x) => x.id !== id);
      app.markMetaDirty();
    }, 'Delete Version');
    selected = find()?.activeId ?? '';
    render();
  };

  const compare = (id: string) => {
    const q = find()!;
    const a = q.alternatives.find((x) => x.id === id)!;
    const out = h('div', { class: 'diff preview-text' });
    for (const op of diffLines(activeText().split('\n'), a.text.split('\n'))) out.append(h('div', { class: op.kind === 'same' ? '' : op.kind }, (op.kind === 'add' ? '+ ' : op.kind === 'del' ? '− ' : '  ') + (op.text || ' ')));
    openDialog({ title: `Script ↔ “${a.name}”`, width: 680, body: [h('p', null, '− lines are only in the screenplay, + lines only in this version.'), out], buttons: [{ label: 'Close', primary: true }] });
  };

  const activate = (id: string) => {
    if (ann.activate(passageId, id)) {
      render();
      toast('Version swapped into the screenplay.', { actions: [{ label: 'Undo', run: () => app.run('edit.undo') }] });
    }
  };

  const dlg = openDialog({
    title: 'Rewrite',
    cls: 'rewrite-dialog',
    body: [
      h('div', { class: 'rw-split' }, list, h('div', { class: 'rw-main' }, editor, info)),
      buttons,
    ],
    buttons: [
      {
        label: 'Remove passage record',
        danger: true,
        run: async () => {
          const ok = await confirmDialog('Remove passage record', 'Keep the text that is in the screenplay and delete the other versions?', 'Remove', { danger: true });
          if (!ok) return false;
          ann.removeRecord(passageId);
        },
      },
      { label: 'Close', primary: true },
    ],
    initialFocus: editor,
    onClose: () => app.rightPane.annotationsChanged(),
  });
  render();
}
