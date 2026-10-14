import { Selection, Step } from '../../shared/doc';

export type EditKind = 'type' | 'delete' | 'enter' | 'other';

export interface HistoryEntry {
  steps: Step[];
  selBefore: Selection;
  selAfter: Selection;
  kind: EditKind;
  time: number;
  /** Extra data restored on undo/redo (e.g. scene filter changes). */
  label?: string;
  /** A change outside the text (comments, highlights, shelf …) undone and redone by callbacks. */
  custom?: { undo(): void; redo(): void };
}

const GROUP_MS = 1200;

export class History {
  done: HistoryEntry[] = [];
  undone: HistoryEntry[] = [];
  limit = 2000;
  private sealed = false;

  push(e: HistoryEntry) {
    const last = this.done[this.done.length - 1];
    if (
      !this.sealed &&
      last &&
      e.kind !== 'other' &&
      last.kind === e.kind &&
      e.time - last.time < GROUP_MS &&
      sameSel(last.selAfter, e.selBefore)
    ) {
      last.steps.push(...e.steps);
      last.selAfter = e.selAfter;
      last.time = e.time;
    } else {
      this.done.push(e);
      if (this.done.length > this.limit) this.done.shift();
    }
    this.undone = [];
    this.sealed = false;
  }

  /**
   * Joins the last entry (a change around the text, from app.undoable) to the text change
   * before it, so one undo reverts both.
   */
  joinLast() {
    const n = this.done.length;
    if (n < 2) return;
    const meta = this.done[n - 1];
    const text = this.done[n - 2];
    if (!meta.custom || meta.steps.length || text.custom || !text.steps.length) return;
    text.custom = meta.custom;
    text.label = meta.label ?? text.label;
    this.done.pop();
    this.sealed = true;
  }

  /** Prevents the next edit from merging into the previous one. */
  seal() {
    this.sealed = true;
  }

  clear() {
    this.done = [];
    this.undone = [];
  }
}

function sameSel(a: Selection, b: Selection) {
  return a.anchor.line === b.anchor.line && a.anchor.ch === b.anchor.ch && a.head.line === b.head.line && a.head.ch === b.head.ch;
}
