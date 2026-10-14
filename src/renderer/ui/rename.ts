// Whole-script character rename.

import type { App } from '../app';
import { h } from './dom';
import { openDialog, toast } from './overlay';
import { characterLabel, characterList } from '../../shared/fountain';
import { PossessiveStyle, guessLanguage, planRename } from '../../shared/rename';
import { t, tn } from '../../shared/i18n';

export function openRename(app: App, preset?: string) {
  const parsed = app.editor.parsed;
  const chars = characterList(parsed);
  if (!chars.length) {
    toast(t("There are no character cues in this screenplay yet."));
    return;
  }
  const select = h('select', { class: 'field', 'aria-label': t("Character") });
  for (const c of chars) select.append(h('option', { value: c.name }, characterLabel(c)));
  if (preset && chars.some((c) => c.name === preset)) select.value = preset;
  const input = h('input', { class: 'field', placeholder: t("New name"), 'aria-label': t("New name"), spellcheck: 'false' });
  const summary = h('div', { class: 'summary' });
  const style = h('select', { class: 'field', 'aria-label': t("Possessive forms") }, h('option', { value: 'de' }, t("German (Lisas, Andreas’)")), h('option', { value: 'en' }, t("English (Lisa’s, James’)")));
  style.value = guessLanguage(app.editor.lineTexts);
  let confirmMerge = false;

  const plan = () => planRename(app.editor.lineTexts, app.editor.parsed, select.value, input.value, app.settings.editor.extraPrefixes, style.value as PossessiveStyle);

  const update = () => {
    confirmMerge = false;
    summary.textContent = '';
    const name = input.value.trim();
    if (!name) {
      summary.append(t('Cues and every mention are renamed with matching capitalization, including possessive forms.'));
      dlg.setButtons([{ label: t("Cancel") }, { label: t("Rename"), primary: true, run: () => false }]);
      return;
    }
    const p = plan();
    const s = p.summary;
    const parts: (Node | string)[] = [h('strong', null, tn(s.total, '{0} replacement', '{0} replacements')), ': ' + [tn(s.cues, '{0} cue', '{0} cues'), t('{0} in action', s.action), t('{0} in dialogue', s.dialogue)].join(', ')];
    if (s.other) parts.push(`, ${s.other} elsewhere`);
    parts.push('.');
    summary.append(...parts);
    if (s.merge) summary.append(h('div', { style: { color: 'var(--warn)', marginTop: '6px' } }, t("{0} already exists. Renaming merges {1} into {2}.", s.newCue, select.value, s.newCue)));
    dlg.setButtons([
      { label: t("Cancel") },
      {
        label: s.merge ? t("Merge into {0}", s.newCue) : t("Rename"),
        primary: true,
        danger: s.merge,
        run: () => apply(),
      },
    ]);
  };

  const apply = (): boolean | void => {
    const p = plan();
    if (!p.changes.length) {
      toast(t("Nothing to rename."));
      return;
    }
    if (p.summary.merge && !confirmMerge) confirmMerge = true;
    const from = select.value;
    app.editor.edit((tx) => {
      for (const c of p.changes) tx.setLine(c.line, c.text);
      return app.editor.sel;
    });
    app.refreshDerived(true);
    toast(t("Renamed {0} → {1}: {2} replacements.", from, p.summary.newCue, p.summary.total), { actions: [{ label: t("Undo"), run: () => app.run('edit.undo') }] });
  };

  const dlg = openDialog({
    title: t("Rename character"),
    body: [h('div', { class: 'form-row' }, h('label', null, t("Character")), select), h('div', { class: 'form-row' }, h('label', null, t("New name")), input), h('div', { class: 'form-row' }, h('label', null, t("Possessive forms")), style), summary],
    initialFocus: input,
  });
  select.addEventListener('change', update);
  input.addEventListener('input', update);
  style.addEventListener('change', update);
  update();
}
