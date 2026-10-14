// Breakdown tags: marking props, costumes, vehicles … in the text for production reports.

import type { App } from '../app';
import { MenuItem, openMenu, toast } from './overlay';
import { LiveAnchor } from '../../shared/anchors';
import { TagCategory, TagRecord } from '../../shared/types';
import { Pos } from '../../shared/doc';
import { t, tn } from '../../shared/i18n';

/** Categories in the usual breakdown order, with the colours breakdown sheets use. */
export const TAG_CATEGORIES: Array<{ key: TagCategory; label: string; color: string }> = [
  { key: 'extras', label: 'Extras', color: '#3BAA5C' },
  { key: 'stunts', label: 'Stunts', color: '#F08A24' },
  { key: 'vehicles', label: 'Vehicles', color: '#E05FA8' },
  { key: 'props', label: 'Props', color: '#8E5BD8' },
  { key: 'sfx', label: 'Special effects', color: '#3A7BE0' },
  { key: 'wardrobe', label: 'Wardrobe', color: '#C9A227' },
  { key: 'makeup', label: 'Makeup & hair', color: '#C2577A' },
  { key: 'animals', label: 'Animals', color: '#7C9A3D' },
  { key: 'music', label: 'Music', color: '#26B0C0' },
  { key: 'sound', label: 'Sound', color: '#5C6BC0' },
  { key: 'setDressing', label: 'Set dressing', color: '#A0785A' },
  { key: 'equipment', label: 'Special equipment', color: '#7A8899' },
  { key: 'vfx', label: 'Visual effects', color: '#00A3A3' },
  { key: 'notes', label: 'Notes', color: '#9A9A9A' },
];

export function categoryLabel(c: TagCategory): string {
  return t(TAG_CATEGORIES.find((x) => x.key === c)?.label ?? c);
}

/** The element name for tagged words: one line, no surrounding punctuation. */
export function elementName(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/^[\s"'“„‚‘’”«»(\[]+|[\s"'“”’‘«».,;:!?)\]]+$/g, '')
    .trim();
}

/** Category menu for the selection, at the mouse or the caret. */
export function tagMenu(app: App, at?: { x: number; y: number }) {
  const an = app.annotations.selectionAnchor();
  if (!an) {
    toast(t('Select the words to tag first, e.g. the name of a prop.'));
    return;
  }
  const pos = at ?? (() => {
    const c = app.editor.coordsAtPos(app.editor.sel.head);
    return c ? { x: c.left, y: c.bottom + 4 } : { x: 200, y: 200 };
  })();
  const items: MenuItem[] = [{ head: t('Tag for breakdown') }, ...TAG_CATEGORIES.map((c) => ({ label: t(c.label), dot: c.color, run: () => tagSelection(app, c.key, an) }))];
  openMenu(items, pos);
}

export function tagSelection(app: App, category: TagCategory, an: LiveAnchor) {
  const name = elementName(textOfAnchor(app, an));
  if (!name) return;
  if (!app.annotations.showTags) setTagsShown(app, true);
  const added = app.annotations.addTags(category, name, [an]);
  const others = mentions(app, name).filter((m) => !(m.a.key === an.a.key && m.a.ch === an.a.ch));
  const untagged = others.filter((m) => !app.annotations.overlapping(m, 'tag').some((r) => (r.rec as TagRecord).category === category));
  const msg = added.length ? t('“{0}” tagged as {1}.', name, categoryLabel(category).toLowerCase()) : t('“{0}” is already tagged as {1} here.', name, categoryLabel(category).toLowerCase());
  toast(msg, untagged.length ? { timeout: 9000, actions: [{ label: tn(untagged.length, 'Tag the other mention', 'Tag all {0} other mentions'), run: () => app.annotations.addTags(category, name, untagged) }] } : {});
}

function textOfAnchor(app: App, an: LiveAnchor): string {
  const L = app.editor.lines;
  const ia = L.findIndex((l) => l.key === an.a.key);
  const ib = L.findIndex((l) => l.key === an.b.key);
  if (ia < 0 || ib < 0) return '';
  if (ia === ib) return L[ia].text.slice(an.a.ch, an.b.ch);
  const parts = [L[ia].text.slice(an.a.ch)];
  for (let i = ia + 1; i < ib; i++) parts.push(L[i].text);
  parts.push(L[ib].text.slice(0, an.b.ch));
  return parts.join(' ');
}

/** Every place in the screenplay where the name appears as a whole word (any case). */
export function mentions(app: App, name: string): LiveAnchor[] {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'giu');
  const out: LiveAnchor[] = [];
  const L = app.editor.lines;
  const parsed = app.editor.parsed;
  for (let i = parsed.bodyStart; i < L.length; i++) {
    const ty = parsed.lines[i]?.type;
    if (ty === 'boneyard' || ty === 'note' || ty === 'section' || ty === 'synopsis') continue;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(L[i].text))) out.push({ a: { key: L[i].key, ch: m.index }, b: { key: L[i].key, ch: m.index + m[0].length } });
  }
  return out;
}

export function tagsAt(app: App, pos: Pos): TagRecord[] {
  return app.annotations.at(pos).filter((r) => r.kind === 'tag').map((r) => r.rec as TagRecord);
}

export function setTagsShown(app: App, on: boolean) {
  app.annotations.showTags = on;
  app.state.layout.showTags = on;
  app.saveStateSoon();
  app.annotations.refresh();
  app.updateMenu();
}

/** Tags with the line they are on now (detached tags are left out). */
export function placedTags(app: App): Array<{ category: TagCategory; name: string; line: number; id: string }> {
  const L = app.editor.lines;
  const idx = new Map<number, number>();
  L.forEach((l, i) => idx.set(l.key, i));
  const out: Array<{ category: TagCategory; name: string; line: number; id: string }> = [];
  for (const tg of app.project?.meta.tags ?? []) {
    const an = app.annotations.live.get(tg.id);
    if (!an || tg.detached) continue;
    const line = idx.get(an.a.key);
    if (line !== undefined) out.push({ category: tg.category, name: tg.name, line, id: tg.id });
  }
  return out;
}
