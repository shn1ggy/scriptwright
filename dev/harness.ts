// Development and test harness: serves the renderer to a normal browser and exposes the
// same backend API over HTTP, so the app can be exercised end-to-end without Electron.
// Not part of the shipped application.

import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Backend } from '../src/main/backend';
import { createApi } from '../src/main/api';

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const port = Number(opt('port', '5174'));
const rendererDir = path.resolve(__dirname, 'renderer');
const userData = path.resolve(opt('userdata', path.join(os.tmpdir(), 'scriptwright-harness')));
const fontsDir = path.resolve(opt('fonts', path.join(__dirname, '..', 'resources', 'fonts')));

const backend = new Backend({ userDataDir: userData, fontsDir });
const api = createApi(backend) as Record<string, (...a: any[]) => any>;
const clients = new Set<http.ServerResponse>();
const dialogQueue: any[] = [];
const windowLog: any[] = [];
let clipboard = '';

backend.on('external', (ev) => broadcast('external', ev));

function broadcast(name: string, payload: unknown) {
  const data = `data: ${JSON.stringify({ name, payload })}\n\n`;
  for (const c of clients) c.write(data);
}

function encode(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && v.type === 'Buffer' && Array.isArray(v.data)) return { __b64: Buffer.from(v.data).toString('base64') };
    if (v instanceof Uint8Array) return { __b64: Buffer.from(v).toString('base64') };
    return v;
  });
}

function decode(text: string): any {
  return JSON.parse(text, (_k, v) => (v && typeof v === 'object' && typeof v.__b64 === 'string' ? Buffer.from(v.__b64, 'base64') : v));
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => res(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rej);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  try {
    if (url.pathname === '/api' && req.method === 'POST') {
      const { method, args: a } = decode(await readBody(req));
      const fn = api[method];
      if (!fn) throw new Error(`Unknown method ${method}`);
      const result = await fn(...a);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(encode({ result: result === undefined ? null : result }));
      return;
    }
    if (url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/native' && req.method === 'POST') {
      const { kind, op, arg } = JSON.parse(await readBody(req));
      let result: any = null;
      if (kind === 'dialog') result = dialogQueue.length ? dialogQueue.shift() : null;
      else if (kind === 'window') windowLog.push({ op, arg, time: Date.now() });
      else if (kind === 'clipboard') {
        if (op === 'read') result = clipboard;
        else clipboard = String(arg ?? '');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ result }));
      return;
    }
    // Test hooks
    if (url.pathname === '/test/dialog' && req.method === 'POST') {
      dialogQueue.push(...JSON.parse(await readBody(req)));
      res.end('ok');
      return;
    }
    if (url.pathname === '/test/window-log') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(windowLog));
      return;
    }
    if (url.pathname === '/test/event' && req.method === 'POST') {
      const { name, payload } = JSON.parse(await readBody(req));
      broadcast(name, payload);
      res.end('ok');
      return;
    }
    // Static files
    let file = path.join(rendererDir, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(rendererDir)) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  } catch (e: any) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e?.message ?? String(e) }));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Harness on http://127.0.0.1:${port} (userData ${userData})`);
});
