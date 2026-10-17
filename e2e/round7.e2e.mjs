// Feedback round 7: clean tab bar, workspace bar, archive/delete, highlights, import numbers, small fixes.
import os from 'os';
import path from 'path';
import fs from 'fs';
import { startHarness, assert, sleep } from './util.mjs';

const h = await startHarness();
const { page } = h;
const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); await page.screenshot({ path: path.join(os.tmpdir(), `r7-fail-${results.length}.png`) }); }
}
const app = (fn, ...a) => page.evaluate(fn, ...a);

await check('the tab bar holds only tabs; view options live in the view and never leak', async () => {
  await page.keyboard.press('Control+4');
  await sleep(100);
  const inBar = await page.locator('.viewbar select, .viewbar .btn, .viewbar .icon-btn').count();
  assert(inBar === 0, `controls in tab bar: ${inBar}`);
  assert(await page.isVisible('.view-head select[aria-label="Character"]'), 'dialogue options missing');
  await page.screenshot({ path: path.join(os.tmpdir(), 'sw-r7-dialogue.png') });
  await page.keyboard.press('Control+5');
  await sleep(100);
  assert(await page.isHidden('.view-head'), 'dialogue options visible in Characters');
  assert((await page.locator('.characters .icon-btn[aria-label^="Back"], .characters .icon-btn[title^="Close"]').count()) === 0, 'close button in Characters');
  await page.keyboard.press('Control+2');
  await sleep(100);
  // Scene view has no header: previous/next sit in the status bar.
  assert(await page.isHidden('.view-head'), 'header in Scene view');
  assert(await page.isVisible('.statusbar .status-nav [aria-label="Next scene"]'), 'scene navigation missing');
  await page.keyboard.press('Control+1');
  assert(await page.isHidden('.view-head'), 'header in Script view');
});

await check('the title page is hidden in Script view by default', async () => {
  const first = await app(() => {
    const ed = window.__app.editor;
    return ed.displayedLines[0] >= ed.parsed.titleEnd;
  });
  assert(first, 'title page shown');
});

await check('workspace bar: switch, create and settings at the bottom of the scene pane', async () => {
  const name = await page.textContent('.workspace-bar .ws-name');
  assert(name === 'Workspace', name);
  await page.click('.workspace-bar .ws-switch');
  await page.waitForSelector('.menu');
  const items = await page.locator('.menu').textContent();
  assert(items.includes('Connect to Workspace Folder') && items.includes('Create New Workspace'), items);
  await page.keyboard.press('Escape');
  const more = await page.locator('.projects .section-head [aria-label="Project actions"]').click().then(() => page.locator('.menu').textContent());
  assert(!/Workspace/.test(more), 'workspace items still in the project menu: ' + more);
  await page.keyboard.press('Escape');
  await page.screenshot({ path: path.join(os.tmpdir(), 'sw-r7-pane.png') });
  // Create a new workspace and come back.
  const parent = path.join(h.tmp, 'Parent');
  fs.mkdirSync(parent);
  await page.click('.workspace-bar .ws-switch');
  await page.click('.menu >> text=Create New Workspace');
  await page.fill('.dialog input', 'Second');
  await h.queueDialog(parent);
  await page.click('.dialog .btn.primary');
  await sleep(600);
  assert(fs.existsSync(path.join(parent, 'Second', '.scriptwright')), 'workspace not created');
  assert((await page.textContent('.workspace-bar .ws-name')) === 'Second', 'not switched');
  await app((ws) => window.__app.setWorkspace(ws), h.ws);
  await sleep(400);
  assert((await page.textContent('.workspace-bar .ws-name')) === 'Workspace', 'not switched back');
});

await check('projects: archive, move back, delete with confirmation', async () => {
  await app(() => window.__app.newProject && null);
  fs.mkdirSync(path.join(h.ws, 'Old One'));
  fs.writeFileSync(path.join(h.ws, 'Old One', 'Old One.fountain'), 'INT. ROOM - DAY\n\nOld.\n');
  await app(() => window.__app.refreshProjects());
  await page.click('.projects .row:has-text("Old One")', { button: 'right' });
  await page.click('.menu >> text=Move to Archive');
  await sleep(300);
  assert(fs.existsSync(path.join(h.ws, 'Archive', 'Old One', 'Old One.fountain')), 'not archived on disk');
  assert(await page.isVisible('.projects .archive-head'), 'no archive section');
  assert(await page.isHidden('.projects .project-row:has-text("Old One")'), 'archived project still in the main list');
  await page.click('.projects .archive-head');
  await page.click('.projects .row.archived:has-text("Old One")', { button: 'right' });
  await page.click('.menu >> text=Move Out of Archive');
  await sleep(300);
  assert(fs.existsSync(path.join(h.ws, 'Old One')), 'not moved back');
  await page.click('.projects .row:has-text("Old One")', { button: 'right' });
  await page.click('.menu >> text=Delete Project');
  await page.waitForSelector('.dialog[aria-label="Delete project"]');
  await page.click('.dialog[aria-label="Delete project"] .btn.danger');
  await sleep(300);
  assert(!fs.existsSync(path.join(h.ws, 'Old One')), 'not deleted');
  const kept = fs.readdirSync(path.join(h.ws, '.scriptwright', 'deleted'));
  assert(kept.some((f) => f.endsWith('Old One')), 'not kept in deleted items');
});

await check('highlight colors and names come from the settings', async () => {
  await app(() => window.__app.openProject('The Long Night'));
  await app(() => {
    const ed = window.__app.editor;
    const i = ed.lines.findIndex((l) => l.text.startsWith('Rain'));
    ed.setSelection({ anchor: { line: i, ch: 0 }, head: { line: i, ch: 4 } });
    ed.focus();
  });
  await app(() => {
    const a = window.__app;
    a.settings.highlights.green = { color: '#22aa44', label: 'Fix later' };
    a.applySettings();
  });
  await page.keyboard.press('Control+H');
  await page.waitForSelector('.menu');
  const menu = await page.locator('.menu').textContent();
  assert(menu.includes('Fix later'), menu);
  await page.keyboard.press('Escape');
  const v = await app(() => getComputedStyle(document.documentElement).getPropertyValue('--hl-green'));
  assert(/34, 170, 68/.test(v), v);
});

await check('Export is a tab: Mod+E opens it below the tab bar, again closes it; panes rest', async () => {
  await app(() => window.__app.editor.focus());
  await page.keyboard.press('Control+E');
  await page.waitForSelector('.main .export');
  assert((await page.locator('.export').count()) === 1, 'not one export');
  assert((await page.textContent('.viewbar .tab.on')) === 'Export', 'Export tab not active');
  const top = await page.locator('.export').evaluate((e) => e.getBoundingClientRect().top);
  const barBottom = await page.locator('.viewbar').evaluate((e) => e.getBoundingClientRect().bottom);
  assert(Math.abs(top - barBottom) < 2, `${top} vs ${barBottom}`);
  assert(await page.locator('.titlebar [aria-label="Toggle scene pane"]').isDisabled(), 'pane toggle active');
  await page.screenshot({ path: path.join(os.tmpdir(), 'sw-r8-export.png') });
  await page.keyboard.press('Control+1');
  assert((await page.locator('.export').count()) === 0, 'Mod+1 did not leave export');
  await page.keyboard.press('Control+E');
  await page.waitForSelector('.main .export');
  await page.keyboard.press('Control+E');
  assert((await page.locator('.export').count()) === 0, 'second Mod+E did not close it');
});

await check('importing a numbered Fountain file offers to remove the numbers', async () => {
  const f = path.join(h.tmp, 'numbered.fountain');
  fs.writeFileSync(f, 'INT. ROOM - DAY #1#\n\nHello.\n\nEXT. YARD - NIGHT #2#\n\nBye.\n');
  await h.queueDialog(f);
  await app(() => window.__app.run('project.importFountain'));
  await page.waitForSelector('.dialog[aria-label="Written scene numbers"]');
  await page.click('.dialog[aria-label="Written scene numbers"] .btn.primary');
  await sleep(300);
  const t = await app(() => window.__app.editor.getText());
  assert(!/#\d+#/.test(t) && t.includes('INT. ROOM - DAY'), t);
});

await check('interface text is not selectable; the panes have shortcuts Mod+0 / Mod+Shift+0', async () => {
  const us = await app(() => getComputedStyle(document.querySelector('.outline .section-head')).userSelect);
  assert(us === 'none', us);
  const before = await app(() => window.__app.state.layout.leftVisible);
  await app(() => window.__app.editor.focus());
  await page.keyboard.press('Control+0');
  const after = await app(() => window.__app.state.layout.leftVisible);
  assert(before !== after, 'Mod+0 did nothing');
  await page.keyboard.press('Control+0');
});

console.log(results.map((r) => r.join(' — ')).join('\n'));
console.log('page errors:', JSON.stringify(h.errors.filter((e) => !e.includes('404'))));
await h.stop();
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
