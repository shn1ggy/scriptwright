// Feedback round 12: focus open, passages without names, locked scene numbers, Final Draft.
import os from 'os';
import fs from 'fs';
import path from 'path';
import { startHarness, assert, sleep } from './util.mjs';

const h = await startHarness();
const { page } = h;
const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); await page.screenshot({ path: path.join(os.tmpdir(), `r12-fail-${results.length}.png`) }); }
}
const app = (fn, ...a) => page.evaluate(fn, ...a);

await check('double-clicking a tab opens it with both panes hidden', async () => {
  await app(() => { const a = window.__app; a.state.layout.leftVisible = true; a.state.layout.rightVisible = true; a.applyLayout(); });
  await page.dblclick('.viewbar .tab:has-text("Scene")');
  await sleep(150);
  const st = await app(() => ({ v: window.__app.view, l: window.__app.state.layout.leftVisible, r: window.__app.state.layout.rightVisible }));
  assert(st.v === 'scene' && !st.l && !st.r, JSON.stringify(st));
  await page.dblclick('.viewbar .tab:has-text("Cards")');
  await sleep(150);
  assert(await app(() => window.__app.panel === 'cards'), 'cards not open');
  await page.click('.viewbar .tab:has-text("Script")');
  await app(() => { const a = window.__app; a.state.layout.leftVisible = true; a.applyLayout(); });
});

await check('scene menu has no "Clear selection"; Projects shows a collapse mark', async () => {
  await page.locator('.outline .row:not(.title-row)').first().click({ button: 'right' });
  await sleep(150);
  const labels = await page.locator('.menu .menu-item').allTextContents();
  assert(!labels.some((l) => /Clear selection/.test(l)) && labels.some((l) => /No color/.test(l)), JSON.stringify(labels));
  await page.keyboard.press('Escape');
  assert(await page.isVisible('.projects .collapse-mark svg'), 'no mark');
  await page.click('.projects .collapser');
  assert(await page.isHidden('.projects .list'), 'did not collapse');
  await page.click('.projects .collapser');
});

await check('a new passage has no name; the Review list shows its current text', async () => {
  await app(() => {
    const a = window.__app;
    const ed = a.editor;
    const i = ed.lines.findIndex((l) => l.text.includes('Rain hammers'));
    ed.setSelection({ anchor: { line: i, ch: 0 }, head: { line: i, ch: 11 } });
  });
  await app(() => window.__app.run('edit.rewrite'));
  await page.waitForSelector('.rewrite-dialog');
  assert((await page.locator('.rewrite-dialog input[aria-label="Passage name"]').count()) === 0, 'name field still there');
  await page.keyboard.press('Escape');
  await app(() => window.__app.showRightTab('comments'));
  await sleep(200);
  const q = await page.locator('.rv-passage .rv-quote').first().textContent();
  assert(q.startsWith('“Rain hammer'), q);
  assert((await app(() => window.__app.project.meta.passages[0].name)) === '', 'has a name');
});

await check('locking numbers writes them; new scenes take letters; removed scenes stay omitted', async () => {
  await app(() => window.__app.run('scene.lockNumbers'));
  await sleep(150);
  const heads = await app(() => window.__app.editor.parsed.scenes.map((s) => s.sceneNumber));
  assert(heads.every(Boolean) && heads[0] === '1', JSON.stringify(heads));
  assert(await page.isVisible('.outline .lock-mark'), 'no lock mark');
  await app(() => {
    const a = window.__app;
    a.enterScene(a.scenes.filter((s) => s.kind === 'scene')[0]);
    a.setView('script');
    a.run('scene.new');
  });
  await sleep(200);
  const nums = await app(() => window.__app.scenes.filter((s) => s.kind === 'scene').map((s) => s.number));
  assert(nums[0] === '1' && nums[1] === '1A' && nums[2] === '2', JSON.stringify(nums));
  // Remove scene 2: it stays as omitted.
  await app(() => { const a = window.__app; void a.deleteScene(a.scenes.filter((s) => s.kind === 'scene')[2]); });
  await page.waitForSelector('.dialog .btn.danger');
  await app(() => document.querySelector('.dialog .btn.danger').click());
  await sleep(200);
  const after = await app(() => window.__app.scenes.filter((s) => s.kind === 'scene').map((s) => `${s.number} ${s.heading}`));
  assert(after[2] === '2 OMITTED', JSON.stringify(after));
  await app(() => { void window.__app.unlockSceneNumbers(); });
  await page.waitForSelector('.dialog .btn.primary');
  await app(() => document.querySelector('.dialog .btn.primary').click());
  await sleep(200);
  const un = await app(() => ({ locked: window.__app.editor.parsed.scenes.some((s) => s.sceneNumber), omitted: window.__app.scenes.some((s) => s.heading === 'OMITTED') }));
  assert(!un.locked && !un.omitted, JSON.stringify(un));
});

await check('Final Draft export and import', async () => {
  const file = path.join(h.tmp, 'out.fdx');
  await h.queueDialog(file);
  await app(() => window.__app.run('project.exportFdx'));
  await sleep(800);
  const xml = fs.readFileSync(file, 'utf8');
  assert(/<FinalDraft/.test(xml) && /Type="Scene Heading"/.test(xml), xml.slice(0, 200));
  await h.queueDialog(file);
  await app(() => window.__app.run('project.importFountain'));
  await sleep(1500);
  const name = await app(() => window.__app.project.name);
  const n = await app(() => window.__app.editor.parsed.scenes.length);
  assert(/^out/.test(name) && n > 2, `${name} ${n}`);
});

console.log(results.map((r) => r.join(' — ')).join('\n'));
console.log('page errors:', JSON.stringify(h.errors.filter((e) => !e.includes('404'))));
await h.stop();
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
