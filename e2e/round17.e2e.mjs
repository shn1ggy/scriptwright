// Round 17: locked pages and revision colours, sides, reports and breakdown, PDF import.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { startHarness, assert, sleep } from './util.mjs';

const h = await startHarness();
const { page } = h;
const results = [];
const shots = process.env.SHOTS;
async function check(name, fn) {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); await page.screenshot({ path: path.join(os.tmpdir(), `r17-fail-${results.length}.png`) }); }
}
const app = (fn, ...a) => page.evaluate(fn, ...a);
await page.setViewportSize({ width: 1400, height: 900 });

// A screenplay long enough for many pages.
await app(() => {
  const a = window.__app;
  const out = ['Title: The Long Night', 'Author: Test', ''];
  for (let k = 1; k <= 30; k++) {
    out.push(`INT. ROOM ${k} - NIGHT`, '', `Lisa walks into room ${k}. Rain against the window, a lamp that flickers, a radio playing low.`, '');
    out.push('LISA', `Hello? Is anyone in room ${k}? I saw the light from the street and the door was open.`, '');
    out.push('TOM (O.S.)', 'Up here. Mind the stairs.', '');
  }
  a.editor.setText(out.join('\n'));
  a.refreshDerived(true);
  a.outline.refresh();
});
await sleep(400);

const confirm = async () => {
  await page.locator('.dialog .btn.primary').click();
  await sleep(500);
};

await check('pages lock with scene numbers; changes go to A pages and keep later numbers', async () => {
  const before = await app(() => window.__app.pagination().pages.filter((p) => !p.title).length);
  await app(() => window.__app.run('production.lockPages'));
  await sleep(300);
  if (shots) await page.screenshot({ path: path.join(shots, 'lock-dialog.png') });
  await confirm();
  await page.waitForFunction(() => !!window.__app.project.meta.production, null, { timeout: 5000 });
  const pr = await app(() => window.__app.project.meta.production);
  assert(pr.pageStarts.length === before, `${pr.pageStarts.length} vs ${before}`);
  assert(await app(() => window.__app.numbersLocked), 'numbers not locked');
  // Lots of new action in scene 3.
  await app(() => {
    const a = window.__app;
    const sc = a.editor.parsed.scenes[2];
    a.editor.edit((tx) => {
      const lines = Array.from({ length: 30 }, (_, k) => ({ key: 8e6 + k, text: k % 2 ? '' : `New material line ${k} that makes the page longer than it was when it went out.` }));
      tx.insertLines(sc.line + 2, lines);
      return a.editor.sel;
    });
    a.refreshDerived(true);
  });
  await sleep(300);
  const labels = await app(() => window.__app.pagination().pages.filter((p) => !p.title).map((p) => p.label));
  assert(labels.some((l) => /^\d+A$/.test(l)), labels.join(' '));
  assert(labels[labels.length - 1] === String(before), `last ${labels[labels.length - 1]} vs ${before}`);
});

await check('the export marks the blue revision and names it in the header', async () => {
  await app(() => window.__app.openPanel('export'));
  await sleep(500);
  const val = await page.locator('select[aria-label="Mark changes since"]').inputValue();
  assert(val === 'production', `baseline ${val}`);
  await page.waitForSelector('.export-preview canvas', { timeout: 20000 });
  await sleep(1500);
  const summary = await page.locator('.export-side').textContent();
  assert(/marked line/.test(summary), 'no revision summary');
  assert(/Pages locked on/.test(summary), 'no production summary');
  if (shots) await page.screenshot({ path: path.join(shots, 'export-production.png') });
  const out = path.join(h.tmp, 'blue.pdf');
  await h.queueDialog(out);
  await page.locator('.export-side .btn.primary', { hasText: 'Export PDF' }).click();
  await page.waitForFunction(() => !document.querySelector('.export-side .btn.primary[disabled]'), null, { timeout: 20000 });
  await sleep(1500);
  assert(fs.existsSync(out), 'no PDF');
  if (shots) fs.copyFileSync(out, path.join(shots, 'blue.pdf'));
});

await check('the next revision round is pink', async () => {
  await page.locator('.export-side .btn', { hasText: 'Start pink revision' }).click();
  await sleep(300);
  await confirm();
  const n = await app(() => window.__app.project.meta.production.rounds.length);
  assert(n === 2, `rounds ${n}`);
  await app(() => window.__app.closePanel());
});

await check('sides of two scenes with a cover sheet', async () => {
  await app(() => {
    const a = window.__app;
    const ids = a.scenes.filter((x) => x.kind === 'scene').slice(4, 6).map((x) => x.id);
    a.setSceneSelection(ids, ids[0]);
    a.run('production.sides');
  });
  await sleep(500);
  const scope = await page.locator('select[aria-label="What to export"]').inputValue();
  assert(scope === 'sides', scope);
  const checked = await page.locator('.scene-pick input:checked').count();
  assert(checked === 2, `checked ${checked}`);
  await page.waitForSelector('.export-preview canvas', { timeout: 20000 });
  await sleep(1500);
  const n = await page.locator('.export-preview canvas').count();
  assert(n >= 2 && n <= 4, `pages ${n}`);
  if (shots) {
    await page.locator('.export-preview').evaluate((e) => (e.scrollTop = 0));
    await page.screenshot({ path: path.join(shots, 'sides.png') });
    const out = path.join(h.tmp, 'sides.pdf');
    await h.queueDialog(out);
    await page.locator('.export-side .btn.primary', { hasText: 'Export PDF' }).click();
    await sleep(2500);
    if (fs.existsSync(out)) fs.copyFileSync(out, path.join(shots, 'sides.pdf'));
  }
  await app(() => window.__app.closePanel());
});

await check('tagging a prop marks every mention and shows in the breakdown', async () => {
  await app(() => {
    const a = window.__app;
    a.editor.edit((tx) => {
      const sc = a.editor.parsed.scenes;
      tx.setLine(sc[1].line + 2, 'Lisa finds a RED UMBRELLA by the door. Rain against the window.');
      tx.setLine(sc[7].line + 2, 'Tom holds the red umbrella over his head.');
      return a.editor.sel;
    });
    a.refreshDerived(true);
    const line = a.editor.parsed.scenes[1].line + 2;
    const text = a.editor.lines[line].text;
    const ch = text.indexOf('RED UMBRELLA');
    a.editor.setSelection({ anchor: { line, ch }, head: { line, ch: ch + 12 } });
    a.run('production.tag');
  });
  await sleep(200);
  await page.locator('.menu [role="menuitem"]', { hasText: 'Props' }).click();
  await sleep(300);
  await page.locator('.toast .btn', { hasText: 'Tag the other mention' }).click();
  await sleep(300);
  const tags = await app(() => window.__app.project.meta.tags.map((t) => [t.category, t.name]));
  assert(tags.length === 2 && tags.every((x) => x[0] === 'props'), JSON.stringify(tags));
  assert((await page.locator('.deco-tag.tag-props').count()) >= 1, 'no tag decoration');
  if (shots) {
    await app(() => { const a = window.__app; a.editor.setSelection({ anchor: { line: a.editor.parsed.scenes[1].line, ch: 0 }, head: { line: a.editor.parsed.scenes[1].line, ch: 0 } }); a.editor.revealSelection?.(); });
    await sleep(300);
    await page.screenshot({ path: path.join(shots, 'tags-text.png'), clip: { x: 280, y: 80, width: 820, height: 380 } });
    await app(() => window.__app.run('production.tag'));
    await sleep(300);
    await page.screenshot({ path: path.join(shots, 'tag-menu.png') });
    await page.keyboard.press('Escape');
  }
  await app(() => window.__app.openPanel('reports'));
  await sleep(400);
  await page.locator('.reports .seg-btn[data-mode="breakdown"]').click();
  await sleep(300);
  const sheet = await page.locator('.rep-sheet').nth(1).textContent();
  assert(/Props/.test(sheet) && /RED UMBRELLA/.test(sheet), sheet);
  if (shots) await page.screenshot({ path: path.join(shots, 'reports-breakdown.png') });
  await page.locator('.reports .seg-btn[data-mode="scenes"]').click();
  await sleep(300);
  const rows = await page.locator('.rep-table tbody tr').count();
  assert(rows === 30, `rows ${rows}`);
  const first = await page.locator('.rep-table tbody tr').first().textContent();
  assert(/ROOM 1/.test(first) && /NIGHT/.test(first) && /LISA/.test(first), first);
  if (shots) await page.screenshot({ path: path.join(shots, 'reports-scenes.png') });
  await page.locator('.reports .seg-btn[data-mode="cast"]').click();
  await sleep(200);
  if (shots) await page.screenshot({ path: path.join(shots, 'reports-cast.png') });
  const cast = await page.locator('.rep-table tbody tr').first().textContent();
  assert(/LISA/.test(cast) && /30/.test(cast), cast);
  await page.locator('.reports .seg-btn[data-mode="locations"]').click();
  await sleep(200);
  if (shots) await page.screenshot({ path: path.join(shots, 'reports-locations.png') });
  await page.locator('.reports .seg-btn[data-mode="elements"]').click();
  await sleep(200);
  assert(/RED UMBRELLA/.test(await page.locator('.reports').textContent()), 'element missing');
  if (shots) await page.screenshot({ path: path.join(shots, 'reports-elements.png') });
  // The scene report as PDF and CSV for the production office.
  await page.locator('.reports .seg-btn[data-mode="scenes"]').click();
  const pdf = path.join(h.tmp, 'scenes.pdf');
  await h.queueDialog(pdf);
  await page.locator('.reports .btn', { hasText: 'Export PDF' }).click();
  await sleep(800);
  assert(fs.readFileSync(pdf).subarray(0, 5).toString() === '%PDF-', 'no PDF written');
  if (shots) fs.copyFileSync(pdf, path.join(shots, 'report-scenes.pdf'));
  const csv = path.join(h.tmp, 'scenes.csv');
  await h.queueDialog(csv);
  await page.locator('.reports .btn', { hasText: 'Export CSV' }).click();
  await sleep(500);
  const rowsCsv = fs.readFileSync(csv, 'utf8').trim().split(/\r?\n/);
  assert(rowsCsv.length === 31 && /ROOM 1/.test(rowsCsv[1]), rowsCsv.slice(0, 2).join(' | '));
  await app(() => window.__app.closePanel());
});

console.log(results.map((r) => r.join(' — ')).join('\n'));
console.log('page errors:', JSON.stringify(h.errors.filter((e) => !e.includes('404'))));
await h.stop();
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
