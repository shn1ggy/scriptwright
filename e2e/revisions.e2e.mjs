// Export versions and revision marks against an earlier export.
import os from 'os';
import path from 'path';
import fs from 'fs';
import { startHarness, assert, sleep } from './util.mjs';

const h = await startHarness();
const { page } = h;
const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); await page.screenshot({ path: path.join(os.tmpdir(), `rev-fail-${results.length}.png`) }); }
}
const app = (fn, ...a) => page.evaluate(fn, ...a);
const meta = () => app(() => JSON.parse(JSON.stringify(window.__app.project.meta)));
const pdfText = async (file) => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), verbosity: 0 }).promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) out.push((await (await doc.getPage(i)).getTextContent()).items.map((x) => x.str).join(' '));
  return { pages: doc.numPages, text: out };
};

await check('every export saves a named copy with a note', async () => {
  await page.keyboard.press('Control+E');
  await page.waitForSelector('.export-preview canvas', { timeout: 15000 });
  await page.fill('input[aria-label="Version name"]', 'Producer draft');
  await page.fill('textarea[aria-label="Version note"]', 'Sent after the table read');
  await h.queueDialog(path.join(h.tmp, 'v1.pdf'));
  await page.click('.export-side .btn.primary');
  await sleep(1200);
  const m = await meta();
  assert(m.exports.length === 1 && m.exports[0].name === 'Producer draft' && m.exports[0].note === 'Sent after the table read', JSON.stringify(m.exports));
  assert(fs.existsSync(path.join(h.ws, 'The Long Night', '.scriptwright', 'exports', `${m.exports[0].id}.fountain`)), 'copy missing');
  await page.keyboard.press('Escape');
});

await check('changes since that export are marked; moved scenes are not', async () => {
  await app(() => {
    const a = window.__app;
    const ed = a.editor;
    const i = ed.lines.findIndex((l) => l.text === "Who's there?");
    ed.setSelection({ anchor: { line: i, ch: 12 }, head: { line: i, ch: 12 } });
    ed.insertText(' Speak up!');
    const sc = a.scenes.filter((s) => s.kind === 'scene');
    a.moveScene(sc[2], sc[0], false);
  });
  await page.keyboard.press('Control+E');
  await page.waitForSelector('.export-preview canvas', { timeout: 15000 });
  const opts = await page.locator('select[aria-label="Mark changes since"] option').allTextContents();
  assert(opts.some((o) => o.startsWith('Producer draft')), JSON.stringify(opts));
  const value = await page.locator('select[aria-label="Mark changes since"] option:has-text("Producer draft")').getAttribute('value');
  await page.selectOption('select[aria-label="Mark changes since"]', value);
  await sleep(1500);
  const summary = await page.locator('.ex-section:has-text("Mark changes") .capacity').last().textContent();
  assert(/1 marked line/.test(summary) && /1 moved \(not marked\)/.test(summary), summary);
  await page.screenshot({ path: path.join(os.tmpdir(), 'sw-rev-panel.png') });
  await h.queueDialog(path.join(h.tmp, 'v2.pdf'));
  await page.click('.export-side .btn.primary');
  await sleep(1200);
  const pdf = await pdfText(path.join(h.tmp, 'v2.pdf'));
  const all = pdf.text.join('\n').replace(/[ \t]+/g, ' ');
  assert(all.includes('Changes since “Producer draft”'), 'header note missing: ' + pdf.text.slice(0, 3).join(' | ').slice(0, 400));
  assert(/\*/.test(all), 'margin mark missing');
  const m = await meta();
  assert(m.exports.length === 2 && m.exports[0].comparedWith === '“Producer draft”', JSON.stringify(m.exports.map((e) => e.comparedWith)));
  await page.keyboard.press('Escape');
});

await check('strict order marks moved scenes; changed pages only', async () => {
  await page.keyboard.press('Control+E');
  await page.waitForSelector('.export-preview canvas', { timeout: 15000 });
  const value = await page.locator('select[aria-label="Mark changes since"] option:has-text("Producer draft")').getAttribute('value');
  await page.selectOption('select[aria-label="Mark changes since"]', value);
  await sleep(800);
  await page.click('label:has-text("Ignore scene order")');
  await sleep(1500);
  const summary = await page.locator('.ex-section:has-text("Mark changes") .capacity').last().textContent();
  const n = Number(/(\d+) marked line/.exec(summary)[1]);
  assert(n > 3, summary);
  await page.click('label:has-text("Ignore scene order")');
  await page.click('label:has-text("Only pages with changes")');
  await sleep(1500);
  const info = await page.locator('.export-side .foot .muted').textContent();
  assert(/^1 page /.test(info) && !info.includes('title page'), info);
  await page.screenshot({ path: path.join(os.tmpdir(), 'sw-rev-preview.png') });
  await page.keyboard.press('Escape');
});

await check('exported versions are listed in History with notes and comparison', async () => {
  await app(() => window.__app.run('view.history'));
  await page.waitForSelector('.hist-row');
  const items = await page.locator('.hist-row:has-text("Producer draft")').count();
  assert(items >= 1, String(items));
  await page.locator('.hist-row:has(.hist-name:text-is("Producer draft"))').click();
  await page.waitForSelector('.cmp-list .chip');
  const chips = await page.locator('.cmp-list .chip').allTextContents();
  assert(chips.includes('Moved') && chips.includes('Changed'), JSON.stringify(chips));
  await page.keyboard.press('Escape');
});

console.log(results.map((r) => r.join(' — ')).join('\n'));
console.log('page errors:', JSON.stringify(h.errors.filter((e) => !e.includes('404'))));
await h.stop();
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
