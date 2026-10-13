import { startHarness, sleep, root } from './util.mjs';
import fs from 'fs';
import path from 'path';
const h = await startHarness({ withSample: false });
fs.mkdirSync(path.join(h.ws, 'Long'));
fs.copyFileSync(path.join(root, 'e2e/fixtures/long.fountain'), path.join(h.ws, 'Long', 'Long.fountain'));
await h.page.evaluate(async () => { await window.__app.refreshProjects(); await window.__app.openProject('Long'); });
await sleep(300);
const r = await h.page.evaluate(async () => {
  const app = window.__app;
  const ed = app.editor;
  let mid = Math.floor(ed.lines.length / 2); while (!ed.lines[mid].text.startsWith('Rain hammers')) mid++;
  ed.setSelection({ anchor: { line: mid, ch: 0 }, head: { line: mid, ch: 0 } });
  ed.focus();
  const wrap = (obj, name, bucket) => {
    const orig = obj[name].bind(obj);
    obj[name] = (...a) => { const t = performance.now(); const r = orig(...a); bucket[name] = (bucket[name] || 0) + performance.now() - t; return r; };
  };
  const b = {};
  wrap(ed, 'reparse', b); wrap(ed, 'render', b); wrap(ed, 'paint', b); wrap(app, 'refreshDerived', b); wrap(app.outline, 'render', b); wrap(app, 'updateScenes', b);
  for (let i = 0; i < 20; i++) ed.insertText('a', 'type');
  for (const k in b) b[k] = +(b[k] / 20).toFixed(2);
  return b;
});
console.log(JSON.stringify(r));
await h.stop();
