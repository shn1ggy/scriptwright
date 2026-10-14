// Production: locking pages and starting revision rounds (the logic is in shared/production.ts).

import type { App } from '../app';
import { bridge } from '../bridge';
import { uid } from './dom';
import { confirmDialog, toast } from './overlay';
import { PageLock, REVISION_COLORS, lockStarts, pageStartLines, revisionColor } from '../../shared/production';
import { ScriptLanguage } from '../../shared/types';
import { t, tn, uiLocale } from '../../shared/i18n';
import { scriptLanguage } from './export';
import type { ProductionInfo } from '../../main/backend';

/** Colour names as printed in the page header, in the screenplay's language. */
const DE_COLORS: Record<string, string> = {
  White: 'Weiß',
  Blue: 'Blau',
  Pink: 'Rosa',
  Yellow: 'Gelb',
  Green: 'Grün',
  Goldenrod: 'Goldgelb',
  Buff: 'Chamois',
  Salmon: 'Lachs',
  Cherry: 'Kirschrot',
};

/** "Blue", "Double Pink" … in the interface language. */
export function roundName(level: number): string {
  const c = revisionColor(level);
  const name = t(c.name);
  return c.prefix === 'Double' ? t('Double {0}', name) : c.prefix === 'Triple' ? t('Triple {0}', name) : name;
}

/** Header of a revised page, in the screenplay's language: "Blue Revision – 10/14/26". */
export function roundHeader(level: number, date: Date, lang: ScriptLanguage): string {
  const c = revisionColor(level);
  if (lang === 'de') {
    const name = DE_COLORS[c.name] ?? c.name;
    const pre = c.prefix === 'Double' ? 'Doppel-' : c.prefix === 'Triple' ? 'Dreifach-' : '';
    return `Änderung ${pre}${name} – ${date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })}`;
  }
  const pre = c.prefix ? `${c.prefix} ` : '';
  return `${pre}${c.name} Revision – ${date.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' })}`;
}

const sceneIds = (app: App) => app.scenes.filter((x) => x.kind === 'scene').map((x) => x.id);

/** Locks the page numbers as they are printed now; changes from here on are the blue revision. */
export async function lockPages(app: App) {
  const p = app.project;
  if (!p || p.meta.production) return;
  const ok = await confirmDialog(
    t('Lock pages'),
    [
      t('The pages keep the numbers they have now, with the current export settings. New material that no longer fits continues on A pages (12A); a page whose text is removed is joined to the one before (12-13).'),
      app.numbersLocked ? '' : t('Scene numbers are locked as well.'),
      t('Changes from now on are the blue revision: marked with an asterisk, and the page header names the colour.'),
    ]
      .filter(Boolean)
      .join(' '),
    t('Lock pages'),
  );
  if (!ok) return;
  if (!app.numbersLocked) app.lockSceneNumbers();
  await app.flush();
  const r = app.pagination();
  if (!r) {
    toast(t('The pages could not be laid out; try again in a moment.'), { warn: true });
    return;
  }
  const text = app.editor.getText();
  const id = uid();
  await bridge.call('saveProductionCopy', p.rel, id, text);
  const now = new Date().toISOString();
  p.meta.production = { lockedAt: now, lockId: id, pageStarts: pageStartLines(r.pages), sceneIds: sceneIds(app), rounds: [{ id, started: now, sceneIds: sceneIds(app) }] };
  app.lockTexts.set(id, text);
  app.markMetaDirty();
  await app.saveMetaNow();
  app.productionChanged();
  toast(tn(p.meta.production.pageStarts.length, 'Pages locked ({0} page). Changes from now on are the {1} revision.', 'Pages locked ({0} pages). Changes from now on are the {1} revision.', roundName(1).toLowerCase()));
}

/** The current round's pages went out: changes from now on get the next colour. */
export async function nextRevision(app: App) {
  const p = app.project;
  const pr = p?.meta.production;
  if (!p || !pr) return;
  const cur = pr.rounds.length;
  const ok = await confirmDialog(
    t('Start next revision'),
    t('The {0} pages are done. Changes from now on are the {1} revision; pages changed only in earlier rounds keep their colour and lose their asterisks.', roundName(cur), roundName(cur + 1)),
    t('Start {0} revision', roundName(cur + 1)),
  );
  if (!ok) return;
  await app.flush();
  const id = uid();
  await bridge.call('saveProductionCopy', p.rel, id, app.editor.getText());
  pr.rounds.push({ id, started: new Date().toISOString(), sceneIds: sceneIds(app) });
  app.markMetaDirty();
  await app.saveMetaNow();
  app.productionChanged();
  toast(t('Changes from now on are the {0} revision.', roundName(cur + 1).toLowerCase()));
}

export async function unlockPages(app: App) {
  const p = app.project;
  if (!p?.meta.production) return;
  const ok = await confirmDialog(t('Unlock pages'), t('Pages are numbered 1, 2, 3 … again and revision colours end. Scene numbers stay locked. The copies of the locked script remain in the project folder.'), t('Unlock'), { danger: true });
  if (!ok) return;
  delete p.meta.production;
  app.markMetaDirty();
  await app.saveMetaNow();
  app.productionChanged();
  toast(t('Pages unlocked.'));
}

/** Where the locked pages begin in the current text (null until the locked copy is loaded). */
export function currentLock(app: App): PageLock | null {
  const pr = app.project?.meta.production;
  if (!pr) return null;
  const text = app.lockTexts.get(pr.lockId);
  if (text === undefined) {
    void loadCopy(app, pr.lockId).then(() => app.productionChanged());
    return null;
  }
  return { starts: lockStarts(text.replace(/\r\n?/g, '\n').split('\n'), pr.pageStarts, app.editor.lineTexts, app.editor.parsed.bodyStart) };
}

const loading = new Map<string, Promise<string>>();
async function loadCopy(app: App, id: string): Promise<string> {
  const have = app.lockTexts.get(id);
  if (have !== undefined) return have;
  let pending = loading.get(id);
  if (!pending) {
    pending = bridge.call('readProductionCopy', app.project!.rel, id) as Promise<string>;
    loading.set(id, pending);
  }
  try {
    const text = await pending;
    app.lockTexts.set(id, text);
    return text;
  } finally {
    loading.delete(id);
  }
}

/** Everything the export needs for locked pages and revision rounds. */
export async function productionInfo(app: App, marks: boolean): Promise<ProductionInfo | undefined> {
  const pr = app.project?.meta.production;
  if (!pr) return undefined;
  const lang = scriptLanguage(app);
  const lockText = await loadCopy(app, pr.lockId);
  const rounds = [];
  for (let k = 0; k < pr.rounds.length; k++) {
    const r = pr.rounds[k];
    // A round's pages carry the date they went out: when the next round began, or today.
    const until = pr.rounds[k + 1] ? new Date(pr.rounds[k + 1].started) : new Date();
    rounds.push({ text: await loadCopy(app, r.id), sceneIds: r.sceneIds, label: roundHeader(k + 1, until, lang), tint: revisionColor(k + 1).tint });
  }
  return { lockText, pageStarts: pr.pageStarts, rounds, currentIds: sceneIds(app), marks };
}

/** One line for the export and the menus: "Pages locked 14 Oct · blue revision". */
export function productionSummary(app: App): string {
  const pr = app.project?.meta.production;
  if (!pr) return '';
  const date = new Date(pr.lockedAt).toLocaleDateString(uiLocale(), { day: 'numeric', month: 'short', year: 'numeric' });
  return t('Pages locked on {0} ({1} pages) · current revision: {2}', date, pr.pageStarts.length, roundName(pr.rounds.length).toLowerCase());
}

export { REVISION_COLORS };
