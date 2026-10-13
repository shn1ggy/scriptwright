import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { parse, reparseLine } from '../src/shared/fountain';

function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

const norm = (r: ReturnType<typeof parse>) => ({
  lines: r.lines.map((l) => ({ t: l.type, f: l.flags ? Array.from(l.flags).join(',') : '', c: l.cue, d: !!l.dual, b: l.block !== undefined, i: !!l.inDialogue, lv: l.level, sn: l.sceneNumber })),
  scenes: r.scenes.map((s) => [s.line, s.end, s.heading, s.sceneNumber, s.order]),
  titleEnd: r.titleEnd,
});

test('single-line fast reparse always equals a full parse (fuzz)', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'e2e', 'fixtures', 'sample.fountain'), 'utf8');
  const base = src.split('\n');
  const rand = rng(42);
  const alphabet = ['a', 'B', ' ', '*', '_', '.', '@', '!', '>', '<', '~', '#', '=', '(', ')', ':', 'TO:', 'INT. ', '\\', 'Ä'];
  let fastUsed = 0;
  for (let iter = 0; iter < 3000; iter++) {
    const lines = base.slice();
    // random prior mutations to vary context
    for (let m = 0; m < 3; m++) {
      const li = Math.floor(rand() * lines.length);
      const t = lines[li];
      const pos = Math.floor(rand() * (t.length + 1));
      lines[li] = t.slice(0, pos) + alphabet[Math.floor(rand() * alphabet.length)] + t.slice(pos);
    }
    const active = Math.floor(rand() * lines.length);
    const opts = { activeLine: active, extraPrefixes: ['INNEN'] };
    const prev = parse(lines, opts);
    const li = active;
    const old = lines[li];
    const pos = Math.floor(rand() * (old.length + 1));
    const next = lines.slice();
    next[li] = rand() < 0.3 && old.length ? old.slice(0, Math.max(0, pos - 1)) + old.slice(pos) : old.slice(0, pos) + alphabet[Math.floor(rand() * alphabet.length)] + old.slice(pos);
    const fast = reparseLine(next, prev, li, old, opts);
    if (!fast) continue;
    fastUsed++;
    const full = parse(next, opts);
    assert.deepEqual(norm(fast), norm(full), `iteration ${iter}: line ${li} ${JSON.stringify(old)} -> ${JSON.stringify(next[li])}`);
  }
  assert.ok(fastUsed > 500, `fast path used only ${fastUsed} times`);
});
