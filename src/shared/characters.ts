// Character analysis: who speaks how much, where, with whom, and who only appears in action.

import { ParseResult, cleanText, countWords } from './fountain';

export interface CharacterStats {
  name: string;
  /** Number of dialogue blocks (cues). */
  cues: number;
  /** Words spoken (dialogue and lyrics, without parentheticals). */
  words: number;
  /** Share of all spoken words, 0..1. */
  share: number;
  parentheticals: number;
  /** Words in the longest single speech. */
  longest: number;
  /** Scene indices (into the `scenes` passed in) where the character speaks. */
  speaksIn: number[];
  /** Scene indices where the name appears in action lines but the character does not speak. */
  mentionedIn: number[];
  /** Cues per scene index. */
  cuesByScene: Map<number, number>;
  firstScene: number;
  lastScene: number;
  /** Other speaking characters by number of scenes shared, most first. */
  sharedWith: Array<{ name: string; scenes: number }>;
  /** Only introduced in action ("TOM (40s)"), never speaks. */
  silent: boolean;
}

export interface AnalysisScene {
  line: number;
  end: number;
}

function nameRegex(name: string): RegExp {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // German and English possessives count as mentions too (Lisas, Lisa's).
  return new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?:s|'s|’s)?(?![\\p{L}\\p{N}])`, 'iu');
}

// "TOM (40s)", "FRAU MÜLLER (60)" — the usual way a character is introduced in action.
const INTRO_RE = /(?<![\p{L}])(\p{Lu}[\p{Lu}'’\-.]+(?: \p{Lu}[\p{Lu}'’\-.]+){0,2})\s*\(\s*(?:\d{1,3}s?|[\p{L} ]{0,10}\d{1,3}s?)\s*\)/gu;

export function analyzeCharacters(lines: string[], parse: ParseResult, scenes: AnalysisScene[]): CharacterStats[] {
  const sceneOf = (line: number) => {
    let lo = 0;
    let hi = scenes.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (scenes[m].line <= line) {
        ans = m;
        lo = m + 1;
      } else hi = m - 1;
    }
    return ans >= 0 && line < scenes[ans].end ? ans : -1;
  };

  const stats = new Map<string, CharacterStats>();
  const get = (name: string) => {
    let s = stats.get(name);
    if (!s) {
      s = { name, cues: 0, words: 0, share: 0, parentheticals: 0, longest: 0, speaksIn: [], mentionedIn: [], cuesByScene: new Map(), firstScene: -1, lastScene: -1, sharedWith: [], silent: false };
      stats.set(name, s);
    }
    return s;
  };

  let totalWords = 0;
  for (const b of parse.blocks) {
    if (!b.cue) continue;
    const s = get(b.cue);
    s.cues++;
    let words = 0;
    for (let i = b.cueLine + 1; i < b.end; i++) {
      const pl = parse.lines[i];
      if (pl.type === 'parenthetical') s.parentheticals++;
      else if (pl.type === 'dialogue' || pl.type === 'lyric') words += countWords(cleanText(lines[i], pl.flags));
    }
    s.words += words;
    s.longest = Math.max(s.longest, words);
    totalWords += words;
    const sc = sceneOf(b.cueLine);
    if (sc >= 0) s.cuesByScene.set(sc, (s.cuesByScene.get(sc) ?? 0) + 1);
  }

  // Action text per scene, for mentions and introductions.
  const actionByScene: string[] = scenes.map(() => '');
  for (let i = 0; i < lines.length; i++) {
    const t = parse.lines[i]?.type;
    if (t !== 'action' && t !== 'centered') continue;
    const sc = sceneOf(i);
    if (sc >= 0) actionByScene[sc] += cleanText(lines[i], parse.lines[i].flags) + '\n';
  }

  // Characters introduced in action who never speak.
  for (let sc = 0; sc < scenes.length; sc++) {
    INTRO_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = INTRO_RE.exec(actionByScene[sc]))) {
      const name = m[1].trim().replace(/^(?:A|AN|THE|EIN|EINE|DER|DIE|DAS) /, '');
      if (name.length < 2 || stats.has(name)) continue;
      const s = get(name);
      s.silent = true;
    }
  }

  for (const s of stats.values()) {
    s.share = totalWords ? s.words / totalWords : 0;
    s.speaksIn = [...s.cuesByScene.keys()].sort((a, b) => a - b);
    const re = nameRegex(s.name);
    for (let sc = 0; sc < scenes.length; sc++) if (!s.cuesByScene.has(sc) && re.test(actionByScene[sc])) s.mentionedIn.push(sc);
    const all = [...s.speaksIn, ...s.mentionedIn];
    s.firstScene = all.length ? Math.min(...all) : -1;
    s.lastScene = all.length ? Math.max(...all) : -1;
  }

  const speaking = [...stats.values()].filter((s) => s.cues > 0);
  for (const a of speaking) {
    const shared: Array<{ name: string; scenes: number }> = [];
    for (const b of speaking) {
      if (a === b) continue;
      let n = 0;
      for (const sc of a.speaksIn) if (b.cuesByScene.has(sc)) n++;
      if (n) shared.push({ name: b.name, scenes: n });
    }
    a.sharedWith = shared.sort((x, y) => y.scenes - x.scenes || x.name.localeCompare(y.name));
  }

  return [...stats.values()].sort((a, b) => b.cues - a.cues || b.words - a.words || a.name.localeCompare(b.name));
}
