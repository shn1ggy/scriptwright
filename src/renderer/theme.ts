// Applies appearance settings as CSS variables.

import { AppearanceSettings, Hsb, ThemeColors } from '../shared/types';

export function hsbToRgb({ h, s, b }: Hsb): [number, number, number] {
  const S = s / 100;
  const V = b / 100;
  const k = (n: number) => (n + h / 60) % 6;
  const f = (n: number) => V - V * S * Math.max(0, Math.min(k(n), 4 - k(n), 1));
  return [Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255)];
}

export function rgbToHex([r, g, b]: [number, number, number]): string {
  return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
}

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [128, 128, 128];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function luminance([r, g, b]: [number, number, number]): number {
  const c = (v: number) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
}

export function contrast(a: string, b: string): number {
  const la = luminance(hexToRgb(a));
  const lb = luminance(hexToRgb(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function applyTheme(a: AppearanceSettings) {
  const dark = a.theme === 'dark';
  const c: ThemeColors = dark ? a.dark : a.light;
  const root = document.documentElement;
  root.classList.toggle('light', !dark);
  const bg = rgbToHex(hsbToRgb(c.background));
  // Panels are a little darker (dark theme) or a touch deeper (light theme) than the page.
  const panel = rgbToHex(hsbToRgb({ ...c.background, b: Math.max(0, c.background.b - (dark ? 3.5 : 3)) }));
  const panel2 = rgbToHex(hsbToRgb({ ...c.background, b: Math.max(0, c.background.b - (dark ? 0.5 : 6)) }));
  const field = rgbToHex(hsbToRgb({ ...c.background, b: dark ? Math.max(0, c.background.b - 6) : Math.min(100, c.background.b + 3) }));
  const set = (k: string, v: string) => root.style.setProperty(k, v);
  set('--bg', bg);
  set('--panel', panel);
  set('--panel-2', panel2);
  set('--field', field);
  set('--text', c.text);
  set('--text-2', c.secondaryText);
  set('--text-3', mix(c.secondaryText, bg, 0.35));
  set('--accent', c.accent);
  set('--accent-tint', rgba(c.accent, dark ? 0.13 : 0.12));
  set('--accent-tint-2', rgba(c.accent, dark ? 0.24 : 0.2));
  set('--sel', rgba(c.accent, dark ? 0.26 : 0.22));
  set('--heading', c.heading);
  set('--action', c.action);
  set('--line', dark ? 'rgba(255,255,255,0.07)' : 'rgba(20,24,30,0.09)');
  set('--line-2', dark ? 'rgba(255,255,255,0.12)' : 'rgba(20,24,30,0.16)');
  set('--note', dark ? '#8fb3cf' : '#3c6e93');
  set('--warn', dark ? '#e3b866' : '#9a6a00');
  set('--danger', dark ? '#e5706b' : '#c23b33');
  set('--ok', dark ? '#7fc48d' : '#2f7d43');
  set('--hl', dark ? 'rgba(227,184,102,0.28)' : 'rgba(230,170,40,0.30)');
  set('--hl-current', dark ? 'rgba(227,184,102,0.55)' : 'rgba(230,170,40,0.6)');
  document.body.style.background = bg;
}

function mix(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex([0, 1, 2].map((i) => Math.round(x[i] * (1 - t) + y[i] * t)) as [number, number, number]);
}

/** Highlight colors from the settings, as CSS variables (--hl-yellow … and -dot variants). */
export function applyHighlightColors(hl: Record<string, { color: string }>, light: boolean) {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(hl)) {
    root.style.setProperty(`--hl-${k}`, rgba(v.color, light ? 0.38 : 0.3));
    root.style.setProperty(`--hl-${k}-dot`, v.color);
  }
}
