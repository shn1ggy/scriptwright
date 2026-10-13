// Electron main process: window, menu, dialogs and IPC to the shared backend.

import { app, BrowserWindow, Menu, MenuItemConstructorOptions, clipboard, dialog, ipcMain, screen, session, shell } from 'electron';
import fs from 'fs';
import path from 'path';
import { Backend } from './backend';
import { createApi, ApiMethod } from './api';

interface MenuModelItem {
  id?: string;
  label?: string;
  accelerator?: string;
  type?: 'separator';
  enabled?: boolean;
}
interface MenuModel {
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
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', click: () => sendCommand('app.settings') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { label: `Hide ${app.name}`, click: () => app.hide() },
        { role: 'hideOthers', accelerator: '' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: `Quit ${app.name}`, accelerator: 'Cmd+Q', registerAccelerator: false, click: () => sendCommand('app.quit') },
      ],
    });
  }
  const model = menuModel.length ? menuModel : [{ label: 'File', items: [{ id: 'app.quit', label: 'Quit' }] }];
  for (const m of model) {
    template.push(fromModel(m));
    if (m.label === 'File') {
      template.push({
        label: 'Edit',
        submenu: [
          { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => sendCommand('edit.undo') },
          { label: 'Redo', accelerator: isMac ? 'Cmd+Shift+Z' : 'Ctrl+Y', click: () => sendCommand('edit.redo') },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: () => sendCommand('edit.selectAll') },
        ],
      });
    }
  }
  if (isMac) template.push({ role: 'windowMenu' });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function setup() {
  backend = new Backend({ userDataDir: app.getPath('userData'), fontsDir: fontsDir() });
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
  ipcMain.handle('menu', (_e, model: MenuModel[]) => {
    menuModel = model;
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
