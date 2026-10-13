// Side-by-side line comparison used for conflicts, recovery and sync copies.

import { h } from './dom';
import { openDialog } from './overlay';

export type DiffOp = { kind: 'same' | 'add' | 'del'; text: string };

/** Line diff (Myers-style via LCS on trimmed-window). Good enough for screenplay sizes. */
export function diffLines(a: string[], b: string[]): DiffOp[] {
  // Trim common prefix/suffix
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const A = a.slice(start, endA);
  const B = b.slice(start, endB);
  const ops: DiffOp[] = a.slice(0, start).map((t) => ({ kind: 'same' as const, text: t }));
  if (A.length * B.length > 4_000_000) {
    // Too large for LCS: show as replaced block.
    ops.push(...A.map((t) => ({ kind: 'del' as const, text: t })), ...B.map((t) => ({ kind: 'add' as const, text: t })));
  } else {
    const n = A.length;
    const m = B.length;
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) {
        ops.push({ kind: 'same', text: A[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ kind: 'del', text: A[i++] });
      else ops.push({ kind: 'add', text: B[j++] });
    }
    while (i < n) ops.push({ kind: 'del', text: A[i++] });
    while (j < m) ops.push({ kind: 'add', text: B[j++] });
  }
  ops.push(...a.slice(endA).map((t) => ({ kind: 'same' as const, text: t })));
  return ops;
}

/** Shows differences; resolves true when the user chooses the action for `b`. */
export function compareDialog(title: string, a: string, b: string, aLabel: string, bLabel: string, actionLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ops = diffLines(a.split('\n'), b.split('\n'));
    const adds = ops.filter((o) => o.kind === 'add').length;
    const dels = ops.filter((o) => o.kind === 'del').length;
    const out = h('div', { class: 'diff preview-text' });
    // Collapse long unchanged stretches
    let k = 0;
    while (k < ops.length) {
      if (ops[k].kind === 'same') {
        let e = k;
        while (e < ops.length && ops[e].kind === 'same') e++;
        const run = ops.slice(k, e);
        if (run.length > 6) {
          const head = k === 0 ? [] : run.slice(0, 2);
          const tail = e === ops.length ? [] : run.slice(-2);
          for (const o of head) out.append(h('div', null, o.text || ' '));
          out.append(h('div', { class: 'dim' }, `⋯ ${run.length - head.length - tail.length} unchanged lines`));
          for (const o of tail) out.append(h('div', null, o.text || ' '));
        } else for (const o of run) out.append(h('div', null, o.text || ' '));
        k = e;
      } else {
        const o = ops[k++];
        out.append(h('div', { class: o.kind }, (o.kind === 'add' ? '+ ' : '− ') + (o.text || ' ')));
      }
    }
    let result = false;
    openDialog({
      title,
      width: 760,
      body: [h('p', null, `Lines marked − are only in “${aLabel}”; lines marked + are only in “${bLabel}”. ${dels} removed, ${adds} added.`), out],
      buttons: [{ label: 'Back' }, { label: actionLabel, primary: true, run: () => void (result = true) }],
      onClose: () => resolve(result),
    });
  });
}
