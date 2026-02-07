/**
 * Direct DOCX XML → Styled HTML Parser
 *
 * Parses the raw DOCX XML and produces HTML with full inline style preservation
 * (font colours, sizes, families, text alignment, highlights, bold/italic/underline,
 * images, hyperlinks, tables, and lists).
 *
 * mammoth.js deliberately strips visual styling; this parser fills that gap.
 *
 * @module docx/styled-html-parser
 */

import { createRequire } from 'module';
import type { DocxImage, DocxDocumentDefaults } from './types.js';
import { IMAGE_MIME_TYPES } from './constants.js';
import { escapeHtml } from './utils.js';

const require = createRequire(import.meta.url);
const { DOMParser } = require('@xmldom/xmldom');

// ─── OOXML Namespace Constants ───────────────────────────────────────────────

const NS = {
  W: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  R: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  WP: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  A: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  PIC: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
} as const;

// ─── Highlight Colour Map ────────────────────────────────────────────────────

const HIGHLIGHT_COLORS: Readonly<Record<string, string>> = {
  yellow: '#FFFF00', green: '#00FF00', cyan: '#00FFFF', magenta: '#FF00FF',
  blue: '#0000FF', red: '#FF0000', darkBlue: '#000080', darkCyan: '#008080',
  darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000',
  darkYellow: '#808000', darkGray: '#808080', lightGray: '#C0C0C0',
  black: '#000000', white: '#FFFFFF',
};

// ─── Heading Detection ───────────────────────────────────────────────────────

const HEADING_PATTERNS: ReadonlyArray<{ pattern: RegExp; tag: string }> = [
  { pattern: /^Heading\s*1$/i, tag: 'h1' },
  { pattern: /^Heading\s*2$/i, tag: 'h2' },
  { pattern: /^Heading\s*3$/i, tag: 'h3' },
  { pattern: /^Heading\s*4$/i, tag: 'h4' },
  { pattern: /^Heading\s*5$/i, tag: 'h5' },
  { pattern: /^Heading\s*6$/i, tag: 'h6' },
  { pattern: /^Title$/i, tag: 'h1' },
  { pattern: /^Subtitle$/i, tag: 'h2' },
];

// ─── Internal Types ──────────────────────────────────────────────────────────

interface RunStyle {
  color?: string;
  fontSize?: string;
  fontFamily?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  backgroundColor?: string;
  verticalAlign?: 'superscript' | 'subscript';
}

interface ParagraphStyle {
  textAlign?: string;
  tag: string;
}

interface StyleDef {
  tag?: string;
  runStyle?: RunStyle;
}

interface ThemeFonts {
  major: string; // heading font (e.g. 'Calibri Light')
  minor: string; // body font (e.g. 'Calibri')
}

/** numId → Map<level, numFmt string> */
type NumberingMap = Map<string, Map<number, string>>;

interface ConversionContext {
  imageMap: Map<string, string>;    // rId → data:… URL
  linkMap: Map<string, string>;     // rId → href URL
  stylesMap: Map<string, StyleDef>;
  themeFonts: ThemeFonts;
  docDefaultRunStyle: RunStyle;     // document-wide default font/size/colour
  numberingMap: NumberingMap;
}

// ─── DOM Helpers ─────────────────────────────────────────────────────────────

function getDirectChild(parent: Element, ns: string, localName: string): Element | null {
  for (let i = 0; i < parent.childNodes.length; i++) {
    const child = parent.childNodes[i];
    if (child.nodeType === 1) {
      const el = child as Element;
      if (el.localName === localName && el.namespaceURI === ns) return el;
    }
  }
  return null;
}

function getDirectChildren(parent: Element, ns: string, localName: string): Element[] {
  const result: Element[] = [];
  for (let i = 0; i < parent.childNodes.length; i++) {
    const child = parent.childNodes[i];
    if (child.nodeType === 1) {
      const el = child as Element;
      if (el.localName === localName && el.namespaceURI === ns) result.push(el);
    }
  }
  return result;
}

// ─── Style Extraction ────────────────────────────────────────────────────────

/** Extract run-level styles from a `w:rPr` element. */
function extractRunStyles(rPr: Element, themeFonts?: ThemeFonts): RunStyle {
  const style: RunStyle = {};

  // Font colour (w:color)
  const colorEl = getDirectChild(rPr, NS.W, 'color');
  if (colorEl) {
    const val = colorEl.getAttribute('w:val');
    if (val && val !== 'auto' && /^[0-9A-Fa-f]{6}$/.test(val)) {
      style.color = `#${val.toUpperCase()}`;
    }
  }

  // Font size (w:sz — value is half-points, e.g. 24 = 12pt)
  const szEl = getDirectChild(rPr, NS.W, 'sz');
  if (szEl) {
    const val = szEl.getAttribute('w:val');
    if (val) {
      const pts = parseInt(val, 10) / 2;
      if (!isNaN(pts) && pts > 0) style.fontSize = `${pts}pt`;
    }
  }

  // Font family (w:rFonts) — with theme-font resolution
  const rFontsEl = getDirectChild(rPr, NS.W, 'rFonts');
  if (rFontsEl) {
    let font =
      rFontsEl.getAttribute('w:ascii') ||
      rFontsEl.getAttribute('w:hAnsi') ||
      rFontsEl.getAttribute('w:cs');

    if (!font && themeFonts) {
      const themeAttr =
        rFontsEl.getAttribute('w:asciiTheme') ||
        rFontsEl.getAttribute('w:hAnsiTheme') ||
        rFontsEl.getAttribute('w:cstheme');
      if (themeAttr) {
        font = themeAttr.includes('minor') ? themeFonts.minor
             : themeAttr.includes('major') ? themeFonts.major
             : null;
      }
    }

    if (font) style.fontFamily = font;
  }

  // Bold
  const bEl = getDirectChild(rPr, NS.W, 'b');
  if (bEl) {
    const val = bEl.getAttribute('w:val');
    style.bold = val !== '0' && val !== 'false';
  }

  // Italic
  const iEl = getDirectChild(rPr, NS.W, 'i');
  if (iEl) {
    const val = iEl.getAttribute('w:val');
    style.italic = val !== '0' && val !== 'false';
  }

  // Underline
  const uEl = getDirectChild(rPr, NS.W, 'u');
  if (uEl) {
    const val = uEl.getAttribute('w:val');
    style.underline = !!val && val !== 'none';
  }

  // Strikethrough
  const strikeEl = getDirectChild(rPr, NS.W, 'strike');
  if (strikeEl) {
    const val = strikeEl.getAttribute('w:val');
    style.strikethrough = val !== '0' && val !== 'false';
  }

  // Highlight
  const highlightEl = getDirectChild(rPr, NS.W, 'highlight');
  if (highlightEl) {
    const val = highlightEl.getAttribute('w:val');
    if (val && val !== 'none' && HIGHLIGHT_COLORS[val]) {
      style.backgroundColor = HIGHLIGHT_COLORS[val];
    }
  }

  // Shading (w:shd) — fallback background
  if (!style.backgroundColor) {
    const shdEl = getDirectChild(rPr, NS.W, 'shd');
    if (shdEl) {
      const fill = shdEl.getAttribute('w:fill');
      if (fill && fill !== 'auto' && /^[0-9A-Fa-f]{6}$/.test(fill)) {
        style.backgroundColor = `#${fill.toUpperCase()}`;
      }
    }
  }

  // Vertical alignment
  const vertAlignEl = getDirectChild(rPr, NS.W, 'vertAlign');
  if (vertAlignEl) {
    const val = vertAlignEl.getAttribute('w:val');
    if (val === 'superscript') style.verticalAlign = 'superscript';
    else if (val === 'subscript') style.verticalAlign = 'subscript';
  }

  return style;
}

// ─── CSS / Style Helpers ─────────────────────────────────────────────────────

function buildCssStyle(style: RunStyle): string {
  const parts: string[] = [];
  if (style.color) parts.push(`color:${style.color}`);
  if (style.fontSize) parts.push(`font-size:${style.fontSize}`);
  if (style.fontFamily) parts.push(`font-family:'${style.fontFamily}'`);
  if (style.backgroundColor) parts.push(`background-color:${style.backgroundColor}`);
  return parts.join(';');
}

function buildStyleAttr(cssParts: string[]): string {
  return cssParts.length > 0 ? ` style="${cssParts.join(';')}"` : '';
}

function mergeRunStyles(inherited: RunStyle | undefined, explicit: RunStyle): RunStyle {
  if (!inherited) return explicit;
  return {
    color: explicit.color || inherited.color,
    fontSize: explicit.fontSize || inherited.fontSize,
    fontFamily: explicit.fontFamily || inherited.fontFamily,
    bold: explicit.bold ?? inherited.bold,
    italic: explicit.italic ?? inherited.italic,
    underline: explicit.underline ?? inherited.underline,
    strikethrough: explicit.strikethrough ?? inherited.strikethrough,
    backgroundColor: explicit.backgroundColor || inherited.backgroundColor,
    verticalAlign: explicit.verticalAlign || inherited.verticalAlign,
  };
}

// ─── Paragraph Style Extraction ──────────────────────────────────────────────

function extractParagraphStyle(pPr: Element | null, stylesMap: Map<string, StyleDef>): ParagraphStyle {
  const result: ParagraphStyle = { tag: 'p' };
  if (!pPr) return result;

  const pStyleEl = getDirectChild(pPr, NS.W, 'pStyle');
  if (pStyleEl) {
    const styleId = pStyleEl.getAttribute('w:val') || '';

    for (const hp of HEADING_PATTERNS) {
      if (hp.pattern.test(styleId)) { result.tag = hp.tag; break; }
    }

    if (result.tag === 'p' && stylesMap.has(styleId)) {
      const mapped = stylesMap.get(styleId)!;
      if (mapped.tag) result.tag = mapped.tag;
    }
  }

  const jcEl = getDirectChild(pPr, NS.W, 'jc');
  if (jcEl) {
    const val = jcEl.getAttribute('w:val');
    if (val === 'center') result.textAlign = 'center';
    else if (val === 'right' || val === 'end') result.textAlign = 'right';
    else if (val === 'both' || val === 'distribute') result.textAlign = 'justify';
  }

  return result;
}

/** Resolve the default RunStyle for a paragraph (docDefaults → Normal/pStyle → pPr/rPr). */
function getDefaultRunStyle(pPr: Element | null, ctx: ConversionContext): RunStyle {
  let inherited: RunStyle = { ...ctx.docDefaultRunStyle };

  let styleId = '';
  if (pPr) {
    const pStyleEl = getDirectChild(pPr, NS.W, 'pStyle');
    styleId = pStyleEl?.getAttribute('w:val') || '';
  }

  if (!styleId) styleId = 'Normal';
  const mapped = ctx.stylesMap.get(styleId);
  if (mapped?.runStyle) inherited = mergeRunStyles(inherited, mapped.runStyle);

  if (pPr) {
    const rPr = getDirectChild(pPr, NS.W, 'rPr');
    if (rPr) return mergeRunStyles(inherited, extractRunStyles(rPr, ctx.themeFonts));
  }

  return inherited;
}

// ─── styles.xml Parsing ──────────────────────────────────────────────────────

function parseStylesXml(xml: string, themeFonts: ThemeFonts): Map<string, StyleDef> {
  const map = new Map<string, StyleDef>();
  try {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const styles = doc.getElementsByTagNameNS(NS.W, 'style');

    for (let i = 0; i < styles.length; i++) {
      const styleEl = styles[i] as Element;
      const styleId = styleEl.getAttribute('w:styleId');
      if (!styleId) continue;

      const entry: StyleDef = {};

      const nameEl = getDirectChild(styleEl, NS.W, 'name');
      if (nameEl) {
        const name = nameEl.getAttribute('w:val') || '';
        for (const hp of HEADING_PATTERNS) {
          if (hp.pattern.test(name)) { entry.tag = hp.tag; break; }
        }
      }

      const rPr = getDirectChild(styleEl, NS.W, 'rPr');
      if (rPr) entry.runStyle = extractRunStyles(rPr, themeFonts);

      map.set(styleId, entry);
    }
  } catch {
    // Non-fatal — return whatever we have
  }
  return map;
}

// ─── Element Converters ──────────────────────────────────────────────────────

function convertDrawingToHtml(drawingEl: Element, ctx: ConversionContext): string {
  try {
    const blips = drawingEl.getElementsByTagNameNS(NS.A, 'blip');
    if (blips.length === 0) return '';

    const blip = blips[0] as Element;
    const rId = blip.getAttributeNS(NS.R, 'embed') || blip.getAttribute('r:embed');
    if (!rId || !ctx.imageMap.has(rId)) return '';

    const dataUrl = ctx.imageMap.get(rId)!;

    let alt = '';
    const docPrs = drawingEl.getElementsByTagNameNS(NS.WP, 'docPr');
    if (docPrs.length > 0) {
      alt = (docPrs[0] as Element).getAttribute('descr')
         || (docPrs[0] as Element).getAttribute('name')
         || '';
    }

    return `<img src="${dataUrl}" alt="${escapeHtml(alt)}" />`;
  } catch {
    return '';
  }
}

function convertRunToHtml(runEl: Element, ctx: ConversionContext, defaultRunStyle?: RunStyle): string {
  const rPr = getDirectChild(runEl, NS.W, 'rPr');
  const explicitStyle = rPr ? extractRunStyles(rPr, ctx.themeFonts) : {};
  const style = mergeRunStyles(defaultRunStyle, explicitStyle);

  const parts: string[] = [];
  for (let i = 0; i < runEl.childNodes.length; i++) {
    const child = runEl.childNodes[i];
    if (child.nodeType !== 1) continue;
    const el = child as Element;

    if (el.localName === 't') parts.push(escapeHtml(el.textContent || ''));
    else if (el.localName === 'br') parts.push('<br>');
    else if (el.localName === 'tab') parts.push('&#9;');
    else if (el.localName === 'drawing') parts.push(convertDrawingToHtml(el, ctx));
  }

  const content = parts.join('');
  if (!content) return '';

  let html = content;

  const cssStyle = buildCssStyle(style);
  if (cssStyle) html = `<span style="${cssStyle}">${html}</span>`;

  if (style.underline) html = `<u>${html}</u>`;
  if (style.strikethrough) html = `<s>${html}</s>`;
  if (style.italic) html = `<em>${html}</em>`;
  if (style.bold) html = `<strong>${html}</strong>`;
  if (style.verticalAlign === 'superscript') html = `<sup>${html}</sup>`;
  else if (style.verticalAlign === 'subscript') html = `<sub>${html}</sub>`;

  return html;
}

function convertHyperlinkToHtml(
  hyperlinkEl: Element,
  ctx: ConversionContext,
  defaultRunStyle?: RunStyle
): string {
  const rId = hyperlinkEl.getAttributeNS(NS.R, 'id') || hyperlinkEl.getAttribute('r:id');
  const anchor = hyperlinkEl.getAttribute('w:anchor');

  let href = '';
  if (rId && ctx.linkMap.has(rId)) href = ctx.linkMap.get(rId)!;
  else if (anchor) href = `#${anchor}`;

  let innerHtml = '';
  for (let i = 0; i < hyperlinkEl.childNodes.length; i++) {
    const child = hyperlinkEl.childNodes[i];
    if (child.nodeType !== 1) continue;
    const el = child as Element;
    if (el.localName === 'r') innerHtml += convertRunToHtml(el, ctx, defaultRunStyle);
  }

  return href ? `<a href="${escapeHtml(href)}">${innerHtml}</a>` : innerHtml;
}

function convertParagraphInner(paraEl: Element, ctx: ConversionContext): string {
  const pPr = getDirectChild(paraEl, NS.W, 'pPr');
  const defaultRunStyle = getDefaultRunStyle(pPr, ctx);

  let innerHtml = '';
  for (let i = 0; i < paraEl.childNodes.length; i++) {
    const child = paraEl.childNodes[i];
    if (child.nodeType !== 1) continue;
    const el = child as Element;

    if (el.localName === 'r') innerHtml += convertRunToHtml(el, ctx, defaultRunStyle);
    else if (el.localName === 'hyperlink') innerHtml += convertHyperlinkToHtml(el, ctx, defaultRunStyle);
  }
  return innerHtml;
}

function convertParagraphToHtml(paraEl: Element, ctx: ConversionContext): string {
  const pPr = getDirectChild(paraEl, NS.W, 'pPr');
  const paraStyle = extractParagraphStyle(pPr, ctx.stylesMap);
  const innerHtml = convertParagraphInner(paraEl, ctx);

  const cssParts: string[] = [];
  if (paraStyle.textAlign) cssParts.push(`text-align:${paraStyle.textAlign}`);
  const styleAttr = buildStyleAttr(cssParts);
  const { tag } = paraStyle;

  return innerHtml.trim()
    ? `<${tag}${styleAttr}>${innerHtml}</${tag}>\n`
    : `<${tag}${styleAttr}><br></${tag}>\n`;
}

function convertTableToHtml(tblEl: Element, ctx: ConversionContext): string {
  let html = '<table border="1" cellpadding="4" cellspacing="0">\n';

  for (const row of getDirectChildren(tblEl, NS.W, 'tr')) {
    html += '<tr>';
    for (const cell of getDirectChildren(row, NS.W, 'tc')) {
      html += '<td>';
      for (const para of getDirectChildren(cell, NS.W, 'p')) {
        html += convertParagraphToHtml(para, ctx);
      }
      html += '</td>';
    }
    html += '</tr>\n';
  }

  return html + '</table>\n';
}

// ─── Relationship Parsing ────────────────────────────────────────────────────

async function loadRelationships(
  zip: any,
  includeImages: boolean
): Promise<{ imageMap: Map<string, string>; linkMap: Map<string, string> }> {
  const imageMap = new Map<string, string>();
  const linkMap = new Map<string, string>();

  const relsFile = zip.file('word/_rels/document.xml.rels');
  if (!relsFile) return { imageMap, linkMap };

  const relsXml = await relsFile.async('string');
  const relsDoc = new DOMParser().parseFromString(relsXml, 'application/xml');
  const rels = relsDoc.getElementsByTagName('Relationship');

  for (let i = 0; i < rels.length; i++) {
    const rel = rels[i] as Element;
    const id = rel.getAttribute('Id');
    const target = rel.getAttribute('Target');
    const type = rel.getAttribute('Type') || '';
    if (!id || !target) continue;

    if (type.includes('image') && includeImages) {
      const imgFile = zip.file(`word/${target}`);
      if (imgFile) {
        try {
          const imgData = await imgFile.async('base64');
          const ext = target.split('.').pop()?.toLowerCase() || 'png';
          const mime = IMAGE_MIME_TYPES[ext] || 'image/png';
          imageMap.set(id, `data:${mime};base64,${imgData}`);
        } catch {
          // Skip failed image extraction
        }
      }
    } else if (type.includes('hyperlink')) {
      linkMap.set(id, target);
    }
  }

  return { imageMap, linkMap };
}

// ─── Numbering / List Parsing ────────────────────────────────────────────────

async function parseNumberingXml(zip: any): Promise<NumberingMap> {
  const result: NumberingMap = new Map();

  try {
    const numFile = zip.file('word/numbering.xml');
    if (!numFile) return result;

    const numXml = await numFile.async('string');
    const doc = new DOMParser().parseFromString(numXml, 'application/xml');

    // Abstract numbering definitions (abstractNumId → level → numFmt)
    const abstractMap = new Map<string, Map<number, string>>();
    const abstractNums = doc.getElementsByTagNameNS(NS.W, 'abstractNum');

    for (let i = 0; i < abstractNums.length; i++) {
      const absNum = abstractNums[i] as Element;
      const absNumId = absNum.getAttribute('w:abstractNumId');
      if (!absNumId) continue;

      const levels = new Map<number, string>();
      for (const lvlEl of getDirectChildren(absNum, NS.W, 'lvl')) {
        const ilvl = parseInt(lvlEl.getAttribute('w:ilvl') || '0', 10);
        const numFmtEl = getDirectChild(lvlEl, NS.W, 'numFmt');
        levels.set(ilvl, numFmtEl?.getAttribute('w:val') || 'bullet');
      }

      abstractMap.set(absNumId, levels);
    }

    // Concrete numbering: numId → abstractNumId mapping
    const nums = doc.getElementsByTagNameNS(NS.W, 'num');
    for (let i = 0; i < nums.length; i++) {
      const numEl = nums[i] as Element;
      const numId = numEl.getAttribute('w:numId');
      if (!numId) continue;

      const absNumIdRef = getDirectChild(numEl, NS.W, 'abstractNumId');
      const absNumId = absNumIdRef?.getAttribute('w:val');
      if (absNumId && abstractMap.has(absNumId)) {
        result.set(numId, abstractMap.get(absNumId)!);
      }
    }
  } catch {
    // Non-fatal
  }

  return result;
}

function getNumInfo(pPr: Element | null): { numId: string; level: number } | null {
  if (!pPr) return null;
  const numPrEl = getDirectChild(pPr, NS.W, 'numPr');
  if (!numPrEl) return null;

  const numIdEl = getDirectChild(numPrEl, NS.W, 'numId');
  const numId = numIdEl?.getAttribute('w:val');
  if (!numId || numId === '0') return null;

  const ilvlEl = getDirectChild(numPrEl, NS.W, 'ilvl');
  const level = parseInt(ilvlEl?.getAttribute('w:val') || '0', 10);

  return { numId, level };
}

function getListTag(numberingMap: NumberingMap, numId: string, level: number): string {
  const levels = numberingMap.get(numId);
  if (!levels) return 'ul';
  const numFmt = levels.get(level) || 'bullet';
  return numFmt === 'bullet' || numFmt === 'none' ? 'ul' : 'ol';
}

// ─── Document Defaults Extraction ────────────────────────────────────────────

async function parseThemeFonts(zip: any): Promise<ThemeFonts> {
  try {
    const themeFile = zip.file('word/theme/theme1.xml');
    if (!themeFile) return { major: '', minor: '' };

    const themeXml = await themeFile.async('string');
    const themeDoc = new DOMParser().parseFromString(themeXml, 'application/xml');

    let major = '';
    let minor = '';

    const majorFonts = themeDoc.getElementsByTagNameNS(NS.A, 'majorFont');
    if (majorFonts.length > 0) {
      const latin = getDirectChild(majorFonts[0] as Element, NS.A, 'latin');
      if (latin) major = latin.getAttribute('typeface') || '';
    }

    const minorFonts = themeDoc.getElementsByTagNameNS(NS.A, 'minorFont');
    if (minorFonts.length > 0) {
      const latin = getDirectChild(minorFonts[0] as Element, NS.A, 'latin');
      if (latin) minor = latin.getAttribute('typeface') || '';
    }

    return { major, minor };
  } catch {
    return { major: '', minor: '' };
  }
}

function parseDocDefaults(stylesXml: string, themeFonts: ThemeFonts): RunStyle {
  try {
    const doc = new DOMParser().parseFromString(stylesXml, 'application/xml');
    const docDefaultsEls = doc.getElementsByTagNameNS(NS.W, 'docDefaults');
    if (docDefaultsEls.length === 0) return {};

    const rPrDefault = getDirectChild(docDefaultsEls[0] as Element, NS.W, 'rPrDefault');
    if (!rPrDefault) return {};

    const rPr = getDirectChild(rPrDefault, NS.W, 'rPr');
    return rPr ? extractRunStyles(rPr, themeFonts) : {};
  } catch {
    return {};
  }
}

// ─── Context Building ────────────────────────────────────────────────────────

async function buildConversionContext(
  zip: any,
  includeImages: boolean
): Promise<{ ctx: ConversionContext; documentDefaults: DocxDocumentDefaults }> {
  const themeFonts = await parseThemeFonts(zip);

  const stylesXmlFile = zip.file('word/styles.xml');
  let stylesMap = new Map<string, StyleDef>();
  let docDefaultsStyle: RunStyle = {};
  if (stylesXmlFile) {
    const stylesXml = await stylesXmlFile.async('string');
    stylesMap = parseStylesXml(stylesXml, themeFonts);
    docDefaultsStyle = parseDocDefaults(stylesXml, themeFonts);
  }

  const normalStyle = stylesMap.get('Normal');
  const docDefaultRunStyle = mergeRunStyles(docDefaultsStyle, normalStyle?.runStyle || {});

  const documentDefaults: DocxDocumentDefaults = {
    font: docDefaultRunStyle.fontFamily || themeFonts.minor || 'Calibri',
    fontSize: docDefaultRunStyle.fontSize ? parseFloat(docDefaultRunStyle.fontSize) : 11,
  };

  const [numberingMap, { imageMap, linkMap }] = await Promise.all([
    parseNumberingXml(zip),
    loadRelationships(zip, includeImages),
  ]);

  return {
    ctx: { imageMap, linkMap, stylesMap, themeFonts, docDefaultRunStyle, numberingMap },
    documentDefaults,
  };
}

// ─── Body Conversion ─────────────────────────────────────────────────────────

function convertBodyChildrenToHtml(bodyEl: Element, ctx: ConversionContext): string {
  let html = '';
  const listStack: Array<{ tag: string; level: number }> = [];
  let currentListNumId = '';

  function closeListsToLevel(targetLevel: number): string {
    let out = '';
    while (listStack.length > 0 && listStack[listStack.length - 1].level > targetLevel) {
      out += `</${listStack.pop()!.tag}>\n`;
    }
    return out;
  }

  function closeAllLists(): string {
    let out = '';
    while (listStack.length > 0) out += `</${listStack.pop()!.tag}>\n`;
    currentListNumId = '';
    return out;
  }

  for (let i = 0; i < bodyEl.childNodes.length; i++) {
    const child = bodyEl.childNodes[i];
    if (child.nodeType !== 1) continue;
    const el = child as Element;

    if (el.localName === 'p') {
      const pPr = getDirectChild(el, NS.W, 'pPr');
      const numInfo = getNumInfo(pPr);

      if (numInfo) {
        html += convertListParagraph(el, pPr, numInfo, ctx, listStack, currentListNumId, closeAllLists, closeListsToLevel);
        currentListNumId = numInfo.numId;
      } else {
        html += closeAllLists();
        html += convertParagraphToHtml(el, ctx);
      }
    } else if (el.localName === 'tbl') {
      html += closeAllLists();
      html += convertTableToHtml(el, ctx);
    }
  }

  html += closeAllLists();
  return html;
}

function convertListParagraph(
  paraEl: Element,
  pPr: Element | null,
  numInfo: { numId: string; level: number },
  ctx: ConversionContext,
  listStack: Array<{ tag: string; level: number }>,
  currentListNumId: string,
  closeAllLists: () => string,
  closeListsToLevel: (targetLevel: number) => string
): string {
  let out = '';
  const tag = getListTag(ctx.numberingMap, numInfo.numId, numInfo.level);
  const { level } = numInfo;

  if (currentListNumId && currentListNumId !== numInfo.numId) {
    out += closeAllLists();
  }

  const top = listStack.length > 0 ? listStack[listStack.length - 1] : null;

  if (!top || level > top.level) {
    out += `<${tag}>\n`;
    listStack.push({ tag, level });
  } else {
    if (level < top.level) out += closeListsToLevel(level);
    const current = listStack[listStack.length - 1];
    if (current && current.tag !== tag) {
      listStack.pop();
      out += `</${current.tag}>\n<${tag}>\n`;
      listStack.push({ tag, level });
    }
  }

  const liContent = convertParagraphInner(paraEl, ctx);
  const paraStyle = extractParagraphStyle(pPr, ctx.stylesMap);
  const liCss: string[] = [];
  if (paraStyle.textAlign) liCss.push(`text-align:${paraStyle.textAlign}`);
  if (level > 0) liCss.push(`margin-left:${level * 36}pt`);
  out += `<li${buildStyleAttr(liCss)}>${liContent || '&nbsp;'}</li>\n`;

  return out;
}

// ─── Image Extraction ────────────────────────────────────────────────────────

function buildImageArray(imageMap: Map<string, string>): DocxImage[] {
  const images: DocxImage[] = [];
  imageMap.forEach((dataUrl, id) => {
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      images.push({
        id,
        data: match[2],
        mimeType: match[1],
        originalSize: Buffer.from(match[2], 'base64').length,
      });
    }
  });
  return images;
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Convert a DOCX buffer to styled HTML by parsing the DOCX XML directly.
 *
 * Bypasses mammoth.js to preserve all inline styles (colours, fonts, sizes,
 * alignment, highlights, bold/italic/underline, images, hyperlinks, tables).
 */
export async function convertDocxToStyledHtml(
  buffer: Buffer,
  includeImages = true
): Promise<{ html: string; images: DocxImage[]; documentDefaults: DocxDocumentDefaults }> {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(buffer);

  const docXmlFile = zip.file('word/document.xml');
  if (!docXmlFile) throw new Error('Invalid DOCX: missing word/document.xml');
  const docXml = await docXmlFile.async('string');
  const doc = new DOMParser().parseFromString(docXml, 'application/xml');

  const { ctx, documentDefaults } = await buildConversionContext(zip, includeImages);

  const bodyEl = doc.getElementsByTagNameNS(NS.W, 'body')[0];
  if (!bodyEl) return { html: '', images: [], documentDefaults };

  const html = convertBodyChildrenToHtml(bodyEl, ctx);
  const images = buildImageArray(ctx.imageMap);

  return { html, images, documentDefaults };
}
