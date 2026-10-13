// Feedback round 6: several scenes at once, Cards/Characters tabs, preset overwrite, title tracking, pane widths.
import os from 'os';
import path from 'path';
import fs from 'fs';
import zlib from 'zlib';
import { startHarness, assert, sleep } from './util.mjs';

const h = await startHarness();
const { page } = h;
const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); await page.screenshot({ path: path.join(os.tmpdir(), `r6-fail-${results.length}.png`) }); }
}
const app = (fn, ...a) => page.evaluate(fn, ...a);
const order = () => app(() => window.__app.scenes.filter((s) => s.kind === 'scene').map((s) => s.heading));

await check('tabs: Script, Scene, Cards, Dialogue, Characters, Source', async () => {
  const tabs = await page.locator('.viewbar .tab').allTextContents();
  assert(JSON.stringify(tabs) === JSON.stringify(['Script', 'Scene', 'Cards', 'Dialogue', 'Characters', 'Source']), JSON.stringify(tabs));
  await page.keyboard.press('Control+3');
  await page.waitForSelector('.cards:not(.hidden)');
  assert((await page.textContent('.viewbar .tab.on')) === 'Cards', 'Cards tab not active');
  await page.click('.viewbar .tab:text-is("Script")');
  assert(await page.isHidden('.cards'), 'cards still shown');
  await page.keyboard.press('Control+6');
  assert((await app(() => window.__app.view)) === 'source', 'Mod+6 is not Source');
  await page.keyboard.press('Control+1');
});

await check('outline: Cmd/Ctrl-click selects several scenes; color and status for all', async () => {
  const rows = page.locator('.outline .row:not(.title-row)');
  await rows.nth(0).click();
  await rows.nth(2).click({ modifiers: ['Control'] });
  const sel = await app(() => [...window.__app.sceneSel].length);
  assert(sel === 2, String(sel));
  await rows.nth(2).click({ button: 'right' });
  await page.waitForSelector('.menu');
  const head = await page.locator('.menu .menu-head').first().textContent();
  assert(head === '2 scenes selected', head);
  await page.click('.menu >> text=Green');
  await rows.nth(2).click({ button: 'right' });
  await page.click('.menu >> text=Done');
  const recs = await app(() => window.__app.scenes.filter((s) => s.kind === 'scene').map((s) => [s.record?.color ?? '', s.record?.status ?? '']));
  assert(recs[0][0] === '#7FC48D' && recs[2][0] === '#7FC48D' && recs[1][0] === '' && recs[0][1] === 'done' && recs[2][1] === 'done', JSON.stringify(recs));
});

await check('several scenes move together (keyboard), as one undo step', async () => {
  const before = await order();
  // Scenes 1 and 3 are selected: move them down → they gather after scene 2... and beyond.
  await page.locator('.outline .list').focus();
  await page.keyboard.press('Alt+Shift+ArrowDown');
  const after = await order();
  assert(after.length === before.length && after[0] === before[1] && after[1] === before[0] && after[2] === before[2], JSON.stringify(after));
  await page.keyboard.press('Control+Z');
  await app(() => window.__app.editor.focus());
  await page.keyboard.press('Control+Z');
  const undone = await order();
  assert(JSON.stringify(undone) === JSON.stringify(before), JSON.stringify(undone));
});

await check('cards: Shift-click selects a range; drag moves the group', async () => {
  await page.keyboard.press('Control+3');
  await page.waitForSelector('.cards:not(.hidden) .card');
  const before = await order();
  const cards = page.locator('.cards .card');
  await cards.nth(0).click();
  await cards.nth(1).click({ modifiers: ['Shift'] });
  const n = await page.locator('.cards .card.selected').count();
  assert(n === 2, String(n));
  await cards.nth(0).dragTo(cards.nth(2), { targetPosition: { x: 200, y: 20 } });
  await sleep(200);
  const after = await order();
  assert(JSON.stringify(after) === JSON.stringify([before[2], before[0], before[1]]), JSON.stringify(after));
  await page.screenshot({ path: path.join(os.tmpdir(), 'sw-r6-cards.png') });
  await page.keyboard.press('Escape');
  assert(await page.isHidden('.cards'), 'Escape did not leave cards');
});

await check('Characters view: speeches, words, scenes, detail and Show dialogue', async () => {
  await page.click('.viewbar .tab:text-is("Characters")');
  await page.waitForSelector('.characters:not(.hidden) .ch-row:not(.ch-header)');
  const names = await page.locator('.ch-row:not(.ch-header) .ch-name').allTextContents();
  assert(names.includes('LISA') && names.includes('TOM'), JSON.stringify(names));
  const first = names[0];
  await page.locator(`.ch-row:not(.ch-header) .ch-name:text-is("${first}")`).click();
  const facts = await page.locator('.ch-facts').textContent();
  assert(/Speeches\d+/.test(facts) && /Speaks in\d+ of \d+ scenes/.test(facts), facts);
  await page.screenshot({ path: path.join(os.tmpdir(), 'sw-r6-characters.png') });
  await page.click('.ch-actions .btn:has-text("Show dialogue")');
  const st = await app(() => [window.__app.view, window.__app.dialogueCharacter, window.__app.panel]);
  assert(st[0] === 'dialogue' && st[1] === first && st[2] === null, JSON.stringify(st));
  await page.keyboard.press('Control+1');
});

await check('saving a preset under an existing name asks before replacing', async () => {
  await page.keyboard.press('Control+E');
  await page.waitForSelector('.export-preview canvas', { timeout: 15000 });
  for (let k = 0; k < 2; k++) {
    await page.click('.export-head .btn:has-text("Save as preset")');
    await page.waitForSelector('.dialog input');
    await page.fill('.dialog input', 'Mine');
    await page.click('.dialog .btn.primary');
    await sleep(150);
  }
  const ask = await page.locator('.dialog[aria-label="Replace preset"]').count();
  assert(ask === 1, 'no replace question');
  await page.click('.dialog[aria-label="Replace preset"] .btn.primary');
  await sleep(100);
});

await check('title letter spacing is written to the PDF', async () => {
  await page.fill('input[aria-label="Letter spacing"]', '50').catch(async () => {
    const inp = page.locator('.form-row:has-text("Letter spacing") input');
    await inp.fill('50');
  });
  await page.locator('.form-row:has-text("Letter spacing") input').press('Tab');
  await sleep(1200);
  await h.queueDialog(path.join(h.tmp, 'tracked.pdf'));
  await page.click('.export-side .btn.primary');
  await sleep(1200);
  const buf = fs.readFileSync(path.join(h.tmp, 'tracked.pdf'));
  const raw = buf.toString('latin1');
  let content = '';
  const re = /stream\n/g;
  let m;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    try { content += zlib.inflateSync(buf.subarray(start, end)).toString('latin1'); } catch {}
  }
  assert(/ 6 Tc /.test(content), 'no Tc operator for 50% of 12 pt');
  await page.keyboard.press('Escape');
});

await check('panes keep a minimum width; tab labels stay on one line', async () => {
  await app(() => {
    const a = window.__app;
    a.state.layout.leftWidth = 100;
    a.state.layout.rightWidth = 100;
    a.state.layout.rightVisible = true;
    a.applyLayout();
  });
  const w = await app(() => [document.querySelector('.pane-left').getBoundingClientRect().width, document.querySelector('.pane-right').getBoundingClientRect().width]);
  assert(w[0] >= 220 && w[1] >= 310, JSON.stringify(w));
  const heights = await page.locator('.rp-tabs .tab').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  assert(heights.every((x) => x <= 31), JSON.stringify(heights));
});

console.log(results.map((r) => r.join(' — ')).join('\n'));
console.log('page errors:', JSON.stringify(h.errors.filter((e) => !e.includes('404'))));
await h.stop();
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
