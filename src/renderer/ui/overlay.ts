// Menus, dialogs and toasts. All share the same compact styling and keyboard behavior.

import { h, iconButton } from './dom';

// ------------------------------------------------------------------------------------
// Escape stack: the most recently opened overlay handles Escape first.

const escapeStack: Array<() => void> = [];
const modalSet = new Set<() => void>();
/** Registers an Escape handler. Modal overlays (dialogs, menus) also block global shortcuts. */
export function pushEscape(fn: () => void, modal = true): () => void {
  escapeStack.push(fn);
  if (modal) modalSet.add(fn);
  return () => {
    const i = escapeStack.lastIndexOf(fn);
    if (i >= 0) escapeStack.splice(i, 1);
    modalSet.delete(fn);
  };
}
export function handleEscape(): boolean {
  const fn = escapeStack[escapeStack.length - 1];
  if (!fn) return false;
  fn();
  return true;
}
export function overlayOpen(): boolean {
  return modalSet.size > 0;
}

// ------------------------------------------------------------------------------------
// Menus

export interface MenuItem {
  label?: string;
  kbd?: string;
  run?: () => void;
  disabled?: boolean;
  dot?: string;
  sep?: boolean;
  head?: string;
}

let openMenuEl: HTMLElement | null = null;
let closeOpenMenu: (() => void) | null = null;

export function closeMenu() {
  closeOpenMenu?.();
}

export function openMenu(items: MenuItem[], at: { x: number; y: number } | DOMRect, opts: { onClose?: () => void; minWidth?: number } = {}) {
  closeMenu();
  const prevFocus = document.activeElement as HTMLElement | null;
  const menu = h('div', { class: 'menu', tabindex: '-1', role: 'menu' });
  if (opts.minWidth) menu.style.minWidth = `${opts.minWidth}px`;
  const actionable: HTMLElement[] = [];
  let focusIdx = -1;
  const setFocus = (i: number) => {
    actionable.forEach((el, k) => el.classList.toggle('focused', k === i));
    focusIdx = i;
    actionable[i]?.scrollIntoView({ block: 'nearest' });
  };
  for (const it of items) {
    if (it.sep) {
      menu.append(h('div', { class: 'menu-sep' }));
      continue;
    }
    if (it.head) {
      menu.append(h('div', { class: 'menu-head' }, it.head));
      continue;
    }
    const row = h(
      'div',
      { class: `menu-item${it.disabled ? ' disabled' : ''}`, role: 'menuitem' },
      it.dot ? h('span', { class: 'dot', style: { background: it.dot } }) : null,
      h('span', { class: 'label' }, it.label ?? ''),
      it.kbd ? h('span', { class: 'kbd' }, it.kbd) : null,
    );
    if (!it.disabled) {
      const idx = actionable.length;
      actionable.push(row);
      row.addEventListener('mousemove', () => {
        if (focusIdx !== idx) setFocus(idx);
      });
      row.addEventListener('mousedown', (e) => e.preventDefault());
      row.addEventListener('click', () => {
        close(true);
        it.run?.();
      });
      (row as any).__run = it.run;
    }
    menu.append(row);
  }
  document.body.append(menu);
  // Position within the window
  const r = menu.getBoundingClientRect();
  let x: number;
  let y: number;
  if (at instanceof DOMRect) {
    x = at.left;
    y = at.bottom + 2;
    if (y + r.height > window.innerHeight - 4) y = Math.max(4, at.top - r.height - 2);
  } else {
    x = at.x;
    y = at.y;
    if (y + r.height > window.innerHeight - 4) y = Math.max(4, y - r.height);
  }
  if (x + r.width > window.innerWidth - 4) x = Math.max(4, window.innerWidth - r.width - 4);
  menu.style.left = `${Math.round(x)}px`;
  menu.style.top = `${Math.round(y)}px`;
  menu.focus();

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') setFocus((focusIdx + 1) % actionable.length);
    else if (e.key === 'ArrowUp') setFocus((focusIdx - 1 + actionable.length) % actionable.length);
    else if (e.key === 'Enter' || e.key === ' ') {
      const el = actionable[focusIdx];
      if (el) {
        close(true);
        (el as any).__run?.();
      }
    } else if (e.key === 'Tab') {
      close(false);
    } else if (e.key.length === 1 && /\S/.test(e.key)) {
      const k = e.key.toLowerCase();
      const start = focusIdx + 1;
      for (let n = 0; n < actionable.length; n++) {
        const i = (start + n) % actionable.length;
        if (actionable[i].textContent!.trim().toLowerCase().startsWith(k)) {
          setFocus(i);
          break;
        }
      }
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };
  menu.addEventListener('keydown', onKey);
  const onDown = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) close(false);
  };
  setTimeout(() => window.addEventListener('mousedown', onDown, true), 0);
  window.addEventListener('blur', () => close(false), { once: true });
  const popEsc = pushEscape(() => close(false));
  function close(ran: boolean) {
    if (!menu.isConnected) return;
    menu.remove();
    popEsc();
    window.removeEventListener('mousedown', onDown, true);
    openMenuEl = null;
    closeOpenMenu = null;
    if (!ran) prevFocus?.focus?.({ preventScroll: true });
    else prevFocus?.focus?.({ preventScroll: true });
    opts.onClose?.();
  }
  openMenuEl = menu;
  closeOpenMenu = () => close(false);
  return { close: () => close(false), el: openMenuEl };
}

// ------------------------------------------------------------------------------------
// Dialogs

export interface DialogButton {
  label: string;
  primary?: boolean;
  danger?: boolean;
  /** Return false to keep the dialog open. */
  run?: () => boolean | void | Promise<boolean | void>;
}

export interface DialogHandle {
  el: HTMLElement;
  body: HTMLElement;
  close(): void;
  setButtons(b: DialogButton[]): void;
}

export function openDialog(opts: {
  title: string;
  body: Node | Node[];
  buttons?: DialogButton[];
  cls?: string;
  width?: number;
  onClose?: () => void;
  initialFocus?: HTMLElement | null;
  /** Escape behaves like this button (default: close). */
  cancel?: () => void;
}): DialogHandle {
  const prevFocus = document.activeElement as HTMLElement | null;
  const body = h('div', { class: 'dialog-body' });
  for (const n of Array.isArray(opts.body) ? opts.body : [opts.body]) body.append(n);
  const foot = h('div', { class: 'dialog-foot' });
  const dlg = h(
    'div',
    { class: `dialog ${opts.cls ?? ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title, tabindex: '-1' },
    h('div', { class: 'dialog-head' }, h('span', null, opts.title), h('span', { class: 'spacer' }), iconButton('close', 'Close', () => cancel())),
    body,
    foot,
  );
  if (opts.width) dlg.style.width = `${opts.width}px`;
  const backdrop = h('div', { class: 'backdrop' }, dlg);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) e.preventDefault();
  });
  let primary: DialogButton | null = null;
  const setButtons = (buttons: DialogButton[]) => {
    foot.textContent = '';
    primary = buttons.find((b) => b.primary) ?? null;
    foot.classList.toggle('hidden', !buttons.length);
    for (const b of buttons) {
      const el = h('button', { class: `btn${b.primary ? ' primary' : ''}${b.danger ? ' danger' : ''}` }, b.label);
      el.addEventListener('click', () => runButton(b));
      foot.append(el);
    }
  };
  const runButton = async (b: DialogButton) => {
    const r = await b.run?.();
    if (r !== false) close();
  };
  setButtons(opts.buttons ?? []);
  document.body.append(backdrop);
  const popEsc = pushEscape(() => cancel());
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      // Keep focus inside the dialog.
      const focusables = Array.from(dlg.querySelectorAll<HTMLElement>('button:not([tabindex="-1"]), input, select, textarea, [tabindex="0"]')).filter(
        (x) => !x.hasAttribute('disabled') && x.offsetParent !== null,
      );
      if (!focusables.length) return;
      const i = focusables.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (i <= 0 ? focusables.length - 1 : i - 1) : i === focusables.length - 1 ? 0 : i + 1;
      focusables[next].focus();
      e.preventDefault();
    } else if (e.key === 'Enter' && primary && (e.target as HTMLElement).tagName !== 'TEXTAREA' && (e.target as HTMLElement).tagName !== 'BUTTON' && !e.isComposing) {
      e.preventDefault();
      runButton(primary);
    }
  });
  function cancel() {
    if (opts.cancel) opts.cancel();
    else close();
  }
  function close() {
    if (!backdrop.isConnected) return;
    backdrop.remove();
    popEsc();
    opts.onClose?.();
    prevFocus?.focus?.({ preventScroll: true });
  }
  const focusTarget = opts.initialFocus ?? (dlg.querySelector('input, select, textarea') as HTMLElement | null) ?? (foot.querySelector('.btn.primary') as HTMLElement | null) ?? dlg;
  setTimeout(() => {
    focusTarget.focus();
    if (focusTarget instanceof HTMLInputElement) focusTarget.select();
  }, 0);
  return { el: dlg, body, close, setButtons };
}

export function confirmDialog(title: string, message: string | Node, okLabel = 'OK', opts: { danger?: boolean; cancelLabel?: string } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    let result = false;
    openDialog({
      title,
      body: typeof message === 'string' ? h('p', null, message) : message,
      buttons: [
        { label: opts.cancelLabel ?? 'Cancel' },
        { label: okLabel, primary: true, danger: opts.danger, run: () => void (result = true) },
      ],
      onClose: () => resolve(result),
    });
  });
}

export function promptDialog(title: string, label: string, value = '', opts: { okLabel?: string; placeholder?: string; validate?: (v: string) => string | null } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    let result: string | null = null;
    const input = h('input', { class: 'field', value, placeholder: opts.placeholder ?? '', 'aria-label': label });
    const err = h('div', { class: 'notice warn hidden' });
    openDialog({
      title,
      body: [h('div', { class: 'form-row' }, h('label', null, label), input), err],
      buttons: [
        { label: 'Cancel' },
        {
          label: opts.okLabel ?? 'OK',
          primary: true,
          run: () => {
            const v = input.value.trim();
            const msg = opts.validate?.(v) ?? (v ? null : 'Please enter a value.');
            if (msg) {
              err.textContent = msg;
              err.classList.remove('hidden');
              return false;
            }
            result = v;
          },
        },
      ],
      initialFocus: input,
      onClose: () => resolve(result),
    });
  });
}

export function choiceDialog<T>(title: string, message: string | Node, choices: Array<{ label: string; value: T; primary?: boolean; danger?: boolean }>): Promise<T | null> {
  return new Promise((resolve) => {
    let result: T | null = null;
    openDialog({
      title,
      body: typeof message === 'string' ? h('p', null, message) : message,
      buttons: choices.map((c) => ({ label: c.label, primary: c.primary, danger: c.danger, run: () => void (result = c.value) })),
      onClose: () => resolve(result),
    });
  });
}

export function alertDialog(title: string, message: string | Node): Promise<void> {
  return new Promise((resolve) => {
    openDialog({ title, body: typeof message === 'string' ? h('p', null, message) : message, buttons: [{ label: 'OK', primary: true }], onClose: () => resolve() });
  });
}

// ------------------------------------------------------------------------------------
// Toasts

let toastEl: HTMLElement | null = null;
let toastTimer: any = null;

export function toast(text: string, opts: { actions?: Array<{ label: string; run: () => void }>; timeout?: number; warn?: boolean } = {}) {
  toastEl?.remove();
  clearTimeout(toastTimer);
  const el = h('div', { class: `toast${opts.warn ? ' warn' : ''}`, role: 'status' }, h('span', null, text));
  for (const a of opts.actions ?? []) {
    el.append(
      h('button', {
        class: 'btn',
        onclick: () => {
          el.remove();
          a.run();
        },
      }, a.label),
    );
  }
  document.body.append(el);
  toastEl = el;
  toastTimer = setTimeout(() => el.remove(), opts.timeout ?? (opts.actions?.length ? 9000 : 3500));
}
