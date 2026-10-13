// Round 13: History view, comparison modes, Cards drive the Scene notes.
import os from 'os';
import path from 'path';
import { startHarness, assert, sleep } from './util.mjs';

const h = await startHarness();
const { page } = h;
const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); await page.screenshot({ path: path.join(os.tmpdir(), `r13-fail-${results.length}.png`) }); }
}
const app = (fn, ...a) => page.evaluate(fn, ...a);

await check('clicking a card shows that scene in the notes pane; Edit summary stays in Cards', async () => {
  await app(() => { const a = window.__app; a.state.layout.rightVisible = true; a.applyLayout(); a.showRightTab('scene'); a.openPanel('cards'); });
  await sleep(300);
  await page.locator('.card').nth(2).click();
  await sleep(150);
  const head = await page.locator('.rp-body .notice').first().textContent();
  const want = await app(() => window.__app.scenes.filter((s) => s.kind === 'scene')[2].heading);
  assert(head.includes(want), `${head} vs ${want}`);
  await page.locator('.card').nth(1).click({ button: 'right' });
  await page.click('.menu .menu-item:has-text("Edit summary")');
  await sleep(150);
  const st = await app(() => ({ panel: window.__app.panel, focus: document.activeElement?.getAttribute('aria-label') }));
  assert(st.panel === 'cards' && st.focus === 'Scene summary', JSON.stringify(st));
  await page.keyboard.type('Tom arrives.');
  await sleep(300);
  const sum = await app(() => { const a = window.__app; return a.sceneRecord(a.scenes.filter((s) => s.kind === 'scene')[1])?.summary; });
  const all = await app(() => window.__app.scenes.filter((s) => s.kind === 'scene').map((s) => s.record?.summary ?? null));
  assert(sum === 'Tom arrives.', JSON.stringify(all) + ' ' + await app(() => document.activeElement?.outerHTML.slice(0, 80)));
  await app(() => window.__app.closePanel());
});

await check('History view: timeline, filter, scenes / all changes / pages', async () => {
  await app(async () => {
    const a = window.__app;
    const { saveTextAsDraft } = window.__drafts ?? {};
    void saveTextAsDraft;
  });
  // A named draft, then a change, then a snapshot.
  await app(() => window.__app.run('view.history'));
  await page.waitForSelector('.history-view');
  await page.click('.history-view .btn:has-text("Save as Draft")');
  await page.waitForSelector('.dialog input');
  await page.keyboard.type('Before the storm');
  await page.keyboard.press('Enter');
  await sleep(500);
  await app(() => window.__app.closePanel());
  await app(() => {
    const ed = window.__app.editor;
    const i = ed.lines.findIndex((l) => l.text.includes('Rain hammers'));
    ed.setSelection({ anchor: { line: i, ch: 0 }, head: { line: i, ch: 0 } });
    ed.insertText('Thunder. ');
  });
  await page.keyboard.press('Control+Shift+H');
  await page.waitForSelector('.history-view .hist-row');
  await page.click('.history-view .btn:has-text("Snapshot Now")');
  await sleep(500);
  const named = await page.locator('.hist-row').count();
  await page.click('.seg-btn[data-f="all"]');
  await sleep(100);
  const all = await page.locator('.hist-row').count();
  assert(all > named, `${named} → ${all}`);
  await page.click('.seg-btn[data-f="named"]');
  await page.locator('.hist-row:has-text("Before the storm")').click();
  await sleep(400);
  const summary = await page.textContent('.hist-summary');
  assert(/1 changed/.test(summary), summary);
  await page.screenshot({ path: path.join(os.tmpdir(), 'sw-r13-history-scenes.png') });
  await page.click('.hist-bar .seg-btn:has-text("All changes")');
  await sleep(300);
  assert((await page.locator('.hist-hunk').count()) === 1, 'hunks');
  assert((await page.locator('.hist-changes .pl.add').count()) === 1, 'no added line');
  assert(/unchanged line/.test(await page.textContent('.hist-changes')), 'no fold');
  await page.screenshot({ path: path.join(os.tmpdir(), 'sw-r13-history-changes.png') });
  await page.click('.hist-bar .seg-btn:has-text("Pages")');
  await page.waitForSelector('.hist-pages canvas', { timeout: 15000 });
  await sleep(600);
  await page.screenshot({ path: path.join(os.tmpdir(), 'sw-r13-history-pages.png') });
  // Pin keeps it on top
  await page.click('.hist-actions .btn:has-text("Pin")');
  await sleep(300);
  assert((await page.locator('.hist-group').first().textContent()).startsWith('Pinned'), 'not pinned');
  await page.keyboard.press('Escape');
  assert(await app(() => window.__app.panel === null), 'still open');
});

await check('notes pane History: recent versions open the History view', async () => {
  await app(() => window.__app.showRightTab('history'));
  await sleep(400);
  const n = await page.locator('.hist-mini').count();
  assert(n >= 2, String(n));
  await page.locator('.hist-mini').first().click();
  await page.waitForSelector('.history-view .hist-row.selected');
  await page.screenshot({ path: path.join(os.tmpdir(), 'sw-r13-history-open.png') });
  await page.keyboard.press('Escape');
});

console.log(results.map((r) => r.join(' — ')).join('\n'));
console.log('page errors:', JSON.stringify(h.errors.filter((e) => !e.includes('404'))));
await h.stop();
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
