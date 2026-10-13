// Cut-material shelf: passages kept outside the screenplay until explicitly deleted.

import type { App } from '../app';
import { bridge } from '../bridge';
import { h, uid } from './dom';
import { confirmDialog, toast } from './overlay';
import { ShelfItem } from '../../shared/types';
import { selFrom, selTo, selEmpty, posAfterInsert, Pos } from '../../shared/doc';
import { makeOrigin, locateOrigin, OriginMatch } from '../../shared/shelf';

function offsetOf(app: App, p: Pos): number {
  const L = app.editor.lines;
  let n = 0;
  for (let i = 0; i < p.line; i++) n += L[i].text.length + 1;
  return n + p.ch;
}

function posAt(app: App, offset: number): Pos {
  const L = app.editor.lines;
  let n = offset;
  for (let i = 0; i < L.length; i++) {
    if (n <= L[i].text.length) return { line: i, ch: n };
    n -= L[i].text.length + 1;
  }
  const last = L.length - 1;
  return { line: last, ch: L[last].text.length };
}

/** Where a shelf item came from in the current text, if that place can still be found. */
function findOrigin(app: App, it: ShelfItem): OriginMatch | null {
  if (!it.origin) return null;
  return locateOrigin(app.editor.getText(), it.origin, it.kind === 'cut' ? '' : it.text);
}

/** Saves the selection to the shelf; with `cut` it is also removed from the screenplay. */
export function toShelf(app: App, cut: boolean) {
  const ed = app.editor;
  if (selEmpty(ed.sel)) {
    toast('Select the text to put on the shelf.');
    return;
  }
  const text = ed.selectedText();
  const scene = app.sceneAt(selFrom(ed.sel).line);
  const from = offsetOf(app, selFrom(ed.sel));
  const origin = makeOrigin(ed.getText(), from, from + text.length);
  const item: ShelfItem = {
    id: uid(),
    text,
    created: new Date().toISOString(),
    kind: cut ? 'cut' : 'copy',
    sceneId: scene?.kind === 'scene' ? scene.id : undefined,
    sceneHeading: scene?.kind === 'scene' ? scene.heading : scene?.heading,
    origin,
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
}

/** Puts cut material back where it was cut from. */
export function putBack(app: App, item: ShelfItem, rerender: () => void) {
  const m = findOrigin(app, item);
  if (!m) {
    toast('The text around its original place has changed, so the place cannot be found. Use Insert at caret instead.', { warn: true });
    return;
  }
  const at = posAt(app, m.from);
  const ed = app.editor;
  ed.replaceRange(at, at, item.text, 'other', 'command', { anchor: at, head: posAfterInsert(at, item.text) });
  ed.history.seal();
  // It is back in the screenplay, so it leaves the shelf (Undo brings both back).
  app.undoable(() => {
    app.project!.meta.shelf = app.project!.meta.shelf.filter((x) => x.id !== item.id);
    app.markMetaDirty();
  }, 'Put Back');
  rerender();
  app.revealRange(at, posAfterInsert(at, item.text));
  toast(m.quality === 'exact' ? 'Put back where it was cut.' : 'Put back next to the text it followed (the other side has changed).', {
    actions: [
      {
        label: 'Undo',
        run: () => {
          app.run('edit.undo');
          app.run('edit.undo');
          rerender();
        },
      },
    ],
  });
}

/** Scrolls to where the item came from (the gap for cut material, the text for copied material). */
export function revealOrigin(app: App, item: ShelfItem) {
  const m = findOrigin(app, item);
  if (!m) {
    if (item.sceneId) {
      const sc = app.scenes.find((x) => x.id === item.sceneId);
      if (sc) {
        app.revealRange({ line: sc.line, ch: 0 }, { line: sc.line, ch: 0 }, false);
        toast('The exact place has changed; showing the scene it came from.');
        return;
      }
    }
    toast(item.origin ? 'The text around its original place has changed, so the place cannot be found.' : 'This item was shelved before places were recorded.');
    return;
  }
  app.revealRange(posAt(app, m.from), posAt(app, m.to), false);
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
        h('button', { class: 'shelf-text', title: 'Show where this came from', onclick: () => revealOrigin(app, it) }, it.text),
        note,
        h(
          'div',
          { class: 'rv-actions' },
          it.kind === 'cut' && it.origin
            ? (() => {
                const m = findOrigin(app, it);
                return h('button', {
                  class: 'btn sm',
                  disabled: !m,
                  title: m ? (m.quality === 'exact' ? 'Insert it again where it was cut' : 'One side of the original place has changed; it goes next to the unchanged side') : 'The text around its original place has changed',
                  onclick: () => putBack(app, it, rerender),
                }, 'Put back');
              })()
            : null,
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
              if (!(await confirmDialog('Delete from shelf', 'Delete this material from the shelf? Undo brings it back.', 'Delete', { danger: true }))) return;
              app.undoable(() => {
                app.project!.meta.shelf = app.project!.meta.shelf.filter((x) => x.id !== it.id);
                app.markMetaDirty();
              }, 'Delete from Shelf');
              rerender();
            },
          }, 'Delete'),
        ),
      ),
    );
  }
}
