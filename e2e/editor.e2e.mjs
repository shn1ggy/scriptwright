// End-to-end checks of the editor in Chromium via the dev harness.
import os from 'os';
import { startHarness, assert, sleep } from './util.mjs';
import fs from 'fs';
import path from 'path';

const h = await startHarness();
const { page } = h;
await sleep(800);
const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(['PASS', name]);
  } catch (e) {
    results.push(['FAIL', name, e.message]);
    await page.screenshot({ path: path.join(os.tmpdir(), `fail-${results.length}.png`) });
  }
}
const app = (fn, ...args) => page.evaluate(fn, ...args);
const lineIndex = (text) => app((t) => window.__app.editor.lines.findIndex((l) => l.text === t), text);
const sel = () => app(() => window.__app.editor.sel);
const lineEl = (i) => page.locator(`.ed-content .ln`).nth(i);

// Find the DOM rect of a substring inside a rendered line (by doc line index).
async function charRect(docLine, sub, nth = 0) {
  return app(([docLine, sub, nth]) => {
    const ed = window.__app.editor;
    const key = ed.lines[docLine].key;
    const v = ed.views.get(key);
    const text = Array.from(v.el.querySelectorAll('span')).map((s) => s.textContent).join('');
    let idx = -1;
    for (let k = 0; k <= nth; k++) idx = text.indexOf(sub, idx + 1);
    // walk text nodes
    let acc = 0;
    for (const seg of v.segs) {
      if (idx < acc + seg.node.length) {
        const r = document.createRange();
        r.setStart(seg.node, idx - acc);
        r.setEnd(seg.node, idx - acc + 1);
        const b = r.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2, left: b.left };
      }
      acc += seg.node.length;
    }
    return null;
  }, [docLine, sub, nth]);
}

await check('inactive lines hide formatting operators completely', async () => {
  const i = await lineIndex("It's Tom. From the harbour. Let me in, **please**.");
  const txt = await app((i) => window.__app.editor.views.get(window.__app.editor.lines[i].key).el.textContent, i);
  assert(!txt.includes('*'), 'markers visible: ' + txt);
});

await check('click on an inactive line resolves to a stable caret and reveals syntax without selecting', async () => {
  const i = await lineIndex("It's Tom. From the harbour. Let me in, **please**.");
  await app((i) => window.__app.editor.scrollToLine(i, 'center'), i);
  await sleep(50);
  const r = await charRect(i, 'please');
  await page.mouse.click(r.x - 2, r.y);
  const s = await sel();
  const src = "It's Tom. From the harbour. Let me in, **please**.";
  assert(s.head.line === i, 'line ' + s.head.line);
  assert(s.head.ch === src.indexOf('please'), `ch ${s.head.ch} expected ${src.indexOf('please')}`);
  assert(s.anchor.ch === s.head.ch && s.anchor.line === s.head.line, 'selection created');
  const txt = await app((i) => window.__app.editor.views.get(window.__app.editor.lines[i].key).el.textContent, i);
  assert(txt.includes('**please**'), 'markers not revealed: ' + txt);
});

await check('revealing syntax does not change line height or vertical position', async () => {
  const i = await lineIndex('One more night. Just one more.');
  const before = await app(() => [...document.querySelectorAll('.ed-content .ln')].map((e) => e.getBoundingClientRect().top));
  const j = await lineIndex('LISA (60s), weathered, wipes the lens with a cloth. She hums something *old*.');
  const r = await charRect(j, 'hums');
  await page.mouse.click(r.x, r.y);
  const after = await app(() => [...document.querySelectorAll('.ed-content .ln')].map((e) => e.getBoundingClientRect().top));
  assert(before.length === after.length, 'line count changed');
  const diffs = before.map((b, k) => Math.abs(b - after[k])).filter((d) => d > 0.5);
  assert(diffs.length === 0, 'vertical shift ' + JSON.stringify(diffs.slice(0, 5)));
  void i;
});

await check('double-click selects the word under the pointer even when markers are revealed', async () => {
  await app(() => { window.__app.settings.editor.titlePageInScript = true; window.__app.applySettings(); });
  const i = await lineIndex('Title: **THE LONG NIGHT**');
  // move caret elsewhere first so the line is inactive
  const j = await lineIndex('Rain hammers the glass. A lamp turns, slow and patient.');
  const rj = await charRect(j, 'glass');
  await page.mouse.click(rj.x, rj.y);
  await app((i) => window.__app.editor.scrollToLine(i, 'center'), i);
  await sleep(50);
  const r = await charRect(i, 'LONG');
  await page.mouse.dblclick(r.x, r.y);
  const t = await app(() => window.__app.editor.selectedText());
  assert(t === 'LONG', 'selected: ' + JSON.stringify(t));
});

await check('all single-line scene headings have identical heights', async () => {
  const hs = await app(() => [...document.querySelectorAll('.ed-content .el-heading')].map((e) => e.getBoundingClientRect().height));
  assert(hs.length >= 3, 'headings ' + hs.length);
  assert(new Set(hs.map((x) => Math.round(x))).size === 1, JSON.stringify(hs));
});

await check('dialogue selection does not paint to the right edge of the column', async () => {
  const i = await lineIndex('One more night. Just one more.');
  const r = await charRect(i, 'One');
  await page.mouse.click(r.x, r.y, { clickCount: 3 });
  await sleep(50);
  const boxes = await app(() => [...document.querySelectorAll('.sel-box')].map((b) => b.getBoundingClientRect()).map((b) => ({ l: b.left, r: b.right, w: b.width })));
  const col = await app(() => document.querySelector('.ed-column').getBoundingClientRect().right);
  assert(boxes.length >= 1, 'no selection boxes');
  const maxRight = Math.max(...boxes.map((b) => b.r));
  assert(maxRight < col - 100, `selection reaches ${maxRight} vs column right ${col}`);
});

await check('typing at the end creates a new scene in the outline immediately', async () => {
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n\nINT. BOATHOUSE - DAY');
  const n = await app(() => window.__app.scenes.filter((s) => s.kind === 'scene').length);
  assert(n === 4, 'scenes ' + n);
  const rows = await page.locator('.outline .row').count();
  assert(rows === 6, 'outline rows ' + rows);
});

await check('cue + Enter allows dialogue immediately; blank line ends it', async () => {
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('ANNA');
  await page.keyboard.press('Enter');
  let types = await app(() => {
    const ed = window.__app.editor;
    const n = ed.lines.length;
    return [ed.parsed.lines[n - 2].type, ed.parsed.lines[n - 1].type];
  });
  assert(types[0] === 'character' && types[1] === 'dialogue', JSON.stringify(types));
  await page.keyboard.type('Hello, Jürgen. Grüß dich!');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('She smiles.');
  types = await app(() => {
    const ed = window.__app.editor;
    const n = ed.lines.length;
    return ed.parsed.lines.slice(n - 4).map((l) => l.type);
  });
  assert(JSON.stringify(types) === JSON.stringify(['character', 'dialogue', 'blank', 'action']), JSON.stringify(types));
});

await check('no autocomplete or automatic capitalization', async () => {
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('lowercase words stay lowercase');
  const last = await app(() => window.__app.editor.lines.at(-1).text);
  assert(last === 'lowercase words stay lowercase', last);
});

await check('undo restores previous text', async () => {
  await sleep(1300); // separate undo group from the previous typing
  const before = await app(() => window.__app.editor.getText());
  await page.keyboard.type(' extra');
  await page.keyboard.press('Control+Z');
  const after = await app(() => window.__app.editor.getText());
  assert(after === before, 'undo mismatch');
});

await check('autosave writes the screenplay to disk', async () => {
  await sleep(1600);
  const disk = fs.readFileSync(path.join(h.ws, 'The Long Night', 'The Long Night.fountain'), 'utf8');
  assert(disk.includes('Hello, Jürgen. Grüß dich!'), 'not saved');
  const st = await page.locator('.save-state').textContent();
  assert(st === 'Saved', st);
});

await check('Mod+2 switches to Scene view with the reading scene and a consistent inset; Tab does not switch', async () => {
  // Caret is in scene 4 (boathouse)
  await page.keyboard.press('Tab');
  assert((await app(() => window.__app.view)) === 'script', 'Tab switched views');
  await page.keyboard.press('Control+2');
  const v = await app(() => window.__app.view);
  assert(v === 'scene', v);
  const first = await app(() => {
    const ed = window.__app.editor;
    const i = ed.displayedLines[0];
    return { text: ed.lines[i].text, top: document.querySelector('.ed-content .ln').getBoundingClientRect().top - document.querySelector('.ed-scroller').getBoundingClientRect().top + document.querySelector('.ed-scroller').scrollTop };
  });
  assert(first.text === 'INT. BOATHOUSE - DAY', first.text);
  await page.keyboard.press('Alt+ArrowLeft');
  const second = await app(() => {
    const ed = window.__app.editor;
    const i = ed.displayedLines[0];
    return { text: ed.lines[i].text, top: document.querySelector('.ed-content .ln').getBoundingClientRect().top - document.querySelector('.ed-scroller').getBoundingClientRect().top + document.querySelector('.ed-scroller').scrollTop };
  });
  assert(second.text === 'INT. LIGHTHOUSE - STAIRWELL - NIGHT', second.text);
  assert(Math.abs(second.top - first.top) < 1, `inset ${first.top} vs ${second.top}`);
});

await check('typing a new heading in Scene view keeps the text in the pane and adds an outline entry', async () => {
  await page.keyboard.press('Control+End');
  const before = await app(() => window.__app.scenes.filter((s) => s.kind === 'scene').length);
  await page.keyboard.type('\n\nEXT. CLIFF - NIGHT\n\nThe wind howls.');
  const after = await app(() => window.__app.scenes.filter((s) => s.kind === 'scene').length);
  assert(after === before + 1, `scenes ${before} -> ${after}`);
  const shown = await app(() => window.__app.editor.displayedLines.map((i) => window.__app.editor.lines[i].text));
  assert(shown.includes('EXT. CLIFF - NIGHT') && shown.includes('The wind howls.'), 'new text not visible');
  assert(shown[0] === 'INT. LIGHTHOUSE - STAIRWELL - NIGHT', 'focus changed: ' + shown[0]);
  const active = await page.locator('.outline .row.active .label').textContent();
  assert(active === 'EXT. CLIFF - NIGHT', 'active ' + active);
});

const caretY = () => app(() => window.__app.editor.coordsAtPos(window.__app.editor.sel.head).top);

await check('Scene → Script keeps the caret at the same screen position', async () => {
  const before = await caretY();
  await page.keyboard.press('Control+1');
  await sleep(50);
  const after = await caretY();
  assert(Math.abs(after - before) < 2, `${before} -> ${after}`);
});

await check('Script → Scene → Script round trip does not move the caret on screen', async () => {
  await app(() => { const ed = window.__app.editor; const i = ed.lines.findIndex((l) => l.text === 'Waves break over the pier. TOM (40s) shields his face, a canvas bag over one shoulder.'); ed.setSelection({ anchor: { line: i, ch: 3 }, head: { line: i, ch: 3 } }); ed.scrollToLine(i, 'center'); });
  await sleep(50);
  const y0 = await caretY();
  await page.keyboard.press('Control+2');
  await sleep(50);
  await page.keyboard.press('Control+1');
  await sleep(50);
  const y2 = await caretY();
  assert(Math.abs(y2 - y0) < 2, `${y0} -> ${y2}`);
  await page.keyboard.press('Control+End');
});

await check('Dialogue view filters by character, marks hidden action and edits the original', async () => {
  await page.click('.tab:has-text("Dialogue")');
  await page.selectOption('.view-head select >> nth=0', 'TOM');
  const shown = await app(() => window.__app.editor.displayedLines.map((i) => window.__app.editor.lines[i].text));
  assert(shown.includes('TOM') && !shown.includes('LISA'), JSON.stringify(shown));
  const gaps = await page.locator('.ln-gap-label').allTextContents();
  assert(gaps.some((g) => g.includes('action hidden')), 'gaps ' + JSON.stringify(gaps));
  const label = await page.locator('.view-head select >> nth=0').locator('option').allTextContents();
  assert(label[1].startsWith('LISA (') || label[1].startsWith('TOM ('), JSON.stringify(label));
  // edit a dialogue line
  const i = await lineIndex('I came because nobody else would.');
  const r = await charRect(i, 'nobody');
  await page.mouse.click(r.x, r.y);
  await page.keyboard.press('End');
  await page.keyboard.type(' Really.');
  const t = await app(() => window.__app.editor.getText());
  assert(t.includes('I came because nobody else would. Really.'), 'edit not applied');
});

await check('deleting a selection across hidden lines keeps the hidden writing', async () => {
  const before = await app(() => window.__app.editor.getText());
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  const after = await app(() => window.__app.editor.getText());
  assert(after.includes('Rain hammers the glass.'), 'hidden action deleted');
  assert(after.includes('LISA'), 'other character deleted');
  assert(!after.includes('I came because nobody else would. Really.'), 'visible text not deleted');
  await page.keyboard.press('Control+Z');
  const restored = await app(() => window.__app.editor.getText());
  assert(restored === before, 'undo did not restore');
});

await check('Go to passage returns to Script at the same place', async () => {
  const s0 = await sel();
  await page.keyboard.press('Control+Enter');
  const v = await app(() => window.__app.view);
  const s1 = await sel();
  assert(v === 'script', v);
  assert(s1.head.line === s0.head.line, 'line changed');
});

await check('minimal view hides everything but the text; Escape restores', async () => {
  await page.keyboard.press('Control+M');
  const vis = await app(() => ['.titlebar', '.viewbar', '.statusbar', '.pane-left'].map((s) => getComputedStyle(document.querySelector(s)).display));
  assert(vis.every((d) => d === 'none'), JSON.stringify(vis));
  await page.keyboard.press('Escape');
  const vis2 = await app(() => getComputedStyle(document.querySelector('.titlebar')).display);
  assert(vis2 !== 'none', 'not restored');
});

await check('command window records a shortcut without running the old command, detects conflicts', async () => {
  await page.keyboard.press('Control+K');
  await page.waitForSelector('.palette .row');
  await page.keyboard.type('minimal view');
  await page.keyboard.press('Control+R');
  await page.keyboard.press('Control+N'); // conflicts with New Scene; must not insert a scene
  const scenes = await app(() => window.__app.scenes.filter((s) => s.kind === 'scene').length);
  const msg = await page.locator('.palette .msg').textContent();
  assert(msg.includes('already used'), msg);
  assert(scenes === 5, 'command ran during recording: ' + scenes);
  await page.click('.palette .msg button:has-text("Cancel")');
  await page.keyboard.press('Control+R');
  await page.keyboard.press('Control+Shift+J');
  const keys = await app(() => window.__app.commands.keysFor('view.minimal'));
  assert(keys[0] === 'Mod+Shift+J', JSON.stringify(keys));
  await page.keyboard.press('Control+Shift+R');
  const keys2 = await app(() => window.__app.commands.keysFor('view.minimal'));
  assert(keys2[0] === 'Mod+M', JSON.stringify(keys2));
  await page.keyboard.press('Escape');
  const open = await page.locator('.palette').count();
  assert(open === 0, 'palette still open');
});

await check('rename character updates cues and mentions with casing, as one undo step', async () => {
  await app(() => window.__app.run('character.rename'));
  await page.waitForSelector('.dialog');
  await page.selectOption('.dialog select', 'LISA');
  await page.fill('.dialog input.field', 'Greta');
  const summary = await page.locator('.dialog .summary').textContent();
  assert(/replacement/.test(summary), summary);
  await page.click('.dialog .btn.primary');
  const t = await app(() => window.__app.editor.getText());
  assert(t.includes('\nGRETA\n(to herself)') && t.includes('Greta freezes') && t.includes('GRETA (60s)') && t.includes('GRETA (CONT\'D)'), 'rename incomplete');
  await page.keyboard.press('Control+Z');
  const t2 = await app(() => window.__app.editor.getText());
  assert(t2.includes('\nLISA\n(to herself)') && !t2.includes('Greta'), 'undo incomplete');
});

await check('title page entry opens with Mod+T and is not Scene 1', async () => {
  await page.keyboard.press('Control+T');
  const v = await app(() => [window.__app.view, window.__app.focus?.kind, window.__app.editor.displayedLines.length]);
  assert(v[0] === 'scene' && v[1] === 'title', JSON.stringify(v));
  const first = await page.locator('.outline .row').nth(2).locator('.num').textContent();
  assert(first === '1', first);
  await page.keyboard.press('Control+T');
  const v2 = await app(() => window.__app.focusedItem()?.kind);
  assert(v2 === 'opening' || v2 === 'scene', v2);
});

await check('external change while clean reloads; while dirty it keeps both', async () => {
  await page.keyboard.press('Control+S');
  await sleep(400);
  const file = path.join(h.ws, 'The Long Night', 'The Long Night.fountain');
  const disk = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, disk.replace('Rain hammers the glass.', 'Rain lashes the glass.'));
  await sleep(2600);
  const t = await app(() => window.__app.editor.getText());
  assert(t.includes('Rain lashes the glass.'), 'not reloaded');
  // now make a local edit and an external one
  await page.keyboard.type('X');
  const disk2 = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, disk2.replace('Rain lashes', 'Rain whips'));
  await sleep(2600);
  const banner = await page.locator('.banner').count();
  const st = await page.locator('.save-state').textContent();
  assert(banner === 1 || st.includes('Changed outside'), 'no conflict shown: ' + st);
  const diskNow = fs.readFileSync(file, 'utf8');
  assert(diskNow.includes('Rain whips'), 'external version overwritten');
});

await check('export preview renders real PDF pages', async () => {
  await page.click('.banner .btn'); // Review…
  await page.click('.dialog .btn.primary'); // Keep my version
  await sleep(500);
  await page.keyboard.press('Control+E');
  await page.waitForSelector('.export-preview canvas', { timeout: 15000 });
  const info = await page.locator('.export-side .foot .muted').textContent();
  assert(/\d+ page/.test(info), info);
  await page.screenshot({ path: path.join(os.tmpdir(), 'sw-export.png') });
  await page.keyboard.press('Escape');
});

console.log(results.map((r) => r.join(' — ')).join('\n'));
console.log('page errors:', JSON.stringify(h.errors.filter((e) => !e.includes('404'))));
await page.screenshot({ path: path.join(os.tmpdir(), 'sw-final.png') });
await h.stop();
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
