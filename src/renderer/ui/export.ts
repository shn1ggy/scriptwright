// Export workspace: settings, presets and a preview rendered from the actual PDF.

import type { App } from '../app';
import { bridge } from '../bridge';
import { formatCombo } from '../commands';
import { h, debounce, icon, uid } from './dom';
import { alertDialog, confirmDialog, promptDialog, pushEscape, toast } from './overlay';
import { ExportScope, ExportSettings, PaperSize, ScriptLanguage, defaultExportSettings, normalizeExportSettings, paperLines } from '../../shared/types';
import { characterLabel, characterList, titleFields } from '../../shared/fountain';
import { capacity } from '../../shared/paginate';
import { sceneNumberList } from '../../shared/scenenumbers';
import { t, tn, uiLocale } from '../../shared/i18n';
import { lockPages, nextRevision, productionInfo, productionSummary, roundName, unlockPages } from './production';

type ScopeKind = 'all' | 'scenes' | 'pages' | 'scenesNewPage' | 'separate' | 'character' | 'dialogue' | 'sides';

export function defaultPaper(): PaperSize {
  return /^en-(US|CA)/.test(navigator.language) ? 'Letter' : 'A4';
}

/** Language of the screenplay (for labels like (MORE)): German scene headings, else the system language. */
export function scriptLanguage(app: App): ScriptLanguage {
  const text = app.editor?.lines?.slice(0, 4000).map((l: { text: string }) => l.text).join('\n') ?? '';
  if (/^\.?(INNEN|AUSSEN|AUẞEN|AUSSEN\/INNEN|INNEN\/AUSSEN|INT\.?\/EXT|I\/A)\b/m.test(text)) return 'de';
  if (/^\.?(INT|EXT|EST)[\s.]/m.test(text)) return 'en';
  return /^de\b/.test(navigator.language) ? 'de' : 'en';
}

/** The export settings currently stored for a project (or defaults). */
export function projectExportSettings(app: App): ExportSettings {
  const lang = scriptLanguage(app);
  // German scripts are printed on A4 even on a computer set up for US English.
  return { ...normalizeExportSettings(app.project?.meta.exportSettings, lang === 'de' ? 'A4' : defaultPaper(), lang), numbersLocked: !!app.project?.meta.numbersLocked };
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
export function loadPdfjs(): Promise<any> {
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

/**
 * The Export tab: settings on the left, the real PDF as preview on the right. It is shown
 * inside `host` (below the tab bar, over the panes) and closed by the app when another tab
 * is chosen.
 */
export interface ExportPreset {
  /** Start with the dialogue of one character ('' = all characters). */
  dialogue?: { character: string; action: boolean };
  /** Start with sides (of the scenes selected in the scene list, if any). */
  sides?: boolean;
}

export function openExport(app: App, host: HTMLElement, preset: ExportPreset = {}): { close(): void } | null {
  const p = app.project;
  if (!p) return null;
  const meta = p.meta;
  let s: ExportSettings = projectExportSettings(app);
  let fonts: FontEntry[] = [];
  let dialogueAction = preset.dialogue?.action ?? false;
  let dialogueHeadings = true;
  let scopeKind: ScopeKind = preset.dialogue ? 'dialogue' : preset.sides ? 'sides' : 'all';
  // Version of this export (a copy is saved with every export) and the version to compare with.
  const stamp = new Date().toLocaleString(uiLocale(), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  let versionName = '';
  let versionNote = '';
  // With locked pages, revision marks come from the production rounds unless chosen otherwise.
  let baseline = meta.lastBaseline ?? (meta.production ? 'production' : '');
  if (baseline === 'production' && !meta.production) baseline = '';
  const baselineCache = new Map<string, { text: string; sceneIds?: string[]; label: string }>();
  let revisionInfo = '';
  const selectedScenes = new Set<number>();
  if (preset.sides) for (const it of app.scenes) if (it.kind === 'scene' && app.sceneSel.has(it.id)) selectedScenes.add(it.line);
  let sidesCover = true;
  let sidesDay = '';
  let pages = '';
  let character = preset.dialogue?.character ?? '';
  const prevFocus = document.activeElement as HTMLElement | null;

  const side = h('div', { class: 'scroll' });
  const preview = h('div', { class: 'export-preview', 'aria-label': t("Preview") });
  // Preview zoom: 'fit' fits the page width; a number is the size relative to the printed page.
  let zoom: number | 'fit' = 'fit';
  const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
  let previewDoc: any = null;
  let previewToken = 0;
  const zoomLabel = h('button', { class: 'btn sm zoom-label', title: t("Fit to width"), onclick: () => setZoom('fit') }, t("Fit"));
  const zoomBar = h(
    'div',
    { class: 'zoom-bar' },
    h('button', { class: 'icon-btn', title: t("Zoom out ({0})", formatCombo('Mod+-')), 'aria-label': t("Zoom out"), onclick: () => stepZoom(-1) }, '−'),
    zoomLabel,
    h('button', { class: 'icon-btn', title: t("Zoom in ({0})", formatCombo('Mod+=')), 'aria-label': t("Zoom in"), onclick: () => stepZoom(1) }, '+'),
  );
  const previewWrap = h('div', { class: 'export-preview-wrap' }, preview, zoomBar);
  const warnings = h('div', { class: 'warnings' });
  const cap = h('div', { class: 'capacity' });
  const revSummary = h('div', { class: 'capacity', style: { color: 'var(--text-2)' } });
  const marginsInfo = h('div', { class: 'capacity' });
  const pageInfo = h('div', { class: 'muted', style: { fontSize: '12px' } });
  const exportBtn = h('button', { class: 'btn primary', onclick: () => doExport() }, t("Export PDF…"));
  const presetSel = h('select', { class: 'field', 'aria-label': t("Preset") });

  const root = h(
    'div',
    { class: 'export', role: 'region', 'aria-label': t("Export") },
    h(
      'div',
      { class: 'export-head' },
      (() => {
        // A white page is very bright next to a dark theme: dim the preview (not the PDF).
        const b = Math.max(40, Math.min(100, app.state.layout.previewBrightness ?? 100));
        const range = h('input', { type: 'range', min: '40', max: '100', step: '1', value: String(b), 'aria-label': t("Preview brightness"), title: t("Brightness of the preview page (the PDF is not changed)") });
        const apply = () => preview.style.setProperty('--preview-b', String(Number(range.value) / 100));
        range.addEventListener('input', () => {
          apply();
          app.state.layout.previewBrightness = Number(range.value);
          app.saveStateSoon();
        });
        apply();
        return h('label', { class: 'preview-dim' }, h('span', null, t("Preview brightness")), range);
      })(),
      h('span', { class: 'spacer' }),
      h('span', { class: 'dim', style: { fontSize: '12px' } }, t("Preset")),
      presetSel,
      h('button', { class: 'btn', onclick: () => savePreset() }, t("Save as preset…")),
      h('button', { class: 'btn', onclick: () => deletePreset() }, t("Delete preset")),
      h('button', { class: 'btn', onclick: () => resetDefaults() }, t("Reset to defaults")),
    ),
    h('div', { class: 'export-main' }, h('div', { class: 'export-side' }, side, h('div', { class: 'foot' }, cap, warnings, pageInfo, exportBtn)), previewWrap),
  );
  host.append(root);
  // Esc goes back to writing, like leaving any other tab.
  const popEsc = pushEscape(() => app.closePanel(), false);
  void prevFocus;

  const closers: Array<() => void> = [];
  function close() {
    popEsc();
    for (const c of closers) c();
    root.remove();
    persist();
  }

  /** Current settings plus the project's scene number lock (not stored with the settings). */
  const withLock = (): ExportSettings => ({ ...s, numbersLocked: !!app.project?.meta.numbersLocked });

  function persist() {
    meta.exportSettings = s;
    app.markMetaDirty();
    app.updatePageMarkers();
  }

  // Presets belong to the workspace (all projects). Presets a project kept on its own (from
  // earlier versions) move there the first time its Export tab opens.
  const presets = () => app.settings.exportPresets;
  if (meta.exportPresets?.length) {
    const have = new Set(presets().map((x) => x.name));
    app.settings.exportPresets = [...presets(), ...meta.exportPresets.filter((x) => !have.has(x.name))];
    meta.exportPresets = [];
    app.markMetaDirty();
    app.saveSettings();
  }
  const setPresets = (list: typeof meta.exportPresets) => {
    app.settings.exportPresets = list;
    app.saveSettings();
  };

  // The chosen preset is remembered by the project. When the settings no longer match it,
  // the menu says "changed", so it is clear the preset could be saved again.
  const plainOf = (x: ExportSettings) => {
    const { numbersLocked: _nl, ...rest } = normalizeExportSettings(x, s.paper, scriptLanguage(app));
    return JSON.stringify(rest);
  };
  const presetChanged = () => {
    const pr = presets().find((x) => x.name === meta.exportPresetName);
    return !!pr && plainOf(pr.settings) !== plainOf(s);
  };
  function renderPresets() {
    presetSel.textContent = '';
    presetSel.append(h('option', { value: '' }, t("No preset")));
    const current = meta.exportPresetName && presets().some((x) => x.name === meta.exportPresetName) ? meta.exportPresetName : '';
    const changed = presetChanged();
    for (const pr of presets()) presetSel.append(h('option', { value: pr.name }, pr.name === current && changed ? t("{0} (changed)", pr.name) : pr.name));
    presetSel.value = current;
    presetSel.classList.toggle('changed', !!current && changed);
    presetSel.title = current && changed ? t("The settings differ from this preset. Save as preset… to keep them.") : '';
  }
  presetSel.addEventListener('change', () => {
    const name = presetSel.value;
    meta.exportPresetName = name || undefined;
    app.markMetaDirty();
    const pr = presets().find((x) => x.name === name);
    if (pr) {
      s = normalizeExportSettings(pr.settings, s.paper, scriptLanguage(app));
      build();
      persist();
      refresh();
    }
    renderPresets();
  });
  async function savePreset() {
    const name = (await promptDialog(t("Save export preset"), t("Name"), presetSel.value || '', { okLabel: t("Save") }))?.trim();
    if (!name) return;
    if (presets().some((x) => x.name === name) && !(await confirmDialog(t("Replace preset"), t("A preset named \"{0}\" already exists. Replace it with the current settings?", name), t("Replace")))) return;
    const { numbersLocked: _nl, ...plain } = s;
    setPresets([...presets().filter((x) => x.name !== name), { name, settings: plain as ExportSettings }]);
    meta.exportPresetName = name;
    app.markMetaDirty();
    renderPresets();
    toast(t("Preset \"{0}\" saved.", name));
  }
  async function deletePreset() {
    const name = presetSel.value;
    if (!name) {
      toast(t("Choose a preset to delete."));
      return;
    }
    if (!(await confirmDialog(t("Delete preset"), t("Delete the preset \"{0}\"?", name), t("Delete"), { danger: true }))) return;
    setPresets(presets().filter((x) => x.name !== name));
    meta.exportPresetName = undefined;
    app.markMetaDirty();
    renderPresets();
  }
  function resetDefaults() {
    s = defaultExportSettings(s.paper, scriptLanguage(app));
    build();
    refresh();
  }

  // Controls ---------------------------------------------------------------------------
  const row = (label: string, control: Node) => h('div', { class: 'form-row' }, h('label', null, label), control);
  const numIn = (key: keyof ExportSettings, min: number, max: number, step: number, unit = '') => {
    const i = h('input', { class: 'field num-in', type: 'number', min: String(min), max: String(max), step: step ? String(step) : 'any', value: String(s[key]), 'aria-label': String(key) });
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
    for (const [v, l] of opts) e.append(h('option', { value: v }, t(l)));
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
    const e = h('select', { class: 'field', 'aria-label': t("Paper") }, h('option', { value: 'Letter' }, t("US Letter")), h('option', { value: 'A4' }, 'A4'));
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
    const i = h('input', { class: 'field', value: versionName, placeholder: t("Export {0}", stamp), 'aria-label': t("Version name") });
    i.addEventListener('input', () => (versionName = i.value));
    return i;
  }

  function versionNoteIn() {
    const ta = h('textarea', { class: 'field', rows: 2, placeholder: t("e.g. Sent to the producer after the table read"), 'aria-label': t("Version note") });
    ta.value = versionNote;
    ta.addEventListener('input', () => (versionNote = ta.value));
    return ta;
  }

  /** "Mark changes since" with the marking style. */
  /**
   * A settings group that folds open and closed by its heading. Which groups are open is
   * remembered; the everyday ones start open.
   */
  /** `title` is the English name: it is the key for the remembered state and shown translated. */
  function collapsible(title: string, ...children: Array<Node | null>): HTMLElement {
    const l = app.state.layout;
    const open = new Set(l.exportOpen ?? ['This version', 'Content', 'Production', 'Mark changes']);
    const isOpen = open.has(title);
    const body = h('div', { class: 'ex-body' }, ...children);
    const head = h('button', { class: 'ex-head', 'aria-expanded': String(isOpen) }, h('span', null, t(title)), h('span', { class: 'collapse-mark' }, icon(isOpen ? 'chevronDown' : 'chevronRight')));
    const sec = h('section', { class: `ex-section${isOpen ? '' : ' folded'}` }, head, body);
    head.addEventListener('click', () => {
      const now = new Set(app.state.layout.exportOpen ?? ['This version', 'Content', 'Production', 'Mark changes']);
      const opening = !now.has(title);
      if (opening) now.add(title);
      else now.delete(title);
      app.state.layout.exportOpen = [...now];
      app.saveStateSoon();
      sec.classList.toggle('folded', !opening);
      head.setAttribute('aria-expanded', String(opening));
      head.querySelector('.collapse-mark')!.replaceChildren(icon(opening ? 'chevronDown' : 'chevronRight'));
    });
    return sec;
  }

  /** Locked pages and revision rounds. */
  function productionSection() {
    const pr = meta.production;
    const again = () => {
      const scroll = side.scrollTop;
      if (meta.production && !baseline) baseline = 'production';
      if (!meta.production && baseline === 'production') baseline = '';
      build();
      side.scrollTop = scroll;
      changed();
    };
    if (!pr) {
      return collapsible(
        'Production',
        h('div', { class: 'capacity' }, t("Once a script goes into production, lock its pages: page numbers stay as printed, new material goes on A pages, and every round of changes gets the next revision colour.")),
        h('div', { class: 'settings-actions' }, h('button', { class: 'btn', onclick: async () => { await lockPages(app); again(); } }, t("Lock pages…"))),
      );
    }
    const next = roundName(pr.rounds.length + 1);
    return collapsible(
      'Production',
      h('div', { class: 'capacity' }, productionSummary(app)),
      h(
        'div',
        { class: 'settings-actions' },
        h('button', { class: 'btn', onclick: async () => { await nextRevision(app); again(); } }, t("Start {0} revision…", next)),
        h('button', { class: 'btn', onclick: async () => { await unlockPages(app); again(); } }, t("Unlock pages…")),
      ),
      h('div', { class: 'capacity' }, t("Keep the layout settings as they were when the pages were locked; otherwise pages move to A pages.")),
    );
  }

  function revisionSection() {
    const sel = h('select', { class: 'field', 'aria-label': t("Mark changes since") }, h('option', { value: '' }, t("Don’t mark changes")));
    if (meta.production) sel.append(h('optgroup', { label: t('Production') }, h('option', { value: 'production' }, t("Revisions (current: {0})", roundName(meta.production.rounds.length).toLowerCase()))));
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
    if (baseline && baseline !== 'production' && !baselineOptions().some((o) => o.value === baseline)) baseline = '';
    if (baseline === 'production' && !meta.production) baseline = '';
    sel.value = baseline;
    sel.addEventListener('change', () => {
      baseline = sel.value;
      const scroll = side.scrollTop;
      build();
      side.scrollTop = scroll;
      changed();
    });
    const color = h('input', { type: 'color', value: s.revColor.toLowerCase(), 'aria-label': t("Change color") });
    const colorHex = h('span', { class: 'dim' }, s.revColor);
    color.addEventListener('input', () => {
      s.revColor = color.value.toUpperCase();
      colorHex.textContent = s.revColor;
      changed();
    });
    const markChar = h('input', { class: 'field', value: s.revMarkChar, style: { width: '48px' }, 'aria-label': t("Margin mark character") });
    markChar.addEventListener('input', () => {
      s.revMarkChar = markChar.value;
      changed();
    });
    const marginChk = h('input', { type: 'checkbox', checked: s.revMargin, 'aria-label': t("Margin mark") });
    marginChk.addEventListener('change', () => {
      s.revMargin = marginChk.checked;
      changed();
    });
    const rows: Array<Node | null> = [row(t("Mark changes since"), sel)];
    if (!meta.exports.length && !meta.drafts.length && !meta.production) rows.push(h('div', { class: 'capacity' }, t("After your first export (or once you save a named draft) you can mark what changed since then.")));
    if (baseline === 'production') {
      rows.push(
        chk('revAllRounds', t("Asterisks for every round (not only the current one)")),
        chk('revChangedPagesOnly', t("Only pages changed in this round")),
        chk('revHeaderNote', t("Revision colour and date in the page header")),
        chk('revTintPages', t("Revised pages in their colour (for reading on screen)")),
        row(t("Margin mark"), h('div', { class: 'inline' }, h('label', { class: 'check' }, marginChk, t("in the right margin")), markChar)),
        chk('revProdColor', t("Changes in colour (productions print black)")),
        row(t("Color"), h("div", { class: "inline" }, color, colorHex)),
        chk('revIgnoreOrder', t("Ignore scene order (moved scenes are not marked)")),
        chk('revMarkDeletions', t("Mark where text was removed")),
        revSummary,
      );
    } else if (baseline) {
      const base = meta.exports.find((e) => `export:${e.id}` === baseline);
      if (base?.note) rows.push(h('div', { class: 'capacity' }, t("Note: {0}", base.note)));
      rows.push(
        row(t("Color"), h('div', { class: 'inline' }, color, colorHex)),
        chk('revColorText', t("Colored text")),
        chk('revHighlight', t("Highlight behind changed text")),
        chk('revUnderline', t("Underline changed text")),
        chk('revBold', t("Bold changed text")),
        row(t("Margin mark"), h('div', { class: 'inline' }, h('label', { class: 'check' }, marginChk, t("in the right margin")), markChar)),
        chk('revIgnoreOrder', t("Ignore scene order (moved scenes are not marked)")),
        chk('revIgnoreSceneNumbers', t("Ignore changes to written scene numbers")),
        chk('revMarkDeletions', t("Mark where text was removed")),
        chk('revMarkMoved', t("Mark the headings of moved scenes")),
        chk('revChangedPagesOnly', t("Only pages with changes")),
        chk('revHeaderNote', t("Header note on every page")),
        row(t("Note text"), textIn('revHeaderText', t("Changes since {version}"))),
        h('div', { class: 'capacity' }, t("{version} is replaced by the name of the version compared with.")),
        revSummary,
      );
    }
    return collapsible('Mark changes', ...rows);
  }

  /** Font menu: Courier fonts first, then system fonts after a separator. */
  function fontSel(key: 'font' | 'titleFont', monoOnly: boolean) {
    const e = h('select', { class: 'field', 'aria-label': key === 'font' ? t("Script font") : t("Title font") });
    const courier = h('optgroup', { label: t("Courier") }, h('option', { value: 'Courier Prime' }, t("Courier Prime")), h('option', { value: 'Courier' }, t("Courier (built into PDF)")));
    for (const f of fonts) if (/courier/i.test(f.family) && f.family !== 'Courier Prime' && f.family !== 'Courier') courier.append(h('option', { value: f.family }, f.family));
    e.append(courier);
    const others = fonts.filter((f) => !/courier/i.test(f.family) && (!monoOnly || f.mono));
    if (others.length) {
      const g = h('optgroup', { label: monoOnly ? t("Monospaced system fonts") : t("System fonts") });
      for (const f of others) g.append(h('option', { value: f.family }, f.family));
      e.append(g);
    }
    if (![...e.querySelectorAll('option')].some((o) => (o as HTMLOptionElement).value === s[key])) e.append(h('option', { value: s[key] }, t("{0} (not installed)", s[key])));
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
    const scopeSel = h('select', { class: 'field', 'aria-label': t("What to export") });
    for (const [v, l] of [
      ['all', 'Complete screenplay'],
      ['scenes', 'Selected scenes'],
      ['pages', 'Selected pages'],
      ['scenesNewPage', 'Each scene on a new page'],
      ['separate', 'Separate PDF for each scene'],
      ['character', 'Scenes with a character'],
      ['dialogue', 'Dialogue only'],
      ['sides', 'Sides'],
    ])
      scopeSel.append(h('option', { value: v }, t(l)));
    scopeSel.value = scopeKind;
    const scopeExtra = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
    const drawScopeExtra = () => {
      scopeExtra.textContent = '';
      if (scopeKind === 'scenes' || scopeKind === 'sides') {
        const box = h('div', { class: 'scene-pick' });
        const nums = sceneNumberList(parsed, !!meta.numbersLocked);
        parsed.scenes.forEach((sc, si) => {
          const c = h('input', { type: 'checkbox', checked: selectedScenes.has(sc.line) });
          c.addEventListener('change', () => {
            if (c.checked) selectedScenes.add(sc.line);
            else selectedScenes.delete(sc.line);
            changed();
          });
          box.append(h('label', { title: sc.heading }, c, `${nums[si]}. ${sc.heading}`));
        });
        const allBtn = h('button', { class: 'btn sm', onclick: () => {
          parsed.scenes.forEach((sc) => selectedScenes.add(sc.line));
          drawScopeExtra();
          changed();
        } }, t("All"));
        const noneBtn = h('button', { class: 'btn sm', onclick: () => {
          selectedScenes.clear();
          drawScopeExtra();
          changed();
        } }, t("None"));
        scopeExtra.append(box, h('div', { style: { display: 'flex', gap: '6px' } }, allBtn, noneBtn));
        if (scopeKind === 'sides') {
          const cover = h('input', { type: 'checkbox', checked: sidesCover });
          cover.addEventListener('change', () => {
            sidesCover = cover.checked;
            changed();
          });
          const day = h('input', { class: 'field', value: sidesDay, placeholder: t('e.g. Day 3 · Thu 16 Oct'), 'aria-label': t('Shooting day') });
          day.addEventListener('input', () => {
            sidesDay = day.value;
            changed();
          });
          scopeExtra.append(
            h('label', { class: 'check' }, cover, t('Cover sheet with scenes, lengths and cast')),
            row(t('Shooting day'), day),
            h('div', { class: 'capacity' }, t('The pages with these scenes as they are in the script (with their page numbers); everything else on them is struck through.')),
          );
        }
      } else if (scopeKind === 'pages') {
        const i = h('input', { class: 'field', value: pages, placeholder: 'e.g. 1-3, 7, 10-', 'aria-label': t("Pages") });
        i.addEventListener('input', () => {
          pages = i.value;
          changed();
        });
        scopeExtra.append(row(t("Pages"), i));
      } else if (scopeKind === 'character') {
        const cs = h('select', { class: 'field', 'aria-label': t("Character") });
        const list = characterList(parsed);
        for (const c of list) cs.append(h('option', { value: c.name }, characterLabel(c)));
        if (!character && list[0]) character = list[0].name;
        cs.value = character;
        cs.addEventListener('change', () => {
          character = cs.value;
          changed();
        });
        scopeExtra.append(row(t("Character"), cs));
      } else if (scopeKind === 'dialogue') {
        const cs = h('select', { class: 'field', 'aria-label': t("Character") }, h('option', { value: '' }, t("All characters")));
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
        scopeExtra.append(row(t("Character"), cs), h('label', { class: 'check' }, ha, t("Scene headings")), h('label', { class: 'check' }, aa, t("Action right before each speech")));
      } else if (scopeKind === 'separate') {
        scopeExtra.append(h('div', { class: 'capacity' }, t("Each scene is written to its own PDF in a folder you choose. The preview shows all scenes.")));
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
    const section = collapsible;
    side.append(
      section(
        'This version',
        row(t("Name"), versionNameIn()),
        row(t("Note"), versionNoteIn()),
        h('div', { class: 'capacity' }, t("A copy of the screenplay is kept with every export, so later exports can show what changed since this one. The note is only shown in the app.")),
      ),
      section('Content', row(t("Export"), scopeSel), scopeExtra),
      productionSection(),
      revisionSection(),
      section(
        'Paper & font',
        row(t("Paper"), paperSel()),
        row(t("Script font"), fontSel('font', true)),
        row(t("Font size"), numIn('fontSize', 8, 16, 0.5, t("pt"))),
        row(t("Line height"), numIn('lineHeight', 8, 24, 0, t("pt"))),
      ),
      section(
        'Page layout',
        row(t("Top margin"), numIn('topMarginPt', 18, 216, 1, t("pt"))),
        row(t("Lines per page"), numIn('linesPerPage', 20, 90, 1, t("lines"))),
        row(t("Left margin"), numIn('leftMargin', 2, 40, 0.5, t("characters"))),
        row(t("Action width"), numIn('actionWidth', 30, 100, 1, t("characters"))),
        marginsInfo,
      ),
      section(
        'Elements',
        h('div', { class: 'capacity' }, t("Indents count characters from the action column.")),
        row(t("Character cue indent"), numIn('characterIndent', 0, 60, 0.5, t("characters"))),
        row(t("Dialogue indent"), numIn('dialogueIndent', 0, 40, 0.5, t("characters"))),
        row(t("Dialogue width"), numIn('dialogueWidth', 10, 80, 1, t("characters"))),
        row(t("Parenthetical indent"), numIn('parentheticalIndent', 0, 40, 0.5, t("characters"))),
        row(t("Parenthetical width"), numIn('parentheticalWidth', 6, 60, 1, t("characters"))),
        row(t("Transitions"), sel('transitionAlign', [['right', 'Right-aligned'], ['left', 'Indented']])),
        s.transitionAlign === 'left' ? row(t("Transition indent"), numIn('transitionIndent', 0, 80, 1, t("characters"))) : null,
        row(t("Between elements"), numIn('elementSpacing', 0, 3, 1, t("blank lines"))),
        chk('preserveBlankLines', t("Keep extra blank lines from the screenplay")),
        chk('boldCues', t("Bold character cues")),
        row(t("Dual dialogue"), sel('dualDialogue', [['side', 'Side by side'], ['stacked', 'One after the other']])),
      ),
      section(
        'Scene headings',
        chk('boldHeadings', t("Bold")),
        chk('underlineHeadings', t("Underline")),
        row(t("Space before"), numIn('headingSpacingBefore', 0, 4, 1, t("extra lines"))),
        row(t("Keep with heading"), numIn('headingKeepLines', 1, 6, 1, t("lines of text"))),
        chk('sceneStartsNewPage', t("Start every scene on a new page")),
        row(t("Scene numbers"), sel('sceneNumbers', [['off', 'Off'], ['left', 'Left'], ['right', 'Right'], ['both', 'Both sides']])),
        row(t("Number format"), textIn('sceneNumberFormat', '{n}')),
        row(t("Left number gap"), numIn('sceneNumberLeftGap', 0, 10, 1, t("characters"))),
        row(t("Right number gap"), numIn('sceneNumberRightGap', 0, 10, 1, t("characters"))),
        chk('autoSceneNumbers', t("Number scenes without a written #number#")),
      ),
      section(
        'Page breaks',
        row(t("Lines before a break"), numIn('minLinesBeforeBreak', 1, 6, 1, t("at least"))),
        row(t("Lines after a break"), numIn('minLinesAfterBreak', 1, 6, 1, t("at least"))),
        chk('splitDialogue', t("Split long dialogue across pages")),
        chk('splitAction', t("Split long action across pages")),
        chk('dialogueSentenceBreaks', t("Break dialogue only at the end of a sentence")),
        chk('useMoreContd', t("Add (MORE) and (CONT’D) at dialogue breaks")),
        row(t("MORE label"), textIn('moreLabel')),
        row(t("CONT’D label"), textIn('contdLabel')),
        chk('contdAfterAction', t("CONT’D when a character continues after action")),
      ),
      section(
        'Title page',
        chk('titlePage', t("Include the title page")),
        row(t("Title font"), fontSel('titleFont', false)),
        row(t("Title size"), numIn('titleSize', 8, 96, 1, t("pt"))),
        row(t("Letter spacing"), numIn('titleTracking', 0, 200, 5, t("% of the size"))),
        chk('titleBold', t("Bold title")),
        chk('titleUnderline', t("Underline title")),
        chk('titleUppercase', t("Uppercase title")),
        row(t("Title baseline"), numIn('titleBaseline', 36, 700, 1, t("pt from the top"))),
        row(t("Detail spacing"), numIn('titleDetailsTracking', 0, 50, 1, t("% between letters"))),
        row(t("Corner distance"), numIn('titleInset', 24, 144, 1, t("pt from the edges"))),
        row(t("Contact details"), sel('contactPosition', [['bottom-left', 'Bottom left'], ['bottom-right', 'Bottom right']])),
        h('div', { class: 'capacity' }, t("Only the title uses the title font; credit, author and the details in the corners use 12 pt Courier. A long title shrinks to fit the page.")),
      ),
      section(
        'Page numbers & furniture',
        chk('pageNumbers', t("Page numbers")),
        chk('pageNumberFirstPage', t("Number the first page")),
        row(t("Position"), sel('pageNumberPosition', [['top-right', 'Top right'], ['bottom-center', 'Bottom center'], ['bottom-right', 'Bottom right']])),
        row(t("Format"), textIn('pageNumberFormat', '{n}.')),
        row(t("Header"), textIn('header', t("e.g. {title}"))),
        row(t("Footer"), textIn('footer', t("e.g. Page {page} of {pages}"))),
        row(t("Draft date"), textIn('draftDate', '')),
        row(t("Label"), textIn('label', t("e.g. BLUE REVISION"))),
        row(t("Watermark"), textIn('watermark', '')),
        h('div', { class: 'capacity' }, t("Placeholders: {title}, {page}, {pages}, {date}.")),
      ),
      section(
        'Private material',
        chk('includeNotes', t("Include [[notes]]")),
        chk('includeSections', t("Include # sections")),
        chk('includeSynopses', t("Include = synopses")),
        h('div', { class: 'capacity' }, t("Comments, highlights, cut material and inactive alternatives are never exported.")),
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
      case 'sides': {
        const title = titleFields(app.editor.lineTexts, app.editor.parsed).find((f) => f.key === 'title')?.value.replace(/[*_]/g, '').replace(/\n/g, ' ') || p!.name;
        return { kind: 'sides', sceneLines: [...selectedScenes], cover: sidesCover, title, day: sidesDay };
      }
      case 'character':
        return { kind: 'character', name: character };
      case 'dialogue':
        return { kind: 'dialogue', name: character, action: dialogueAction, headings: dialogueHeadings };
      default:
        return { kind: 'all' };
    }
  }

  async function info() {
    const lines = app.editor.lineTexts;
    const fields = titleFields(lines, app.editor.parsed);
    const title = fields.find((f) => f.key === 'title')?.value.replace(/[*_]/g, '') || p!.name;
    const author = fields.find((f) => f.key === 'author' || f.key === 'authors')?.value;
    const base = baseline && baseline !== 'production' ? baselineCache.get(baseline) : undefined;
    const revision = base
      ? { text: base.text, sceneIds: base.sceneIds, currentIds: app.scenes.filter((x) => x.kind === 'scene').map((x) => x.id), label: (s.revHeaderText || 'Changes since {version}').replace(/\{version\}/g, base.label) }
      : undefined;
    const production = await productionInfo(app, baseline === 'production');
    return { title, author, extraPrefixes: app.settings.editor.extraPrefixes, revision, production };
  }

  /** Versions to compare with: earlier exports (newest first) and named drafts. */
  function baselineOptions(): Array<{ group: string; value: string; label: string }> {
    const fmt = (iso: string) => new Date(iso).toLocaleString(uiLocale(), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    return [
      ...meta.exports.map((e) => ({ group: t('Earlier exports'), value: `export:${e.id}`, label: `${e.name} — ${fmt(e.created)}` })),
      ...meta.drafts.map((d) => ({ group: t('Named drafts'), value: `draft:${d.id}`, label: `${d.name} — ${fmt(d.created)}` })),
    ];
  }

  async function loadBaseline(value: string) {
    if (!value || value === 'production' || baselineCache.has(value)) return;
    const [kind, id] = value.split(':');
    try {
      if (kind === 'export') {
        const rec = meta.exports.find((e) => e.id === id);
        if (!rec) throw new Error(t("missing"));
        baselineCache.set(value, { text: await bridge.call('readExportCopy', p!.rel, id), sceneIds: rec.sceneIds, label: `“${rec.name}”` });
      } else {
        const rec = meta.drafts.find((d) => d.id === id);
        if (!rec) throw new Error(t("missing"));
        baselineCache.set(value, { text: await bridge.call('readDraft', p!.rel, id), sceneIds: rec.sceneIds, label: `“${rec.name}”` });
      }
    } catch {
      toast(t("The copy of that version could not be read."), { warn: true });
      baseline = '';
    }
  }

  function scopeLabel(): string {
    const map: Record<ScopeKind, string> = {
      all: t('Complete screenplay'),
      scenes: t('Selected scenes'),
      pages: t('Pages {0}', pages),
      scenesNewPage: t('Each scene on a new page'),
      separate: t('Separate scene PDFs'),
      character: t('Scenes with {0}', character),
      dialogue: character ? t('Dialogue of {0}', character) : t('Dialogue'),
      sides: sidesDay.trim() ? t('Sides: {0}', sidesDay.trim()) : t('Sides'),
    };
    return map[scopeKind];
  }

  /** Every export keeps a copy of the screenplay, so later versions can mark what changed. */
  async function recordExport(pagesOut: number, file?: string) {
    const id = uid();
    await bridge.call('saveExportCopy', p!.rel, id, app.editor.getText());
    meta.exports.unshift({
      id,
      name: versionName.trim() || t('Export {0}', stamp),
      note: versionNote.trim(),
      created: new Date().toISOString(),
      pages: pagesOut,
      scope: scopeLabel(),
      file,
      sceneIds: app.scenes.filter((x) => x.kind === 'scene').map((x) => x.id),
      comparedWith: baseline === 'production' && meta.production ? t('{0} revision', roundName(meta.production.rounds.length)) : baseline ? baselineCache.get(baseline)?.label : undefined,
      settings: withLock(),
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
    cap.textContent = t("{0} lines per page · action {1} · dialogue {2} · parenthetical {3} characters per line", c.cap.linesPerPage, c.cap.actionChars, c.cap.dialogueChars, c.cap.parentheticalChars);
    marginsInfo.textContent = t("The page holds {0} lines × {1} characters: {2} pt remain at the bottom and {3} characters to the right of the action.", c.cap.totalLines, c.cap.totalChars, Math.round(c.cap.bottomMarginPt), c.cap.rightMarginChars);
    warnings.textContent = c.warnings.join(' ');
  }

  const refreshSoon = debounce(() => refresh(), 350);

  async function refresh() {
    renderPresets();
    const token = ++renderToken;
    const sc = scope();
    if ((scopeKind === 'scenes' || scopeKind === 'sides') && !selectedScenes.size) {
      preview.replaceChildren(h('div', { class: 'state' }, t("Choose at least one scene.")));
      pageInfo.textContent = '';
      exportBtn.disabled = true;
      return;
    }
    exportBtn.disabled = false;
    preview.replaceChildren(h('div', { class: 'state' }, t("Preparing preview…")));
    let r;
    try {
      if (baseline) await loadBaseline(baseline);
      r = await bridge.call('exportPdf', app.editor.getText(), withLock(), sc, await info());
    } catch (e: any) {
      if (token !== renderToken) return;
      preview.replaceChildren(h('div', { class: 'state' }, t("The PDF could not be created: {0}", e.message)));
      return;
    }
    if (token !== renderToken) return;
    lastPdf = r.pdf as unknown as Uint8Array;
    const extra = r.warnings.filter((w: string) => !warnings.textContent!.includes(w));
    if (extra.length) warnings.textContent = [warnings.textContent, ...extra].filter(Boolean).join(' ');
    const n = r.pages;
    const withTitle = s.titlePage && app.editor.parsed.titleEnd > 0 && scopeKind !== 'pages' && scopeKind !== 'sides' && !(baseline && s.revChangedPagesOnly);
    pageInfo.textContent = [withTitle ? tn(n, '{0} page plus title page', '{0} pages plus title page') : tn(n, '{0} page', '{0} pages'), t('roughly {0} min of screen time (estimate: one page ≈ one minute)', n)].join(' · ');
    const rv = r.revision;
    revisionInfo = rv
      ? [
          tn(rv.changedLines, '{0} marked line', '{0} marked lines') + ' ' + tn(rv.changedPages, 'on {0} page', 'on {0} pages'),
          rv.addedScenes ? tn(rv.addedScenes, '{0} new scene', '{0} new scenes') : '',
          rv.removedScenes ? t('{0} removed', rv.removedScenes) : '',
          rv.movedScenes ? (s.revMarkMoved ? t('{0} moved', rv.movedScenes) : t('{0} moved (not marked)', rv.movedScenes)) : '',
        ].filter(Boolean).join(' · ')
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
      preview.replaceChildren(h('iframe', { src: url, style: { width: '100%', height: '100%', border: '0', background: 'white' }, title: t("PDF preview") }));
      return;
    }
    const doc = await pdfjs.getDocument({ data: data.slice() }).promise;
    if (token !== renderToken) return;
    previewDoc = doc;
    const ratio = preview.scrollHeight > preview.clientHeight ? preview.scrollTop / preview.scrollHeight : 0;
    await renderPages(ratio);
  }

  function fitScale(pageWidth: number) {
    return Math.max(0.2, Math.min(820, preview.clientWidth - 48) / pageWidth);
  }

  function effectiveZoom(): number {
    // The zoom level shown for 'fit', relative to the printed size (A4/Letter ≈ 595–612 pt).
    return zoom === 'fit' ? fitScale(600) : zoom;
  }

  /** Draws every page at the current zoom; keeps the reading position (as a fraction of the height). */
  async function renderPages(ratio: number) {
    const doc = previewDoc;
    if (!doc) return;
    const token = ++previewToken;
    const pagesEl = h('div', { class: 'pages' });
    const dpr = window.devicePixelRatio || 1;
    const items: Array<{ page: any; canvas: HTMLCanvasElement; vp: any }> = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      if (token !== previewToken) return;
      const vp1 = page.getViewport({ scale: 1 });
      const scale = zoom === 'fit' ? fitScale(vp1.width) : zoom;
      const vp = page.getViewport({ scale: scale * dpr });
      const canvas = h('canvas', { width: Math.floor(vp.width), height: Math.floor(vp.height), 'aria-label': t("Page {0}", i) });
      canvas.style.width = `${Math.floor(vp.width / dpr)}px`;
      canvas.style.height = `${Math.floor(vp.height / dpr)}px`;
      pagesEl.append(canvas, h('div', { class: 'page-label' }, `${i} / ${doc.numPages}`));
      items.push({ page, canvas, vp });
    }
    preview.replaceChildren(pagesEl);
    preview.scrollTop = ratio * preview.scrollHeight;
    zoomLabel.textContent = zoom === 'fit' ? t("Fit") : `${Math.round(zoom * 100)}%`;
    zoomLabel.title = zoom === 'fit' ? t("Fitted to the width") : t("Fit to width");
    for (const it of items) {
      if (token !== previewToken) return;
      await it.page.render({ canvasContext: it.canvas.getContext('2d')!, viewport: it.vp }).promise;
    }
  }

  const rerenderZoomSoon = debounce((ratio: number) => renderPages(ratio), 120);

  function setZoom(z: number | 'fit', anchor?: { x: number; y: number }) {
    if (z !== 'fit') z = Math.min(4, Math.max(0.25, z));
    if (z === zoom) return;
    const old = effectiveZoom();
    // Keep the point under the pointer (or the middle of the view) in place.
    const r = preview.getBoundingClientRect();
    const ax = anchor ? anchor.x - r.left : preview.clientWidth / 2;
    const ay = anchor ? anchor.y - r.top : preview.clientHeight / 2;
    const fx = preview.scrollLeft + ax;
    const fy = preview.scrollTop + ay;
    zoom = z;
    const k = effectiveZoom() / old;
    // Instant feedback by resizing the canvases; a sharp redraw follows.
    for (const c of Array.from(preview.querySelectorAll('canvas'))) {
      c.style.width = `${parseFloat(c.style.width) * k}px`;
      c.style.height = `${parseFloat(c.style.height) * k}px`;
    }
    preview.scrollLeft = fx * k - ax;
    preview.scrollTop = fy * k - ay;
    zoomLabel.textContent = zoom === 'fit' ? t("Fit") : `${Math.round(zoom * 100)}%`;
    rerenderZoomSoon(preview.scrollHeight ? preview.scrollTop / preview.scrollHeight : 0);
  }

  function stepZoom(dir: number) {
    const cur = effectiveZoom();
    const next = dir > 0 ? ZOOMS.find((z) => z > cur + 0.01) : [...ZOOMS].reverse().find((z) => z < cur - 0.01);
    if (next !== undefined) setZoom(next);
  }

  // Pinch on a trackpad and Ctrl/Cmd + wheel zoom the preview.
  preview.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom(effectiveZoom() * Math.exp(-e.deltaY * 0.01), { x: e.clientX, y: e.clientY });
    },
    { passive: false },
  );

  async function doExport() {
    await app.flush();
    if (baseline) await loadBaseline(baseline);
    const meta2 = await info();
    const safe = (meta2.title || p!.name).replace(/[\\/:*?"<>|]/g, '-');
    if (scopeKind === 'separate') {
      const folder = await bridge.dialog('folder', { title: t("Choose a folder for the scene PDFs") });
      if (!folder) return;
      try {
        if (baseline) await loadBaseline(baseline);
        const r = await bridge.call('exportScenePdfs', app.editor.getText(), withLock(), folder, meta2);
        await recordExport(r.files.length, folder);
        toast(t("{0} scene PDFs written. A copy of this version was saved as “{1}”.", r.files.length, meta.exports[0].name));
      } catch (e: any) {
        alertDialog(t("Export failed"), e.message);
      }
      return;
    }
    const suffix = scopeKind === 'sides' ? ` - ${t('Sides')}${sidesDay.trim() ? ' ' + sidesDay.trim() : ''}` : baseline === 'production' && meta.production && s.revChangedPagesOnly ? ` - ${roundName(meta.production.rounds.length)}` : '';
    const dest = await bridge.dialog('save', { title: t("Export PDF"), defaultPath: `${safe}${suffix.replace(/[\\/:*?"<>|]/g, '-')}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (!dest) return;
    try {
      if (baseline) await loadBaseline(baseline);
      const r = await bridge.call('exportPdf', app.editor.getText(), withLock(), scope(), meta2);
      const file = dest.toLowerCase().endsWith('.pdf') ? dest : dest + '.pdf';
      await bridge.call('writeFile', file, r.pdf as unknown as Uint8Array);
      persist();
      await recordExport(r.pages, file);
      // Pages with locked numbers went out: new scenes keep the letters they were printed with.
      const fixed = app.writeNewSceneNumbers();
      const fixedNote = fixed.length ? tn(fixed.length, 'New scene {1} now keeps its number.', 'New scenes {1} now keep their numbers.', fixed.join(', ')) : '';
      toast([tn(r.pages, 'Exported {0} page.', 'Exported {0} pages.'), t('This version was saved as “{0}” for later comparisons.', meta.exports[0].name), fixedNote].filter(Boolean).join(' '));
      versionName = '';
      versionNote = '';
      const scroll = side.scrollTop;
      build();
      side.scrollTop = scroll;
    } catch (e: any) {
      alertDialog(t("Export failed"), e.message);
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
  // Zoom keys work wherever the focus is while the Export tab is shown.
  const zoomKeys = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
      if (e.code === 'Equal' || e.code === 'NumpadAdd') {
        e.preventDefault();
        e.stopPropagation();
        return stepZoom(1);
      }
      if (e.code === 'Minus' || e.code === 'NumpadSubtract') {
        e.preventDefault();
        e.stopPropagation();
        return stepZoom(-1);
      }
      if (e.code === 'Digit0' || e.code === 'Numpad0') {
        e.preventDefault();
        e.stopPropagation();
        return setZoom('fit');
      }
    }
  };
  document.addEventListener('keydown', zoomKeys);
  closers.push(() => document.removeEventListener('keydown', zoomKeys));
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
  return { close };
}
