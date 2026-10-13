# Scriptwright

A fast, dependable desktop screenplay editor for writers and directors who prefer manual
writing and keyboard control. Every screenplay is one readable Fountain file; notes, scene
information, history and export settings live beside it.

This is **stage 1** of the product described in the brief: the core writing app plus
professional PDF export. Later stages are listed at the end, with what exists today.

## Getting started

Requirements: Node.js 20 or newer.

```bash
npm install          # also downloads Courier Prime into resources/fonts
npm start            # builds and runs the Electron app
```

Other scripts:

| Command | What it does |
| --- | --- |
| `npm test` | Unit tests (parser, pagination, PDF output, rename, storage, scene identity) |
| `npm run e2e` | End-to-end checks in Chromium through the browser harness |
| `npm run dev:browser` | Runs the renderer in a normal browser at http://127.0.0.1:5174 with the real backend (for development) |
| `npm run typecheck` | TypeScript check |
| `npm run dist:mac` / `dist:win` / `dist:linux` | Installers via electron-builder (build on the target OS) |

If `npm install` cannot reach GitHub, place the four Courier Prime TTF files and `OFL.txt`
in `resources/fonts` (see the README there). Without them the app uses Courier and says so.

## What stage 1 includes

**Writing**
- Live Fountain formatting for every element: headings (standard and configurable prefixes such
  as INNEN/AUSSEN), action, cues with extensions, dialogue, parentheticals, transitions,
  centered text, lyrics, dual dialogue, bold/italic/underline and combinations, escapes,
  title page fields, page breaks, notes, omitted text, sections, synopses, scene numbers,
  and forcing with `.`, `@`, `!`, `>`, `~`.
- Clean text: formatting operators are removed from the layout on inactive lines and revealed
  on the caret line. Clicks resolve to a stable position before the reveal; double and triple
  clicks select the word or line that was under the pointer.
- Typing a cue and pressing Enter starts dialogue immediately; a blank line ends it. Nothing is
  auto-completed, capitalized or rewritten.
- Selection follows the text (dialogue selections do not paint to the column edge). The caret
  blinks in the primary text color. A Fountain source mode shows the raw text.

**Views and organization**
- Script, Scene and Dialogue views over the same text (never copies). Scene view keeps each
  scene's caret, selection and scroll; typing a new heading there adds the outline entry
  immediately while the text stays in the pane. Scene → Script puts the edited scene's heading
  near the top.
- Dialogue view: all characters or one (sorted by cue count, `LISA (12 cues)`), whole script
  or current scene, optional nearby action, clear "action hidden" markers, edits go to the
  original, and edits never delete hidden writing.
- Outline with order numbers, active/reading markers, search, keyboard navigation, creation,
  duplication, removal, drag-and-drop and keyboard reordering (all undoable). Scene cards
  overview using the same order. Title page entry that is not Scene 1.
- Scene summaries, status, color and notes; project notes. Scene information follows heading
  edits and reordering, survives reopening and external reordering, and is set aside for review
  (never attached to the wrong scene) when a scene cannot be identified.
- Whole-script character rename with casing preserved, longer names protected, merge warning,
  one undo step.

**Files and safety**
- Workspace folder with projects; loose `.fountain` files can be adopted into a project.
- Atomic autosave after a short pause; truthful saved / unsaved / error state; changes made
  during a save stay pending.
- Every save checks that the file on disk is still the version being edited. External edits
  reload automatically when there are no local changes; otherwise both versions are kept and
  you choose (with a line comparison). Deleted or renamed files, damaged project information,
  sync conflict copies and a project open on another computer are detected and explained.
- Recovery copy outside the project folder while there are unsaved changes; offered on reopen.
- Automatic history snapshots with preview and undoable restore. Retention: everything from the
  last 24 hours, then one per day for 30 days.
- Complete project backup and import (ZIP with all project information).
- Session restore: workspace, project, view, focused scene, caret, pane sizes and visibility,
  window size and position.

**Commands and appearance**
- Command window (⌘K / Ctrl+K) to search and run commands, record shortcuts (the pressed keys
  never trigger their old command), see and resolve conflicts, clear and restore defaults.
  Changes apply immediately and are saved.
- Settings: editor (font, size, line height, measure, default heading, blank line after
  heading, extra prefixes, spellchecking with German/English and a project dictionary,
  typewriter scrolling), appearance (dark/light, text/accent/heading/action colors, background
  hue/saturation/brightness with a contrast check), commands & shortcuts, saving & history.
- Minimal view (only the text and its scrollbar), maximize/restore without drift.

**PDF export**
- Export workspace with a preview rendered from the actual PDF, validated line capacity and
  real page counts (runtime estimate clearly marked as approximate).
- A4/Letter, margins, Courier Prime or Courier, size, line and element spacing, all element
  widths and indents, heading spacing and keep-with-next, explicit page breaks, no orphaned
  headings/cues/parentheticals, sentence-aware action and dialogue splitting with minimum lines,
  optional (MORE)/(CONT'D), new-page scene starts, title page layout (title font only for the
  title), contact position, page and scene numbers, header, footer, draft date, label, watermark.
- Complete script, selected scenes, selected pages, each scene on a new page, a separate PDF per
  scene, or scenes with a chosen character. Notes, sections and synopses excluded by default.
- Named presets per project and reset to defaults. Very long passages paginate without loss.

## Default shortcuts

`Mod` is ⌘ on macOS and Ctrl on Windows/Linux. All can be changed in the command window.

| Action | Shortcut |
| --- | --- |
| Previous / next scene | ⌥/Alt + ← / → |
| Script ⇄ Scene (editor focused) | Tab |
| Title page | Mod+T |
| New scene after the current one | Mod+N |
| Export | Mod+E |
| Search scenes / search in screenplay | Mod+F / Mod+Shift+F |
| Settings / commands & shortcuts | Mod+P / Mod+K |
| Minimal view | Mod+M |
| Maximize / restore | Mod+Ö |
| Save / quit | Mod+S / Mod+Q |
| Script, Scene, Dialogue view | Mod+1, Mod+2, Mod+3 |
| Move scene up / down | ⌥⇧/Alt+Shift + ↑ / ↓ |
| Go to passage (from Scene or Dialogue view) | Mod+Enter |
| Scene cards | Mod+Shift+O |

Escape closes menus and dialogs, leaves search fields and exits minimal view.
Word movement: Ctrl+←/→ on Windows/Linux; on macOS ⌥⇧←/→ selects by word (⌥←/→ is scene
navigation by default; rebinding it restores word movement).

## Files on disk

```
Workspace/
  My Film/
    My Film.fountain            ← the complete screenplay, readable by any Fountain app
    .scriptwright/
      project.json              ← notes, scene information, dictionary, export presets
      history/                  ← automatic snapshots
      conflicts/                ← versions kept when two edits collided
```

Project information never goes into the Fountain file. If `project.json` is missing or
damaged, the screenplay still opens (a damaged file is kept aside, not overwritten).

## Testing status

Distinguishing what was actually run from what was not:

| Area | Status |
| --- | --- |
| Parser (incl. a 3,000-case fuzz test of incremental parsing), pagination, PDF writer, rename, scene matching, storage backend | 75 unit tests, run on Linux (Node 22) |
| Renderer (editor, views, outline, dialogs, export preview) | 5 end-to-end suites (55 checks) in Chromium on Linux through the browser harness, including a macOS key-binding pass |
| Typing latency | ≈4 ms per keystroke on a 6,200-line (≈130 page) script in Chromium |
| Electron shell (window, menus, dialogs, IPC, close/quit, maximize, spellchecking) | **Written but not run** — Electron could not be installed in the build environment |
| macOS, Windows | **Not tested** |
| Packaging (electron-builder) | **Not run** |

The Electron main process is a thin layer over the same backend the tests exercise, but
please run `npm start` on each platform before relying on it.

## Architecture

- `src/shared` — Fountain parser (with an incremental single-line path), document model with
  stable line keys, pagination, rename, scene identity. No DOM or Node dependencies.
- `src/main` — backend (files, saving, watching, history, recovery, backups), PDF writer with
  TrueType embedding, Electron main process.
- `src/renderer` — custom editor view (hidden-textarea input, measured caret and selection),
  app shell, panes and dialogs.
- `dev/harness.ts` — serves the renderer to a browser with the real backend over HTTP (tests and
  development only; not shipped).

## Roadmap (later stages of the brief)

| Brief section | Status |
| --- | --- |
| §13 Rewrite and alternative passages | Not started |
| §14 Cut-material shelf | Not started |
| §15 Named drafts and draft/scene comparison | Automatic history with preview and restore exists; named drafts and position-independent scene comparison not started |
| §16 Comments, highlights, detached-annotation review | Project and scene notes exist; comments and highlights not started (line keys are in place for anchoring) |
| §21 Collaboration | Not started |
| §24 Production tools (revision sets, locked numbering, reports, Final Draft) | Not started |
| Alt/⌥+A (Rewrite) and Mod+H (highlights) shortcuts | Reserved for those features |
