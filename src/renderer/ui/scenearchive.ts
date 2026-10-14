// Scene archive: scenes taken out of the screenplay but kept with their details. They are
// listed at the end of the scene list and can be read, put back or deleted.

import type { App } from '../app';
import { h } from './dom';
import { MenuItem, openDialog } from './overlay';

export function archivedSceneMenu(app: App, id: string): MenuItem[] {
  return [
    { label: 'Read…', run: () => openArchivedScene(app, id) },
    { sep: true },
    { label: 'Put Back Where It Was', run: () => app.restoreArchivedScene(id, 'original') },
    { label: 'Put Back After Current Scene', run: () => app.restoreArchivedScene(id, 'current') },
    { sep: true },
    { label: 'Delete from Archive…', run: () => void app.deleteArchivedScene(id) },
  ];
}

/** Shows the archived scene's text and details, with the ways to put it back. */
export function openArchivedScene(app: App, id: string) {
  const a = app.project?.meta.sceneArchive?.find((x) => x.id === id);
  if (!a) return;
  const details = [a.summary, a.notes].filter(Boolean) as string[];
  openDialog({
    title: a.heading || 'Archived scene',
    width: 640,
    body: [
      h('p', { class: 'muted' }, `Archived ${new Date(a.archivedAt).toLocaleString()} · was scene ${a.number}`),
      ...details.map((d) => h('p', { class: 'archive-detail' }, d)),
      h('pre', { class: 'archive-text' }, a.lines.join('\n')),
    ],
    buttons: [
      { label: 'Delete…', run: () => void app.deleteArchivedScene(id) },
      { label: 'Close' },
      { label: 'After current scene', run: () => app.restoreArchivedScene(id, 'current') },
      { label: 'Put back where it was', primary: true, run: () => app.restoreArchivedScene(id, 'original') },
    ],
  });
}
