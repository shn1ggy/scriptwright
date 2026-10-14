// Story structure: acts and sequences (Fountain sections), story models with their beats,
// and where each scene sits in the script (in pages).
//
// A model's positions are typical places, as fractions of the running time (0 = first page,
// 1 = last page). There is no right model: the writer chooses one (or makes their own) and
// sees where their beats land compared to it.

import type { ParseResult } from './fountain';
import { t, tn } from './i18n';

export interface ModelPhase {
  name: string;
  from: number;
  to: number;
}

export interface ModelBeat {
  id: string;
  name: string;
  /** Typical position (0–1). */
  at: number;
  /** For a stretch rather than a moment: where it typically ends. */
  to?: number;
  hint?: string;
}

export interface StoryModel {
  id: string;
  name: string;
  /** One line about the model (shown when choosing it). */
  about: string;
  phases: ModelPhase[];
  beats: ModelBeat[];
}

const b = (id: string, name: string, at: number, hint?: string, to?: number): ModelBeat => ({ id, name, at, hint, to });

export const STORY_MODELS: StoryModel[] = [
  {
    id: 'three-act',
    name: 'Three acts',
    about: 'Setup, confrontation, resolution, turned by two plot points (Syd Field’s paradigm).',
    phases: [
      { name: 'Act I · Setup', from: 0, to: 0.25 },
      { name: 'Act II · Confrontation', from: 0.25, to: 0.75 },
      { name: 'Act III · Resolution', from: 0.75, to: 1 },
    ],
    beats: [
      b('inciting', 'Inciting incident', 0.1, 'Something upsets the hero’s world.'),
      b('pp1', 'Plot point I', 0.25, 'The story turns; the hero commits.'),
      b('pinch1', 'Pinch I', 0.375, 'A reminder of the opposing force.'),
      b('midpoint', 'Midpoint', 0.5, 'A turn that changes the hero’s course.'),
      b('pinch2', 'Pinch II', 0.625, 'The opposition tightens.'),
      b('pp2', 'Plot point II', 0.75, 'The turn into the final act.'),
      b('climax', 'Climax', 0.9, 'The decisive confrontation.'),
      b('resolution', 'Resolution', 0.97, 'The new balance.'),
    ],
  },
  {
    id: 'freytag',
    name: 'Freytag’s pyramid',
    about: 'Five acts rising to a climax at the centre and falling to the catastrophe (Gustav Freytag).',
    phases: [
      { name: 'Exposition', from: 0, to: 0.2 },
      { name: 'Rising action', from: 0.2, to: 0.4 },
      { name: 'Climax', from: 0.4, to: 0.6 },
      { name: 'Falling action', from: 0.6, to: 0.8 },
      { name: 'Catastrophe', from: 0.8, to: 1 },
    ],
    beats: [
      b('exciting', 'Exciting force', 0.15, 'The erregendes Moment that starts the conflict.'),
      b('climax', 'Climax', 0.5, 'The height of the action.'),
      b('tragic', 'Tragic force', 0.58, 'The turn that starts the fall.'),
      b('suspense', 'Final suspense', 0.8, 'A last hope before the end.'),
      b('catastrophe', 'Catastrophe', 0.92, 'The resolution (or downfall).'),
    ],
  },
  {
    id: 'hero',
    name: 'Hero’s journey',
    about: 'Twelve stages of departure, initiation and return (Christopher Vogler after Joseph Campbell).',
    phases: [
      { name: 'Departure', from: 0, to: 0.25 },
      { name: 'Initiation', from: 0.25, to: 0.75 },
      { name: 'Return', from: 0.75, to: 1 },
    ],
    beats: [
      b('ordinary', 'Ordinary world', 0.02),
      b('call', 'Call to adventure', 0.1),
      b('refusal', 'Refusal of the call', 0.14),
      b('mentor', 'Meeting the mentor', 0.18),
      b('threshold', 'Crossing the threshold', 0.25),
      b('tests', 'Tests, allies, enemies', 0.35),
      b('approach', 'Approach to the inmost cave', 0.45),
      b('ordeal', 'The ordeal', 0.55),
      b('reward', 'Reward', 0.65),
      b('roadback', 'The road back', 0.75),
      b('resurrection', 'Resurrection', 0.9),
      b('elixir', 'Return with the elixir', 0.98),
    ],
  },
  {
    id: 'save-the-cat',
    name: 'Save the Cat',
    about: 'Fifteen beats on a 110-page script (Blake Snyder’s beat sheet).',
    phases: [
      { name: 'Act One', from: 0, to: 0.23 },
      { name: 'Act Two A', from: 0.23, to: 0.5 },
      { name: 'Act Two B', from: 0.5, to: 0.77 },
      { name: 'Act Three', from: 0.77, to: 1 },
    ],
    beats: [
      b('opening', 'Opening image', 0, 'A snapshot of the world before.'),
      b('theme', 'Theme stated', 0.045, 'Someone says what the story is about.'),
      b('setup', 'Set-up', 0.01, 'The hero, their world and what is missing.', 0.09),
      b('catalyst', 'Catalyst', 0.11, 'The event that changes everything.'),
      b('debate', 'Debate', 0.11, 'Should the hero go?', 0.23),
      b('break2', 'Break into Two', 0.23, 'The hero chooses the new world.'),
      b('bstory', 'B story', 0.27, 'Often the love story; carries the theme.'),
      b('fun', 'Fun and games', 0.27, 'The promise of the premise.', 0.5),
      b('midpoint', 'Midpoint', 0.5, 'A false victory or a false defeat.'),
      b('badguys', 'Bad guys close in', 0.5, 'Doubt, jealousy, pressure.', 0.68),
      b('allislost', 'All is lost', 0.68, 'The whiff of death.'),
      b('darknight', 'Dark night of the soul', 0.68, 'The hero at their lowest.', 0.77),
      b('break3', 'Break into Three', 0.77, 'The solution, thanks to the B story.'),
      b('finale', 'Finale', 0.77, 'The lessons applied.', 0.99),
      b('final', 'Final image', 1, 'The opposite of the opening image.'),
    ],
  },
  {
    id: 'eight-sequences',
    name: 'Eight sequences',
    about: 'Eight sequences of about 12–15 pages, each with its own tension (Paul Gulino).',
    phases: 'ABCDEFGH'.split('').map((l, i) => ({ name: `Sequence ${l}`, from: i / 8, to: (i + 1) / 8 })),
    beats: [
      b('attack', 'Point of attack', 0.1, 'End of A: the inciting incident.'),
      b('lockin', 'Lock-in', 0.25, 'End of B: the hero is locked into the predicament.'),
      b('raise', 'Stakes raised', 0.375, 'End of C: the first attempt fails.'),
      b('first', 'First culmination', 0.5, 'End of D: the midpoint.'),
      b('subplot', 'Subplot turn', 0.625, 'End of E.'),
      b('main', 'Main culmination', 0.75, 'End of F: the end of the second act.'),
      b('twist', 'Twist', 0.875, 'End of G: the last turn.'),
      b('resolution', 'Resolution', 0.97, 'H: the main tension is resolved.'),
    ],
  },
  {
    id: 'story-circle',
    name: 'Story circle',
    about: 'Eight steps from order into chaos and back, changed (Dan Harmon).',
    phases: [
      { name: 'Order', from: 0, to: 0.25 },
      { name: 'Chaos', from: 0.25, to: 0.75 },
      { name: 'Order', from: 0.75, to: 1 },
    ],
    beats: [
      b('you', 'You', 0, 'A character in a zone of comfort…'),
      b('need', 'Need', 0.125, '…wants something.'),
      b('go', 'Go', 0.25, 'They enter an unfamiliar situation…'),
      b('search', 'Search', 0.375, '…adapt to it…'),
      b('find', 'Find', 0.5, '…get what they wanted…'),
      b('take', 'Take', 0.625, '…pay a heavy price for it…'),
      b('return', 'Return', 0.75, '…return to their familiar situation…'),
      b('change', 'Change', 0.875, '…having changed.'),
    ],
  },
  {
    id: 'seven-point',
    name: 'Seven-point structure',
    about: 'Start from the resolution and work back to the hook (Dan Wells).',
    phases: [
      { name: 'Beginning', from: 0, to: 0.2 },
      { name: 'Middle', from: 0.2, to: 0.8 },
      { name: 'End', from: 0.8, to: 1 },
    ],
    beats: [
      b('hook', 'Hook', 0, 'The opposite state of the resolution.'),
      b('turn1', 'Plot turn 1', 0.2, 'The conflict is introduced.'),
      b('pinch1', 'Pinch 1', 0.35, 'Pressure: something goes wrong.'),
      b('midpoint', 'Midpoint', 0.5, 'From reacting to acting.'),
      b('pinch2', 'Pinch 2', 0.65, 'More pressure; the plan fails.'),
      b('turn2', 'Plot turn 2', 0.8, 'The last piece is found.'),
      b('resolution', 'Resolution', 1, 'The story’s goal is reached (or not).'),
    ],
  },
  {
    id: 'kishotenketsu',
    name: 'Kishōtenketsu',
    about: 'Four parts without conflict as the engine: introduction, development, twist, reconciliation.',
    phases: [
      { name: 'Ki · Introduction', from: 0, to: 0.25 },
      { name: 'Shō · Development', from: 0.25, to: 0.5 },
      { name: 'Ten · Twist', from: 0.5, to: 0.75 },
      { name: 'Ketsu · Reconciliation', from: 0.75, to: 1 },
    ],
    beats: [
      b('ki', 'Introduction', 0),
      b('sho', 'Development', 0.25),
      b('ten', 'Twist', 0.5),
      b('ketsu', 'Reconciliation', 0.75),
    ],
  },
];

export const CUSTOM_MODEL_ID = 'custom';

/** Beats and phases of a model, or of the project's own model. */
export function modelFor(id: string | undefined, custom: ModelBeat[] = []): StoryModel {
  if (id === CUSTOM_MODEL_ID)
    return { id: CUSTOM_MODEL_ID, name: 'Own model', about: 'Beats you define, at the positions you choose.', phases: [], beats: [...custom].sort((a, z) => a.at - z.at) };
  return STORY_MODELS.find((m) => m.id === id) ?? STORY_MODELS[0];
}

// ------------------------------------------------------------------------------------
// Acts and sequences

export interface StorySection {
  /** Line of the section (# Act One). */
  line: number;
  /** 1 = act (#), 2 = sequence (##), deeper levels as written. */
  level: number;
  title: string;
  /** Index of the first scene it contains (scenes.length if none follow). */
  firstScene: number;
  /** Exclusive index of the scene after it (the next section of the same or a higher level). */
  endScene: number;
}

export function sectionTitle(text: string): string {
  return text.replace(/^\s*#+\s*/, '').trim();
}

/** Acts and sequences, from the Fountain sections of the screenplay. */
export function sectionsOf(parse: ParseResult, texts: string[]): StorySection[] {
  const scenes = parse.scenes;
  const out: StorySection[] = [];
  for (let i = parse.bodyStart; i < parse.lines.length; i++) {
    const pl = parse.lines[i];
    if (pl.type !== 'section') continue;
    let first = scenes.findIndex((s) => s.line > i);
    if (first < 0) first = scenes.length;
    out.push({ line: i, level: pl.level ?? 1, title: sectionTitle(texts[i]), firstScene: first, endScene: scenes.length });
  }
  for (let k = 0; k < out.length; k++) {
    for (let j = k + 1; j < out.length; j++) {
      if (out[j].level <= out[k].level) {
        out[k].endScene = out[j].firstScene;
        break;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------
// Positions in pages

export interface ScenePosition {
  /** Start, in pages from the first page of the screenplay (0 = top of page 1). */
  start: number;
  /** Length in pages. */
  length: number;
}

/**
 * Where each scene starts and how long it runs, from the pagination: the page a heading is on
 * plus how far down the page it sits. `pages` are the body pages (no title page).
 */
export function scenePositions(
  pages: Array<{ lines: Array<{ row: number; sourceLine: number }> }>,
  linesPerPage: number,
  sceneLines: number[],
): { scenes: ScenePosition[]; total: number } {
  const startOf = new Map<number, number>();
  let last = 0;
  pages.forEach((p, pi) => {
    for (const l of p.lines) {
      const at = pi + l.row / linesPerPage;
      if (!startOf.has(l.sourceLine)) startOf.set(l.sourceLine, at);
      last = Math.max(last, pi + (l.row + 1) / linesPerPage);
    }
  });
  const total = Math.max(last, pages.length ? 0.01 : 0);
  // A heading not on any page (e.g. an omitted scene) starts where the next printed line does.
  const lines = [...startOf.keys()].sort((a, z) => a - z);
  const firstAtOrAfter = (line: number) => {
    for (const l of lines) if (l >= line) return startOf.get(l)!;
    return total;
  };
  const starts = sceneLines.map((l) => startOf.get(l) ?? firstAtOrAfter(l));
  const scenes = starts.map((s, i) => ({ start: s, length: Math.max(0, (i + 1 < starts.length ? starts[i + 1] : total) - s) }));
  return { scenes, total };
}

// ------------------------------------------------------------------------------------
// Beats compared with the model

export interface BeatPlacement {
  beat: ModelBeat;
  /** Typical page (from the model's position and the script's length). */
  typical: number;
  /** Scene index the writer put the beat on, if any. */
  scene?: number;
  /** Page where that scene starts. */
  actual?: number;
  /** actual − typical, in pages. */
  delta?: number;
}

export function placeBeats(model: StoryModel, beatScenes: Record<string, number | undefined>, positions: ScenePosition[], total: number): BeatPlacement[] {
  return model.beats.map((beat) => {
    const typical = beat.at * total;
    const scene = beatScenes[beat.id];
    if (scene == null || !positions[scene]) return { beat, typical };
    const actual = positions[scene].start;
    return { beat, typical, scene, actual, delta: actual - typical };
  });
}

/** "3 pages later", "1.5 pages earlier", "as typical" (within half a page). */
export function deltaLabel(delta: number): string {
  if (Math.abs(delta) < 0.5) return t('as typical');
  const v = Math.round(Math.abs(delta) * 2) / 2;
  return delta > 0 ? tn(v, '{0} page later', '{0} pages later') : tn(v, '{0} page earlier', '{0} pages earlier');
}

/** Page number as printed (1-based) for a position in pages. */
export function pageNumberAt(pos: number): number {
  return Math.floor(pos) + 1;
}
