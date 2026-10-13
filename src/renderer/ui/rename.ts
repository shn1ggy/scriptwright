// Whole-script character rename.

import type { App } from '../app';
import { h } from './dom';
import { openDialog, toast } from './overlay';
import { characterLabel, characterList } from '../../shared/fountain';
import { planRename } from '../../shared/rename';

export function openRename(app: App, preset?: string) {
  const parsed = app.editor.parsed;
  const chars = characterList(parsed);
  if (!chars.length) {
    toast('There are no character cues in this screenplay yet.');
    return;
  }
  const select = h('select', { class: 'field', 'aria-label': 'Character' });
  for (const c of chars) select.append(h('option', { value: c.name }, characterLabel(c)));
  if (preset && chars.some((c) => c.name === preset)) select.value = preset;
  const input = h('input', { class: 'field', placeholder: 'New name', 'aria-label': 'New name', spellcheck: 'false' });
  const summary = h('div', { class: 'summary' });
  let confirmMerge = false;

  const plan = () => planRename(app.editor.lineTexts, app.editor.parsed, select.value, input.value, app.settings.editor.extraPrefixes);

  const update = () => {
    confirmMerge = false;
    summary.textContent = '';
    const name = input.value.trim();
    if (!name) {
      summary.append('Cues, and mentions in action and dialogue, are renamed with matching capitalization.');
      dlg.setButtons([{ label: 'Cancel' }, { label: 'Rename', primary: true, run: () => false }]);
      return;
    }
    const p = plan();
    const s = p.summary;
    const parts: (Node | string)[] = [h('strong', null, `${s.total} replacement${s.total === 1 ? '' : 's'}`), `: ${s.cues} cue${s.cues === 1 ? '' : 's'}, ${s.action} in action, ${s.dialogue} in dialogue`];
    if (s.other) parts.push(`, ${s.other} elsewhere`);
    parts.push('.');
    summary.append(...parts);
    if (s.merge) summary.append(h('div', { style: { color: 'var(--warn)', marginTop: '6px' } }, `${s.newCue} already exists. Renaming merges ${select.value} into ${s.newCue}.`));
    dlg.setButtons([
      { label: 'Cancel' },
      {
        label: s.merge ? `Merge into ${s.newCue}` : 'Rename',
        primary: true,
        danger: s.merge,
        run: () => apply(),
      },
    ]);
  };

  const apply = (): boolean | void => {
    const p = plan();
    if (!p.changes.length) {
      toast('Nothing to rename.');
      return;
    }
    if (p.summary.merge && !confirmMerge) confirmMerge = true;
    const from = select.value;
    app.editor.edit((tx) => {
      for (const c of p.changes) tx.setLine(c.line, c.text);
      return app.editor.sel;
    });
    app.refreshDerived(true);
    toast(`Renamed ${from} → ${p.summary.newCue}: ${p.summary.total} replacements.`, { actions: [{ label: 'Undo', run: () => app.run('edit.undo') }] });
  };

  const dlg = openDialog({
    title: 'Rename character',
    body: [h('div', { class: 'form-row' }, h('label', null, 'Character'), select), h('div', { class: 'form-row' }, h('label', null, 'New name'), input), summary],
    initialFocus: input,
  });
  select.addEventListener('change', update);
  input.addEventListener('input', update);
  update();
}
