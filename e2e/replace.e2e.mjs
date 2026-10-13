// Find & Replace in the find bar.
import os from 'os';
import path from 'path';
import { startHarness, assert, sleep } from './util.mjs';

const h = await startHarness();
const { page } = h;
const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); await page.screenshot({ path: path.join(os.tmpdir(), `replace-fail-${results.length}.png`) }); }
}
const app = (fn, ...a) => page.evaluate(fn, ...a);
const text = () => app(() => window.__app.editor.lines.map((l) => l.text).join('\n'));
const SCRIPT = 'INT. KITCHEN - DAY\n\nAndrea makes coffee.\n\nANDREA\nWhere is Ben?\n\nEXT. GARDEN - NIGHT\n\nBen waits for andrea.\n\nBEN\nAndrea! Andreas Hut ist hier.\n';

await app(async (t) => {
  const a = window.__app;
  a.setView('script');
  await a.replaceAllText(t, null);
  a.editor.setSelection({ anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 0 } });
  a.editor.focus();
}, SCRIPT);
await sleep(200);

await check('Mod+Alt+F opens the replace row', async () => {
  await page.keyboard.press('Control+Alt+F');
  await page.waitForSelector('.findbar:not(.hidden) input[aria-label="Replace with"]');
  assert(await page.isVisible('input[aria-label="Replace with"]'), 'replace field hidden');
  await page.screenshot({ path: path.join(os.tmpdir(), 'sw-replace-open.png') });
});

await check('Replace walks results one at a time, preserving case', async () => {
  await page.fill('input[aria-label="Find in screenplay"]', 'andrea');
  await sleep(100);
  const count = await page.locator('.findbar-count').textContent();
  assert(/of 5$/.test(count), count);
  await page.fill('input[aria-label="Replace with"]', 'Maria');
  await page.focus('input[aria-label="Replace with"]');
  await page.keyboard.press('Enter'); // selects the first result
  await page.keyboard.press('Enter'); // replaces it
  let t = await text();
  assert(t.includes('Maria makes coffee.') && t.includes('\nANDREA\n'), t);
  await page.keyboard.press('Enter'); // replaces the cue
  t = await text();
  assert(t.includes('\nMARIA\n'), t);
  const count2 = await page.locator('.findbar-count').textContent();
  assert(/of 3$/.test(count2), count2);
});

await check('Replace All is one undo step and reports the count', async () => {
  await page.click('.findbar-opt[title^="Whole words"]');
  await sleep(100);
  const count = await page.locator('.findbar-count').textContent();
  assert(/of 2$/.test(count), 'whole word should skip "Andreas": ' + count);
  await page.focus('input[aria-label="Replace with"]');
  await page.keyboard.press('Control+Enter');
  await sleep(150);
  const t = await text();
  assert(t.includes('Ben waits for maria.') && t.includes('Maria! Andreas Hut'), t);
  const toastText = await page.locator('.toast').last().textContent();
  assert(/Replaced 2 occurrences\./.test(toastText), toastText);
  await page.locator('.toast').last().locator('button:has-text("Undo")').click();
  const t2 = await text();
  assert(t2.includes('Ben waits for andrea.') && t2.includes('Maria makes coffee.'), t2);
  await page.click('.findbar-opt[title^="Whole words"]');
});

await check('regular expressions with groups', async () => {
  await page.click('.findbar-opt[title^="Regular expression"]');
  await page.fill('input[aria-label="Find in screenplay"]', '^(INT|EXT)\\. (\\w+) - (DAY|NIGHT)$');
  await page.fill('input[aria-label="Replace with"]', '$1. $2 -- $3');
  await page.click('.findbar-opt[title^="Preserve case"]');
  await page.focus('input[aria-label="Replace with"]');
  await page.keyboard.press('Control+Enter');
  await sleep(150);
  const t = await text();
  assert(t.startsWith('INT. KITCHEN -- DAY') && t.includes('EXT. GARDEN -- NIGHT'), t);
  await page.fill('input[aria-label="Find in screenplay"]', '(');
  const c = await page.locator('.findbar-count').textContent();
  assert(c === 'Invalid pattern', c);
  await page.click('.findbar-opt[title^="Regular expression"]');
  await page.click('.findbar-opt[title^="Preserve case"]');
});

await check('Dialogue view only replaces the lines it shows', async () => {
  await page.keyboard.press('Escape');
  await app(() => {
    const a = window.__app;
    a.editor.setText('INT. ROOM - DAY\n\nBen sits.\n\nBEN\nBen is here.\n');
    a.setView('dialogue');
  });
  await sleep(300);
  const shown = await app(() => window.__app.editor.displayedLines.length);
  await page.keyboard.press('Control+Alt+F');
  await page.fill('input[aria-label="Find in screenplay"]', 'Ben');
  await page.fill('input[aria-label="Replace with"]', 'Tom');
  await page.focus('input[aria-label="Replace with"]');
  await page.keyboard.press('Control+Enter');
  await sleep(150);
  const t = await text();
  assert(shown > 0 && t.includes('Ben sits.'), 'action changed: ' + t);
  assert(t.includes('TOM\nTom is here.') || t.includes('\nBEN\nTom is here.'), t);
  await page.keyboard.press('Escape');
  await app(() => window.__app.setView('script'));
});

console.log(results.map((r) => r.join(' — ')).join('\n'));
console.log('page errors:', JSON.stringify(h.errors.filter((e) => !e.includes('404'))));
await h.stop();
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
