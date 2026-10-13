import { startHarness, sleep, root } from './util.mjs';
import fs from 'fs';
import path from 'path';
const h = await startHarness({ withSample: false });
fs.mkdirSync(path.join(h.ws, 'Long'));
fs.copyFileSync(path.join(root, 'e2e/fixtures/long.fountain'), path.join(h.ws, 'Long', 'Long.fountain'));
await h.page.evaluate(async () => { await window.__app.refreshProjects(); await window.__app.openProject('Long'); });
await sleep(300);
const r = await h.page.evaluate(async () => {
  const ed = window.__app.editor;
  const mid = Math.floor(ed.lines.length / 2);
  ed.setSelection({ anchor: { line: mid, ch: 0 }, head: { line: mid, ch: 0 } });
  ed.focus();
  let full = 0;
  const orig = ed.reparse.bind(ed);
  ed.reparse = () => { full++; orig(); };
  const t = [];
  for (let i = 0; i < 20; i++) { const t0 = performance.now(); ed.insertText('a', 'type'); t.push(performance.now() - t0); }
  return { full, text: ed.lines[mid].text, prevText: ed.lines[mid-1].text, t };
});
console.log(JSON.stringify(r));
await h.stop();
