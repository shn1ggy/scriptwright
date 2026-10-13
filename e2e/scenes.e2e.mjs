// Scene organization: insertion, reordering (drag and keyboard), identity of scene information.
import { startHarness, assert, sleep } from './util.mjs';
import fs from 'fs';
import path from 'path';

const h = await startHarness();
const { page } = h;
const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(['PASS', name]);
  } catch (e) {
    results.push(['FAIL', name, e.message]);
    await page.screenshot({ path: `/tmp/claude-0/-home-claude/14b80900-66cb-5798-b9ca-df392d53185c/scratchpad/scenes-fail-${results.length}.png` });
  }
}
const app = (fn, ...a) => page.evaluate(fn, ...a);
const headings = () => app(() => window.__app.scenes.filter((s) => s.kind === 'scene').map((s) => s.heading));
const goScene = (n) => app((n) => { const a = window.__app; a.goToScene(a.scenes.filter((s) => s.kind === 'scene')[n]); }, n);

await check('new scene is inserted directly after the active scene', async () => {
  await goScene(0);
  await page.keyboard.press('Control+N');
  const hs = await headings();
  assert(hs[1] === 'INT. LOCATION - DAY', JSON.stringify(hs));
  assert(hs[0] === 'INT. LIGHTHOUSE - NIGHT' && hs[2] === 'EXT. HARBOUR - CONTINUOUS', JSON.stringify(hs));
  // The location part is selected for typing over
  await page.keyboard.type('KITCHEN - NIGHT');
  const hs2 = await headings();
  assert(hs2[1] === 'INT. KITCHEN - NIGHT', JSON.stringify(hs2));
  // following heading still a heading after typing in the new scene
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.type('Kettle whistles.');
  const hs3 = await headings();
  assert(hs3.length === 4 && hs3[2] === 'EXT. HARBOUR - CONTINUOUS', JSON.stringify(hs3));
});

await check('scene information follows heading edits', async () => {
  await goScene(1);
  await app(() => { const a = window.__app; a.updateSceneRecord(a.activeScene(), { summary: 'Tea before the storm', color: '#7FC48D' }); });
  // edit the heading text
  await app(() => { const a = window.__app; const s = a.activeScene(); a.editor.setSelection({ anchor: { line: s.line, ch: 5 }, head: { line: s.line, ch: 12 } }); });
  await page.keyboard.type('PANTRY');
  const s = await app(() => { const a = window.__app; const s = a.activeScene(); return [s.heading, s.record?.summary]; });
  assert(s[0] === 'INT. PANTRY - NIGHT' && s[1] === 'Tea before the storm', JSON.stringify(s));
});

await check('keyboard reordering moves the scene with its information, undoable', async () => {
  const before = await app(() => window.__app.editor.getText());
  await page.keyboard.press('Alt+Shift+ArrowDown');
  const hs = await headings();
  assert(hs[2] === 'INT. PANTRY - NIGHT', JSON.stringify(hs));
  const rec = await app(() => window.__app.scenes.find((s) => s.heading === 'INT. PANTRY - NIGHT').record?.summary);
  assert(rec === 'Tea before the storm', rec);
  // Every heading still parses as a heading (blank line separation kept)
  const types = await app(() => window.__app.scenes.filter((s) => s.kind === 'scene').length);
  assert(types === 4, String(types));
  await page.keyboard.press('Control+Z');
  const after = await app(() => window.__app.editor.getText());
  assert(after === before, 'undo did not restore order');
  await page.keyboard.press('Control+Shift+Z');
  const hs2 = await headings();
  assert(hs2[2] === 'INT. PANTRY - NIGHT', 'redo ' + JSON.stringify(hs2));
});

await check('drag and drop in the outline reorders scenes', async () => {
  const rows = page.locator('.outline .row');
  const from = rows.filter({ hasText: 'INT. LIGHTHOUSE - STAIRWELL' });
  const to = rows.filter({ hasText: 'INT. LIGHTHOUSE - NIGHT' });
  await from.dragTo(to, { targetPosition: { x: 40, y: 3 } });
  const hs = await headings();
  assert(hs[0] === 'INT. LIGHTHOUSE - STAIRWELL - NIGHT', JSON.stringify(hs));
  assert(hs.length === 4, JSON.stringify(hs));
});

await check('moved scenes keep their text intact', async () => {
  const t = await app(() => window.__app.editor.getText());
  for (const s of ['Lisa descends, lantern raised.', 'Kettle whistles.', 'Waves break over the pier.', 'Rain hammers the glass.']) assert(t.includes(s), 'lost ' + s);
  assert(!/\n\n\n\n/.test(t), 'blank lines accumulating');
});

await check('deleting a heading detaches its information; undo reattaches it', async () => {
  const idx = await app(() => window.__app.scenes.find((s) => s.heading === 'INT. PANTRY - NIGHT').line);
  await app((i) => window.__app.editor.setSelection({ anchor: { line: i, ch: 0 }, head: { line: i, ch: window.__app.editor.lines[i].text.length } }), idx);
  await page.keyboard.press('Backspace');
  const det = await app(() => window.__app.project.meta.detached.map((d) => d.summary));
  assert(det.includes('Tea before the storm'), JSON.stringify(det));
  await page.keyboard.press('Control+Z');
  const rec = await app(() => window.__app.scenes.find((s) => s.heading === 'INT. PANTRY - NIGHT')?.record?.summary);
  const det2 = await app(() => window.__app.project.meta.detached.length);
  assert(rec === 'Tea before the storm' && det2 === 0, `${rec} ${det2}`);
});

await check('scene information survives closing and reopening, even after external reordering', async () => {
  await page.keyboard.press('Control+S');
  await sleep(300);
  const block = await app(() => {
    const a = window.__app;
    const s = a.scenes.find((x) => x.heading === 'INT. PANTRY - NIGHT');
    return a.editor.lines.slice(s.line, s.end).map((l) => l.text).join('\n');
  });
  await app(() => window.__app.closeProject());
  // External reorder: move the pantry scene to the start of the body by editing the file directly.
  const file = path.join(h.ws, 'The Long Night', 'The Long Night.fountain');
  let t = fs.readFileSync(file, 'utf8');
  assert(t.includes(block), 'pantry block not found');
  t = t.replace(block, '');
  t = t.replace('FADE IN:\n', 'FADE IN:\n\n' + block.trim() + '\n');
  fs.writeFileSync(file, t);
  await app(() => window.__app.openProject('The Long Night'));
  await sleep(200);
  const rec = await app(() => window.__app.scenes.find((s) => s.heading === 'INT. PANTRY - NIGHT')?.record);
  assert(rec && rec.summary === 'Tea before the storm' && rec.color === '#7FC48D', JSON.stringify(rec));
  const first = await app(() => window.__app.scenes.filter((s) => s.kind === 'scene')[0].heading);
  assert(first === 'INT. PANTRY - NIGHT', first);
});

await check('Script/Scene cycling skips the title page; first focused scene is the first actual scene', async () => {
  await app(() => { const a = window.__app; a.setView('script'); a.editor.setSelection({ anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 0 } }); a.editor.scrollTop = 0; });
  await app(() => window.__app.editor.focus());
  await page.keyboard.press('Tab');
  const f = await app(() => [window.__app.view, window.__app.focusedItem()?.kind]);
  assert(f[0] === 'scene' && f[1] !== 'title', JSON.stringify(f));
  // Next/previous never land on the title page
  for (let k = 0; k < 8; k++) await page.keyboard.press('Alt+ArrowLeft');
  const f2 = await app(() => window.__app.focusedItem()?.kind);
  assert(f2 !== 'title', f2);
});

await check('scene search filters the outline; Escape returns to writing', async () => {
  await page.keyboard.press('Control+F');
  await page.keyboard.type('harbour');
  const n = await page.locator('.outline .row').count();
  assert(n === 1, String(n));
  await page.keyboard.press('Escape');
  const focused = await app(() => window.__app.editor.hasFocus());
  const n2 = await page.locator('.outline .row').count();
  assert(focused && n2 > 1, `${focused} ${n2}`);
});

console.log(results.map((r) => r.join(' — ')).join('\n'));
console.log('page errors:', JSON.stringify(h.errors.filter((e) => !e.includes('404'))));
await h.stop();
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
