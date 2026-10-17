// Rewrite: several named versions of one passage, exactly one of them in the screenplay.

import type { App } from '../app';
import { h, uid } from './dom';
import { confirmDialog, openDialog, promptDialog, toast } from './overlay';
import { diffLines } from './compare';
import { PassageRecord } from '../../shared/types';
import { keyIndex } from '../../shared/anchors';
import type { Annotations } from '../annotations';
import { t } from '../../shared/i18n';

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
export function passageText(ann: Annotations, p: PassageRecord, max = 90): string {
  const t = (ann.live.has(p.id) ? ann.textOf(p.id) : p.anchor.quote).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** Short label: the name if there is one, else the current text in quotes. */
export function passageLabel(ann: Annotations, p: PassageRecord, max = 50): string {
  return passageName(p) || `“${passageText(ann, p, max)}”`;
}

/** Gives a passage a name (or removes it with an empty name); undoable. */
export async function namePassage(ann: Annotations, passageId: string) {
  const p = ann.host.store()?.passages.find((x) => x.id === passageId);
  if (!p) return;
  const n = await promptDialog(t("Name passage"), t("Name (optional)"), passageName(p), { okLabel: t("Save") });
  if (n === null || n === undefined) return;
  ann.undoable(() => {
    const q = ann.host.store()?.passages.find((x) => x.id === passageId);
    if (!q) return;
    q.name = n.trim();
    ann.markDirty();
  }, t("Name Passage"));
  ann.host.changed();
}

/** Opens the rewrite tool for the selection (or the passage at the caret). */
export function openRewrite(app: App, ann: Annotations) {
  if (!ann.host.store()) return;
  const sel = ann.selectionAnchor();
  if (!sel) {
    const here = ann.at(ann.editor.sel.head).find((r) => r.kind === 'passage');
    if (here) return openRewriteFor(app, ann, here.rec.id);
    toast(t("Select the passage you want to rewrite."));
    return;
  }
  const idx = keyIndex(ann.editor.lines);
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
    if (over.length === 1 && le(pa, sa) && le(sb, pb)) return openRewriteFor(app, ann, p.rec.id);
    toast(t("The selection overlaps the passage {0}. Select it exactly, or text outside it.", passageLabel(ann, p.rec as PassageRecord)), {
      warn: true,
      actions: [{ label: t("Open that passage"), run: () => openRewriteFor(app, ann, p.rec.id) }],
    });
    return;
  }
  // Passages have no name unless the writer gives one; lists show their current text.
  const rec = ann.addPassage(sel, '');
  openRewriteFor(app, ann, rec.id, true);
}

export function openRewriteFor(app: App, ann: Annotations, passageId: string, isNew = false) {
  const find = () => ann.host.store()?.passages.find((p) => p.id === passageId);
  const inDoc = ann.scope === 'document';
  let p = find();
  if (!p) return;
  let selected = isNew ? '' : p.activeId;
  const list = h('div', { class: 'rw-list', role: 'listbox' });
  const editor = h('textarea', { class: 'field rw-text', spellcheck: 'true', 'aria-label': t("Version text") });
  // Versions read like the text they belong to: that editor's font, size and line height.
  const cs = getComputedStyle(ann.editor.dom);
  editor.style.fontFamily = cs.getPropertyValue('--ed-font').trim() || cs.fontFamily;
  editor.style.fontSize = cs.getPropertyValue('--ed-size').trim() || cs.fontSize;
  editor.style.lineHeight = cs.getPropertyValue('--ed-lh').trim() || cs.lineHeight;
  const info = h('div', { class: 'notice' });
  const buttons = h('div', { class: 'rw-buttons' });

  const activeText = () => ann.textOf(passageId);

  // A new passage starts with a second version to write in.
  if (isNew) {
    const alt = { id: uid(), name: t('Version {0}', 2), text: activeText(), created: new Date().toISOString() };
    p.alternatives.push(alt);
    selected = alt.id;
    ann.markDirty();
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
        isActive ? h('span', { class: 'chip chip-same' }, inDoc ? t("in document") : t("in script")) : null,
      );
      row.addEventListener('click', () => {
        selected = a.id;
        render();
      });
      row.addEventListener('dblclick', async () => {
        const n = await promptDialog(t("Rename version"), t("Name"), a.name, { okLabel: t("Rename") });
        if (n) {
          ann.undoable(() => {
            a.name = n;
            ann.markDirty();
          }, t("Rename Version"));
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
      ? inDoc
        ? t("This passage is detached ({0}). Versions are kept; select text in the document and use “Attach to selection” in the Review pane to use them again.", p.detached)
        : t("This passage is detached ({0}). Versions are kept; select text in the screenplay and use “Attach to selection” in the Review pane to use them again.", p.detached)
      : isActive
        ? inDoc
          ? t("This version is in the document. Edit it there, or select another version to edit it here.")
          : t("This version is in the screenplay. Edit it there, or select another version to edit it here.")
        : inDoc
          ? t("Edits here are saved immediately. “Use this version” swaps it into the document; the current text is kept as its own version.")
          : t("Edits here are saved immediately. “Use this version” swaps it into the screenplay; the current text is kept as its own version.");
    buttons.textContent = '';
    buttons.append(
      h('button', { class: 'btn', onclick: () => newVersion(a.id) }, t("New version from this")),
      h('button', { class: 'btn', disabled: isActive || detached, onclick: () => compare(a.id) }, inDoc ? t("Compare with document") : t("Compare with script")),
      h('button', {
        class: 'btn',
        onclick: async () => {
          const n = await promptDialog(t("Rename version"), t("Name"), a.name, { okLabel: t("Rename") });
          if (n) {
            ann.undoable(() => {
              a.name = n;
              ann.markDirty();
            }, t("Rename Version"));
            render();
          }
        },
      }, t("Rename")),
      h('button', { class: 'btn danger', disabled: isActive || p.alternatives.length < 2, onclick: () => deleteVersion(a.id) }, t("Delete")),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary', disabled: isActive || detached || !a.text, onclick: () => activate(a.id) }, t("Use this version")),
    );
  };

  editor.addEventListener('input', () => {
    const q = find();
    const a = q?.alternatives.find((x) => x.id === selected);
    if (!q || !a || (a.id === q.activeId && !q.detached)) return;
    a.text = editor.value;
    ann.markDirty();
  });

  const newVersion = (fromId: string) => {
    const q = find()!;
    const src = q.alternatives.find((x) => x.id === fromId)!;
    const text = src.id === q.activeId && !q.detached ? activeText() : src.text;
    const alt = { id: uid(), name: t('Version {0}', q.alternatives.length + 1), text, created: new Date().toISOString() };
    ann.undoable(() => {
      q.alternatives.push(alt);
      ann.markDirty();
    }, t("New Version"));
    selected = alt.id;
    render();
    editor.focus();
  };

  const deleteVersion = async (id: string) => {
    const q = find()!;
    const a = q.alternatives.find((x) => x.id === id)!;
    if (!(await confirmDialog(t("Delete version"), t("Delete the version “{0}”?", a.name), t("Delete"), { danger: true }))) return;
    ann.undoable(() => {
      q.alternatives = q.alternatives.filter((x) => x.id !== id);
      ann.markDirty();
    }, t("Delete Version"));
    selected = find()?.activeId ?? '';
    render();
  };

  const compare = (id: string) => {
    const q = find()!;
    const a = q.alternatives.find((x) => x.id === id)!;
    const out = h('div', { class: 'diff preview-text' });
    for (const op of diffLines(activeText().split('\n'), a.text.split('\n'))) out.append(h('div', { class: op.kind === 'same' ? '' : op.kind }, (op.kind === 'add' ? '+ ' : op.kind === 'del' ? '− ' : '  ') + (op.text || ' ')));
    openDialog({ title: inDoc ? t("Document ↔ “{0}”", a.name) : t("Script ↔ “{0}”", a.name), width: 680, body: [h('p', null, inDoc ? t("− lines are only in the document, + lines only in this version.") : t("− lines are only in the screenplay, + lines only in this version.")), out], buttons: [{ label: t("Close"), primary: true }] });
  };

  const activate = (id: string) => {
    if (ann.activate(passageId, id)) {
      render();
      toast(inDoc ? t("Version swapped into the document.") : t("Version swapped into the screenplay."), { actions: [{ label: t("Undo"), run: () => (inDoc ? ann.editor.undo() : app.run('edit.undo')) }] });
    }
  };

  const dlg = openDialog({
    title: t("Rewrite"),
    cls: 'rewrite-dialog',
    body: [
      h('div', { class: 'rw-split' }, list, h('div', { class: 'rw-main' }, editor, info)),
      buttons,
    ],
    buttons: [
      {
        label: t("Remove passage record"),
        danger: true,
        run: async () => {
          const ok = await confirmDialog(t("Remove passage record"), inDoc ? t("Keep the text that is in the document and delete the other versions?") : t("Keep the text that is in the screenplay and delete the other versions?"), t("Remove"), { danger: true });
          if (!ok) return false;
          ann.removeRecord(passageId);
        },
      },
      { label: t("Close"), primary: true },
    ],
    initialFocus: editor,
    onClose: () => ann.host.changed(),
  });
  render();
}
