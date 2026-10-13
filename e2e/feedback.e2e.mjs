// Checks for the second round of feedback.
import os from 'os';
import path from 'path';
import fs from 'fs';
import { startHarness, assert, sleep, root } from './util.mjs';

const h = await startHarness();
const { page } = h;
const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); await page.screenshot({ path: path.join(os.tmpdir(), `fb-fail-${results.length}.png`) }); }
}
const app = (fn, ...a) => page.evaluate(fn, ...a);
const lineIndex = (t) => app((t) => window.__app.editor.lines.findIndex((l) => l.text === t), t);

await check('minimal view shows the screenplay', async () => {
  await page.keyboard.press('Control+M');
  await sleep(100);
  const r = await app(() => ({ h: document.querySelector('.ed-scroller').getBoundingClientRect().height, lines: [...document.querySelectorAll('.ed-content .ln')].filter((e) => { const b = e.getBoundingClientRect(); return b.height > 0 && b.top < innerHeight && b.bottom > 0; }).length }));
  assert(r.h > 600 && r.lines > 10, JSON.stringify(r));
  await page.keyboard.press('Escape');
});

await check('Mod+F searches the screenplay, Mod+Shift+F searches scenes', async () => {
  await page.keyboard.press('Control+F');
  const a = await app(() => document.activeElement.getAttribute('aria-label'));
  assert(a === 'Search in screenplay', a);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Shift+F');
  const b = await app(() => document.activeElement.getAttribute('aria-label'));
  assert(b === 'Search scenes', b);
  await page.keyboard.press('Escape');
});

await check('Source is a tab (Mod+4) showing all operators', async () => {
  await page.keyboard.press('Control+4');
  const r = await app(() => [window.__app.view, document.querySelector('.tab.on').textContent, document.querySelector('.ed-content').textContent.includes('**please**')]);
  assert(r[0] === 'source' && r[1] === 'Source' && r[2], JSON.stringify(r));
  await page.keyboard.press('Control+1');
});

await check('automatic scene numbers on both sides, written numbers kept', async () => {
  const r = await app(() => [...document.querySelectorAll('.el-heading')].map((e) => [...e.querySelectorAll('.sn')].map((x) => x.className + ':' + x.textContent)));
  assert(JSON.stringify(r[0]) === JSON.stringify(['sn sn-l:1', 'sn sn-r:1']), JSON.stringify(r));
  assert(JSON.stringify(r[1]) === JSON.stringify(['sn sn-l:2', 'sn sn-r:2']), JSON.stringify(r));
  await app(() => { const a = window.__app; a.settings.editor.sceneNumbers = 'right'; a.applySettings(); });
  const r2 = await app(() => [...document.querySelectorAll('.el-heading')][1].querySelectorAll('.sn').length);
  assert(r2 === 1, String(r2));
  await app(() => { const a = window.__app; a.settings.editor.sceneNumbers = 'both'; a.applySettings(); });
});

await check('triple click selects the line text without the line break', async () => {
  const i = await lineIndex('One more night. Just one more.');
  await app((i) => window.__app.editor.scrollToLine(i, 'center'), i);
  await sleep(50);
  const r = await app((i) => { const ed = window.__app.editor; const v = ed.views.get(ed.lines[i].key).el.querySelector('span'); const b = v.getBoundingClientRect(); return { x: b.left + 20, y: b.top + b.height / 2 }; }, i);
  await page.mouse.click(r.x, r.y, { clickCount: 3 });
  const t = await app(() => window.__app.editor.selectedText());
  assert(t === 'One more night. Just one more.', JSON.stringify(t));
});

await check('Mod+R opens rename with possessive forms', async () => {
  await page.keyboard.press('Control+R');
  await page.waitForSelector('.dialog select[aria-label="Possessive forms"]');
  await page.keyboard.press('Escape');
});

await check('scene color swatch moves the selection ring and tints the outline row', async () => {
  await app(() => { const a = window.__app; a.goToScene(a.scenes.filter((s) => s.kind === 'scene')[0]); a.showRightTab('scene'); });
  await sleep(100);
  await page.click('.swatches button[title="Green"]');
  await page.click('.swatches button[title="Blue"]');
  const on = await page.locator('.swatches button.on').getAttribute('title');
  assert(on === 'Blue', on);
  const tinted = await page.locator('.outline .row.tinted').count();
  assert(tinted === 1, String(tinted));
});

await check('scene summary updates open scene cards immediately', async () => {
  await page.keyboard.press('Control+Shift+O');
  await page.waitForSelector('.card');
  await page.click('.rp-body textarea[aria-label="Scene summary"]');
  await page.keyboard.type('Storm arrives');
  await sleep(50);
  const t = await page.locator('.card').first().locator('.card-summary').textContent();
  assert(t === 'Storm arrives', t);
  const persisted = await app(() => window.__app.project.meta.scenes[0].summary);
  assert(persisted === 'Storm arrives', persisted);
  const len = await page.locator('.card .card-len').count();
  assert(len === 3, String(len));
  await page.keyboard.press('Escape');
  await app(() => window.__app.cards.close());
});

await check('page break markers appear in Script view when enabled', async () => {
  await app(() => { const a = window.__app; a.settings.editor.showPageBreaks = true; a.applySettings(); a.setView('script'); });
  // make the script long enough for several pages
  await app(() => { const ed = window.__app.editor; const n = ed.lines.length - 1; ed.setSelection({ anchor: { line: n, ch: ed.lines[n].text.length }, head: { line: n, ch: ed.lines[n].text.length } }); ed.insertText('\n\n' + Array.from({ length: 120 }, (_, i) => `Line of action number ${i}.`).join('\n\n')); });
  await sleep(600);
  const n = await app(() => window.__app.editor.pageMarkers.length);
  assert(n >= 3, String(n));
  await app(() => window.__app.editor.scrollToLine(window.__app.editor.lines.length - 1, 'top'));
  await sleep(100);
  const vis = await page.locator('.pb-mark').count();
  assert(vis >= 1, String(vis));
});

await check('settings command list fits without horizontal scrolling', async () => {
  await page.keyboard.press('Control+P');
  await page.click('.settings nav .row:has-text("Commands")');
  await sleep(100);
  const r = await app(() => { const c = document.querySelector('.settings .content'); return [c.scrollWidth, c.clientWidth]; });
  assert(r[0] <= r[1] + 1, JSON.stringify(r));
  await page.keyboard.press('Escape');
});

await check('export: dialogue only for one character, lines/characters settings, system title font', async () => {
  await page.keyboard.press('Control+E');
  await page.waitForSelector('.export-preview canvas', { timeout: 15000 });
  await page.selectOption('select[aria-label="What to export"]', 'dialogue');
  await page.selectOption('.export-side select[aria-label="Character"]', 'TOM');
  await sleep(1500);
  const info = await page.locator('.export-side .foot .muted').textContent();
  assert(/1 page/.test(info), info);
  const units = await page.locator('.export-side .ex-section >> nth=2').textContent();
  assert(units.includes('lines') && units.includes('characters'), units);
  const opts = await page.locator('select[aria-label="Title font"] optgroup').evaluateAll((g) => g.map((x) => x.label));
  assert(opts[0] === 'Courier' && opts[1] === 'System fonts', JSON.stringify(opts));
  await page.selectOption('select[aria-label="Title font"]', 'DejaVu Sans');
  await sleep(1500);
  const warn = await page.locator('.export-side .warnings').textContent();
  assert(!warn.includes('DejaVu Sans'), warn);
  await page.screenshot({ path: path.join(os.tmpdir(), 'sw-export2.png') });
  await page.keyboard.press('Escape');
});

console.log(results.map((r) => r.join(' — ')).join('\n'));
console.log('page errors:', JSON.stringify(h.errors.filter((e) => !e.includes('404'))));
await h.stop();
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
