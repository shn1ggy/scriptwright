import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { DE } from '../src/shared/i18n-de';
import { setUiLanguage, t, tn } from '../src/shared/i18n';

/** All string literals passed to t() and tn() in the source. */
function usedKeys(): string[] {
  const out = new Set<string>();
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.ts') && !p.endsWith('i18n-de.ts')) {
        const src = fs.readFileSync(p, 'utf8');
        const lit = `'((?:[^'\\\\\\n]|\\\\.)*)'|"((?:[^"\\\\\\n]|\\\\.)*)"`;
        for (const m of src.matchAll(new RegExp(`\\bt\\(\\s*(?:${lit})`, 'g'))) out.add(unescape(m[1] ?? m[2]));
        for (const m of src.matchAll(new RegExp(`\\btn\\([^,]+,\\s*(?:${lit})\\s*,\\s*(?:${lit})`, 'g'))) {
          out.add(unescape(m[1] ?? m[2]));
          out.add(unescape(m[3] ?? m[4]));
        }
      }
    }
  };
  walk(path.join(process.cwd(), 'src'));
  return [...out];
}
function unescape(s: string): string {
  return s.replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c));
}

test('every interface string has a German entry', () => {
  const missing = usedKeys().filter((k) => !(k in DE));
  assert.deepEqual(missing, []);
});

test('German entries keep their placeholders', () => {
  const ph = (s: string) => [...new Set(s.match(/\{[^}]*\}/g) ?? [])].sort().join(',');
  const bad = Object.entries(DE).filter(([k, v]) => ph(k) !== ph(v));
  assert.deepEqual(bad, []);
});

test('t and tn fill in values and switch language', () => {
  setUiLanguage('en');
  assert.equal(t('Scene {0} of {1}', 3, 40), 'Scene 3 of 40');
  assert.equal(tn(1, '{0} scene', '{0} scenes'), '1 scene');
  setUiLanguage('de');
  assert.equal(t('Scene {0} of {1}', 3, 40), 'Szene 3 von 40');
  assert.equal(tn(5, '{0} scene', '{0} scenes'), '5 Szenen');
  assert.equal(t('not a known string'), 'not a known string');
  setUiLanguage('en');
});
