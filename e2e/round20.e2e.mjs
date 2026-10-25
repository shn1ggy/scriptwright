// Round 20: reordering scene cards by drag stays clean (no leftover drop-line classes after the
// drag ends, and dropping actually moves the scene), and the app ships with a default GitHub
// repository for updates so nothing has to be typed in.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { startHarness, assert, sleep, root } from './util.mjs';

const h = await startHarness();
const { page } = h;
const results = [];
const shots = process.env.SHOTS;
async function check(name, fn) {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); await page.screenshot({ path: path.join(os.tmpdir(), `r20-fail-${results.length}.png`) }); }
}
const app = (fn, ...a) => page.evaluate(fn, ...a);
await page.setViewportSize({ width: 1400, height: 900 });

await check('dragging a card to reorder moves the scene and leaves no stray drop-line classes', async () => {
  await app(() => window.__app.openPanel('cards'));
  await sleep(400);
  const before = await app(() => window.__app.scenes.filter((x) => x.kind === 'scene').map((s) => s.heading));
  assert(before.length >= 2, 'need at least two scenes');
  const cards = page.locator('.cards-grid .card');
  const src = cards.nth(0);
  const dst = cards.nth(1);
  // Dispatch the native drag sequence by hand: Playwright's own dragTo is unreliable with
  // custom HTML5 dragover handlers, and this also exercises the same listeners a real OS
  // drag uses, including the deferred "dragging" class and the per-frame drop indicator.
  await app(() => {
    const dt = new DataTransfer();
    const cardsEl = [...document.querySelectorAll('.cards-grid .card')];
    const from = cardsEl[0];
    const to = cardsEl[1];
    const fire = (el, type, x, y) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
    const r = to.getBoundingClientRect();
    fire(from, 'dragstart', r.left - 50, r.top + r.height / 2);
    fire(to, 'dragover', r.right - 2, r.top + r.height / 2); // drop after `to`
    window.__r20_dropClasses_during = [...document.querySelectorAll('.drop-before, .drop-after')].length;
  });
  // The drop indicator itself is applied on the next animation frame.
  await page.waitForFunction(() => document.querySelectorAll('.cards-grid .drop-after, .cards-grid .drop-before').length > 0);
  assert((await page.locator('.cards-grid .drop-after').count()) === 1, 'no drop line shown');
  await app(() => {
    const dt = new DataTransfer();
    const cardsEl = [...document.querySelectorAll('.cards-grid .card')];
    const to = cardsEl[1];
    const r = to.getBoundingClientRect();
    const fire = (el, type, x, y) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
    fire(to, 'drop', r.right - 2, r.top + r.height / 2);
    fire(to, 'dragend', r.right - 2, r.top + r.height / 2);
  });
  await sleep(200);
  const after = await app(() => window.__app.scenes.filter((x) => x.kind === 'scene').map((s) => s.heading));
  assert(after[0] === before[1] && after[1] === before[0], `not reordered: ${JSON.stringify(after)}`);
  assert((await page.locator('.cards-grid .drop-before, .cards-grid .drop-after').count()) === 0, 'drop line left behind');
  assert((await page.locator('.cards-grid .dragging').count()) === 0, 'dragging class left behind');
  if (shots) await page.screenshot({ path: path.join(shots, 'cards-after-drag.png') });
  await app(() => window.__app.closePanel());
});

await check('the app ships with a default GitHub repository for updates, nothing to type in', async () => {
  // Settings → Updates only renders in Electron (bridge.update), so the harness (a browser
  // tab) cannot show the field; this checks the same build-time wiring directly instead,
  // the way `scripts/build.mjs` actually bakes `pkg.scriptwright.updateRepo` into the app.
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert(pkg.scriptwright?.updateRepo === 'shn1ggy/scriptwright', `package.json: ${pkg.scriptwright?.updateRepo}`);
  const bundle = fs.readFileSync(path.join(root, 'dist', 'renderer', 'app.js'), 'utf8');
  assert(bundle.includes('shn1ggy/scriptwright'), 'repo not baked into the built app');
});

console.log(results.map((r) => r.join(' — ')).join('\n'));
console.log('page errors:', JSON.stringify(h.errors.filter((e) => !e.includes('404'))));
await h.stop();
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
