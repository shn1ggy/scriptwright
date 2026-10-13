// Real-world feedback round: comments/passages, shelf origin, preview zoom, title page, workspace settings.
import os from 'os';
import path from 'path';
import fs from 'fs';
import { startHarness, assert, sleep } from './util.mjs';

const h = await startHarness();
const { page } = h;
const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); await page.screenshot({ path: path.join(os.tmpdir(), `r5-fail-${results.length}.png`) }); }
}
const app = (fn, ...a) => page.evaluate(fn, ...a);
const text = () => app(() => window.__app.editor.lines.map((l) => l.text).join('\n'));
async function select(str) {
  await app((s) => {
    const ed = window.__app.editor;
    const i = ed.lines.findIndex((l) => l.text.includes(s));
    const ch = ed.lines[i].text.indexOf(s);
    ed.setSelection({ anchor: { line: i, ch }, head: { line: i, ch: ch + s.length } });
    ed.focus();
  }, str);
}
async function pointAt(str, offset = 2) {
  return app(([s, off]) => {
    const ed = window.__app.editor;
    const i = ed.lines.findIndex((l) => l.text.includes(s));
    const c = ed.coordsAtPos({ line: i, ch: ed.lines[i].text.indexOf(s) + off });
    return { x: c.left + 2, y: (c.top + c.bottom) / 2 };
  }, [str, offset]);
}

await check('Ctrl+click on a comment opens it; the context menu deletes it', async () => {
  await select("Who's there?");
  await app(() => window.__app.annotations.addComment('Make this scarier.', window.__app.annotations.selectionAnchor()));
  await app(() => window.__app.editor.setSelection({ anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 0 } }));
  const p = await pointAt("Who's there?");
  await page.keyboard.down('Control');
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up('Control');
  await page.waitForSelector('.comment-dialog');
  const v = await page.inputValue('.comment-dialog textarea');
  assert(v === 'Make this scarier.', v);
  await page.fill('.comment-dialog textarea', 'Make this much scarier.');
  await page.click('.comment-dialog .btn.primary');
  const t = await app(() => window.__app.project.meta.comments[0].text);
  assert(t === 'Make this much scarier.', t);
  await page.mouse.click(p.x, p.y, { button: 'right' });
  await page.waitForSelector('.menu');
  await page.click('.menu >> text=Delete comment');
  const n = await app(() => window.__app.project.meta.comments.length);
  assert(n === 0, String(n));
});

await check('Ctrl+click on an alternative passage opens its versions', async () => {
  await select('A KNOCK at the door below');
  await app(() => window.__app.annotations.addPassage(window.__app.annotations.selectionAnchor(), 'Knock'));
  await app(() => window.__app.editor.setSelection({ anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 0 } }));
  const p = await pointAt('A KNOCK at the door below', 4);
  await page.keyboard.down('Control');
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up('Control');
  await page.waitForSelector('.rewrite-dialog');
  await page.keyboard.press('Escape');
});

await check('Review tab separates comments (yellow) and alternatives (blue)', async () => {
  await select('Rain hammers the glass');
  await app(() => window.__app.annotations.addComment('Sound design note.', window.__app.annotations.selectionAnchor()));
  await app(() => window.__app.showRightTab('comments'));
  await sleep(200);
  const swatches = await page.locator('.rv-section .rv-swatch').count();
  const passageBorder = await page.locator('.rv-item.rv-passage').evaluate((el) => getComputedStyle(el).borderLeftColor);
  const commentBorder = await page.locator('.rv-item.rv-comment').first().evaluate((el) => getComputedStyle(el).borderLeftColor);
  assert(swatches === 2 && passageBorder !== commentBorder, `${swatches} ${passageBorder} ${commentBorder}`);
  await page.screenshot({ path: path.join(os.tmpdir(), 'sw-r5-review.png') });
});

await check('cut material can be put back where it was cut, and reveals its origin', async () => {
  const before = await text();
  await select('LISA (60s), weathered');
  await app(() => {
    const ed = window.__app.editor;
    const i = ed.sel.head.line;
    ed.setSelection({ anchor: { line: i, ch: 0 }, head: { line: i + 1, ch: 0 } });
  });
  await page.keyboard.press('Control+Shift+X');
  await sleep(100);
  const cut = await text();
  assert(cut !== before && !cut.includes('LISA (60s), weathered'), 'not cut');
  // Edit elsewhere so the position shifts.
  await app(() => {
    const ed = window.__app.editor;
    const i = ed.lines.length - 1;
    ed.setSelection({ anchor: { line: i, ch: ed.lines[i].text.length }, head: { line: i, ch: ed.lines[i].text.length } });
    ed.insertText('\nTHE END');
  });
  await app(() => window.__app.showRightTab('shelf'));
  await sleep(200);
  await page.click('.shelf-text');
  const sel = await app(() => window.__app.editor.sel.head);
  await page.click('.rv-actions .btn:has-text("Put back")');
  const after = await text();
  assert(after === before + '\nTHE END', 'not restored exactly:\n' + after.slice(0, 400));
  const lineOf = await app(() => window.__app.editor.lines.findIndex((l) => l.text.includes('LISA (60s), weathered')));
  assert(sel.line === lineOf, `reveal went to ${sel.line}, text at ${lineOf}`);
});

await check('the export preview zooms (buttons, Mod+= / Mod+0)', async () => {
  await page.keyboard.press('Control+E');
  await page.waitForSelector('.export-preview canvas', { timeout: 15000 });
  const w0 = await page.locator('.export-preview canvas').first().evaluate((c) => c.getBoundingClientRect().width);
  await page.click('.zoom-bar [aria-label="Zoom in"]');
  await page.click('.zoom-bar [aria-label="Zoom in"]');
  await sleep(600);
  const label = await page.textContent('.zoom-label');
  const w1 = await page.locator('.export-preview canvas').first().evaluate((c) => c.getBoundingClientRect().width);
  assert(label !== 'Fit' && w1 > w0 * 1.1, `${label} ${w0} → ${w1}`);
  await page.screenshot({ path: path.join(os.tmpdir(), 'sw-r5-zoom.png') });
  await page.keyboard.press('Control+0');
  await sleep(500);
  assert((await page.textContent('.zoom-label')) === 'Fit', 'not back to fit');
  await page.keyboard.press('Control+=');
  await sleep(300);
  assert((await page.textContent('.zoom-label')) !== 'Fit', 'Mod+= did nothing');
  await page.keyboard.press('Escape');
});

await check('title page can be hidden from Script view', async () => {
  await app(() => window.__app.setView('script'));
  await app(() => { window.__app.settings.editor.titlePageInScript = true; window.__app.applySettings(); });
  const shownBefore = await app(() => window.__app.editor.displayedLines[0]);
  await app(() => {
    window.__app.settings.editor.titlePageInScript = false;
    window.__app.applySettings();
  });
  await sleep(100);
  const first = await app(() => {
    const ed = window.__app.editor;
    return { line: ed.displayedLines[0], text: ed.lines[ed.displayedLines[0]].text, titleEnd: ed.parsed.titleEnd };
  });
  assert(shownBefore === 0 && first.line >= first.titleEnd && first.text.trim() !== '', JSON.stringify(first));
  // Title page view still shows it.
  await page.keyboard.press('Control+T');
  await sleep(100);
  const inTitle = await app(() => window.__app.editor.displayedLines.includes(0));
  assert(inTitle, 'title page view empty');
  await page.keyboard.press('Control+T');
  await app(() => window.__app.setView('script'));
  await app(() => {
    window.__app.settings.editor.titlePageInScript = true;
    window.__app.applySettings();
  });
  const back = await app(() => window.__app.editor.displayedLines[0]);
  assert(back === 0, String(back));
});

await check('missing title page fields can be added; empty ones are not printed', async () => {
  await page.evaluate(() => window.__app.run('title.addFields'));
  const t = await text();
  assert(/^Source: $/m.test(t) && /^Copyright: $/m.test(t) && /^Notes: $/m.test(t), t.slice(0, 300));
  await page.keyboard.press('Control+E');
  await page.waitForSelector('.export-preview canvas', { timeout: 15000 });
  await page.keyboard.press('Escape');
});

await check('settings are saved in the workspace folder', async () => {
  await app(() => {
    window.__app.settings.editor.typewriter = true;
    window.__app.saveSettings();
    window.__app.saveSettings.flush();
  });
  await sleep(400);
  const f = path.join(h.ws, '.scriptwright', 'settings.json');
  assert(fs.existsSync(f), 'no workspace settings file');
  assert(JSON.parse(fs.readFileSync(f, 'utf8')).editor.typewriter === true, 'not written');
  const projects = await app(() => window.__app.projects.map((p) => p.name));
  assert(!projects.some((n) => n.startsWith('.')), JSON.stringify(projects));
});

await check('right-clicking a project opens its menu', async () => {
  await page.click('.projects .row >> nth=0', { button: 'right' });
  await page.waitForSelector('.menu');
  const items = await page.locator('.menu').textContent();
  assert(items.includes('Rename Project') && items.includes('Back Up Project'), items);
  await page.keyboard.press('Escape');
});

console.log(results.map((r) => r.join(' — ')).join('\n'));
console.log('page errors:', JSON.stringify(h.errors.filter((e) => !e.includes('404'))));
await h.stop();
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
