// Reports: scenes, cast, locations, breakdown sheets and breakdown elements, as tables in the
// app and as PDF or CSV for the production office.

import type { App } from '../app';
import { bridge } from '../bridge';
import { h } from './dom';
import { alertDialog, promptDialog, pushEscape, toast } from './overlay';
import { ReportData, ReportDoc, buildReports, formatEighths, toCsv } from '../../shared/reports';
import { sceneNumberList } from '../../shared/scenenumbers';
import { titleFields } from '../../shared/fountain';
import { TagCategory } from '../../shared/types';
import { TAG_CATEGORIES, categoryLabel, placedTags } from './breakdown';
import { projectExportSettings } from './export';
import { t, tn, uiLocale } from '../../shared/i18n';

type Mode = 'scenes' | 'cast' | 'locations' | 'breakdown' | 'elements';

const MODES: Array<[Mode, string]> = [
  ['scenes', 'Scenes'],
  ['cast', 'Cast'],
  ['locations', 'Locations'],
  ['breakdown', 'Breakdown'],
  ['elements', 'Elements'],
];

interface Table {
  columns: Array<{ label: string; width: number; align?: 'left' | 'right' }>;
  rows: string[][];
  /** What a click on a row opens (a scene line), per row. */
  sceneLine?: Array<number | undefined>;
}

export function openReports(app: App, host: HTMLElement): { close(): void } | null {
  if (!app.project) return null;
  let mode: Mode = (app.state.layout.reportMode as Mode) ?? 'scenes';
  const body = h('div', { class: 'rep-body scroll' });
  const modeBar = h('div', { class: 'seg', role: 'tablist' });
  const info = h('span', { class: 'dim rep-info' });
  const root = h(
    'div',
    { class: 'reports', role: 'region', 'aria-label': t('Reports') },
    h(
      'div',
      { class: 'rep-head' },
      h('span', { class: 'rep-title' }, t('Reports')),
      modeBar,
      info,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => void exportCsv() }, t('Export CSV…')),
      h('button', { class: 'btn primary', onclick: () => void exportPdf() }, t('Export PDF…')),
    ),
    body,
  );
  host.append(root);
  const popEsc = pushEscape(() => app.closePanel(), false);

  for (const [m, label] of MODES) {
    const b = h('button', { class: 'seg-btn', 'data-mode': m, role: 'tab', onclick: () => setMode(m) }, t(label));
    modeBar.append(b);
  }

  function setMode(m: Mode) {
    mode = m;
    app.state.layout.reportMode = m;
    app.saveStateSoon();
    render();
  }

  let data: ReportData;
  function compute() {
    const r = app.pagination();
    const parsed = app.editor.parsed;
    const nums = sceneNumberList(parsed, app.numbersLocked);
    const cap = r?.capacity.linesPerPage ?? 55;
    data = buildReports(app.editor.lineTexts as string[], parsed, nums, r?.pages ?? [], cap, placedTags(app));
  }

  const scriptTitle = () => titleFields(app.editor.lineTexts, app.editor.parsed).find((f) => f.key === 'title')?.value.replace(/[*_]/g, '').replace(/\n/g, ' ') || app.project!.name;

  // Tables --------------------------------------------------------------------------------

  function scenesTable(): Table {
    return {
      columns: [
        { label: t('Sc.'), width: 0.06 },
        { label: t('I/E'), width: 0.08 },
        { label: t('Location'), width: 0.26 },
        { label: t('Time'), width: 0.12 },
        { label: t('Page'), width: 0.07, align: 'right' },
        { label: t('Length'), width: 0.09, align: 'right' },
        { label: t('Cast'), width: 0.32 },
      ],
      rows: data.scenes.map((s) => [s.number, s.parts.intExt, s.parts.location || s.heading, s.parts.time, s.page, formatEighths(s.eighths), [...s.speaking, ...s.silent.map((x) => `(${x})`)].join(', ')]),
      sceneLine: data.scenes.map((s) => s.line),
    };
  }

  function castTable(): Table {
    return {
      columns: [
        { label: t('Character'), width: 0.22 },
        { label: t('Scenes'), width: 0.08, align: 'right' },
        { label: t('Scene numbers'), width: 0.36 },
        { label: t('Speeches'), width: 0.1, align: 'right' },
        { label: t('Words'), width: 0.08, align: 'right' },
        { label: t('Pages'), width: 0.08, align: 'right' },
        { label: t('First page'), width: 0.08, align: 'right' },
      ],
      rows: data.cast.map((c) => [c.silent ? `${c.name} ${t('(not speaking)')}` : c.name, String(c.scenes.length), c.scenes.join(', '), String(c.speeches), String(c.words), formatEighths(c.eighths), c.first]),
    };
  }

  function locationsTable(): Table {
    return {
      columns: [
        { label: t('Location'), width: 0.3 },
        { label: t('I/E'), width: 0.1 },
        { label: t('Time'), width: 0.16 },
        { label: t('Scenes'), width: 0.08, align: 'right' },
        { label: t('Scene numbers'), width: 0.26 },
        { label: t('Pages'), width: 0.1, align: 'right' },
      ],
      rows: data.locations.map((l) => [l.location, l.intExt.join(', '), l.times.join(', '), String(l.scenes.length), l.scenes.join(', '), formatEighths(l.eighths)]),
    };
  }

  /** Every tagged element with the scenes it appears in. */
  function elements(): Array<{ category: TagCategory; name: string; scenes: string[] }> {
    const map = new Map<string, { category: TagCategory; name: string; scenes: string[] }>();
    for (const s of data.scenes)
      for (const [cat, names] of Object.entries(s.tags) as Array<[TagCategory, string[]]>)
        for (const n of names) {
          const k = `${cat}|${n.toLowerCase()}`;
          let e = map.get(k);
          if (!e) map.set(k, (e = { category: cat, name: n, scenes: [] }));
          if (!e.scenes.includes(s.number)) e.scenes.push(s.number);
        }
    const order = TAG_CATEGORIES.map((c) => c.key);
    return [...map.values()].sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category) || a.name.localeCompare(b.name));
  }

  function elementsTable(): Table {
    const els = elements();
    return {
      columns: [
        { label: t('Category'), width: 0.2 },
        { label: t('Element'), width: 0.36 },
        { label: t('Scenes'), width: 0.08, align: 'right' },
        { label: t('Scene numbers'), width: 0.36 },
      ],
      rows: els.map((e) => [categoryLabel(e.category), e.name, String(e.scenes.length), e.scenes.join(', ')]),
    };
  }

  const tableFor = (m: Mode): Table => (m === 'cast' ? castTable() : m === 'locations' ? locationsTable() : m === 'elements' ? elementsTable() : scenesTable());

  // Rendering -------------------------------------------------------------------------------

  function render() {
    compute();
    for (const b of Array.from(modeBar.children)) b.classList.toggle('on', (b as HTMLElement).dataset.mode === mode);
    body.textContent = '';
    const tags = (app.project?.meta.tags ?? []).length;
    info.textContent = [tn(data.scenes.length, '{0} scene', '{0} scenes'), t('{0} pages', formatEighths(data.totalEighths)), tags ? tn(tags, '{0} tag', '{0} tags') : ''].filter(Boolean).join(' · ');
    if (mode === 'breakdown') return renderBreakdown();
    const tb = tableFor(mode);
    if (mode === 'elements' && !tb.rows.length) {
      body.append(emptyTags());
      return;
    }
    const table = h('table', { class: 'rep-table' });
    const colgroup = h('colgroup', null, ...tb.columns.map((c) => h('col', { style: { width: `${c.width * 100}%` } })));
    table.append(colgroup, h('thead', null, h('tr', null, ...tb.columns.map((c) => h('th', { class: c.align === 'right' ? 'r' : '' }, c.label)))));
    const tbody = h('tbody');
    tb.rows.forEach((row, ri) => {
      const line = tb.sceneLine?.[ri];
      const tr = h('tr', { class: line !== undefined ? 'link' : '' }, ...row.map((v, i) => h('td', { class: tb.columns[i].align === 'right' ? 'r' : '' }, v)));
      if (line !== undefined) tr.addEventListener('click', () => goTo(line));
      if (mode === 'elements') {
        const e = elements()[ri];
        tr.title = t('Double-click to rename “{0}”', e.name);
        tr.addEventListener('dblclick', async () => {
          const name = (await promptDialog(t('Rename element'), t('Name'), e.name, { okLabel: t('Rename') }))?.trim();
          if (name && name !== e.name) {
            app.annotations.renameTag(e.category, e.name, name);
            render();
          }
        });
      }
      tbody.append(tr);
    });
    table.append(tbody);
    body.append(table);
    if (mode === 'cast' && data.cast.some((c) => c.silent)) body.append(h('div', { class: 'capacity' }, t('Characters who are introduced in action but never speak are listed as not speaking.')));
  }

  function emptyTags() {
    return h(
      'div',
      { class: 'notice rep-empty' },
      h('p', null, t('No breakdown elements yet. Select words in the script (a prop, a costume, a car) and choose Production → Tag for Breakdown, or right-click them.')),
      h('p', null, t('Cast and locations come from the screenplay by themselves.')),
    );
  }

  function renderBreakdown() {
    const list = h('div', { class: 'rep-sheets' });
    if (!(app.project?.meta.tags ?? []).length) list.append(emptyTags());
    for (const s of data.scenes) {
      const rows: Array<[string, string]> = [];
      if (s.speaking.length) rows.push([t('Cast'), s.speaking.join(', ')]);
      if (s.silent.length) rows.push([t('Also in the scene'), s.silent.join(', ')]);
      for (const c of TAG_CATEGORIES) {
        const items = s.tags[c.key];
        if (items?.length) rows.push([t(c.label), items.join(', ')]);
      }
      const card = h(
        'div',
        { class: 'rep-sheet' },
        h(
          'div',
          { class: 'rep-sheet-head link', onclick: () => goTo(s.line) },
          h('span', { class: 'num' }, s.number),
          h('span', { class: 'heading' }, s.heading.toUpperCase()),
          h('span', { class: 'dim' }, [s.page ? t('page {0}', s.page) : '', formatEighths(s.eighths)].filter(Boolean).join(' · ')),
        ),
        ...rows.map(([k, v]) => {
          const cat = TAG_CATEGORIES.find((c) => t(c.label) === k);
          return h('div', { class: 'rep-sheet-row' }, h('span', { class: 'k' }, cat ? h('span', { class: 'dot', style: { background: cat.color } }) : null, k), h('span', { class: 'v' }, v));
        }),
      );
      list.append(card);
    }
    body.append(list);
  }

  function goTo(line: number) {
    const it = app.scenes.find((x) => x.kind === 'scene' && x.line === line);
    app.closePanel(false);
    if (it) app.goToScene(it, { focusEditor: true });
  }

  // Export ----------------------------------------------------------------------------------

  const modeLabel = () => t(MODES.find((m) => m[0] === mode)![1]);
  const stamp = () => new Date().toLocaleDateString(uiLocale(), { day: 'numeric', month: 'short', year: 'numeric' });

  function reportDoc(): ReportDoc {
    const title = scriptTitle();
    if (mode === 'breakdown') {
      return {
        title,
        subtitle: `${t('Breakdown')} · ${stamp()}`,
        sections: data.scenes.map((s) => {
          const lines: Array<{ label?: string; text: string }> = [];
          if (s.speaking.length) lines.push({ label: t('Cast'), text: s.speaking.join(', ') });
          if (s.silent.length) lines.push({ label: t('Also in the scene'), text: s.silent.join(', ') });
          for (const c of TAG_CATEGORIES) if (s.tags[c.key]?.length) lines.push({ label: t(c.label), text: s.tags[c.key]!.join(', ') });
          if (!lines.length) lines.push({ text: '—' });
          return { heading: `${s.number}  ${s.heading.toUpperCase()}   (${[s.page ? t('page {0}', s.page) : '', formatEighths(s.eighths)].filter(Boolean).join(' · ')})`, lines, keep: true };
        }),
      };
    }
    const tb = tableFor(mode);
    const rows = tb.rows.slice();
    const bold: number[] = [];
    if (mode === 'scenes') {
      rows.push(['', '', t('Total'), '', '', formatEighths(data.totalEighths), '']);
      bold.push(rows.length - 1);
    }
    return { title, subtitle: `${modeLabel()} · ${stamp()}`, sections: [{ table: { columns: tb.columns, rows, boldRows: bold } }] };
  }

  async function exportPdf() {
    const safe = scriptTitle().replace(/[\\/:*?"<>|]/g, '-');
    const dest = await bridge.dialog('save', { title: t('Export PDF'), defaultPath: `${safe} - ${modeLabel()}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (!dest) return;
    try {
      const pdf = await bridge.call('exportReportPdf', reportDoc(), projectExportSettings(app).paper);
      await bridge.call('writeFile', dest.toLowerCase().endsWith('.pdf') ? dest : dest + '.pdf', pdf as unknown as Uint8Array);
      toast(t('Report saved.'));
    } catch (e: any) {
      alertDialog(t('Export failed'), e.message);
    }
  }

  async function exportCsv() {
    const safe = scriptTitle().replace(/[\\/:*?"<>|]/g, '-');
    const dest = await bridge.dialog('save', { title: t('Export CSV'), defaultPath: `${safe} - ${modeLabel()}.csv`, filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (!dest) return;
    let rows: string[][];
    if (mode === 'breakdown') {
      // One row per scene with a column per category: opens in any spreadsheet.
      const cats = TAG_CATEGORIES.filter((c) => data.scenes.some((s) => s.tags[c.key]?.length));
      rows = [
        [t('Scene'), t('I/E'), t('Location'), t('Time'), t('Page'), t('Eighths'), t('Cast'), t('Also in the scene'), ...cats.map((c) => t(c.label))],
        ...data.scenes.map((s) => [s.number, s.parts.intExt, s.parts.location, s.parts.time, s.page, String(s.eighths), s.speaking.join(', '), s.silent.join(', '), ...cats.map((c) => (s.tags[c.key] ?? []).join(', '))]),
      ];
    } else {
      const tb = tableFor(mode);
      rows = [tb.columns.map((c) => c.label), ...tb.rows];
    }
    try {
      await bridge.call('writeFile', dest.toLowerCase().endsWith('.csv') ? dest : dest + '.csv', toCsv(rows));
      toast(t('Report saved.'));
    } catch (e: any) {
      alertDialog(t('Export failed'), e.message);
    }
  }

  render();
  return {
    close() {
      popEsc();
      root.remove();
    },
  };
}
