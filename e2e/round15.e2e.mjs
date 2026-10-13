// Round 15: structure (acts, beats, timeline), minimal view, remembered export preset.
import os from 'os';
import path from 'path';
import { startHarness, assert, sleep } from './util.mjs';

const h = await startHarness();
const { page } = h;
const results = [];
const shots = process.env.SHOTS;
async function check(name, fn) {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); await page.screenshot({ path: path.join(os.tmpdir(), `r15-fail-${results.length}.png`) }); }
}
const app = (fn, ...a) => page.evaluate(fn, ...a);
const text = () => app(() => window.__app.editor.getText());
await page.setViewportSize({ width: 1500, height: 900 });

await check('every tab except Script and Scene leaves minimal view', async () => {
  await app(() => { const a = window.__app; a.setView('script'); if (!a.minimal) a.toggleMinimal(); });
  await app(() => window.__app.setView('scene'));
  assert(await app(() => window.__app.minimal), 'Scene left minimal view');
  await app(() => window.__app.setView('dialogue'));
  assert(!(await app(() => window.__app.minimal)), 'Dialogue kept minimal view');
  await app(() => { const a = window.__app; a.setView('script'); a.toggleMinimal(); a.editor.focus(); });
  await page.keyboard.press('Control+3');
  await sleep(200);
  assert(!(await app(() => window.__app.minimal)), 'Cards shortcut kept minimal view');
  await app(() => window.__app.closePanel());
});

await check('starting an act from a card writes a section and shows a divider', async () => {
  await app(() => window.__app.openPanel('cards'));
  await sleep(300);
  for (const [n, title] of [[0, 'Act One'], [2, 'Act Two']]) {
    await page.locator('.cards-grid .card').nth(n).click({ button: 'right' });
    await page.locator('.menu [role="menuitem"]:has-text("Start an act here")').click();
    const input = page.locator('.dialog input.field');
    await input.fill(title);
    await input.press('Enter');
    await sleep(300);
  }
  const t = await text();
  assert(t.includes('# Act One') && t.includes('# Act Two'), 'sections not written');
  const divs = await page.locator('.cards-divider').count();
  assert(divs === 2, String(divs));
  // The act line stays where it is when the scene before it moves.
  const before = await app(() => { const ed = window.__app.editor; return ed.lineTexts.findIndex((l) => l === '# Act Two'); });
  const sceneEnd = await app(() => { const a = window.__app; const s = a.scenes.filter((x) => x.kind === 'scene')[1]; return s.end; });
  assert(sceneEnd <= before, `scene 2 ends at ${sceneEnd}, act line at ${before}`);
});

await check('a beat can be placed from the card menu and undone', async () => {
  await page.locator('.cards-grid .card').nth(1).click({ button: 'right' });
  await page.locator('.menu [role="menuitem"]:has-text("Inciting incident")').click();
  await sleep(200);
  assert((await page.locator('.cards-grid .card').nth(1).locator('.card-beat').count()) === 1, 'no beat chip');
  await page.locator('.cards-grid').focus();
  await page.keyboard.press('Control+Z');
  await sleep(200);
  assert((await page.locator('.card-beat').count()) === 0, 'beat not undone');
  await page.keyboard.press('Control+Y');
  await sleep(200);
  assert((await page.locator('.card-beat').count()) === 1, 'beat not redone');
});

await check('the timeline shows the model, acts, scenes and beats; a marker drags onto a scene', async () => {
  await page.locator('.cards-head .seg-btn[data-mode="timeline"]').click();
  await sleep(400);
  assert(await page.locator('.timeline').isVisible(), 'timeline hidden');
  const scenes = await page.locator('.tl-scene').count();
  const n = await app(() => window.__app.scenes.filter((x) => x.kind === 'scene').length);
  assert(scenes === n, `${scenes} blocks for ${n} scenes`);
  assert((await page.locator('.tl-band.act').count()) === 2, 'acts');
  assert((await page.locator('.tl-band.model').count()) === 3, 'model phases');
  assert((await page.locator('.tl-lane.beat').count()) === 8, 'beats');
  if (shots) await page.screenshot({ path: path.join(shots, 'timeline.png') });
  // Drag the midpoint's typical marker onto the last scene.
  const row = page.locator('.tl-lane.beat').nth(3);
  const mark = row.locator('.tl-mark.typical');
  const mb = await mark.boundingBox();
  const last = await page.locator('.tl-scene').last().boundingBox();
  await page.mouse.move(mb.x + mb.width / 2, mb.y + mb.height / 2);
  await page.mouse.down();
  await page.mouse.move(last.x + last.width / 2, mb.y + 5, { steps: 6 });
  await page.mouse.up();
  await sleep(300);
  const placed = await app(() => { const a = window.__app; const id = a.project.meta.structure.beats.midpoint; return a.scenes.filter((x) => x.kind === 'scene').findIndex((s) => s.id === id); });
  assert(placed === n - 1, `midpoint on scene index ${placed}`);
  assert((await page.locator('.tl-lane.beat').nth(3).locator('.tl-mark.actual').count()) === 1, 'no actual marker');
  // Another model.
  await page.locator('.tl-model select').selectOption('save-the-cat');
  await sleep(300);
  assert((await page.locator('.tl-lane.beat').count()) === 15, 'save the cat beats');
  if (shots) await page.screenshot({ path: path.join(shots, 'timeline-stc.png') });
  await page.locator('.tl-model select').selectOption('three-act');
  await page.locator('.cards-head .seg-btn[data-mode="cards"]').click();
  await sleep(200);
  if (shots) await page.screenshot({ path: path.join(shots, 'cards-acts.png') });
});

await check('removing an act keeps its scenes', async () => {
  const n0 = await app(() => window.__app.scenes.filter((x) => x.kind === 'scene').length);
  await page.locator('.cards-divider').nth(1).click({ button: 'right' });
  await page.locator('.menu [role="menuitem"]:has-text("Remove this act")').click();
  await sleep(300);
  assert(!(await text()).includes('# Act Two'), 'section still there');
  assert((await app(() => window.__app.scenes.filter((x) => x.kind === 'scene').length)) === n0, 'scenes changed');
  await app(() => window.__app.closePanel());
});

await check('the chosen export preset is remembered and marked when changed', async () => {
  await app(() => window.__app.openPanel('export'));
  await sleep(600);
  await page.locator('.export-head .btn:has-text("Save as preset")').click();
  const input = page.locator('.dialog input.field');
  await input.fill('Festival');
  await input.press('Enter');
  await sleep(300);
  assert((await page.locator('.export-head select').inputValue()) === 'Festival', 'not selected after save');
  await app(() => window.__app.closePanel());
  await sleep(200);
  await app(() => window.__app.openPanel('export'));
  await sleep(600);
  assert((await page.locator('.export-head select').inputValue()) === 'Festival', 'not remembered');
  // Change a setting: the preset shows as changed.
  await page.locator('.ex-head:has-text("Elements")').click();
  const box = page.locator('.export-side input[type="checkbox"]:visible').first();
  await box.click();
  await sleep(800);
  const label = await page.locator('.export-head select option:checked').textContent();
  assert(label.includes('changed'), label);
  await box.click();
  await sleep(800);
  await page.locator('.ex-head:has-text("Elements")').click();
  const label2 = await page.locator('.export-head select option:checked').textContent();
  assert(!label2.includes('changed'), label2);
  await app(() => window.__app.closePanel());
});

await check('colored scene rows have no second marker; card headings are plain', async () => {
  await app(() => { const a = window.__app; const it = a.scenes.find((x) => x.kind === 'scene'); a.updateSceneRecord(it, { color: '#E5534B' }); a.settings.cards.tintOutline = true; a.outline.refresh(); a.goToScene(it); });
  await sleep(300);
  const disp = await page.locator('.outline .row.tinted.active').first().evaluate((e) => getComputedStyle(e, '::before').display);
  assert(disp === 'none', disp);
});

console.log(results.map((r) => r.join(' — ')).join('\n'));
console.log('page errors:', JSON.stringify(h.errors.filter((e) => !e.includes('404'))));
await h.stop();
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
