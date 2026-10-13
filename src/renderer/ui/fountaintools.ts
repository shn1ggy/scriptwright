// Written scene numbers (#12#) in the Fountain text, and Fountain export for other apps.

import type { App } from '../app';
import { bridge } from '../bridge';
import { h } from './dom';
import { alertDialog, openDialog, toast } from './overlay';
import { NumberMode, exportFountain, sceneNumberEdits } from '../../shared/fountainout';
import { exportFdx } from '../../shared/fdx';
import { sceneNumberList } from '../../shared/scenenumbers';
import { projectExportSettings } from './export';

export function openSceneNumbers(app: App) {
  const sel = h(
    'select',
    { class: 'field', 'aria-label': 'Action' },
    h('option', { value: 'remove' }, 'Remove all written numbers'),
    h('option', { value: 'addMissing' }, 'Add numbers where missing'),
    h('option', { value: 'renumber' }, 'Renumber all in outline order'),
  );
  const written = app.editor.parsed.scenes.filter((s) => s.sceneNumber).length;
  sel.value = written ? 'remove' : 'renumber';
  const summary = h('div', { class: 'summary' });
  const update = () => {
    const n = sceneNumberEdits(app.editor.lineTexts, app.editor.parsed, sel.value as NumberMode).length;
    summary.textContent = `${written} of ${app.editor.parsed.scenes.length} headings have a written number. This changes ${n} heading${n === 1 ? '' : 's'}.`;
  };
  sel.addEventListener('change', update);
  update();
  openDialog({
    title: 'Scene numbers in the Fountain text',
    body: [
      h('p', null, 'Scene numbers are shown automatically while writing and in PDF export. Written numbers (such as #4#) are only needed for other apps or locked production numbering.'),
      h('div', { class: 'form-row' }, h('label', null, 'Change'), sel),
      summary,
    ],
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Apply',
        primary: true,
        run: () => {
          const edits = sceneNumberEdits(app.editor.lineTexts, app.editor.parsed, sel.value as NumberMode);
          if (!edits.length) {
            toast('Nothing to change.');
            return;
          }
          app.editor.edit((tx) => {
            for (const e of edits) tx.setLine(e.line, e.text);
            return app.editor.sel;
          });
          app.refreshDerived(true);
          toast(`${edits.length} heading${edits.length === 1 ? '' : 's'} changed.`, { actions: [{ label: 'Undo', run: () => app.run('edit.undo') }] });
        },
      },
    ],
  });
}

export function openFountainExport(app: App) {
  const p = app.project;
  if (!p) return;
  const numbers = h(
    'select',
    { class: 'field', 'aria-label': 'Scene numbers' },
    h('option', { value: 'renumber' }, 'Write numbers in outline order'),
    h('option', { value: 'addMissing' }, 'Add where missing'),
    h('option', { value: 'keep' }, 'Keep as written'),
    h('option', { value: 'remove' }, 'Remove'),
  );
  const notes = h('input', { type: 'checkbox', checked: true });
  const omitted = h('input', { type: 'checkbox', checked: true });
  const title = h('input', { type: 'checkbox', checked: true });
  openDialog({
    title: 'Export Fountain file',
    body: [
      h('p', null, 'Writes a copy for other screenplay apps. Your screenplay is not changed. Comments, highlights, the shelf and other versions are never included.'),
      h('div', { class: 'form-row' }, h('label', null, 'Scene numbers'), numbers),
      h('label', { class: 'check-row' }, notes, 'Remove [[notes]]'),
      h('label', { class: 'check-row' }, omitted, 'Remove omitted text /* */'),
      h('label', { class: 'check-row' }, title, 'Include the title page'),
    ],
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Export…',
        primary: true,
        run: async () => {
          const text = exportFountain(app.editor.lineTexts, app.editor.parsed, {
            numbers: numbers.value as NumberMode,
            removeNotes: notes.checked,
            removeOmitted: omitted.checked,
            titlePage: title.checked,
          });
          const dest = await bridge.dialog('save', { title: 'Export Fountain file', defaultPath: `${p.name}.fountain`, filters: [{ name: 'Fountain', extensions: ['fountain'] }] });
          if (!dest) return false;
          try {
            await bridge.call('writeFile', dest.toLowerCase().endsWith('.fountain') ? dest : dest + '.fountain', text);
            toast('Fountain file exported.');
          } catch (e: any) {
            alertDialog('Export failed', e.message);
          }
        },
      },
    ],
  });
}

/** Exports the screenplay as a Final Draft (.fdx) file. Scene numbers follow the PDF settings. */
export async function exportFinalDraft(app: App) {
  const p = app.project;
  if (!p) return;
  const parsed = app.editor.parsed;
  const s = projectExportSettings(app);
  const locked = !!p.meta.numbersLocked;
  const nums = locked || s.sceneNumbers !== 'off' ? sceneNumberList(parsed, locked) : undefined;
  const xml = exportFdx(app.editor.lineTexts, parsed, { sceneNumbers: nums, titlePage: true });
  const dest = await bridge.dialog('save', { title: 'Export Final Draft file', defaultPath: `${p.name}.fdx`, filters: [{ name: 'Final Draft', extensions: ['fdx'] }] });
  if (!dest) return;
  try {
    await bridge.call('writeFile', dest.toLowerCase().endsWith('.fdx') ? dest : dest + '.fdx', xml);
    toast('Final Draft file exported. Notes, sections, synopses and omitted text are left out.');
  } catch (e: any) {
    alertDialog('Export failed', e.message);
  }
}
