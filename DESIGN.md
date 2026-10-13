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
┌ title bar 38 ─ ● ● ●  ▣  Project  file.fountain ················ 🔍 ⤓ ⌘ ⚙ ▣ ┐
├ tab bar 36 ── Script  Scene  Cards  Dialogue  Characters  Source ─────────┤
│ scene pane 280 │ view header 40 (Scene/Dialogue only)          │ notes 320 │
│ Projects  + …  │                                               │ tabs 40   │
│  project       │            the page (Courier, centred)        │           │
│ Scenes  + …    │                                               │           │
│  search        │                                               │           │
│  1 INT. …      │                                               │           │
│ ─────────────  │                                               │           │
│ workspace ⌄  ⚙ │                                               │           │
├ status bar 26 ─────────────────────────────────────────────────────────────┤
```

- The **tab bar holds only tabs.** Options of a view live in that view's own header row.
- **Scene pane:** minimum 220 px, default 280 px. **Notes pane:** minimum 310 px, default 320 px.
- Full-window overlays (Export) start after the macOS window buttons and drag the window.
- Text in the interface is not selectable; text a person writes is.

## 3. Spacing and sizes

Everything sits on a **4 px grid**. Spacing steps: **4 · 8 · 12 · 16 · 20 · 24 · 32**.

| Element | Height | Inner padding |
| --- | --- | --- |
| Title bar | 38 | 10 sides (80 left of the macOS buttons) |
| Tab bar | 36 | tabs 14 |
| View header (Scene, Dialogue) | 40 | 14 |
| Section heading in a pane (Projects, Scenes) | 36 | 14 left |
| List row (projects, scenes, results) | 28 | 14 sides, 10 gap |
| Control: button, field, select | 30 | 10 sides |
| Small control (inside lists, cards, toolbars) | 24 | 8 sides |
| Icon button | 30 (26 in headings) | icon 16 |
| Menu item | 28 | 10 sides; menu padding 6 |
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

## 7. Behaviour

- Every change to the screenplay is undoable; destructive actions on files ask first and say
  where things go (Trash, Archive).
- Switching views never moves the caret on screen.
- One instance of each window (pressing a shortcut again focuses it). Esc closes the topmost
  thing and returns to writing.
- Feedback after an action is a short toast naming the result ("Moved to the archive."), with
  Undo when possible.

## 8. Words

- Name things by what writers know: scene, speech, character, draft, version, shelf.
- Buttons say what happens: "Move to Archive", "Put back", "Export PDF…" (… when a dialog follows).
- Sentence case everywhere. No exclamation marks, no apologies in errors; say what happened and
  what to do.

## 9. Checklist for a new feature

1. Does it need a new place, or does it fit an existing pane, menu or view header?
2. Use the sizes from section 3 and the radius from section 6; no new values without adding
   them here.
3. Accent only for state; meaning colours only for their meaning.
4. Give it a command (Commands & shortcuts) and a visible place to click.
5. Check it at the minimum pane widths and in the light theme.
