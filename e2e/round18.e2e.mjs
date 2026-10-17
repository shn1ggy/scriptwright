// Round 18: documents beside the screenplay, folding the scene list, the status line under the
// writing column, the slider.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { startHarness, assert, sleep } from './util.mjs';

const h = await startHarness();
const { page } = h;
const results = [];
const shots = process.env.SHOTS;
async function check(name, fn) {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); await page.screenshot({ path: path.join(os.tmpdir(), `r18-fail-${results.length}.png`) }); }
}
const app = (fn, ...a) => page.evaluate(fn, ...a);
await page.setViewportSize({ width: 1280, height: 800 });
const projectDir = path.join(h.ws, 'The Long Night');

await check('the scene list folds away like Projects and stays folded', async () => {
  await page.locator('.outline .section-head .collapser').click();
  await sleep(150);
  assert(await page.locator('.outline .list').isHidden(), 'list still shown');
  assert(await app(() => window.__app.state.layout.scenesCollapsed === true), 'not remembered');
  await page.locator('.outline .section-head .collapser').click();
  await sleep(150);
  assert(await page.locator('.outline .list').isVisible(), 'list not back');
});

await check('the status line sits under the writing column; the left pane runs to the bottom', async () => {
  const pane = await page.locator('.pane-left').boundingBox();
  const status = await page.locator('.statusbar').boundingBox();
  assert(pane.y + pane.height >= 799, `pane ends at ${pane.y + pane.height}`);
  assert(status.x >= pane.x + pane.width - 2, `status starts at ${status.x}`);
});

await check('without documents the section has no hint and nothing to fold', async () => {
  assert(await page.locator('.documents.empty').count() === 1, 'not marked empty');
  assert(!(await page.locator('.documents .list').isVisible()), 'empty list shown');
  assert(!(await page.locator('.documents .collapse-mark').isVisible()), 'fold arrow shown');
});

await check('a new exposé is created, written and saved as a Markdown file', async () => {
  await page.locator('.documents .section-head .icon-btn').first().click();
  await page.locator('.menu [role="menuitem"]', { hasText: 'Exposé' }).click();
  await sleep(400);
  assert(await app(() => window.__app.docs.isOpen), 'not open');
  assert(await page.locator('.ed-scroller.ed-prose').isVisible(), 'prose editor hidden');
  await page.keyboard.type('# Logline\n\nLisa, 41, sends out *one more* application.\n\n- first point\n');
  await sleep(1400);
  const file = path.join(projectDir, 'Exposé.txt');
  assert(fs.existsSync(file), 'no file');
  assert(fs.readFileSync(file, 'utf8').includes('Lisa, 41, sends out *one more* application.'), 'text not saved');
  const status = await page.locator('.statusbar .count').textContent();
  assert(/Exposé · 1[0-9] words/.test(status), status);
  assert((await page.locator('.titlebar .doc-sub').textContent()) === 'Exposé', 'title bar');
  assert((await page.locator('.viewbar .tab.on').count()) === 0, 'a tab is still marked');
  if (shots) await page.screenshot({ path: path.join(shots, 'doc-open.png') });
});

await check('undo in the document leaves the screenplay alone', async () => {
  const before = await app(() => window.__app.editor.getText());
  const docBefore = await app(() => window.__app.docs.docEditor.getText());
  await page.keyboard.press('Control+Z');
  await sleep(200);
  const doc = await app(() => window.__app.docs.docEditor.getText());
  assert(doc !== docBefore, 'document undo did nothing');
  assert((await app(() => window.__app.editor.getText())) === before, 'screenplay changed');
  await page.keyboard.press('Control+Y');
});

await check('a scene or the Script tab leads back to the screenplay; the document opens again', async () => {
  await page.locator('.outline .row[data-id]').nth(2).click();
  await sleep(300);
  assert(!(await app(() => window.__app.docs.isOpen)), 'document still open');
  assert(await page.locator('.ed-scroller:not(.ed-prose)').isVisible(), 'screenplay hidden');
  await page.locator('.documents .doc-row').first().click();
  await sleep(300);
  assert((await app(() => window.__app.docs.docEditor.getText())).includes('one more'), 'text lost');
  await page.locator('.viewbar .tab', { hasText: 'Script' }).click();
  await sleep(300);
  assert(!(await app(() => window.__app.docs.isOpen)), 'Script tab did not leave');
  assert((await page.locator('.viewbar .tab.on').textContent()) === 'Script', 'Script tab not marked');
});

await check('the right-click menu formats text: bold, heading, list', async () => {
  const ed = () => app(() => window.__app.docs.docEditor.getText());
  if (!(await app(() => window.__app.docs.isOpen))) await page.locator('.documents .doc-row').first().click();
  await sleep(300);
  // The word "application" on the paragraph line.
  await app(() => {
    const e = window.__app.docs.docEditor;
    const i = e.lines.findIndex((l) => l.text.startsWith('Lisa'));
    const ch = e.lines[i].text.indexOf('application') + 3;
    e.setSelection({ anchor: { line: i, ch }, head: { line: i, ch } });
  });
  const caret = await page.locator('.ed-prose .ed-caret').boundingBox();
  await page.mouse.click(caret.x + 1, caret.y + 4, { button: 'right' });
  await sleep(150);
  if (shots) await page.screenshot({ path: path.join(shots, 'doc-menu.png') });
  await page.locator('.menu .menu-tool[aria-label="Bold"]').click();
  await sleep(150);
  assert((await ed()).includes('**application**'), await ed());
  await page.mouse.click(caret.x + 1, caret.y + 4, { button: 'right' });
  await page.locator('.menu .menu-tool[aria-label="Bold"].on').waitFor({ timeout: 2000 });
  await page.locator('.menu .menu-tool[aria-label="Subheading"]').click();
  await sleep(150);
  assert((await ed()).includes('## Lisa, 41'), await ed());
  await page.mouse.click(caret.x + 1, caret.y + 4, { button: 'right' });
  await page.locator('.menu .menu-tool[aria-label="Paragraph"]').click();
  await sleep(150);
  assert((await ed()).includes('\nLisa, 41'), 'heading not undone');
  await page.mouse.click(caret.x + 1, caret.y + 4, { button: 'right' });
  await page.locator('.menu .menu-tool[aria-label="Centre"]').click();
  await sleep(150);
  assert((await ed()).includes('> Lisa, 41') && /application\*\* <|\. </.test(await ed()), await ed());
  assert(await page.locator('.ed-prose .ln.align-center').count() === 1, 'not centred on screen');
  await page.mouse.click(caret.x + 1, caret.y + 4, { button: 'right' });
  await page.locator('.menu .menu-tool[aria-label="Align left"]').click();
  await sleep(150);
  assert(!(await ed()).includes('> Lisa'), 'alignment not removed');
});

await check('Mod+1 while writing a document goes back to the script', async () => {
  await app(() => window.__app.docs.docEditor.focus());
  await page.keyboard.press('Control+1');
  await sleep(300);
  assert(!(await app(() => window.__app.docs.isOpen)), 'document still open');
  assert((await page.locator('.viewbar .tab.on').textContent()) === 'Script', 'not on Script');
  await page.locator('.documents .doc-row').first().click();
  await sleep(300);
});

await check('the + buttons line up in every section', async () => {
  const xs = await page.$$eval('.pane-left .section-head', (heads) => heads.map((h) => { const b = [...h.querySelectorAll('.icon-btn')]; return Math.round(b[0].getBoundingClientRect().left); }));
  assert(new Set(xs).size === 1, JSON.stringify(xs));
  if (shots) await page.screenshot({ path: path.join(shots, 'heads.png'), clip: { x: 0, y: 76, width: 300, height: 724 } });
});

await check('rename, colour and archive from the context menu', async () => {
  await page.locator('.documents .doc-row').first().click({ button: 'right' });
  await page.locator('.menu [role="menuitem"]', { hasText: 'Rename' }).click();
  await page.locator('.dialog input.field').fill('Exposé v2');
  await page.keyboard.press('Enter');
  await sleep(400);
  assert(fs.existsSync(path.join(projectDir, 'Exposé v2.txt')), 'file not renamed');
  await page.locator('.documents .doc-row').first().click({ button: 'right' });
  await page.locator('.menu [role="menuitem"]', { hasText: 'Green' }).click();
  await sleep(150);
  assert(await page.locator('.documents .doc-row.tinted').count() === 1, 'no colour');
  await page.locator('.documents .section-head .icon-btn').first().click();
  await page.locator('.menu [role="menuitem"]', { hasText: 'Treatment' }).click();
  await sleep(400);
  await page.keyboard.type('# Act one\n\nThe copy shop at night.');
  await sleep(200);
  if (shots) await page.screenshot({ path: path.join(shots, 'docs-pane.png'), clip: { x: 0, y: 70, width: 300, height: 730 } });
  await page.locator('.documents .doc-row', { hasText: 'Treatment' }).click({ button: 'right' });
  await page.locator('.menu [role="menuitem"]', { hasText: 'Move to archive' }).click();
  await sleep(300);
  assert(!(await app(() => window.__app.docs.isOpen)), 'archived document still open');
  assert((await page.locator('.documents .archive-head').textContent()).includes('1'), 'no archive group');
  assert(await page.locator('.documents .archive-head.act-row').count() === 1, 'archive head differs from the scene archive');
  assert(fs.existsSync(path.join(projectDir, 'Treatment.txt')), 'archive deleted the file');
});

await check('the document exports as a PDF', async () => {
  await page.locator('.documents .doc-row').first().click();
  await sleep(300);
  const out = path.join(h.tmp, 'expose.pdf');
  await h.queueDialog(out);
  await page.locator('.viewbar .tab', { hasText: 'Export' }).click();
  await sleep(1200);
  assert(fs.readFileSync(out).subarray(0, 5).toString() === '%PDF-', 'no PDF');
  if (shots) fs.copyFileSync(out, path.join(shots, 'expose.pdf'));
});

await check('documents survive closing and reopening the project', async () => {
  await page.reload();
  await page.waitForFunction(() => window.__app && window.__app.ready && window.__app.project, null, { timeout: 15000 });
  await sleep(500);
  const titles = await page.locator('.documents .doc-row').allTextContents();
  assert(titles.join('|') === 'Exposé v2', titles.join('|'));
});

await check('the brightness slider fills up to its value', async () => {
  await app(() => window.__app.openPanel('export'));
  await sleep(800);
  const fill = await page.locator('.preview-dim input').evaluate((e) => e.style.getPropertyValue('--fill'));
  assert(/%$/.test(fill), `fill ${fill}`);
  if (shots) await page.screenshot({ path: path.join(shots, 'export-head.png'), clip: { x: 0, y: 76, width: 1280, height: 44 } });
  await sleep(1500);
  const foot = await page.locator('.export-side .foot').textContent();
  assert(/page/.test(foot) && !/min|lines per page/.test(foot), foot);
  if (shots) await page.screenshot({ path: path.join(shots, 'export-foot.png'), clip: { x: 0, y: 600, width: 400, height: 200 } });
  await app(() => window.__app.closePanel());
});

await check('a workspace can be removed from the app without touching its folder', async () => {
  const ws = await app(() => window.__app.state.workspace);
  await page.locator('.ws-switch').click();
  await page.locator('.menu [role="menuitem"]', { hasText: 'from Scriptwright' }).click();
  await sleep(200);
  if (shots) await page.screenshot({ path: path.join(shots, 'remove-ws.png') });
  await page.locator('.dialog .btn.primary').click();
  await sleep(500);
  assert(!(await app(() => window.__app.state.workspace)), 'still connected');
  assert(fs.existsSync(ws), 'folder gone');
  assert((await app(() => window.__app.state.recentWorkspaces)).length === 0, 'still listed');
});

console.log(results.map((r) => r.join(' — ')).join('\n'));
console.log('page errors:', JSON.stringify(h.errors.filter((e) => !e.includes('404'))));
await h.stop();
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
