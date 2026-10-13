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
  /** Show scene numbers (#12#) in the margin. */
  showSceneNumbers: boolean;
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
      showSceneNumbers: true,
    },
    appearance: { theme: 'dark', dark: { ...DEFAULT_DARK, background: { ...DEFAULT_DARK.background } }, light: { ...DEFAULT_LIGHT, background: { ...DEFAULT_LIGHT.background } } },
    saving: { autosaveDelayMs: 800, snapshotIntervalMin: 10 },
    keymap: {},
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
export type ExportFont = 'Courier' | 'Courier Prime';

export interface ExportSettings {
  paper: PaperSize;
  /** Margins in inches. */
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
  font: ExportFont;
  fontSize: number;
  /** Lines per inch (6 = standard single spacing at 12pt). */
  linesPerInch: number;
  /** Blank lines between elements. */
  elementSpacing: number;
  /** Blank lines before a scene heading (in addition to nothing). */
  headingSpacingBefore: number;
  /** Lines of following content kept on the same page as a heading. */
  headingKeepLines: number;
  boldHeadings: boolean;
  underlineHeadings: boolean;
  // Element geometry, inches measured from the left margin
  characterIndent: number;
  dialogueIndent: number;
  dialogueWidth: number;
  parentheticalIndent: number;
  parentheticalWidth: number;
  actionWidth: number;
  // Page breaking
  minLinesBeforeBreak: number;
  minLinesAfterBreak: number;
  splitDialogue: boolean;
  splitAction: boolean;
  moreLabel: string;
  contdLabel: string;
  useMoreContd: boolean;
  /** Add (CONT'D) when the same character speaks again after only action in the same scene. */
  contdAfterAction: boolean;
  sceneStartsNewPage: boolean;
  // Title page
  titlePage: boolean;
  titleFont: ExportFont | 'Helvetica' | 'Times';
  titleSize: number;
  titleBold: boolean;
  titleUnderline: boolean;
  titleUppercase: boolean;
  /** Vertical position of the title block, fraction of page height from the top. */
  titlePosition: number;
  contactPosition: 'bottom-left' | 'bottom-right';
  // Numbering & page furniture
  pageNumbers: boolean;
  pageNumberFirstPage: boolean;
  pageNumberPosition: 'top-right' | 'bottom-center' | 'bottom-right';
  pageNumberFormat: string; // e.g. "{n}."
  sceneNumbers: 'off' | 'left' | 'right' | 'both';
  /** Number scenes automatically when they have no #n# number. */
  autoSceneNumbers: boolean;
  header: string;
  footer: string;
  draftDate: string;
  label: string;
  watermark: string;
  // Content
  includeNotes: boolean;
  includeSections: boolean;
  includeSynopses: boolean;
}

export function defaultExportSettings(paper: PaperSize = 'Letter'): ExportSettings {
  return {
    paper,
    marginTop: 1,
    marginBottom: 1,
    marginLeft: 1.5,
    marginRight: 1,
    font: 'Courier Prime',
    fontSize: 12,
    linesPerInch: 6,
    elementSpacing: 1,
    headingSpacingBefore: 1,
    headingKeepLines: 2,
    boldHeadings: true,
    underlineHeadings: false,
    characterIndent: 2.0,
    dialogueIndent: 1.0,
    dialogueWidth: 3.5,
    parentheticalIndent: 1.5,
    parentheticalWidth: 2.5,
    actionWidth: 6.0,
    minLinesBeforeBreak: 2,
    minLinesAfterBreak: 2,
    splitDialogue: true,
    splitAction: true,
    moreLabel: '(MORE)',
    contdLabel: "(CONT'D)",
    useMoreContd: true,
    contdAfterAction: false,
    sceneStartsNewPage: false,
    titlePage: true,
    titleFont: 'Courier Prime',
    titleSize: 12,
    titleBold: false,
    titleUnderline: true,
    titleUppercase: true,
    titlePosition: 0.36,
    contactPosition: 'bottom-left',
    pageNumbers: true,
    pageNumberFirstPage: false,
    pageNumberPosition: 'top-right',
    pageNumberFormat: '{n}.',
    sceneNumbers: 'off',
    autoSceneNumbers: true,
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

export interface ExportPreset {
  name: string;
  settings: ExportSettings;
}

export type ExportScope =
  | { kind: 'all' }
  | { kind: 'scenes'; sceneLines: number[] }
  | { kind: 'pages'; pages: string }
  | { kind: 'scenesNewPage' }
  | { kind: 'character'; name: string };

export interface PaperDims {
  width: number;
  height: number;
}

export function paperDims(p: PaperSize): PaperDims {
  return p === 'A4' ? { width: 595.28, height: 841.89 } : { width: 612, height: 792 };
}

// ---------------------------------------------------------------------------------------
// App state (session restore)

export type ViewName = 'script' | 'scene' | 'dialogue';

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
