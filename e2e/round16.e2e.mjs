// Round 16: acts in the scene list, scene archive, deselect in Cards, language.
import os from 'os';
import path from 'path';
import { startHarness, assert, sleep } from './util.mjs';

const h = await startHarness();
const { page } = h;
const results = [];
const shots = process.env.SHOTS;
async function check(name, fn) {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); await page.screenshot({ path: path.join(os.tmpdir(), `r16-fail-${results.length}.png`) }); }
}
const app = (fn, ...a) => page.evaluate(fn, ...a);
const text = () => app(() => window.__app.editor.getText());
const sceneCount = () => app(() => window.__app.scenes.filter((x) => x.kind === 'scene').length);
await page.setViewportSize({ width: 1400, height: 900 });

await check('acts show in the scene list and fold their scenes', async () => {
  await app(() => {
    const a = window.__app;
    const ed = a.editor;
    const sc = a.scenes.filter((x) => x.kind === 'scene');
    ed.edit((tx) => {
      const i2 = tx.lines.findIndex((l) => l.key === sc[1].key);
      tx.insertLines(i2, [{ key: 9e6 + 1, text: '# Act Two' }, { key: 9e6 + 2, text: '' }]);
      const i0 = tx.lines.findIndex((l) => l.key === sc[0].key);
      tx.insertLines(i0, [{ key: 9e6 + 3, text: '# Act One' }, { key: 9e6 + 4, text: '' }]);
      return ed.sel;
    });
    a.refreshDerived(true);
    a.outline.refresh();
  });
  await sleep(200);
  assert((await page.locator('.outline .act-row').count()) === 2, 'act rows');
  assert((await app(() => window.__app.scenes.filter((x) => x.kind === 'opening').length)) === 1, 'FADE IN opening kept');
  await page.locator('.outline .act-row', { hasText: 'Act Two' }).click();
  await sleep(150);
  const rows = await page.locator('.outline .row[data-id]').count();
  assert(rows === 3, `rows after folding: ${rows}`); // title, opening, scene 1
  await page.locator('.outline .act-row', { hasText: 'Act Two' }).click();
  await sleep(150);
  assert((await page.locator('.outline .row[data-id]').count()) === 5, 'unfold');
  if (shots) await page.screenshot({ path: path.join(shots, 'outline-acts.png'), clip: { x: 0, y: 0, width: 300, height: 500 } });
});

await check('a scene moves to the archive and comes back with one undo each', async () => {
  const n = await sceneCount();
  const before = await text();
  await app(() => { const a = window.__app; const it = a.scenes.filter((x) => x.kind === 'scene')[1]; a.updateSceneRecord(it, { summary: 'Tom arrives.' }); });
  await page.locator('.outline .row[data-id]').nth(3).click({ button: 'right' });
  await page.locator('.menu [role="menuitem"]:has-text("Move to Archive")').click();
  await sleep(300);
  assert((await sceneCount()) === n - 1, 'not removed');
  assert((await app(() => window.__app.project.meta.sceneArchive.length)) === 1, 'not archived');
  assert((await page.locator('.outline .archive-head').count()) === 1, 'no archive group');
  await app(() => window.__app.editor.focus());
  await page.keyboard.press('Control+Z');
  await sleep(200);
  assert((await sceneCount()) === n, 'undo did not bring it back');
  assert((await app(() => window.__app.project.meta.sceneArchive.length)) === 0, 'undo left it archived');
  await page.keyboard.press('Control+Y');
  await sleep(200);
  assert((await sceneCount()) === n - 1, 'redo');
  // Put back where it was.
  await page.locator('.outline .archive-head').click();
  await sleep(150);
  await page.locator('.outline .row.archived').first().click();
  await sleep(200);
  if (shots) await page.screenshot({ path: path.join(shots, 'archive-dialog.png') });
  await page.locator('.dialog .btn:has-text("Put back where it was")').click();
  await sleep(300);
  assert((await sceneCount()) === n, 'not restored');
  const back = await app(() => { const a = window.__app; const it = a.scenes.filter((x) => x.kind === 'scene')[1]; return [it.heading, it.record?.summary]; });
  assert(back[1] === 'Tom arrives.', `summary lost: ${back}`);
  const after = await text();
  const strip = (t) => t.replace(/\n{3,}/g, '\n\n').trim();
  assert(strip(after) === strip(before), 'text differs after putting back');
});

await check('a click on empty space in Cards clears the selection', async () => {
  await app(() => window.__app.openPanel('cards'));
  await sleep(300);
  await page.locator('.cards-grid .card').first().click();
  assert((await app(() => window.__app.sceneSel.size)) === 1, 'not selected');
  const g = await page.locator('.cards-grid').boundingBox();
  await page.mouse.click(g.x + g.width - 20, g.y + g.height - 20);
  await sleep(100);
  assert((await app(() => window.__app.sceneSel.size)) === 0, 'still selected');
  await app(() => window.__app.closePanel());
});

console.log(results.map((r) => r.join(' — ')).join('\n'));
console.log('page errors:', JSON.stringify(h.errors.filter((e) => !e.includes('404'))));
await h.stop();
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
