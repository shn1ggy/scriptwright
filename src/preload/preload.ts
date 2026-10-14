// Preload: exposes a small, explicit bridge to the renderer.

import { contextBridge, ipcRenderer, webFrame } from 'electron';

const listeners = new Map<string, Set<(...args: any[]) => void>>();
ipcRenderer.on('event', (_e, name: string, payload: unknown) => {
  for (const cb of listeners.get(name) ?? []) cb(payload);
});

contextBridge.exposeInMainWorld('bridge', {
  isElectron: true,
  platform: process.platform,
  call: (method: string, ...args: unknown[]) => ipcRenderer.invoke('api', method, args),
  on: (name: string, cb: (...args: any[]) => void) => {
    let set = listeners.get(name);
    if (!set) listeners.set(name, (set = new Set()));
    set.add(cb);
  },
  dialog: (kind: string, opts?: unknown) => ipcRenderer.invoke('dialog', kind, opts),
  window: (op: string, arg?: unknown) => ipcRenderer.invoke('window', op, arg),
  clipboard: {
    readText: () => ipcRenderer.invoke('clipboard', 'read'),
    writeText: (text: string) => ipcRenderer.invoke('clipboard', 'write', text),
  },
  spell: {
    check: (words: string[]) => words.map((w) => webFrame.isWordMisspelled(w)),
    suggest: (word: string) => webFrame.getWordSuggestions(word),
    languages: (langs: string[]) => ipcRenderer.invoke('spell', 'languages', langs),
    enable: (on: boolean) => ipcRenderer.invoke('spell', 'enable', on),
    add: (word: string) => ipcRenderer.invoke('spell', 'add', word),
  },
  setMenu: (model: unknown) => ipcRenderer.invoke('menu', model),
  update: (op: string, arg?: unknown) => ipcRenderer.invoke('update', op, arg),
});
