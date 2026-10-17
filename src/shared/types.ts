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
  /** Show the title page at the top of Script view (otherwise it is edited in its own view). */
  titlePageInScript: boolean;
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
  /** Interface language (the screenplay's own language is a project setting). */
  language: 'en' | 'de';
  /** Updates from GitHub releases. */
  updates: UpdateSettings;
  version: 1;
  editor: EditorSettings;
  appearance: AppearanceSettings;
  saving: SavingSettings;
  /** command id → list of key combos ([] = explicitly cleared). Missing = default. */
  keymap: Record<string, string[]>;
  cards: CardSettings;
  /** The four highlight slots: their color and the name shown in menus (e.g. "Fix later"). */
  highlights: Record<HighlightColor, { color: string; label: string }>;
  /** Export presets, shared by all projects of the workspace. */
  exportPresets: ExportPreset[];
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
  /** Show acts and sequences as foldable groups in the scene list. */
  actsInOutline: boolean;
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
    language: 'en',
    updates: { auto: true, repo: '', lastCheck: '', skip: '' },
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
      titlePageInScript: false,
    },
    appearance: { theme: 'dark', dark: { ...DEFAULT_DARK, background: { ...DEFAULT_DARK.background } }, light: { ...DEFAULT_LIGHT, background: { ...DEFAULT_LIGHT.background } } },
    saving: { autosaveDelayMs: 800, snapshotIntervalMin: 10 },
    keymap: {},
    highlights: {
      yellow: { color: '#E8C547', label: 'Yellow' },
      green: { color: '#6EC878', label: 'Green' },
      blue: { color: '#5AA0F0', label: 'Blue' },
      pink: { color: '#E5534B', label: 'Red' },
    },
    exportPresets: [],
    cards: { size: 'medium', colorStyle: 'tint', showSummary: true, showStatus: true, showCharacters: true, showLength: true, tintOutline: true, actsInOutline: true },
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
  // The fourth highlight used to be pink by default; red is the default now.
  const hp = s.highlights?.pink;
  if (hp && hp.color.toUpperCase() === '#EB78B4' && hp.label === 'Pink') s.highlights.pink = { ...d.highlights.pink };
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
  /** The export preset last chosen for this project (its settings may have changed since). */
  exportPresetName?: string;
  exportSettings?: ExportSettings;
  highlights: HighlightRecord[];
  comments: CommentRecord[];
  passages: PassageRecord[];
  shelf: ShelfItem[];
  /** Scenes taken out of the screenplay but kept, newest first. */
  sceneArchive: ArchivedScene[];
  drafts: DraftInfo[];
  exports: ExportRecord[];
  /** Version last used for "Mark changes since" in the export. */
  lastBaseline?: string;
  /** Scene numbers are locked for production (see shared/scenenumbers.ts). */
  numbersLocked?: boolean;
  /** Documents beside the screenplay (exposé, treatment …), in their order in the list. */
  documents?: DocumentRecord[];
  /** Documents print with justified paragraphs. */
  docJustify?: boolean;
  /** Story structure: the chosen model, which scene carries each beat, and an own model's beats. */
  structure?: StructureState;
}

/** A document of the project: a Markdown file in the project folder. */
export interface DocumentRecord {
  id: string;
  title: string;
  /** File name in the project folder ("Exposé.md"). */
  file: string;
  color?: string;
  archived?: boolean;
  created: string;
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
  /** Print settings used, so the History view can show the pages as they were sent. */
  settings?: ExportSettings;
  /** Kept at the top of the History view. */
  pinned?: boolean;
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
  /** Text around the place it came from, to find that place again. */
  origin?: ShelfOrigin;
}

export interface ShelfOrigin {
  before: string;
  after: string;
  /** Character offset in the screenplay when it was shelved (tie-breaker). */
  offset: number;
}

export interface DraftInfo {
  id: string;
  name: string;
  created: string;
  words: number;
  /** Scene ids in order, for comparisons that survive reordering. */
  sceneIds: string[];
  note?: string;
  /** Kept at the top of the History view. */
  pinned?: boolean;
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
    sceneArchive: [],
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
  /** Points from the top of the paper to the top of the first line's letters. */
  topMarginPt: number;
  /** Text lines per page. */
  linesPerPage: number;
  /** Characters from the page edge to the action column (halves allowed). */
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
  /** Gap between the scene number and the text column, in characters. */
  sceneNumberLeftGap: number;
  sceneNumberRightGap: number;
  // Page breaks ---------------------------------------------------------------------
  minLinesBeforeBreak: number;
  minLinesAfterBreak: number;
  splitDialogue: boolean;
  splitAction: boolean;
  /** Break dialogue only at the end of a sentence (otherwise at any line). */
  dialogueSentenceBreaks: boolean;
  useMoreContd: boolean;
  moreLabel: string;
  contdLabel: string;
  contdAfterAction: boolean;
  // Title page ------------------------------------------------------------------------
  titlePage: boolean;
  titleFont: ExportFont;
  titleSize: number;
  /** Extra space between the title's letters, in percent of the title size. */
  titleTracking: number;
  titleBold: boolean;
  titleUnderline: boolean;
  titleUppercase: boolean;
  /** Points from the top of the paper to the baseline of the title. */
  titleBaseline: number;
  /** Distance of the bottom details from the left, right and bottom edges of the paper, in points. */
  titleInset: number;
  /** Extra space between the letters of credit, author and details, in percent of 12 pt. */
  titleDetailsTracking: number;
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
  /** Header note for marked changes; {version} is the version compared with. */
  revHeaderText: string;
  // Content -----------------------------------------------------------------------------
  includeNotes: boolean;
  includeSections: boolean;
  includeSynopses: boolean;
  /** Filled in from the project when exporting (not a print setting): scene numbers are locked. */
  numbersLocked?: boolean;
}

/** Default line height: 12 pt Courier set slightly tighter than single spacing (6.41 lines per inch). */
export const DEFAULT_LINE_HEIGHT = 11.232;

/** Lines per page that fill the paper at the default line height (1 in top, about 0.85 in bottom). */
export function paperLines(paper: PaperSize): number {
  return paper === 'A4' ? 63 : 58;
}

/** Script language used for defaults such as the (MORE) label. */
export type ScriptLanguage = 'en' | 'de';

export function defaultExportSettings(paper: PaperSize = 'Letter', lang: ScriptLanguage = 'en'): ExportSettings {
  return {
    paper,
    font: 'Courier Prime',
    fontSize: 12,
    lineHeight: DEFAULT_LINE_HEIGHT,
    topMarginPt: 72,
    linesPerPage: paperLines(paper),
    leftMargin: 12.5,
    actionWidth: 60,
    characterIndent: 22.5,
    dialogueIndent: 12.5,
    dialogueWidth: 36,
    parentheticalIndent: 17.5,
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
    sceneNumbers: 'both',
    autoSceneNumbers: true,
    sceneNumberFormat: '{n}',
    sceneNumberLeftGap: 4,
    sceneNumberRightGap: 1,
    minLinesBeforeBreak: 2,
    minLinesAfterBreak: 2,
    splitDialogue: true,
    splitAction: true,
    dialogueSentenceBreaks: false,
    useMoreContd: true,
    moreLabel: lang === 'de' ? '(MEHR)' : '(MORE)',
    contdLabel: lang === 'de' ? '' : "(CONT'D)",
    contdAfterAction: false,
    titlePage: true,
    titleFont: 'Courier Prime',
    titleSize: 48,
    titleTracking: 0,
    titleBold: true,
    titleUnderline: false,
    titleUppercase: true,
    titleBaseline: 287,
    titleInset: 70,
    titleDetailsTracking: 5,
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
    revColor: '#D0312D',
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
    revHeaderText: lang === 'de' ? 'Änderungen seit {version}' : 'Changes since {version}',
    includeNotes: false,
    includeSections: false,
    includeSynopses: false,
  };
}

/** Settings saved before page geometry moved to lines and characters (measured in inches). */
function isInchGeometry(stored: any): boolean {
  return 'marginLeft' in stored || 'linesPerInch' in stored || 'titlePosition' in stored || (!('topMargin' in stored) && !('topMarginPt' in stored));
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
  out.paper = paper;
  for (const k of ['marginLeft', 'marginRight', 'marginTop', 'marginBottom', 'linesPerInch', 'titlePosition']) delete out[k];
  return out;
}

/**
 * Defaults before the layout was modelled on a finished German screenplay (round 11). Stored
 * settings that still hold one of these values were never changed by the writer, so they
 * move to the new default.
 */
const OLD_DEFAULTS: Record<string, unknown> = {
  lineHeight: 12,
  leftMargin: 15,
  characterIndent: 22,
  dialogueIndent: 10,
  dialogueWidth: 35,
  parentheticalIndent: 16,
  sceneNumbers: 'off',
  titleSize: 12,
  titleBold: false,
  titleUnderline: true,
  moreLabel: '(MORE)',
  contdLabel: "(CONT'D)",
};

/** Moves settings saved before round 11 (top margin and title in lines) to the current model. */
function upgradeLineGeometry(stored: any, d: ExportSettings): any {
  const out: any = { ...stored };
  const lh = typeof stored.lineHeight === 'number' ? stored.lineHeight : 12;
  for (const [k, v] of Object.entries(OLD_DEFAULTS)) if (out[k] === v) out[k] = (d as any)[k];
  if (out.linesPerPage === (d.paper === 'A4' ? 57 : 54)) out.linesPerPage = d.linesPerPage;
  if (typeof stored.topMargin === 'number' && stored.topMargin !== 6) out.topMarginPt = Math.round(stored.topMargin * lh);
  if (typeof stored.titleLine === 'number' && stored.titleLine !== 22) out.titleBaseline = Math.round(stored.titleLine * lh);
  delete out.topMargin;
  delete out.titleLine;
  return out;
}

/** Stored settings over defaults. Settings from earlier versions are converted. */
export function normalizeExportSettings(stored: Partial<ExportSettings> | undefined, paper: PaperSize, lang: ScriptLanguage = 'en'): ExportSettings {
  const p = ((stored?.paper as PaperSize) ?? paper) === 'A4' ? 'A4' : 'Letter';
  const d = defaultExportSettings(p, lang);
  if (!stored || typeof stored !== 'object') return d;
  let src: any = isInchGeometry(stored) ? convertInchGeometry(stored, p) : stored;
  if (!('topMarginPt' in src)) src = upgradeLineGeometry(src, d);
  const out: any = { ...d };
  for (const k of Object.keys(d) as Array<keyof ExportSettings>) {
    const v = (src as any)[k];
    if (v !== undefined && typeof v === typeof (d as any)[k]) out[k] = v;
  }
  if (out.titleFont === 'Helvetica' || out.titleFont === 'Times') out.titleFont = 'Courier Prime';
  // Change marks used to default to blue; red is the convention.
  if (out.revColor === '#1E63C8') out.revColor = d.revColor;
  // Guard against impossible values from damaged settings: fall back to defaults.
  if (out.actionWidth < 20 || out.dialogueWidth < 8 || out.linesPerPage < 10) {
    for (const k of ['actionWidth', 'characterIndent', 'dialogueIndent', 'dialogueWidth', 'parentheticalIndent', 'parentheticalWidth', 'linesPerPage', 'topMarginPt', 'leftMargin', 'lineHeight'] as const) (out as any)[k] = (d as any)[k];
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
  /** Scene list folded away in the left pane. */
  scenesCollapsed?: boolean;
  /** Documents list folded away in the left pane. */
  documentsCollapsed?: boolean;
  /** Documents list: the archive group is open. */
  docArchiveOpen?: boolean;
  /** Characters view: width of the detail pane and of the name column. */
  charDetailWidth?: number;
  charNameWidth?: number;
  /** Cards panel: the card grid or the timeline. */
  cardsMode?: 'cards' | 'timeline';
  /** Export preview: brightness of the white page, 40–100 (%). */
  previewBrightness?: number;
  /** Export settings groups that are open. */
  exportOpen?: string[];
  /** Scene list: the archive group is open. */
  sceneArchiveOpen?: boolean;
  /** Scene list: acts and sequences folded closed (by level and title). */
  outlineFolded?: string[];
  /** Review pane: groups that are folded closed. */
  reviewFolded?: string[];
  /** History: show only the scenes that differ. */
  historyOnlyDiff?: boolean;
  /** History lists: kinds of versions shown. */
  historyKinds?: Array<'draft' | 'export' | 'snapshot'>;
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
  /** Keep settings in the workspace folder (default) instead of only on this computer. */
  settingsInWorkspace?: boolean;
}

export function defaultAppState(): AppState {
  return {
    version: 1,
    recentWorkspaces: [],
    sessions: {},
    layout: { leftWidth: 280, leftVisible: true, rightWidth: 320, rightVisible: false, rightTab: 'notes', projectsCollapsed: false },
    window: { width: 1280, height: 820, maximized: false },
  };
}

export interface StructureState {
  model: string;
  /** Beat id → scene id. */
  beats: Record<string, string>;
  /** Beats of the project's own model. */
  custom: Array<{ id: string; name: string; at: number; hint?: string }>;
}

export interface ArchivedScene {
  /** The scene's id when it was archived. */
  id: string;
  heading: string;
  /** Number shown for it at the time (1, 2 … or a locked 12A). */
  number: string;
  /** Its lines, heading first. */
  lines: string[];
  summary?: string;
  status?: SceneStatus;
  color?: string;
  notes?: string;
  archivedAt: string;
  /** Scene it followed and scene that followed it (to put it back where it was). */
  afterId?: string;
  beforeId?: string;
  /** It was the first scene of an act or sequence (goes back after that section line). */
  opensSection?: boolean;
}

export interface UpdateSettings {
  /** Look for a new version once a day when the app starts. */
  auto: boolean;
  /** GitHub repository (owner/name) the releases come from; empty = the one built in. */
  repo: string;
  /** When updates were last looked for (ISO). */
  lastCheck: string;
  /** A version the writer chose to skip. */
  skip: string;
}
