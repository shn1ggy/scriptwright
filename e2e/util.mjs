// Shared helpers for end-to-end checks against the dev harness in Chromium.
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function startHarness({ port = 5180 + Math.floor(Math.random() * 500), withSample = true, mac = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-e2e-'));
  const ws = path.join(tmp, 'Workspace');
  fs.mkdirSync(ws);
  if (withSample) {
    fs.mkdirSync(path.join(ws, 'The Long Night'));
    fs.copyFileSync(path.join(root, 'e2e/fixtures/sample.fountain'), path.join(ws, 'The Long Night', 'The Long Night.fountain'));
  }
  const ud = path.join(tmp, 'userdata');
  fs.mkdirSync(ud);
  // Pre-select the workspace so the app opens straight into it.
  fs.writeFileSync(path.join(ud, 'state.json'), JSON.stringify({ version: 1, workspace: ws, recentWorkspaces: [ws], lastProject: withSample ? 'The Long Night' : undefined, sessions: {} }));
  const proc = spawn(process.execPath, [path.join(root, 'dist/harness.js'), '--port', String(port), '--userdata', ud], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => {
    proc.stdout.on('data', (d) => d.toString().includes('Harness on') && res());
    proc.stderr.on('data', (d) => process.stderr.write(d));
    proc.on('exit', (c) => rej(new Error('harness exited ' + c)));
  });
  const browser = await chromium.launch({ args: ['--font-render-hinting=none'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  if (mac) await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' }));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => window.__app && window.__app.ready, null, { timeout: 15000 }).catch((e) => { console.log('ERRORS', errors.join(' | ')); throw e; });
  return {
    tmp, ws, ud, port, page, browser, errors,
    url: `http://127.0.0.1:${port}`,
    async queueDialog(...values) {
      await fetch(`http://127.0.0.1:${port}/test/dialog`, { method: 'POST', body: JSON.stringify(values) });
    },
    async stop() {
      await browser.close();
      proc.kill();
    },
  };
}

export function assert(cond, msg) {
  if (!cond) throw new Error('Assertion failed: ' + msg);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
