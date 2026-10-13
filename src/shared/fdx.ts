// Final Draft (.fdx) import and export.
//
// Export writes one FDX paragraph per screenplay element with bold, italic and underline
// runs, scene numbers, dual dialogue, page breaks and the title page. Import reads the same
// structure back into Fountain text. Notes, sections, synopses and omitted text stay private.

import { ParseResult, titleFields } from './fountain';
import { S_BOLD, S_ITALIC, S_UNDERLINE, styledText } from './paginate';

// ---------------------------------------------------------------------------------------
// Export

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function styleName(st: number): string {
  const parts: string[] = [];
  if (st & S_BOLD) parts.push('Bold');
  if (st & S_ITALIC) parts.push('Italic');
  if (st & S_UNDERLINE) parts.push('Underline');
  return parts.join('+');
}

/** <Text> runs for styled text (line breaks inside a paragraph are kept as newlines). */
function runs(text: string, styles: number[]): string {
  if (!text) return '<Text></Text>';
  let out = '';
  let start = 0;
  for (let k = 1; k <= text.length; k++) {
    if (k === text.length || (styles[k] ?? 0) !== (styles[start] ?? 0)) {
      const st = styleName(styles[start] ?? 0);
      out += `<Text${st ? ` Style="${st}"` : ''}>${esc(text.slice(start, k))}</Text>`;
      start = k;
    }
  }
  return out;
}

interface Para {
  type: string;
  text: string;
  styles: number[];
  attrs?: Record<string, string>;
  dual?: 'left' | 'right';
}

const TYPE: Record<string, string> = {
  heading: 'Scene Heading',
  action: 'Action',
  character: 'Character',
  dialogue: 'Dialogue',
  parenthetical: 'Parenthetical',
  lyric: 'Lyrics',
  transition: 'Transition',
  centered: 'General',
};

function paraXml(p: Para, newPage: boolean): string {
  const attrs: Record<string, string> = { ...(p.attrs ?? {}) };
  if (p.type === 'centered') attrs.Alignment = 'Center';
  if (newPage) attrs.StartsNewPage = 'Yes';
  const a = Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join('');
  return `    <Paragraph Type="${TYPE[p.type]}"${a}>${runs(p.text, p.styles)}</Paragraph>`;
}

export interface FdxExportOptions {
  /** Scene numbers to write on headings ('' = none), one per scene in order. */
  sceneNumbers?: string[];
  titlePage?: boolean;
}

/** The screenplay as a Final Draft document. */
export function exportFdx(lines: string[], parse: ParseResult, o: FdxExportOptions = {}): string {
  const paras: Array<Para | 'break'> = [];
  const sceneIndex = new Map(parse.scenes.map((s, i) => [s.line, i]));
  let block: Para | null = null; // current multi-line element (action or dialogue lines)
  for (let i = parse.titleEnd; i < lines.length; i++) {
    const pl = parse.lines[i];
    const type = pl.type;
    if (type === 'pageBreak') {
      paras.push('break');
      block = null;
      continue;
    }
    if (!(type in TYPE)) {
      // blank, notes, sections, synopses and boneyard end an element
      if (type === 'blank' || type === 'boneyard') block = null;
      continue;
    }
    const st = styledText(lines[i], pl.flags);
    let text = st.text;
    let styles = st.styles;
    // Trim surrounding spaces (operators are already gone).
    const lead = text.length - text.trimStart().length;
    text = text.trim();
    styles = styles.slice(lead, lead + text.length);
    if (type === 'heading' || type === 'character' || type === 'transition') {
      block = null;
      const p: Para = { type, text, styles, dual: pl.dual };
      if (type === 'heading') {
        const n = o.sceneNumbers?.[sceneIndex.get(i) ?? -1];
        if (n) p.attrs = { Number: n };
      }
      paras.push(p);
      continue;
    }
    // Consecutive lines of the same element continue one paragraph.
    if (block && block.type === type && (type === 'dialogue' || type === 'lyric' || type === 'action')) {
      block.text += '\n' + text;
      block.styles = block.styles.concat([0], styles);
      continue;
    }
    const p: Para = { type, text, styles, dual: pl.dual };
    paras.push(p);
    block = type === 'parenthetical' || type === 'centered' ? null : p;
  }

  // Dual dialogue: the left and right speech go into one <DualDialogue> paragraph.
  const body: string[] = [];
  let newPage = false;
  for (let k = 0; k < paras.length; k++) {
    const p = paras[k];
    if (p === 'break') {
      newPage = true;
      continue;
    }
    if (p.dual === 'left' && p.type === 'character') {
      const group: Para[] = [];
      let j = k;
      let sawRight = false;
      while (j < paras.length) {
        const q = paras[j];
        if (q === 'break' || !q.dual) break;
        if (q.dual === 'right' && q.type === 'character') sawRight = true;
        if (q.dual === 'left' && q.type === 'character' && group.length) break;
        group.push(q);
        j++;
        if (sawRight && j < paras.length && paras[j] !== 'break' && (paras[j] as Para).type === 'character') break;
      }
      if (sawRight) {
        body.push(`    <Paragraph${newPage ? ' StartsNewPage="Yes"' : ''}><DualDialogue>`);
        for (const q of group) body.push('  ' + paraXml(q, false));
        body.push('    </DualDialogue></Paragraph>');
        newPage = false;
        k = j - 1;
        continue;
      }
    }
    body.push(paraXml(p, newPage));
    newPage = false;
  }

  const title: string[] = [];
  if (o.titlePage !== false && parse.titleEnd > 0) {
    const fields = titleFields(lines, parse);
    const get = (...keys: string[]) => fields.filter((f) => keys.includes(f.key)).flatMap((f) => f.value.split('\n')).map((v) => v.trim()).filter(Boolean);
    const tp = (text: string, align: 'Center' | 'Left' | 'Right') => `      <Paragraph Alignment="${align}" Type="Action"><Text>${esc(text)}</Text></Paragraph>`;
    const blank = () => title.push('      <Paragraph Type="Action"><Text></Text></Paragraph>');
    for (let k = 0; k < 16; k++) blank();
    for (const t of get('title')) title.push(tp(t.toUpperCase(), 'Center'));
    blank();
    for (const t of get('credit')) title.push(tp(t, 'Center'));
    blank();
    for (const t of get('author', 'authors', 'writer', 'writers')) title.push(tp(t, 'Center'));
    const source = get('source');
    if (source.length) {
      blank();
      for (const t of source) title.push(tp(t, 'Center'));
    }
    for (let k = 0; k < 16; k++) blank();
    for (const t of get('notes')) title.push(tp(t, 'Left'));
    for (const t of get('contact', 'address', 'phone', 'email', 'agent')) title.push(tp(t, 'Left'));
    for (const t of [...get('revision'), ...get('copyright'), ...get('draft date', 'date')]) title.push(tp(t, 'Right'));
  }

  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="no" ?>',
    '<FinalDraft DocumentType="Script" Template="No" Version="5">',
    '  <Content>',
    ...body,
    '  </Content>',
    ...(title.length ? ['  <TitlePage>', '    <Content>', ...title, '    </Content>', '  </TitlePage>'] : []),
    '</FinalDraft>',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------
// Import

function unesc(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? unesc(m[1]) : undefined;
}

interface FdxPara {
  type: string;
  text: string;
  align?: string;
  number?: string;
  newPage: boolean;
  dual?: 'left' | 'right';
}

/** Escapes Fountain emphasis characters in plain text. */
function fountainEscape(s: string): string {
  return s.replace(/([*_\\])/g, '\\$1');
}

/** Text of a paragraph with Fountain emphasis for styled runs. */
function paraText(inner: string): string {
  let out = '';
  const re = /<Text\b([^>]*)\/>|<Text\b([^>]*)>([\s\S]*?)<\/Text>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner))) {
    if (m[1] !== undefined) continue;
    const style = attr(m[2] ?? '', 'Style') ?? '';
    const raw = unesc(m[3] ?? '');
    const bold = /Bold/i.test(style);
    const italic = /Italic/i.test(style);
    const under = /Underline/i.test(style);
    // Emphasis wraps the words, never the spaces around them (Fountain needs that).
    const parts = raw.split('\n');
    out += parts
      .map((part) => {
        const t = fountainEscape(part);
        const core = t.trim();
        if (!core || !(bold || italic || under)) return t;
        const lead = t.slice(0, t.length - t.trimStart().length);
        const tail = t.slice(t.trimEnd().length);
        let w = core;
        if (italic && bold) w = `***${w}***`;
        else if (bold) w = `**${w}**`;
        else if (italic) w = `*${w}*`;
        if (under) w = `_${w}_`;
        return lead + w + tail;
      })
      .join('\n');
  }
  return out.replace(/\t/g, ' ');
}

function readParagraphs(xml: string): FdxPara[] {
  const out: FdxPara[] = [];
  // Paragraphs may hold a <DualDialogue> with paragraphs inside; handle those first.
  const re = /<Paragraph\b([^>]*)>([\s\S]*?)<\/Paragraph>/g;
  let m: RegExpExecArray | null;
  let pos = 0;
  while ((m = re.exec(xml))) {
    const tag = m[1];
    let inner = m[2];
    const start = m.index;
    if (start < pos) continue;
    if (/<DualDialogue\b/.test(inner)) {
      // The non-greedy match stopped at the first inner </Paragraph>; take the whole block.
      const end = xml.indexOf('</DualDialogue>', start);
      const close = xml.indexOf('</Paragraph>', end);
      const block = xml.slice(xml.indexOf('<DualDialogue', start), end);
      const inside = readParagraphs(block);
      let side: 'left' | 'right' = 'left';
      let cues = 0;
      inside.forEach((p, k) => {
        if (p.type === 'Character') {
          cues++;
          side = cues === 1 ? 'left' : 'right';
        }
        p.dual = side;
        if (k === 0 && attr(tag, 'StartsNewPage') === 'Yes') p.newPage = true;
        out.push(p);
      });
      pos = close + '</Paragraph>'.length;
      re.lastIndex = pos;
      continue;
    }
    inner = inner.replace(/<SceneProperties\b[\s\S]*?<\/SceneProperties>|<SceneProperties\b[^>]*\/>/g, '');
    out.push({
      type: attr(tag, 'Type') ?? 'Action',
      text: paraText(inner),
      align: attr(tag, 'Alignment'),
      number: attr(tag, 'Number'),
      newPage: attr(tag, 'StartsNewPage') === 'Yes',
    });
    pos = m.index + m[0].length;
  }
  return out;
}

/** Headings Fountain recognises without a leading dot. */
const STD_HEADING_RE = /^(INT|EXT|EST|INT\.?\/EXT|I\/E)[\s.]/i;
const HEADING_RE = /^(INT|EXT|EST|INT\.?\/EXT|I\/E|INNEN|AUSSEN|AUẞEN|INNEN\/AUSSEN|AUSSEN\/INNEN)[\s./]/i;

function titlePageFountain(xml: string): string[] {
  const paras = readParagraphs(xml).map((p) => ({ ...p, text: p.text.replace(/\\([*_\\])/g, '$1').trim() }));
  const centered = paras.filter((p) => p.text && (p.align ?? '').toLowerCase() === 'center');
  const left = paras.filter((p) => p.text && (p.align ?? 'left').toLowerCase() === 'left');
  const right = paras.filter((p) => p.text && (p.align ?? '').toLowerCase() === 'right');
  const fields: Array<[string, string[]]> = [];
  let k = 0;
  const title: string[] = [];
  while (k < centered.length && !/^(written by|screenplay by|story by|teleplay by|by|von|drehbuch|ein film von)\b/i.test(centered[k].text)) {
    title.push(centered[k].text);
    k++;
    if (title.length && k < centered.length && centered[k].text && paras.indexOf(centered[k]) - paras.indexOf(centered[k - 1]) > 1) break;
  }
  if (title.length) fields.push(['Title', title]);
  if (k < centered.length && /^(written by|screenplay by|story by|teleplay by|by|von|drehbuch|ein film von)\b/i.test(centered[k].text)) {
    fields.push(['Credit', [centered[k].text]]);
    k++;
  }
  if (k < centered.length) {
    fields.push(['Author', [centered[k].text]]);
    k++;
  }
  if (k < centered.length) fields.push(['Source', centered.slice(k).map((p) => p.text)]);
  if (left.length) fields.push(['Contact', left.map((p) => p.text)]);
  const dates = right.filter((p) => /\d/.test(p.text));
  const others = right.filter((p) => !/\d/.test(p.text));
  if (dates.length) fields.push(['Draft date', [dates[dates.length - 1].text]]);
  if (others.length || dates.length > 1) fields.push(['Notes', [...others, ...dates.slice(0, -1)].map((p) => p.text)]);
  const out: string[] = [];
  for (const [key, vals] of fields) {
    if (vals.length === 1) out.push(`${key}: ${vals[0]}`);
    else {
      out.push(`${key}:`);
      for (const v of vals) out.push(`    ${v}`);
    }
  }
  return out;
}

/** Fountain text from a Final Draft document. */
export function importFdx(xml: string): string {
  const contentStart = xml.search(/<Content\b/);
  const titleStart = xml.search(/<TitlePage\b/);
  let body = xml;
  let titleXml = '';
  if (titleStart >= 0) {
    const titleEnd = xml.indexOf('</TitlePage>', titleStart);
    titleXml = xml.slice(titleStart, titleEnd);
    body = xml.slice(0, titleStart) + xml.slice(titleEnd + '</TitlePage>'.length);
  }
  if (contentStart < 0) throw new Error('This file does not look like a Final Draft screenplay.');
  const cStart = body.search(/<Content\b/);
  const cEnd = body.indexOf('</Content>', cStart);
  const paras = readParagraphs(body.slice(cStart, cEnd < 0 ? undefined : cEnd));
  const out: string[] = [];
  const title = titleXml ? titlePageFountain(titleXml) : [];
  if (title.length) out.push(...title, '');
  let prev: string | null = null;
  const inSpeech = (t: string | null) => t === 'Character' || t === 'Dialogue' || t === 'Parenthetical' || t === 'Lyrics';
  for (const p of paras) {
    const text = p.text;
    if (p.newPage && out.length) {
      out.push('', '===');
      prev = null;
    }
    const type = p.type;
    const continuesSpeech = (type === 'Dialogue' || type === 'Parenthetical' || type === 'Lyrics') && inSpeech(prev);
    if (!continuesSpeech && out.length && out[out.length - 1] !== '') out.push('');
    const lines = text.split('\n');
    switch (type) {
      case 'Scene Heading': {
        const t = lines.join(' ').trim();
        const num = p.number ? ` #${p.number}#` : '';
        out.push(`${STD_HEADING_RE.test(t) ? '' : '.'}${t.toUpperCase() === t ? t : t.toUpperCase()}${num}`);
        break;
      }
      case 'Character': {
        const t = lines.join(' ').trim();
        const upper = t === t.toUpperCase() && /\p{Lu}/u.test(t);
        out.push(`${upper ? '' : '@'}${t}${p.dual === 'right' ? ' ^' : ''}`);
        break;
      }
      case 'Parenthetical': {
        const t = lines.join(' ').trim();
        out.push(t.startsWith('(') ? t : `(${t})`);
        break;
      }
      case 'Dialogue':
        out.push(...lines.map((l) => l.trim() || '  '));
        break;
      case 'Lyrics':
        out.push(...lines.map((l) => `~${l.trim()}`));
        break;
      case 'Transition': {
        const t = lines.join(' ').trim();
        out.push(/^[\p{Lu}\s.]+TO:$/u.test(t) ? t : `> ${t}`);
        break;
      }
      case 'New Act':
      case 'End of Act':
        out.push(`# ${lines.join(' ').trim()}`);
        break;
      default: {
        // Action, General, Shot, Cast List …
        if ((p.align ?? '').toLowerCase() === 'center') out.push(...lines.map((l) => `> ${l.trim()} <`));
        else
          out.push(
            ...lines.map((l) => {
              const t = l.replace(/\s+$/, '');
              // Keep action that looks like another element from being read as one.
              if (HEADING_RE.test(t) || (/^[\p{Lu}0-9 .'()-]+$/u.test(t.trim()) && /\p{Lu}/u.test(t) && t.trim().length < 40) || /TO:$/.test(t.trim())) return `!${t}`;
              return t;
            }),
          );
      }
    }
    prev = type;
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n') + '\n';
}
