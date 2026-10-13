// Export workspace: settings, presets and a preview rendered from the actual PDF.

import type { App } from '../app';
import { bridge } from '../bridge';
import { h, iconButton, debounce } from './dom';
import { alertDialog, confirmDialog, promptDialog, pushEscape, toast } from './overlay';
import { ExportScope, ExportSettings, defaultExportSettings } from '../../shared/types';
import { characterLabel, characterList, titleFields } from '../../shared/fountain';
import { capacity } from '../../shared/paginate';

type ScopeKind = 'all' | 'scenes' | 'pages' | 'scenesNewPage' | 'separate' | 'character';

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
  const defaultPaper = /^en-US|en-CA/.test(navigator.language) ? 'Letter' : 'A4';
  let s: ExportSettings = { ...defaultExportSettings(defaultPaper), ...(meta.exportSettings ?? {}) };
  let scopeKind: ScopeKind = 'all';
  const selectedScenes = new Set<number>();
  let pages = '';
  let character = '';
  const prevFocus = document.activeElement as HTMLElement | null;

  const side = h('div', { class: 'scroll' });
  const preview = h('div', { class: 'export-preview', 'aria-label': 'Preview' });
  const warnings = h('div', { class: 'warnings' });
  const cap = h('div', { class: 'capacity' });
  const pageInfo = h('div', { class: 'muted', style: { fontSize: '12px' } });
  const exportBtn = h('button', { class: 'btn primary', onclick: () => doExport() }, 'Export PDF…');
  const presetSel = h('select', { class: 'field', style: { height: '24px' }, 'aria-label': 'Preset' });

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
      h('button', { class: 'btn', style: { height: '24px' }, onclick: () => savePreset() }, 'Save as preset…'),
      h('button', { class: 'btn', style: { height: '24px' }, onclick: () => deletePreset() }, 'Delete preset'),
      h('button', { class: 'btn', style: { height: '24px' }, onclick: () => resetDefaults() }, 'Reset to defaults'),
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
    s = { ...defaultExportSettings(), ...pr.settings };
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
        const allBtn = h('button', { class: 'btn', style: { height: '22px' }, onclick: () => {
          parsed.scenes.forEach((sc) => selectedScenes.add(sc.line));
          drawScopeExtra();
          changed();
        } }, 'All');
        const noneBtn = h('button', { class: 'btn', style: { height: '22px' }, onclick: () => {
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

    side.append(
      h('h3', null, 'Content'),
      row('Export', scopeSel),
      scopeExtra,
      h('h3', null, 'Page'),
      row('Paper', sel('paper', [['Letter', 'US Letter'], ['A4', 'A4']])),
      row('Margin top', numIn('marginTop', 0.25, 3, 0.05, 'in')),
      row('Margin bottom', numIn('marginBottom', 0.25, 3, 0.05, 'in')),
      row('Margin left', numIn('marginLeft', 0.25, 3, 0.05, 'in')),
      row('Margin right', numIn('marginRight', 0.25, 3, 0.05, 'in')),
      row('Font', sel('font', [['Courier Prime', 'Courier Prime'], ['Courier', 'Courier']])),
      row('Font size', numIn('fontSize', 8, 16, 0.5, 'pt')),
      row('Lines per inch', numIn('linesPerInch', 4, 8, 0.5)),
      h('h3', null, 'Elements'),
      row('Element spacing', numIn('elementSpacing', 0, 3, 1, 'lines')),
      row('Extra space before heading', numIn('headingSpacingBefore', 0, 3, 1, 'lines')),
      row('Keep after heading', numIn('headingKeepLines', 1, 6, 1, 'lines')),
      chk('boldHeadings', 'Bold scene headings'),
      chk('underlineHeadings', 'Underline scene headings'),
      row('Action width', numIn('actionWidth', 3, 8, 0.1, 'in')),
      row('Character indent', numIn('characterIndent', 0, 5, 0.1, 'in')),
      row('Dialogue indent', numIn('dialogueIndent', 0, 4, 0.1, 'in')),
      row('Dialogue width', numIn('dialogueWidth', 1.5, 6, 0.1, 'in')),
      row('Parenthetical indent', numIn('parentheticalIndent', 0, 4, 0.1, 'in')),
      row('Parenthetical width', numIn('parentheticalWidth', 1, 5, 0.1, 'in')),
      h('h3', null, 'Page breaks'),
      row('Lines before a break', numIn('minLinesBeforeBreak', 1, 6, 1)),
      row('Lines after a break', numIn('minLinesAfterBreak', 1, 6, 1)),
      chk('splitDialogue', 'Split long dialogue across pages'),
      chk('splitAction', 'Split long action across pages'),
      chk('useMoreContd', 'Add (MORE) and (CONT’D) at dialogue breaks'),
      row('MORE label', textIn('moreLabel')),
      row('CONT’D label', textIn('contdLabel')),
      chk('contdAfterAction', 'CONT’D when a character continues after action'),
      chk('sceneStartsNewPage', 'Start every scene on a new page'),
      h('h3', null, 'Title page'),
      chk('titlePage', 'Include the title page'),
      row('Title font', sel('titleFont', [['Courier Prime', 'Courier Prime'], ['Courier', 'Courier'], ['Helvetica', 'Helvetica'], ['Times', 'Times']])),
      row('Title size', numIn('titleSize', 10, 36, 1, 'pt')),
      chk('titleBold', 'Bold title'),
      chk('titleUnderline', 'Underline title'),
      chk('titleUppercase', 'Uppercase title'),
      row('Title position', numIn('titlePosition', 0.15, 0.6, 0.01, '× page height')),
      row('Contact', sel('contactPosition', [['bottom-left', 'Bottom left'], ['bottom-right', 'Bottom right']])),
      h('div', { class: 'capacity' }, 'Only the title uses the title font; other title page details use 12 pt Courier.'),
      h('h3', null, 'Numbers & page furniture'),
      chk('pageNumbers', 'Page numbers'),
      chk('pageNumberFirstPage', 'Number the first page'),
      row('Number position', sel('pageNumberPosition', [['top-right', 'Top right'], ['bottom-center', 'Bottom center'], ['bottom-right', 'Bottom right']])),
      row('Number format', textIn('pageNumberFormat', '{n}.')),
      row('Scene numbers', sel('sceneNumbers', [['off', 'Off'], ['left', 'Left'], ['right', 'Right'], ['both', 'Both sides']])),
      chk('autoSceneNumbers', 'Number scenes without a #number# automatically'),
      row('Header', textIn('header', 'e.g. {title}')),
      row('Footer', textIn('footer', 'e.g. Page {page} of {pages}')),
      row('Draft date', textIn('draftDate', '')),
      row('Label', textIn('label', 'e.g. BLUE REVISION')),
      row('Watermark', textIn('watermark', '')),
      h('h3', null, 'Private material'),
      chk('includeNotes', 'Include [[notes]]'),
      chk('includeSections', 'Include # sections'),
      chk('includeSynopses', 'Include = synopses'),
      h('div', { class: 'capacity' }, 'Comments, highlights, cut material and inactive alternatives are never exported.'),
    );
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
      default:
        return { kind: 'all' };
    }
  }

  function info() {
    const lines = app.editor.lineTexts;
    const fields = titleFields(lines, app.editor.parsed);
    const title = fields.find((f) => f.key === 'title')?.value.replace(/[*_]/g, '') || p!.name;
    const author = fields.find((f) => f.key === 'author' || f.key === 'authors')?.value;
    return { title, author, extraPrefixes: app.settings.editor.extraPrefixes };
  }

  const changed = () => {
    updateCapacity();
    refreshSoon();
  };

  function updateCapacity() {
    const c = capacity(s);
    cap.textContent = `${c.cap.linesPerPage} lines per page · action ${c.cap.actionChars} · dialogue ${c.cap.dialogueChars} · parenthetical ${c.cap.parentheticalChars} characters per line`;
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
    pageInfo.textContent = `${n} page${n === 1 ? '' : 's'}${s.titlePage && app.editor.parsed.titleEnd > 0 && scopeKind !== 'pages' ? ' plus title page' : ''} · roughly ${n} min of screen time (estimate: one page ≈ one minute)`;
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
        const r = await bridge.call('exportScenePdfs', app.editor.getText(), s, folder, meta2);
        toast(`${r.files.length} scene PDFs written.`);
      } catch (e: any) {
        alertDialog('Export failed', e.message);
      }
      return;
    }
    const dest = await bridge.dialog('save', { title: 'Export PDF', defaultPath: `${safe}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (!dest) return;
    try {
      const r = await bridge.call('exportPdf', app.editor.getText(), s, scope(), meta2);
      await bridge.call('writeFile', dest.toLowerCase().endsWith('.pdf') ? dest : dest + '.pdf', r.pdf as unknown as Uint8Array);
      persist();
      toast(`Exported ${r.pages} page${r.pages === 1 ? '' : 's'}.`);
    } catch (e: any) {
      alertDialog('Export failed', e.message);
    }
  }

  renderPresets();
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
