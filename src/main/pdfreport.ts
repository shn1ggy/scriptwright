// Production reports as PDF: a title, then tables and labelled lines, in Courier.

import { PdfDocument } from './pdfwriter';
import { RenderInfo, registerFamily } from './pdfexport';
import { ReportDoc } from '../shared/reports';
import { PaperSize, paperDims } from '../shared/types';
import { wrap } from '../shared/paginate';
import { t } from '../shared/i18n';

export function renderReportPdf(rep: ReportDoc, paper: PaperSize, info: RenderInfo = {}): Buffer {
  const doc = new PdfDocument();
  registerFamily(doc, 'F', 'Courier Prime', info);
  const { width: W, height: H } = paperDims(paper);
  const size = 9.5;
  const lh = size * 1.25;
  const cw = size * 0.6;
  const M = 48;
  const inner = W - 2 * M;
  const maxChars = Math.floor(inner / cw);
  let y = 0;
  let pageNo = 0;
  const pages: number[] = [];
  const newPage = () => {
    doc.addPage(W, H);
    pageNo++;
    pages.push(pageNo);
    doc.text(M, 34, rep.title, 'F1', 9);
    if (rep.subtitle) doc.text(W - M - doc.measure('F0', rep.subtitle, 9), 34, rep.subtitle, 'F0', 9);
    doc.line(M, 40, W - M, 40, 0.5, [0.6, 0.6, 0.6]);
    doc.text(W / 2 - 10, H - 28, `${pageNo}`, 'F0', 9);
    y = 62;
  };
  const room = (h: number) => {
    if (y + h > H - 48) newPage();
  };
  newPage();
  for (const sec of rep.sections) {
    // Height of the whole section, to keep short ones together.
    const tableRows = (sec.table?.rows ?? []).map((r) => cellsOf(r, sec.table!.columns));
    const height = (sec.heading ? lh * 2 : 0) + (sec.table ? lh * 1.4 + tableRows.reduce((s, r) => s + r.height * lh + 2, 0) : 0) + (sec.lines?.length ?? 0) * lh;
    if (sec.keep && height < H - 110) room(height);
    if (sec.heading) {
      room(lh * 3);
      y += lh * 0.5;
      doc.text(M, y, sec.heading, 'F1', size + 1);
      y += lh * 1.4;
    }
    if (sec.table) {
      const cols = sec.table.columns;
      const xs = positions(cols);
      const head = () => {
        cols.forEach((c, i) => {
          const x = c.align === 'right' ? M + xs[i] + c.width * inner - 2 * cw - doc.measure('F1', c.label, size) : M + xs[i];
          doc.text(x, y, c.label, 'F1', size);
        });
        doc.line(M, y + 4, W - M, y + 4, 0.4, [0.7, 0.7, 0.7]);
        y += lh * 1.4;
      };
      room(lh * 3);
      head();
      tableRows.forEach((r, ri) => {
        if (y + r.height * lh > H - 48) {
          newPage();
          head();
        }
        const bold = sec.table!.boldRows?.includes(ri);
        r.cells.forEach((lines, i) => {
          const c = cols[i];
          lines.forEach((ln, k) => {
            const x = c.align === 'right' ? M + xs[i] + c.width * inner - 2 * cw - doc.measure('F0', ln, size) : M + xs[i];
            doc.text(x, y + k * lh, ln, bold ? 'F1' : 'F0', size);
          });
        });
        y += r.height * lh + 2;
      });
    }
    for (const l of sec.lines ?? []) {
      const label = l.label ? `${l.label}: ` : '';
      const wrapped = wrap(label + l.text, maxChars);
      for (let k = 0; k < wrapped.length; k++) {
        room(lh);
        const [a, b] = wrapped[k];
        const seg = (label + l.text).slice(a, b);
        if (k === 0 && label) {
          doc.text(M, y, label.trimEnd(), 'F1', size);
          doc.text(M + label.length * cw, y, seg.slice(label.length), 'F0', size);
        } else doc.text(M + (k > 0 && label ? label.length * cw : 0), y, seg, 'F0', size);
        y += lh;
      }
    }
    y += lh * 0.6;
  }
  void t;
  return doc.toBuffer({ title: rep.title });

  function positions(cols: Array<{ width: number }>): number[] {
    const out: number[] = [];
    let acc = 0;
    for (const c of cols) {
      out.push(acc * inner);
      acc += c.width;
    }
    return out;
  }
  function cellsOf(row: string[], cols: Array<{ width: number }>) {
    const cells = cols.map((c, i) => {
      const chars = Math.max(3, Math.floor((c.width * inner) / cw) - 1);
      const text = row[i] ?? '';
      return wrap(text, chars).map(([a, b]) => text.slice(a, b));
    });
    return { cells, height: Math.max(1, ...cells.map((c) => c.length)) };
  }
}
