// Interface language. English is the source: every string is written in English in the code
// and looked up in the dictionary of the chosen language; a missing entry stays English.
//
//   t('Remove scene')                     → "Szene entfernen"
//   t('Scene {0} of {1}', 3, 40)          → "Szene 3 von 40"
//   tn(n, '{0} scene', '{0} scenes')      → "1 Szene" / "5 Szenen"
//
// The screenplay's own language (MORE, CONT'D on the page) is a separate project setting.

import { DE } from './i18n-de';

export type UiLanguage = 'en' | 'de';

export const UI_LANGUAGES: Array<{ id: UiLanguage; name: string }> = [
  { id: 'en', name: 'English' },
  { id: 'de', name: 'Deutsch' },
];

let current: UiLanguage = 'en';
let dict: Record<string, string> | null = null;

// The renderer keeps the chosen language in local storage too, so strings made while the
// modules load (menus, labels in constants) are already in the right language.
try {
  const stored = (globalThis as any).localStorage?.getItem('scriptwright.uiLanguage');
  if (stored === 'de') setUiLanguage('de');
} catch {
  /* no storage (main process, tests) */
}

export function setUiLanguage(lang: UiLanguage) {
  current = lang === 'de' ? 'de' : 'en';
  dict = current === 'de' ? DE : null;
}

export function uiLanguage(): UiLanguage {
  return current;
}

/** Locale for dates and numbers. */
export function uiLocale(): string {
  return current === 'de' ? 'de-DE' : 'en-US';
}

function fill(s: string, args: unknown[]): string {
  return args.length ? s.replace(/\{(\d+)\}/g, (m, i) => (args[+i] !== undefined ? String(args[+i]) : m)) : s;
}

/** The string in the interface language; {0}, {1} … are replaced by the arguments. */
export function t(s: string, ...args: unknown[]): string {
  return fill((dict && dict[s]) || s, args);
}

/** Singular or plural by n; {0} is n, further arguments follow as {1}, {2} … */
export function tn(n: number, one: string, other: string, ...args: unknown[]): string {
  return t(n === 1 ? one : other, n, ...args);
}
