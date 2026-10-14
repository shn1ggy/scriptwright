// Reading a screenplay PDF back into Fountain.
//
// A PDF keeps no notion of "dialogue" or "scene heading", only text at positions. Screenplays
// are laid out on a fixed grid, though: action at the left margin, dialogue about ten
// characters in, parentheticals about fifteen, character cues about twenty, transitions on
// the right. The columns are measured from the document itself (so A4 German layouts work as
// well as US Letter ones), every line is assigned to the nearest column, and page furniture
// (page numbers, (MORE)/(CONT'D), scene numbers in the margins, revision asterisks, headers) is
// left out. Lines of one paragraph are joined again.

export interface PdfItem {
  str: string;
  /** Left edge and baseline, in points from the top-left corner of the page. */
  x: number;
  y: number;
  /** Advance width of the string in points. */
  w: number;
  size: number;
}

export interface PdfPageText {
  width: number;
  height: number;
  items: PdfItem[];
}

export interface PdfImportResult {
  text: string;
  /** Pages read, scenes found, and what could not be recognised. */
  stats: { pages: number; scenes: number; cues: number; titlePage: boolean };
  warnings: string[];
}

interface Seg {
  x: number;
  end: number;
  text: string;
}

interface Line {
  y: number;
  segs: Seg[];
  page: number;
}

type Kind = 'heading' | 'action' | 'cue' | 'paren' | 'dialogue' | 'transition' | 'centered';

interface Classified {
  kind: Kind;
  text: string;
  y: number;
  page: number;
  /** Written scene number in the margin (headings). */
  number?: string;
  /** Second column of dual dialogue. */
  dual?: boolean;
}

const HEADING_RE = /^(?:\d+[A-Z]?\.?\s+)?(INT|EXT|EST|INT\.?\/EXT|EXT\.?\/INT|I\/E|INNEN|AUSSEN|AUẞEN|INNEN\/AUSSEN|AUSSEN\/INNEN|I\/A)(?=[\s./—–-])/iu;
const TRANSITION_RE = /^(?:[A-ZÄÖÜ][A-ZÄÖÜ ]* TO:|FADE (?:IN|OUT)[.:]?|FADE TO BLACK[.:]?|CUT TO BLACK[.:]?|SMASH CUT[.:]?|MATCH CUT[.:]?|DISSOLVE[.:]?|INTERCUT[.:]?|(?:AB|AUF|ÜBER)BLENDE[.:]?|SCHNITT(?: AUF)?[.:]?|SCHWARZBLENDE[.:]?|ENDE[.:]?|THE END[.:]?)$/u;
const FURNITURE_RE = /^(?:\d{1,4}[A-Z]{0,2}\.?|\(?CONTINUED\)?:?|CONTINUED:?\s*\(\d+\)|\(MORE\)|\(MEHR\)|\(FORTS\.\)|\*+)$/i;
const NUMBER_RE = /^[A-Z]{0,2}\d{1,4}[A-Z]{0,3}\.?$/;
const CONTD_RE = /\s*\((?:CONT['’]?D|CONT\.|CONTINUING|FORTS\.?|WEITER)\)\s*$/i;

/** Letters only, all capitals (character cues, headings, transitions). */
function isUpper(s: string): boolean {
  const letters = s.replace(/\([^)]*\)/g, '').replace(/[^\p{L}]/gu, '');
  return letters.length > 0 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** The most frequent value after rounding to `step`. */
function mode(xs: number[], step: number): number | null {
  const m = new Map<number, number>();
  for (const x of xs) {
    const k = Math.round(x / step) * step;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  let best: number | null = null;
  let n = 0;
  for (const [k, c] of m) if (c > n || (c === n && best !== null && k < best)) [best, n] = [k, c];
  return best;
}

/** Text items of a page as lines (by baseline) of segments (separated by wide gaps). */
function linesOf(page: PdfPageText, pageNo: number, charW: number): Line[] {
  const items = page.items.filter((i) => i.str.trim() || i.str === ' ').sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: PdfItem[][] = [];
  for (const it of items) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0].y - it.y) < Math.max(2, it.size * 0.35)) row.push(it);
    else rows.push([it]);
  }
  const out: Line[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x);
    const segs: Seg[] = [];
    for (const it of row) {
      const last = segs[segs.length - 1];
      const gap = last ? it.x - last.end : Infinity;
      // A number standing apart (scene numbers next to the heading) is its own segment.
      const apart = NUMBER_RE.test(it.str.trim()) && gap > charW * 0.6;
      // Large type (a title) has wider gaps between words.
      const cw = Math.max(charW, it.size * 0.6);
      if (last && gap < cw * 2.5 && !apart) {
        const spaces = gap > charW * 0.4 && !last.text.endsWith(' ') && !it.str.startsWith(' ') ? ' ' : '';
        last.text += spaces + it.str;
        last.end = Math.max(last.end, it.x + it.w);
      } else segs.push({ x: it.x, end: it.x + it.w, text: it.str });
    }
    const clean = segs.map((s) => ({ ...s, text: s.text.replace(/\s+/g, ' ').trim() })).filter((s) => s.text);
    if (clean.length) out.push({ y: row[0].y, segs: clean, page: pageNo });
  }
  return out;
}

/** Recognises a title page: no scene heading and only a few lines. */
function isTitlePage(lines: Line[]): boolean {
  if (!lines.length || lines.length > 40) return false;
  return !lines.some((l) => HEADING_RE.test(l.segs.map((s) => s.text).join(' ')));
}

function titlePageFountain(lines: Line[], page: PdfPageText): string {
  const center = page.width / 2;
  const fields: Array<[string, string[]]> = [];
  const add = (k: string, v: string) => {
    const f = fields.find((x) => x[0] === k);
    if (f) f[1].push(v);
    else fields.push([k, [v]]);
  };
  let stage: 'title' | 'credit' | 'author' | 'after' = 'title';
  const bottom: Line[] = [];
  let lastY = -1;
  for (const l of lines) {
    const text = l.segs.map((s) => s.text).join('   ');
    const mid = (l.segs[0].x + l.segs[l.segs.length - 1].end) / 2;
    const centered = Math.abs(mid - center) < page.width * 0.12 && l.segs.length === 1;
    if (l.y > page.height * 0.62 && !centered) {
      bottom.push(l);
      continue;
    }
    if (!centered) {
      bottom.push(l);
      continue;
    }
    if (/^(written by|screenplay by|story by|teleplay by|by|von|drehbuch(?: von)?|ein drehbuch von|nach (?:einer|dem).*)$/i.test(text)) {
      add('Credit', text);
      stage = 'author';
      continue;
    }
    // A wide gap after the title: without a credit line, the next block is the author.
    const gap = lastY >= 0 ? l.y - lastY : 0;
    lastY = l.y;
    if (stage === 'title' && fields.some((f) => f[0] === 'Title') && gap > 30) stage = 'author';
    if (stage === 'title') add('Title', text);
    else if (stage === 'author') {
      add('Author', text);
      stage = 'after';
    } else add(/draft|fassung|\d{4}/i.test(text) ? 'Draft date' : 'Notes', text);
  }
  // Bottom corners: left is usually contact details, right the draft and date.
  for (const l of bottom) {
    const left = l.segs.filter((q) => q.x < center).map((q) => q.text).join(' ');
    const right = l.segs.filter((q) => q.x >= center).map((q) => q.text).join(' ');
    if (left) add('Contact', left);
    if (right) add(/\d{2,4}/.test(right) ? 'Draft date' : 'Notes', right);
  }
  const out: string[] = [];
  for (const [k, vs] of fields) {
    if (vs.length === 1) out.push(`${k}: ${vs[0]}`);
    else out.push(`${k}:`, ...vs.map((v) => `    ${v}`));
  }
  return out.join('\n');
}

export function pdfToFountain(pages: PdfPageText[]): PdfImportResult {
  const warnings: string[] = [];
  const allItems = pages.flatMap((p) => p.items).filter((i) => i.str.trim().length >= 4);
  // Width of one character (screenplays are set in Courier): the typical advance per letter.
  const charW = median(allItems.map((i) => i.w / i.str.length)) || 7.2;
  const lineLists = pages.map((p, k) => linesOf(p, k, charW));

  let titleText = '';
  let start = 0;
  if (lineLists.length > 1 && isTitlePage(lineLists[0])) {
    titleText = titlePageFountain(lineLists[0], pages[0]);
    start = 1;
  }

  // Body lines without page furniture (header and footer bands, page numbers, MORE …).
  const body: Line[] = [];
  for (let k = start; k < lineLists.length; k++) {
    const h = pages[k].height;
    for (const l of lineLists[k]) {
      const text = l.segs.map((s) => s.text).join(' ');
      if (l.y < 54 && (l.segs.length <= 2 || /rev|änderung|fassung|draft|\d{1,2}[./]\d{1,2}[./]\d{2,4}/i.test(text))) continue;
      if (l.y > h - 36) continue;
      if (FURNITURE_RE.test(text)) continue;
      body.push(l);
    }
  }
  if (!body.length) return { text: titleText, stats: { pages: pages.length, scenes: 0, cues: 0, titlePage: !!titleText }, warnings: ['No text was found. The PDF may be a scan (an image of the pages).'] };

  // The left margin of the text: where most long lines (action) begin.
  const firstX = body.map((l) => l.segs.find((s) => !NUMBER_RE.test(s.text) || s.text.length > 6)?.x ?? l.segs[0].x);
  const longStarts = body.filter((l, i) => l.segs.reduce((n, s) => n + s.text.length, 0) > 40 && firstX[i] !== undefined).map((l) => firstX[body.indexOf(l)]);
  const leftX = mode(longStarts.length ? longStarts : firstX, charW / 2) ?? Math.min(...firstX);
  const rightEdge = leftX + 62 * charW;

  // Columns, in characters from the left margin, measured from the document.
  const rel = (x: number) => (x - leftX) / charW;
  const upperShort = body.filter((l) => {
    const s = l.segs.find((q) => rel(q.x) > 12 && rel(q.x) < 40);
    return s && isUpper(s.text) && s.text.length < 40 && l.segs.length <= 2;
  });
  const cueCol = mode(upperShort.map((l) => rel(l.segs.find((q) => rel(q.x) > 12)!.x)), 1) ?? 22;
  const dialogueLines = body.filter((l) => {
    const r = rel(l.segs[0].x);
    return r > 4 && r < cueCol - 4 && !l.segs[0].text.startsWith('(');
  });
  const dialCol = mode(dialogueLines.map((l) => rel(l.segs[0].x)), 1) ?? 10;

  // Classify every line.
  const out: Classified[] = [];
  let inDialogue = false;
  let dual = false;
  let lastY = -Infinity;
  let lastPage = -1;
  // Single line spacing: the smallest step between lines that is still a full line.
  const fontSize = median(allItems.map((i) => i.size)) || 12;
  const steps = body.slice(1).map((l, i) => (l.page === body[i].page ? l.y - body[i].y : 0)).filter((d) => d > fontSize * 0.7);
  const lineGap = steps.length ? Math.min(...steps) : fontSize;
  const half = 30; // dual dialogue: the right column starts about halfway along the line
  for (const l of body) {
    const newPara = l.page !== lastPage ? false : l.y - lastY > lineGap * 1.5;
    if (newPara) {
      inDialogue = false;
      dual = false;
    }
    lastY = l.y;
    lastPage = l.page;
    // Scene numbers in the margins and revision asterisks at the right edge.
    let number: string | undefined;
    const segs = l.segs.filter((s) => {
      if (NUMBER_RE.test(s.text) && (s.end < leftX - charW * 0.5 || s.x > rightEdge - charW * 4)) {
        number = s.text.replace(/\.$/, '');
        return false;
      }
      if (/^\*+$/.test(s.text) && s.x > rightEdge - charW * 6) return false;
      return true;
    });
    if (!segs.length) continue;
    const kindOf = (t: string): Kind => (isUpper(t) && !/[.!?]$/.test(t) && t.length < 30 ? 'cue' : t.startsWith('(') ? 'paren' : 'dialogue');
    // Dual dialogue: two speeches side by side, the right one starting about halfway.
    const right = segs.findIndex((q) => rel(q.x) > half - 8 && rel(q.x) < half + 12);
    const twoCues = segs.length === 2 && right === 1 && rel(segs[0].x) > 2 && isUpper(segs[0].text) && isUpper(segs[1].text) && segs[0].text.length < 30 && segs[1].text.length < 30;
    if (twoCues) dual = true;
    if (dual) {
      for (const q of segs) {
        const isRight = rel(q.x) > half - 8;
        out.push({ kind: kindOf(q.text), text: q.text, y: l.y, page: l.page, dual: isRight });
      }
      inDialogue = true;
      continue;
    }
    const text = segs.map((q) => q.text).join(' ');
    const r = rel(segs[0].x);
    const mid = (segs[0].x + segs[segs.length - 1].end) / 2;
    const centeredOnPage = Math.abs(mid - pages[l.page].width / 2) < charW * 2;
    const rightAligned = Math.abs(segs[segs.length - 1].end - rightEdge) < charW * 2;
    let kind: Kind;
    if (r < 4) {
      if (HEADING_RE.test(text) || (number && isUpper(text))) kind = 'heading';
      else if (isUpper(text) && / TO:$/.test(text)) kind = 'transition';
      else kind = 'action';
    } else if (isUpper(text) && rightAligned && (TRANSITION_RE.test(text) || /[:.]$/.test(text))) kind = 'transition';
    else if (centeredOnPage && r > 6 && !inDialogue && Math.abs(r - dialCol) > 1.5 && !(Math.abs(r - cueCol) <= 2 && isUpper(text) && !TRANSITION_RE.test(text))) kind = 'centered';
    else if (isUpper(text) && TRANSITION_RE.test(text)) kind = 'transition';
    else if (Math.abs(r - cueCol) <= 4 && isUpper(text) && text.length < 45) kind = 'cue';
    else if (text.startsWith('(') && r > dialCol + 1) kind = 'paren';
    else if (inDialogue && r > 3 && r < cueCol - 2) kind = out[out.length - 1]?.kind === 'paren' && !/\)\s*$/.test(out[out.length - 1].text) && r > dialCol + 1 ? 'paren' : 'dialogue';
    else if (r > 3 && r < cueCol - 2 && out.length && (out[out.length - 1].kind === 'dialogue' || out[out.length - 1].kind === 'paren')) kind = 'dialogue';
    else kind = 'action';
    if (kind === 'cue') inDialogue = true;
    else if (kind !== 'dialogue' && kind !== 'paren') inDialogue = false;
    out.push({ kind, text, y: l.y, page: l.page, number: kind === 'heading' ? number : undefined });
  }

  // Assemble Fountain: join wrapped lines, blank lines between elements.
  const parts: string[] = [];
  let prev: Classified | null = null;
  let lastCue = '';
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) parts.push(paragraph.join('\n'));
    paragraph = [];
  };
  let scenes = 0;
  let cues = 0;
  let dualPending: Classified[] = [];
  const flushDual = () => {
    if (!dualPending.length) return;
    // The right column follows as its own speech, its cue marked with ^.
    flush();
    const lines: string[] = [];
    let prevKind: Kind | null = null;
    for (const d of dualPending) {
      if (d.kind === 'cue' && prevKind === null) lines.push(`${d.text} ^`);
      else if (d.kind === 'dialogue' && prevKind === 'dialogue') lines[lines.length - 1] += ' ' + d.text;
      else if (d.kind === 'paren' && prevKind === 'paren' && !/\)\s*$/.test(lines[lines.length - 1])) lines[lines.length - 1] += ' ' + d.text;
      else lines.push(d.kind === 'cue' ? d.text : d.text);
      prevKind = d.kind;
    }
    if (lines.length) {
      cues++;
      parts.push(lines.join('\n'));
    }
    dualPending = [];
  };
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (c.dual) {
      dualPending.push(c);
      continue;
    }
    if (dualPending.length && c.kind !== 'dialogue' && c.kind !== 'paren') flushDual();
    const sameBlock = prev && c.page === prev.page && c.y - prev.y <= lineGap * 1.5;
    const pageTurn = prev && c.page !== prev.page;
    switch (c.kind) {
      case 'heading': {
        flush();
        scenes++;
        let h = c.text.replace(/^\d+[A-Z]?\.?\s+/, '');
        if (!HEADING_RE.test(h)) h = '.' + h;
        parts.push(c.number ? `${h} #${c.number}#` : h);
        break;
      }
      case 'transition':
        flush();
        parts.push(/TO:$/.test(c.text) ? c.text : `> ${c.text}`);
        break;
      case 'centered':
        if (!(prev?.kind === 'centered' && sameBlock)) flush();
        paragraph.push(`> ${c.text} <`);
        break;
      case 'cue': {
        // After a page break, "NAME (CONT'D)" only repeats the cue of the speech that continues.
        const base = c.text.replace(CONTD_RE, '').trim();
        // The speech simply goes on: keep `prev` on its last line so the text joins up.
        if (pageTurn && base === lastCue && (prev?.kind === 'dialogue' || prev?.kind === 'paren')) continue;
        flush();
        cues++;
        lastCue = base;
        // A cue Fountain would not recognise (lowercase letters, numbers only) is forced with @.
        paragraph.push(/\p{Ll}/u.test(c.text.replace(/\([^)]*\)/g, '')) || !/\p{L}/u.test(c.text) ? `@${c.text}` : c.text);
        break;
      }
      case 'paren':
        if (paragraph.length && (prev?.kind === 'paren') && !/\)\s*$/.test(paragraph[paragraph.length - 1])) paragraph[paragraph.length - 1] += ' ' + c.text;
        else paragraph.push(c.text);
        break;
      case 'dialogue':
        if (paragraph.length && prev?.kind === 'dialogue') paragraph[paragraph.length - 1] += ' ' + c.text;
        else paragraph.push(c.text);
        break;
      case 'action': {
        const cont = prev?.kind === 'action' && (sameBlock || (pageTurn && !/[.!?:"”’)]$/.test(paragraph[paragraph.length - 1] ?? '')));
        if (cont && paragraph.length) paragraph[paragraph.length - 1] += ' ' + c.text;
        else {
          flush();
          // Action written in capitals would read as a heading or cue: force it with !.
          paragraph.push(isUpper(c.text) && (HEADING_RE.test(c.text) || / TO:$/.test(c.text)) ? `!${c.text}` : c.text);
        }
        break;
      }
    }
    prev = c;
  }
  flushDual();
  flush();
  const bodyText = parts.join('\n\n');
  if (!scenes) warnings.push('No scene headings were recognised.');
  return { text: (titleText ? titleText + '\n\n' : '') + bodyText + '\n', stats: { pages: pages.length, scenes, cues, titlePage: !!titleText }, warnings };
}

/** Text with positions from a PDF, using PDF.js (the same code in the app and in tests). */
export async function readPdfText(pdfjs: any, data: Uint8Array): Promise<PdfPageText[]> {
  const doc = await pdfjs.getDocument({ data, useSystemFonts: false, isEvalSupported: false }).promise;
  const pages: PdfPageText[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items: PdfItem[] = [];
    for (const it of tc.items as any[]) {
      if (typeof it.str !== 'string' || !it.str) continue;
      const [a, b, , , e, f] = it.transform;
      const size = Math.hypot(a, b) || it.height || 12;
      // PDF.js joins runs on one line with spaces; wide gaps separate real columns again.
      const cw = it.str.length ? it.width / it.str.length : 0;
      const re = /\S+(?:\s{1,2}\S+)*/g;
      let m: RegExpExecArray | null;
      let any = false;
      while ((m = re.exec(it.str))) {
        any = true;
        items.push({ str: m[0], x: e + m.index * cw, y: vp.height - f, w: m[0].length * cw, size });
      }
      if (!any) continue;
    }
    pages.push({ width: vp.width, height: vp.height, items });
    page.cleanup?.();
  }
  await doc.destroy?.();
  return pages;
}
