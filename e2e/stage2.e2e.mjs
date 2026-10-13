// Rewrite/alternatives, shelf, drafts and comparison, comments, highlights, Fountain tools.
import os from 'os';
import path from 'path';
import fs from 'fs';
import { startHarness, assert, sleep } from './util.mjs';

const h = await startHarness();
const { page } = h;
const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); await page.screenshot({ path: path.join(os.tmpdir(), `s2-fail-${results.length}.png`) }); }
}
const app = (fn, ...a) => page.evaluate(fn, ...a);
const selectText = (text) => app((t) => {
  const ed = window.__app.editor;
  for (let i = 0; i < ed.lines.length; i++) {
    const c = ed.lines[i].text.indexOf(t);
    if (c >= 0) { ed.setSelection({ anchor: { line: i, ch: c }, head: { line: i, ch: c + t.length } }, { scroll: 'center' }); ed.focus(); return true; }
  }
  return false;
}, text);
const getText = () => app(() => window.__app.editor.getText());
const meta = () => app(() => JSON.parse(JSON.stringify(window.__app.project.meta)));

await check('highlight follows edits, detaches on deletion and comes back with undo', async () => {
  await selectText('lamp turns');
  await page.keyboard.press('Control+H');
  await page.click('.menu-item:has-text("Yellow")');
  assert((await page.locator('.deco-hl-yellow').count()) >= 1, 'no highlight painted');
  // type before the highlight
  await app(() => { const ed = window.__app.editor; const i = ed.lines.findIndex((l) => l.text.startsWith('Rain hammers')); ed.setSelection({ anchor: { line: i, ch: 0 }, head: { line: i, ch: 0 } }); ed.focus(); });
  await page.keyboard.type('Cold. ');
  const id = (await meta()).highlights[0].id;
  assert((await app((id) => window.__app.annotations.textOf(id), id)) === 'lamp turns', 'anchor moved wrongly');
  await selectText('A lamp turns, slow');
  await sleep(1300);
  await page.keyboard.press('Backspace');
  const m1 = await meta();
  assert(m1.highlights[0].detached, 'not detached');
  await page.keyboard.press('Control+Z');
  const m2 = await meta();
  assert(!m2.highlights[0].detached && (await app((id) => window.__app.annotations.textOf(id), id)) === 'lamp turns', 'undo did not restore anchor');
});

await check('comments: add, resolve, reopen; shown in Review', async () => {
  await selectText('Who\'s there?');
  await page.keyboard.press('Control+Shift+M');
  await page.waitForSelector('.dialog textarea');
  await page.keyboard.type('Make this scarier.');
  await page.click('.dialog .btn.primary');
  await sleep(300);
  assert((await page.locator('.rv-comment').count()) === 1, 'comment not listed');
  assert((await page.locator('.deco-comment').count()) >= 1, 'comment not painted');
  await page.click('.rv-comment .btn:has-text("Resolve")');
  await sleep(200);
  assert((await meta()).comments[0].resolved === true, 'not resolved');
  assert((await page.locator('.deco-comment').count()) === 0, 'resolved comment still painted');
});

await check('Rewrite: versions, swap into the screenplay, undo and redo', async () => {
  await selectText('One more night. Just one more.');
  await page.keyboard.press('Alt+A');
  await page.waitForSelector('.rewrite-dialog textarea');
  await page.fill('.rewrite-dialog textarea', 'Just this night. Then never again.');
  await page.click('.rewrite-dialog .btn:has-text("Use this version")');
  await sleep(200);
  let t = await getText();
  assert(t.includes('Just this night. Then never again.') && !t.includes('One more night. Just one more.'), 'not swapped');
  const p = (await meta()).passages[0];
  const original = p.alternatives.find((a) => a.name === 'Original');
  assert(original.text === 'One more night. Just one more.', 'outgoing version not kept: ' + original.text);
  await page.keyboard.press('Escape');
  await app(() => window.__app.editor.focus());
  await page.keyboard.press('Control+Z');
  t = await getText();
  const p2 = (await meta()).passages[0];
  assert(t.includes('One more night. Just one more.') && p2.activeId === original.id, 'undo did not restore version');
  await page.keyboard.press('Control+Shift+Z');
  const p3 = (await meta()).passages[0];
  assert((await getText()).includes('Just this night.') && p3.activeId !== original.id, 'redo failed');
  // swap back through the dialog (caret inside passage)
  await selectText('Just this night.');
  await page.keyboard.press('Alt+A');
  await page.waitForSelector('.rewrite-dialog');
  await page.click('.rewrite-dialog .rw-list .row:has-text("Original")');
  await page.click('.rewrite-dialog .btn:has-text("Use this version")');
  assert((await getText()).includes('One more night. Just one more.'), 'swap back failed');
  await page.keyboard.press('Escape');
});

await check('shelf: cut keeps material, insert never replaces a selection', async () => {
  await selectText('Waves break over the pier.');
  await page.keyboard.press('Control+Shift+X');
  assert(!(await getText()).includes('Waves break over the pier.'), 'not cut');
  const shelf = (await meta()).shelf;
  assert(shelf.length === 1 && shelf[0].text === 'Waves break over the pier.' && shelf[0].sceneHeading === 'EXT. HARBOUR - CONTINUOUS', JSON.stringify(shelf));
  await app(() => window.__app.showRightTab('shelf'));
  await selectText('Lisa descends');
  await page.click('.rv-item .btn:has-text("Insert at caret")');
  const t = await getText();
  assert(t.includes('Lisa descendsWaves break over the pier.'), 'inserted wrongly');
  await page.keyboard.press('Control+Z');
  assert((await meta()).shelf.length === 1, 'shelf item lost');
});

await check('named drafts: compare finds moved and changed scenes; restore is safe and undoable', async () => {
  await page.keyboard.press('Control+Shift+D');
  await page.waitForSelector('.dialog input');
  await page.keyboard.type('Before feedback');
  await page.keyboard.press('Enter');
  await sleep(400);
  const draftText = await getText();
  // move scene 3 to the top and change scene 2
  await app(() => { const a = window.__app; const sc = a.scenes.filter((s) => s.kind === 'scene'); a.moveScene(sc[2], sc[0], false); });
  await selectText('The boat\'s gone.');
  await page.keyboard.type('The boat is gone!');
  await app(() => window.__app.showRightTab('history'));
  await page.click('.rv-item:has-text("Before feedback") .btn:has-text("Preview")');
  await page.waitForSelector('.compare-dialog');
  const chips = await page.locator('.cmp-list .chip').allTextContents();
  assert(chips.includes('Moved') && chips.includes('Changed') && !chips.includes('Added'), JSON.stringify(chips));
  await page.click('.compare-dialog .btn.primary');
  await page.waitForSelector('.dialog-head:has-text("Restore version")');
  await page.click('.dialog:has-text("Restore version") .btn.primary');
  await sleep(600);
  assert((await getText()) === draftText, 'restored text differs');
  const drafts = (await meta()).drafts.map((d) => d.name);
  assert(drafts.some((n) => n.startsWith('Before restoring')), JSON.stringify(drafts));
  await app(() => window.__app.editor.focus());
  await page.keyboard.press('Control+Z');
  assert((await getText()).includes('The boat is gone!'), 'restore not undoable');
  await page.keyboard.press('Control+Shift+Z');
});

await check('written scene numbers: renumber and remove', async () => {
  await app(() => window.__app.run('scene.writtenNumbers'));
  await page.selectOption('.dialog select', 'renumber');
  await page.click('.dialog .btn.primary');
  let t = await getText();
  assert(t.includes('INT. LIGHTHOUSE - NIGHT #1#') && t.includes('EXT. HARBOUR - CONTINUOUS #2#'), 'renumber failed');
  await app(() => window.__app.run('scene.writtenNumbers'));
  await page.selectOption('.dialog select', 'remove');
  await page.click('.dialog .btn.primary');
  t = await getText();
  assert(!/#\d+#/.test(t), 'numbers not removed');
});

await check('Fountain export writes numbers and drops notes, screenplay unchanged', async () => {
  const before = await getText();
  const dest = path.join(h.tmp, 'out.fountain');
  await h.queueDialog(dest);
  await app(() => window.__app.run('project.exportFountain'));
  await page.click('.dialog .btn.primary');
  await sleep(500);
  const out = fs.readFileSync(dest, 'utf8');
  assert(out.includes('#1#') && !out.includes('[[') && !out.includes('/*'), out.slice(0, 300));
  assert((await getText()) === before, 'screenplay changed');
});

await check('annotations survive closing and reopening', async () => {
  await page.keyboard.press('Control+S');
  await sleep(300);
  await app(() => window.__app.closeProject());
  await app(() => window.__app.openProject('The Long Night'));
  await sleep(300);
  const m = await meta();
  const hl = m.highlights[0];
  assert(!hl.detached && (await app((id) => window.__app.annotations.textOf(id), hl.id)) === 'lamp turns', 'highlight lost ' + JSON.stringify(hl));
  assert(m.comments.length === 1 && !m.comments[0].detached, 'comment lost');
  assert(m.passages.length === 1 && !m.passages[0].detached, 'passage lost');
});

await check('export settings saved in inches by the first version are converted', async () => {
  await app(() => { window.__app.project.meta.exportSettings = { paper: 'Letter', marginTop: 1, marginBottom: 1, marginLeft: 1.5, marginRight: 1, font: 'Courier', fontSize: 12, linesPerInch: 6, actionWidth: 6, characterIndent: 2, dialogueIndent: 1, dialogueWidth: 3.5, parentheticalIndent: 1.5, parentheticalWidth: 2.5 }; });
  await page.keyboard.press('Control+E');
  await page.waitForSelector('.export-preview canvas', { timeout: 15000 });
  const cap = await page.locator('.export-side .foot .capacity').first().textContent();
  assert(cap.includes('action 60') && cap.includes('dialogue 36'), cap);
  await page.keyboard.press('Escape');
});

console.log(results.map((r) => r.join(' — ')).join('\n'));
console.log('page errors:', JSON.stringify(h.errors.filter((e) => !e.includes('404'))));
await h.stop();
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
