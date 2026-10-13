// Shared types and defaults for settings, project information and export.

export interface EditorSettings {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  /** Characters per line for action and headings. */
  measure: number;
  defaultHeading: string;
  /** Insert an extra blank line after a new scene heading. */
  blankAfterHeading: boolean;
  extraPrefixes: string[];
  spellcheck: boolean;
  spellLanguages: string[];
  typewriter: boolean;
  /** Scene numbers beside headings: written #12A# numbers, otherwise the outline position. */
  sceneNumbers: 'off' | 'left' | 'right' | 'both';
  /** Show where pages break with the current export settings (Script and Source view). */
  showPageBreaks: boolean;
}

export interface Hsb {
  h: number;
  s: number;
  b: number;
}

export interface ThemeColors {
  background: Hsb;
  text: string;
  secondaryText: string;
  accent: string;
  heading: string;
  action: string;
}

export interface AppearanceSettings {
  theme: 'dark' | 'light';
  dark: ThemeColors;
  light: ThemeColors;
}

export interface SavingSettings {
  autosaveDelayMs: number;
  snapshotIntervalMin: number;
}

export interface Settings {
  version: 1;
  editor: EditorSettings;
  appearance: AppearanceSettings;
  saving: SavingSettings;
  /** command id → list of key combos ([] = explicitly cleared). Missing = default. */
  keymap: Record<string, string[]>;
  cards: CardSettings;
}

export interface CardSettings {
  size: 'small' | 'medium' | 'large';
  /** How a scene's color shows on its card. */
  colorStyle: 'stripe' | 'tint' | 'header' | 'full';
  showSummary: boolean;
  showStatus: boolean;
  showCharacters: boolean;
  showLength: boolean;
  /** Tint outline rows with the scene color. */
  tintOutline: boolean;
}

export const DEFAULT_DARK: ThemeColors = {
  background: { h: 220, s: 23.5, b: 20 }, // #272B33
  text: '#DCDDDE',
  secondaryText: '#8C9199',
  accent: '#47C1F5',
  heading: '#E398ED',
  action: '#DCDDDE',
};

export const DEFAULT_LIGHT: ThemeColors = {
  background: { h: 40, s: 2, b: 97 },
  text: '#24272C',
  secondaryText: '#6B7079',
  accent: '#0B86BD',
  heading: '#9B3AAE',
  action: '#24272C',
};

export function defaultSettings(): Settings {
  return {
    version: 1,
    editor: {
      fontFamily: 'Courier Prime',
      fontSize: 16,
      lineHeight: 24,
      measure: 60,
      defaultHeading: 'INT. LOCATION - DAY',
      blankAfterHeading: true,
      extraPrefixes: ['INNEN', 'AUSSEN', 'INNEN/AUSSEN', 'I/A'],
      spellcheck: false,
      spellLanguages: ['de-DE', 'en-US'],
      typewriter: false,
      sceneNumbers: 'both',
      showPageBreaks: false,
    },
    appearance: { theme: 'dark', dark: { ...DEFAULT_DARK, background: { ...DEFAULT_DARK.background } }, light: { ...DEFAULT_LIGHT, background: { ...DEFAULT_LIGHT.background } } },
    saving: { autosaveDelayMs: 800, snapshotIntervalMin: 10 },
    keymap: {},
    cards: { size: 'medium', colorStyle: 'tint', showSummary: true, showStatus: true, showCharacters: true, showLength: true, tintOutline: true },
  };
}

/** Deep-merges stored settings over defaults so new fields get defaults. */
export function mergeSettings(stored: any): Settings {
  const d = defaultSettings();
  if (!stored || typeof stored !== 'object') return d;
  const merge = (base: any, over: any): any => {
    if (!over || typeof over !== 'object' || Array.isArray(base)) return over === undefined ? base : over;
    const out: any = { ...base };
    for (const k of Object.keys(over)) {
      if (base && typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k])) out[k] = merge(base[k], over[k]);
      else if (over[k] !== undefined && (base[k] === undefined || typeof over[k] === typeof base[k])) out[k] = over[k];
    }
    return out;
  };
  const s = merge(d, stored) as Settings;
  s.keymap = stored.keymap && typeof stored.keymap === 'object' ? stored.keymap : {};
  return s;
}

// ---------------------------------------------------------------------------------------
// Project information (stored beside the screenplay, never inside it)

export type SceneStatus = '' | 'draft' | 'revise' | 'done';

export interface SceneRecord {
  id: string;
  /** Last known heading text (clean). */
  heading: string;
  /** Hash of the scene body for identity recovery. */
  fingerprint: string;
  /** Position in the outline when last saved. */
  order: number;
  summary?: string;
  status?: SceneStatus;
  color?: string;
  notes?: string;
}

export interface DetachedRecord extends SceneRecord {
  detachedAt: string;
  reason: string;
}

export interface ProjectMeta {
  format: 'scriptwright-project';
  version: 1;
  id: string;
  createdAt: string;
  notes: string;
  scenes: SceneRecord[];
  detached: DetachedRecord[];
  dictionary: string[];
  exportPresets: ExportPreset[];
  exportSettings?: ExportSettings;
}

export function emptyMeta(id: string): ProjectMeta {
  return {
    format: 'scriptwright-project',
    version: 1,
    id,
    createdAt: new Date().toISOString(),
    notes: '',
    scenes: [],
    detached: [],
    dictionary: [],
    exportPresets: [],
  };
}

// ---------------------------------------------------------------------------------------
// Export

export type PaperSize = 'A4' | 'Letter';
/** 'Courier Prime' (bundled), 'Courier' (built into PDF) or a system font family name. */
export type ExportFont = string;

/**
 * Export settings. Page geometry is measured in lines (vertical) and characters (horizontal)
 * of the script font, since screenplays are set in a monospaced font.
 */
export interface ExportSettings {
  paper: PaperSize;
  font: ExportFont;
  fontSize: number;
  /** Line height in points (12 = classic single spacing for 12 pt Courier). */
  lineHeight: number;
  // Page layout ------------------------------------------------------------------
  /** Blank lines above the first text line. */
  topMargin: number;
  /** Text lines per page. */
  linesPerPage: number;
  /** Characters from the page edge to the action column. */
  leftMargin: number;
  // Elements (characters from the action column) ---------------------------------
  actionWidth: number;
  characterIndent: number;
  dialogueIndent: number;
  dialogueWidth: number;
  parentheticalIndent: number;
  parentheticalWidth: number;
  transitionAlign: 'right' | 'left';
  transitionIndent: number;
  /** Blank lines between elements. */
  elementSpacing: number;
  /** Keep runs of several blank lines from the screenplay. */
  preserveBlankLines: boolean;
  boldCues: boolean;
  dualDialogue: 'side' | 'stacked';
  // Scene headings ------------------------------------------------------------------
  headingSpacingBefore: number;
  headingKeepLines: number;
  boldHeadings: boolean;
  underlineHeadings: boolean;
  sceneStartsNewPage: boolean;
  sceneNumbers: 'off' | 'left' | 'right' | 'both';
  autoSceneNumbers: boolean;
  sceneNumberFormat: string; // e.g. "{n}" or "{n}."
  // Page breaks ---------------------------------------------------------------------
  minLinesBeforeBreak: number;
  minLinesAfterBreak: number;
  splitDialogue: boolean;
  splitAction: boolean;
  useMoreContd: boolean;
  moreLabel: string;
  contdLabel: string;
  contdAfterAction: boolean;
  // Title page ------------------------------------------------------------------------
  titlePage: boolean;
  titleFont: ExportFont;
  titleSize: number;
  titleBold: boolean;
  titleUnderline: boolean;
  titleUppercase: boolean;
  /** Line (from the top of the page) where the title starts. */
  titleLine: number;
  contactPosition: 'bottom-left' | 'bottom-right';
  // Page furniture ------------------------------------------------------------------
  pageNumbers: boolean;
  pageNumberFirstPage: boolean;
  pageNumberPosition: 'top-right' | 'bottom-center' | 'bottom-right';
  pageNumberFormat: string;
  header: string;
  footer: string;
  draftDate: string;
  label: string;
  watermark: string;
  // Content -----------------------------------------------------------------------------
  includeNotes: boolean;
  includeSections: boolean;
  includeSynopses: boolean;
}

/** Lines per page that fill the paper with equal top and bottom margins. */
export function paperLines(paper: PaperSize): number {
  return paper === 'A4' ? 57 : 54;
}

export function defaultExportSettings(paper: PaperSize = 'Letter'): ExportSettings {
  return {
    paper,
    font: 'Courier Prime',
    fontSize: 12,
    lineHeight: 12,
    topMargin: 6,
    linesPerPage: paperLines(paper),
    leftMargin: 15,
    actionWidth: 60,
    characterIndent: 22,
    dialogueIndent: 10,
    dialogueWidth: 35,
    parentheticalIndent: 16,
    parentheticalWidth: 25,
    transitionAlign: 'right',
    transitionIndent: 45,
    elementSpacing: 1,
    preserveBlankLines: false,
    boldCues: false,
    dualDialogue: 'side',
    headingSpacingBefore: 1,
    headingKeepLines: 2,
    boldHeadings: true,
    underlineHeadings: false,
    sceneStartsNewPage: false,
    sceneNumbers: 'off',
    autoSceneNumbers: true,
    sceneNumberFormat: '{n}',
    minLinesBeforeBreak: 2,
    minLinesAfterBreak: 2,
    splitDialogue: true,
    splitAction: true,
    useMoreContd: true,
    moreLabel: '(MORE)',
    contdLabel: "(CONT'D)",
    contdAfterAction: false,
    titlePage: true,
    titleFont: 'Courier Prime',
    titleSize: 12,
    titleBold: false,
    titleUnderline: true,
    titleUppercase: true,
    titleLine: 22,
    contactPosition: 'bottom-left',
    pageNumbers: true,
    pageNumberFirstPage: false,
    pageNumberPosition: 'top-right',
    pageNumberFormat: '{n}.',
    header: '',
    footer: '',
    draftDate: '',
    label: '',
    watermark: '',
    includeNotes: false,
    includeSections: false,
    includeSynopses: false,
  };
}

/** Stored settings over defaults; settings from older versions (inch-based) are ignored. */
export function normalizeExportSettings(stored: Partial<ExportSettings> | undefined, paper: PaperSize): ExportSettings {
  const d = defaultExportSettings((stored?.paper as PaperSize) ?? paper);
  if (!stored) return d;
  const out: any = { ...d };
  for (const k of Object.keys(d) as Array<keyof ExportSettings>) {
    const v = (stored as any)[k];
    if (v !== undefined && typeof v === typeof (d as any)[k]) out[k] = v;
  }
  if (out.titleFont === 'Helvetica' || out.titleFont === 'Times') out.titleFont = 'Courier Prime';
  return out as ExportSettings;
}

export interface ExportPreset {
  name: string;
  settings: ExportSettings;
}

export type ExportScope =
  | { kind: 'all' }
  | { kind: 'scenes'; sceneLines: number[] }
  | { kind: 'pages'; pages: string }
  | { kind: 'scenesNewPage' }
  | { kind: 'character'; name: string }
  | { kind: 'dialogue'; name: string; action: boolean; headings: boolean };

export interface PaperDims {
  width: number;
  height: number;
}

export function paperDims(p: PaperSize): PaperDims {
  return p === 'A4' ? { width: 595.28, height: 841.89 } : { width: 612, height: 792 };
}

// ---------------------------------------------------------------------------------------
// App state (session restore)

export type ViewName = 'script' | 'scene' | 'dialogue' | 'source';

export interface ProjectSession {
  view: ViewName;
  caret: { line: number; ch: number; key?: number };
  scrollLine: number;
  focusedSceneId?: string;
  titleFocused?: boolean;
  dialogueCharacter?: string;
  dialogueScope?: 'scene' | 'all';
  dialogueAction?: boolean;
  source?: boolean;
}

export interface LayoutState {
  leftWidth: number;
  leftVisible: boolean;
  rightWidth: number;
  rightVisible: boolean;
  rightTab: 'notes' | 'scene' | 'history';
  projectsCollapsed: boolean;
}

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

export interface AppState {
  version: 1;
  workspace?: string;
  recentWorkspaces: string[];
  /** Project folder path relative to the workspace. */
  lastProject?: string;
  sessions: Record<string, ProjectSession>;
  layout: LayoutState;
  window: WindowState;
}

export function defaultAppState(): AppState {
  return {
    version: 1,
    recentWorkspaces: [],
    sessions: {},
    layout: { leftWidth: 260, leftVisible: true, rightWidth: 300, rightVisible: false, rightTab: 'notes', projectsCollapsed: false },
    window: { width: 1280, height: 820, maximized: false },
  };
}
