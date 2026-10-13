// Cut-material shelf: passages kept outside the screenplay until explicitly deleted.

import type { App } from '../app';
import { bridge } from '../bridge';
import { h, uid } from './dom';
import { confirmDialog, toast } from './overlay';
import { ShelfItem } from '../../shared/types';
import { selFrom, selTo, selEmpty, cursor, posAfterInsert } from '../../shared/doc';

/** Saves the selection to the shelf; with `cut` it is also removed from the screenplay. */
export function toShelf(app: App, cut: boolean) {
  const ed = app.editor;
  if (selEmpty(ed.sel)) {
    toast('Select the text to put on the shelf.');
    return;
  }
  const text = ed.selectedText();
  const scene = app.sceneAt(selFrom(ed.sel).line);
  const item: ShelfItem = {
    id: uid(),
    text,
    created: new Date().toISOString(),
    kind: cut ? 'cut' : 'copy',
    sceneId: scene?.kind === 'scene' ? scene.id : undefined,
    sceneHeading: scene?.kind === 'scene' ? scene.heading : scene?.heading,
  };
  app.project!.meta.shelf.unshift(item);
  app.markMetaDirty();
  if (cut) ed.insertText('', 'other');
  app.rightPane.shelfChanged();
  toast(cut ? 'Moved to the shelf.' : 'Copied to the shelf.', {
    actions: [{ label: 'Show shelf', run: () => app.showRightTab('shelf') }],
  });
}

/** Inserts a shelf item at the caret. A selection is never replaced: the text goes after it. */
export function insertFromShelf(app: App, item: ShelfItem) {
  const ed = app.editor;
  const at = selEmpty(ed.sel) ? ed.sel.head : selTo(ed.sel);
  ed.replaceRange(at, at, item.text, 'other', 'command', { anchor: at, head: posAfterInsert(at, item.text) });
  ed.history.seal();
  ed.focus();
  toast('Inserted from the shelf. The shelf keeps its copy.', { actions: [{ label: 'Undo', run: () => app.run('edit.undo') }] });
  void cursor;
}

export function renderShelf(app: App, body: HTMLElement, rerender: () => void) {
  const items = app.project!.meta.shelf;
  body.append(
    h(
      'div',
      { class: 'notice' },
      `Cut material stays here until you delete it. Cut to shelf: ${app.commands.label('shelf.cut') || 'context menu'} · copy: ${app.commands.label('shelf.copy') || 'context menu'}.`,
    ),
  );
  if (!items.length) {
    body.append(h('div', { class: 'notice' }, 'The shelf is empty.'));
    return;
  }
  for (const it of items) {
    const note = h('input', { class: 'field sm', placeholder: 'Note', value: it.note ?? '', 'aria-label': 'Note' });
    note.addEventListener('change', () => {
      it.note = note.value.trim() || undefined;
      app.markMetaDirty();
    });
    body.append(
      h(
        'div',
        { class: 'rv-item' },
        h('div', { class: 'rv-meta' }, `${it.kind === 'cut' ? 'Cut' : 'Copied'} ${new Date(it.created).toLocaleString()}${it.sceneHeading ? ' · ' + it.sceneHeading : ''}`),
        h('div', { class: 'shelf-text' }, it.text),
        note,
        h(
          'div',
          { class: 'rv-actions' },
          h('button', { class: 'btn sm', title: 'Insert at the caret (never replaces a selection)', onclick: () => insertFromShelf(app, it) }, 'Insert at caret'),
          h('button', {
            class: 'btn sm',
            onclick: async () => {
              await bridge.clipboard.writeText(it.text);
              toast('Copied to the clipboard.');
            },
          }, 'Copy'),
          h('button', {
            class: 'btn sm',
            onclick: async () => {
              if (!(await confirmDialog('Delete from shelf', 'Delete this material from the shelf permanently?', 'Delete', { danger: true }))) return;
              app.project!.meta.shelf = app.project!.meta.shelf.filter((x) => x.id !== it.id);
              app.markMetaDirty();
              rerender();
            },
          }, 'Delete'),
        ),
      ),
    );
  }
}
