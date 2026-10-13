// Round 14: undo keys, review toggles, put back, shared scenes, window-centred text.
import os from 'os';
import path from 'path';
import { startHarness, assert, sleep } from './util.mjs';

const h = await startHarness();
const { page } = h;
const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); await page.screenshot({ path: path.join(os.tmpdir(), `r14-fail-${results.length}.png`) }); }
}
const app = (fn, ...a) => page.evaluate(fn, ...a);
const text = () => app(() => window.__app.editor.getText());

await check('Ctrl+Z undoes typing and a deleted comment; Ctrl+Y redoes', async () => {
  const before = await text();
  await app(() => { const ed = window.__app.editor; ed.setSelection({ anchor: { line: 12, ch: 0 }, head: { line: 12, ch: 0 } }); ed.focus(); });
  await page.keyboard.type('Wind. ');
  await page.keyboard.press('Control+Z');
  assert((await text()) === before, 'typing not undone');
  await page.keyboard.press('Control+Y');
  assert((await text()) !== before, 'not redone');
  await page.keyboard.press('Control+Z');
  const n0 = await app(() => window.__app.project.meta.comments.length);
  await app(() => {
    const a = window.__app;
    const ed = a.editor;
    const i = ed.lines.findIndex((l) => l.text.includes('Rain hammers'));
    ed.setSelection({ anchor: { line: i, ch: 0 }, head: { line: i, ch: 4 } });
    a.annotations.addComment('Gone soon.', a.annotations.selectionAnchor());
    a.showRightTab('comments');
  });
  await sleep(200);
  await page.locator('.rv-comment:has-text("Gone soon.") .btn:has-text("Delete")').click();
  await sleep(100);
  await page.keyboard.press('Control+Z');
  await sleep(100);
  assert((await app(() => window.__app.project.meta.comments.length)) === n0 + 1, 'comment delete not undone by the key');
});

await check('Review toggles show comments, alternatives and highlights separately', async () => {
  await page.click('.rp-body .kind-toggle[data-k="passages"]');
  await page.click('.rp-body .kind-toggle[data-k="highlights"]');
  await sleep(100);
  const hidden = await page.locator('.rp-body .rv-section.hidden').count();
  assert(hidden === 2, String(hidden));
  await page.click('.rp-body .kind-toggle[data-k="passages"]');
  await page.click('.rp-body .kind-toggle[data-k="highlights"]');
});

await check('putting cut material back removes it from the shelf', async () => {
  await app(() => {
    const a = window.__app;
    const ed = a.editor;
    const i = ed.lines.findIndex((l) => l.text.includes('Rain hammers'));
    ed.setSelection({ anchor: { line: i, ch: 0 }, head: { line: i, ch: 5 } });
    a.run('shelf.cut');
    a.showRightTab('shelf');
  });
  await sleep(300);
  const n = await app(() => window.__app.project.meta.shelf.length);
  await page.locator('.rp-body .btn:has-text("Put back")').first().click();
  await sleep(300);
  assert((await app(() => window.__app.project.meta.shelf.length)) === n - 1, 'still on the shelf');
});

await check('the text column keeps its place when both panes toggle', async () => {
  await page.setViewportSize({ width: 1700, height: 900 });
  await app(() => { const a = window.__app; a.state.layout.leftVisible = true; a.state.layout.rightVisible = true; a.applyLayout(); a.closePanel(); a.setView('script'); });
  await sleep(300);
  const x1 = await page.locator('.ed-column').evaluate((e) => e.getBoundingClientRect().left);
  await app(() => window.__app.hidePanes());
  await sleep(300);
  const x2 = await page.locator('.ed-column').evaluate((e) => e.getBoundingClientRect().left);
  assert(Math.abs(x1 - x2) <= 1, `${x1} → ${x2}`);
  await app(() => window.__app.hidePanes());
});

console.log(results.map((r) => r.join(' — ')).join('\n'));
console.log('page errors:', JSON.stringify(h.errors.filter((e) => !e.includes('404'))));
await h.stop();
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
