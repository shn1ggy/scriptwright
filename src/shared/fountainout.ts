// Fountain text transformations: written scene numbers (#12#) and clean Fountain export.

import { F_BONEYARD, F_NOTE, ParseResult } from './fountain';

const NUM_RE = /\s*#[\p{L}\p{N}.\-]+#\s*$/u;

export type NumberMode = 'keep' | 'remove' | 'addMissing' | 'renumber';

/** Line changes that remove, add or rewrite written scene numbers on headings. */
export function sceneNumberEdits(lines: string[], parse: ParseResult, mode: NumberMode): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  if (mode === 'keep') return out;
  for (const sc of parse.scenes) {
    const text = lines[sc.line];
    const has = NUM_RE.test(text);
    const base = text.replace(NUM_RE, '');
    let next = text;
    if (mode === 'remove') next = base;
    else if (mode === 'renumber') next = `${base.trimEnd()} #${sc.order}#`;
    else if (mode === 'addMissing' && !has) next = `${base.trimEnd()} #${sc.order}#`;
    if (next !== text) out.push({ line: sc.line, text: next });
  }
  return out;
}

export interface FountainExportOptions {
  numbers: NumberMode;
  removeNotes: boolean;
  removeOmitted: boolean;
  titlePage: boolean;
}

/** Fountain text for sharing with other apps. The screenplay itself is not changed. */
export function exportFountain(lines: string[], parse: ParseResult, o: FountainExportOptions): string {
  const work = lines.slice();
  for (const e of sceneNumberEdits(lines, parse, o.numbers)) work[e.line] = e.text;
  const out: string[] = [];
  const strip = (o.removeNotes ? F_NOTE : 0) | (o.removeOmitted ? F_BONEYARD : 0);
  let skipBlank = false;
  for (let i = o.titlePage ? 0 : parse.titleEnd; i < work.length; i++) {
    const pl = parse.lines[i];
    let text = work[i];
    if (strip && pl.flags && pl.flags.some((f) => f & strip)) {
      // Heading edits may have changed the line length; notes on headings are rare, so
      // only strip when the line is unchanged.
      if (text === lines[i]) {
        let t = '';
        let cut = false;
        for (let k = 0; k < text.length; k++) {
          if (pl.flags[k] & strip) {
            cut = true;
            continue;
          }
          // Removing "[[note]]" between two spaces leaves one space, not two.
          if (cut && text[k] === ' ' && t.endsWith(' ')) continue;
          cut = false;
          t += text[k];
        }
        text = t.replace(/[ \t]+$/, '');
      }
      const wasContent = lines[i].trim() !== '';
      if (wasContent && text.trim() === '') {
        // The whole line was a note or omitted text: drop it and one following blank line.
        if (out.length && out[out.length - 1].trim() === '') skipBlank = true;
        continue;
      }
    }
    if (skipBlank && text.trim() === '') {
      skipBlank = false;
      continue;
    }
    skipBlank = false;
    out.push(text);
  }
  return out.join('\n');
}
