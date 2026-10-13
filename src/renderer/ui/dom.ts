// Tiny DOM helpers and the icon set.

type Child = Node | string | null | undefined | false;
type Props = Record<string, any>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k in el && typeof v !== 'string') (el as any)[k] = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

const PATHS: Record<string, string> = {
  sidebarLeft: 'M3 4h14v12H3zM8 4v12',
  sidebarRight: 'M3 4h14v12H3zM12 4v12',
  search: 'M8.5 3.5a5 5 0 1 1 0 10 5 5 0 0 1 0-10zM12.2 12.2 16.5 16.5',
  export: 'M10 3v9M6.5 8.5 10 12l3.5-3.5M4 14v2.5h12V14',
  settings: 'M10 7.2a2.8 2.8 0 1 1 0 5.6 2.8 2.8 0 0 1 0-5.6zM10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4',
  command: 'M7 4.5a2 2 0 1 0-2 2h2zm0 0v11m0-9h6m0 0v-2a2 2 0 1 1 2 2zm0 0v7m0 0h2a2 2 0 1 1-2 2zm0 0H7m0 0v2a2 2 0 1 1-2-2z',
  plus: 'M10 4v12M4 10h12',
  more: 'M5 10h.01M10 10h.01M15 10h.01',
  left: 'M12 5l-5 5 5 5',
  right: 'M8 5l5 5-5 5',
  up: 'M5 12l5-5 5 5',
  down: 'M5 8l5 5 5-5',
  close: 'M5 5l10 10M15 5L5 15',
  chevronDown: 'M6 8l4 4 4-4',
  chevronRight: 'M8 6l4 4-4 4',
  folder: 'M3 6h5l1.5 1.5H17V15H3z',
  minimal: 'M4 8V4h4M16 8V4h-4M4 12v4h4M16 12v4h-4',
  restore: 'M5 10a5 5 0 1 0 1.5-3.5M5 4v3h3',
  cards: 'M3.5 4.5h5.5v4.5H3.5zM11 4.5h5.5v4.5H11zM3.5 11h5.5v4.5H3.5zM11 11h5.5v4.5H11z',
};

export function icon(name: keyof typeof PATHS | string, title?: string): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', name === 'more' ? '2.6' : '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', PATHS[name] ?? '');
  svg.append(p);
  if (title) {
    const t = document.createElementNS(ns, 'title');
    t.textContent = title;
    svg.append(t);
  }
  return svg;
}

export function iconButton(name: string, title: string, onClick: (e: MouseEvent) => void, cls = ''): HTMLButtonElement {
  const b = h('button', { class: `icon-btn ${cls}`.trim(), title, 'aria-label': title, onclick: onClick, tabindex: '-1' }, icon(name));
  return b;
}

export function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T & { flush(): void; cancel(): void } {
  let t: any = null;
  let lastArgs: any[] = [];
  const d = ((...args: any[]) => {
    lastArgs = args;
    clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn(...lastArgs);
    }, ms);
  }) as any;
  d.flush = () => {
    if (t) {
      clearTimeout(t);
      t = null;
      fn(...lastArgs);
    }
  };
  d.cancel = () => {
    clearTimeout(t);
    t = null;
  };
  return d;
}

export function fmtNum(n: number): string {
  return n.toLocaleString('en-US');
}

export function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
