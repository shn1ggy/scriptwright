// System font discovery and loading for PDF export.
//
// Fonts are found by scanning the usual font folders for TrueType/OpenType files and
// collections. Only the tables needed to name and classify a face are read, and the
// results are cached by file path, size and modification time.

import fs from 'fs';
import os from 'os';
import path from 'path';

export interface FontFace {
  family: string;
  style: string;
  bold: boolean;
  italic: boolean;
  weight: number;
  mono: boolean;
  /** Advance width of a monospaced face in em (0.6 for Courier). */
  advance: number;
  file: string;
  index: number;
  cff: boolean;
}

export interface FontFamily {
  family: string;
  mono: boolean;
  advance: number;
  faces: FontFace[];
}

export function fontDirs(): string[] {
  const home = os.homedir();
  if (process.platform === 'darwin') return ['/System/Library/Fonts', '/Library/Fonts', path.join(home, 'Library/Fonts')];
  if (process.platform === 'win32') {
    const win = process.env.WINDIR ?? 'C:\\Windows';
    const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    return [path.join(win, 'Fonts'), path.join(local, 'Microsoft', 'Windows', 'Fonts')];
  }
  return ['/usr/share/fonts', '/usr/local/share/fonts', path.join(home, '.local/share/fonts'), path.join(home, '.fonts')];
}

function readAt(fd: number, pos: number, len: number): Buffer {
  const b = Buffer.alloc(len);
  const n = fs.readSync(fd, b, 0, len, pos);
  return n === len ? b : b.subarray(0, n);
}

interface Table {
  off: number;
  len: number;
}

function tableDir(fd: number, base: number): Map<string, Table> {
  const head = readAt(fd, base, 12);
  const n = head.readUInt16BE(4);
  const dir = readAt(fd, base + 12, n * 16);
  const out = new Map<string, Table>();
  for (let i = 0; i < n; i++) {
    const r = i * 16;
    out.set(dir.toString('latin1', r, r + 4), { off: dir.readUInt32BE(r + 8), len: dir.readUInt32BE(r + 12) });
  }
  return out;
}

function decodeName(buf: Buffer, pid: number): string {
  if (pid === 0 || pid === 3) return Buffer.from(buf).swap16().toString('utf16le');
  return buf.toString('latin1');
}

function readFace(fd: number, base: number, file: string, index: number): FontFace | null {
  const sig = readAt(fd, base, 4).toString('latin1');
  const t = tableDir(fd, base);
  const name = t.get('name');
  const head = t.get('head');
  const hhea = t.get('hhea');
  if (!name || !head || !hhea || !t.get('cmap') || !t.get('hmtx')) return null;
  const nb = readAt(fd, name.off, Math.min(name.len, 64 * 1024));
  const count = nb.readUInt16BE(2);
  const strOff = nb.readUInt16BE(4);
  const names: Record<number, string> = {};
  const prio: Record<number, number> = {};
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    if (r + 12 > nb.length) break;
    const pid = nb.readUInt16BE(r);
    const lang = nb.readUInt16BE(r + 4);
    const id = nb.readUInt16BE(r + 6);
    const len = nb.readUInt16BE(r + 8);
    const off = nb.readUInt16BE(r + 10);
    if (![1, 2, 16, 17].includes(id)) continue;
    // Prefer Windows English names, then any Unicode, then Mac Roman.
    const p = pid === 3 && (lang === 0x409 || lang === 0) ? 3 : pid === 3 || pid === 0 ? 2 : 1;
    if ((prio[id] ?? 0) >= p) continue;
    const start = strOff + off;
    if (start + len > nb.length) continue;
    names[id] = decodeName(nb.subarray(start, start + len), pid).replace(/\u0000/g, '').trim();
    prio[id] = p;
  }
  const family = names[16] || names[1];
  const style = names[17] || names[2] || 'Regular';
  if (!family || family.startsWith('.')) return null;
  const hb = readAt(fd, head.off, 54);
  const unitsPerEm = hb.readUInt16BE(18) || 1000;
  const macStyle = hb.readUInt16BE(44);
  const hh = readAt(fd, hhea.off, 36);
  const advanceMax = hh.readUInt16BE(10);
  let weight = 400;
  let fsSel = 0;
  const os2 = t.get('OS/2');
  if (os2 && os2.len >= 64) {
    const ob = readAt(fd, os2.off, 64);
    weight = ob.readUInt16BE(4);
    fsSel = ob.readUInt16BE(62);
  }
  let fixed = false;
  const post = t.get('post');
  if (post && post.len >= 16) fixed = readAt(fd, post.off, 16).readUInt32BE(12) !== 0;
  const italic = !!(fsSel & 1) || !!(macStyle & 2) || /italic|oblique/i.test(style);
  const bold = !!(fsSel & 32) || !!(macStyle & 1) || weight >= 600 || /bold|black|heavy/i.test(style);
  return {
    family,
    style,
    bold,
    italic,
    weight,
    mono: fixed,
    advance: Math.round((advanceMax / unitsPerEm) * 1000) / 1000,
    file,
    index,
    cff: sig === 'OTTO' || t.has('CFF '),
  };
}

export function readFontFile(file: string): FontFace[] {
  const fd = fs.openSync(file, 'r');
  try {
    const sig = readAt(fd, 0, 4).toString('latin1');
    if (sig === 'ttcf') {
      const h = readAt(fd, 0, 12);
      const n = Math.min(64, h.readUInt32BE(8));
      const offs = readAt(fd, 12, n * 4);
      const out: FontFace[] = [];
      for (let i = 0; i < n; i++) {
        try {
          const f = readFace(fd, offs.readUInt32BE(i * 4), file, i);
          if (f) out.push(f);
        } catch {}
      }
      return out;
    }
    if (sig !== '\u0000\u0001\u0000\u0000' && sig !== 'OTTO' && sig !== 'true') return [];
    const f = readFace(fd, 0, file, 0);
    return f ? [f] : [];
  } finally {
    fs.closeSync(fd);
  }
}

function walk(dir: string, depth: number, out: string[]) {
  let ents: fs.Dirent[];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth < 5) walk(p, depth + 1, out);
    else if ((e.isFile() || e.isSymbolicLink()) && /\.(ttf|otf|ttc)$/i.test(e.name)) out.push(p);
  }
}

let memo: FontFamily[] | null = null;

/** All font families on this computer, cached in `cacheFile`. */
export function listFontFamilies(cacheFile?: string, dirs = fontDirs()): FontFamily[] {
  if (memo) return memo;
  let cache: Record<string, { size: number; mtime: number; faces: FontFace[] }> = {};
  if (cacheFile) {
    try {
      cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch {}
  }
  const files: string[] = [];
  for (const d of dirs) walk(d, 0, files);
  const next: typeof cache = {};
  const faces: FontFace[] = [];
  for (const f of files) {
    let st: fs.Stats;
    try {
      st = fs.statSync(f);
    } catch {
      continue;
    }
    const c = cache[f];
    let fs2: FontFace[];
    if (c && c.size === st.size && c.mtime === st.mtimeMs) fs2 = c.faces;
    else {
      try {
        fs2 = readFontFile(f);
      } catch {
        fs2 = [];
      }
    }
    next[f] = { size: st.size, mtime: st.mtimeMs, faces: fs2 };
    faces.push(...fs2);
  }
  if (cacheFile) {
    try {
      fs.writeFileSync(cacheFile, JSON.stringify(next));
    } catch {}
  }
  const byFamily = new Map<string, FontFace[]>();
  for (const f of faces) {
    const arr = byFamily.get(f.family) ?? [];
    if (!arr.some((x) => x.style === f.style)) arr.push(f);
    byFamily.set(f.family, arr);
  }
  memo = [...byFamily.entries()]
    .map(([family, fc]) => {
      const reg = pickFace(fc, false, false);
      return { family, mono: reg.mono, advance: reg.advance, faces: fc };
    })
    .sort((a, b) => a.family.localeCompare(b.family));
  return memo;
}

export function resetFontCache() {
  memo = null;
}

/** Best face for a style: exact match first, closest weight to 400/700 otherwise. */
export function pickFace(faces: FontFace[], bold: boolean, italic: boolean): FontFace {
  const target = bold ? 700 : 400;
  const score = (f: FontFace) => (f.bold === bold ? 0 : 1000) + (f.italic === italic ? 0 : 2000) + Math.abs(f.weight - target) + (/condensed|narrow|light|thin/i.test(f.style) ? 300 : 0);
  return faces.slice().sort((a, b) => score(a) - score(b))[0];
}

/** Extracts one font from a collection (or returns the file) as standalone sfnt data. */
export function loadFontData(face: FontFace): Buffer {
  const data = fs.readFileSync(face.file);
  if (data.toString('latin1', 0, 4) !== 'ttcf') return data;
  const base = data.readUInt32BE(12 + face.index * 4);
  const n = data.readUInt16BE(base + 4);
  const recs: Array<{ tag: string; check: number; off: number; len: number }> = [];
  for (let i = 0; i < n; i++) {
    const r = base + 12 + i * 16;
    recs.push({ tag: data.toString('latin1', r, r + 4), check: data.readUInt32BE(r + 4), off: data.readUInt32BE(r + 8), len: data.readUInt32BE(r + 12) });
  }
  const headerLen = 12 + n * 16;
  let total = headerLen;
  for (const r of recs) total += (r.len + 3) & ~3;
  const out = Buffer.alloc(total);
  data.copy(out, 0, base, base + 12);
  let off = headerLen;
  recs.forEach((r, i) => {
    const d = 12 + i * 16;
    out.write(r.tag, d, 'latin1');
    out.writeUInt32BE(r.check, d + 4);
    out.writeUInt32BE(off, d + 8);
    out.writeUInt32BE(r.len, d + 12);
    data.copy(out, off, r.off, r.off + r.len);
    off += (r.len + 3) & ~3;
  });
  return out;
}
