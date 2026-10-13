# Scriptwright design manifest

What the app should feel like, and the rules every screen follows. When a new feature needs a
control, a list or a dialog, take it from here. If something here no longer fits, change this
file first, then the code.

## 1. Character

- **The page is the work.** The screenplay is the only thing that may be big, bright or
  colourful. Everything around it (panes, bars, menus, dialogs) is quiet, calm and secondary.
- **Calm, not cramped.** Chrome is compact enough to leave the page most of the window, but
  every row, field and button has room to breathe and to be hit with a mouse or trackpad.
- **Keyboard first, mouse friendly.** Every action has a command (and usually a shortcut); every
  command also has a visible place to click.
- **One app, one voice.** The same thing looks and is named the same everywhere (a scene is a
  scene, a speech is a speech, Delete is Delete).

## 2. Layout of the window

```
┌ title bar 38 ─ ● ● ●  ▣  Project  file.fountain ························ ▣ ┐
├ tab bar 40 ── Script  Scene  Cards  Dialogue  Characters ·· Source  History  Export ┤
│ scene pane 280 │ view header 40 (Dialogue, Cards, Characters)  │ notes 320 │
│ Projects  + …  │                                               │ tabs 40   │
│  project       │            the page (Courier, centred)        │           │
│ Scenes  + …    │                                               │           │
│  search        │                                               │           │
│  1 INT. …      │                                               │           │
│ ─────────────  │                                               │           │
│ workspace ⌄ ⌘⚙ │                                               │           │
├ status bar 26 ─ (under the text view only) saved · counts ···· Scene 4 of 38 ‹ › ┤
```

- The **tab bar holds only tabs.** Options of a view live in that view's own header row.
- **Export is a tab** at the far right of the tab bar. It covers both panes (their toggles rest)
  and starts below the tab bar like every other view. **History** works the same way: one
  timeline of drafts, exports and snapshots (grouped by time, older months folded, pins on top,
  Named / Snapshots / All) and the chosen version as Scenes, All changes or Pages, compared
  with the current screenplay or any other version. Kinds are switched with three toggles
  (Drafts, Exports, Snapshots; drafts and exports by default). Views: Scenes, All changes,
  Pages and Text (the plain Fountain text to copy from). The notes pane keeps Save as Draft,
  Snapshot Now, Open History, the same toggles and as many versions as fit.
- While Cards is open, the notes pane's Scene tab follows the card with the cursor.
- The title bar holds only the pane toggles and the project name. Commands and Settings sit at
  the bottom of the scene pane, next to the workspace switcher.
- **Outer edge: 14 px.** Text and controls start 14 px from the window's left edge and end 14 px
  from its right edge in every bar and pane (tab bar, panes, view headers, status bar).
- View headers (Dialogue, Cards, Characters, Export) are 40 px: title, a short info, then the
  view's controls; all controls in them are 30 px. Scene view has no header: previous/next
  scene sit in the status bar.
- **Double-click a tab** to open it in focus: both side panes are hidden (Export excepted).
- The notes pane's tabs are right-aligned, so the last one ends 14 px from the window edge.
- **Scene pane:** minimum 220 px, default 280 px. **Notes pane:** minimum 310 px, default 320 px.
- Text in the interface is not selectable; text a person writes is.
- The status bar lines up with the text view between the panes; with both panes hidden it
  uses the full width. The editor reserves its scrollbar space, so text never shifts.
- Double-clicking a tab hides both panes; double-clicking again brings them back.
- Esc never closes Cards or Characters: in Cards it clears the selection.
- Settings, the layout and view options (pane widths, open groups, preview brightness …) are
  saved in the workspace so it looks the same on every computer; a switch keeps them local.
- Export settings are grouped and fold open and closed; This version, Content and Mark changes
  start open. Change marks are red by default and run on across the spaces between words.

## 3. Spacing and sizes

Everything sits on a **4 px grid**. Spacing steps: **4 · 8 · 12 · 16 · 20 · 24 · 32**.

| Element | Height | Inner padding |
| --- | --- | --- |
| Title bar | 38 | 10 sides (80 left of the macOS buttons) |
| Tab bar | 40 | tabs 14 (14 to the window edges) |
| View header (Scene, Dialogue) | 40 | 14 |
| Section heading in a pane (Projects, Scenes) | 36 | 14 left |
| List row (projects, scenes, results) | 28 | 14 sides, 10 gap |
| Control: button, field, select | 30 | 10 sides |
| Small control (inside lists, cards, toolbars) | 24 | 8 sides |
| Icon button | 30 (26 in headings) | icon 16 |
| Menu item | 28 | 10 sides; menu padding 6 |
| Dialog (default width 480, settings 860 × 640) | | |
| Dialog head / foot | 46 / 58 | 20 sides |
| Dialog body | | 20 top/bottom, 24 sides, 14 between rows |
| Settings: navigation row | 32 | 12 sides |
| Status bar | 26 | 14 sides |

Forms use a two-column grid: **label column 160–168 px, gap 16 px**, field up to 380 px.
Help text sits directly under its field (4 px), and the next row follows after 14 px.

## 4. Type

- **Interface:** the system font (SF Pro on macOS, Segoe UI on Windows).
  13 px body · 12 px secondary and help text · 11.5 px captions · 14 px dialog titles.
- **The page:** Courier Prime 12 pt at export; on screen as set in Settings (default 16 px / 24 px).
- **Headings in panes, menus and dialogs are sentence case**, 12–13 px semibold. No all-caps
  labels with letter spacing.
- Numbers that line up (scene numbers, counts, page numbers) use tabular figures.

## 5. Colour

- Colours come from the theme (Appearance settings): background, text, secondary text, accent,
  heading and action colours. Panels are derived from the background.
- **Accent means state:** selection, focus, the active tab or scene. Never decoration.
- **Meaning colours** are fixed and used only for their meaning:
  comments **yellow**, alternative passages **blue**, highlights **as set in Settings**,
  warnings amber, danger red, done green.
- Scene colours (red … purple) belong to the writer; the interface never uses them for itself.

## 6. Shapes and depth

- Corner radius: **6** controls and rows · **8** menus, cards, list items in panes · **10** dialogs.
- Separate areas with **1 px lines**, not shadows. Shadows only for things that float above the
  page: menus, dialogs, the find bar, toasts.
- Cards and boxes only where something is a separate object (a comment, a scene card). Plain
  lists stay plain.
- **Hover:** every button, icon button and list row shows a subtle hover (text colour at 7–8 %
  over whatever is behind it), so it works on panels, cards and dialogs alike.
- **Destructive buttons** (Delete, Remove) are red-tinted with normal text, never red text on the
  accent colour.
- **Search and filter fields** have a clear button (×) while they contain text.
- **Settings** are denser than the rest (30 px navigation rows, 10 px between rows): it is a
  long list read top to bottom.
- **Checkboxes** are drawn by the app: 16 px, radius 4, accent fill with a check when on.
- **Two-way choices** in a pane (Open / Resolved) are a segmented switch, not a checkbox.
- A scene's colour shows as the colour of its number in the scene list (nothing that shifts the
  heading); cards and the optional row tint use it more strongly.

## 7. Behaviour

- Every change to the screenplay is undoable, and so is every change around it: comments,
  replies, resolving, highlights, alternative passages and their versions, the shelf and scene
  details share one history with the text (Mod+Z / Mod+Shift+Z). Destructive actions on files
  ask first and say where things go (Trash, Archive).
- A key a field or dialog handles (Enter, Mod+Enter) is consumed there and never also runs a
  menu command.
- Switching views never moves the caret on screen.
- One instance of each window (pressing a shortcut again focuses it). Esc closes the topmost
  thing and returns to writing.
- A dialog takes keyboard focus the moment it opens, so nothing typed lands in the script.
- Feedback after an action is a short toast naming the result ("Moved to the archive."), with
  Undo when possible.

## 8. The printed page

Export defaults are taken from a finished screenplay (DRUCK, 2026) and should stay that way
unless a writer changes them:

- Courier Prime 12 pt, line pitch **11.232 pt** (6.41 lines per inch): **63 lines** on A4,
  58 on Letter. Top margin **72 pt** to the top of the letters (first baseline at 80 pt).
- Action starts **12.5 characters (90 pt)** from the left edge and is **60** characters wide.
  Cue at +22.5, dialogue at +12.5 (36 wide), parentheticals at +17.5 (25 wide).
- Scene headings bold, two blank lines before and one after. Scene numbers on **both sides**,
  bold like the heading: left ending four characters before the text, right one character
  after the action column.
- Page numbers "2." top right, aligned to the end of the action column, halfway into the top
  margin; none on the first page.
- Dialogue breaks at any line with (MEHR)/(MORE) at the parenthetical indent; German scripts
  repeat the cue without (CONT'D). Centred text is centred on the paper.
- Title page: title centred with its baseline at 287 pt; credit ("von", "written by") five
  lines below, author a blank line below that, all centred. Notes, then two blank lines, then
  contact sit in the bottom-left corner; the date closes the bottom-right corner on the last
  contact line. Both corners keep the **same 70 pt** from the side and bottom edges. Details
  use 5 % letter spacing.

- Scene numbers count 1, 2, 3 … until they are **locked** (Scene ▸ Lock Scene Numbers). Locked
  numbers are written on the headings (#12#); new scenes take letters (12A), removed scenes
  stay as "12 OMITTED" / "ENTFÄLLT", and the scene pane shows a small lock.

## 9. Words

- Name things by what writers know: scene, speech, character, draft, version, shelf.
- Don't ask for names nobody needs. A passage is shown by its current text; a name is optional.
- Buttons say what happens: "Move to Archive", "Put back", "Export PDF…" (… when a dialog follows).
- Sentence case everywhere. No exclamation marks, no apologies in errors; say what happened and
  what to do.

## 10. Checklist for a new feature

1. Does it need a new place, or does it fit an existing pane, menu or view header?
2. Use the sizes from section 3 and the radius from section 6; no new values without adding
   them here.
3. Accent only for state; meaning colours only for their meaning.
4. Give it a command (Commands & shortcuts) and a visible place to click.
5. Check it at the minimum pane widths and in the light theme.
