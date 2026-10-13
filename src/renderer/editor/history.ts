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
