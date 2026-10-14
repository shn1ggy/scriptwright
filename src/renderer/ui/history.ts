// History view: every kept version of the screenplay (named drafts, exported versions and
// automatic snapshots) on one timeline, with the selected version shown scene by scene, as
// a list of all changes, or as the printed pages. Any two versions can be compared.

import type { App } from '../app';
import { bridge } from '../bridge';
import { h, icon, withClear } from './dom';
import { confirmDialog, promptDialog, pushEscape, toast } from './overlay';
import { diffLines } from './compare';
import { restoreVersion, saveDraft, saveTextAsDraft } from './drafts';
import { loadPdfjs, projectExportSettings } from './export';
import { DraftInfo, ExportRecord, ExportSettings } from '../../shared/types';
import { compareScenes, scenesOf, ROW_LABELS, CompareRow } from '../../shared/scenecompare';
import { ElementType, cleanText, parse, titleFields } from '../../shared/fountain';
import { t, tn, uiLocale } from '../../shared/i18n';

export type EntryKind = 'draft' | 'export' | 'snapshot' | 'now';

export interface HistoryEntry {
  key: string;
  kind: EntryKind;
  id: string;
  name: string;
  time: number;
  note?: string;
  pinned?: boolean;
  /** Short facts: words, pages, what was exported. */
  facts: string;
  sceneIds?: string[];
  settings?: ExportSettings;
}

type ListKind = 'draft' | 'export' | 'snapshot';
type Mode = 'scenes' | 'changes' | 'pages' | 'text';

/** Which kinds of versions the lists show (remembered; drafts and exports by default). */
export function shownKinds(app: App): Set<ListKind> {
  const k = app.state.layout.historyKinds;
  return new Set((k && k.length ? k : ['draft', 'export']) as ListKind[]);
}

/** Three toggles (Drafts, Exports, Snapshots); at least one stays on. */
export function kindToggles(app: App, onChange: () => void): HTMLElement {
  const wrap = h('div', { class: 'kind-toggles', role: 'group', 'aria-label': t("Show") });
  const draw = () => {
    const on = shownKinds(app);
    wrap.textContent = '';
    for (const [k, label] of [['draft', 'Drafts'], ['export', 'Exports'], ['snapshot', 'Snapshots']] as Array<[ListKind, string]>) {
      const b = h('button', { class: `kind-toggle${on.has(k) ? ' on' : ''}`, 'aria-pressed': String(on.has(k)), 'data-k': k }, h('span', { class: `hist-kind k-${k}` }), t(label));
      b.addEventListener('click', () => {
        const next = shownKinds(app);
        if (next.has(k)) {
          if (next.size === 1) return;
          next.delete(k);
        } else next.add(k);
        app.state.layout.historyKinds = [...next];
        app.saveStateSoon();
        draw();
        onChange();
      });
      wrap.append(b);
    }
  };
  draw();
  return wrap;
}

const KIND_LABEL: Record<EntryKind, string> = { draft: 'Draft', export: 'Export', snapshot: 'Snapshot', now: 'Now' };

function fmtDate(t: number, withTime = true): string {
  const d = new Date(t);
  return d.toLocaleString(uiLocale(), withTime ? { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', year: 'numeric' });
}

function snapshotLabel(name: string): string {
  const l = name.replace(/^\d{4}-\d{2}-\d{2}_\d{6}\s*/, '').replace(/\.fountain$/, '');
  return l && l !== 'auto' ? t(l) : '';
}

/** All versions of the open project, newest first ('now' excluded). */
export async function historyEntries(app: App): Promise<HistoryEntry[]> {
  const p = app.project;
  if (!p) return [];
  const drafts: HistoryEntry[] = p.meta.drafts.map((d: DraftInfo) => ({
    key: `draft:${d.id}`,
    kind: 'draft',
    id: d.id,
    name: d.name,
    time: Date.parse(d.created),
    note: d.note,
    pinned: d.pinned,
    facts: t('{0} words', d.words.toLocaleString(uiLocale())),
    sceneIds: d.sceneIds,
  }));
  const exports: HistoryEntry[] = p.meta.exports.map((e: ExportRecord) => ({
    key: `export:${e.id}`,
    kind: 'export',
    id: e.id,
    name: e.name,
    time: Date.parse(e.created),
    note: e.note,
    pinned: e.pinned,
    facts: [tn(e.pages, '{0} page', '{0} pages'), e.scope, e.comparedWith ? t('changes since {0}', e.comparedWith) : ''].filter(Boolean).join(' · '),
    sceneIds: e.sceneIds,
    settings: e.settings,
  }));
  let snaps: HistoryEntry[] = [];
  try {
    const list = await bridge.call('listHistory', p.rel);
    snaps = list.map((s: { name: string; time: number; size: number }) => {
      const label = snapshotLabel(s.name);
      return {
        key: `snap:${s.name}`,
        kind: 'snapshot' as const,
        id: s.name,
        name: label ? t('Snapshot · {0}', label) : t('Snapshot'),
        time: s.time,
        facts: `${Math.max(1, Math.round(s.size / 1024))} KB`,
      };
    });
  } catch {
    snaps = [];
  }
  return [...drafts, ...exports, ...snaps].sort((a, b) => b.time - a.time);
}

/** Text of a version. */
async function readEntry(app: App, e: HistoryEntry): Promise<string> {
  const p = app.project!;
  if (e.kind === 'now') return app.editor.getText();
  if (e.kind === 'draft') return bridge.call('readDraft', p.rel, e.id);
  if (e.kind === 'export') return bridge.call('readExportCopy', p.rel, e.id);
  return bridge.call('readHistory', p.rel, e.id);
}

/** Time groups: Pinned, Today, Yesterday, This week, Earlier this month, then by month. */
function groupOf(time: number, now = new Date()): { key: string; label: string; old: boolean } {
  const d = new Date(time);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff <= 0) return { key: 'today', label: t("Today"), old: false };
  if (diff === 1) return { key: 'yesterday', label: t("Yesterday"), old: false };
  if (diff < 7) return { key: 'week', label: t("This week"), old: false };
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return { key: 'month', label: t("Earlier this month"), old: false };
  return { key: `m${d.getFullYear()}-${d.getMonth()}`, label: d.toLocaleDateString(uiLocale(), { month: 'long', year: 'numeric' }), old: true };
}

export interface HistoryHandle {
  close(): void;
  select(key: string): void;
}

export function openHistory(app: App, host: HTMLElement, initialKey?: string): HistoryHandle | null {
  const p = app.project;
  if (!p) return null;
  const extra = app.settings.editor.extraPrefixes;
  let entries: HistoryEntry[] = [];
  let query = '';
  let selKey = initialKey ?? '';
  let cmpKey = 'now';
  let mode: Mode = 'scenes';
  let markChanges = true;
  const toggled = new Set<string>(); // groups the writer opened or closed
  const textCache = new Map<string, string>();
  let token = 0;

  const nowEntry = (): HistoryEntry => ({ key: 'now', kind: 'now', id: 'now', name: t('Current screenplay'), time: Date.now(), facts: '', sceneIds: app.scenes.filter((s) => s.kind === 'scene').map((s) => s.id) });
  const entry = (key: string) => (key === 'now' ? nowEntry() : entries.find((e) => e.key === key));
  const text = async (e: HistoryEntry) => {
    if (e.kind === 'now') return app.editor.getText();
    if (!textCache.has(e.key)) textCache.set(e.key, await readEntry(app, e));
    return textCache.get(e.key)!;
  };

  // Layout -------------------------------------------------------------------------------
  const countEl = h('span', { class: 'view-head-info' });
  const search = h('input', { class: 'field', placeholder: t("Search names and notes"), 'aria-label': t("Search versions") });
  // Opening a snapshot from the notes pane shows snapshots even when they were hidden.
  if (initialKey?.startsWith('snap:') && !shownKinds(app).has('snapshot')) {
    app.state.layout.historyKinds = [...shownKinds(app), 'snapshot'];
  }
  let seg = kindToggles(app, () => renderList());
  const list = h('div', { class: 'hist-list', role: 'listbox', tabindex: '0', 'aria-label': t("Versions") });
  const detail = h('div', { class: 'hist-detail' });
  const root = h(
    'div',
    { class: 'history-view', role: 'region', 'aria-label': t("History") },
    h(
      'div',
      { class: 'view-head' },
      h('span', { class: 'view-head-title' }, t("History")),
      countEl,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => void snapshotNow() }, t("Snapshot Now")),
      h('button', { class: 'btn', onclick: () => void saveDraftNow() }, t("Save as Draft…")),
    ),
    h('div', { class: 'hist-body' }, h('div', { class: 'hist-side' }, h('div', { class: 'hist-tools' }, withClear(search), seg), list), detail),
  );
  host.append(root);
  search.addEventListener('input', () => {
    query = search.value.trim().toLowerCase();
    renderList();
  });

  const popEsc = pushEscape(() => app.closePanel(), false);

  async function reload(keepSel = true) {
    entries = await historyEntries(app);
    const named = entries.filter((e) => e.kind !== 'snapshot').length;
    countEl.textContent = [t('{0} named', named), tn(entries.length - named, '{0} snapshot', '{0} snapshots')].join(' · ');
    if (!keepSel || !entries.some((e) => e.key === selKey)) selKey = visible()[0]?.key ?? entries[0]?.key ?? '';
    renderList();
    renderDetail();
  }

  function visible(): HistoryEntry[] {
    const kinds = shownKinds(app);
    return entries.filter((e) => {
      if (!kinds.has(e.kind as ListKind)) return false;
      if (query && !`${e.name} ${e.note ?? ''} ${t(KIND_LABEL[e.kind])}`.toLowerCase().includes(query)) return false;
      return true;
    });
  }


  // List ---------------------------------------------------------------------------------
  function row(e: HistoryEntry): HTMLElement {
    const r = h(
      'div',
      { class: `hist-row${e.key === selKey ? ' selected' : ''}`, role: 'option', 'aria-selected': String(e.key === selKey), 'data-key': e.key },
      h('span', { class: `hist-kind k-${e.kind}`, title: t(KIND_LABEL[e.kind]) }),
      h(
        'span',
        { class: 'hist-main' },
        h('span', { class: 'hist-name' }, e.kind === 'snapshot' ? new Date(e.time).toLocaleTimeString(uiLocale(), { hour: '2-digit', minute: '2-digit' }) + (snapshotLabel(e.id) ? ` · ${snapshotLabel(e.id)}` : '') : e.name),
        h('span', { class: 'hist-sub' }, [t(KIND_LABEL[e.kind]), fmtDate(e.time, e.kind !== 'snapshot'), e.note ? e.note.split('\n')[0] : ''].filter(Boolean).join(' · ')),
      ),
      e.pinned ? h('span', { class: 'hist-pin', title: t("Pinned") }, icon('pin')) : null,
    );
    r.addEventListener('click', () => select(e.key));
    return r;
  }

  function renderList() {
    const items = visible();
    list.textContent = '';
    if (!items.length) {
      list.append(h('div', { class: 'notice' }, entries.length ? t("Nothing matches.") : t("No versions yet. Save a draft, export a PDF, or keep writing: snapshots are taken while you write.")));
      return;
    }
    const pinned = items.filter((e) => e.pinned);
    if (pinned.length) {
      list.append(h('div', { class: 'hist-group' }, h('span', null, t("Pinned"))));
      for (const e of pinned) list.append(row(e));
    }
    let cur = '';
    let collapsed = false;
    const counts = new Map<string, number>();
    for (const e of items) if (!e.pinned) counts.set(groupOf(e.time).key, (counts.get(groupOf(e.time).key) ?? 0) + 1);
    for (const e of items) {
      if (e.pinned) continue;
      const g = groupOf(e.time);
      if (g.key !== cur) {
        cur = g.key;
        // Older months start folded, recent groups open; a click flips that. A search or the
        // selected version keeps a group open.
        const gk = g.key;
        const holdsSel = items.some((x) => x.key === selKey && !x.pinned && groupOf(x.time).key === gk);
        collapsed = (g.old !== toggled.has(gk)) && !query && !holdsSel;
        const head = h(
          'button',
          { class: 'hist-group', 'aria-expanded': String(!collapsed), onclick: () => {
            if (toggled.has(gk)) toggled.delete(gk);
            else toggled.add(gk);
            renderList();
          } },
          h('span', null, g.label),
          h('span', { class: 'dim' }, String(counts.get(g.key) ?? 0)),
          h('span', { class: 'collapse-mark' }, icon(collapsed ? 'chevronRight' : 'chevronDown')),
        );
        list.append(head);
      }
      if (!collapsed) list.append(row(e));
    }
  }

  function select(key: string) {
    selKey = key;
    if (cmpKey === key) cmpKey = 'now';
    for (const r of Array.from(list.querySelectorAll<HTMLElement>('.hist-row'))) {
      r.classList.toggle('selected', r.dataset.key === key);
      r.setAttribute('aria-selected', String(r.dataset.key === key));
    }
    renderDetail();
  }

  list.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    ev.preventDefault();
    const rows = Array.from(list.querySelectorAll<HTMLElement>('.hist-row'));
    const i = rows.findIndex((r) => r.dataset.key === selKey);
    const n = rows[Math.max(0, Math.min(rows.length - 1, i + (ev.key === 'ArrowDown' ? 1 : -1)))];
    if (n) {
      select(n.dataset.key!);
      n.scrollIntoView({ block: 'nearest' });
    }
  });

  // Detail -------------------------------------------------------------------------------
  async function renderDetail() {
    const my = ++token;
    detail.textContent = '';
    const e = entry(selKey);
    if (!e) {
      detail.append(h('div', { class: 'notice' }, t("Choose a version on the left.")));
      return;
    }
    const meta = e.kind === 'snapshot' ? 'Saved automatically while writing' : e.facts;
    const actions = h('div', { class: 'hist-actions' });
    if (e.kind !== 'snapshot') {
      actions.append(
        h('button', { class: 'btn', onclick: () => void rename(e) }, t("Rename…")),
        h('button', { class: 'btn', onclick: () => togglePin(e) }, e.pinned ? t("Unpin") : t("Pin")),
      );
    } else actions.append(h('button', { class: 'btn', onclick: () => void keepAsDraft(e) }, t("Keep as Draft…")));
    actions.append(h('button', { class: 'btn primary', onclick: () => void restore(e) }, t("Restore…")));
    if (e.kind !== 'snapshot') actions.append(h('button', { class: 'btn danger', onclick: () => void remove(e) }, t("Delete…")));

    let note: HTMLTextAreaElement | null = null;
    if (e.kind === 'draft' || e.kind === 'export') {
      note = h('textarea', { class: 'field hist-note', rows: 1, placeholder: t("Note (only shown in the app)"), 'aria-label': t("Note") });
      note.value = e.note ?? '';
      note.addEventListener('change', () => {
        const rec = e.kind === 'draft' ? p!.meta.drafts.find((d) => d.id === e.id) : p!.meta.exports.find((x) => x.id === e.id);
        if (!rec) return;
        rec.note = note!.value.trim();
        e.note = rec.note;
        app.markMetaDirty();
        renderList();
      });
    }

    const cmpSel = h('select', { class: 'field', 'aria-label': t("Compare with") });
    cmpSel.append(h('option', { value: 'now' }, t("Current screenplay")));
    const others = entries.filter((x) => x.key !== e.key);
    const named = others.filter((x) => x.kind !== 'snapshot');
    const snaps = others.filter((x) => x.kind === 'snapshot').slice(0, 40);
    if (named.length) cmpSel.append(h('optgroup', { label: t("Named versions") }, ...named.map((x) => h('option', { value: x.key }, `${x.name} — ${fmtDate(x.time)}`))));
    if (snaps.length) cmpSel.append(h('optgroup', { label: t("Snapshots") }, ...snaps.map((x) => h('option', { value: x.key }, fmtDate(x.time)))));
    if (!entry(cmpKey)) cmpKey = 'now';
    cmpSel.value = cmpKey;
    cmpSel.addEventListener('change', () => {
      cmpKey = cmpSel.value;
      void renderBody();
    });
    const modeBtn = (m: Mode, label: string) => h('button', { class: `seg-btn${mode === m ? ' on' : ''}`, dataset: { mode: m }, onclick: () => setMode(m) }, label);
    const modes = h('div', { class: 'seg', role: 'group', 'aria-label': t("View") }, modeBtn('scenes', t("Scenes")), modeBtn('changes', t("All changes")), modeBtn('pages', t("Pages")), modeBtn('text', t("Text")));
    const mark = h('input', { type: 'checkbox', checked: markChanges, 'aria-label': t("Mark changes") });
    mark.addEventListener('change', () => {
      markChanges = mark.checked;
      void renderBody();
    });
    const markLabel = h('label', { class: 'check hist-mark' }, mark, t("Mark changes"));
    const summary = h('div', { class: 'hist-summary' });
    const body = h('div', { class: 'hist-content' });
    detail.append(
      h(
        'div',
        { class: 'hist-top' },
        h(
          'div',
          { class: 'hist-top-row' },
          h(
            'div',
            { class: 'hist-head' },
            h('div', { class: 'hist-title' }, h('span', { class: `hist-kind k-${e.kind}` }), h('span', null, e.kind === 'snapshot' ? t("Snapshot from {0}", fmtDate(e.time)) : e.name)),
            h('div', { class: 'hist-meta' }, `${t(KIND_LABEL[e.kind])} · ${fmtDate(e.time)}${meta ? ' · ' + meta : ''}`),
          ),
          actions,
        ),
        note,
      ),
      h('div', { class: 'hist-bar' }, modes, h('span', { class: 'spacer' }), markLabel, h('label', { class: 'hist-cmp' }, h('span', null, t("Compare with")), cmpSel)),
      summary,
      body,
    );

    function setMode(m: Mode) {
      mode = m;
      for (const b of Array.from(modes.children) as HTMLElement[]) b.classList.toggle('on', b.dataset.mode === m);
      void renderBody();
    }

    async function renderBody() {
      const mine = ++token;
      markLabel.classList.toggle('hidden', mode !== 'pages');
      body.textContent = '';
      summary.textContent = '';
      body.append(h('div', { class: 'notice' }, t("Loading…")));
      const other = entry(cmpKey) ?? nowEntry();
      let a: string;
      let b: string;
      try {
        [a, b] = await Promise.all([text(e!), text(other)]);
      } catch (err: any) {
        if (mine !== token) return;
        body.replaceChildren(h('div', { class: 'notice warn' }, t("This version could not be read: {0}", err.message)));
        return;
      }
      if (mine !== token) return;
      const oldS = scenesOf(a, e!.sceneIds, extra);
      const newS = scenesOf(b, other.sceneIds, extra);
      const rows = compareScenes(oldS, newS);
      const c: Record<string, number> = {};
      for (const r of rows) c[r.kind] = (c[r.kind] ?? 0) + 1;
      const otherName = other.kind === 'now' ? t('the current screenplay') : `“${other.name}”`;
      summary.textContent =
        t("Compared with {0}: {1} changed, {2} moved, {3} added, {4} removed, {5} unchanged.", otherName, c.changed ?? 0, (c.moved ?? 0) + (c.movedChanged ?? 0), c.added ?? 0, c.removed ?? 0, c.same ?? 0);
      body.textContent = '';
      if (mode === 'scenes') renderScenes(body, rows, oldS, newS);
      else if (mode === 'changes') renderChanges(body, a, b);
      else if (mode === 'text') renderText(body, a, e!);
      else await renderPages(body, e!, a, b, other, () => mine === token);
    }
    void renderBody();
    if (my !== token) return;
  }

  // Text: the version's plain text, to read or copy from ------------------------------------
  function renderText(body: HTMLElement, a: string, e: HistoryEntry) {
    const pre = h('pre', { class: 'hist-text', tabindex: '0', 'aria-label': t("Text of this version") }, a);
    const copy = h('button', {
      class: 'btn',
      onclick: async () => {
        const sel = window.getSelection();
        const part = sel && pre.contains(sel.anchorNode) ? sel.toString() : '';
        await bridge.clipboard.writeText(part || a);
        toast(part ? t("Selection copied.") : t("The whole text was copied."));
      },
    }, t("Copy"));
    body.append(
      h('div', { class: 'hist-text-bar' }, h('span', { class: 'hist-summary' }, t("The Fountain text of {0}. Select a part to copy only that, or copy everything.", e.kind === 'snapshot' ? t('this snapshot') : `“${e.name}”`)), h('span', { class: 'spacer' }), copy),
      pre,
    );
  }

  // Scenes: list of scenes with their differences ----------------------------------------
  function renderScenes(body: HTMLElement, rows: CompareRow[], oldS: ReturnType<typeof scenesOf>, newS: ReturnType<typeof scenesOf>) {
    const only = h('input', { type: 'checkbox', checked: app.state.layout.historyOnlyDiff !== false, 'aria-label': t("Only differences") });
    only.addEventListener('change', () => {
      app.state.layout.historyOnlyDiff = only.checked;
      app.saveStateSoon();
    });
    const sceneList = h('div', { class: 'cmp-list', role: 'listbox', tabindex: '0' });
    const diff = h('div', { class: 'cmp-detail diff preview-text' });
    let sel = rows.findIndex((r) => r.kind !== 'same');
    if (sel < 0) sel = 0;
    const draw = () => {
      sceneList.textContent = '';
      rows.forEach((r, k) => {
        if (only.checked && r.kind === 'same') return;
        const o = r.oldIndex !== undefined ? oldS[r.oldIndex] : undefined;
        const n = r.newIndex !== undefined ? newS[r.newIndex] : undefined;
        const el = h(
          'div',
          { class: `row cmp-row${k === sel ? ' selected' : ''}`, role: 'option' },
          h('span', { class: `chip chip-${r.kind}` }, ROW_LABELS[r.kind] + (r.ambiguous ? '?' : '')),
          h('span', { class: 'label' }, (n ?? o)!.heading),
          h('span', { class: 'meta' }, r.oldIndex !== undefined && r.newIndex !== undefined ? (r.oldIndex !== r.newIndex ? `${r.oldIndex + 1} → ${r.newIndex + 1}` : `${r.newIndex + 1}`) : r.newIndex !== undefined ? t("new {0}", r.newIndex + 1) : t("was {0}", r.oldIndex! + 1)),
        );
        el.addEventListener('click', () => {
          sel = k;
          draw();
        });
        sceneList.append(el);
      });
      if (!sceneList.childElementCount) sceneList.append(h('div', { class: 'notice', style: { padding: '8px' } }, t("No scene differs.")));
      diff.textContent = '';
      const r = rows[sel];
      if (!r) return;
      const al = r.oldIndex !== undefined ? oldS[r.oldIndex].lines : [];
      const bl = r.newIndex !== undefined ? newS[r.newIndex].lines : [];
      if (r.kind === 'moved') diff.append(h('div', { class: 'notice' }, t("Moved from position {0} to {1}. The text is unchanged.", r.oldIndex! + 1, r.newIndex! + 1)));
      if (r.ambiguous) diff.append(h('div', { class: 'notice warn' }, t("This scene could not be matched with certainty (several scenes look alike).")));
      for (const op of diffLines(al, bl)) diff.append(h('div', { class: op.kind === 'same' ? '' : op.kind }, (op.kind === 'add' ? '+ ' : op.kind === 'del' ? '− ' : '  ') + (op.text || ' ')));
    };
    only.addEventListener('change', draw);
    draw();
    body.append(h('label', { class: 'check hist-only' }, only, t("Only differences")), h('div', { class: 'cmp-split' }, sceneList, diff));
  }

  // All changes: only the changed passages, in screenplay layout --------------------------
  function renderChanges(body: HTMLElement, a: string, b: string) {
    const al = a.replace(/\r\n?/g, '\n').split('\n');
    const bl = b.replace(/\r\n?/g, '\n').split('\n');
    const pa = parse(al, { extraPrefixes: extra });
    const pb = parse(bl, { extraPrefixes: extra });
    const ops = diffLines(al, bl);
    // Element type and scene heading for every op (from the side it came from).
    let ia = 0;
    let ib = 0;
    let headA = '';
    let headB = '';
    // Lines are shown as they read (without Fountain markers such as #12# or *…*).
    const clean = (pl: { flags: Uint8Array | null; type: ElementType } | undefined, text: string) => (pl && pl.type !== 'blank' ? cleanText(text, pl.flags) : text.trim());
    const info = ops.map((op) => {
      let type: ElementType;
      let shown: string;
      if (op.kind === 'add') {
        type = pb.lines[ib]?.type ?? 'action';
        shown = clean(pb.lines[ib], op.text);
        if (type === 'heading') headB = shown;
        ib++;
      } else if (op.kind === 'del') {
        type = pa.lines[ia]?.type ?? 'action';
        shown = clean(pa.lines[ia], op.text);
        if (type === 'heading') headA = shown;
        ia++;
      } else {
        type = pb.lines[ib]?.type ?? 'action';
        shown = clean(pb.lines[ib], op.text);
        if (type === 'heading') headA = headB = shown;
        ia++;
        ib++;
      }
      return { type, shown, heading: op.kind === 'del' ? headA : headB };
    });
    const CONTEXT = 2;
    const show = new Array(ops.length).fill(false);
    ops.forEach((op, k) => {
      if (op.kind === 'same') return;
      for (let j = Math.max(0, k - CONTEXT); j <= Math.min(ops.length - 1, k + CONTEXT); j++) show[j] = true;
    });
    const out = h('div', { class: 'hist-changes' });
    let k = 0;
    let hunks = 0;
    while (k < ops.length) {
      if (!show[k]) {
        let j = k;
        while (j < ops.length && !show[j]) j++;
        const n = ops.slice(k, j).filter((o) => o.text.trim()).length;
        if (n) out.append(h('div', { class: 'hist-gap' }, tn(n, '… {0} unchanged line', '… {0} unchanged lines')));
        k = j;
        continue;
      }
      // A run of shown lines forms one passage; it is introduced by its scene heading.
      hunks++;
      const head = info[k].heading;
      const box = h('div', { class: 'hist-hunk' });
      if (head && info[k].type !== 'heading') box.append(h('div', { class: 'hist-hunk-scene' }, head));
      while (k < ops.length && show[k]) {
        const op = ops[k];
        box.append(h('div', { class: `pl t-${info[k].type} ${op.kind === 'same' ? '' : op.kind}` }, info[k].shown || ' '));
        k++;
      }
      out.append(box);
    }
    if (!hunks) out.replaceChildren(h('div', { class: 'notice' }, t("The text is the same.")));
    body.append(out);
  }

  // Pages: the version as printed --------------------------------------------------------
  async function renderPages(body: HTMLElement, e: HistoryEntry, a: string, b: string, other: HistoryEntry, current: () => boolean) {
    const settings: ExportSettings = { ...(e.settings ?? projectExportSettings(app)), numbersLocked: e.settings?.numbersLocked ?? !!p!.meta.numbersLocked };
    const lines = a.replace(/\r\n?/g, '\n').split('\n');
    const fields = titleFields(lines, parse(lines, { extraPrefixes: extra }));
    const title = fields.find((f) => f.key === 'title')?.value.replace(/[*_]/g, '') || p!.name;
    const revision = markChanges ? { text: b, sceneIds: other.sceneIds, currentIds: e.sceneIds ?? [], label: '' } : undefined;
    const note = h(
      'div',
      { class: 'notice' },
      (e.settings ? t("Printed with the settings used for this export.") : t("Shown with the current print settings (versions saved before this update did not keep theirs).")) +
        (markChanges ? ' ' + t('Marks show what differs from {0}.', other.kind === 'now' ? t('the current screenplay') : `“${other.name}”`) : ''),
    );
    const pagesEl = h('div', { class: 'hist-pages' });
    body.append(note, pagesEl);
    let r: { pdf: Uint8Array; pages: number };
    try {
      r = await bridge.call('exportPdf', a, { ...settings, revHeaderNote: false }, { kind: 'all' }, { title, extraPrefixes: extra, revision });
    } catch (err: any) {
      pagesEl.replaceChildren(h('div', { class: 'notice warn' }, t("The pages could not be made: {0}", err.message)));
      return;
    }
    if (!current()) return;
    let pdfjs: any;
    try {
      pdfjs = await loadPdfjs();
    } catch {
      const url = URL.createObjectURL(new Blob([r.pdf as BlobPart], { type: 'application/pdf' }));
      pagesEl.replaceChildren(h('iframe', { src: url, style: { width: '100%', height: '100%', border: '0', background: 'white' }, title: t("Pages") }));
      return;
    }
    const doc = await pdfjs.getDocument({ data: (r.pdf as Uint8Array).slice() }).promise;
    const dpr = window.devicePixelRatio || 1;
    const b2 = Math.max(40, Math.min(100, app.state.layout.previewBrightness ?? 100));
    pagesEl.style.setProperty('--preview-b', String(b2 / 100));
    for (let i = 1; i <= doc.numPages; i++) {
      if (!current()) return;
      const page = await doc.getPage(i);
      const vp1 = page.getViewport({ scale: 1 });
      const scale = Math.max(0.3, Math.min(760, pagesEl.clientWidth - 48) / vp1.width);
      const vp = page.getViewport({ scale: scale * dpr });
      const canvas = h('canvas', { width: Math.floor(vp.width), height: Math.floor(vp.height), 'aria-label': t("Page {0}", i) });
      canvas.style.width = `${Math.floor(vp.width / dpr)}px`;
      canvas.style.height = `${Math.floor(vp.height / dpr)}px`;
      pagesEl.append(canvas, h('div', { class: 'page-label' }, `${i} / ${doc.numPages}`));
      await page.render({ canvasContext: canvas.getContext('2d')!, viewport: vp }).promise;
    }
  }

  // Actions ------------------------------------------------------------------------------
  async function rename(e: HistoryEntry) {
    const n = (await promptDialog(e.kind === 'draft' ? t('Rename draft') : t('Rename exported version'), t("Name"), e.name, { okLabel: t("Rename") }))?.trim();
    if (!n) return;
    const rec = e.kind === 'draft' ? p!.meta.drafts.find((d) => d.id === e.id) : p!.meta.exports.find((x) => x.id === e.id);
    if (!rec) return;
    rec.name = n;
    app.markMetaDirty();
    app.rightPane.historyChanged();
    await reload();
  }

  function togglePin(e: HistoryEntry) {
    const rec = e.kind === 'draft' ? p!.meta.drafts.find((d) => d.id === e.id) : p!.meta.exports.find((x) => x.id === e.id);
    if (!rec) return;
    rec.pinned = !rec.pinned || undefined;
    app.markMetaDirty();
    void reload();
  }

  async function keepAsDraft(e: HistoryEntry) {
    const n = (await promptDialog(t("Keep snapshot as draft"), t("Name"), t("Snapshot {0}", fmtDate(e.time)), { okLabel: t("Keep as Draft") }))?.trim();
    if (!n) return;
    const d = await saveTextAsDraft(app, n, await text(e));
    if (!d) return;
    toast(t("Kept as the draft “{0}”.", n));
    selKey = `draft:${d.id}`;
    await reload();
  }

  async function restore(e: HistoryEntry) {
    const label = e.kind === 'snapshot' ? `snapshot from ${fmtDate(e.time)}` : e.name;
    const ok = await confirmDialog(t("Restore version"), t("Replace the screenplay with “{0}”? Your current text is saved as a named draft first, and you can undo the restore.", label), t("Restore"));
    if (!ok) return;
    await restoreVersion(app, await text(e), label, e.sceneIds);
    textCache.delete('now');
    await reload();
  }

  async function remove(e: HistoryEntry) {
    if (e.kind === 'draft') {
      if (!(await confirmDialog(t("Delete draft"), t("Delete the draft “{0}” permanently?", e.name), t("Delete"), { danger: true }))) return;
      await bridge.call('deleteDraft', p!.rel, e.id);
      p!.meta.drafts = p!.meta.drafts.filter((x) => x.id !== e.id);
    } else {
      if (!(await confirmDialog(t("Delete exported version"), t("Delete the saved copy of “{0}”? The PDF file itself is not affected, but you can no longer mark changes since this version.", e.name), t("Delete"), { danger: true }))) return;
      await bridge.call('deleteExportCopy', p!.rel, e.id);
      p!.meta.exports = p!.meta.exports.filter((x) => x.id !== e.id);
      if (p!.meta.lastBaseline === `export:${e.id}`) p!.meta.lastBaseline = undefined;
    }
    app.markMetaDirty();
    app.rightPane.historyChanged();
    textCache.delete(e.key);
    await reload(false);
  }

  async function snapshotNow() {
    await bridge.call('snapshotProject', p!.rel, app.editor.getText(), 'manual');
    toast(t("Snapshot saved."));
    app.rightPane.historyChanged();
    await reload();
  }

  async function saveDraftNow() {
    const d = await saveDraft(app);
    if (!d) return;
    selKey = `draft:${d.id}`;
    await reload();
  }

  void reload();
  list.focus();

  return {
    close() {
      popEsc();
      token++;
      root.remove();
    },
    select(key: string) {
      if (key.startsWith('snap:') && !shownKinds(app).has('snapshot')) {
        app.state.layout.historyKinds = [...shownKinds(app), 'snapshot'];
        const fresh = kindToggles(app, () => renderList());
        seg.replaceWith(fresh);
        seg = fresh;
      }
      selKey = key;
      void reload();
    },
  };
}
