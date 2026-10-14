// Electron main process: window, menu, dialogs and IPC to the shared backend.

import { app, BrowserWindow, Menu, MenuItemConstructorOptions, clipboard, dialog, ipcMain, net, screen, session, shell } from 'electron';
import os from 'os';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Backend } from './backend';
import { createApi, ApiMethod } from './api';
import { applyPackage, compareVersions, detectInstall, normalizeRepo, packageAssets, parseRelease, ReleaseInfo, verifyChecksum } from './updates';

declare const __APP_VERSION__: string;
declare const __BUILD_DATE__: string;
declare const __COMMIT__: string;

interface MenuModelItem {
  id?: string;
  label?: string;
  accelerator?: string;
  type?: 'separator';
  enabled?: boolean;
}
interface MenuModel {
  /** Stable name (File, Edit …); the label may be translated. */
  key?: string;
  label: string;
  items: MenuModelItem[];
}

const isMac = process.platform === 'darwin';
let win: BrowserWindow | null = null;
let backend: Backend;
let api: ReturnType<typeof createApi>;
let allowClose = false;
let quitting = false;
let normalBounds: Electron.Rectangle | null = null;
let menuModel: MenuModel[] = [];
/** Labels of the menu items the main process adds itself (translated by the renderer). */
let menuLabels: Record<string, string> = {};
const ML = (key: string, fallback: string) => menuLabels[key] ?? fallback;

const windowFile = () => path.join(app.getPath('userData'), 'window.json');

function loadWindowState(): { x?: number; y?: number; width: number; height: number; maximized: boolean } {
  try {
    const s = JSON.parse(fs.readFileSync(windowFile(), 'utf8'));
    if (typeof s.width === 'number' && typeof s.height === 'number') return s;
  } catch {}
  return { width: 1280, height: 820, maximized: false };
}

function saveWindowState() {
  if (!win) return;
  const b = normalBounds ?? win.getNormalBounds();
  try {
    fs.writeFileSync(windowFile(), JSON.stringify({ ...b, maximized: win.isMaximized() }));
  } catch {}
}

/** The app icon (Dock, task bar), copied into dist/ by the build. */
function appIconPath(): string {
  return path.join(__dirname, 'icon.png');
}

function fontsDir(): string {
  const packaged = path.join(process.resourcesPath ?? '', 'fonts');
  if (app.isPackaged && fs.existsSync(packaged)) return packaged;
  return path.join(app.getAppPath(), 'resources', 'fonts');
}

function createWindow() {
  const st = loadWindowState();
  let bounds: Partial<Electron.Rectangle> = { width: st.width, height: st.height };
  if (st.x !== undefined && st.y !== undefined) {
    // Only restore a position that is still on a connected display.
    const display = screen.getDisplayMatching({ x: st.x, y: st.y, width: st.width, height: st.height });
    const wa = display.workArea;
    const visible = st.x < wa.x + wa.width - 80 && st.x + st.width > wa.x + 80 && st.y >= wa.y - 10 && st.y < wa.y + wa.height - 80;
    if (visible) bounds = { x: st.x, y: st.y, width: st.width, height: st.height };
  }
  win = new BrowserWindow({
    ...bounds,
    minWidth: 640,
    minHeight: 420,
    backgroundColor: '#272B33',
    show: false,
    title: 'Scriptwright',
    ...(fs.existsSync(appIconPath()) ? { icon: appIconPath() } : {}),
    // The app's own top bar takes the place of the system title bar.
    titleBarStyle: 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 14, y: 13 } } : { titleBarOverlay: { color: '#272B33', symbolColor: '#C9CED6', height: 38 } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: true,
      nodeIntegration: false,
    },
  });
  normalBounds = win.getBounds();
  if (st.maximized) win.maximize();
  win.once('ready-to-show', () => win?.show());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  const trackBounds = () => {
    if (win && !win.isMaximized() && !win.isMinimized() && !win.isFullScreen()) normalBounds = win.getBounds();
  };
  let saveTimer: NodeJS.Timeout | undefined;
  const scheduleSave = () => {
    trackBounds();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveWindowState, 400);
  };
  win.on('resize', scheduleSave);
  win.on('move', scheduleSave);
  win.on('enter-full-screen', () => win?.webContents.send('event', 'fullscreen', true));
  win.on('leave-full-screen', () => win?.webContents.send('event', 'fullscreen', false));
  win.on('maximize', saveWindowState);
  win.on('unmaximize', saveWindowState);

  win.on('close', (e) => {
    if (allowClose) {
      saveWindowState();
      return;
    }
    e.preventDefault();
    win?.webContents.send('event', 'request-close');
    // If the renderer cannot answer (hung), close anyway after recovery had its chance.
    setTimeout(() => {
      if (!allowClose && win) {
        allowClose = true;
        win.close();
      }
    }, 8000);
  });
  win.on('closed', () => {
    win = null;
    if (!isMac || quitting) app.quit();
  });

  // Links open in the system browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('context-menu', (e) => e.preventDefault());

  backend.on('external', (ev) => win?.webContents.send('event', 'external', ev));
  buildMenu();
}

function toggleMaximize() {
  if (!win) return;
  if (win.isFullScreen()) {
    win.setFullScreen(false);
    return;
  }
  if (win.isMaximized()) {
    const restore = normalBounds;
    win.unmaximize();
    // Restore the exact previous bounds so repeated toggling never drifts.
    if (restore) win.setBounds(restore);
  } else {
    normalBounds = win.getBounds();
    win.maximize();
  }
}

function sendCommand(id: string) {
  win?.webContents.send('event', 'command', id);
}

function buildMenu() {
  const template: MenuItemConstructorOptions[] = [];
  const fromModel = (m: MenuModel): MenuItemConstructorOptions => ({
    label: m.label,
    submenu: m.items.map((it) =>
      it.type === 'separator'
        ? { type: 'separator' as const }
        : {
            label: it.label,
            accelerator: it.accelerator,
            // The renderer handles shortcuts itself, so menus only display them.
            registerAccelerator: false,
            enabled: it.enabled !== false,
            click: () => sendCommand(it.id!),
          },
    ),
  });
  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { label: ML('about', `About ${app.name}`).replace('{app}', app.name), click: () => sendCommand('app.about') },
        { label: ML('updates', 'Check for Updates…'), click: () => sendCommand('app.updates') },
        { type: 'separator' },
        { label: ML('settings', 'Settings…'), accelerator: 'Cmd+,', registerAccelerator: false, click: () => sendCommand('app.settings') },
        { type: 'separator' },
        { label: ML('services', 'Services'), role: 'services' },
        { type: 'separator' },
        { label: ML('hide', `Hide ${app.name}`).replace('{app}', app.name), click: () => app.hide() },
        { label: ML('hideOthers', 'Hide Others'), role: 'hideOthers' },
        { label: ML('showAll', 'Show All'), role: 'unhide' },
        { type: 'separator' },
        { label: ML('quit', `Quit ${app.name}`).replace('{app}', app.name), accelerator: 'Cmd+Q', registerAccelerator: false, click: () => sendCommand('app.quit') },
      ],
    });
  }
  const model: MenuModel[] = menuModel.length ? menuModel : [{ key: 'File', label: 'File', items: [{ id: 'app.quit', label: 'Quit' }] }];
  // Standard edit items; the renderer's own Edit entries (find, replace, rename…) follow them
  // in the same menu, so there is only one Edit menu.
  const editBasics: MenuItemConstructorOptions[] = [
    // The renderer handles these keys itself (reliably on every system); the menu shows them.
    { label: ML('undo', 'Undo'), accelerator: 'CmdOrCtrl+Z', registerAccelerator: false, click: () => sendCommand('edit.undo') },
    { label: ML('redo', 'Redo'), accelerator: isMac ? 'Cmd+Shift+Z' : 'Ctrl+Y', registerAccelerator: false, click: () => sendCommand('edit.redo') },
    { type: 'separator' },
    { label: ML('cut', 'Cut'), role: 'cut' },
    { label: ML('copy', 'Copy'), role: 'copy' },
    { label: ML('paste', 'Paste'), role: 'paste' },
    { label: ML('selectAll', 'Select All'), accelerator: 'CmdOrCtrl+A', click: () => sendCommand('edit.selectAll') },
  ];
  const keyOf = (m: MenuModel) => m.key ?? m.label;
  const hasEdit = model.some((m) => keyOf(m) === 'Edit');
  for (const m of model) {
    const item = fromModel(m);
    if (keyOf(m) === 'Edit') item.submenu = [...editBasics, { type: 'separator' }, ...(item.submenu as MenuItemConstructorOptions[])];
    // Help is the last menu on every system: the Window menu goes before it.
    if (keyOf(m) === 'Help') template.push(windowMenu());
    template.push(item);
    if (keyOf(m) === 'File' && !hasEdit) template.push({ label: ML('edit', 'Edit'), submenu: editBasics });
  }
  if (!model.some((m) => keyOf(m) === 'Help')) template.push(windowMenu());
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function windowMenu(): MenuItemConstructorOptions {
  // Custom Window menu: the standard one claims ⌘M, which is the minimal-view shortcut.
  return {
    label: ML('window', 'Window'),
    submenu: [
      { label: ML('minimize', 'Minimize'), click: () => win?.minimize() },
      { label: isMac ? ML('zoom', 'Zoom') : ML('maximize', 'Maximize / Restore'), click: () => toggleMaximize() },
      { type: 'separator' },
      { label: ML('closeWindow', 'Close Window'), accelerator: 'CmdOrCtrl+W', click: () => win?.close() },
      ...(isMac ? [{ type: 'separator' as const }, { label: ML('front', 'Bring All to Front'), role: 'front' as const }] : []),
    ],
  };
}

function setup() {
  backend = new Backend({ userDataDir: app.getPath('userData'), fontsDir: fontsDir(), trash: (f) => shell.trashItem(f) });
  api = createApi(backend);

  ipcMain.handle('api', async (_e, method: ApiMethod, args: unknown[]) => {
    const fn = (api as any)[method];
    if (typeof fn !== 'function') throw new Error(`Unknown method ${String(method)}`);
    return fn(...args);
  });
  ipcMain.handle('dialog', async (_e, kind: string, opts: any) => {
    if (!win) return null;
    if (kind === 'folder') {
      const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: opts?.title });
      return r.canceled ? null : r.filePaths[0];
    }
    if (kind === 'open') {
      const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: opts?.filters, title: opts?.title });
      return r.canceled ? null : r.filePaths[0];
    }
    if (kind === 'save') {
      const r = await dialog.showSaveDialog(win, { defaultPath: opts?.defaultPath, filters: opts?.filters, title: opts?.title });
      return r.canceled ? null : r.filePath;
    }
    return null;
  });
  ipcMain.handle('window', (_e, op: string, arg?: any) => {
    if (!win) return;
    switch (op) {
      case 'toggleMaximize':
        toggleMaximize();
        return;
      case 'minimize':
        win.minimize();
        return;
      case 'setTitle':
        win.setTitle(String(arg));
        return;
      case 'reload':
        // Reloads the page (e.g. after the interface language changed).
        win.webContents.reloadIgnoringCache();
        return;
      case 'titleBar': {
        // Colors of the window buttons drawn over the app's top bar (Windows/Linux), and
        // whether the macOS window buttons are shown (hidden in minimal view).
        const a = (arg ?? {}) as { color?: string; symbolColor?: string; buttons?: boolean };
        if (isMac) {
          if (typeof a.buttons === 'boolean') win.setWindowButtonVisibility(a.buttons);
        } else if (a.color && a.symbolColor) {
          try {
            win.setTitleBarOverlay({ color: a.color, symbolColor: a.symbolColor, height: 38 });
          } catch {}
        }
        return;
      }
      case 'isFullScreen':
        return win.isFullScreen();
      case 'closeReady':
        allowClose = true;
        win.close();
        return;
      case 'quit':
        // The renderer has already flushed everything before asking to quit.
        quitting = true;
        allowClose = true;
        win.close();
        return;
      case 'reveal':
        shell.showItemInFolder(String(arg));
        return;
    }
  });
  // About and updates ---------------------------------------------------------------------
  const install = () => detectInstall(app.getAppPath(), process.resourcesPath);
  const getBuffer = async (url: string) => {
    const r = await net.fetch(url, { headers: { 'User-Agent': 'Scriptwright' } });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return Buffer.from(await r.arrayBuffer());
  };
  ipcMain.handle('update', async (_e, op: string, arg?: any) => {
    if (op === 'about') {
      return {
        version: __APP_VERSION__,
        buildDate: __BUILD_DATE__,
        commit: __COMMIT__,
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        platform: `${process.platform} ${process.arch}`,
        os: `${os.type()} ${os.release()}`,
        userData: app.getPath('userData'),
        install: install().kind,
      };
    }
    if (op === 'check') {
      const repo = normalizeRepo(String(arg ?? ''));
      if (!repo) throw new Error('No GitHub repository is set.');
      const r = await net.fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Scriptwright' } });
      if (r.status === 404) return { available: false, none: true };
      if (!r.ok) throw new Error(`GitHub answered ${r.status} ${r.statusText}`);
      const rel: ReleaseInfo = parseRelease(await r.json());
      const { zip } = packageAssets(rel);
      return { available: compareVersions(rel.version, __APP_VERSION__) > 0, release: rel, installable: !!zip && install().kind !== 'none' };
    }
    if (op === 'install') {
      const rel = arg as ReleaseInfo;
      const { zip, sha } = packageAssets(rel);
      const where = install();
      if (!zip || where.kind === 'none') throw new Error('This release cannot be installed here; download it from the release page.');
      const buf = await getBuffer(zip.url);
      if (sha) {
        const shaText = (await getBuffer(sha.url)).toString('utf8');
        if (!verifyChecksum(buf, shaText)) throw new Error('The download does not match its checksum; nothing was changed.');
      }
      const n = applyPackage(buf, where.kind, where.root);
      return { files: n, kind: where.kind };
    }
    if (op === 'restart') {
      // The renderer has saved everything. Start again: the Windows launcher copies the new
      // app into the runtime; a source checkout runs the new build.
      const where = install();
      if (where.kind === 'portable') {
        spawn('cmd.exe', ['/c', 'start', '""', 'Run Scriptwright.cmd'], { cwd: where.root, detached: true, stdio: 'ignore', windowsHide: true }).unref();
      } else app.relaunch();
      quitting = true;
      allowClose = true;
      app.quit();
      return;
    }
    if (op === 'openPage') {
      if (/^https:\/\//.test(String(arg))) await shell.openExternal(String(arg));
      return;
    }
    throw new Error(`Unknown update operation ${op}`);
  });
  ipcMain.handle('clipboard', (_e, op: string, text?: string) => {
    if (op === 'read') return clipboard.readText();
    clipboard.writeText(text ?? '');
  });
  ipcMain.handle('spell', (_e, op: string, arg: any) => {
    const ses = session.defaultSession;
    if (op === 'languages') {
      if (!isMac) {
        const available = ses.availableSpellCheckerLanguages;
        const wanted = (arg as string[]).filter((l) => available.includes(l));
        ses.setSpellCheckerLanguages(wanted);
        return wanted;
      }
      return arg;
    }
    if (op === 'enable') {
      ses.setSpellCheckerEnabled(!!arg);
      return;
    }
    if (op === 'add') {
      ses.addWordToSpellCheckerDictionary(String(arg));
      return;
    }
  });
  ipcMain.handle('menu', (_e, model: MenuModel[] | { menus: MenuModel[]; labels?: Record<string, string> }) => {
    if (Array.isArray(model)) menuModel = model;
    else {
      menuModel = model.menus;
      menuLabels = model.labels ?? {};
    }
    buildMenu();
  });
}

if (!app.requestSingleInstanceLock()) {
  // Another instance owns the projects; let it handle the request.
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    if (isMac && app.dock && fs.existsSync(appIconPath())) app.dock.setIcon(appIconPath());
    setup();
    createWindow();
    app.on('activate', () => {
      if (!win) {
        allowClose = false;
        createWindow();
      }
    });
  });
  app.on('before-quit', (e) => {
    if (win && !allowClose) {
      e.preventDefault();
      quitting = true;
      win.close();
    }
  });
  app.on('window-all-closed', () => {
    backend?.dispose();
    if (!isMac || quitting) app.quit();
  });
}
