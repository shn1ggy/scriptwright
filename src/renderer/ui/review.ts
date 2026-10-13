// Review tab: comments, alternative passages, highlights and detached annotations.

import type { App } from '../app';
import { h } from './dom';
import { confirmDialog, openDialog, toast } from './overlay';
import { CommentRecord, HighlightRecord, PassageRecord } from '../../shared/types';
import { uid } from './dom';
import { openRewriteFor } from './rewrite';


function quote(text: string, max = 90): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function when(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function renderReview(app: App, body: HTMLElement, rerender: () => void) {
  const ann = app.annotations;
  const m = app.project!.meta;

  // Comments ---------------------------------------------------------------------------
  const open = m.comments.filter((c) => !c.detached && !c.resolved);
  const resolved = m.comments.filter((c) => !c.detached && c.resolved);
  // Open and resolved comments are two views of the list. Resolving a comment keeps it
  // (with its replies) but takes it out of the way; the Resolved view shows them again.
  const seg = (label: string, on: boolean, run: () => void) => h('button', { class: `seg-btn${on ? ' on' : ''}`, 'aria-pressed': String(on), onclick: run }, label);
  const switcher = h(
    'span',
    { class: 'seg', role: 'group', 'aria-label': 'Show comments' },
    seg(`Open ${open.length}`, !ann.showResolved, () => {
      ann.showResolved = false;
      ann.refresh();
      rerender();
    }),
    seg(`Resolved ${resolved.length}`, ann.showResolved, () => {
      ann.showResolved = true;
      ann.refresh();
      rerender();
    }),
  );
  const secComments = h('div', { class: 'rv-section' });
  body.append(secComments);
  secComments.append(
    h(
      'div',
      { class: 'rv-head' },
      h('span', { class: 'rv-swatch comment' }),
      h('span', null, 'Comments'),
      h('span', { class: 'spacer' }),
      switcher,
    ),
  );
  const comments = ann.showResolved ? resolved : open;
  if (!comments.length)
    secComments.append(
      h(
        'div',
        { class: 'notice' },
        ann.showResolved
          ? 'No resolved comments. Resolving a comment keeps it here, out of the way of the open ones.'
          : `Select text and choose Comment (${app.commands.label('edit.comment') || 'context menu'}) to add one.`,
      ),
    );
  for (const c of comments) secComments.append(commentCard(app, c, rerender));

  // Alternatives -----------------------------------------------------------------------
  const passages = m.passages.filter((p) => !p.detached);
  const secPassages = h('div', { class: 'rv-section' });
  body.append(secPassages);
  secPassages.append(h('div', { class: 'rv-head' }, h('span', { class: 'rv-swatch passage' }), h('span', null, `Alternative passages (${passages.length})`)));
  if (!passages.length) secPassages.append(h('div', { class: 'notice' }, `Select a passage and choose Rewrite… (${app.commands.label('edit.rewrite') || 'context menu'}) to keep several versions.`));
  for (const p of passages) {
    const active = p.alternatives.find((a) => a.id === p.activeId);
    secPassages.append(
      h(
        'div',
        { class: 'rv-item rv-passage' },
        h('button', { class: 'rv-quote', onclick: () => app.revealAnnotation(p.id) }, p.name),
        h('div', { class: 'rv-meta' }, `${p.alternatives.length} version${p.alternatives.length === 1 ? '' : 's'} · using “${active?.name ?? '?'}”${p.sceneHeading ? ' · ' + p.sceneHeading : ''}`),
        h('div', { class: 'rv-actions' }, h('button', { class: 'btn sm', onclick: () => openRewriteFor(app, p.id) }, 'Open…')),
      ),
    );
  }

  // Highlights ---------------------------------------------------------------------------
  const hls = m.highlights.filter((x) => !x.detached);
  const secHl = h('div', { class: 'rv-section' });
  body.append(secHl);
  secHl.append(h('div', { class: 'rv-head' }, h('span', null, `Highlights (${hls.length})`)));
  for (const hl of hls) {
    secHl.append(
      h(
        'div',
        { class: 'rv-item rv-row' },
        h('span', { class: `rv-dot dot-${hl.color}`, title: app.settings.highlights[hl.color]?.label }),
        h('button', { class: 'rv-quote', onclick: () => app.revealAnnotation(hl.id) }, quote(ann.textOf(hl.id), 60)),
        h('button', {
          class: 'icon-btn',
          title: 'Remove highlight',
          onclick: () => {
            const an = ann.live.get(hl.id) ?? null;
            ann.removeRecord(hl.id);
            toast('Highlight removed.', { actions: [{ label: 'Undo', run: () => ann.restoreRecord('highlight', hl, an) }] });
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
    secDet.append(h('div', { class: 'rv-head warn' }, h('span', null, `Detached (${detached.length})`)));
    secDet.append(h('div', { class: 'notice' }, 'The text these belonged to was deleted or changed. Select the right text and attach them again, or delete them.'));
    for (const { kind, rec } of detached) {
      const label = kind === 'comment' ? `Comment: ${quote((rec as CommentRecord).text, 50)}` : kind === 'passage' ? `Passage: ${(rec as PassageRecord).name}` : `Highlight: ${app.settings.highlights[(rec as HighlightRecord).color]?.label ?? ''}`;
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
                if (!ann.reattach(rec.id)) toast('Select the text to attach it to first.');
                else rerender();
              },
            }, 'Attach to selection'),
            kind === 'passage' ? h('button', { class: 'btn sm', onclick: () => openRewriteFor(app, rec.id) }, 'Versions…') : null,
            h('button', {
              class: 'btn sm',
              onclick: async () => {
                if (!(await confirmDialog('Delete', 'Delete this detached item permanently? Its text versions and comments are removed.', 'Delete', { danger: true }))) return;
                ann.removeRecord(rec.id);
              },
            }, 'Delete'),
          ),
        ),
      );
    }
  }
}

function commentCard(app: App, c: CommentRecord, rerender: () => void): HTMLElement {
  const ann = app.annotations;
  const text = h('div', { class: 'rv-text', title: 'Click to edit' }, c.text);
  text.addEventListener('click', () => {
    const ta = h('textarea', { class: 'field', rows: 3 });
    ta.value = c.text;
    text.replaceWith(ta);
    ta.focus();
    const done = () => {
      c.text = ta.value.trim() || c.text;
      app.markMetaDirty();
      rerender();
    };
    ta.addEventListener('blur', done);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) ta.blur();
      if (e.key === 'Escape') {
        e.stopPropagation();
        ta.value = c.text;
        ta.blur();
      }
    });
  });
  const reply = h('input', { class: 'field', placeholder: 'Reply', 'aria-label': 'Reply' });
  reply.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && reply.value.trim()) {
      c.replies.push({ id: uid(), text: reply.value.trim(), created: new Date().toISOString() });
      app.markMetaDirty();
      rerender();
    }
  });
  return h(
    'div',
    { class: `rv-item rv-comment${c.resolved ? ' resolved' : ''}` },
    h('button', { class: 'rv-quote', title: 'Go to the commented text', onclick: () => app.revealAnnotation(c.id) }, `“${quote(ann.textOf(c.id))}”`),
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
          c.resolved = !c.resolved;
          app.markMetaDirty();
          ann.refresh();
          rerender();
          if (c.resolved)
            toast('Comment resolved. It is kept under Resolved.', {
              actions: [{ label: 'Show resolved', run: () => {
                ann.showResolved = true;
                ann.refresh();
                rerender();
              } }],
            });
        },
      }, c.resolved ? 'Reopen' : 'Resolve'),
      h('button', {
        class: 'btn sm',
        onclick: () => {
          deleteComment(app, c.id);
          rerender();
        },
      }, 'Delete'),
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
  toast('Comment deleted.', { actions: [{ label: 'Undo', run: () => ann.restoreRecord('comment', c, an) }] });
}

/** A comment on its own: edit the text, read and add replies, resolve or delete. */
export function openCommentDialog(app: App, id: string) {
  const ann = app.annotations;
  const c = app.project?.meta.comments.find((x) => x.id === id);
  if (!c) return;
  const ta = h('textarea', { class: 'field', rows: 4, 'aria-label': 'Comment' });
  ta.value = c.text;
  const reply = h('input', { class: 'field', placeholder: 'Add a reply', 'aria-label': 'Reply' });
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
  const d = openDialog({
    title: c.resolved ? 'Comment (resolved)' : 'Comment',
    cls: 'comment-dialog',
    body: [
      h('div', { class: 'notice' }, `“${quote(ann.textOf(c.id), 140)}”`),
      h('div', { class: 'rv-meta' }, when(c.created), c.sceneHeading ? ` · ${c.sceneHeading}` : ''),
      ta,
      replies,
      reply,
    ],
    buttons: [
      { label: 'Delete', danger: true, run: () => deleteComment(app, c.id) },
      {
        label: c.resolved ? 'Reopen' : 'Resolve',
        run: () => {
          save();
          c.resolved = !c.resolved;
          app.markMetaDirty();
          ann.refresh();
          app.rightPane.annotationsChanged();
        },
      },
      { label: 'Save', primary: true, run: () => save() },
    ],
    initialFocus: ta,
    onClose: () => app.editor.focus(),
  });
  const submitOnModEnter = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      save();
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
