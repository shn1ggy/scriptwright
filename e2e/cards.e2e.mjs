// Scene cards and outline keyboard reordering.
import { startHarness, assert, sleep } from './util.mjs';
const h = await startHarness();
const { page } = h;
const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); }
}
const app = (fn, ...a) => page.evaluate(fn, ...a);
const headings = () => app(() => window.__app.scenes.filter((s) => s.kind === 'scene').map((s) => s.heading));

await check('cards show the outline order; keyboard moves the selected card', async () => {
  await page.keyboard.press('Control+Shift+O');
  await page.waitForSelector('.card');
  const n = await page.locator('.card').count();
  assert(n === 3, String(n));
  // select first card and move it right
  await page.click('.card >> nth=0');
  await page.keyboard.press('Alt+Shift+ArrowRight');
  const hs = await headings();
  assert(hs[1] === 'INT. LIGHTHOUSE - NIGHT', JSON.stringify(hs));
  const sel = await page.locator('.card.selected .card-heading').textContent();
  assert(sel === 'INT. LIGHTHOUSE - NIGHT', sel);
});

await check('global shortcuts keep working while cards or search are open', async () => {
  await page.keyboard.press('Control+S');
  await sleep(200);
  const st = await page.locator('.save-state').textContent();
  assert(st === 'Saved', st);
  // Esc no longer leaves Cards (it clears the selection); the Script tab does.
  await page.keyboard.press('Escape');
  assert((await page.locator('.cards:not(.hidden)').count()) === 1, 'Esc closed cards');
  assert((await page.locator('.card.selected').count()) === 0, 'selection kept');
  await page.click('.viewbar .tab:text-is("Script")');
  const open = await page.locator('.cards:not(.hidden)').count();
  assert(open === 0, 'cards still open');
});

await check('outline list: Alt+Shift+arrows move the selected row, not the caret scene', async () => {
  await app(() => { const a = window.__app; a.goToScene(a.scenes.filter((s) => s.kind === 'scene')[0]); });
  const before = await headings();
  await page.click('.outline .row:has-text("INT. LIGHTHOUSE - STAIRWELL")');
  await app(() => document.querySelector('.outline .list').focus());
  await page.keyboard.press('Alt+Shift+ArrowUp');
  const after = await headings();
  assert(after[1] === 'INT. LIGHTHOUSE - STAIRWELL - NIGHT', JSON.stringify([before, after]));
});

console.log(results.map((r) => r.join(' — ')).join('\n'));
console.log('page errors:', JSON.stringify(h.errors.filter((e) => !e.includes('404'))));
await h.stop();
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
