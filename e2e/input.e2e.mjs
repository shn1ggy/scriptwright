// Text input details: IME/dead-key composition, clipboard, macOS key bindings.
import { startHarness, assert, sleep } from './util.mjs';

const results = [];
async function run(mac) {
  const h = await startHarness({ mac });
  const { page } = h;
  const app = (fn, ...a) => page.evaluate(fn, ...a);
  const M = mac ? 'Meta' : 'Control';
  async function check(name, fn) {
    try {
      await fn();
      results.push(['PASS', `${mac ? '[mac] ' : ''}${name}`]);
    } catch (e) {
      results.push(['FAIL', `${mac ? '[mac] ' : ''}${name}`, e.message]);
    }
  }
  const endOfDoc = async () => {
    await app(() => { const ed = window.__app.editor; const n = ed.lines.length - 1; ed.setSelection({ anchor: { line: n, ch: ed.lines[n].text.length }, head: { line: n, ch: ed.lines[n].text.length } }); ed.focus(); });
  };

  await check('composition (dead keys / IME) inserts the composed text once', async () => {
    await endOfDoc();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: '´', selectionStart: 1, selectionEnd: 1 });
    await cdp.send('Input.imeSetComposition', { text: 'é', selectionStart: 1, selectionEnd: 1 });
    await cdp.send('Input.insertText', { text: 'é' });
    await page.keyboard.type('t');
    const last = await app(() => window.__app.editor.lines.at(-1).text);
    assert(last === 'ét', JSON.stringify(last));
  });

  // On macOS the clipboard keys come from the Edit menu, which a Linux browser cannot emulate.
  if (!mac) await check('copy and paste through the clipboard', async () => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.keyboard.press('Shift+Home');
    await page.keyboard.press(`${M}+C`);
    await page.keyboard.press('End');
    await page.keyboard.press(`${M}+V`);
    const last = await app(() => window.__app.editor.lines.at(-1).text);
    assert(last === 'étét', JSON.stringify(last));
  });

  if (!mac) await check('cut removes the selection', async () => {
    await page.keyboard.press('Shift+Home');
    await page.keyboard.press(`${M}+X`);
    const last = await app(() => window.__app.editor.lines.at(-1).text);
    assert(last === '', JSON.stringify(last));
  });

  if (mac) {
    await check('⌥← / ⌥→ navigate scenes (default), ⌘← goes to line start', async () => {
      await page.keyboard.press('Shift+Home');
      await page.keyboard.press('Backspace');
      await page.keyboard.type('Some words here');
      await page.keyboard.press('Meta+ArrowLeft');
      const ch = await app(() => window.__app.editor.sel.head.ch);
      assert(ch === 0, String(ch));
      const before = await app(() => window.__app.activeScene()?.heading);
      await page.keyboard.press('Alt+ArrowLeft');
      const after = await app(() => window.__app.activeScene()?.heading);
      assert(before !== after, `${before} -> ${after}`);
    });
    await check('⌥⇧→ selects by word (text navigation stays available)', async () => {
      await endOfDoc();
      await page.keyboard.press('Meta+ArrowLeft');
      await page.keyboard.press('Alt+Shift+ArrowRight');
      const t = await app(() => window.__app.editor.selectedText());
      assert(t === 'Some', JSON.stringify(t));
    });
  } else {
    await check('Ctrl+← / Ctrl+→ move by word', async () => {
      await page.keyboard.type('Some words here');
      await page.keyboard.press('Control+ArrowLeft');
      const ch = await app(() => window.__app.editor.sel.head.ch);
      assert(ch === 'Some words '.length, String(ch));
    });
  }

  await check('Alt+arrow keeps word navigation inside text fields', async () => {
    await page.keyboard.press(`${M}+Shift+F`);
    await page.keyboard.type('alpha beta');
    const before = await app(() => window.__app.activeScene()?.heading);
    await page.keyboard.press('Alt+ArrowLeft');
    const after = await app(() => window.__app.activeScene()?.heading);
    const focused = await app(() => document.activeElement?.getAttribute('aria-label'));
    assert(before === after && focused === 'Search scenes', `${before} ${after} ${focused}`);
    await page.keyboard.press('Escape');
  });

  await check('Tab inside dialogs moves focus instead of switching views', async () => {
    await page.keyboard.press(`${M}+P`);
    await page.waitForSelector('.settings');
    const v1 = await app(() => window.__app.view);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    const v2 = await app(() => window.__app.view);
    const inDialog = await app(() => !!document.activeElement.closest('.dialog'));
    assert(v1 === v2 && inDialog, `${v1} ${v2} ${inDialog}`);
    await page.keyboard.press('Escape');
  });

  console.log('errors', JSON.stringify(h.errors.filter((e) => !e.includes('404'))));
  await h.stop();
}

await run(false);
await run(true);
console.log(results.map((r) => r.join(' — ')).join('\n'));
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
