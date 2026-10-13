// Feedback round 9: resolved comments view, scene list colour and selection, dialogue export.
import os from 'os';
import path from 'path';
import { startHarness, assert, sleep } from './util.mjs';

const h = await startHarness();
const { page } = h;
const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); await page.screenshot({ path: path.join(os.tmpdir(), `r9-fail-${results.length}.png`) }); }
}
const app = (fn, ...a) => page.evaluate(fn, ...a);

await check('resolved comments move to the Resolved view and can be reopened', async () => {
  await app(() => {
    const a = window.__app;
    const ed = a.editor;
    const i = ed.lines.findIndex((l) => l.text.includes('Rain hammers'));
    ed.setSelection({ anchor: { line: i, ch: 0 }, head: { line: i, ch: 4 } });
    a.annotations.addComment('Louder.', a.annotations.selectionAnchor());
    a.showRightTab('comments');
  });
  await sleep(200);
  await page.click('.rv-comment .btn:has-text("Resolve")');
  await sleep(200);
  assert((await page.locator('.rv-comment').count()) === 0, 'still in Open');
  await page.click('.seg-btn:has-text("Resolved")');
  await sleep(200);
  assert((await page.locator('.rv-comment').count()) === 1, 'not in Resolved');
  await page.click('.rv-comment .btn:has-text("Reopen")');
  await page.click('.seg-btn:has-text("Open")');
  await sleep(200);
  assert((await page.locator('.rv-comment').count()) === 1, 'not reopened');
});

await check('scene colour shows on the number; headings stay aligned', async () => {
  await app(() => {
    const a = window.__app;
    a.updateSceneRecord(a.scenes.filter((s) => s.kind === 'scene')[1], { color: '#E5706B' });
  });
  const xs = await page.locator('.outline .row:not(.title-row) .label').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
  assert(new Set(xs).size === 1, JSON.stringify(xs));
  const col = await page.locator('.outline .row:not(.title-row) .num').nth(1).evaluate((e) => getComputedStyle(e).color);
  assert(col === 'rgb(229, 112, 107)', col);
});

await check('a clicked scene stops being marked once writing moves to another scene', async () => {
  await page.locator('.outline .row:not(.title-row)').nth(0).click();
  assert((await page.locator('.outline .row.selected').count()) === 1, 'not selected');
  await app(() => {
    const a = window.__app;
    const s = a.scenes.filter((x) => x.kind === 'scene')[2];
    a.editor.setSelection({ anchor: { line: s.line + 2, ch: 0 }, head: { line: s.line + 2, ch: 0 } });
  });
  await sleep(100);
  assert((await page.locator('.outline .row.selected').count()) === 0, 'old selection still marked');
});

await check('Dialogue view: title, info and Export for the chosen character', async () => {
  await page.keyboard.press('Control+4');
  await page.selectOption('.view-head select[aria-label="Character"]', 'TOM');
  await sleep(100);
  const title = await page.textContent('.view-head-title');
  const info = await page.textContent('.view-head-info');
  assert(title === 'Dialogue' && /speech/.test(info), `${title} / ${info}`);
  const hs = await page.locator('.view-head select, .view-head .btn').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
  assert(new Set(hs).size === 1, 'control heights differ: ' + JSON.stringify(hs));
  await page.screenshot({ path: path.join(os.tmpdir(), 'sw-r9-dialogue.png') });
  await page.click('.view-head .btn:has-text("Export")');
  await page.waitForSelector('.main .export');
  await sleep(300);
  const scope = await page.locator('.export-side select').first().inputValue();
  const who = await page.locator('.export-side select[aria-label="Character"]').inputValue();
  assert(scope === 'dialogue' && who === 'TOM', `${scope} ${who}`);
  await page.keyboard.press('Escape');
});

console.log(results.map((r) => r.join(' — ')).join('\n'));
console.log('page errors:', JSON.stringify(h.errors.filter((e) => !e.includes('404'))));
await h.stop();
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
