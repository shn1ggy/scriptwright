// Settings window: Editor, Appearance, Commands & shortcuts, Saving & history.

import type { App } from '../app';
import { bridge } from '../bridge';
import { h } from './dom';
import { openDialog, toast } from './overlay';
import { CommandList } from './palette';
import { loadFonts } from './export';
import { DEFAULT_DARK, DEFAULT_LIGHT, ThemeColors } from '../../shared/types';
import { contrast, hsbToRgb, rgbToHex } from '../theme';

type Section = 'editor' | 'appearance' | 'commands' | 'saving';

export function openSettings(app: App, section: Section = 'editor') {
  const content = h('div', { class: 'content' });
  const nav = h('nav');
  const sections: Array<[Section, string]> = [
    ['editor', 'Editor'],
    ['appearance', 'Appearance'],
    ['commands', 'Commands & shortcuts'],
    ['saving', 'Saving & history'],
  ];
  let current: Section = section;
  let cmdList: CommandList | null = null;
  const navRows = new Map<Section, HTMLElement>();
  for (const [id, label] of sections) {
    const row = h('button', { class: 'row', onclick: () => show(id) }, h('span', { class: 'label' }, label));
    navRows.set(id, row);
    nav.append(row);
  }
  const dlg = openDialog({
    title: 'Settings',
    cls: 'settings',
    body: [],
    onClose: () => cmdList?.dispose(),
    cancel: () => {
      if (app.recording) return;
      dlg.close();
    },
  });
  dlg.body.replaceWith(h('div', { class: 'split' }, nav, content));

  const changed = () => app.applySettings();

  function show(s: Section) {
    current = s;
    cmdList?.dispose();
    cmdList = null;
    for (const [id, row] of navRows) row.classList.toggle('selected', id === s);
    content.textContent = '';
    if (s === 'editor') editor();
    else if (s === 'appearance') appearance();
    else if (s === 'commands') commands();
    else saving();
  }

  const row = (label: string, control: Node, help?: string) => {
    const r = h('div', { class: 'form-row' }, h('label', null, label), control);
    if (help) r.append(h('div', { class: 'help' }, help));
    return r;
  };
  const num = (value: number, min: number, max: number, step: number, set: (v: number) => void, aria: string) => {
    const i = h('input', { class: 'field num-in', type: 'number', min: String(min), max: String(max), step: String(step), value: String(value), 'aria-label': aria });
    i.addEventListener('change', () => {
      const v = Math.max(min, Math.min(max, Number(i.value)));
      if (!Number.isFinite(v)) return;
      i.value = String(v);
      set(v);
      changed();
    });
    return i;
  };
  const check = (value: boolean, set: (v: boolean) => void, label: string) => {
    const c = h('input', { type: 'checkbox', checked: value, 'aria-label': label });
    c.addEventListener('change', () => {
      set(c.checked);
      changed();
    });
    return h('label', { class: 'inline' }, c, h('span', null, label));
  };

  function editor() {
    const e = app.settings.editor;
    const font = h('select', { class: 'field', 'aria-label': 'Font' });
    const courier = h('optgroup', { label: 'Courier' });
    for (const f of ['Courier Prime', 'Courier New', 'Courier']) courier.append(h('option', { value: f }, f));
    font.append(courier);
    if (!['Courier Prime', 'Courier New', 'Courier'].includes(e.fontFamily)) font.append(h('option', { value: e.fontFamily }, e.fontFamily));
    font.value = e.fontFamily;
    loadFonts().then((list) => {
      const mono = list.filter((f) => f.mono && !/courier/i.test(f.family));
      if (!mono.length || !font.isConnected) return;
      const g = h('optgroup', { label: 'Monospaced system fonts' });
      for (const f of mono) if (f.family !== e.fontFamily) g.append(h('option', { value: f.family }, f.family));
      font.append(g);
      font.value = e.fontFamily;
    });
    font.addEventListener('change', () => {
      e.fontFamily = font.value;
      changed();
    });
    const heading = h('input', { class: 'field', value: e.defaultHeading, 'aria-label': 'Default scene heading' });
    heading.addEventListener('change', () => {
      e.defaultHeading = heading.value.trim() || 'INT. LOCATION - DAY';
      changed();
    });
    const prefixes = h('input', { class: 'field', value: e.extraPrefixes.join(', '), 'aria-label': 'Additional scene prefixes' });
    prefixes.addEventListener('change', () => {
      e.extraPrefixes = prefixes.value
        .split(/[,;\n]/)
        .map((x) => x.trim().replace(/\.$/, ''))
        .filter(Boolean);
      changed();
    });
    const langs = h('div', { class: 'inline' });
    for (const [code, label] of [
      ['de-DE', 'German'],
      ['en-US', 'English (US)'],
      ['en-GB', 'English (UK)'],
    ]) {
      const c = h('input', { type: 'checkbox', checked: e.spellLanguages.includes(code), disabled: !bridge.spell, 'aria-label': label });
      c.addEventListener('change', () => {
        e.spellLanguages = c.checked ? [...new Set([...e.spellLanguages, code])] : e.spellLanguages.filter((x) => x !== code);
        changed();
      });
      langs.append(h('label', { class: 'inline' }, c, label));
    }
    content.append(
      h('h3', null, 'Typography'),
      row('Font', font, `Courier Prime is recommended. Other fonts must be monospaced. ${document.fonts.check('16px "Courier Prime"') ? 'The built-in Courier Prime is loaded.' : 'The built-in Courier Prime could not be loaded on this computer.'}`),
      row('Font size', h('div', { class: 'inline' }, num(e.fontSize, 10, 32, 1, (v) => (e.fontSize = v), 'Font size'), h('span', { class: 'dim' }, 'px'))),
      row('Line height', h('div', { class: 'inline' }, num(e.lineHeight, 12, 64, 1, (v) => (e.lineHeight = v), 'Line height'), h('span', { class: 'dim' }, 'px'))),
      row('Characters per line', num(e.measure, 30, 120, 1, (v) => (e.measure = v), 'Characters per line'), 'Dialogue and parenthetical widths follow proportionally.'),
      h('h3', null, 'Scenes'),
      row('Default scene heading', heading),
      row('After a heading', check(e.blankAfterHeading, (v) => (e.blankAfterHeading = v), 'Add a blank line')),
      row('Additional prefixes', prefixes, 'Recognized as scene headings in addition to INT, EXT, EST, I/E.'),
      row('Scene numbers', (() => {
        const sel = h('select', { class: 'field', 'aria-label': 'Scene numbers' }, h('option', { value: 'both' }, 'Both sides'), h('option', { value: 'left' }, 'Left'), h('option', { value: 'right' }, 'Right'), h('option', { value: 'off' }, 'Off'));
        sel.value = e.sceneNumbers;
        sel.addEventListener('change', () => {
          e.sceneNumbers = sel.value as typeof e.sceneNumbers;
          changed();
        });
        return sel;
      })(), 'Written numbers such as #12A# are shown as written; other scenes show their position in the outline.'),
      row('Page breaks', check(e.showPageBreaks, (v) => (e.showPageBreaks = v), 'Show where pages end with the current export settings')),
      row('Title page', check(e.titlePageInScript, (v) => (e.titlePageInScript = v), 'Show the title page in Script view'), `When off, edit it in its own view (${app.commands.label('view.titlePage') || 'Title Page'} or “Title page” in the scene list).`),
      h('h3', null, 'Writing'),
      row('Typewriter scrolling', check(e.typewriter, (v) => (e.typewriter = v), 'Keep the caret line near the middle')),
      row('Spellchecking', check(e.spellcheck, (v) => (e.spellcheck = v), bridge.spell ? 'Check spelling' : 'Available in the desktop app')),
      row('Languages', langs, 'Words added from the context menu go into the project dictionary.'),
    );
  }

  function appearance() {
    const a = app.settings.appearance;
    const theme = h('select', { class: 'field', 'aria-label': 'Theme' }, h('option', { value: 'dark' }, 'Dark'), h('option', { value: 'light' }, 'Light'));
    theme.value = a.theme;
    theme.addEventListener('change', () => {
      a.theme = theme.value as 'dark' | 'light';
      changed();
      show('appearance');
    });
    const c: ThemeColors = a.theme === 'dark' ? a.dark : a.light;
    const color = (key: 'text' | 'secondaryText' | 'accent' | 'heading' | 'action', label: string) => {
      const i = h('input', { type: 'color', value: c[key].toLowerCase(), 'aria-label': label });
      const hex = h('input', { class: 'field', value: c[key].toUpperCase(), style: { width: '92px' }, 'aria-label': `${label} hex` });
      const apply = (v: string) => {
        if (!/^#[0-9a-f]{6}$/i.test(v)) return;
        c[key] = v.toUpperCase();
        i.value = v.toLowerCase();
        hex.value = v.toUpperCase();
        app.applyLookSoon();
        updateContrast();
      };
      i.addEventListener('input', () => apply(i.value));
      i.addEventListener('change', () => changed());
      hex.addEventListener('change', () => apply(hex.value.startsWith('#') ? hex.value : '#' + hex.value));
      return h('div', { class: 'inline' }, i, hex);
    };
    const bgPreview = h('span', { style: { width: '34px', height: '26px', borderRadius: '4px', border: '1px solid var(--line-2)', display: 'inline-block' } });
    const contrastNote = h('div', { class: 'help', style: { marginTop: '0' } });
    const updateContrast = () => {
      const bg = rgbToHex(hsbToRgb(c.background));
      bgPreview.style.background = bg;
      const r = contrast(c.text, bg);
      contrastNote.textContent = `Text contrast ${r.toFixed(1)}:1${r < 4.5 ? ' — below the recommended 4.5:1' : ''}`;
      contrastNote.style.color = r < 4.5 ? 'var(--warn)' : '';
    };
    const slider = (k: 'h' | 's' | 'b', max: number, label: string) => {
      const s = h('input', { type: 'range', min: '0', max: String(max), step: k === 'h' ? '1' : '0.5', value: String(c.background[k]), 'aria-label': label, style: { width: '220px' } });
      const out = h('span', { class: 'dim', style: { width: '40px' } }, String(c.background[k]));
      s.addEventListener('input', () => {
        c.background[k] = Number(s.value);
        out.textContent = s.value;
        app.applyLookSoon();
        updateContrast();
      });
      s.addEventListener('change', () => changed());
      return h('div', { class: 'inline' }, s, out);
    };
    updateContrast();
    content.append(
      h('h3', null, 'Theme'),
      row('Appearance', theme),
      h('h3', null, 'Colors'),
      row('Primary text', color('text', 'Primary text')),
      row('Secondary text', color('secondaryText', 'Secondary text')),
      row('Accent', color('accent', 'Accent')),
      row('Scene headings', color('heading', 'Scene headings')),
      row('Action', color('action', 'Action')),
      h('h3', null, 'Writing background'),
      row('Preview', bgPreview),
      row('Hue', slider('h', 360, 'Background hue')),
      row('Saturation', slider('s', 100, 'Background saturation')),
      row('Brightness', slider('b', 100, 'Background brightness')),
      h('div', { class: 'form-row' }, h('span'), contrastNote),
      row(
        '',
        h('button', {
          class: 'btn',
          onclick: () => {
            const d = a.theme === 'dark' ? DEFAULT_DARK : DEFAULT_LIGHT;
            const fresh = { ...d, background: { ...d.background } };
            if (a.theme === 'dark') a.dark = fresh;
            else a.light = fresh;
            changed();
            show('appearance');
          },
        }, `Reset ${a.theme} colors`),
      ),
      h('h3', null, 'Highlights'),
      h('div', { class: 'notice' }, 'Give each highlight color a meaning, e.g. “Fix later” or “Cut candidate”. The names appear in the highlight menu and the Review tab.'),
      ...(['yellow', 'green', 'blue', 'pink'] as const).map((k) => {
        const hl = app.settings.highlights[k];
        const col = h('input', { type: 'color', value: hl.color, 'aria-label': `Highlight color ${k}` });
        col.addEventListener('input', () => {
          hl.color = col.value;
          app.applyLookSoon();
        });
        col.addEventListener('change', () => changed());
        const label = h('input', { class: 'field', value: hl.label, 'aria-label': `Highlight name ${k}`, placeholder: k === 'pink' ? 'Red' : k[0].toUpperCase() + k.slice(1) });
        label.addEventListener('change', () => {
          hl.label = label.value.trim() || (k === 'pink' ? 'Red' : k[0].toUpperCase() + k.slice(1));
          label.value = hl.label;
          changed();
        });
        return row(`Highlight ${['yellow', 'green', 'blue', 'pink'].indexOf(k) + 1}`, h('div', { class: 'inline hl-row' }, col, label));
      }),
    );
  }

  function commands() {
    cmdList = new CommandList(app, { embedded: true });
    cmdList.el.style.border = '1px solid var(--line)';
    cmdList.el.style.borderRadius = '4px';
    cmdList.el.style.minHeight = '360px';
    const exportKeys = async () => {
      const file = await bridge.dialog('save', { title: 'Export shortcuts', defaultPath: 'Scriptwright shortcuts.json', filters: [{ name: 'Shortcuts', extensions: ['json'] }] });
      if (!file) return;
      const data = { format: 'scriptwright-shortcuts', version: 1, keymap: app.commands.overrides };
      await bridge.call('writeFile', file, JSON.stringify(data, null, 2) + '\n');
      toast(`Shortcuts exported (${Object.keys(app.commands.overrides).length} changed from the defaults).`);
    };
    const importKeys = async () => {
      const file = await bridge.dialog('open', { title: 'Import shortcuts', filters: [{ name: 'Shortcuts', extensions: ['json'] }] });
      if (!file) return;
      let keymap: Record<string, string[]> | null = null;
      try {
        const data = JSON.parse(await bridge.call('readTextFile', file));
        const km = data?.format === 'scriptwright-shortcuts' ? data.keymap : null;
        if (km && typeof km === 'object' && Object.values(km).every((v) => Array.isArray(v) && v.every((k) => typeof k === 'string'))) keymap = km;
      } catch {
        keymap = null;
      }
      if (!keymap) {
        toast('This file does not contain Scriptwright shortcuts.', { warn: true });
        return;
      }
      const known = Object.fromEntries(Object.entries(keymap).filter(([id]) => !!app.commands.get(id)));
      app.commands.overrides = known;
      app.commands.onChange?.();
      cmdList?.render();
      toast(`Shortcuts imported (${Object.keys(known).length} changed from the defaults).`);
    };
    content.append(
      h('div', { class: 'notice' }, 'Shortcuts apply immediately and are saved with your settings.'),
      h('div', { class: 'settings-actions' }, h('button', { class: 'btn', onclick: () => void exportKeys() }, 'Export Shortcuts…'), h('button', { class: 'btn', onclick: () => void importKeys() }, 'Import Shortcuts…')),
      cmdList.el,
    );
  }

  function saving() {
    const s = app.settings.saving;
    content.append(
      h('h3', null, 'Saving'),
      row('Autosave after', h('div', { class: 'inline' }, num(s.autosaveDelayMs, 300, 10000, 100, (v) => (s.autosaveDelayMs = v), 'Autosave delay'), h('span', { class: 'dim' }, 'ms pause in typing'))),
      h('div', { class: 'notice' }, 'Every save is atomic and checks that the file on disk is still the version you started from. If someone else changed it, both versions are kept.'),
      h('h3', null, 'History'),
      row('Snapshot every', h('div', { class: 'inline' }, num(s.snapshotIntervalMin, 1, 120, 1, (v) => (s.snapshotIntervalMin = v), 'Snapshot interval'), h('span', { class: 'dim' }, 'minutes while writing'))),
      h(
        'div',
        { class: 'notice' },
        'Retention: all automatic snapshots from the last 24 hours are kept; older ones are reduced to one per day and removed after 30 days. Snapshots made before restoring or resolving a conflict are kept.',
      ),
      h('h3', null, 'Storage'),
      (() => {
        const where = h('div', { class: 'notice' });
        const showWhere = async () => {
          const loc = await bridge.call('settingsLocation');
          where.textContent = loc.inWorkspace
            ? `Settings, the window layout and view options are saved in the workspace (${loc.file.replace(/settings\.json$/, '')}), so the app looks and works the same on every computer that opens it. Only the window's size and place stay with each computer.`
            : `Settings and the layout are saved on this computer only (${loc.file}).`;
        };
        void showWhere();
        const c = h('input', { type: 'checkbox', checked: app.state.settingsInWorkspace !== false, 'aria-label': 'Keep settings and layout in the workspace folder' });
        c.addEventListener('change', async () => {
          app.state.settingsInWorkspace = c.checked;
          await bridge.call('saveState', app.state);
          await bridge.call('saveSettings', app.settings);
          await showWhere();
        });
        return h(
          'div',
          { class: 'settings-block' },
          row('Settings', h('label', { class: 'check' }, c, h('span', null, 'Keep settings and layout in the workspace folder')), 'Another workspace brings its own; one without any starts from the current ones. Turn this off to keep your own setup when several people share a workspace.'),
          where,
        );
      })(),
      h(
        'div',
        { class: 'notice' },
        'Each project folder holds everything belonging to the screenplay: the Fountain file plus a .scriptwright folder with history snapshots, named drafts, export versions, comments, alternatives, the shelf and scene information. Copy or sync the workspace folder and all of it comes along. Only window positions, the last caret positions and recovery copies stay on this computer.',
      ),
      h('h3', null, 'Recovery'),
      h('div', { class: 'notice' }, 'While there are unsaved changes, a recovery copy is written outside the project folder. It is offered when the project is opened again and removed after a successful save.'),
      h('h3', null, 'Collaboration'),
      h('div', { class: 'notice' }, 'Simultaneous editing is not part of this version. Projects in a synced folder are protected by conflict detection.'),
    );
  }

  show(current);
}
