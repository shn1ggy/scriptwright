// Live anchors for highlights, comments and alternative passages.
//
// Records live in the project information (never in the screenplay). While a project is
// open each attached record has a live anchor that follows edits; undo and redo restore
// anchors (and passage versions) exactly as they were.

import type { Editor } from './editor/editor';
import { Step, Pos } from '../shared/doc';
import {
  LiveAnchor,
  anchorProblem,
  anchorText,
  cloneAnchor,
  fullText,
  keyIndex,
  mapAnchorsThroughStep,
  overlaps,
  resolveStored,
  toStored,
} from '../shared/anchors';
import type { HistoryEntry } from './editor/history';
import { CommentRecord, HighlightColor, HighlightRecord, PassageRecord } from '../shared/types';
import { uid } from './ui/dom';
import { t } from '../shared/i18n';

export type AnnKind = 'highlight' | 'comment' | 'passage';
type AnyRecord = HighlightRecord | CommentRecord | PassageRecord;

interface Snapshot {
  anchors: Map<string, LiveAnchor>;
  detached: Map<string, string | undefined>;
  passages: string;
}

/** Where the records live and how changes are recorded: the screenplay, or one document. */
export interface AnnHost {
  readonly editor: Editor;
  /** The lists of records, or null when nothing is open. */
  store(): AnnStore | null;
  /** Runs a change to the records as one step of the editor's undo history. */
  undoable<T>(fn: () => T, label: string): T;
  markDirty(): void;
  /** The scene heading (or document heading) above a line, kept with comments and passages. */
  headingAt(line: number): string | undefined;
  /** The records or their places changed (the Review pane redraws). */
  changed(): void;
  /** Selects a range and shows it. */
  reveal(a: Pos, b: Pos): void;
  /** 'script' or 'document', for the wording of dialogs. */
  readonly scope: 'script' | 'document';
}

export interface AnnStore {
  highlights: HighlightRecord[];
  comments: CommentRecord[];
  passages: PassageRecord[];
}

export interface Deco {
  a: { key: number; ch: number };
  b: { key: number; ch: number };
  cls: string;
}

export class Annotations {
  live = new Map<string, LiveAnchor>();
  private before = new WeakMap<HistoryEntry, Snapshot>();
  private after = new WeakMap<HistoryEntry, Snapshot>();
  private current: Snapshot | null = null;
  showResolved = false;

  constructor(readonly host: AnnHost) {}

  get scope() {
    return this.host.scope;
  }

  get editor() {
    return this.host.editor;
  }

  /** The record lists (only valid while store() is not null). */
  get meta(): AnnStore {
    return this.host.store()!;
  }

  private get open() {
    return !!this.host.store();
  }

  /** Runs a change to the records as one undoable step. */
  undoable<T>(fn: () => T, label: string): T {
    return this.host.undoable(fn, label);
  }

  markDirty() {
    this.host.markDirty();
  }

  /** Shows a record's text in its editor. */
  reveal(id: string): boolean {
    const an = this.live.get(id);
    if (!an) return false;
    const idx = keyIndex(this.editor.lines);
    this.host.reveal({ line: idx.get(an.a.key)!, ch: an.a.ch }, { line: idx.get(an.b.key)!, ch: an.b.ch });
    return true;
  }

  records(): Array<{ kind: AnnKind; rec: AnyRecord }> {
    if (!this.open) return [];
    const m = this.meta;
    return [
      ...m.highlights.map((rec) => ({ kind: 'highlight' as const, rec })),
      ...m.comments.map((rec) => ({ kind: 'comment' as const, rec })),
      ...m.passages.map((rec) => ({ kind: 'passage' as const, rec })),
    ];
  }

  record(id: string): { kind: AnnKind; rec: AnyRecord } | undefined {
    return this.records().find((r) => r.rec.id === id);
  }

  /** Finds stored anchors in the text after opening or reloading. */
  load() {
    this.live.clear();
    if (!this.open) return;
    const lines = this.host.editor.lines;
    const full = fullText(lines);
    let changed = false;
    for (const { rec } of this.records()) {
      if (rec.detached) continue;
      const r = resolveStored(rec.anchor, lines, full);
      if (r.ok) this.live.set(rec.id, r.anchor);
      else {
        rec.detached = r.reason;
        changed = true;
      }
    }
    this.current = this.snapshot();
    if (changed) this.host.markDirty();
    this.refresh();
  }

  private snapshot(): Snapshot {
    const anchors = new Map<string, LiveAnchor>();
    for (const [id, an] of this.live) anchors.set(id, cloneAnchor(an));
    const detached = new Map<string, string | undefined>();
    for (const { rec } of this.records()) detached.set(rec.id, rec.detached);
    return { anchors, detached, passages: JSON.stringify(this.host.store()?.passages ?? []) };
  }

  private restore(s: Snapshot) {
    this.live.clear();
    for (const [id, an] of s.anchors) this.live.set(id, cloneAnchor(an));
    this.meta.passages = JSON.parse(s.passages);
    for (const { rec } of this.records()) if (s.detached.has(rec.id)) rec.detached = s.detached.get(rec.id);
  }

  /** Puts live anchors back after an undo of a change outside the text. */
  restoreLive(anchors: Map<string, LiveAnchor>) {
    this.live.clear();
    for (const [id, an] of anchors) this.live.set(id, cloneAnchor(an));
    this.current = this.snapshot();
    this.refresh();
  }

  /** Called for every editor change. */
  onChange(origin: string, steps: Step[]) {
    if (!this.open) return;
    const hist = this.host.editor.history;
    if (origin === 'undo') {
      const entry = hist.undone[hist.undone.length - 1];
      const snap = entry && this.before.get(entry);
      if (entry) this.after.set(entry, this.snapshot());
      if (snap) {
        this.restore(snap);
        this.finish();
        return;
      }
    } else if (origin === 'redo') {
      const entry = hist.done[hist.done.length - 1];
      const snap = entry && this.after.get(entry);
      if (snap) {
        this.restore(snap);
        this.finish();
        return;
      }
    } else if (origin !== 'load') {
      const entry = hist.done[hist.done.length - 1];
      if (entry && !this.before.has(entry) && this.current) this.before.set(entry, this.current);
    }
    if (!this.live.size) {
      this.current = this.snapshot();
      return;
    }
    const anchors = [...this.live.values()];
    for (const st of steps) mapAnchorsThroughStep(st, anchors);
    this.finish();
  }

  private finish() {
    const idx = keyIndex(this.host.editor.lines);
    for (const [id, an] of [...this.live]) {
      const problem = anchorProblem(an, idx);
      if (!problem) continue;
      const r = this.record(id);
      if (r) {
        // Keep the last known text so the record can be reviewed.
        r.rec.detached = problem;
      }
      this.live.delete(id);
    }
    this.current = this.snapshot();
    this.host.markDirty();
    this.refresh();
  }

  /** Writes live anchors into the records (before saving project information). */
  syncToMeta() {
    if (!this.open || !this.live.size) return;
    const lines = this.host.editor.lines;
    const idx = keyIndex(lines);
    const full = fullText(lines);
    for (const { rec } of this.records()) {
      const an = this.live.get(rec.id);
      if (!an) continue;
      const st = toStored(an, lines, idx, full);
      if (st) rec.anchor = st;
    }
  }

  textOf(id: string): string {
    const an = this.live.get(id);
    if (an) return anchorText(an, this.host.editor.lines, keyIndex(this.host.editor.lines));
    return this.record(id)?.rec.anchor.quote ?? '';
  }

  /** Editor selection as a live anchor (null when empty). */
  selectionAnchor(): LiveAnchor | null {
    const ed = this.host.editor;
    const s = ed.sel;
    const a = s.anchor.line < s.head.line || (s.anchor.line === s.head.line && s.anchor.ch <= s.head.ch) ? s.anchor : s.head;
    const b = a === s.anchor ? s.head : s.anchor;
    if (a.line === b.line && a.ch === b.ch) return null;
    return { a: { key: ed.lines[a.line].key, ch: a.ch }, b: { key: ed.lines[b.line].key, ch: b.ch } };
  }

  /** Records whose anchor contains the position. */
  at(pos: Pos): Array<{ kind: AnnKind; rec: AnyRecord }> {
    const ed = this.host.editor;
    const idx = keyIndex(ed.lines);
    const out: Array<{ kind: AnnKind; rec: AnyRecord }> = [];
    for (const r of this.records()) {
      const an = this.live.get(r.rec.id);
      if (!an) continue;
      const a = idx.get(an.a.key)!;
      const b = idx.get(an.b.key)!;
      const after = pos.line > a || (pos.line === a && pos.ch >= an.a.ch);
      const before = pos.line < b || (pos.line === b && pos.ch <= an.b.ch);
      if (after && before) out.push(r);
    }
    return out;
  }

  overlapping(an: LiveAnchor, kind?: AnnKind) {
    const idx = keyIndex(this.host.editor.lines);
    return this.records().filter((r) => (!kind || r.kind === kind) && this.live.has(r.rec.id) && overlaps(this.live.get(r.rec.id)!, an, idx));
  }

  // ---------------------------------------------------------------------------------
  // Mutations

  private storedFor(an: LiveAnchor) {
    const lines = this.host.editor.lines;
    return toStored(an, lines, keyIndex(lines))!;
  }

  private sceneHeadingAt(an: LiveAnchor): string | undefined {
    const i = keyIndex(this.host.editor.lines).get(an.a.key);
    return i === undefined ? undefined : this.host.headingAt(i);
  }

  /** Highlights the selection; overlapping highlights are trimmed or replaced. */
  highlight(color: HighlightColor | null): boolean {
    const an = this.selectionAnchor();
    if (!an) return false;
    return this.host.undoable(() => this.highlightAt(an, color), color ? t("Highlight") : t("Remove Highlight"));
  }

  private highlightAt(an: LiveAnchor, color: HighlightColor | null): boolean {
    // Remove highlights that overlap the selection, then add the new one.
    const removed = this.overlapping(an, 'highlight');
    for (const r of removed) this.removeRecord(r.rec.id, false);
    if (color) {
      const rec: HighlightRecord = { id: uid(), color, anchor: this.storedFor(an), created: new Date().toISOString() };
      this.meta.highlights.push(rec);
      this.live.set(rec.id, cloneAnchor(an));
    }
    this.current = this.snapshot();
    this.host.markDirty();
    this.refresh();
    return true;
  }

  addComment(text: string, an: LiveAnchor): CommentRecord {
    return this.host.undoable(() => this.addCommentNow(text, an), t("Comment"));
  }

  private addCommentNow(text: string, an: LiveAnchor): CommentRecord {
    const rec: CommentRecord = { id: uid(), text, created: new Date().toISOString(), resolved: false, replies: [], anchor: this.storedFor(an), sceneHeading: this.sceneHeadingAt(an) };
    this.meta.comments.push(rec);
    this.live.set(rec.id, cloneAnchor(an));
    this.current = this.snapshot();
    this.host.markDirty();
    this.refresh();
    return rec;
  }

  addPassage(an: LiveAnchor, name: string): PassageRecord {
    return this.host.undoable(() => this.addPassageNow(an, name), t("Alternative Passage"));
  }

  private addPassageNow(an: LiveAnchor, name: string): PassageRecord {
    const text = anchorText(an, this.host.editor.lines, keyIndex(this.host.editor.lines));
    const first = { id: uid(), name: t('Original'), text, created: new Date().toISOString() };
    const rec: PassageRecord = { id: uid(), name, anchor: this.storedFor(an), activeId: first.id, alternatives: [first], sceneHeading: this.sceneHeadingAt(an) };
    this.meta.passages.push(rec);
    this.live.set(rec.id, cloneAnchor(an));
    this.current = this.snapshot();
    this.host.markDirty();
    this.refresh();
    return rec;
  }

  /** Re-attaches a detached record to the current selection. */
  reattach(id: string): boolean {
    const an = this.selectionAnchor();
    const r = this.record(id);
    if (!an || !r) return false;
    return this.host.undoable(() => this.reattachNow(id, an, r), t("Attach"));
  }

  private reattachNow(id: string, an: LiveAnchor, r: { rec: AnyRecord }): boolean {
    r.rec.detached = undefined;
    r.rec.anchor = this.storedFor(an);
    this.live.set(id, cloneAnchor(an));
    this.current = this.snapshot();
    this.host.markDirty();
    this.refresh();
    return true;
  }

  removeRecord(id: string, refresh = true) {
    if (refresh) this.host.undoable(() => this.removeNow(id, true), t("Delete"));
    else this.removeNow(id, false);
  }

  private removeNow(id: string, refresh: boolean) {
    const m = this.meta;
    m.highlights = m.highlights.filter((x) => x.id !== id);
    m.comments = m.comments.filter((x) => x.id !== id);
    m.passages = m.passages.filter((x) => x.id !== id);
    this.live.delete(id);
    if (refresh) {
      this.current = this.snapshot();
      this.host.markDirty();
      this.refresh();
    }
  }

  /** Restores a removed record (used by "Undo" in toasts). */
  restoreRecord(kind: AnnKind, rec: AnyRecord, an: LiveAnchor | null) {
    this.host.undoable(() => this.restoreNow(kind, rec, an), t("Restore"));
  }

  private restoreNow(kind: AnnKind, rec: AnyRecord, an: LiveAnchor | null) {
    if (this.record(rec.id)) return;
    const list = kind === 'highlight' ? this.meta.highlights : kind === 'comment' ? this.meta.comments : this.meta.passages;
    (list as AnyRecord[]).push(rec);
    if (an) this.live.set(rec.id, cloneAnchor(an));
    this.current = this.snapshot();
    this.host.markDirty();
    this.refresh();
  }

  /**
   * Replaces the passage's active text with another alternative (one undoable edit).
   * The outgoing text is stored in its alternative first, so nothing is lost.
   */
  activate(passageId: string, altId: string): boolean {
    const p = this.meta.passages.find((x) => x.id === passageId);
    const an = this.live.get(passageId);
    if (!p || !an || p.detached) return false;
    const alt = p.alternatives.find((a) => a.id === altId);
    if (!alt || alt.id === p.activeId || !alt.text) return false;
    const ed = this.host.editor;
    const idx = keyIndex(ed.lines);
    const outgoing = p.alternatives.find((a) => a.id === p.activeId);
    if (outgoing) outgoing.text = anchorText(an, ed.lines, idx);
    const from = { line: idx.get(an.a.key)!, ch: an.a.ch };
    const to = { line: idx.get(an.b.key)!, ch: an.b.ch };
    // Snapshot with the outgoing text saved but the old active id, for undo.
    this.current = this.snapshot();
    const lines = alt.text.split('\n');
    const endPos = { line: from.line + lines.length - 1, ch: lines.length === 1 ? from.ch + lines[0].length : lines[lines.length - 1].length };
    p.activeId = alt.id;
    ed.edit((tx) => {
      tx.replace(from, to, alt.text);
      return { anchor: from, head: endPos };
    });
    // The anchor now spans exactly the new text.
    const L = ed.lines;
    this.live.set(passageId, { a: { key: L[from.line].key, ch: from.ch }, b: { key: L[endPos.line].key, ch: endPos.ch } });
    p.detached = undefined;
    this.current = this.snapshot();
    // Record the state after the switch for redo.
    const entry = ed.history.done[ed.history.done.length - 1];
    if (entry) this.after.set(entry, this.current);
    this.host.markDirty();
    this.refresh();
    return true;
  }

  // ---------------------------------------------------------------------------------

  refresh() {
    const decos: Deco[] = [];
    for (const { kind, rec } of this.records()) {
      const an = this.live.get(rec.id);
      if (!an) continue;
      if (kind === 'highlight') decos.push({ a: an.a, b: an.b, cls: `deco-hl-${(rec as HighlightRecord).color}` });
      else if (kind === 'comment') {
        const c = rec as CommentRecord;
        if (!c.resolved || this.showResolved) decos.push({ a: an.a, b: an.b, cls: c.resolved ? 'deco-comment resolved' : 'deco-comment' });
      } else decos.push({ a: an.a, b: an.b, cls: 'deco-passage' });
    }
    this.host.editor.setDecorations(decos);
    this.host.changed();
  }
}
