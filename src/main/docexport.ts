// PDF of a document (exposé, treatment …): a simple book page with headings, paragraphs and
// lists, set in a serif or sans face from the system (Courier Prime when none is found), or
// in the screenplay's own monospace face.

import { PdfDocument } from './pdfwriter';
import { RenderInfo, registerFamily } from './pdfexport';
import { parse } from '../shared/fountain';
import { S_BOLD, S_ITALIC, S_UNDERLINE, styledText } from '../shared/paginate';
import { PaperSize, paperDims } from '../shared/types';

export interface DocumentPdfOptions {
  paper: PaperSize;
  /** Project title and author, set above the text on the first page. */
  title: string;
  author: string;
  /** The document's own name ("Exposé"). */
  docTitle: string;
  /** Paragraphs set justified (flush on both sides). */
  justify?: boolean;
  /** Serif (default), sans or the screenplay's monospace face (`mono` names that family). */
  font?: 'serif' | 'sans' | 'mono';
  mono?: string;
}

const SERIFS = ['Charter', 'Iowan Old Style', 'Georgia', 'Cambria', 'Palatino', 'Book Antiqua', 'Times New Roman', 'Liberation Serif', 'DejaVu Serif'];
// The same order as on screen: Segoe UI on Windows, Avenir Next on the Mac.
const SANS = ['Segoe UI', 'Avenir Next', 'Helvetica Neue', 'Arial', 'Liberation Sans', 'DejaVu Sans'];
const GREY: [number, number, number] = [0.42, 0.42, 0.42];

interface Seg {
  text: string;
  style: number;
}

function segments(text: string, styles: number[]): Seg[] {
  const out: Seg[] = [];
  for (let k = 0; k < text.length; k++) {
    const st = styles[k] & (S_BOLD | S_ITALIC | S_UNDERLINE);
    const last = out[out.length - 1];
    if (last && last.style === st) last.text += text[k];
    else out.push({ text: text[k], style: st });
  }
  return out;
}

export function renderDocumentPdf(text: string, o: DocumentPdfOptions, info: RenderInfo): Buffer {
  const doc = new PdfDocument();
  let family = 'Courier Prime';
  const mono = o.font === 'mono';
  if (mono) family = o.mono || 'Courier Prime';
  else {
    const available = new Set((info.families?.() ?? []).map((f) => f.family));
    for (const f of o.font === 'sans' ? SANS : SERIFS) {
      if (available.has(f)) {
        family = f;
        break;
      }
    }
  }
  registerFamily(doc, 'F', family, info);
  const font = (style: number) => `F${(style & S_BOLD ? 1 : 0) + (style & S_ITALIC ? 2 : 0)}`;

  const dims = paperDims(o.paper);
  const W = dims.width;
  const H = dims.height;
  const left = 72;
  const right = W - 72;
  const top = 72;
  const bottom = H - 72;
  const width = right - left;
  let y = top;
  let page = 0;
  const newPage = () => {
    doc.addPage(W, H);
    page++;
    y = top;
    const label = String(page);
    doc.text((W - doc.measure('F0', label, 9)) / 2, H - 40, label, 'F0', 9, 0, GREY);
  };
  newPage();

  /** Sets styled text wrapped to the column; returns nothing, advances y. */
  const paragraph = (segs: Seg[], size: number, lead: number, indent = 0, extraStyle = 0, align: 'left' | 'center' | 'right' | 'justify' = 'left') => {
    // Words keep their styled pieces; spaces separate them.
    type Word = { segs: Seg[]; w: number };
    const words: Word[] = [];
    let cur: Word | null = null;
    for (const s of segs) {
      const style = s.style | extraStyle;
      for (const part of s.text.split(/(\s+)/)) {
        if (!part) continue;
        if (/^\s+$/.test(part)) {
          cur = null;
          continue;
        }
        if (!cur) {
          cur = { segs: [], w: 0 };
          words.push(cur);
        }
        cur.segs.push({ text: part, style });
        cur.w += doc.measure(font(style), part, size);
      }
    }
    const space = doc.measure('F0', ' ', size);
    const avail = width - indent;
    let line: Word[] = [];
    let lineW = 0;
    const flush = (last: boolean) => {
      if (!line.length) return;
      if (y + lead > bottom) newPage();
      let x = left + indent;
      const free = avail - lineW;
      if (align === 'center') x += free / 2;
      else if (align === 'right') x += free;
      // Justified: the gaps share the free space, except on a paragraph's last line.
      const gap = align === 'justify' && !last && line.length > 1 ? space + free / (line.length - 1) : space;
      const base = y + size * 0.8;
      line.forEach((w, i) => {
        if (i > 0) x += gap;
        for (const s of w.segs) {
          const sw = doc.measure(font(s.style), s.text, size);
          doc.text(x, base, s.text, font(s.style), size);
          if (s.style & S_UNDERLINE) doc.line(x, base + size * 0.15, x + sw, base + size * 0.15, Math.max(0.5, size / 22));
          x += sw;
        }
      });
      y += lead;
      line = [];
      lineW = 0;
    };
    for (const w of words) {
      const need = line.length ? lineW + space + w.w : w.w;
      if (line.length && need > avail) flush(false);
      lineW = line.length ? lineW + space + w.w : w.w;
      line.push(w);
    }
    flush(true);
  };

  // Head: project title, then the document's name and the author.
  paragraph([{ text: o.title || o.docTitle, style: S_BOLD }], 20, 26);
  const sub = [o.docTitle, o.author].filter(Boolean).join(' · ');
  if (sub && o.title) {
    doc.text(left, y + 11 * 0.8, sub, 'F0', 11, 0, GREY);
    y += 16;
  }
  y += 22;

  const lines = text.split('\n');
  const parsed = parse(lines, { prose: true });
  // The typewriter face is set like a screenplay page: 12 pt.
  const body = mono ? 12 : 11.5;
  const lead = body * (mono ? 1.4 : 1.5);
  let prevBlank = true;
  for (let i = 0; i < lines.length; i++) {
    const pl = parsed.lines[i];
    if (pl.type === 'blank' || pl.type === 'note' || pl.type === 'boneyard') {
      if (pl.type === 'blank' && !prevBlank) y += lead * 0.55;
      prevBlank = pl.type === 'blank' || prevBlank;
      continue;
    }
    const st = styledText(lines[i], pl.flags);
    const segs = segments(st.text.trim() ? st.text : '', st.styles);
    if (pl.type === 'section') {
      const lvl = pl.level ?? 1;
      const size = lvl === 1 ? 15 : lvl === 2 ? 12.5 : 11.5;
      y += prevBlank ? lead * 0.3 : lead * 0.8;
      // Keep a heading with at least two lines of what follows.
      if (y + size * 1.4 + lead * 2 > bottom) newPage();
      paragraph(segs, size, size * 1.4, 0, lvl === 3 ? S_BOLD | S_ITALIC : S_BOLD, pl.align ?? 'left');
      y += 4;
    } else if (pl.type === 'listItem') {
      if (y + lead > bottom) newPage();
      doc.text(left + 4, y + body * 0.8, '•', 'F0', body);
      paragraph(segs, body, lead, 16);
    } else {
      paragraph(segs, body, lead, 0, 0, pl.align ?? (o.justify ? 'justify' : 'left'));
    }
    prevBlank = false;
  }
  return doc.toBuffer({ title: [o.title, o.docTitle].filter(Boolean).join(' – '), author: o.author });
}
