// Production reports: scene list, cast, locations and the breakdown per scene.
//
// Lengths are in eighths of a page, from the real pagination (with locked page numbers when
// the pages are locked). Everything here is plain data; the app shows it as tables and
// exports it as PDF or CSV.

import { ParseResult } from './fountain';
import { analyzeCharacters } from './characters';
import { Page, formatEighths, sceneEighths } from './paginate';
import { TagCategory } from './types';

export interface HeadingParts {
  /** "INT.", "EXT.", "INT./EXT." … as written, or ''. */
  intExt: string;
  location: string;
  time: string;
}

const INT_EXT = /^(INT\.?\/EXT\.?|EXT\.?\/INT\.?|I\/E\.?|INT\.?|EXT\.?|EST\.?|INNEN\/AU(?:SS|ß)EN|AU(?:SS|ß)EN\/INNEN|INNEN|AU(?:SS|ß)EN|I\/A)(?=$|[\s./—–-])/iu;
const TIMES =
  /^(DAY|NIGHT|MORNING|EVENING|AFTERNOON|DAWN|DUSK|SUNRISE|SUNSET|NOON|MIDNIGHT|LATER|CONTINUOUS|CONT(?:'|’)?D|SAME|SAME TIME|MOMENTS LATER|MINUTES LATER|LATER THAT DAY|LATER THAT NIGHT|MAGIC HOUR|TAG|NACHT|MORGEN|MORGENS|ABEND|ABENDS|MITTAG|NACHMITTAG|VORMITTAG|DÄMMERUNG|DAEMMERUNG|MORGENDÄMMERUNG|ABENDDÄMMERUNG|SONNENAUFGANG|SONNENUNTERGANG|SPÄTER|SPAETER|KURZ DARAUF|KONTINUIERLICH|GLEICHZEITIG|DURCHGEHEND)$/iu;

/**
 * Splits a scene heading into int./ext., location and time of day. Works for
 * "INT. KITCHEN - NIGHT", "EXT. FARM - BARN - DAY" and German headings like
 * "INNEN/TAG — COPYSHOP" or "AUSSEN/NACHT - STRASSE".
 */
export function headingParts(heading: string): HeadingParts {
  let h = heading.replace(/\s*#[^#]*#\s*$/, '').trim().replace(/^\./, '');
  let intExt = '';
  let time = '';
  const m = INT_EXT.exec(h);
  if (m) {
    intExt = m[1].toUpperCase();
    const rest = h.slice(m[0].length);
    // German order puts the time right after a slash: "INNEN/TAG — COPYSHOP".
    const slash = /^\s*\//.test(rest);
    h = rest.replace(/^\s*[./]?\s*/, '');
    const t = slash ? /^([\p{L}'’ ]+?)\s*(?:—|–|-)\s*(.*)$/u.exec(h) : null;
    if (t && TIMES.test(t[1].trim())) {
      time = t[1].trim().toUpperCase();
      h = t[2];
    }
  }
  const parts = h.split(/\s+[—–-]+\s+|\s*[—–]\s*/).map((x) => x.trim()).filter(Boolean);
  if (!time && parts.length > 1 && TIMES.test(parts[parts.length - 1])) time = parts.pop()!.toUpperCase();
  return { intExt, location: parts.join(' – ').toUpperCase(), time };
}

export interface SceneRow {
  index: number;
  /** Line of the heading. */
  line: number;
  number: string;
  heading: string;
  parts: HeadingParts;
  /** Printed page the scene starts on (e.g. "12" or "12A"). */
  page: string;
  eighths: number;
  /** Characters who speak, then those only seen in action. */
  speaking: string[];
  silent: string[];
  /** Breakdown elements by category. */
  tags: Partial<Record<TagCategory, string[]>>;
}

export interface ReportData {
  scenes: SceneRow[];
  cast: Array<{ name: string; scenes: string[]; speeches: number; words: number; eighths: number; first: string; silent: boolean }>;
  locations: Array<{ location: string; intExt: string[]; times: string[]; scenes: string[]; eighths: number }>;
  totalEighths: number;
}

/** A breakdown tag found in the text: its category, name and the line it starts on. */
export interface PlacedTag {
  category: TagCategory;
  name: string;
  line: number;
}

export function buildReports(
  lines: string[],
  parse: ParseResult,
  numbers: string[],
  pages: Page[],
  linesPerPage: number,
  tags: PlacedTag[] = [],
): ReportData {
  const scenes = parse.scenes;
  const sceneOfLine = new Int32Array(lines.length).fill(-1);
  for (const sc of scenes) for (let i = sc.line; i < sc.end && i < lines.length; i++) sceneOfLine[i] = sc.line;
  const eighths = sceneEighths(pages, sceneOfLine, linesPerPage);
  const startPage = new Map<number, string>();
  for (const pg of pages) {
    if (pg.title) continue;
    for (const l of pg.sceneLines) if (!startPage.has(l)) startPage.set(l, pg.label || String(pg.number));
  }
  const stats = analyzeCharacters(lines, parse, scenes.map((s) => ({ line: s.line, end: Math.max(s.end, s.line + 1) })));
  const rows: SceneRow[] = scenes.map((sc, i) => ({
    index: i,
    line: sc.line,
    number: numbers[i] ?? String(i + 1),
    heading: sc.heading.replace(/\s*#[^#]*#\s*$/, '').trim(),
    parts: headingParts(sc.heading),
    page: startPage.get(sc.line) ?? '',
    eighths: eighths.get(sc.line) ?? 0,
    speaking: [],
    silent: [],
    tags: {},
  }));
  for (const st of stats) {
    for (const k of st.speaksIn) rows[k]?.speaking.push(st.name);
    for (const k of st.mentionedIn) rows[k]?.silent.push(st.name);
  }
  // Breakdown tags by scene (a tag before the first scene is ignored).
  for (const tg of tags) {
    const sc = sceneOfLine[tg.line];
    if (sc < 0) continue;
    const row = rows.find((r) => r.line === sc);
    if (!row) continue;
    const list = (row.tags[tg.category] ??= []);
    const name = tg.name.trim();
    if (name && !list.some((x) => x.toLowerCase() === name.toLowerCase())) list.push(name);
  }

  // Cast: speaking characters first (by number of scenes), then those only seen in action.
  const cast = stats
    .map((st) => {
      const idx = [...new Set([...st.speaksIn, ...st.mentionedIn])].sort((a, b) => a - b);
      return {
        name: st.name,
        scenes: idx.map((k) => rows[k].number),
        speeches: st.cues,
        words: st.words,
        eighths: idx.reduce((sum, k) => sum + rows[k].eighths, 0),
        first: idx.length ? rows[idx[0]].page : '',
        silent: st.silent || st.cues === 0,
      };
    })
    .filter((c) => c.scenes.length)
    .sort((a, b) => Number(a.silent) - Number(b.silent) || b.scenes.length - a.scenes.length || b.speeches - a.speeches || a.name.localeCompare(b.name));

  // Locations: one row per place, in order of first appearance.
  const locs = new Map<string, ReportData['locations'][number]>();
  for (const r of rows) {
    const key = r.parts.location || r.heading.toUpperCase();
    let l = locs.get(key);
    if (!l) {
      l = { location: key, intExt: [], times: [], scenes: [], eighths: 0 };
      locs.set(key, l);
    }
    if (r.parts.intExt && !l.intExt.includes(r.parts.intExt)) l.intExt.push(r.parts.intExt);
    if (r.parts.time && !l.times.includes(r.parts.time)) l.times.push(r.parts.time);
    l.scenes.push(r.number);
    l.eighths += r.eighths;
  }
  return { scenes: rows, cast, locations: [...locs.values()], totalEighths: rows.reduce((s, r) => s + r.eighths, 0) };
}

export { formatEighths };

/** Comma-separated values with quotes where needed (opens in Excel, Numbers, Google Sheets). */
export function toCsv(rows: string[][]): string {
  const cell = (v: string) => (/[",\n;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  // A byte order mark tells Excel the file is UTF-8 (umlauts).
  return '﻿' + rows.map((r) => r.map((v) => cell(v ?? '')).join(',')).join('\r\n') + '\r\n';
}

/** A report as printed: a title and sections of tables or plain lines. */
export interface ReportDoc {
  title: string;
  subtitle: string;
  sections: Array<{
    heading?: string;
    /** Column widths are shares of the line; cells wrap. */
    table?: { columns: Array<{ label: string; width: number; align?: 'left' | 'right' }>; rows: string[][]; boldRows?: number[] };
    lines?: Array<{ label?: string; text: string }>;
    /** Keep the section on one page when it fits. */
    keep?: boolean;
  }>;
}
