// Turns pagination into PDF bytes.

import fs from 'fs';
import path from 'path';
import { PdfDocument, TtfInfo, parseTtf } from './pdfwriter';
import { PaginationResult, S_BOLD, S_ITALIC, S_UNDERLINE } from '../shared/paginate';
import { ExportSettings, paperDims } from '../shared/types';

export interface RenderInfo {
  title?: string;
  author?: string;
  fontsDir?: string;
}

export interface RenderOutput {
  pdf: Buffer;
  warnings: string[];
  fontUsed: string;
}

const ttfCache = new Map<string, TtfInfo | null>();

function loadTtf(file: string): TtfInfo | null {
  if (ttfCache.has(file)) return ttfCache.get(file)!;
  let info: TtfInfo | null = null;
  try {
    if (fs.existsSync(file)) info = parseTtf(fs.readFileSync(file));
  } catch {
    info = null;
  }
  ttfCache.set(file, info);
  return info;
}

const COURIER_PRIME_FILES = ['CourierPrime-Regular.ttf', 'CourierPrime-Bold.ttf', 'CourierPrime-Italic.ttf', 'CourierPrime-BoldItalic.ttf'];

/** Registers F0..F3 (regular, bold, italic, bold italic) for the requested family. Returns the family actually used. */
function registerFamily(doc: PdfDocument, prefix: string, family: string, fontsDir?: string): string {
  if (family === 'Courier Prime' && fontsDir) {
    const infos = COURIER_PRIME_FILES.map((f) => loadTtf(path.join(fontsDir, f)));
    if (infos.every(Boolean)) {
      infos.forEach((info, i) => doc.registerFont(`${prefix}${i}`, { kind: 'ttf', info: info! }));
      return 'Courier Prime';
    }
  }
  const std: Record<string, string[]> = {
    Courier: ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'],
    Helvetica: ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'],
    Times: ['Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic'],
  };
  const names = std[family] ?? std.Courier;
  names.forEach((n, i) => doc.registerFont(`${prefix}${i}`, { kind: 'standard', name: n }));
  return std[family] ? family : 'Courier';
}

function styleIndex(style: number): number {
  return (style & S_BOLD ? 1 : 0) + (style & S_ITALIC ? 2 : 0);
}

export function fillTemplate(t: string, vars: Record<string, string>): string {
  return t.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

export function renderPdf(result: PaginationResult, s: ExportSettings, info: RenderInfo = {}): RenderOutput {
  const doc = new PdfDocument();
  const warnings = [...result.warnings];
  const used = registerFamily(doc, 'F', s.font, info.fontsDir);
  if (used !== s.font) warnings.push(`${s.font} font files were not found; Courier was used instead.`);
  const titleFamily = s.titleFont === 'Courier Prime' || s.titleFont === 'Courier' ? s.titleFont : s.titleFont;
  const titleUsed = registerFamily(doc, 'T', titleFamily, info.fontsDir);
  if (titleUsed !== titleFamily && titleFamily !== s.font) warnings.push(`${titleFamily} is unavailable for the title; Courier was used.`);
  // Title page details use Courier at 12pt.
  registerFamily(doc, 'C', s.font === 'Courier Prime' ? 'Courier Prime' : 'Courier', info.fontsDir);

  const dims = paperDims(s.paper);
  const charW = s.fontSize * 0.6;
  const lineH = 72 / s.linesPerInch;
  const left = s.marginLeft * 72;
  const top = s.marginTop * 72;
  const baseline = s.fontSize * 0.78;
  const actionRight = left + result.capacity.actionChars * charW;
  const totalPages = result.bodyPageCount;
  const vars = (n: number) => ({ title: info.title ?? '', page: String(n), pages: String(totalPages), date: s.draftDate });

  for (const page of result.pages) {
    doc.addPage(dims.width, dims.height);
    if (s.watermark.trim()) {
      const wm = s.watermark.trim();
      const size = Math.min(110, (dims.width * 1.05) / Math.max(4, wm.length * 0.62));
      doc.watermark(wm, 'F1', size, 0.88, 45, wm.length * size * 0.6);
    }
    if (page.title) {
      for (const item of page.title) {
        const isTitle = !!item.title;
        const size = isTitle ? s.titleSize : 12;
        const font = isTitle ? `T${(s.titleBold ? 1 : 0)}` : 'C0';
        const w = item.text.length * size * (isTitle && (s.titleFont === 'Helvetica' || s.titleFont === 'Times') ? 0.5 : 0.6);
        let x = left;
        // The title block is centered on the page; contact details align to the margins.
        if (item.align === 'center') x = (dims.width - w) / 2;
        else if (item.align === 'right') x = dims.width - s.marginRight * 72 - w;
        doc.text(x, item.y, item.text, font, size);
        if (isTitle && s.titleUnderline && item.text.trim()) doc.line(x, item.y + size * 0.15, x + w, item.y + size * 0.15, Math.max(0.5, size / 24));
      }
      continue;
    }
    // Page furniture
    const showNumber = s.pageNumbers && (page.number > 1 || s.pageNumberFirstPage);
    const furnitureY = Math.max(lineH, top / 2 + baseline / 2);
    const bottomY = dims.height - Math.max(lineH, (s.marginBottom * 72) / 2) + baseline / 2;
    if (showNumber) {
      const label = fillTemplate(s.pageNumberFormat || '{n}.', { n: String(page.number) });
      const w = label.length * charW;
      if (s.pageNumberPosition === 'top-right') doc.text(dims.width - s.marginRight * 72 - w, furnitureY, label, 'F0', s.fontSize);
      else if (s.pageNumberPosition === 'bottom-right') doc.text(dims.width - s.marginRight * 72 - w, bottomY, label, 'F0', s.fontSize);
      else doc.text((dims.width - w) / 2, bottomY, label, 'F0', s.fontSize);
    }
    if (s.header.trim()) doc.text(left, furnitureY, fillTemplate(s.header, vars(page.number)), 'F0', s.fontSize);
    if (s.label.trim()) {
      const l = fillTemplate(s.label, vars(page.number));
      doc.text((dims.width - l.length * charW) / 2, furnitureY, l, 'F0', s.fontSize);
    }
    if (s.footer.trim()) {
      const f = fillTemplate(s.footer, vars(page.number));
      const x = s.pageNumberPosition === 'bottom-center' && showNumber ? left : (dims.width - f.length * charW) / 2;
      doc.text(x, bottomY, f, 'F0', s.fontSize);
    }
    if (s.draftDate.trim() && !s.header.includes('{date}') && !s.footer.includes('{date}')) {
      const d = s.draftDate.trim();
      doc.text(dims.width - s.marginRight * 72 - d.length * charW, bottomY - (s.pageNumberPosition === 'bottom-right' && showNumber ? lineH : 0), d, 'F0', s.fontSize);
    }

    for (const line of page.lines) {
      const y = top + line.row * lineH + baseline;
      let x = left + line.col * charW;
      for (const run of line.runs) {
        if (!run.text) continue;
        doc.text(x, y, run.text, `F${styleIndex(run.style)}`, s.fontSize);
        if (run.style & S_UNDERLINE) {
          const trimmedLen = run.text.length;
          doc.line(x, y + s.fontSize * 0.14, x + trimmedLen * charW, y + s.fontSize * 0.14, Math.max(0.5, s.fontSize / 20));
        }
        x += run.text.length * charW;
      }
      if (line.sceneNumber && s.sceneNumbers !== 'off') {
        const num = line.sceneNumber;
        if (s.sceneNumbers === 'left' || s.sceneNumbers === 'both') doc.text(Math.max(18, left - 0.75 * 72), y, num, 'F0', s.fontSize);
        if (s.sceneNumbers === 'right' || s.sceneNumbers === 'both') doc.text(actionRight + 0.35 * 72, y, num, 'F0', s.fontSize);
      }
    }
  }
  if (doc.pageCount === 0) doc.addPage(dims.width, dims.height);
  const pdf = doc.toBuffer({ title: info.title, author: info.author });
  if (doc.unencodable > 0) warnings.push(`${doc.unencodable} character(s) cannot be represented in the PDF font and were replaced with "?".`);
  return { pdf, warnings, fontUsed: used };
}
