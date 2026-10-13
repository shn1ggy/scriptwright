// Command registry and keyboard shortcuts.

import { isMac } from './bridge';

export interface Command {
  id: string;
  title: string;
  category: string;
  keys: string[];
  run: () => void | Promise<void>;
  enabled?: () => boolean;
  /** Shown in the application menu under this heading. */
  menu?: string;
  /** Allowed while a text field (other than the editor) has focus. */
  inFields?: boolean;
  /** Only while the editor has focus. */
  editorOnly?: boolean;
}

const NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Backspace', 'Delete', 'Tab', 'Enter', 'Space']);

/** Normalized combo string from a keyboard event, e.g. "Mod+Shift+F", "Alt+ArrowLeft", "Mod+Ö". */
export function comboFromEvent(e: KeyboardEvent): string | null {
  const key = keyName(e);
  if (!key) return null;
  const parts: string[] = [];
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod) parts.push('Mod');
  if (isMac && e.ctrlKey) parts.push('Ctrl');
  if (!isMac && e.metaKey) parts.push('Meta');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

function keyName(e: KeyboardEvent): string | null {
  const k = e.key;
  if (k === 'Meta' || k === 'Control' || k === 'Alt' || k === 'Shift' || k === 'AltGraph' || k === 'CapsLock' || k === 'Dead' || k === 'Process' || k === 'Unidentified') return null;
  if (/^Key[A-Z]$/.test(e.code)) {
    // The letter printed on the key wins (AZERTY, QWERTZ); Option/Alt on macOS produces
    // special characters, so fall back to the physical key there.
    if (k.length === 1 && /^[a-z]$/i.test(k)) return k.toUpperCase();
    if (k.length === 1 && !e.altKey) return k.toUpperCase();
    return e.code.slice(3);
  }
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
  if (/^Numpad\d$/.test(e.code)) return e.code.slice(6);
  if (k === ' ') return 'Space';
  if (k.length === 1) return k.toUpperCase();
  return k;
}

export function isNavigationCombo(combo: string): boolean {
  const key = combo.split('+').pop()!;
  return NAV_KEYS.has(key);
}

export function hasModifier(combo: string): boolean {
  return /(^|\+)(Mod|Ctrl|Meta|Alt)\+/.test(combo);
}

const MAC_SYMBOLS: Record<string, string> = { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' };
const KEY_LABELS: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Enter: isMac ? '↩' : 'Enter',
  Backspace: isMac ? '⌫' : 'Backspace',
  Delete: isMac ? '⌦' : 'Del',
  Escape: 'Esc',
  Tab: isMac ? '⇥' : 'Tab',
  Space: 'Space',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
};

export function formatCombo(combo: string): string {
  const parts = combo.split('+');
  const key = parts.pop()!;
  const keyLabel = KEY_LABELS[key] ?? key;
  if (isMac) {
    const order = ['Ctrl', 'Alt', 'Shift', 'Mod', 'Meta'];
    const mods = order.filter((m) => parts.includes(m)).map((m) => MAC_SYMBOLS[m]);
    return mods.join('') + keyLabel;
  }
  const names: Record<string, string> = { Mod: 'Ctrl', Meta: 'Win', Alt: 'Alt', Shift: 'Shift', Ctrl: 'Ctrl' };
  return [...parts.map((p) => names[p] ?? p), keyLabel].join('+');
}

/** Electron accelerator for menu display, or undefined when Electron can't express it. */
export function toAccelerator(combo: string): string | undefined {
  const parts = combo.split('+');
  const key = parts.pop()!;
  const map: Record<string, string> = { ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Escape: 'Esc', ' ': 'Space' };
  let k = map[key] ?? key;
  if (!/^([A-Z0-9]|F\d{1,2}|Left|Right|Up|Down|Enter|Tab|Space|Backspace|Delete|Home|End|PageUp|PageDown|Esc|[=\-,.\/\\;'\[\]`])$/.test(k)) return undefined;
  if (k === '=') k = '=';
  const mods = parts.map((p) => (p === 'Mod' ? 'CmdOrCtrl' : p === 'Meta' ? 'Super' : p === 'Ctrl' ? 'Ctrl' : p));
  return [...mods, k].join('+');
}

export class CommandRegistry {
  private cmds = new Map<string, Command>();
  private defaults = new Map<string, string[]>();
  overrides: Record<string, string[]> = {};
  onChange: (() => void) | null = null;

  register(c: Command) {
    this.cmds.set(c.id, c);
    this.defaults.set(c.id, c.keys.slice());
  }

  get(id: string) {
    return this.cmds.get(id);
  }

  all(): Command[] {
    return [...this.cmds.values()];
  }

  keysFor(id: string): string[] {
    return this.overrides[id] ?? this.defaults.get(id) ?? [];
  }

  defaultKeys(id: string): string[] {
    return this.defaults.get(id) ?? [];
  }

  isDefault(id: string): boolean {
    return !(id in this.overrides);
  }

  /** Commands bound to the combo (more than one means a conflict). */
  lookup(combo: string): Command[] {
    const out: Command[] = [];
    for (const c of this.cmds.values()) if (this.keysFor(c.id).includes(combo)) out.push(c);
    return out;
  }

  conflictsFor(id: string, combo: string): Command[] {
    return this.lookup(combo).filter((c) => c.id !== id);
  }

  setKeys(id: string, keys: string[]) {
    const def = this.defaults.get(id) ?? [];
    if (keys.length === def.length && keys.every((k, i) => k === def[i])) delete this.overrides[id];
    else this.overrides[id] = keys;
    this.onChange?.();
  }

  /** Assigns a combo, removing it from any other command that had it. */
  assign(id: string, combo: string) {
    for (const other of this.conflictsFor(id, combo)) {
      this.setKeys(
        other.id,
        this.keysFor(other.id).filter((k) => k !== combo),
      );
    }
    this.setKeys(id, [combo]);
  }

  clear(id: string) {
    this.setKeys(id, []);
  }

  reset(id: string) {
    delete this.overrides[id];
    this.onChange?.();
  }

  label(id: string): string {
    const k = this.keysFor(id)[0];
    return k ? formatCombo(k) : '';
  }
}
