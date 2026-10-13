// Renders the same screens with the current styles and with a proposed layer, for comparison.
import fs from 'fs';
import path from 'path';
import { startHarness, sleep } from '../../e2e/util.mjs';

const out = process.argv[2];
const proposal = process.argv[3] ? fs.readFileSync(process.argv[3], 'utf8') : '';
fs.mkdirSync(out, { recursive: true });
const h = await startHarness();
const { page } = h;
await page.setViewportSize({ width: 1440, height: 900 });
const titleH = proposal ? 38 : 30;
const macLook = `
body { }
body::after { content: ''; position: fixed; z-index: 2000; left: 13px; top: ${Math.round(titleH / 2 - 6)}px; width: 12px; height: 12px; border-radius: 50%;
  background: #ff5f57; box-shadow: 20px 0 0 #febc2e, 40px 0 0 #28c840; pointer-events: none; }
`;
await page.addStyleTag({ content: macLook + proposal });
const app = (fn, ...a) => page.evaluate(fn, ...a);
await app(() => {
  document.body.classList.add('frameless', 'platform-darwin');
  const a = window.__app;
  a.state.layout.rightVisible = true;
  a.state.layout.rightTab = 'comments';
  a.applyLayout();
  const ed = a.editor;
  const sel = (s) => {
    const i = ed.lines.findIndex((l) => l.text.includes(s));
    const ch = ed.lines[i].text.indexOf(s);
    ed.setSelection({ anchor: { line: i, ch }, head: { line: i, ch: ch + s.length } });
  };
  sel('Rain hammers the glass');
  a.annotations.addComment('Sound design: let the rain drown the room tone.', a.annotations.selectionAnchor());
  sel('A KNOCK at the door below');
  a.annotations.addPassage(a.annotations.selectionAnchor(), 'The knock');
  const sc = a.scenes.filter((s) => s.kind === 'scene');
  a.updateSceneRecord(sc[0], { color: '#7FC48D', status: 'done', summary: 'Lisa alone with the lamp; Tom knocks.' });
  a.updateSceneRecord(sc[1], { color: '#6FA8E8' });
  ed.setSelection({ anchor: { line: 12, ch: 0 }, head: { line: 12, ch: 0 } });
  a.showRightTab('comments');
});
await sleep(400);
await page.screenshot({ path: path.join(out, '1-main.png') });

// Context menu on a scene
const row = page.locator('.outline .row:not(.title-row)').nth(1);
await row.click({ button: 'right' });
await sleep(200);
const box = await row.boundingBox();
await page.screenshot({ path: path.join(out, '2-menu.png'), clip: { x: 0, y: 0, width: 720, height: 900 } });
await page.keyboard.press('Escape');

// Settings
await app(() => window.__app.run('app.settings'));
await sleep(400);
await page.screenshot({ path: path.join(out, '3-settings.png') });
await page.keyboard.press('Escape');
await sleep(200);

// Export
await page.keyboard.press('Control+E');
await page.waitForSelector('.export-preview canvas', { timeout: 15000 });
await sleep(800);
await page.screenshot({ path: path.join(out, '4-export.png') });
await h.stop();
void box;
