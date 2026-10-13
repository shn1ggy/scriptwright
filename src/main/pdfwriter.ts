// Minimal PDF writer: standard Type 1 fonts and embedded TrueType fonts (WinAnsi
// encoding), text, lines and a rotated watermark. No external dependencies.

import { deflateSync } from 'zlib';

const WIN_ANSI_SPECIAL: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
  0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
  0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/** Unicode → WinAnsi code, or -1 if not representable. */
export function winAnsiCode(cp: number): number {
  if (cp >= 0x20 && cp <= 0x7e) return cp;
  if (cp >= 0xa0 && cp <= 0xff) return cp;
  return WIN_ANSI_SPECIAL[cp] ?? -1;
}

const WIN_ANSI_TO_UNICODE: number[] = (() => {
  const t: number[] = new Array(256).fill(0);
  for (let c = 0x20; c <= 0x7e; c++) t[c] = c;
  for (let c = 0xa0; c <= 0xff; c++) t[c] = c;
  for (const [u, c] of Object.entries(WIN_ANSI_SPECIAL)) t[c] = Number(u);
  return t;
})();

export interface TtfInfo {
  data: Buffer;
  unitsPerEm: number;
  bbox: [number, number, number, number];
  ascent: number;
  descent: number;
  capHeight: number;
  italicAngle: number;
  fixedPitch: boolean;
  /** Width (1/1000 em) for WinAnsi codes 32..255. */
  widths: number[];
  postscriptName: string;
  /** OpenType with CFF outlines (embedded as FontFile3). */
  cff: boolean;
}

export function parseTtf(data: Buffer): TtfInfo {
  const numTables = data.readUInt16BE(4);
  const tables = new Map<string, { off: number; len: number }>();
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    tables.set(data.toString('latin1', rec, rec + 4), { off: data.readUInt32BE(rec + 8), len: data.readUInt32BE(rec + 12) });
  }
  const need = (t: string) => {
    const v = tables.get(t);
    if (!v) throw new Error(`Font is missing the ${t} table`);
    return v.off;
  };
  const head = need('head');
  const unitsPerEm = data.readUInt16BE(head + 18);
  const bbox: [number, number, number, number] = [
    data.readInt16BE(head + 36),
    data.readInt16BE(head + 38),
    data.readInt16BE(head + 40),
    data.readInt16BE(head + 42),
  ];
  const hhea = need('hhea');
  const ascent = data.readInt16BE(hhea + 4);
  const descent = data.readInt16BE(hhea + 6);
  const numHMetrics = data.readUInt16BE(hhea + 34);
  const hmtx = need('hmtx');
  const advance = (gid: number) => data.readUInt16BE(hmtx + Math.min(gid, numHMetrics - 1) * 4);
  let capHeight = ascent;
  const os2 = tables.get('OS/2');
  if (os2 && os2.len >= 90 && data.readUInt16BE(os2.off) >= 2) capHeight = data.readInt16BE(os2.off + 88);
  let italicAngle = 0;
  let fixedPitch = false;
  const post = tables.get('post');
  if (post) {
    italicAngle = data.readInt32BE(post.off + 4) / 65536;
    fixedPitch = data.readUInt32BE(post.off + 12) !== 0;
  }
  // cmap format 4
  const cmap = need('cmap');
  const nSub = data.readUInt16BE(cmap + 2);
  let sub = -1;
  for (let i = 0; i < nSub; i++) {
    const r = cmap + 4 + i * 8;
    const pid = data.readUInt16BE(r);
    const eid = data.readUInt16BE(r + 2);
    const off = data.readUInt32BE(r + 4);
    const fmt = data.readUInt16BE(cmap + off);
    if (fmt === 4 && ((pid === 3 && eid === 1) || pid === 0)) {
      sub = cmap + off;
      if (pid === 3) break;
    }
  }
  if (sub < 0) throw new Error('Font has no Unicode cmap');
  const segX2 = data.readUInt16BE(sub + 6);
  const ends = sub + 14;
  const starts = ends + segX2 + 2;
  const deltas = starts + segX2;
  const ranges = deltas + segX2;
  const glyphFor = (cp: number): number => {
    for (let s = 0; s < segX2 / 2; s++) {
      const end = data.readUInt16BE(ends + s * 2);
      if (cp > end) continue;
      const start = data.readUInt16BE(starts + s * 2);
      if (cp < start) return 0;
      const delta = data.readInt16BE(deltas + s * 2);
      const ro = data.readUInt16BE(ranges + s * 2);
      if (ro === 0) return (cp + delta) & 0xffff;
      const gaddr = ranges + s * 2 + ro + (cp - start) * 2;
      const g = data.readUInt16BE(gaddr);
      return g === 0 ? 0 : (g + delta) & 0xffff;
    }
    return 0;
  };
  const widths: number[] = [];
  for (let c = 32; c <= 255; c++) {
    const u = WIN_ANSI_TO_UNICODE[c];
    const g = u ? glyphFor(u) : 0;
    widths.push(Math.round((advance(g) * 1000) / unitsPerEm));
  }
  let postscriptName = 'EmbeddedFont';
  const name = tables.get('name');
  if (name) {
    const count = data.readUInt16BE(name.off + 2);
    const strOff = name.off + data.readUInt16BE(name.off + 4);
    for (let i = 0; i < count; i++) {
      const r = name.off + 6 + i * 12;
      const pid = data.readUInt16BE(r);
      const nameId = data.readUInt16BE(r + 6);
      const len = data.readUInt16BE(r + 8);
      const off = data.readUInt16BE(r + 10);
      if (nameId !== 6) continue;
      const raw = data.subarray(strOff + off, strOff + off + len);
      postscriptName = pid === 3 || pid === 0 ? Buffer.from(raw).swap16().toString('utf16le') : raw.toString('latin1');
      if (postscriptName) break;
    }
  }
  postscriptName = postscriptName.replace(/[^A-Za-z0-9\-]/g, '') || 'EmbeddedFont';
  const k = 1000 / unitsPerEm;
  return {
    data,
    unitsPerEm,
    bbox: bbox.map((v) => Math.round(v * k)) as [number, number, number, number],
    ascent: Math.round(ascent * k),
    descent: Math.round(descent * k),
    capHeight: Math.round(capHeight * k),
    italicAngle,
    fixedPitch,
    widths,
    postscriptName,
    cff: data.toString('latin1', 0, 4) === 'OTTO' || tables.has('CFF '),
  };
}

export type FontRef = { kind: 'standard'; name: string } | { kind: 'ttf'; info: TtfInfo };

interface PageData {
  width: number;
  height: number;
  ops: string[];
  fonts: Set<string>;
  gs: boolean;
}

export class PdfDocument {
  fonts = new Map<string, FontRef>();
  private pages: PageData[] = [];
  private current: PageData | null = null;
  /** Characters that could not be encoded (replaced with ?). */
  unencodable = 0;
  compress = true;

  registerFont(alias: string, ref: FontRef) {
    this.fonts.set(alias, ref);
  }

  addPage(width: number, height: number) {
    this.current = { width, height, ops: [], fonts: new Set(), gs: false };
    this.pages.push(this.current);
  }

  /** Width of `text` in points (unencodable characters measure as "?"). */
  measure(alias: string, text: string, size: number): number {
    const ref = this.fonts.get(alias);
    let units = 0;
    for (const ch of text) {
      let code = winAnsiCode(ch.codePointAt(0)!);
      if (code < 0) code = 0x3f;
      if (!ref || ref.kind === 'standard') units += STANDARD_WIDTHS[(ref as any)?.name]?.(code) ?? 600;
      else units += ref.info.widths[code - 32] ?? 500;
    }
    return (units * size) / 1000;
  }

  get pageCount() {
    return this.pages.length;
  }

  private encode(text: string): string {
    let out = '';
    for (const ch of text) {
      let code = winAnsiCode(ch.codePointAt(0)!);
      if (code < 0) {
        this.unencodable++;
        code = 0x3f;
      }
      if (code === 0x28 || code === 0x29 || code === 0x5c) out += '\\' + String.fromCharCode(code);
      else if (code < 0x20 || code > 0x7e) out += '\\' + code.toString(8).padStart(3, '0');
      else out += String.fromCharCode(code);
    }
    return out;
  }

  /** Draws text with its baseline at (x, y) measured from the top-left of the page. */
  text(x: number, y: number, text: string, font: string, size: number, gray = 0) {
    const p = this.current!;
    p.fonts.add(font);
    const py = p.height - y;
    p.ops.push(`BT ${gray ? `${gray.toFixed(3)} g ` : ''}/${font} ${fmt(size)} Tf ${fmt(x)} ${fmt(py)} Td (${this.encode(text)}) Tj ET${gray ? ' 0 g' : ''}`);
  }

  line(x1: number, y1: number, x2: number, y2: number, width = 0.6) {
    const p = this.current!;
    p.ops.push(`${fmt(width)} w ${fmt(x1)} ${fmt(p.height - y1)} m ${fmt(x2)} ${fmt(p.height - y2)} l S`);
  }

  /** Large rotated text centred on the page (drawn first so it sits under the script). */
  watermark(text: string, font: string, size: number, gray: number, angleDeg: number, textWidth: number) {
    const p = this.current!;
    p.fonts.add(font);
    const a = (angleDeg * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const cx = p.width / 2;
    const cy = p.height / 2;
    const tx = cx - (cos * textWidth) / 2 + (sin * size * 0.35);
    const ty = cy - (sin * textWidth) / 2 - (cos * size * 0.35);
    p.ops.unshift(`q ${gray.toFixed(3)} g BT /${font} ${fmt(size)} Tf ${fmt(cos)} ${fmt(sin)} ${fmt(-sin)} ${fmt(cos)} ${fmt(tx)} ${fmt(ty)} Tm (${this.encode(text)}) Tj ET Q`);
  }

  toBuffer(info: { title?: string; author?: string } = {}): Buffer {
    const objs: Array<Buffer> = [];
    const alloc = () => {
      objs.push(Buffer.alloc(0));
      return objs.length; // object number
    };
    const set = (n: number, body: string | Buffer) => {
      objs[n - 1] = typeof body === 'string' ? Buffer.from(body, 'latin1') : body;
    };
    const stream = (dict: string, data: Buffer, compress = this.compress): Buffer => {
      const payload = compress ? deflateSync(data) : data;
      const d = `<< ${dict}${compress ? ' /Filter /FlateDecode' : ''} /Length ${payload.length} >>\nstream\n`;
      return Buffer.concat([Buffer.from(d, 'latin1'), payload, Buffer.from('\nendstream', 'latin1')]);
    };

    const catalog = alloc();
    const pagesObj = alloc();
    const infoObj = alloc();

    // Fonts actually used
    const used = new Set<string>();
    for (const p of this.pages) for (const f of p.fonts) used.add(f);
    const fontObj = new Map<string, number>();
    for (const alias of used) {
      const ref = this.fonts.get(alias);
      if (!ref) throw new Error(`Unknown font ${alias}`);
      const n = alloc();
      fontObj.set(alias, n);
      if (ref.kind === 'standard') {
        set(n, `<< /Type /Font /Subtype /Type1 /BaseFont /${ref.name} /Encoding /WinAnsiEncoding >>`);
      } else {
        const fi = ref.info;
        const fileN = alloc();
        set(fileN, fi.cff ? stream('/Subtype /OpenType', fi.data) : stream(`/Length1 ${fi.data.length}`, fi.data));
        const descN = alloc();
        const flags = (fi.fixedPitch ? 1 : 0) | 32 | (fi.italicAngle !== 0 ? 64 : 0);
        set(
          descN,
          `<< /Type /FontDescriptor /FontName /${fi.postscriptName} /Flags ${flags} /FontBBox [${fi.bbox.join(' ')}] /ItalicAngle ${fmt(fi.italicAngle)} /Ascent ${fi.ascent} /Descent ${fi.descent} /CapHeight ${fi.capHeight} /StemV 80 /${fi.cff ? 'FontFile3' : 'FontFile2'} ${fileN} 0 R >>`,
        );
        set(
          n,
          `<< /Type /Font /Subtype /${fi.cff ? 'Type1' : 'TrueType'} /BaseFont /${fi.postscriptName} /FirstChar 32 /LastChar 255 /Widths [${fi.widths.join(' ')}] /Encoding /WinAnsiEncoding /FontDescriptor ${descN} 0 R >>`,
        );
      }
    }

    const pageNums: number[] = [];
    for (const p of this.pages) {
      const contentN = alloc();
      set(contentN, stream('', Buffer.from(p.ops.join('\n'), 'latin1')));
      const pageN = alloc();
      pageNums.push(pageN);
      const fontDict = [...p.fonts].map((f) => `/${f} ${fontObj.get(f)} 0 R`).join(' ');
      set(
        pageN,
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${fmt(p.width)} ${fmt(p.height)}] /Resources << /Font << ${fontDict} >> >> /Contents ${contentN} 0 R >>`,
      );
    }
    set(pagesObj, `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageNums.length} >>`);
    set(catalog, `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);
    const now = new Date();
    const d = `D:${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
    set(
      infoObj,
      `<< /Producer (Scriptwright) /CreationDate (${d})${info.title ? ` /Title ${pdfString(info.title)}` : ''}${info.author ? ` /Author ${pdfString(info.author)}` : ''} >>`,
    );

    const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    let offset = chunks[0].length;
    const offsets: number[] = [];
    objs.forEach((body, i) => {
      offsets.push(offset);
      const head = Buffer.from(`${i + 1} 0 obj\n`, 'latin1');
      const tail = Buffer.from('\nendobj\n', 'latin1');
      chunks.push(head, body, tail);
      offset += head.length + body.length + tail.length;
    });
    const xrefStart = offset;
    let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
    xref += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${infoObj} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
    chunks.push(Buffer.from(xref, 'latin1'));
    return Buffer.concat(chunks);
  }
}

/** Built-in fonts used here are all Courier (fixed 600 units). */
const STANDARD_WIDTHS: Record<string, (code: number) => number> = {};

function pad(n: number) {
  return String(n).padStart(2, '0');
}

function fmt(n: number): string {
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
}

/** PDF text string as UTF-16BE hex (for document info). */
function pdfString(s: string): string {
  const buf = Buffer.from('﻿' + s, 'utf16le').swap16();
  return `<${buf.toString('hex')}>`;
}
