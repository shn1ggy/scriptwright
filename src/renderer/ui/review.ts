// Review tab: comments, alternative passages, highlights and detached annotations.

import type { App } from '../app';
import { h } from './dom';
import { confirmDialog, toast } from './overlay';
import { CommentRecord, HighlightRecord, PassageRecord } from '../../shared/types';
import { uid } from './dom';
import { openRewriteFor } from './rewrite';

const COLOR_NAMES: Record<string, string> = { yellow: 'Yellow', green: 'Green', blue: 'Blue', pink: 'Pink' };

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
  const showRes = h('input', { type: 'checkbox', checked: ann.showResolved });
  showRes.addEventListener('change', () => {
    ann.showResolved = showRes.checked;
    ann.refresh();
  });
  body.append(
    h(
      'div',
      { class: 'rv-head' },
      h('span', null, `Comments (${open.length})`),
      h('span', { class: 'spacer' }),
      h('label', { class: 'rv-toggle' }, showRes, `Resolved (${resolved.length})`),
    ),
  );
  const comments = [...open, ...(ann.showResolved ? resolved : [])];
  if (!comments.length) body.append(h('div', { class: 'notice' }, `Select text and choose Comment (${app.commands.label('edit.comment') || 'context menu'}) to add one.`));
  for (const c of comments) body.append(commentCard(app, c, rerender));

  // Alternatives -----------------------------------------------------------------------
  const passages = m.passages.filter((p) => !p.detached);
  body.append(h('div', { class: 'rv-head' }, h('span', null, `Alternative passages (${passages.length})`)));
  if (!passages.length) body.append(h('div', { class: 'notice' }, `Select a passage and choose Rewrite… (${app.commands.label('edit.rewrite') || 'context menu'}) to keep several versions.`));
  for (const p of passages) {
    const active = p.alternatives.find((a) => a.id === p.activeId);
    body.append(
      h(
        'div',
        { class: 'rv-item' },
        h('button', { class: 'rv-quote', onclick: () => app.revealAnnotation(p.id) }, p.name),
        h('div', { class: 'rv-meta' }, `${p.alternatives.length} versions · using “${active?.name ?? '?'}”${p.sceneHeading ? ' · ' + p.sceneHeading : ''}`),
        h('div', { class: 'rv-actions' }, h('button', { class: 'btn sm', onclick: () => openRewriteFor(app, p.id) }, 'Open…')),
      ),
    );
  }

  // Highlights ---------------------------------------------------------------------------
  const hls = m.highlights.filter((x) => !x.detached);
  body.append(h('div', { class: 'rv-head' }, h('span', null, `Highlights (${hls.length})`)));
  for (const hl of hls) {
    body.append(
      h(
        'div',
        { class: 'rv-item rv-row' },
        h('span', { class: `rv-dot dot-${hl.color}`, title: COLOR_NAMES[hl.color] }),
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
    body.append(h('div', { class: 'rv-head warn' }, h('span', null, `Detached (${detached.length})`)));
    body.append(h('div', { class: 'notice' }, 'The text these belonged to was deleted or changed. Select the right text and attach them again, or delete them.'));
    for (const { kind, rec } of detached) {
      const label = kind === 'comment' ? `Comment: ${quote((rec as CommentRecord).text, 50)}` : kind === 'passage' ? `Passage: ${(rec as PassageRecord).name}` : `${COLOR_NAMES[(rec as HighlightRecord).color]} highlight`;
      body.append(
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
  const reply = h('input', { class: 'field sm', placeholder: 'Reply', 'aria-label': 'Reply' });
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
        },
      }, c.resolved ? 'Reopen' : 'Resolve'),
      h('button', {
        class: 'btn sm',
        onclick: () => {
          const an = ann.live.get(c.id) ?? null;
          ann.removeRecord(c.id);
          toast('Comment deleted.', { actions: [{ label: 'Undo', run: () => ann.restoreRecord('comment', c, an) }] });
        },
      }, 'Delete'),
    ),
  );
}
