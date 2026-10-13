// Feedback round 10: clear buttons, find in one scene, folded results, instant deletes, preview brightness.
import os from 'os';
import path from 'path';
import { startHarness, assert, sleep } from './util.mjs';

const h = await startHarness();
const { page } = h;
const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); await page.screenshot({ path: path.join(os.tmpdir(), `r10-fail-${results.length}.png`) }); }
}
const app = (fn, ...a) => page.evaluate(fn, ...a);

await check('scene search has a clear button that brings all scenes back', async () => {
  await page.fill('.outline-search input', 'harbour');
  await page.dispatchEvent('.outline-search input', 'input');
  await sleep(100);
  const n1 = await page.locator('.outline .row').count();
  assert(await page.isVisible('.outline-search .field-clear'), 'no clear button');
  await page.click('.outline-search .field-clear');
  await sleep(100);
  const n2 = await page.locator('.outline .row').count();
  assert(n2 > n1 && (await page.inputValue('.outline-search input')) === '', `${n1} → ${n2}`);
  assert(await page.isHidden('.outline-search .field-clear'), 'clear button still shown');
});

await check('find in Scene view searches only that scene; results are folded by default', async () => {
  await app(() => {
    const a = window.__app;
    a.setView('scene');
    a.enterScene(a.scenes.filter((s) => s.kind === 'scene')[0]);
  });
  await page.keyboard.press('Control+F');
  await page.keyboard.type('TOM');
  await sleep(200);
  const inScene = await app(() => {
    const a = window.__app;
    const sc = a.scenes.filter((s) => s.kind === 'scene')[0];
    return a.editor.lines.slice(sc.line, sc.end).reduce((n, l) => n + (l.text.match(/tom/gi) || []).length, 0);
  });
  const count = await page.textContent('.findbar-count');
  assert(new RegExp(`of ${inScene}$`).test(count), `${count} vs ${inScene} in the scene`);
  assert(await page.isHidden('.findbar-results'), 'results shown by default');
  await page.click('.findbar [aria-label="Show all results"]');
  assert(await page.isVisible('.findbar-results'), 'results did not open');
  await page.keyboard.press('Escape');
  await app(() => window.__app.setView('script'));
});

await check('deleting a comment removes it from the Review pane at once', async () => {
  await app(() => {
    const a = window.__app;
    const ed = a.editor;
    const i = ed.lines.findIndex((l) => l.text.includes('Rain hammers'));
    ed.setSelection({ anchor: { line: i, ch: 0 }, head: { line: i, ch: 4 } });
    a.annotations.addComment('Delete me.', a.annotations.selectionAnchor());
    a.showRightTab('comments');
  });
  await sleep(250);
  await page.click('.rv-comment .btn:has-text("Delete")');
  await sleep(50);
  assert((await page.locator('.rv-comment').count()) === 0, 'still shown');
});

await check('preview brightness is applied and remembered; Source sits next to Export', async () => {
  const tabs = await page.locator('.viewbar > .tabs:last-child .tab').allTextContents();
  assert(JSON.stringify(tabs) === '["Source","Export"]', JSON.stringify(tabs));
  await page.keyboard.press('Control+E');
  await page.waitForSelector('.export-preview canvas', { timeout: 15000 });
  await page.locator('.preview-dim input').fill('70');
  await page.locator('.preview-dim input').dispatchEvent('input');
  const f = await page.locator('.export-preview canvas').first().evaluate((c) => getComputedStyle(c).filter);
  assert(f.includes('0.7'), f);
  await page.keyboard.press('Escape');
  const saved = await app(() => window.__app.state.layout.previewBrightness);
  assert(saved === 70, String(saved));
});

await check('destructive buttons are red, not red on the accent colour', async () => {
  await app(() => {
    const a = window.__app;
    a.project.meta.shelf.unshift({ id: 'x1', text: 'Cut text', created: new Date().toISOString(), kind: 'cut' });
    a.showRightTab('shelf');
  });
  await sleep(200);
  await page.click('.rp-body .btn:has-text("Delete")');
  await page.waitForSelector('.dialog .btn.danger');
  const bg = await page.locator('.dialog .btn.danger').evaluate((b) => getComputedStyle(b).backgroundColor);
  await page.screenshot({ path: path.join(os.tmpdir(), 'sw-r10-delete.png') });
  assert(!/71, 193, 245/.test(bg), bg);
  await page.keyboard.press('Escape');
});

console.log(results.map((r) => r.join(' — ')).join('\n'));
console.log('page errors:', JSON.stringify(h.errors.filter((e) => !e.includes('404'))));
await h.stop();
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
