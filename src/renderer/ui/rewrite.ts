// Rewrite: several named versions of one passage, exactly one of them in the screenplay.

import type { App } from '../app';
import { h, uid } from './dom';
import { confirmDialog, openDialog, promptDialog, toast } from './overlay';
import { diffLines } from './compare';
import { PassageRecord } from '../../shared/types';
import { keyIndex } from '../../shared/anchors';

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
    toast(`The selection overlaps the passage “${(p.rec as PassageRecord).name}”. Select it exactly, or text outside it.`, {
      warn: true,
      actions: [{ label: 'Open that passage', run: () => openRewriteFor(app, p.rec.id) }],
    });
    return;
  }
  const text = app.editor.selectedText();
  const words = text.replace(/\s+/g, ' ').trim().split(' ').slice(0, 5).join(' ');
  const rec = ann.addPassage(sel, words.length > 2 ? `“${words}${text.length > words.length + 2 ? '…' : ''}”` : 'Passage');
  openRewriteFor(app, rec.id, true);
}

export function openRewriteFor(app: App, passageId: string, isNew = false) {
  const ann = app.annotations;
  const find = () => app.project!.meta.passages.find((p) => p.id === passageId);
  let p = find();
  if (!p) return;
  let selected = isNew ? '' : p.activeId;
  const nameIn = h('input', { class: 'field', value: p.name, 'aria-label': 'Passage name' });
  nameIn.addEventListener('change', () => {
    const q = find();
    if (q && nameIn.value.trim()) {
      q.name = nameIn.value.trim();
      app.markMetaDirty();
      app.rightPane.annotationsChanged();
    }
  });
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
      h('div', { class: 'form-row' }, h('label', null, 'Passage'), nameIn),
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
