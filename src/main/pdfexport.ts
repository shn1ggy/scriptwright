// Turns pagination into PDF bytes.

import fs from 'fs';
import path from 'path';
import { PdfDocument, TtfInfo, parseTtf } from './pdfwriter';
import { PaginationResult, S_BOLD, S_CHANGED, S_ITALIC, S_UNDERLINE } from '../shared/paginate';
import { ExportSettings } from '../shared/types';
import { FontFamily, loadFontData, pickFace } from './fonts';

export interface RenderInfo {
  title?: string;
  author?: string;
  fontsDir?: string;
  /** System font families, for fonts other than Courier and Courier Prime. */
  families?: () => FontFamily[];
  /** "Changes since …" when revision marks are shown. */
  revisionLabel?: string;
}

function hexRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0x1e63c8;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export interface RenderOutput {
  pdf: Buffer;
  warnings: string[];
  fontUsed: string;
}

const ttfCache = new Map<string, TtfInfo | null>();

function cached(key: string, load: () => Buffer): TtfInfo | null {
  if (ttfCache.has(key)) return ttfCache.get(key)!;
  let info: TtfInfo | null = null;
  try {
    info = parseTtf(load());
  } catch {
    info = null;
  }
  ttfCache.set(key, info);
  return info;
}

const COURIER_PRIME_FILES = ['CourierPrime-Regular.ttf', 'CourierPrime-Bold.ttf', 'CourierPrime-Italic.ttf', 'CourierPrime-BoldItalic.ttf'];
const COURIER_STD = ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'];

export interface ResolvedFamily {
  name: string;
  /** Character advance in em (monospaced families). */
  advance: number;
}

/**
 * Registers <prefix>0..3 (regular, bold, italic, bold italic) for a family:
 * the bundled Courier Prime, PDF's built-in Courier, or a system family.
 * Falls back to Courier when the family is not available.
 */
export function registerFamily(doc: PdfDocument, prefix: string, family: string, info: RenderInfo): ResolvedFamily {
  if (family === 'Courier Prime' && info.fontsDir) {
    const faces = COURIER_PRIME_FILES.map((f) => {
      const file = path.join(info.fontsDir!, f);
      return fs.existsSync(file) ? cached(file, () => fs.readFileSync(file)) : null;
    });
    if (faces.every(Boolean)) {
      faces.forEach((f, i) => doc.registerFont(`${prefix}${i}`, { kind: 'ttf', info: f! }));
      return { name: 'Courier Prime', advance: faces[0]!.widths[0x4d - 32] / 1000 };
    }
  }
  if (family !== 'Courier' && family !== 'Courier Prime' && info.families) {
    const fam = info.families().find((f) => f.family === family);
    if (fam) {
      const styles: Array<[boolean, boolean]> = [
        [false, false],
        [true, false],
        [false, true],
        [true, true],
      ];
      const loaded = styles.map(([b, it]) => {
        const face = pickFace(fam.faces, b, it);
        return cached(`${face.file}#${face.index}`, () => loadFontData(face));
      });
      if (loaded[0]) {
        loaded.forEach((f, i) => doc.registerFont(`${prefix}${i}`, { kind: 'ttf', info: (f ?? loaded[0])! }));
        return { name: family, advance: loaded[0].widths[0x4d - 32] / 1000 };
      }
    }
  }
  COURIER_STD.forEach((n, i) => doc.registerFont(`${prefix}${i}`, { kind: 'standard', name: n }));
  return { name: 'Courier', advance: 0.6 };
}

function styleIndex(style: number): number {
  return (style & S_BOLD ? 1 : 0) + (style & S_ITALIC ? 2 : 0);
}

export function fillTemplate(t: string, vars: Record<string, string>): string {
  return t.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

/** Resolves the script font (to learn its advance width before paginating). */
export function scriptFontAdvance(s: ExportSettings, info: RenderInfo): number {
  const doc = new PdfDocument();
  return registerFamily(doc, 'F', s.font, info).advance;
}

export function renderPdf(result: PaginationResult, s: ExportSettings, info: RenderInfo = {}): RenderOutput {
  const doc = new PdfDocument();
  const warnings = [...result.warnings];
  const used = registerFamily(doc, 'F', s.font, info);
  if (used.name !== s.font)
    warnings.push(s.font === 'Courier Prime' ? 'Courier Prime font files were not found (they are downloaded by npm install); Courier was used instead.' : `The font "${s.font}" is not installed; Courier was used instead.`);
  const titleUsed = registerFamily(doc, 'T', s.titleFont, info);
  if (titleUsed.name !== s.titleFont && s.titleFont !== s.font) warnings.push(`The title font "${s.titleFont}" is not available; Courier was used.`);
  // Title page details are set in Courier at 12 pt.
  registerFamily(doc, 'C', s.font === 'Courier Prime' ? 'Courier Prime' : 'Courier', info);

  const cap = result.capacity;
  const charW = cap.charWidth;
  const lineH = cap.lineHeight;
  const left = cap.left;
  const top = cap.top;
  const baseline = s.fontSize * 0.78;
  const actionRight = left + cap.actionChars * charW;
  const W = cap.pageWidth;
  const H = cap.pageHeight;
  const totalPages = result.bodyPageCount;
  const vars = (n: number) => ({ title: info.title ?? '', page: String(n), pages: String(totalPages), date: s.draftDate });
  // Page furniture sits in the margins, aligned with the text column.
  const headerY = Math.max(lineH, top - 2 * lineH) + baseline;
  const footerY = Math.min(H - lineH, cap.textBottom + 2 * lineH) + baseline;

  const revRgb = hexRgb(s.revColor);
  // Light tint of the revision color for highlighting.
  const revTint: [number, number, number] = revRgb.map((c) => 1 - (1 - c) * 0.22) as [number, number, number];
  const markX = Math.min(W - 3 * charW, actionRight + (s.sceneNumbers === 'right' || s.sceneNumbers === 'both' ? 9 : 4) * charW);

  for (const page of result.pages) {
    doc.addPage(W, H);
    if (s.watermark.trim()) {
      const wm = s.watermark.trim();
      const unit = doc.measure('F1', wm, 1);
      const size = Math.min(110, (W * 1.0) / Math.max(1, unit));
      doc.watermark(wm, 'F1', size, 0.88, 45, unit * size);
    }
    if (page.title) {
      for (const item of page.title) {
        const isTitle = !!item.title;
        const size = isTitle ? s.titleSize : 12;
        const font = isTitle ? `T${s.titleBold ? 1 : 0}` : 'C0';
        const w = doc.measure(font, item.text, size);
        let x = left;
        // The title block is centered on the page; contact details align to the text column.
        if (item.align === 'center') x = (W - w) / 2;
        else if (item.align === 'right') x = actionRight - w;
        doc.text(x, item.y, item.text, font, size);
        if (isTitle && s.titleUnderline && item.text.trim()) doc.line(x, item.y + size * 0.15, x + w, item.y + size * 0.15, Math.max(0.5, size / 24));
      }
      continue;
    }
    const showNumber = s.pageNumbers && (page.number > 1 || s.pageNumberFirstPage);
    const label = showNumber ? fillTemplate(s.pageNumberFormat || '{n}.', { n: String(page.number) }) : '';
    const wOf = (t: string) => doc.measure('F0', t, s.fontSize);
    if (showNumber) {
      if (s.pageNumberPosition === 'top-right') doc.text(actionRight - wOf(label), headerY, label, 'F0', s.fontSize);
      else if (s.pageNumberPosition === 'bottom-right') doc.text(actionRight - wOf(label), footerY, label, 'F0', s.fontSize);
      else doc.text((W - wOf(label)) / 2, footerY, label, 'F0', s.fontSize);
    }
    const revNote = info.revisionLabel && s.revHeaderNote ? info.revisionLabel : '';
    const headerText = [s.header.trim() ? fillTemplate(s.header, vars(page.number)) : '', revNote].filter(Boolean).join(' · ');
    if (headerText) doc.text(left, headerY, headerText, 'F0', s.fontSize, 0, revNote && !s.header.trim() ? revRgb : undefined);
    if (s.label.trim()) {
      const l = fillTemplate(s.label, vars(page.number));
      doc.text((W - wOf(l)) / 2, headerY, l, 'F0', s.fontSize);
    }
    if (s.footer.trim()) {
      const f = fillTemplate(s.footer, vars(page.number));
      const x = s.pageNumberPosition === 'bottom-center' && showNumber ? left : (W - wOf(f)) / 2;
      doc.text(x, footerY, f, 'F0', s.fontSize);
    }
    if (s.draftDate.trim() && !s.header.includes('{date}') && !s.footer.includes('{date}')) {
      const d = s.draftDate.trim();
      doc.text(actionRight - wOf(d), footerY - (s.pageNumberPosition === 'bottom-right' && showNumber ? lineH : 0), d, 'F0', s.fontSize);
    }

    for (const line of page.lines) {
      const y = top + line.row * lineH + baseline;
      let x = left + line.col * charW;
      for (const run of line.runs) {
        if (!run.text) continue;
        const changed = !!(run.style & S_CHANGED);
        const style = changed && s.revBold ? run.style | S_BOLD : run.style;
        const font = `F${styleIndex(style)}`;
        const w = run.text.length * charW;
        if (changed && s.revHighlight && run.text.trim()) doc.rect(x - 0.5, y - s.fontSize * 0.8, w + 1, lineH * 0.98, revTint);
        doc.text(x, y, run.text, font, s.fontSize, 0, changed && s.revColorText ? revRgb : undefined);
        if (run.style & S_UNDERLINE) doc.line(x, y + s.fontSize * 0.14, x + w, y + s.fontSize * 0.14, Math.max(0.5, s.fontSize / 20), changed && s.revColorText ? revRgb : undefined);
        if (changed && s.revUnderline && run.text.trim()) doc.line(x, y + s.fontSize * 0.2, x + w, y + s.fontSize * 0.2, Math.max(0.6, s.fontSize / 16), revRgb);
        x += w;
      }
      if (line.mark && s.revMargin && s.revMarkChar.trim()) doc.text(markX, y, s.revMarkChar.trim().slice(0, 3), 'F1', s.fontSize, 0, s.revColorText || s.revHighlight || s.revUnderline ? revRgb : undefined);
      if (line.sceneNumber && s.sceneNumbers !== 'off') {
        const num = line.sceneNumber;
        if (s.sceneNumbers === 'left' || s.sceneNumbers === 'both') doc.text(Math.max(18, left - (num.length + 4) * charW), y, num, 'F0', s.fontSize);
        if (s.sceneNumbers === 'right' || s.sceneNumbers === 'both') doc.text(actionRight + 4 * charW, y, num, 'F0', s.fontSize);
      }
    }
  }
  if (doc.pageCount === 0) doc.addPage(W, H);
  const pdf = doc.toBuffer({ title: info.title, author: info.author });
  if (doc.unencodable > 0) warnings.push(`${doc.unencodable} character(s) cannot be represented in the PDF font and were replaced with "?".`);
  return { pdf, warnings, fontUsed: used.name };
}
