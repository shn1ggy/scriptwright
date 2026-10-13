import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, fingerprint } from '../src/shared/scenes';
import { SceneRecord } from '../src/shared/types';

const rec = (id: string, heading: string, body: string, order: number, extra: Partial<SceneRecord> = {}): SceneRecord => ({ id, heading, fingerprint: fingerprint(body.split('\n')), order, ...extra });
const sc = (heading: string, body: string) => ({ heading, fingerprint: fingerprint(body.split('\n')) });

test('matches after reordering', () => {
  const r = reconcile([rec('a', 'INT. A', 'one', 1), rec('b', 'INT. B', 'two', 2)], [sc('INT. B', 'two'), sc('INT. A', 'one')]);
  assert.deepEqual(r.ids, ['b', 'a']);
  assert.equal(r.unmatched.length, 0);
});

test('matches a renamed heading by body, and an edited body by heading', () => {
  const r = reconcile([rec('a', 'INT. A', 'one', 1), rec('b', 'INT. B', 'two', 2)], [sc('INT. A2', 'one'), sc('INT. B', 'two changed')]);
  assert.deepEqual(r.ids, ['a', 'b']);
});

test('ambiguous duplicates are not guessed', () => {
  const r = reconcile([rec('a', 'INT. A', 'x', 1, { notes: 'n' })], [sc('INT. A', 'y'), sc('INT. A', 'z')]);
  assert.deepEqual(r.ids, [null, null]);
  assert.equal(r.ambiguous[0].id, 'a');
  assert.equal(r.unmatched[0].id, 'a');
});

test('identical duplicates keep their relative order', () => {
  const r = reconcile([rec('a', 'INT. A', 'x', 1), rec('b', 'INT. A', 'x', 5)], [sc('INT. A', 'x'), sc('INT. A', 'x')]);
  assert.deepEqual(r.ids, ['a', 'b']);
});

test('new scenes get no id, removed scenes are unmatched', () => {
  const r = reconcile([rec('a', 'INT. A', 'x', 1), rec('gone', 'INT. G', 'g', 2)], [sc('INT. A', 'x'), sc('INT. NEW', '')]);
  assert.deepEqual(r.ids, ['a', null]);
  assert.deepEqual(r.unmatched.map((x) => x.id), ['gone']);
});
