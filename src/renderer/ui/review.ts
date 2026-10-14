// Review tab: comments, alternative passages, highlights and detached annotations.

import type { App } from '../app';
import { h, icon } from './dom';
import { confirmDialog, openDialog, toast } from './overlay';
import { TagRecord, CommentRecord, HighlightRecord, PassageRecord } from '../../shared/types';
import { uid } from './dom';
import { namePassage, openRewriteFor, passageLabel, passageName, passageText } from './rewrite';
import { t, tn, uiLocale } from '../../shared/i18n';


function quote(text: string, max = 90): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function when(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(uiLocale(), { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString(uiLocale(), { hour: '2-digit', minute: '2-digit' });
}

export function renderReview(app: App, body: HTMLElement, rerender: () => void) {
  const ann = app.annotations;
  const m = app.project!.meta;

  // Each group folds open and closed; the choice is remembered.
  type RK = 'comments' | 'passages' | 'highlights';
  const folded = () => new Set<string>(app.state.layout.reviewFolded ?? []);
  const fold = (k: RK, sec: HTMLElement, ...title: Array<Node | string>) => {
    const isOpen = !folded().has(k);
    // Like the export groups: the whole heading is the button, the chevron sits at its end.
    const btn = h('button', { class: 'rv-fold', 'aria-expanded': String(isOpen), 'data-k': k }, ...title, h('span', { class: 'collapse-mark' }, icon(isOpen ? 'chevronDown' : 'chevronRight')));
    sec.classList.toggle('folded', !isOpen);
    btn.addEventListener('click', () => {
      const f = folded();
      const opening = f.has(k);
      if (opening) f.delete(k);
      else f.add(k);
      app.state.layout.reviewFolded = [...f];
      app.saveStateSoon();
      sec.classList.toggle('folded', !opening);
      btn.setAttribute('aria-expanded', String(opening));
      btn.querySelector('.collapse-mark')!.replaceChildren(icon(opening ? 'chevronDown' : 'chevronRight'));
    });
    return btn;
  };

  // Comments ---------------------------------------------------------------------------
  const open = m.comments.filter((c) => !c.detached && !c.resolved);
  const resolved = m.comments.filter((c) => !c.detached && c.resolved);
  // Open and resolved comments are two views of the list. Resolving a comment keeps it
  // (with its replies) but takes it out of the way; the Resolved view shows them again.
  const seg = (label: string, on: boolean, run: () => void) => h('button', { class: `seg-btn${on ? ' on' : ''}`, 'aria-pressed': String(on), onclick: run }, label);
  const switcher = h(
    'span',
    { class: 'seg', role: 'group', 'aria-label': t("Show comments") },
    seg(t("Open {0}", open.length), !ann.showResolved, () => {
      ann.showResolved = false;
      ann.refresh();
      rerender();
    }),
    seg(t("Resolved {0}", resolved.length), ann.showResolved, () => {
      ann.showResolved = true;
      ann.refresh();
      rerender();
    }),
  );
  const secComments = h('div', { class: 'rv-section' });
  body.append(secComments);
  secComments.append(h('div', { class: 'rv-head' }, fold('comments', secComments, h('span', { class: 'rv-swatch comment' }), h('span', null, t("Comments ({0})", open.length)))), switcher);
  const comments = ann.showResolved ? resolved : open;
  if (!comments.length)
    secComments.append(
      h(
        'div',
        { class: 'notice' },
        ann.showResolved
          ? t("No resolved comments. Resolving a comment keeps it here, out of the way of the open ones.")
          : t("Select text and choose Comment ({0}) to add one.", app.commands.label('edit.comment') || t('context menu')),
      ),
    );
  for (const c of comments) secComments.append(commentCard(app, c, rerender));

  // Alternatives -----------------------------------------------------------------------
  const passages = m.passages.filter((p) => !p.detached);
  const secPassages = h('div', { class: 'rv-section' });
  body.append(secPassages);
  secPassages.append(h('div', { class: 'rv-head' }, fold('passages', secPassages, h('span', { class: 'rv-swatch passage' }), h('span', null, t("Alternative passages ({0})", passages.length)))));
  if (!passages.length) secPassages.append(h('div', { class: 'notice' }, t("Select a passage and choose Rewrite… ({0}) to keep several versions.", app.commands.label('edit.rewrite') || t('context menu'))));
  for (const p of passages) {
    const active = p.alternatives.find((a) => a.id === p.activeId);
    secPassages.append(
      h(
        'div',
        { class: 'rv-item rv-passage' },
        // The label is the text in the screenplay now; a name, when given, stands above it.
        passageName(p) ? h('div', { class: 'rv-label' }, passageName(p)) : null,
        h('button', { class: 'rv-quote', title: t("Go to the passage"), onclick: () => app.revealAnnotation(p.id) }, `“${passageText(app, p)}”`),
        h('div', { class: 'rv-meta' }, [tn(p.alternatives.length, '{0} version', '{0} versions'), t('using “{0}”', active?.name ?? '?'), p.sceneHeading].filter(Boolean).join(' · ')),
        h(
          'div',
          { class: 'rv-actions' },
          h('button', { class: 'btn sm', onclick: () => openRewriteFor(app, p.id) }, t("Open…")),
          h('button', { class: 'btn sm', onclick: () => void namePassage(app, p.id) }, passageName(p) ? t("Rename…") : t("Name…")),
        ),
      ),
    );
  }

  // Highlights ---------------------------------------------------------------------------
  const hls = m.highlights.filter((x) => !x.detached);
  const secHl = h('div', { class: 'rv-section' });
  body.append(secHl);
  secHl.append(h('div', { class: 'rv-head' }, fold('highlights', secHl, h('span', null, t("Highlights ({0})", hls.length)))));
  for (const hl of hls) {
    secHl.append(
      h(
        'div',
        { class: 'rv-item rv-row' },
        h('span', { class: `rv-dot dot-${hl.color}`, title: app.settings.highlights[hl.color]?.label }),
        h('button', { class: 'rv-quote', onclick: () => app.revealAnnotation(hl.id) }, quote(ann.textOf(hl.id), 60)),
        h('button', {
          class: 'icon-btn',
          title: t("Remove highlight"),
          onclick: () => {
            const an = ann.live.get(hl.id) ?? null;
            ann.removeRecord(hl.id);
            toast(t("Highlight removed."), { actions: [{ label: t("Undo"), run: () => ann.restoreRecord('highlight', hl, an) }] });
          },
        }, '×'),
      ),
    );
  }

  // Detached ----------------------------------------------------------------------------
  const detached = ann.records().filter((r) => r.rec.detached);
  if (detached.length) {
    const secDet = h('div', { class: 'rv-section' });
    body.append(secDet);
    secDet.append(h('div', { class: 'rv-head warn' }, h('span', null, t("Detached ({0})", detached.length))));
    secDet.append(h('div', { class: 'notice' }, t("The text these belonged to was deleted or changed. Select the right text and attach them again, or delete them.")));
    for (const { kind, rec } of detached) {
      const label =
        kind === 'comment'
          ? `Comment: ${quote((rec as CommentRecord).text, 50)}`
          : kind === 'passage'
            ? `Passage: ${passageLabel(app, rec as PassageRecord)}`
            : kind === 'tag'
              ? `${t('Breakdown')}: ${(rec as TagRecord).name}`
              : `Highlight: ${app.settings.highlights[(rec as HighlightRecord).color]?.label ?? ''}`;
      secDet.append(
        h(
          'div',
          { class: 'rv-item' },
          h('div', { class: 'rv-label' }, label),
          h('div', { class: 'rv-meta' }, `“${quote(rec.anchor.quote, 70)}” · ${rec.detached}`),
          h(
            'div',
            { class: 'rv-actions' },
            h('button', {
              class: 'btn sm',
              onclick: () => {
                if (!ann.reattach(rec.id)) toast(t("Select the text to attach it to first."));
                else rerender();
              },
            }, t("Attach to selection")),
            kind === 'passage' ? h('button', { class: 'btn sm', onclick: () => openRewriteFor(app, rec.id) }, t("Versions…")) : null,
            h('button', {
              class: 'btn sm',
              onclick: async () => {
                if (!(await confirmDialog(t("Delete"), t("Delete this detached item permanently? Its text versions and comments are removed."), t("Delete"), { danger: true }))) return;
                ann.removeRecord(rec.id);
              },
            }, t("Delete")),
          ),
        ),
      );
    }
  }
}

function commentCard(app: App, c: CommentRecord, rerender: () => void): HTMLElement {
  const ann = app.annotations;
  const text = h('div', { class: 'rv-text', title: t("Click to edit") }, c.text);
  text.addEventListener('click', () => {
    const ta = h('textarea', { class: 'field', rows: 3 });
    ta.value = c.text;
    text.replaceWith(ta);
    ta.focus();
    const done = () => {
      const v = ta.value.trim();
      if (v && v !== c.text)
        app.undoable(() => {
          c.text = v;
          app.markMetaDirty();
        }, t("Edit Comment"));
      rerender();
    };
    ta.addEventListener('blur', done);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        ta.blur();
      }
      if (e.key === 'Escape') {
        e.stopPropagation();
        ta.value = c.text;
        ta.blur();
      }
    });
  });
  const reply = h('input', { class: 'field', placeholder: t("Reply"), 'aria-label': t("Reply") });
  reply.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && reply.value.trim()) {
      const text = reply.value.trim();
      app.undoable(() => {
        c.replies.push({ id: uid(), text, created: new Date().toISOString() });
        app.markMetaDirty();
      }, t("Reply"));
      rerender();
    }
  });
  return h(
    'div',
    { class: `rv-item rv-comment${c.resolved ? ' resolved' : ''}` },
    h('button', { class: 'rv-quote', title: t("Go to the commented text"), onclick: () => app.revealAnnotation(c.id) }, `“${quote(ann.textOf(c.id))}”`),
    text,
    ...c.replies.map((r) => h('div', { class: 'rv-reply' }, h('span', { class: 'rv-meta' }, when(r.created)), ' ', r.text)),
    h('div', { class: 'rv-meta' }, when(c.created), c.sceneHeading ? ` · ${c.sceneHeading}` : ''),
    reply,
    h(
      'div',
      { class: 'rv-actions' },
      h('button', {
        class: 'btn sm',
        onclick: () => {
          app.undoable(() => {
            c.resolved = !c.resolved;
            app.markMetaDirty();
          }, c.resolved ? t("Reopen Comment") : t("Resolve Comment"));
          ann.refresh();
          rerender();
          if (c.resolved)
            toast(t("Comment resolved. It is kept under Resolved."), {
              actions: [{ label: t("Show resolved"), run: () => {
                ann.showResolved = true;
                ann.refresh();
                rerender();
              } }],
            });
        },
      }, c.resolved ? t("Reopen") : t("Resolve")),
      h('button', {
        class: 'btn sm',
        onclick: () => {
          deleteComment(app, c.id);
          rerender();
        },
      }, t("Delete")),
    ),
  );
}

/** Deletes a comment, with Undo in the notice. */
export function deleteComment(app: App, id: string) {
  const ann = app.annotations;
  const c = app.project?.meta.comments.find((x) => x.id === id);
  if (!c) return;
  const an = ann.live.get(c.id) ?? null;
  ann.removeRecord(c.id);
  toast(t("Comment deleted."), { actions: [{ label: t("Undo"), run: () => ann.restoreRecord('comment', c, an) }] });
}

/** A comment on its own: edit the text, read and add replies, resolve or delete. */
export function openCommentDialog(app: App, id: string) {
  const ann = app.annotations;
  const c = app.project?.meta.comments.find((x) => x.id === id);
  if (!c) return;
  const ta = h('textarea', { class: 'field', rows: 4, 'aria-label': t("Comment") });
  ta.value = c.text;
  const reply = h('input', { class: 'field', placeholder: t("Add a reply"), 'aria-label': t("Reply") });
  const replies = h('div', { class: 'cm-replies' });
  const renderReplies = () => {
    replies.textContent = '';
    for (const r of c.replies) replies.append(h('div', { class: 'rv-reply' }, h('span', { class: 'rv-meta' }, when(r.created)), ' ', r.text));
  };
  renderReplies();
  const save = () => {
    const t = ta.value.trim();
    let changed = false;
    if (t && t !== c.text) {
      c.text = t;
      changed = true;
    }
    if (reply.value.trim()) {
      c.replies.push({ id: uid(), text: reply.value.trim(), created: new Date().toISOString() });
      changed = true;
    }
    if (changed) {
      app.markMetaDirty();
      app.rightPane.annotationsChanged();
    }
  };
  const saveUndoable = () => app.undoable(save, t("Edit Comment"));
  const d = openDialog({
    title: c.resolved ? t("Comment (resolved)") : t("Comment"),
    cls: 'comment-dialog',
    body: [
      h('div', { class: 'notice' }, `“${quote(ann.textOf(c.id), 140)}”`),
      h('div', { class: 'rv-meta' }, when(c.created), c.sceneHeading ? ` · ${c.sceneHeading}` : ''),
      ta,
      replies,
      reply,
    ],
    buttons: [
      { label: t("Delete"), danger: true, run: () => deleteComment(app, c.id) },
      {
        label: c.resolved ? t("Reopen") : t("Resolve"),
        run: () => {
          app.undoable(() => {
            save();
            c.resolved = !c.resolved;
            app.markMetaDirty();
          }, t("Resolve Comment"));
          ann.refresh();
          app.rightPane.annotationsChanged();
        },
      },
      { label: t("Save"), primary: true, run: () => saveUndoable() },
    ],
    initialFocus: ta,
    onClose: () => app.editor.focus(),
  });
  const submitOnModEnter = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      saveUndoable();
      d.close();
    }
  };
  ta.addEventListener('keydown', submitOnModEnter);
  reply.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !(e.metaKey || e.ctrlKey) && reply.value.trim()) {
      e.preventDefault();
      save();
      reply.value = '';
      renderReplies();
    } else submitOnModEnter(e);
  });
}
