// Runs every end-to-end suite against the browser harness and summarizes the results.
import { spawnSync } from 'child_process';
import path from 'path';
import { root } from './util.mjs';
const suites = ['editor', 'scenes', 'session', 'input', 'cards', 'feedback', 'stage2', 'revisions'];
let failed = 0;
for (const s of suites) {
  const r = spawnSync(process.execPath, [path.join(root, 'e2e', `${s}.e2e.mjs`)], { encoding: 'utf8' });
  const lines = (r.stdout + r.stderr).split('\n').filter((l) => /^(PASS|FAIL)|page errors/.test(l));
  console.log(`\n## ${s}\n` + lines.join('\n'));
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n${failed} suite(s) failed` : '\nAll suites passed');
process.exit(failed ? 1 : 0);
