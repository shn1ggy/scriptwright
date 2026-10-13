// Typing latency on a long screenplay.
import { startHarness, sleep, root } from './util.mjs';
import fs from 'fs';
import path from 'path';
const h = await startHarness({ withSample: false });
fs.mkdirSync(path.join(h.ws, 'Long'));
fs.copyFileSync(path.join(root, 'e2e/fixtures/long.fountain'), path.join(h.ws, 'Long', 'Long.fountain'));
await h.page.evaluate(async () => { await window.__app.refreshProjects(); await window.__app.openProject('Long'); });
await sleep(500);
const r = await h.page.evaluate(async () => {
  const app = window.__app;
  const ed = app.editor;
  let mid = Math.floor(ed.lines.length / 2); while (!ed.lines[mid].text.startsWith('Rain hammers')) mid++;
  ed.setSelection({ anchor: { line: mid, ch: 0 }, head: { line: mid, ch: 0 } });
  ed.focus();
  const times = [];
  for (let i = 0; i < 40; i++) {
    const t0 = performance.now();
    ed.insertText('a', 'type');
    // force layout like a real frame would
    document.querySelector('.ed-caret').getBoundingClientRect();
    times.push(performance.now() - t0);
    await new Promise((r) => setTimeout(r, 5));
  }
  times.sort((a, b) => a - b);
  const t1 = performance.now();
  ed.insertText('\n', 'enter');
  const enter = performance.now() - t1;
  return { lines: ed.lines.length, scenes: app.scenes.length, median: times[20], p90: times[36], max: times[39], enter };
});
console.log(JSON.stringify(r));
await h.stop();
