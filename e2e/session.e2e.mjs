// Session restore, recovery, damaged information, sync copies, backups, missing files.
import os from 'os';
import { startHarness, assert, sleep } from './util.mjs';
import fs from 'fs';
import path from 'path';

const h = await startHarness();
const { page } = h;
const results = [];
async function check(name, fn) {
  console.log('… ' + name);
  try {
    await fn();
    results.push(['PASS', name]);
  } catch (e) {
    results.push(['FAIL', name, e.message]);
    await page.screenshot({ path: path.join(os.tmpdir(), `session-fail-${results.length}.png`) });
  }
}
const app = (fn, ...a) => page.evaluate(fn, ...a);
const proj = path.join(h.ws, 'The Long Night');
const file = path.join(proj, 'The Long Night.fountain');
const reload = async () => {
  await page.reload();
  await page.waitForFunction(() => window.__app && window.__app.ready);
  await sleep(300);
};

await check('view, scene and caret are restored after restarting', async () => {
  await app(() => { const a = window.__app; const s = a.scenes.filter((x) => x.kind === 'scene')[1]; a.setView('scene'); a.enterScene(s); a.editor.setSelection({ anchor: { line: s.line + 2, ch: 5 }, head: { line: s.line + 2, ch: 5 } }); });
  const before = await app(() => [window.__app.editor.sel.head, window.__app.focusedItem().heading]);
  await app(() => window.__app.saveStateNow());
  await reload();
  const after = await app(() => [window.__app.view, window.__app.editor.sel.head, window.__app.focusedItem()?.heading]);
  assert(after[0] === 'scene', after[0]);
  assert(after[2] === before[1], `${after[2]} vs ${before[1]}`);
  assert(after[1].line === before[0].line && after[1].ch === before[0].ch, JSON.stringify(after[1]));
});

await check('pane sizes and visibility are remembered', async () => {
  await app(() => { const a = window.__app; a.state.layout.leftWidth = 300; a.state.layout.rightVisible = true; a.applyLayout(); return a.saveStateNow(); });
  await reload();
  const w = await app(() => [document.querySelector('.pane-left').getBoundingClientRect().width, getComputedStyle(document.querySelector('.pane-right')).display]);
  assert(Math.round(w[0]) === 300 && w[1] !== 'none', JSON.stringify(w));
});

await check('unsaved work is offered for recovery after a crash', async () => {
  const id = await app(() => window.__app.project.meta.id);
  const text = fs.readFileSync(file, 'utf8') + '\n\nRECOVERED LINE.';
  await app(([id, text]) => fetch('/api', { method: 'POST', body: JSON.stringify({ method: 'writeRecovery', args: [id, 'The Long Night', text] }) }), [id, text]);
  await reload();
  await page.waitForSelector('.dialog');
  const title = await page.locator('.dialog-head span').first().textContent();
  assert(title === 'Unsaved work found', title);
  await page.click('.dialog .btn.primary'); // Restore
  await sleep(200);
  const t = await app(() => window.__app.editor.getText());
  assert(t.includes('RECOVERED LINE.'), 'not restored');
  await sleep(1500);
  assert(fs.readFileSync(file, 'utf8').includes('RECOVERED LINE.'), 'restored text not saved');
});

await check('damaged project information does not prevent opening the screenplay', async () => {
  await app(() => window.__app.closeProject());
  fs.writeFileSync(path.join(proj, '.scriptwright', 'project.json'), '{"oops":');
  await app(() => window.__app.openProject('The Long Night'));
  await sleep(200);
  const t = await app(() => window.__app.editor.getText());
  assert(t.includes('INT. LIGHTHOUSE - NIGHT'), 'screenplay not open');
  const toast = await page.locator('.toast').textContent();
  assert(/damaged/.test(toast), toast);
  assert(fs.readdirSync(path.join(proj, '.scriptwright')).some((f) => f.startsWith('project.json.damaged-')), 'damaged copy not kept');
});

await check('a sync conflict copy appearing next to the screenplay is reported and reviewable', async () => {
  fs.writeFileSync(path.join(proj, "The Long Night (Nico's conflicted copy 2026-10-13).fountain"), fs.readFileSync(file, 'utf8') + '\nOther computer line.');
  await page.waitForSelector('.banner', { timeout: 6000 });
  const text = await page.locator('.banner .text').textContent();
  assert(/copy/.test(text), text);
  await page.click('.banner .btn:has-text("Review")');
  await page.waitForSelector('.dialog');
  await page.click('.dialog .btn:has-text("Archive")');
  await sleep(500);
  assert(!fs.readdirSync(proj).some((f) => f.includes('conflicted copy')), 'not archived');
  assert(fs.readdirSync(path.join(proj, '.scriptwright', 'conflicts')).some((f) => f.includes('conflicted copy')), 'archive missing');
});

await check('a deleted screenplay file is reported and can be saved again', async () => {
  await sleep(300);
  fs.unlinkSync(file);
  await page.waitForSelector('.banner .btn:has-text("Save here again")', { timeout: 6000 });
  const st = await page.locator('.save-state').textContent();
  assert(st === 'File missing', st);
  await page.click('.banner .btn:has-text("Save here again")');
  await sleep(300);
  assert(fs.existsSync(file), 'file not restored');
});

await check('backup and import keep all project information', async () => {
  const zip = path.join(h.tmp, 'backup.zip');
  await app(() => { const a = window.__app; const s = a.scenes.filter((x) => x.kind === 'scene')[0]; a.updateSceneRecord(s, { summary: 'Backed up summary' }); });
  await h.queueDialog(zip);
  await app(() => window.__app.run('project.backup'));
  await sleep(800);
  assert(fs.existsSync(zip), 'zip not written');
  await h.queueDialog(zip);
  await app(() => window.__app.run('project.importBackup'));
  await sleep(1000);
  const name = await app(() => window.__app.project.name);
  assert(/imported/.test(name), name);
  const rec = await app(() => window.__app.scenes.filter((s) => s.kind === 'scene')[0].record?.summary);
  assert(rec === 'Backed up summary', rec);
});

await check('new project via the projects pane starts with a title page and a scene', async () => {
  await page.click('.projects .section-head .icon-btn[title="New project"]');
  await page.waitForSelector('.dialog input');
  await page.fill('.dialog input', 'Zweiter Film');
  await page.keyboard.press('Enter');
  await sleep(600);
  const r = await app(() => [window.__app.project.name, window.__app.scenes.map((s) => s.kind)]);
  assert(r[0] === 'Zweiter Film', r[0]);
  assert(r[1].includes('title') && r[1].includes('scene'), JSON.stringify(r[1]));
  assert(fs.existsSync(path.join(h.ws, 'Zweiter Film', 'Zweiter Film.fountain')), 'file missing');
});

await check('external heading edit while clean keeps scene information', async () => {
  await app(() => { window.__app.openProject('The Long Night'); });
  await sleep(1500);
  const dlg = await page.locator('.dialog-head span').first().textContent().catch(() => null);
  assert(!dlg, 'unexpected dialog: ' + dlg);
  await app(() => { const a = window.__app; const s = a.scenes.find((x) => x.heading === 'EXT. HARBOUR - CONTINUOUS'); a.updateSceneRecord(s, { notes: 'Harbour notes' }); return a.saveMetaNow(); });
  const t = fs.readFileSync(file, 'utf8').replace('EXT. HARBOUR - CONTINUOUS', 'EXT. HARBOUR - LATER');
  fs.writeFileSync(file, t);
  await sleep(2800);
  const rec = await app(() => window.__app.scenes.find((x) => x.heading === 'EXT. HARBOUR - LATER')?.record?.notes);
  assert(rec === 'Harbour notes', String(rec));
});

console.log(results.map((r) => r.join(' — ')).join('\n'));
console.log('page errors:', JSON.stringify(h.errors.filter((e) => !e.includes('404'))));
await h.stop();
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
