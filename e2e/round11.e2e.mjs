// Feedback round 11: comments in Scene view, undo for annotations, export defaults from a template.
import os from 'os';
import path from 'path';
import { startHarness, assert, sleep } from './util.mjs';

const h = await startHarness();
const { page } = h;
const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); await page.screenshot({ path: path.join(os.tmpdir(), `r11-fail-${results.length}.png`) }); }
}
const app = (fn, ...a) => page.evaluate(fn, ...a);

await check('adding a comment in Scene view stays in Scene view', async () => {
  await app(() => {
    const a = window.__app;
    a.setView('scene');
    const sc = a.scenes.filter((s) => s.kind === 'scene')[0];
    a.enterScene(sc);
    const ed = a.editor;
    const i = ed.lines.findIndex((l, k) => k > sc.line && l.text.trim().length > 6);
    ed.setSelection({ anchor: { line: i, ch: 0 }, head: { line: i, ch: 5 } });
  });
  await page.keyboard.press('Control+Shift+M');
  await page.waitForSelector('.dialog textarea');
  await page.keyboard.type('Stay here.');
  await page.click('.dialog .btn.primary');
  await sleep(300);
  const view = await app(() => window.__app.view);
  assert(view === 'scene', 'view is ' + view);
});

await check('comment via the context menu and Mod+Enter in Scene view stays in Scene view', async () => {
  await app(() => {
    const a = window.__app;
    a.state.layout.rightVisible = false;
    a.applyLayout();
    a.setView('scene');
    const sc = a.scenes.filter((s) => s.kind === 'scene')[1];
    a.enterScene(sc);
    const ed = a.editor;
    const i = ed.lines.findIndex((l, k) => k > sc.line && l.text.trim().length > 6);
    ed.setSelection({ anchor: { line: i, ch: 0 }, head: { line: i, ch: 5 } });
  });
  const box = await app(() => {
    const ed = window.__app.editor;
    const r = ed.coordsAtPos({ line: ed.sel.head.line, ch: 2 });
    return r;
  });
  await page.mouse.click(box.left, box.top + 4, { button: 'right' });
  await sleep(150);
  const item = page.locator('.menu .menu-item:has-text("Comment")');
  if (await item.count()) await item.first().click();
  else await page.keyboard.press('Control+Shift+M');
  await page.waitForSelector('.dialog textarea');
  await page.keyboard.type('Second.');
  await page.keyboard.press('Control+Enter');
  await sleep(300);
  const view = await app(() => window.__app.view);
  assert(view === 'scene', 'view is ' + view);
});

await check('deleting a comment, resolving and highlighting can be undone and redone', async () => {
  await app(() => window.__app.setView('script'));
  const n0 = await app(() => window.__app.project.meta.comments.length);
  await app(() => {
    const a = window.__app;
    const ed = a.editor;
    const i = ed.lines.findIndex((l) => l.text.includes('Rain hammers'));
    ed.setSelection({ anchor: { line: i, ch: 0 }, head: { line: i, ch: 4 } });
    a.annotations.addComment('Undo me.', a.annotations.selectionAnchor());
    a.showRightTab('comments');
  });
  await sleep(200);
  const n1 = await app(() => window.__app.project.meta.comments.length);
  assert(n1 === n0 + 1, `${n0} → ${n1}`);
  await page.locator('.rv-comment:has-text("Undo me.") .btn:has-text("Delete")').click();
  await sleep(100);
  assert((await app(() => window.__app.project.meta.comments.length)) === n0, 'not deleted');
  await app(() => window.__app.run('edit.undo'));
  await sleep(100);
  assert((await app(() => window.__app.project.meta.comments.length)) === n1, 'delete not undone');
  assert((await page.locator('.rv-comment:has-text("Undo me.")').count()) === 1, 'card not back');
  assert(await app(() => { const a = window.__app; const c = a.project.meta.comments.find((x) => x.text === 'Undo me.'); return a.annotations.live.has(c.id); }), 'anchor not restored');
  await app(() => window.__app.run('edit.redo'));
  await sleep(100);
  assert((await app(() => window.__app.project.meta.comments.length)) === n0, 'delete not redone');
  await app(() => window.__app.run('edit.undo'));
  // Highlight, then undo it; then undo the comment itself.
  const hl0 = await app(() => window.__app.project.meta.highlights.length);
  await app(() => {
    const a = window.__app;
    const ed = a.editor;
    const i = ed.lines.findIndex((l) => l.text.includes('Rain hammers'));
    ed.setSelection({ anchor: { line: i, ch: 5 }, head: { line: i, ch: 12 } });
    a.annotations.highlight('yellow');
  });
  assert((await app(() => window.__app.project.meta.highlights.length)) === hl0 + 1, 'no highlight');
  await app(() => window.__app.run('edit.undo'));
  assert((await app(() => window.__app.project.meta.highlights.length)) === hl0, 'highlight not undone');
  await app(() => window.__app.run('edit.undo'));
  assert((await app(() => window.__app.project.meta.comments.length)) === n0, 'comment not undone');
});

await check('notes pane tabs sit at the right edge; export labels start 14 px in', async () => {
  await app(() => window.__app.showRightTab('history'));
  await sleep(100);
  const gap = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.rp-tabs .tab')];
    const last = tabs[tabs.length - 1];
    const r = document.createRange();
    r.selectNodeContents(last);
    return window.innerWidth - r.getBoundingClientRect().right;
  });
  assert(Math.abs(gap - 14) <= 1.5, 'gap ' + gap);
  await page.keyboard.press('Control+E');
  await page.waitForSelector('.export-side .form-row label');
  const x = await page.locator('.export-side .ex-section h3').first().evaluate((e) => e.getBoundingClientRect().left);
  assert(Math.abs(x - 14) <= 1, 'label x ' + x);
  const top = await page.locator('.export-side input[aria-label="topMarginPt"]').inputValue();
  assert(top === '72', 'top margin ' + top);
  await page.keyboard.press('Escape');
});

await check('Dialogue view export button has no ellipsis', async () => {
  await page.keyboard.press('Control+4');
  await sleep(100);
  const t = await page.textContent('.view-head .btn:has-text("Export")');
  assert(t === 'Export', t);
  await page.keyboard.press('Control+1');
});

console.log(results.map((r) => r.join(' — ')).join('\n'));
console.log('page errors:', JSON.stringify(h.errors.filter((e) => !e.includes('404'))));
await h.stop();
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
