// Named drafts: saving, keeping any text as a draft, and restoring a version.

import type { App } from '../app';
import { bridge } from '../bridge';
import { uid } from './dom';
import { promptDialog, toast } from './overlay';
import { DraftInfo } from '../../shared/types';
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

/** Keeps any text (e.g. an automatic snapshot) as a named draft. */
export async function saveTextAsDraft(app: App, name: string, text: string, sceneIds?: string[]): Promise<DraftInfo | null> {
  const p = app.project;
  if (!p) return null;
  const info: DraftInfo = { id: uid(), name, created: new Date().toISOString(), words: countWords(text), sceneIds: sceneIds ?? [] };
  await bridge.call('saveDraft', p.rel, info.id, text);
  p.meta.drafts.unshift(info);
  app.markMetaDirty();
  await app.saveMetaNow();
  app.rightPane.historyChanged();
  return info;
}

/** Restores a version after saving the current writing as a draft. Undoable. */
export async function restoreVersion(app: App, text: string, label: string, sceneIds?: string[]) {
  const before = await saveDraft(app, `Before restoring “${label}”`);
  if (!before) return;
  await app.replaceAllText(text, `Restored “${label}”. Your previous text was saved as the draft “${before.name}”.`, 'command', sceneIds);
  app.rightPane.historyChanged();
}
