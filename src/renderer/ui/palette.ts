// Command window: search and run commands, and manage their shortcuts.

import type { App } from '../app';
import { Command, comboFromEvent, formatCombo } from '../commands';
import { h, icon } from './dom';
import { openDialog } from './overlay';
import { isMac } from '../bridge';

/** The command list with shortcut editing. Used by the command window and Settings. */
export class CommandList {
  el: HTMLElement;
  search: HTMLInputElement;
  private list: HTMLElement;
  private msg: HTMLElement;
  private selected = 0;
  private items: Command[] = [];
  private recordingId: string | null = null;
  private pending: { id: string; combo: string } | null = null;

  constructor(private app: App, private opts: { onRun?: (c: Command) => void; embedded?: boolean }) {
    this.search = h('input', { class: 'field', placeholder: opts.embedded ? 'Filter commands' : 'Search commands', 'aria-label': 'Search commands', spellcheck: 'false' });
    this.search.dataset.esc = 'self';
    this.search.addEventListener('input', () => {
      this.selected = 0;
      this.render();
    });
    this.search.addEventListener('keydown', (e) => this.onKey(e));
    this.list = h('div', { class: 'list', role: 'listbox', 'aria-label': 'Commands' });
    this.msg = h('div', { class: 'msg hidden' });
    const mod = isMac ? '⌘' : 'Ctrl+';
    const foot = h(
      'div',
      { class: 'foot' },
      opts.onRun ? h('span', null, '↵ Run') : null,
      h('span', null, `${mod}R Record shortcut`),
      h('span', null, `${mod}${isMac ? '⌫' : 'Backspace'} Clear`),
      h('span', null, `${mod}${isMac ? '⇧' : 'Shift+'}R Restore default`),
    );
    this.el = h('div', { class: 'palette', style: { display: 'flex', flexDirection: 'column', minHeight: '0', flex: '1' } }, h('div', { class: 'search' }, this.search), this.list, this.msg, foot);
    this.render();
  }

  private filtered(): Command[] {
    const q = this.search.value.trim().toLowerCase();
    const all = this.app.commands.all().filter((c) => c.id !== 'edit.selectAll' || true);
    if (!q) return all;
    const words = q.split(/\s+/);
    return all.filter((c) => {
      const hay = `${c.category} ${c.title} ${this.app.commands.keysFor(c.id).map(formatCombo).join(' ')}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }

  render() {
    this.items = this.filtered();
    if (this.selected >= this.items.length) this.selected = Math.max(0, this.items.length - 1);
    this.list.textContent = '';
    this.items.forEach((c, i) => {
      const keys = this.app.commands.keysFor(c.id);
      const keyEls = h('span', { class: 'keys' });
      if (this.recordingId === c.id) keyEls.append(h('span', { class: 'kbd recording' }, this.pending ? formatCombo(this.pending.combo) : 'Press keys…'));
      else {
        for (const k of keys) {
          const conflict = this.app.commands.lookup(k).length > 1;
          keyEls.append(h('span', { class: `kbd${conflict ? ' conflict' : ''}`, title: conflict ? 'This shortcut is assigned to more than one command' : '' }, formatCombo(k)));
        }
      }
      const enabled = !c.enabled || c.enabled();
      const acts = h(
        'span',
        { class: 'acts' },
        h('button', { class: 'icon-btn', title: 'Record shortcut', tabindex: '-1', onclick: (e: MouseEvent) => (e.stopPropagation(), this.startRecording(c.id)) }, h('span', { style: { fontSize: '11px' } }, '⏺')),
        h('button', { class: 'icon-btn', title: 'Clear shortcut', tabindex: '-1', onclick: (e: MouseEvent) => (e.stopPropagation(), this.clear(c.id)) }, icon('close')),
        h('button', { class: 'icon-btn', title: 'Restore default', tabindex: '-1', onclick: (e: MouseEvent) => (e.stopPropagation(), this.reset(c.id)) }, icon('restore')),
      );
      const row = h(
        'div',
        { class: `row${i === this.selected ? ' selected' : ''}`, role: 'option', 'aria-selected': String(i === this.selected), style: enabled ? {} : { color: 'var(--text-3)' } },
        h('span', { class: 'cat' }, c.category),
        h('span', { class: 'label' }, c.title, this.app.commands.isDefault(c.id) ? null : h('span', { class: 'dim', style: { fontSize: '11px' } }, '  · custom')),
        keyEls,
        acts,
      );
      row.addEventListener('mousemove', () => {
        if (this.selected !== i) {
          this.selected = i;
          this.updateSelection();
        }
      });
      row.addEventListener('click', () => {
        this.selected = i;
        if (this.opts.onRun) this.opts.onRun(c);
        else this.updateSelection();
      });
      this.list.append(row);
    });
    this.updateSelection();
  }

  private updateSelection() {
    Array.from(this.list.children).forEach((r, i) => {
      r.classList.toggle('selected', i === this.selected);
      r.setAttribute('aria-selected', String(i === this.selected));
    });
    this.list.children[this.selected]?.scrollIntoView({ block: 'nearest' });
  }

  private setMsg(text: string, warn = false, actions: Array<{ label: string; run: () => void }> = []) {
    this.msg.textContent = '';
    this.msg.className = `msg${warn ? ' warn' : ''}${text ? '' : ' hidden'}`;
    if (!text) return;
    this.msg.append(h('span', null, text));
    for (const a of actions) this.msg.append(' ', h('button', { class: 'btn', style: { height: '22px', marginLeft: '6px' }, onclick: a.run }, a.label));
  }

  private onKey(e: KeyboardEvent) {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const c = this.items[this.selected];
    if (e.key === 'ArrowDown') {
      this.selected = Math.min(this.items.length - 1, this.selected + 1);
      this.updateSelection();
    } else if (e.key === 'ArrowUp') {
      this.selected = Math.max(0, this.selected - 1);
      this.updateSelection();
    } else if (e.key === 'PageDown') {
      this.selected = Math.min(this.items.length - 1, this.selected + 10);
      this.updateSelection();
    } else if (e.key === 'PageUp') {
      this.selected = Math.max(0, this.selected - 10);
      this.updateSelection();
    } else if (e.key === 'Enter' && !mod) {
      if (c && this.opts.onRun) this.opts.onRun(c);
    } else if (mod && e.code === 'KeyR' && !e.shiftKey) {
      if (c) this.startRecording(c.id);
    } else if (mod && e.code === 'KeyR' && e.shiftKey) {
      if (c) this.reset(c.id);
    } else if (mod && e.key === 'Backspace') {
      if (c) this.clear(c.id);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }

  private startRecording(id: string) {
    this.recordingId = id;
    this.pending = null;
    this.setMsg('Press the new shortcut. Esc cancels.');
    this.render();
    this.app.recording = (e: KeyboardEvent) => {
      // The pressed keys go to the recorder only; they never run their current command.
      e.preventDefault();
      e.stopPropagation();
      if (e.type !== 'keydown') return;
      if (e.key === 'Escape') {
        this.stopRecording();
        this.setMsg('');
        return;
      }
      const combo = comboFromEvent(e);
      if (!combo) return;
      const conflicts = this.app.commands.conflictsFor(id, combo);
      if (!conflicts.length) {
        this.app.commands.assign(id, combo);
        this.stopRecording();
        this.setMsg(`Assigned ${formatCombo(combo)}.`);
        return;
      }
      this.pending = { id, combo };
      this.app.recording = null;
      this.render();
      const names = conflicts.map((x) => `“${x.title}”`).join(', ');
      this.setMsg(`${formatCombo(combo)} is already used by ${names}.`, true, [
        {
          label: 'Reassign',
          run: () => {
            this.app.commands.assign(id, combo);
            this.stopRecording();
            this.setMsg(`Assigned ${formatCombo(combo)}; removed it from ${names}.`);
            this.search.focus();
          },
        },
        {
          label: 'Cancel',
          run: () => {
            this.stopRecording();
            this.setMsg('');
            this.search.focus();
          },
        },
      ]);
    };
  }

  private stopRecording() {
    this.app.recording = null;
    this.recordingId = null;
    this.pending = null;
    this.render();
    this.search.focus();
  }

  private clear(id: string) {
    this.app.commands.clear(id);
    this.setMsg('Shortcut cleared.');
    this.render();
  }

  private reset(id: string) {
    this.app.commands.reset(id);
    const k = this.app.commands.keysFor(id);
    this.setMsg(k.length ? `Restored ${k.map(formatCombo).join(', ')}.` : 'Restored (no default shortcut).');
    this.render();
  }

  dispose() {
    if (this.recordingId) this.stopRecording();
  }
}

export function openPalette(app: App) {
  let list: CommandList;
  const dlg = openDialog({
    title: 'Commands & Shortcuts',
    cls: 'palette',
    body: [],
    onClose: () => list.dispose(),
    cancel: () => {
      if (app.recording) return; // Escape is handled by the recorder
      dlg.close();
    },
  });
  list = new CommandList(app, {
    onRun: (c) => {
      dlg.close();
      setTimeout(() => app.run(c.id), 0);
    },
  });
  dlg.body.replaceWith(list.el);
  list.el.style.maxHeight = 'calc(80vh - 34px)';
  setTimeout(() => list.search.focus(), 0);
}
