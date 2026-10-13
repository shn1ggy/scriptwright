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
  highlights: HighlightRecord[];
  comments: CommentRecord[];
  passages: PassageRecord[];
  shelf: ShelfItem[];
  drafts: DraftInfo[];
  exports: ExportRecord[];
  /** Version last used for "Mark changes since" in the export. */
  lastBaseline?: string;
}

/** A copy of the screenplay saved with every PDF export, to compare later versions against. */
export interface ExportRecord {
  id: string;
  name: string;
  note: string;
  created: string;
  pages: number;
  /** What was exported, e.g. "Complete screenplay". */
  scope: string;
  /** Where the PDF was written (for reference only). */
  file?: string;
  sceneIds: string[];
  /** The version this export marked changes against. */
  comparedWith?: string;
}

/** Text position stored as quoted text with context (see shared/anchors.ts). */
export interface StoredAnchorRec {
  quote: string;
  prefix: string;
  suffix: string;
  line: number;
}

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink';

export interface HighlightRecord {
  id: string;
  color: HighlightColor;
  anchor: StoredAnchorRec;
  /** Reason when the text could not be found; the record is kept for review. */
  detached?: string;
  created: string;
}

export interface CommentReply {
  id: string;
  text: string;
  created: string;
}

export interface CommentRecord {
  id: string;
  text: string;
  created: string;
  resolved: boolean;
  replies: CommentReply[];
  anchor: StoredAnchorRec;
  detached?: string;
  sceneHeading?: string;
}

export interface Alternative {
  id: string;
  name: string;
  /** For the active alternative this is refreshed from the screenplay when switching away. */
  text: string;
  created: string;
}

export interface PassageRecord {
  id: string;
  name: string;
  anchor: StoredAnchorRec;
  activeId: string;
  alternatives: Alternative[];
  detached?: string;
  sceneHeading?: string;
}

export interface ShelfItem {
  id: string;
  text: string;
  created: string;
  kind: 'cut' | 'copy';
  sceneId?: string;
  sceneHeading?: string;
  note?: string;
}

export interface DraftInfo {
  id: string;
  name: string;
  created: string;
  words: number;
  /** Scene ids in order, for comparisons that survive reordering. */
  sceneIds: string[];
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
    highlights: [],
    comments: [],
    passages: [],
    shelf: [],
    drafts: [],
    exports: [],
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
  // Revision marks (changes since an earlier version) -----------------------------------
  revColor: string;
  revColorText: boolean;
  revHighlight: boolean;
  revUnderline: boolean;
  revBold: boolean;
  revMargin: boolean;
  revMarkChar: string;
  revIgnoreOrder: boolean;
  revIgnoreSceneNumbers: boolean;
  revMarkDeletions: boolean;
  revMarkMoved: boolean;
  revChangedPagesOnly: boolean;
  revHeaderNote: boolean;
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
    revColor: '#1E63C8',
    revColorText: true,
    revHighlight: false,
    revUnderline: false,
    revBold: false,
    revMargin: true,
    revMarkChar: '*',
    revIgnoreOrder: true,
    revIgnoreSceneNumbers: true,
    revMarkDeletions: true,
    revMarkMoved: false,
    revChangedPagesOnly: false,
    revHeaderNote: true,
    includeNotes: false,
    includeSections: false,
    includeSynopses: false,
  };
}

/** Settings saved before page geometry moved to lines and characters (measured in inches). */
function isInchGeometry(stored: any): boolean {
  return 'marginLeft' in stored || 'linesPerInch' in stored || 'titlePosition' in stored || !('topMargin' in stored);
}

/** Converts inch-based settings (first version) to lines and characters. */
function convertInchGeometry(stored: any, paper: PaperSize): any {
  const out: any = { ...stored };
  const size = typeof stored.fontSize === 'number' ? stored.fontSize : 12;
  const cpi = 72 / (size * 0.6); // characters per inch
  const lpi = typeof stored.linesPerInch === 'number' ? stored.linesPerInch : 6;
  const hIn = paperDims(paper).height / 72;
  const top = typeof stored.marginTop === 'number' ? stored.marginTop : 1;
  const bottom = typeof stored.marginBottom === 'number' ? stored.marginBottom : 1;
  const chars = (k: string) => {
    if (typeof stored[k] === 'number') out[k] = Math.round(stored[k] * cpi);
  };
  for (const k of ['actionWidth', 'characterIndent', 'dialogueIndent', 'dialogueWidth', 'parentheticalIndent', 'parentheticalWidth']) chars(k);
  if (typeof stored.marginLeft === 'number') out.leftMargin = Math.round(stored.marginLeft * cpi);
  out.lineHeight = Math.round((72 / lpi) * 2) / 2;
  out.topMargin = Math.round(top * lpi);
  out.linesPerPage = Math.floor((hIn - top - bottom) * lpi + 1e-6);
  if (typeof stored.titlePosition === 'number') out.titleLine = Math.round(stored.titlePosition * hIn * lpi);
  for (const k of ['marginLeft', 'marginRight', 'marginTop', 'marginBottom', 'linesPerInch', 'titlePosition']) delete out[k];
  return out;
}

/** Stored settings over defaults. Settings from the first (inch-based) version are converted. */
export function normalizeExportSettings(stored: Partial<ExportSettings> | undefined, paper: PaperSize): ExportSettings {
  const p = ((stored?.paper as PaperSize) ?? paper) === 'A4' ? 'A4' : 'Letter';
  const d = defaultExportSettings(p);
  if (!stored || typeof stored !== 'object') return d;
  const src = isInchGeometry(stored) ? convertInchGeometry(stored, p) : stored;
  const out: any = { ...d };
  for (const k of Object.keys(d) as Array<keyof ExportSettings>) {
    const v = (src as any)[k];
    if (v !== undefined && typeof v === typeof (d as any)[k]) out[k] = v;
  }
  if (out.titleFont === 'Helvetica' || out.titleFont === 'Times') out.titleFont = 'Courier Prime';
  // Guard against impossible values from damaged settings: fall back to defaults.
  if (out.actionWidth < 20 || out.dialogueWidth < 8 || out.linesPerPage < 10) {
    for (const k of ['actionWidth', 'characterIndent', 'dialogueIndent', 'dialogueWidth', 'parentheticalIndent', 'parentheticalWidth', 'linesPerPage', 'topMargin', 'leftMargin', 'lineHeight'] as const) (out as any)[k] = (d as any)[k];
  }
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
  rightTab: 'notes' | 'scene' | 'comments' | 'shelf' | 'history';
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
