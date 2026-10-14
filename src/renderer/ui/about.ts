// About Scriptwright (a section of Settings) and looking for updates.

import type { App } from '../app';
import { bridge } from '../bridge';
import { h } from './dom';
import { confirmDialog, toast } from './overlay';
import { t, uiLocale } from '../../shared/i18n';

declare const __APP_VERSION__: string;
declare const __BUILD_DATE__: string;
declare const __COMMIT__: string;
declare const __UPDATE_REPO__: string;

export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';

interface ReleaseInfo {
  version: string;
  name: string;
  notes: string;
  page: string;
  publishedAt: string;
}
interface CheckResult {
  available: boolean;
  none?: boolean;
  release?: ReleaseInfo;
  installable?: boolean;
}

/** The repository updates come from: the writer's choice, else the one the app was built with. */
export function updateRepo(app: App): string {
  return (app.settings.updates?.repo || (typeof __UPDATE_REPO__ === 'string' ? __UPDATE_REPO__ : '')).trim();
}

let lastResult: CheckResult | null = null;

/** Looks for a newer release. Quiet mode (at start) only speaks up when there is one. */
export async function checkForUpdates(app: App, quiet: boolean): Promise<CheckResult | null> {
  const repo = updateRepo(app);
  if (!bridge.update || !repo) return null;
  try {
    const r: CheckResult = await bridge.update('check', repo);
    app.settings.updates.lastCheck = new Date().toISOString();
    app.saveSettings();
    lastResult = r;
    if (r.available && r.release && (!quiet || app.settings.updates.skip !== r.release.version)) {
      toast(t('Scriptwright {0} is available.', r.release.version), {
        timeout: 12000,
        actions: [{ label: t('Details…'), run: () => app.openSettings('about') }],
      });
    } else if (!quiet) toast(r.none ? t('No release has been published yet.') : t('Scriptwright is up to date.'));
    return r;
  } catch (e: any) {
    if (!quiet) toast(t('Could not look for updates: {0}', e?.message ?? e), { warn: true });
    return null;
  }
}

/** Once a day at start, when automatic checks are on. */
export function checkForUpdatesSoon(app: App) {
  const u = app.settings.updates;
  if (!u?.auto || !bridge.update || !updateRepo(app)) return;
  const last = Date.parse(u.lastCheck || '') || 0;
  if (Date.now() - last < 20 * 3600 * 1000) return;
  setTimeout(() => void checkForUpdates(app, true), 8000);
}

async function install(app: App, r: CheckResult, status: HTMLElement) {
  if (!r.release || !bridge.update) return;
  const ok = await confirmDialog(
    t('Install update'),
    t('Scriptwright {0} is downloaded and installed, then the app starts again. Your work is saved first.', r.release.version),
    t('Install and restart'),
  );
  if (!ok) return;
  status.textContent = t('Downloading and installing …');
  try {
    await app.flush();
    await bridge.update('install', r.release);
    status.textContent = t('Installed. Starting again …');
    await app.flush();
    await bridge.update('restart');
  } catch (e: any) {
    status.textContent = t('The update could not be installed: {0}', e?.message ?? e);
  }
}

/** Notes from a release (Markdown) shown as plain paragraphs and list items. */
function notesView(md: string): HTMLElement {
  const box = h('div', { class: 'about-notes' });
  for (const block of md.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim());
    if (!lines.length) continue;
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      box.append(h('ul', null, ...lines.map((l) => h('li', null, l.replace(/^\s*[-*]\s+/, '').replace(/\*\*|__|`/g, '')))));
    } else box.append(h('p', null, lines.join(' ').replace(/^#+\s*/, '').replace(/\*\*|__|`/g, '')));
  }
  return box;
}

export function renderAbout(app: App, content: HTMLElement, row: (label: string, control: Node, help?: string) => HTMLElement) {
  const info = h('div', { class: 'about-facts' });
  const head = h(
    'div',
    { class: 'about-head' },
    h('img', { class: 'about-icon', src: 'icon.svg', alt: '' }),
    h('div', null, h('div', { class: 'about-name' }, 'Scriptwright'), h('div', { class: 'about-version' }, t('Version {0}', APP_VERSION))),
  );
  content.append(
    head,
    h('p', { class: 'about-text' }, t('A screenplay editor built on Fountain: plain text that stays yours, with the tools of a writing room around it.')),
    info,
  );
  const fact = (label: string, value: string) => info.append(h('div', { class: 'about-fact' }, h('span', null, label), h('span', null, value)));
  fact(t('Version'), `${APP_VERSION}${typeof __COMMIT__ === 'string' && __COMMIT__ ? ` (${__COMMIT__})` : ''}`);
  if (typeof __BUILD_DATE__ === 'string') fact(t('Built'), new Date(__BUILD_DATE__).toLocaleDateString(uiLocale()));
  if (bridge.update) {
    void bridge.update('about').then((a: any) => {
      fact(t('System'), `${a.os} · ${a.platform}`);
      fact('Electron', `${a.electron} · Chromium ${a.chrome} · Node ${a.node}`);
      fact(t('App data'), a.userData);
      fact(t('Installed as'), a.install === 'source' ? t('Project folder (npm start)') : a.install === 'portable' ? t('Portable folder (Run Scriptwright.cmd)') : t('Application'));
    });
  } else fact(t('Running in'), t('Browser (development)'));

  // Updates -------------------------------------------------------------------------------
  content.append(h('h3', null, t('Updates')));
  const u = app.settings.updates;
  const auto = h('input', { type: 'checkbox', checked: u.auto, 'aria-label': t('Look for updates automatically') });
  auto.addEventListener('change', () => {
    u.auto = auto.checked;
    app.saveSettings();
  });
  const repo = h('input', { class: 'field', value: updateRepo(app), placeholder: 'owner/scriptwright', spellcheck: 'false', 'aria-label': t('GitHub repository') });
  repo.addEventListener('change', () => {
    u.repo = repo.value.trim();
    app.saveSettings();
  });
  const status = h('div', { class: 'about-status' });
  const result = h('div', { class: 'about-result' });
  const checkBtn = h('button', { class: 'btn' }, t('Check now'));
  const show = (r: CheckResult | null) => {
    result.textContent = '';
    if (!r) return;
    if (!r.available || !r.release) {
      status.textContent = r.none ? t('No release has been published yet.') : t('Scriptwright is up to date.');
      return;
    }
    const rel = r.release;
    status.textContent = t('Version {0} is available (you have {1}).', rel.version, APP_VERSION);
    const buttons = h('div', { class: 'settings-actions' });
    if (r.installable) buttons.append(h('button', { class: 'btn primary', onclick: () => void install(app, r, status) }, t('Install and restart …')));
    if (rel.page) buttons.append(h('button', { class: 'btn', onclick: () => void bridge.update?.('openPage', rel.page) }, t('Open release page')));
    if (u.skip !== rel.version)
      buttons.append(
        h('button', {
          class: 'btn',
          onclick: () => {
            u.skip = rel.version;
            app.saveSettings();
            toast(t('Version {0} will not be offered again at start.', rel.version));
          },
        }, t('Skip this version')),
      );
    result.append(h('div', { class: 'about-release' }, rel.name || rel.version), notesView(rel.notes || ''), buttons);
  };
  checkBtn.addEventListener('click', async () => {
    if (!updateRepo(app)) {
      status.textContent = t('Enter the GitHub repository the releases come from first.');
      repo.focus();
      return;
    }
    checkBtn.disabled = true;
    status.textContent = t('Looking for updates …');
    const r = await checkForUpdates(app, true);
    checkBtn.disabled = false;
    if (r) show(r);
    else status.textContent = t('Could not look for updates. Check the repository name and the connection.');
  });
  if (!bridge.update) {
    content.append(h('div', { class: 'notice' }, t('Updates are available in the desktop app.')));
  } else {
    content.append(
      row(t('Automatically'), h('label', { class: 'check' }, auto, h('span', null, t('Look for updates once a day at start'))), t('Only asks GitHub which version is the newest; nothing is installed without you.')),
      row(t('Releases from'), repo, t('The GitHub repository (owner/name) where new versions are published.')),
      h('div', { class: 'settings-actions' }, checkBtn),
      status,
      result,
    );
    const last = Date.parse(u.lastCheck || '');
    status.textContent = last ? t('Last checked {0}.', new Date(last).toLocaleString(uiLocale())) : '';
    if (lastResult) show(lastResult);
  }

  // Credits ---------------------------------------------------------------------------------
  content.append(
    h('h3', null, t('Credits')),
    h(
      'div',
      { class: 'about-credits' },
      h('p', null, t('Made by Nico Sanft.')),
      h('p', null, t('Fountain, the plain-text screenplay format, by John August, Stu Maschwitz and others (fountain.io).')),
      h('p', null, t('Courier Prime by Alan Dague-Greene for Quote-Unquote Apps, under the SIL Open Font License 1.1.')),
      h('p', null, t('PDF preview with PDF.js by Mozilla, under the Apache License 2.0.')),
      h('p', null, t('Built with Electron (MIT License) and esbuild (MIT License).')),
    ),
  );
}
