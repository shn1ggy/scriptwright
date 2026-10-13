// Scene numbers: counted 1, 2, 3 … while writing; locked for production on request (the
// project remembers it and every heading carries a written number, #12#). In a locked script
// a new scene takes the number of the scene before it plus a letter (12A, 12B …) and a
// removed scene stays as OMITTED.

import type { ParseResult } from './fountain';


function nextLetters(s: string): string {
  // A → B … Z → AA
  const chars = s.toUpperCase().split('');
  let i = chars.length - 1;
  while (i >= 0) {
    if (chars[i] !== 'Z') {
      chars[i] = String.fromCharCode(chars[i].charCodeAt(0) + 1);
      return chars.join('');
    }
    chars[i] = 'A';
    i--;
  }
  return 'A' + chars.join('');
}

/** The number after `prev` for an inserted scene: 12 → 12A, 12A → 12B. */
export function insertedNumber(prev: string): string {
  const m = /^(.*\d)([A-Za-z]*)$/.exec(prev);
  if (!m) return prev + 'A';
  return m[1] + (m[2] ? nextLetters(m[2]) : 'A');
}

/**
 * The number of every scene, in order. Unlocked: a written number or the count (1, 2, 3 …).
 * Locked: the written number, or for a scene without one the previous number plus a letter
 * (A1, B1 … before the first).
 */
export function sceneNumberList(parse: ParseResult, locked: boolean): string[] {
  const scenes = parse.scenes;
  if (!locked || !scenes.some((s) => s.sceneNumber)) return scenes.map((s, i) => s.sceneNumber ?? String(i + 1));
  const taken = new Set(scenes.map((s) => s.sceneNumber).filter(Boolean) as string[]);
  const out: string[] = [];
  let prev: string | null = null;
  const firstWritten = scenes.find((s) => s.sceneNumber)?.sceneNumber ?? '1';
  let lead = '';
  for (const sc of scenes) {
    let n = sc.sceneNumber;
    if (!n) {
      if (prev === null) {
        // Before the first numbered scene: A1, B1 …
        lead = lead ? nextLetters(lead) : 'A';
        n = lead + firstWritten;
        while (taken.has(n)) {
          lead = nextLetters(lead);
          n = lead + firstWritten;
        }
      } else {
        n = insertedNumber(prev);
        while (taken.has(n)) n = insertedNumber(n);
      }
      taken.add(n);
    }
    out.push(n);
    prev = n;
  }
  return out;
}

const OMITTED_RE = /^\s*\.?\s*(OMITTED|ENTFÄLLT|ENTFAELLT)\s*(#[^#]*#)?\s*$/iu;

/** A heading that only marks an omitted scene ("OMITTED #12#"). */
export function isOmittedHeading(text: string): boolean {
  return OMITTED_RE.test(text);
}

/** Heading text for an omitted scene that keeps its number. */
export function omittedHeading(num: string, lang: 'en' | 'de'): string {
  return `.${lang === 'de' ? 'ENTFÄLLT' : 'OMITTED'} #${num}#`;
}
