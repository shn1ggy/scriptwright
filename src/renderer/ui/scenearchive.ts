// Scene archive: scenes taken out of the screenplay but kept with their details. They are
// listed at the end of the scene list and can be read, put back or deleted.

import type { App } from '../app';
import { h } from './dom';
import { MenuItem, openDialog } from './overlay';
import { t, uiLocale } from '../../shared/i18n';

export function archivedSceneMenu(app: App, id: string): MenuItem[] {
  return [
    { label: t("Read…"), run: () => openArchivedScene(app, id) },
    { sep: true },
    { label: t("Put Back Where It Was"), run: () => app.restoreArchivedScene(id, 'original') },
    { label: t("Put Back After Current Scene"), run: () => app.restoreArchivedScene(id, 'current') },
    { sep: true },
    { label: t("Delete from Archive…"), run: () => void app.deleteArchivedScene(id) },
  ];
}

/** Shows the archived scene's text and details, with the ways to put it back. */
export function openArchivedScene(app: App, id: string) {
  const a = app.project?.meta.sceneArchive?.find((x) => x.id === id);
  if (!a) return;
  const details = [a.summary, a.notes].filter(Boolean) as string[];
  openDialog({
    title: a.heading || t("Archived scene"),
    width: 640,
    body: [
      h('p', { class: 'muted' }, t("Archived {0} · was scene {1}", new Date(a.archivedAt).toLocaleString(uiLocale()), a.number)),
      ...details.map((d) => h('p', { class: 'archive-detail' }, d)),
      h('pre', { class: 'archive-text' }, a.lines.join('\n')),
    ],
    buttons: [
      { label: t("Delete…"), run: () => void app.deleteArchivedScene(id) },
      { label: t("Close") },
      { label: t("After current scene"), run: () => app.restoreArchivedScene(id, 'current') },
      { label: t("Put back where it was"), primary: true, run: () => app.restoreArchivedScene(id, 'original') },
    ],
  });
}
