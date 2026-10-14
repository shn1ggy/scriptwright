// Connection to the backend: Electron's preload bridge, or the HTTP harness in a browser.

import type { Api } from '../main/api';

export interface Bridge {
  isElectron: boolean;
  platform: string;
  call<M extends keyof Api>(method: M, ...args: Parameters<Api[M]>): Promise<Awaited<ReturnType<Api[M]>>>;
  on(name: string, cb: (payload: any) => void): void;
  dialog(kind: 'folder' | 'open' | 'save', opts?: { title?: string; filters?: Array<{ name: string; extensions: string[] }>; defaultPath?: string }): Promise<string | null>;
  window(op: 'toggleMaximize' | 'minimize' | 'setTitle' | 'reload' | 'closeReady' | 'quit' | 'reveal' | 'titleBar' | 'isFullScreen', arg?: unknown): Promise<any>;
  clipboard: { readText(): Promise<string>; writeText(t: string): Promise<void> };
  spell?: {
    check(words: string[]): boolean[];
    suggest(word: string): string[];
    languages(langs: string[]): Promise<string[]>;
    enable(on: boolean): Promise<void>;
    add(word: string): Promise<void>;
  };
  setMenu?(model: unknown): Promise<void>;
  /** About information and updates (desktop app only). */
  update?(op: 'about' | 'check' | 'install' | 'restart' | 'openPage', arg?: unknown): Promise<any>;
}

function toUint8(v: any): any {
  if (v && typeof v === 'object') {
    if (typeof v.__b64 === 'string') {
      const bin = atob(v.__b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    for (const k of Object.keys(v)) v[k] = toUint8(v[k]);
  }
  return v;
}

function encodeArg(v: any): any {
  if (v instanceof Uint8Array) {
    let s = '';
    for (let i = 0; i < v.length; i += 0x8000) s += String.fromCharCode(...v.subarray(i, i + 0x8000));
    return { __b64: btoa(s) };
  }
  return v;
}

function createHttpBridge(): Bridge {
  const listeners = new Map<string, Set<(p: any) => void>>();
  const es = new EventSource('/events');
  es.onmessage = (m) => {
    const { name, payload } = JSON.parse(m.data);
    for (const cb of listeners.get(name) ?? []) cb(payload);
  };
  const native = async (kind: string, op?: string, arg?: unknown) => {
    const r = await fetch('/native', { method: 'POST', body: JSON.stringify({ kind, op, arg }) });
    return (await r.json()).result;
  };
  const platform = /Mac/.test(navigator.platform) ? 'darwin' : /Win/.test(navigator.platform) ? 'win32' : 'linux';
  return {
    isElectron: false,
    platform,
    async call(method: string, ...args: unknown[]) {
      const r = await fetch('/api', { method: 'POST', body: JSON.stringify({ method, args: args.map(encodeArg) }) });
      const data = await r.json();
      if (data.error) throw new Error(data.error);
      return toUint8(data.result);
    },
    on(name, cb) {
      let set = listeners.get(name);
      if (!set) listeners.set(name, (set = new Set()));
      set.add(cb);
    },
    dialog: (kind, opts) => native('dialog', kind, opts),
    window: (op, arg) => native('window', op, arg),
    clipboard: { readText: () => native('clipboard', 'read'), writeText: (t) => native('clipboard', 'write', t) },
  } as Bridge;
}

export const bridge: Bridge = (window as any).bridge ?? createHttpBridge();
export const isMac = bridge.platform === 'darwin';
