// Round 19: highlights, comments and rewrites in documents; the documents' typeface; the bottom
// row (workspace switcher and status line) and the export foot.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { startHarness, assert, sleep } from './util.mjs';

const h = await startHarness();
const { page } = h;
const results = [];
const shots = process.env.SHOTS;
async function check(name, fn) {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); await page.screenshot({ path: path.join(os.tmpdir(), `r19-fail-${results.length}.png`) }); }
}
const app = (fn, ...a) => page.evaluate(fn, ...a);
await page.setViewportSize({ width: 1280, height: 800 });
const projectDir = path.join(h.ws, 'The Long Night');
const docText = () => app(() => window.__app.docs.docEditor.getText());
const rec = () => app(() => JSON.parse(JSON.stringify(window.__app.project.meta.documents[0])));
/** Selects the first occurrence of a phrase in the document. */
const select = (phrase) => app((p) => {
  const ed = window.__app.docs.docEditor;
  const i = ed.lines.findIndex((l) => l.text.includes(p));
  const ch = ed.lines[i].text.indexOf(p);
  ed.setSelection({ anchor: { line: i, ch }, head: { line: i, ch: ch + p.length } });
  ed.focus();
}, phrase);

await check('the status line and the workspace switcher share one bottom row', async () => {
  const ws = await page.locator('.workspace-bar').boundingBox();
  const st = await page.locator('.statusbar').boundingBox();
  assert(Math.abs(ws.y - st.y) < 1 && Math.abs(ws.height - st.height) < 1, `workspace ${ws.y}/${ws.height}, status ${st.y}/${st.height}`);
  const mid = (b) => b.y + b.height / 2;
  const a = await page.locator('.ws-switch .ws-name').boundingBox();
  const b = await page.locator('.statusbar .count').boundingBox();
  assert(Math.abs(mid(a) - mid(b)) <= 1, `text centres ${mid(a)} / ${mid(b)}`);
});

await check('the export foot keeps one rhythm: line, page count, button, edge', async () => {
  await app(() => window.__app.openPanel('export'));
  await sleep(1200);
  const g = await app(() => {
    const f = document.querySelector('.export-side .foot').getBoundingClientRect();
    const p = document.querySelector('.export-side .foot .page-info').getBoundingClientRect();
    const b = document.querySelector('.export-side .foot .btn.primary').getBoundingClientRect();
    return { top: p.top - f.top, mid: b.top - p.bottom, bottom: f.bottom - b.bottom };
  });
  assert(Math.max(g.top, g.mid, g.bottom) - Math.min(g.top, g.mid, g.bottom) <= 3, JSON.stringify(g));
  await app(() => window.__app.closePanel());
});

await check('a document gets highlights that stay through closing and opening it', async () => {
  await page.locator('.documents .section-head .icon-btn').first().click();
  await page.locator('.menu [role="menuitem"]', { hasText: 'Exposé' }).click();
  await sleep(400);
  await page.keyboard.type('# Logline\n\nLisa, 41, sends out one more application.\n\nShe gets the job, but not the one she wanted.\n');
  await sleep(300);
  await select('one more');
  await app(() => window.__app.highlight('yellow'));
  await sleep(200);
  const r = await rec();
  assert(r.highlights?.length === 1, 'no highlight record');
  assert((await page.locator('.ed-prose .deco-hl-yellow').count()) > 0, 'not painted');
  assert(!(await app(() => window.__app.project.meta.highlights.length)), 'landed in the screenplay');
  // Undo and redo in the document.
  await page.keyboard.press('Control+Z');
  await sleep(150);
  assert((await rec()).highlights.length === 0, 'undo kept it');
  await page.keyboard.press('Control+Y');
  await sleep(150);
  assert((await rec()).highlights.length === 1, 'redo lost it');
  // Back to the script and in again: it is found in the text.
  await page.locator('.viewbar .tab', { hasText: 'Script' }).click();
  await sleep(300);
  assert((await page.locator('.ed-scroller:not(.ed-prose) .deco-hl-yellow').count()) === 0, 'painted in the screenplay');
  await page.locator('.documents .doc-row').first().click();
  await sleep(400);
  assert((await page.locator('.ed-prose .deco-hl-yellow').count()) > 0, 'gone after reopening');
});

await check('a comment on a document shows in the Review pane under the document', async () => {
  await select('gets the job');
  await page.keyboard.press('Control+Shift+M');
  await sleep(300);
  await page.locator('.dialog textarea').fill('Which job?');
  await page.locator('.dialog .btn.primary').click();
  await sleep(400);
  const r = await rec();
  assert(r.comments?.length === 1 && r.comments[0].text === 'Which job?', 'no comment');
  assert(r.comments[0].sceneHeading === 'Logline', `heading ${r.comments[0].sceneHeading}`);
  assert((await page.locator('.ed-prose .deco-comment').count()) > 0, 'not marked');
  const pane = await page.locator('.pane-right').textContent();
  assert(pane.includes('In “Exposé”') && pane.includes('Which job?'), 'not in the pane');
  if (shots) await page.screenshot({ path: path.join(shots, 'doc-comment.png') });
  // The screenplay's own comments come back with the screenplay.
  await page.locator('.viewbar .tab', { hasText: 'Script' }).click();
  await sleep(300);
  assert(!(await page.locator('.pane-right').textContent()).includes('Which job?'), 'document comment shown for the screenplay');
  await page.locator('.documents .doc-row').first().click();
  await sleep(300);
});

await check('a passage in a document gets a second version and swaps it in', async () => {
  await select('She gets the job, but not the one she wanted.');
  await page.keyboard.press('Alt+A');
  await sleep(300);
  assert(await page.locator('.rewrite-dialog').isVisible(), 'no rewrite dialog');
  assert((await page.locator('.rewrite-dialog').textContent()).includes('in document'), 'wording');
  await page.locator('.rewrite-dialog .rw-text').fill('She gets a job. Not the one she wanted.');
  await page.locator('.rewrite-dialog .btn', { hasText: 'Use this version' }).click();
  await sleep(300);
  await page.keyboard.press('Escape');
  await sleep(200);
  assert((await docText()).includes('She gets a job. Not the one she wanted.'), 'not swapped in');
  const r = await rec();
  assert(r.passages?.length === 1 && r.passages[0].alternatives.length === 2, 'passage record');
  await sleep(1500);
  assert(fs.readFileSync(path.join(projectDir, 'Exposé.txt'), 'utf8').includes('She gets a job.'), 'file not saved');
  // Saved project information keeps the document's records.
  await app(() => window.__app.saveMetaNow());
  const raw = fs.readFileSync(path.join(projectDir, '.scriptwright', 'project.json'), 'utf8');
  assert(raw.includes('Which job?'), 'comment not saved');
});

await check('the … menu sets the documents in serif, sans or the screenplay’s monospace', async () => {
  const font = () => app(() => getComputedStyle(window.__app.docs.docEditor.dom).getPropertyValue('--ed-font'));
  assert(/Iowan|Charter/.test(await font()), 'not serif first');
  const pick = async (label) => {
    await page.locator('.documents .section-head .icon-btn').nth(1).click();
    await page.locator('.menu [role="menuitem"]').filter({ hasText: new RegExp(`^[\\s✓]*${label}`) }).click();
    await sleep(200);
  };
  await pick('Sans Serif');
  assert(/Segoe UI/.test(await font()), await font());
  assert((await app(() => window.__app.project.meta.docFont)) === 'sans', 'not stored');
  if (shots) await page.screenshot({ path: path.join(shots, 'doc-sans.png') });
  await pick('Monospace');
  assert(/Courier Prime/.test(await font()), await font());
  await pick('Serif');
  assert(/Iowan|Charter/.test(await font()), 'serif not back');
  assert((await app(() => window.__app.project.meta.docFont)) === undefined, 'serif stored');
});

console.log(results.map((r) => r.join(' — ')).join('\n'));
console.log('page errors:', JSON.stringify(h.errors.filter((e) => !e.includes('404'))));
await h.stop();
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
