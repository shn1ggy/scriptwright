// Screenshots of every main screen and dialog, for checking against DESIGN.md.
import fs from 'fs';
import path from 'path';
import { startHarness, sleep } from '../../e2e/util.mjs';
const out = process.argv[2];
const light = process.argv[3] === 'light';
fs.mkdirSync(out, { recursive: true });
const h = await startHarness();
const { page } = h;
await page.setViewportSize({ width: 1440, height: 900 });
const app = (fn, ...a) => page.evaluate(fn, ...a);
const shot = async (name) => { await sleep(350); await page.screenshot({ path: path.join(out, name + '.png') }); };
await app((light) => {
  const a = window.__app;
  if (light) { a.settings.appearance.theme = 'light'; a.applySettings(); }
  a.state.layout.rightVisible = true; a.applyLayout();
  const ed = a.editor;
  const sel = (s) => { const i = ed.lines.findIndex((l) => l.text.includes(s)); const ch = ed.lines[i].text.indexOf(s); ed.setSelection({ anchor: { line: i, ch }, head: { line: i, ch: ch + s.length } }); };
  sel('Rain hammers the glass'); a.annotations.addComment('Sound design: let the rain drown the room tone.', a.annotations.selectionAnchor());
  sel('A KNOCK at the door below'); a.annotations.addPassage(a.annotations.selectionAnchor(), 'The knock');
  const sc = a.scenes.filter((s) => s.kind === 'scene');
  a.updateSceneRecord(sc[0], { color: '#7FC48D', status: 'done', summary: 'Lisa alone with the lamp; Tom knocks.' });
  ed.setSelection({ anchor: { line: 12, ch: 0 }, head: { line: 12, ch: 0 } });
  a.showRightTab('comments');
}, light);
await shot('01-script');
await app(() => window.__app.setView('scene')); await shot('02-scene');
await app(() => window.__app.setView('dialogue')); await shot('03-dialogue');
await app(() => window.__app.openPanel('cards')); await shot('04-cards');
await app(() => window.__app.openPanel('characters')); await shot('05-characters');
await app(() => { window.__app.closePanel(); window.__app.setView('script'); });
await app(() => window.__app.showRightTab('scene')); await shot('06-right-scene');
await app(() => window.__app.showRightTab('history')); await shot('07-right-history');
await app(() => window.__app.showRightTab('shelf')); await shot('08-right-shelf');
await page.keyboard.press('Control+Alt+F'); await page.keyboard.type('the'); await shot('09-find');
await page.keyboard.press('Escape');
await page.locator('.outline .row:not(.title-row)').nth(0).click({ button: 'right' }); await shot('10-scene-menu'); await page.keyboard.press('Escape');
await page.click('.workspace-bar .ws-switch'); await shot('11-workspace-menu'); await page.keyboard.press('Escape');
for (const [i, sec] of [['12', 'Editor'], ['13', 'Appearance'], ['14', 'Commands & shortcuts'], ['15', 'Saving & history']]) {
  await app(() => window.__app.run('app.settings'));
  await sleep(200);
  await page.click(`.settings nav .row:has-text("${sec}")`);
  await shot(`${i}-settings-${sec.split(' ')[0].toLowerCase()}`);
  await page.keyboard.press('Escape');
}
await app(() => window.__app.run('app.commands')); await shot('16-commands'); await page.keyboard.press('Escape');
await app(() => { const ed = window.__app.editor; const i = ed.lines.findIndex((l) => l.text.includes('Rain hammers')); ed.setSelection({ anchor: { line: i, ch: 0 }, head: { line: i, ch: 4 } }); window.__app.run('edit.comment'); });
await shot('17-comment-dialog'); await page.keyboard.press('Escape');
await app(() => window.__app.run('edit.rewrite')); await shot('18-rewrite'); await page.keyboard.press('Escape');
await page.keyboard.press('Control+E'); await page.waitForSelector('.export-preview canvas', { timeout: 15000 }); await shot('19-export'); await page.keyboard.press('Escape');
await app(() => window.__app.run('character.rename')); await shot('20-rename'); await page.keyboard.press('Escape');
await h.stop();
