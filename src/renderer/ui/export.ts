// Export workspace: settings, presets and a preview rendered from the actual PDF.

import type { App } from '../app';
import { bridge } from '../bridge';
import { h, iconButton, debounce, uid } from './dom';
import { alertDialog, confirmDialog, promptDialog, pushEscape, toast } from './overlay';
import { ExportScope, ExportSettings, PaperSize, defaultExportSettings, normalizeExportSettings, paperLines } from '../../shared/types';
import { characterLabel, characterList, titleFields } from '../../shared/fountain';
import { capacity } from '../../shared/paginate';

type ScopeKind = 'all' | 'scenes' | 'pages' | 'scenesNewPage' | 'separate' | 'character' | 'dialogue';

export function defaultPaper(): PaperSize {
  return /^en-(US|CA)/.test(navigator.language) ? 'Letter' : 'A4';
}

/** The export settings currently stored for a project (or defaults). */
export function projectExportSettings(app: App): ExportSettings {
  return normalizeExportSettings(app.project?.meta.exportSettings, defaultPaper());
}

export interface FontEntry {
  family: string;
  mono: boolean;
  advance: number;
}
let fontList: Promise<FontEntry[]> | null = null;
/** System font families (loaded once). */
export function loadFonts(): Promise<FontEntry[]> {
  if (!fontList) fontList = bridge.call('listFonts').catch(() => [] as FontEntry[]);
  return fontList;
}

let pdfjsPromise: Promise<any> | null = null;
function loadPdfjs(): Promise<any> {
  if (!pdfjsPromise) {
    const base = new URL('./pdfjs/', document.baseURI).href;
    pdfjsPromise = import(/* @vite-ignore */ base + 'pdf.min.mjs').then((m) => {
      m.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.mjs';
      return m;
    });
    pdfjsPromise.catch(() => (pdfjsPromise = null));
  }
  return pdfjsPromise;
}

export function openExport(app: App) {
  const p = app.project;
  if (!p) return;
  const meta = p.meta;
  let s: ExportSettings = projectExportSettings(app);
  let fonts: FontEntry[] = [];
  let dialogueAction = false;
  let dialogueHeadings = true;
  let scopeKind: ScopeKind = 'all';
  // Version of this export (a copy is saved with every export) and the version to compare with.
  const stamp = new Date().toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  let versionName = '';
  let versionNote = '';
  let baseline = meta.lastBaseline ?? '';
  const baselineCache = new Map<string, { text: string; sceneIds?: string[]; label: string }>();
  let revisionInfo = '';
  const selectedScenes = new Set<number>();
  let pages = '';
  let character = '';
  const prevFocus = document.activeElement as HTMLElement | null;

  const side = h('div', { class: 'scroll' });
  const preview = h('div', { class: 'export-preview', 'aria-label': 'Preview' });
  const warnings = h('div', { class: 'warnings' });
  const cap = h('div', { class: 'capacity' });
  const revSummary = h('div', { class: 'capacity', style: { color: 'var(--text-2)' } });
  const marginsInfo = h('div', { class: 'capacity' });
  const pageInfo = h('div', { class: 'muted', style: { fontSize: '12px' } });
  const exportBtn = h('button', { class: 'btn primary', onclick: () => doExport() }, 'Export PDF…');
  const presetSel = h('select', { class: 'field', 'aria-label': 'Preset' });

  const root = h(
    'div',
    { class: 'export', role: 'dialog', 'aria-label': 'Export' },
    h(
      'div',
      { class: 'export-head' },
      h('span', { class: 'title' }, 'Export'),
      h('span', { class: 'dim' }, p.name),
      h('span', { class: 'spacer' }),
      h('span', { class: 'dim', style: { fontSize: '12px' } }, 'Preset'),
      presetSel,
      h('button', { class: 'btn', onclick: () => savePreset() }, 'Save as preset…'),
      h('button', { class: 'btn', onclick: () => deletePreset() }, 'Delete preset'),
      h('button', { class: 'btn', onclick: () => resetDefaults() }, 'Reset to defaults'),
      iconButton('close', 'Close (Esc)', () => close()),
    ),
    h('div', { class: 'export-main' }, h('div', { class: 'export-side' }, side, h('div', { class: 'foot' }, cap, warnings, pageInfo, exportBtn)), preview),
  );
  document.body.append(root);
  const popEsc = pushEscape(() => close());

  function close() {
    popEsc();
    root.remove();
    persist();
    prevFocus?.focus?.();
    if (!prevFocus || prevFocus === document.body) app.editor.focus();
  }

  function persist() {
    meta.exportSettings = s;
    app.markMetaDirty();
    app.updatePageMarkers();
  }

  function renderPresets() {
    presetSel.textContent = '';
    presetSel.append(h('option', { value: '' }, 'Current settings'));
    for (const pr of meta.exportPresets) presetSel.append(h('option', { value: pr.name }, pr.name));
    presetSel.value = '';
  }
  presetSel.addEventListener('change', () => {
    const pr = meta.exportPresets.find((x) => x.name === presetSel.value);
    if (!pr) return;
    s = normalizeExportSettings(pr.settings, s.paper);
    build();
    refresh();
  });
  async function savePreset() {
    const name = await promptDialog('Save export preset', 'Name', presetSel.value || '', { okLabel: 'Save' });
    if (!name) return;
    meta.exportPresets = [...meta.exportPresets.filter((x) => x.name !== name), { name, settings: { ...s } }];
    persist();
    renderPresets();
    presetSel.value = name;
    toast(`Preset "${name}" saved.`);
  }
  async function deletePreset() {
    const name = presetSel.value;
    if (!name) {
      toast('Choose a preset to delete.');
      return;
    }
    if (!(await confirmDialog('Delete preset', `Delete the preset "${name}"?`, 'Delete', { danger: true }))) return;
    meta.exportPresets = meta.exportPresets.filter((x) => x.name !== name);
    persist();
    renderPresets();
  }
  function resetDefaults() {
    s = defaultExportSettings(s.paper);
    build();
    refresh();
  }

  // Controls ---------------------------------------------------------------------------
  const row = (label: string, control: Node) => h('div', { class: 'form-row' }, h('label', null, label), control);
  const numIn = (key: keyof ExportSettings, min: number, max: number, step: number, unit = '') => {
    const i = h('input', { class: 'field num-in', type: 'number', min: String(min), max: String(max), step: String(step), value: String(s[key]), 'aria-label': String(key) });
    i.addEventListener('change', () => {
      const v = Math.max(min, Math.min(max, Number(i.value)));
      if (!Number.isFinite(v)) return;
      i.value = String(v);
      (s as any)[key] = v;
      changed();
    });
    return unit ? h('div', { class: 'inline', style: { display: 'flex', gap: '6px', alignItems: 'center' } }, i, h('span', { class: 'dim' }, unit)) : i;
  };
  const textIn = (key: keyof ExportSettings, placeholder = '') => {
    const i = h('input', { class: 'field', value: String(s[key] ?? ''), placeholder, 'aria-label': String(key) });
    i.addEventListener('input', () => {
      (s as any)[key] = i.value;
      changed();
    });
    return i;
  };
  const sel = (key: keyof ExportSettings, opts: Array<[string, string]>) => {
    const e = h('select', { class: 'field', 'aria-label': String(key) });
    for (const [v, l] of opts) e.append(h('option', { value: v }, l));
    e.value = String(s[key]);
    e.addEventListener('change', () => {
      (s as any)[key] = e.value;
      if (key === 'transitionAlign') {
        const scroll = side.scrollTop;
        build();
        side.scrollTop = scroll;
      }
      changed();
    });
    return e;
  };
  const chk = (key: keyof ExportSettings, label: string) => {
    const c = h('input', { type: 'checkbox', checked: !!s[key], 'aria-label': label });
    c.addEventListener('change', () => {
      (s as any)[key] = c.checked;
      changed();
    });
    return h('label', { class: 'check' }, c, label);
  };

  /** Paper choice; lines per page follow the paper when they were still the default. */
  function paperSel() {
    const e = h('select', { class: 'field', 'aria-label': 'Paper' }, h('option', { value: 'Letter' }, 'US Letter'), h('option', { value: 'A4' }, 'A4'));
    e.value = s.paper;
    e.addEventListener('change', () => {
      const untouched = s.linesPerPage === paperLines(s.paper);
      s.paper = e.value as PaperSize;
      if (untouched) s.linesPerPage = paperLines(s.paper);
      build();
      changed();
    });
    return e;
  }

  function versionNameIn() {
    const i = h('input', { class: 'field', value: versionName, placeholder: `Export ${stamp}`, 'aria-label': 'Version name' });
    i.addEventListener('input', () => (versionName = i.value));
    return i;
  }

  function versionNoteIn() {
    const t = h('textarea', { class: 'field', rows: 2, placeholder: 'e.g. Sent to the producer after the table read', 'aria-label': 'Version note' });
    t.value = versionNote;
    t.addEventListener('input', () => (versionNote = t.value));
    return t;
  }

  /** "Mark changes since" with the marking style. */
  function revisionSection() {
    const sel = h('select', { class: 'field', 'aria-label': 'Mark changes since' }, h('option', { value: '' }, 'Don’t mark changes'));
    const groups = new Map<string, HTMLElement>();
    for (const o of baselineOptions()) {
      let g = groups.get(o.group);
      if (!g) {
        g = h('optgroup', { label: o.group });
        groups.set(o.group, g);
        sel.append(g);
      }
      g.append(h('option', { value: o.value }, o.label));
    }
    if (baseline && !baselineOptions().some((o) => o.value === baseline)) baseline = '';
    sel.value = baseline;
    sel.addEventListener('change', () => {
      baseline = sel.value;
      const scroll = side.scrollTop;
      build();
      side.scrollTop = scroll;
      changed();
    });
    const color = h('input', { type: 'color', value: s.revColor.toLowerCase(), 'aria-label': 'Change color' });
    const colorHex = h('span', { class: 'dim' }, s.revColor);
    color.addEventListener('input', () => {
      s.revColor = color.value.toUpperCase();
      colorHex.textContent = s.revColor;
      changed();
    });
    const markChar = h('input', { class: 'field', value: s.revMarkChar, style: { width: '48px' }, 'aria-label': 'Margin mark character' });
    markChar.addEventListener('input', () => {
      s.revMarkChar = markChar.value;
      changed();
    });
    const marginChk = h('input', { type: 'checkbox', checked: s.revMargin, 'aria-label': 'Margin mark' });
    marginChk.addEventListener('change', () => {
      s.revMargin = marginChk.checked;
      changed();
    });
    const rows: Array<Node | null> = [row('Mark changes since', sel)];
    if (!meta.exports.length && !meta.drafts.length) rows.push(h('div', { class: 'capacity' }, 'After your first export (or once you save a named draft) you can mark what changed since then.'));
    if (baseline) {
      const base = meta.exports.find((e) => `export:${e.id}` === baseline);
      if (base?.note) rows.push(h('div', { class: 'capacity' }, `Note: ${base.note}`));
      rows.push(
        row('Color', h('div', { class: 'inline' }, color, colorHex)),
        chk('revColorText', 'Colored text'),
        chk('revHighlight', 'Highlight behind changed text'),
        chk('revUnderline', 'Underline changed text'),
        chk('revBold', 'Bold changed text'),
        row('Margin mark', h('div', { class: 'inline' }, h('label', { class: 'check' }, marginChk, 'in the right margin'), markChar)),
        chk('revIgnoreOrder', 'Ignore scene order (moved scenes are not marked)'),
        chk('revIgnoreSceneNumbers', 'Ignore changes to written scene numbers'),
        chk('revMarkDeletions', 'Mark where text was removed'),
        chk('revMarkMoved', 'Mark the headings of moved scenes'),
        chk('revChangedPagesOnly', 'Only pages with changes'),
        chk('revHeaderNote', 'Show “Changes since …” in the header'),
        revSummary,
      );
    }
    return h('section', { class: 'ex-section' }, h('h3', null, 'Mark changes'), ...rows);
  }

  /** Font menu: Courier fonts first, then system fonts after a separator. */
  function fontSel(key: 'font' | 'titleFont', monoOnly: boolean) {
    const e = h('select', { class: 'field', 'aria-label': key === 'font' ? 'Script font' : 'Title font' });
    const courier = h('optgroup', { label: 'Courier' }, h('option', { value: 'Courier Prime' }, 'Courier Prime'), h('option', { value: 'Courier' }, 'Courier (built into PDF)'));
    for (const f of fonts) if (/courier/i.test(f.family) && f.family !== 'Courier Prime' && f.family !== 'Courier') courier.append(h('option', { value: f.family }, f.family));
    e.append(courier);
    const others = fonts.filter((f) => !/courier/i.test(f.family) && (!monoOnly || f.mono));
    if (others.length) {
      const g = h('optgroup', { label: monoOnly ? 'Monospaced system fonts' : 'System fonts' });
      for (const f of others) g.append(h('option', { value: f.family }, f.family));
      e.append(g);
    }
    if (![...e.querySelectorAll('option')].some((o) => (o as HTMLOptionElement).value === s[key])) e.append(h('option', { value: s[key] }, `${s[key]} (not installed)`));
    e.value = s[key];
    e.addEventListener('change', () => {
      s[key] = e.value;
      changed();
    });
    return e;
  }

  function advance(): number {
    if (s.font === 'Courier' || s.font === 'Courier Prime') return 0.6;
    return fonts.find((f) => f.family === s.font)?.advance ?? 0.6;
  }

  function build() {
    side.textContent = '';
    const parsed = app.editor.parsed;
    // Scope
    const scopeSel = h('select', { class: 'field', 'aria-label': 'What to export' });
    for (const [v, l] of [
      ['all', 'Complete screenplay'],
      ['scenes', 'Selected scenes'],
      ['pages', 'Selected pages'],
      ['scenesNewPage', 'Each scene on a new page'],
      ['separate', 'Separate PDF for each scene'],
      ['character', 'Scenes with a character'],
      ['dialogue', 'Dialogue only'],
    ])
      scopeSel.append(h('option', { value: v }, l));
    scopeSel.value = scopeKind;
    const scopeExtra = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
    const drawScopeExtra = () => {
      scopeExtra.textContent = '';
      if (scopeKind === 'scenes') {
        const box = h('div', { class: 'scene-pick' });
        parsed.scenes.forEach((sc) => {
          const c = h('input', { type: 'checkbox', checked: selectedScenes.has(sc.line) });
          c.addEventListener('change', () => {
            if (c.checked) selectedScenes.add(sc.line);
            else selectedScenes.delete(sc.line);
            changed();
          });
          box.append(h('label', { title: sc.heading }, c, `${sc.order}. ${sc.heading}`));
        });
        const allBtn = h('button', { class: 'btn sm', onclick: () => {
          parsed.scenes.forEach((sc) => selectedScenes.add(sc.line));
          drawScopeExtra();
          changed();
        } }, 'All');
        const noneBtn = h('button', { class: 'btn sm', onclick: () => {
          selectedScenes.clear();
          drawScopeExtra();
          changed();
        } }, 'None');
        scopeExtra.append(box, h('div', { style: { display: 'flex', gap: '6px' } }, allBtn, noneBtn));
      } else if (scopeKind === 'pages') {
        const i = h('input', { class: 'field', value: pages, placeholder: 'e.g. 1-3, 7, 10-', 'aria-label': 'Pages' });
        i.addEventListener('input', () => {
          pages = i.value;
          changed();
        });
        scopeExtra.append(row('Pages', i));
      } else if (scopeKind === 'character') {
        const cs = h('select', { class: 'field', 'aria-label': 'Character' });
        const list = characterList(parsed);
        for (const c of list) cs.append(h('option', { value: c.name }, characterLabel(c)));
        if (!character && list[0]) character = list[0].name;
        cs.value = character;
        cs.addEventListener('change', () => {
          character = cs.value;
          changed();
        });
        scopeExtra.append(row('Character', cs));
      } else if (scopeKind === 'dialogue') {
        const cs = h('select', { class: 'field', 'aria-label': 'Character' }, h('option', { value: '' }, 'All characters'));
        for (const c of characterList(parsed)) cs.append(h('option', { value: c.name }, characterLabel(c)));
        cs.value = character;
        cs.addEventListener('change', () => {
          character = cs.value;
          changed();
        });
        const ha = h('input', { type: 'checkbox', checked: dialogueHeadings });
        ha.addEventListener('change', () => {
          dialogueHeadings = ha.checked;
          changed();
        });
        const aa = h('input', { type: 'checkbox', checked: dialogueAction });
        aa.addEventListener('change', () => {
          dialogueAction = aa.checked;
          changed();
        });
        scopeExtra.append(row('Character', cs), h('label', { class: 'check' }, ha, 'Scene headings'), h('label', { class: 'check' }, aa, 'Action right before each speech'));
      } else if (scopeKind === 'separate') {
        scopeExtra.append(h('div', { class: 'capacity' }, 'Each scene is written to its own PDF in a folder you choose. The preview shows all scenes.'));
      }
    };
    scopeSel.addEventListener('change', () => {
      scopeKind = scopeSel.value as ScopeKind;
      drawScopeExtra();
      changed();
    });
    drawScopeExtra();

    const unitRow = (label: string, control: Node, help?: string) => {
      const r = row(label, control);
      if (help) r.append(h('div', { class: 'help' }, help));
      return r;
    };
    const section = (title: string, ...children: Array<Node | null>) => h('section', { class: 'ex-section' }, h('h3', null, title), ...children);
    side.append(
      section(
        'This version',
        row('Name', versionNameIn()),
        row('Note', versionNoteIn()),
        h('div', { class: 'capacity' }, 'A copy of the screenplay is kept with every export, so later exports can show what changed since this one. The note is only shown in the app.'),
      ),
      section('Content', row('Export', scopeSel), scopeExtra),
      revisionSection(),
      section(
        'Paper & font',
        row('Paper', paperSel()),
        row('Script font', fontSel('font', true)),
        row('Font size', numIn('fontSize', 8, 16, 0.5, 'pt')),
        row('Line height', numIn('lineHeight', 8, 24, 0.5, 'pt')),
      ),
      section(
        'Page layout',
        row('Top margin', numIn('topMargin', 1, 20, 1, 'lines')),
        row('Lines per page', numIn('linesPerPage', 20, 90, 1, 'lines')),
        row('Left margin', numIn('leftMargin', 2, 40, 1, 'characters')),
        row('Action width', numIn('actionWidth', 30, 100, 1, 'characters')),
        marginsInfo,
      ),
      section(
        'Elements',
        h('div', { class: 'capacity' }, 'Indents count characters from the action column.'),
        row('Character cue indent', numIn('characterIndent', 0, 60, 1, 'characters')),
        row('Dialogue indent', numIn('dialogueIndent', 0, 40, 1, 'characters')),
        row('Dialogue width', numIn('dialogueWidth', 10, 80, 1, 'characters')),
        row('Parenthetical indent', numIn('parentheticalIndent', 0, 40, 1, 'characters')),
        row('Parenthetical width', numIn('parentheticalWidth', 6, 60, 1, 'characters')),
        row('Transitions', sel('transitionAlign', [['right', 'Right-aligned'], ['left', 'Indented']])),
        s.transitionAlign === 'left' ? row('Transition indent', numIn('transitionIndent', 0, 80, 1, 'characters')) : null,
        row('Between elements', numIn('elementSpacing', 0, 3, 1, 'blank lines')),
        chk('preserveBlankLines', 'Keep extra blank lines from the screenplay'),
        chk('boldCues', 'Bold character cues'),
        row('Dual dialogue', sel('dualDialogue', [['side', 'Side by side'], ['stacked', 'One after the other']])),
      ),
      section(
        'Scene headings',
        chk('boldHeadings', 'Bold'),
        chk('underlineHeadings', 'Underline'),
        row('Space before', numIn('headingSpacingBefore', 0, 4, 1, 'extra lines')),
        row('Keep with heading', numIn('headingKeepLines', 1, 6, 1, 'lines of text')),
        chk('sceneStartsNewPage', 'Start every scene on a new page'),
        row('Scene numbers', sel('sceneNumbers', [['off', 'Off'], ['left', 'Left'], ['right', 'Right'], ['both', 'Both sides']])),
        row('Number format', textIn('sceneNumberFormat', '{n}')),
        chk('autoSceneNumbers', 'Number scenes without a written #number#'),
      ),
      section(
        'Page breaks',
        row('Lines before a break', numIn('minLinesBeforeBreak', 1, 6, 1, 'at least')),
        row('Lines after a break', numIn('minLinesAfterBreak', 1, 6, 1, 'at least')),
        chk('splitDialogue', 'Split long dialogue across pages'),
        chk('splitAction', 'Split long action across pages'),
        chk('useMoreContd', 'Add (MORE) and (CONT’D) at dialogue breaks'),
        row('MORE label', textIn('moreLabel')),
        row('CONT’D label', textIn('contdLabel')),
        chk('contdAfterAction', 'CONT’D when a character continues after action'),
      ),
      section(
        'Title page',
        chk('titlePage', 'Include the title page'),
        row('Title font', fontSel('titleFont', false)),
        row('Title size', numIn('titleSize', 8, 48, 1, 'pt')),
        chk('titleBold', 'Bold title'),
        chk('titleUnderline', 'Underline title'),
        chk('titleUppercase', 'Uppercase title'),
        row('Title starts at', numIn('titleLine', 4, 50, 1, 'line')),
        row('Contact details', sel('contactPosition', [['bottom-left', 'Bottom left'], ['bottom-right', 'Bottom right']])),
        h('div', { class: 'capacity' }, 'Only the title uses the title font; credit, author and contact use 12 pt Courier.'),
      ),
      section(
        'Page numbers & furniture',
        chk('pageNumbers', 'Page numbers'),
        chk('pageNumberFirstPage', 'Number the first page'),
        row('Position', sel('pageNumberPosition', [['top-right', 'Top right'], ['bottom-center', 'Bottom center'], ['bottom-right', 'Bottom right']])),
        row('Format', textIn('pageNumberFormat', '{n}.')),
        row('Header', textIn('header', 'e.g. {title}')),
        row('Footer', textIn('footer', 'e.g. Page {page} of {pages}')),
        row('Draft date', textIn('draftDate', '')),
        row('Label', textIn('label', 'e.g. BLUE REVISION')),
        row('Watermark', textIn('watermark', '')),
        h('div', { class: 'capacity' }, 'Placeholders: {title}, {page}, {pages}, {date}.'),
      ),
      section(
        'Private material',
        chk('includeNotes', 'Include [[notes]]'),
        chk('includeSections', 'Include # sections'),
        chk('includeSynopses', 'Include = synopses'),
        h('div', { class: 'capacity' }, 'Comments, highlights, cut material and inactive alternatives are never exported.'),
      ),
    );
    void unitRow;
  }

  // Preview ------------------------------------------------------------------------------
  let renderToken = 0;
  let lastPdf: Uint8Array | null = null;

  function scope(): ExportScope {
    switch (scopeKind) {
      case 'scenes':
        return { kind: 'scenes', sceneLines: [...selectedScenes] };
      case 'pages':
        return { kind: 'pages', pages };
      case 'scenesNewPage':
        return { kind: 'scenesNewPage' };
      case 'character':
        return { kind: 'character', name: character };
      case 'dialogue':
        return { kind: 'dialogue', name: character, action: dialogueAction, headings: dialogueHeadings };
      default:
        return { kind: 'all' };
    }
  }

  function info() {
    const lines = app.editor.lineTexts;
    const fields = titleFields(lines, app.editor.parsed);
    const title = fields.find((f) => f.key === 'title')?.value.replace(/[*_]/g, '') || p!.name;
    const author = fields.find((f) => f.key === 'author' || f.key === 'authors')?.value;
    const base = baseline ? baselineCache.get(baseline) : undefined;
    const revision = base
      ? { text: base.text, sceneIds: base.sceneIds, currentIds: app.scenes.filter((x) => x.kind === 'scene').map((x) => x.id), label: `Changes since ${base.label}` }
      : undefined;
    return { title, author, extraPrefixes: app.settings.editor.extraPrefixes, revision };
  }

  /** Versions to compare with: earlier exports (newest first) and named drafts. */
  function baselineOptions(): Array<{ group: string; value: string; label: string }> {
    const fmt = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    return [
      ...meta.exports.map((e) => ({ group: 'Earlier exports', value: `export:${e.id}`, label: `${e.name} — ${fmt(e.created)}` })),
      ...meta.drafts.map((d) => ({ group: 'Named drafts', value: `draft:${d.id}`, label: `${d.name} — ${fmt(d.created)}` })),
    ];
  }

  async function loadBaseline(value: string) {
    if (!value || baselineCache.has(value)) return;
    const [kind, id] = value.split(':');
    try {
      if (kind === 'export') {
        const rec = meta.exports.find((e) => e.id === id);
        if (!rec) throw new Error('missing');
        baselineCache.set(value, { text: await bridge.call('readExportCopy', p!.rel, id), sceneIds: rec.sceneIds, label: `“${rec.name}”` });
      } else {
        const rec = meta.drafts.find((d) => d.id === id);
        if (!rec) throw new Error('missing');
        baselineCache.set(value, { text: await bridge.call('readDraft', p!.rel, id), sceneIds: rec.sceneIds, label: `“${rec.name}”` });
      }
    } catch {
      toast('The copy of that version could not be read.', { warn: true });
      baseline = '';
    }
  }

  function scopeLabel(): string {
    const map: Record<ScopeKind, string> = {
      all: 'Complete screenplay',
      scenes: 'Selected scenes',
      pages: `Pages ${pages}`,
      scenesNewPage: 'Each scene on a new page',
      separate: 'Separate scene PDFs',
      character: `Scenes with ${character}`,
      dialogue: `Dialogue${character ? ' of ' + character : ''}`,
    };
    return map[scopeKind];
  }

  /** Every export keeps a copy of the screenplay, so later versions can mark what changed. */
  async function recordExport(pagesOut: number, file?: string) {
    const id = uid();
    await bridge.call('saveExportCopy', p!.rel, id, app.editor.getText());
    meta.exports.unshift({
      id,
      name: versionName.trim() || `Export ${stamp}`,
      note: versionNote.trim(),
      created: new Date().toISOString(),
      pages: pagesOut,
      scope: scopeLabel(),
      file,
      sceneIds: app.scenes.filter((x) => x.kind === 'scene').map((x) => x.id),
      comparedWith: baseline ? baselineCache.get(baseline)?.label : undefined,
    });
    meta.lastBaseline = baseline || undefined;
    app.markMetaDirty();
    await app.saveMetaNow();
    app.rightPane.historyChanged();
  }

  const changed = () => {
    updateCapacity();
    refreshSoon();
  };

  function updateCapacity() {
    const c = capacity(s, advance());
    cap.textContent = `${c.cap.linesPerPage} lines per page · action ${c.cap.actionChars} · dialogue ${c.cap.dialogueChars} · parenthetical ${c.cap.parentheticalChars} characters per line`;
    marginsInfo.textContent = `The page holds ${c.cap.totalLines} lines × ${c.cap.totalChars} characters: ${c.cap.bottomMarginLines} lines remain at the bottom and ${c.cap.rightMarginChars} characters to the right of the action.`;
    warnings.textContent = c.warnings.join(' ');
  }

  const refreshSoon = debounce(() => refresh(), 350);

  async function refresh() {
    const token = ++renderToken;
    const sc = scope();
    if (scopeKind === 'scenes' && !selectedScenes.size) {
      preview.replaceChildren(h('div', { class: 'state' }, 'Choose at least one scene.'));
      pageInfo.textContent = '';
      exportBtn.disabled = true;
      return;
    }
    exportBtn.disabled = false;
    preview.replaceChildren(h('div', { class: 'state' }, 'Preparing preview…'));
    let r;
    try {
      if (baseline) await loadBaseline(baseline);
      r = await bridge.call('exportPdf', app.editor.getText(), s, sc, info());
    } catch (e: any) {
      if (token !== renderToken) return;
      preview.replaceChildren(h('div', { class: 'state' }, `The PDF could not be created: ${e.message}`));
      return;
    }
    if (token !== renderToken) return;
    lastPdf = r.pdf as unknown as Uint8Array;
    const extra = r.warnings.filter((w: string) => !warnings.textContent!.includes(w));
    if (extra.length) warnings.textContent = [warnings.textContent, ...extra].filter(Boolean).join(' ');
    const n = r.pages;
    pageInfo.textContent = `${n} page${n === 1 ? '' : 's'}${s.titlePage && app.editor.parsed.titleEnd > 0 && scopeKind !== 'pages' && !(baseline && s.revChangedPagesOnly) ? ' plus title page' : ''} · roughly ${n} min of screen time (estimate: one page ≈ one minute)`;
    const rv = r.revision;
    revisionInfo = rv
      ? `${rv.changedLines} marked line${rv.changedLines === 1 ? '' : 's'} on ${rv.changedPages} page${rv.changedPages === 1 ? '' : 's'}` +
        (rv.addedScenes ? ` · ${rv.addedScenes} new scene${rv.addedScenes === 1 ? '' : 's'}` : '') +
        (rv.removedScenes ? ` · ${rv.removedScenes} removed` : '') +
        (rv.movedScenes ? ` · ${rv.movedScenes} moved${s.revMarkMoved ? '' : ' (not marked)'}` : '')
      : '';
    revSummary.textContent = baseline ? revisionInfo : '';
    await renderPreview(lastPdf, token);
  }

  async function renderPreview(data: Uint8Array, token: number) {
    let pdfjs: any;
    try {
      pdfjs = await loadPdfjs();
    } catch {
      // Fallback: the browser's own PDF viewer.
      const url = URL.createObjectURL(new Blob([data as BlobPart], { type: 'application/pdf' }));
      preview.replaceChildren(h('iframe', { src: url, style: { width: '100%', height: '100%', border: '0', background: 'white' }, title: 'PDF preview' }));
      return;
    }
    const doc = await pdfjs.getDocument({ data: data.slice() }).promise;
    if (token !== renderToken) return;
    const frag: HTMLElement[] = [];
    const width = Math.min(820, preview.clientWidth - 48);
    preview.replaceChildren();
    for (let i = 1; i <= doc.numPages; i++) {
      if (token !== renderToken) return;
      const page = await doc.getPage(i);
      const vp1 = page.getViewport({ scale: 1 });
      const scale = width / vp1.width;
      const dpr = window.devicePixelRatio || 1;
      const vp = page.getViewport({ scale: scale * dpr });
      const canvas = h('canvas', { width: Math.floor(vp.width), height: Math.floor(vp.height), 'aria-label': `Page ${i}` });
      canvas.style.width = `${Math.floor(vp.width / dpr)}px`;
      canvas.style.height = `${Math.floor(vp.height / dpr)}px`;
      preview.append(canvas, h('div', { class: 'page-label' }, `${i} / ${doc.numPages}`));
      await page.render({ canvasContext: canvas.getContext('2d')!, viewport: vp }).promise;
      void frag;
    }
  }

  async function doExport() {
    await app.flush();
    const meta2 = info();
    const safe = (meta2.title || p!.name).replace(/[\\/:*?"<>|]/g, '-');
    if (scopeKind === 'separate') {
      const folder = await bridge.dialog('folder', { title: 'Choose a folder for the scene PDFs' });
      if (!folder) return;
      try {
        if (baseline) await loadBaseline(baseline);
        const r = await bridge.call('exportScenePdfs', app.editor.getText(), s, folder, info());
        await recordExport(r.files.length, folder);
        toast(`${r.files.length} scene PDFs written. A copy of this version was saved as “${meta.exports[0].name}”.`);
      } catch (e: any) {
        alertDialog('Export failed', e.message);
      }
      return;
    }
    const dest = await bridge.dialog('save', { title: 'Export PDF', defaultPath: `${safe}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (!dest) return;
    try {
      if (baseline) await loadBaseline(baseline);
      const r = await bridge.call('exportPdf', app.editor.getText(), s, scope(), info());
      const file = dest.toLowerCase().endsWith('.pdf') ? dest : dest + '.pdf';
      await bridge.call('writeFile', file, r.pdf as unknown as Uint8Array);
      persist();
      await recordExport(r.pages, file);
      toast(`Exported ${r.pages} page${r.pages === 1 ? '' : 's'}. This version was saved as “${meta.exports[0].name}” for later comparisons.`);
      versionName = '';
      versionNote = '';
      const scroll = side.scrollTop;
      build();
      side.scrollTop = scroll;
    } catch (e: any) {
      alertDialog('Export failed', e.message);
    }
  }

  renderPresets();
  loadFonts().then((f) => {
    fonts = f;
    if (root.isConnected) {
      const scroll = side.scrollTop;
      build();
      side.scrollTop = scroll;
      updateCapacity();
    }
  });
  build();
  updateCapacity();
  refresh();
  setTimeout(() => (side.querySelector('select, input') as HTMLElement | null)?.focus(), 0);
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      // Keep focus inside the export workspace.
      const f = Array.from(root.querySelectorAll<HTMLElement>('button:not([tabindex="-1"]), input, select')).filter((x) => !x.hasAttribute('disabled') && x.offsetParent !== null);
      const i = f.indexOf(document.activeElement as HTMLElement);
      const n = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : i === f.length - 1 ? 0 : i + 1;
      f[n]?.focus();
      e.preventDefault();
    }
  });
}
