import { startHarness, sleep } from './util.mjs';
const h = await startHarness();
await sleep(1200);
await h.page.screenshot({ path: process.argv[2] ?? '/tmp/shot.png' });
console.log('errors:', JSON.stringify(h.errors));
await h.stop();
