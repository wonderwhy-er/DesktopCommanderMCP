/**
 * Direct DOCX XML to Styled HTML Parser
 *
 * Parses DOCX XML directly to produce HTML with full inline style preservation,
 * including font colors, sizes, families, text alignment, highlights, and more.
 *
 * Mammoth.js deliberately strips visual styling (colors, fonts, etc.) and only
 * preserves semantic structure. This parser fills that gap by reading the raw
 * DOCX XML and producing HTML with inline CSS styles.
 *
 * @module docx/styled-html-parser
 */

import { createRequire } from 'module';
import type { DocxImage, DocxDocumentDefaults } from './types.js';

const require = createRequire(import.meta.url);
const { DOMParser } = require('@xmldom/xmldom');

// ─── OOXML Namespace Constants ───────────────────────────────────────────────

const NS = {
  W: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  R: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  WP: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  A: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  PIC: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
};

// ─── Highlight Color Map ─────────────────────────────────────────────────────

const HIGHLIGHT_COLORS: Record<string, string> = {
  yellow: '#FFFF00', green: '#00FF00', cyan: '#00FFFF', magenta: '#FF00FF',
  blue: '#0000FF', red: '#FF0000', darkBlue: '#000080', darkCyan: '#008080',
  darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000',
  darkYellow: '#808000', darkGray: '#808080', lightGray: '#C0C0C0',
  black: '#000000', white: '#FFFFFF',
};

// ─── Heading Detection ───────────────────────────────────────────────────────

const HEADING_PATTERNS: Array<{ pattern: RegExp; tag: string }> = [
  { pattern: /^Heading\s*1$/i, tag: 'h1' },
  { pattern: /^Heading\s*2$/i, tag: 'h2' },
  { pattern: /^Heading\s*3$/i, tag: 'h3' },
  { pattern: /^Heading\s*4$/i, tag: 'h4' },
  { pattern: /^Heading\s*5$/i, tag: 'h5' },
  { pattern: /^Heading\s*6$/i, tag: 'h6' },
  { pattern: /^Title$/i, tag: 'h1' },
  { pattern: /^Subtitle$/i, tag: 'h2' },
];

// ─── Types ───────────────────────────────────────────────────────────────────

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
  isList?: boolean;
  listLevel?: number;
}

interface StyleDef {
  tag?: string;
  runStyle?: RunStyle;
}

interface ThemeFonts {
  major: string;  // heading font (e.g. 'Calibri Light')
  minor: string;  // body font (e.g. 'Calibri')
}

/** numId → Map<level, numFmt string> */
type NumberingMap = Map<string, Map<number, string>>;

interface ConversionContext {
  imageMap: Map<string, string>;   // rId → data:... URL
  linkMap: Map<string, string>;    // rId → href URL
  stylesMap: Map<string, StyleDef>;
  themeFonts: ThemeFonts;
  docDefaultRunStyle: RunStyle;    // document-wide default font/size/color
  numberingMap: NumberingMap;       // list numbering definitions
}

// ─── DOM Helpers ─────────────────────────────────────────────────────────────

/** Get first direct child element matching namespace + localName */
function getDirectChild(parent: Element, ns: string, localName: string): Element | null {
  const children = parent.childNodes;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.nodeType === 1) {
      const el = child as Element;
      if (el.localName === localName && el.namespaceURI === ns) {
        return el;
      }
    }
  }
  return null;
}

/** Get all direct child elements matching namespace + localName */
function getDirectChildren(parent: Element, ns: string, localName: string): Element[] {
  const result: Element[] = [];
  const children = parent.childNodes;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.nodeType === 1) {
      const el = child as Element;
      if (el.localName === localName && el.namespaceURI === ns) {
        result.push(el);
      }
    }
  }
  return result;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Style Extraction ────────────────────────────────────────────────────────

/** Extract run-level styles from a w:rPr element */
function extractRunStyles(rPr: Element, themeFonts?: ThemeFonts): RunStyle {
  const style: RunStyle = {};

  // Font color (w:color)
  const colorEl = getDirectChild(rPr, NS.W, 'color');
  if (colorEl) {
    const val = colorEl.getAttribute('w:val');
    if (val && val !== 'auto' && /^[0-9A-Fa-f]{6}$/.test(val)) {
      style.color = `#${val.toUpperCase()}`;
    }
  }

  // Font size (w:sz – value is in half-points, e.g. 24 = 12pt)
  const szEl = getDirectChild(rPr, NS.W, 'sz');
  if (szEl) {
    const val = szEl.getAttribute('w:val');
    if (val) {
      const pts = parseInt(val, 10) / 2;
      if (!isNaN(pts) && pts > 0) style.fontSize = `${pts}pt`;
    }
  }

  // Font family (w:rFonts) — with theme font resolution
  const rFontsEl = getDirectChild(rPr, NS.W, 'rFonts');
  if (rFontsEl) {
    let font =
      rFontsEl.getAttribute('w:ascii') ||
      rFontsEl.getAttribute('w:hAnsi') ||
      rFontsEl.getAttribute('w:cs');

    // Resolve theme font references (e.g. w:asciiTheme="minorHAnsi")
    if (!font && themeFonts) {
      const themeAttr =
        rFontsEl.getAttribute('w:asciiTheme') ||
        rFontsEl.getAttribute('w:hAnsiTheme') ||
        rFontsEl.getAttribute('w:cstheme');
      if (themeAttr) {
        if (themeAttr.includes('minor')) font = themeFonts.minor;
        else if (themeAttr.includes('major')) font = themeFonts.major;
      }
    }

    if (font) style.fontFamily = font;
  }

  // Bold (w:b)
  const bEl = getDirectChild(rPr, NS.W, 'b');
  if (bEl) {
    const val = bEl.getAttribute('w:val');
    style.bold = val !== '0' && val !== 'false';
  }

  // Italic (w:i)
  const iEl = getDirectChild(rPr, NS.W, 'i');
  if (iEl) {
    const val = iEl.getAttribute('w:val');
    style.italic = val !== '0' && val !== 'false';
  }

  // Underline (w:u)
  const uEl = getDirectChild(rPr, NS.W, 'u');
  if (uEl) {
    const val = uEl.getAttribute('w:val');
    style.underline = !!val && val !== 'none';
  }

  // Strikethrough (w:strike)
  const strikeEl = getDirectChild(rPr, NS.W, 'strike');
  if (strikeEl) {
    const val = strikeEl.getAttribute('w:val');
    style.strikethrough = val !== '0' && val !== 'false';
  }

  // Highlight (w:highlight)
  const highlightEl = getDirectChild(rPr, NS.W, 'highlight');
  if (highlightEl) {
    const val = highlightEl.getAttribute('w:val');
    if (val && val !== 'none' && HIGHLIGHT_COLORS[val]) {
      style.backgroundColor = HIGHLIGHT_COLORS[val];
    }
  }

  // Shading (w:shd) — another way to set background
  if (!style.backgroundColor) {
    const shdEl = getDirectChild(rPr, NS.W, 'shd');
    if (shdEl) {
      const fill = shdEl.getAttribute('w:fill');
      if (fill && fill !== 'auto' && /^[0-9A-Fa-f]{6}$/.test(fill)) {
        style.backgroundColor = `#${fill.toUpperCase()}`;
      }
    }
  }

  // Vertical alignment (w:vertAlign)
  const vertAlignEl = getDirectChild(rPr, NS.W, 'vertAlign');
  if (vertAlignEl) {
    const val = vertAlignEl.getAttribute('w:val');
    if (val === 'superscript') style.verticalAlign = 'superscript';
    else if (val === 'subscript') style.verticalAlign = 'subscript';
  }

  return style;
}

/** Build CSS style string from RunStyle (only visual properties that need CSS) */
function buildCssStyle(style: RunStyle): string {
  const parts: string[] = [];
  if (style.color) parts.push(`color:${style.color}`);
  if (style.fontSize) parts.push(`font-size:${style.fontSize}`);
  if (style.fontFamily) parts.push(`font-family:'${style.fontFamily}'`);
  if (style.backgroundColor) parts.push(`background-color:${style.backgroundColor}`);
  return parts.join(';');
}

/** Merge inherited run style with explicit run style (explicit wins) */
function mergeRunStyles(inherited: RunStyle | undefined, explicit: RunStyle): RunStyle {
  if (!inherited) return explicit;
  return {
    color: explicit.color || inherited.color,
    fontSize: explicit.fontSize || inherited.fontSize,
    fontFamily: explicit.fontFamily || inherited.fontFamily,
    bold: explicit.bold !== undefined ? explicit.bold : inherited.bold,
    italic: explicit.italic !== undefined ? explicit.italic : inherited.italic,
    underline: explicit.underline !== undefined ? explicit.underline : inherited.underline,
    strikethrough: explicit.strikethrough !== undefined ? explicit.strikethrough : inherited.strikethrough,
    backgroundColor: explicit.backgroundColor || inherited.backgroundColor,
    verticalAlign: explicit.verticalAlign || inherited.verticalAlign,
  };
}

/** Extract paragraph-level styles from w:pPr */
function extractParagraphStyle(
  pPr: Element | null,
  stylesMap: Map<string, StyleDef>
): ParagraphStyle {
  const result: ParagraphStyle = { tag: 'p' };
  if (!pPr) return result;

  // Paragraph style name (w:pStyle) — for heading detection
  const pStyleEl = getDirectChild(pPr, NS.W, 'pStyle');
  if (pStyleEl) {
    const styleId = pStyleEl.getAttribute('w:val') || '';

    // Match against heading patterns (style ID itself)
    for (const hp of HEADING_PATTERNS) {
      if (hp.pattern.test(styleId)) { result.tag = hp.tag; break; }
    }

    // If not matched, try the display name from styles.xml
    if (result.tag === 'p' && stylesMap.has(styleId)) {
      const mapped = stylesMap.get(styleId)!;
      if (mapped.tag) result.tag = mapped.tag;
    }
  }

  // Text alignment (w:jc)
  const jcEl = getDirectChild(pPr, NS.W, 'jc');
  if (jcEl) {
    const val = jcEl.getAttribute('w:val');
    if (val === 'center') result.textAlign = 'center';
    else if (val === 'right' || val === 'end') result.textAlign = 'right';
    else if (val === 'both' || val === 'distribute') result.textAlign = 'justify';
  }

  // Numbering / list (w:numPr)
  const numPrEl = getDirectChild(pPr, NS.W, 'numPr');
  if (numPrEl) {
    result.isList = true;
    const ilvlEl = getDirectChild(numPrEl, NS.W, 'ilvl');
    result.listLevel = ilvlEl ? parseInt(ilvlEl.getAttribute('w:val') || '0', 10) : 0;
  }

  return result;
}

/** Get default run style for a paragraph (from docDefaults → Normal/pStyle → pPr/rPr) */
function getDefaultRunStyle(
  pPr: Element | null,
  ctx: ConversionContext
): RunStyle {
  // Always start with document-wide defaults (docDefaults + Normal style)
  // This ensures every run gets at least the correct default font-family and font-size.
  let inherited: RunStyle = { ...ctx.docDefaultRunStyle };

  // Get paragraph style ID; if absent, implicitly "Normal"
  let styleId = '';
  if (pPr) {
    const pStyleEl = getDirectChild(pPr, NS.W, 'pStyle');
    styleId = pStyleEl?.getAttribute('w:val') || '';
  }

  // Apply the named style's run properties (or Normal if implicit)
  if (!styleId) styleId = 'Normal';
  const mapped = ctx.stylesMap.get(styleId);
  if (mapped?.runStyle) {
    inherited = mergeRunStyles(inherited, mapped.runStyle);
  }

  // Apply explicit rPr within pPr (paragraph-level run override)
  if (pPr) {
    const rPr = getDirectChild(pPr, NS.W, 'rPr');
    if (rPr) {
      const explicit = extractRunStyles(rPr, ctx.themeFonts);
      return mergeRunStyles(inherited, explicit);
    }
  }

  return inherited;
}

// ─── styles.xml Parsing ──────────────────────────────────────────────────────

/** Parse word/styles.xml to build a style-ID → StyleDef map */
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

      // Display name (w:name)
      const nameEl = getDirectChild(styleEl, NS.W, 'name');
      if (nameEl) {
        const name = nameEl.getAttribute('w:val') || '';
        for (const hp of HEADING_PATTERNS) {
          if (hp.pattern.test(name)) { entry.tag = hp.tag; break; }
        }
      }

      // Default run properties for this style (with theme font resolution)
      const rPr = getDirectChild(styleEl, NS.W, 'rPr');
      if (rPr) {
        entry.runStyle = extractRunStyles(rPr, themeFonts);
      }

      map.set(styleId, entry);
    }
  } catch {
    // Ignore style parsing errors – return whatever we have
  }
  return map;
}

// ─── Element Converters ──────────────────────────────────────────────────────

/** Convert w:drawing element to <img> HTML */
function convertDrawingToHtml(drawingEl: Element, ctx: ConversionContext): string {
  try {
    // Find a:blip deep inside the drawing
    const blips = drawingEl.getElementsByTagNameNS(NS.A, 'blip');
    if (blips.length === 0) return '';

    const blip = blips[0] as Element;
    const rId =
      blip.getAttributeNS(NS.R, 'embed') ||
      blip.getAttribute('r:embed');
    if (!rId || !ctx.imageMap.has(rId)) return '';

    const dataUrl = ctx.imageMap.get(rId)!;

    // Alt text from wp:docPr
    let alt = '';
    const docPrs = drawingEl.getElementsByTagNameNS(NS.WP, 'docPr');
    if (docPrs.length > 0) {
      alt =
        (docPrs[0] as Element).getAttribute('descr') ||
        (docPrs[0] as Element).getAttribute('name') ||
        '';
    }

    return `<img src="${dataUrl}" alt="${escapeHtml(alt)}" />`;
  } catch {
    return '';
  }
}

/** Convert a single w:r (run) element to HTML */
function convertRunToHtml(
  runEl: Element,
  ctx: ConversionContext,
  defaultRunStyle?: RunStyle
): string {
  // Extract explicit run properties (with theme font resolution)
  const rPr = getDirectChild(runEl, NS.W, 'rPr');
  const explicitStyle = rPr ? extractRunStyles(rPr, ctx.themeFonts) : {};
  const style = mergeRunStyles(defaultRunStyle, explicitStyle);

  // Collect content parts
  const parts: string[] = [];
  const children = runEl.childNodes;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.nodeType !== 1) continue;
    const el = child as Element;

    if (el.localName === 't') {
      parts.push(escapeHtml(el.textContent || ''));
    } else if (el.localName === 'br') {
      parts.push('<br>');
    } else if (el.localName === 'tab') {
      parts.push('&#9;');
    } else if (el.localName === 'drawing') {
      parts.push(convertDrawingToHtml(el, ctx));
    }
  }

  const content = parts.join('');
  if (!content) return '';

  // Build HTML – wrap with style span, then semantic tags
  let html = content;

  const cssStyle = buildCssStyle(style);
  if (cssStyle) {
    html = `<span style="${cssStyle}">${html}</span>`;
  }

  if (style.underline) html = `<u>${html}</u>`;
  if (style.strikethrough) html = `<s>${html}</s>`;
  if (style.italic) html = `<em>${html}</em>`;
  if (style.bold) html = `<strong>${html}</strong>`;
  if (style.verticalAlign === 'superscript') html = `<sup>${html}</sup>`;
  else if (style.verticalAlign === 'subscript') html = `<sub>${html}</sub>`;

  return html;
}

/** Convert w:hyperlink element to <a> HTML */
function convertHyperlinkToHtml(
  hyperlinkEl: Element,
  ctx: ConversionContext,
  defaultRunStyle?: RunStyle
): string {
  // Resolve href
  const rId =
    hyperlinkEl.getAttributeNS(NS.R, 'id') ||
    hyperlinkEl.getAttribute('r:id');
  const anchor = hyperlinkEl.getAttribute('w:anchor');

  let href = '';
  if (rId && ctx.linkMap.has(rId)) {
    href = ctx.linkMap.get(rId)!;
  } else if (anchor) {
    href = `#${anchor}`;
  }

  // Convert child runs
  let innerHtml = '';
  const children = hyperlinkEl.childNodes;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.nodeType !== 1) continue;
    const el = child as Element;
    if (el.localName === 'r') {
      innerHtml += convertRunToHtml(el, ctx, defaultRunStyle);
    }
  }

  if (href) {
    return `<a href="${escapeHtml(href)}">${innerHtml}</a>`;
  }
  return innerHtml;
}

/** Convert the inner content of a w:p to HTML (without the wrapper tag) */
function convertParagraphInner(
  paraEl: Element,
  ctx: ConversionContext
): string {
  const pPr = getDirectChild(paraEl, NS.W, 'pPr');
  const defaultRunStyle = getDefaultRunStyle(pPr, ctx);

  let innerHtml = '';
  const children = paraEl.childNodes;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.nodeType !== 1) continue;
    const el = child as Element;

    if (el.localName === 'r') {
      innerHtml += convertRunToHtml(el, ctx, defaultRunStyle);
    } else if (el.localName === 'hyperlink') {
      innerHtml += convertHyperlinkToHtml(el, ctx, defaultRunStyle);
    }
  }
  return innerHtml;
}

/** Convert a w:p (paragraph) to full HTML element */
function convertParagraphToHtml(paraEl: Element, ctx: ConversionContext): string {
  const pPr = getDirectChild(paraEl, NS.W, 'pPr');
  const paraStyle = extractParagraphStyle(pPr, ctx.stylesMap);
  const innerHtml = convertParagraphInner(paraEl, ctx);

  const cssStyles: string[] = [];
  if (paraStyle.textAlign) cssStyles.push(`text-align:${paraStyle.textAlign}`);
  const styleAttr = cssStyles.length > 0 ? ` style="${cssStyles.join(';')}"` : '';
  const tag = paraStyle.tag;

  if (!innerHtml.trim()) {
    return `<${tag}${styleAttr}><br></${tag}>\n`;
  }
  return `<${tag}${styleAttr}>${innerHtml}</${tag}>\n`;
}

/** Convert a w:tbl (table) to HTML */
function convertTableToHtml(tblEl: Element, ctx: ConversionContext): string {
  let html = '<table border="1" cellpadding="4" cellspacing="0">\n';

  const rows = getDirectChildren(tblEl, NS.W, 'tr');
  for (const row of rows) {
    html += '<tr>';

    const cells = getDirectChildren(row, NS.W, 'tc');
    for (const cell of cells) {
      html += '<td>';

      // Each cell contains paragraphs
      const paras = getDirectChildren(cell, NS.W, 'p');
      for (const para of paras) {
        html += convertParagraphToHtml(para, ctx);
      }

      html += '</td>';
    }

    html += '</tr>\n';
  }

  html += '</table>\n';
  return html;
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
          const mime =
            ext === 'jpg' || ext === 'jpeg'
              ? 'image/jpeg'
              : ext === 'gif'
                ? 'image/gif'
                : ext === 'bmp'
                  ? 'image/bmp'
                  : ext === 'webp'
                    ? 'image/webp'
                    : 'image/png';
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

// ─── Numbering / List Parsing ─────────────────────────────────────────────────

/**
 * Parse word/numbering.xml to build a map of numId → level → numFmt.
 * This tells us whether each list level is bullet, decimal, lowerLetter, etc.
 */
async function parseNumberingXml(zip: any): Promise<NumberingMap> {
  const result: NumberingMap = new Map();

  try {
    const numFile = zip.file('word/numbering.xml');
    if (!numFile) return result;

    const numXml = await numFile.async('string');
    const doc = new DOMParser().parseFromString(numXml, 'application/xml');

    // Parse abstract numbering definitions (abstractNumId → level → numFmt)
    const abstractMap = new Map<string, Map<number, string>>();
    const abstractNums = doc.getElementsByTagNameNS(NS.W, 'abstractNum');

    for (let i = 0; i < abstractNums.length; i++) {
      const absNum = abstractNums[i] as Element;
      const absNumId = absNum.getAttribute('w:abstractNumId');
      if (!absNumId) continue;

      const levels = new Map<number, string>();
      const lvlEls = getDirectChildren(absNum, NS.W, 'lvl');

      for (const lvlEl of lvlEls) {
        const ilvl = parseInt(lvlEl.getAttribute('w:ilvl') || '0', 10);
        const numFmtEl = getDirectChild(lvlEl, NS.W, 'numFmt');
        const numFmt = numFmtEl?.getAttribute('w:val') || 'bullet';
        levels.set(ilvl, numFmt);
      }

      abstractMap.set(absNumId, levels);
    }

    // Parse concrete numbering: numId → abstractNumId mapping
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
    // Numbering parsing is non-fatal
  }

  return result;
}

/** Extract numId and ilvl from a w:pPr element */
function getNumInfo(pPr: Element | null): { numId: string; level: number } | null {
  if (!pPr) return null;
  const numPrEl = getDirectChild(pPr, NS.W, 'numPr');
  if (!numPrEl) return null;

  const numIdEl = getDirectChild(numPrEl, NS.W, 'numId');
  const numId = numIdEl?.getAttribute('w:val');
  // numId "0" means numbering is explicitly removed
  if (!numId || numId === '0') return null;

  const ilvlEl = getDirectChild(numPrEl, NS.W, 'ilvl');
  const level = parseInt(ilvlEl?.getAttribute('w:val') || '0', 10);

  return { numId, level };
}

/** Determine whether a list level is ordered (<ol>) or unordered (<ul>) */
function getListTag(numberingMap: NumberingMap, numId: string, level: number): string {
  const levels = numberingMap.get(numId);
  if (!levels) return 'ul';
  const numFmt = levels.get(level) || 'bullet';
  // "bullet" and "none" → unordered; everything else (decimal, lowerLetter, etc.) → ordered
  return numFmt === 'bullet' || numFmt === 'none' ? 'ul' : 'ol';
}

// ─── Document Defaults Extraction ────────────────────────────────────────────

/** Parse theme fonts from word/theme/theme1.xml (major = heading font, minor = body font) */
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

/** Parse w:docDefaults from styles.xml to get document-level default run properties */
function parseDocDefaults(stylesXml: string, themeFonts: ThemeFonts): RunStyle {
  try {
    const doc = new DOMParser().parseFromString(stylesXml, 'application/xml');
    const docDefaultsEls = doc.getElementsByTagNameNS(NS.W, 'docDefaults');
    if (docDefaultsEls.length === 0) return {};

    const rPrDefault = getDirectChild(docDefaultsEls[0] as Element, NS.W, 'rPrDefault');
    if (!rPrDefault) return {};

    const rPr = getDirectChild(rPrDefault, NS.W, 'rPr');
    if (!rPr) return {};

    return extractRunStyles(rPr, themeFonts);
  } catch {
    return {};
  }
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Convert a DOCX buffer to styled HTML by parsing the DOCX XML directly.
 *
 * This bypasses mammoth.js to preserve ALL inline styles that mammoth strips:
 * - Font color (w:color)
 * - Font size (w:sz)
 * - Font family (w:rFonts)
 * - Text alignment (w:jc)
 * - Background / highlight colors
 * - Bold, italic, underline, strikethrough
 * - Superscript / subscript
 * - Images, hyperlinks, tables
 *
 * @param buffer  DOCX file buffer
 * @param includeImages  Whether to extract and embed images
 * @returns Object with HTML string and extracted images array
 */
export async function convertDocxToStyledHtml(
  buffer: Buffer,
  includeImages: boolean = true
): Promise<{ html: string; images: DocxImage[]; documentDefaults: DocxDocumentDefaults }> {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(buffer);

  // ── Parse document.xml ──
  const docXmlFile = zip.file('word/document.xml');
  if (!docXmlFile) {
    throw new Error('Invalid DOCX: missing word/document.xml');
  }
  const docXml = await docXmlFile.async('string');
  const doc = new DOMParser().parseFromString(docXml, 'application/xml');

  // ── Parse theme fonts (major = headings, minor = body) ──
  const themeFonts = await parseThemeFonts(zip);

  // ── Parse styles.xml (with theme font resolution) ──
  const stylesXmlFile = zip.file('word/styles.xml');
  let stylesMap = new Map<string, StyleDef>();
  let docDefaultsStyle: RunStyle = {};
  if (stylesXmlFile) {
    const stylesXml = await stylesXmlFile.async('string');
    stylesMap = parseStylesXml(stylesXml, themeFonts);
    docDefaultsStyle = parseDocDefaults(stylesXml, themeFonts);
  }

  // ── Compute effective document defaults ──
  // Priority: docDefaults → merged with "Normal" style overrides → effective default
  const normalStyle = stylesMap.get('Normal');
  const effectiveDefault = mergeRunStyles(docDefaultsStyle, normalStyle?.runStyle || {});

  const documentDefaults: DocxDocumentDefaults = {
    font: effectiveDefault.fontFamily || themeFonts.minor || 'Calibri',
    fontSize: effectiveDefault.fontSize ? parseFloat(effectiveDefault.fontSize) : 11,
  };

  // ── Parse numbering definitions (for bullet / numbered list detection) ──
  const numberingMap = await parseNumberingXml(zip);

  // ── Parse relationships (images + hyperlinks) ──
  const { imageMap, linkMap } = await loadRelationships(zip, includeImages);

  // ── Build document default RunStyle (docDefaults merged with Normal) ──
  const docDefaultRunStyle = mergeRunStyles(docDefaultsStyle, normalStyle?.runStyle || {});

  const ctx: ConversionContext = {
    imageMap, linkMap, stylesMap, themeFonts,
    docDefaultRunStyle,
    numberingMap,
  };

  // ── Find body ──
  const bodyEl = doc.getElementsByTagNameNS(NS.W, 'body')[0];
  if (!bodyEl) {
    return { html: '', images: [], documentDefaults };
  }

  // ── Walk body children and build HTML ──
  let html = '';

  // List state tracking: stack of open list tags with their level
  const listStack: Array<{ tag: string; level: number }> = [];
  let currentListNumId = '';

  /** Close all open list tags down to (but not including) targetLevel. Pass -1 to close all. */
  function closeListsToLevel(targetLevel: number): string {
    let out = '';
    while (listStack.length > 0 && listStack[listStack.length - 1].level > targetLevel) {
      const closed = listStack.pop()!;
      out += `</${closed.tag}>\n`;
    }
    return out;
  }

  function closeAllLists(): string {
    let out = '';
    while (listStack.length > 0) {
      const closed = listStack.pop()!;
      out += `</${closed.tag}>\n`;
    }
    currentListNumId = '';
    return out;
  }

  const bodyChildren = bodyEl.childNodes;
  for (let i = 0; i < bodyChildren.length; i++) {
    const child = bodyChildren[i];
    if (child.nodeType !== 1) continue;
    const el = child as Element;

    if (el.localName === 'p') {
      const pPr = getDirectChild(el, NS.W, 'pPr');
      const numInfo = getNumInfo(pPr);

      if (numInfo) {
        // ── List paragraph ──
        const tag = getListTag(numberingMap, numInfo.numId, numInfo.level);
        const level = numInfo.level;

        // If numId changed, close all previous lists and start fresh
        if (currentListNumId && currentListNumId !== numInfo.numId) {
          html += closeAllLists();
        }
        currentListNumId = numInfo.numId;

        if (listStack.length === 0) {
          // Start a new list
          html += `<${tag}>\n`;
          listStack.push({ tag, level });
        } else if (level > listStack[listStack.length - 1].level) {
          // Going deeper — open nested list(s)
          html += `<${tag}>\n`;
          listStack.push({ tag, level });
        } else if (level < listStack[listStack.length - 1].level) {
          // Going shallower — close deeper lists
          html += closeListsToLevel(level);
          // If the tag at current level differs, swap it
          if (listStack.length > 0 && listStack[listStack.length - 1].tag !== tag) {
            const old = listStack.pop()!;
            html += `</${old.tag}>\n<${tag}>\n`;
            listStack.push({ tag, level });
          }
        } else {
          // Same level — check if tag type changed (e.g. ul → ol)
          if (listStack[listStack.length - 1].tag !== tag) {
            const old = listStack.pop()!;
            html += `</${old.tag}>\n<${tag}>\n`;
            listStack.push({ tag, level });
          }
        }

        // Emit the <li>
        const liContent = convertParagraphInner(el, ctx);
        const paraStyle = extractParagraphStyle(pPr, stylesMap);
        const cssStyles: string[] = [];
        if (paraStyle.textAlign) cssStyles.push(`text-align:${paraStyle.textAlign}`);
        // Visual indent for nested levels (helps html-to-docx produce indented output)
        if (level > 0) cssStyles.push(`margin-left:${level * 36}pt`);
        const styleAttr = cssStyles.length > 0 ? ` style="${cssStyles.join(';')}"` : '';
        html += `<li${styleAttr}>${liContent || '&nbsp;'}</li>\n`;
      } else {
        // ── Normal paragraph ──
        html += closeAllLists();
        html += convertParagraphToHtml(el, ctx);
      }
    } else if (el.localName === 'tbl') {
      html += closeAllLists();
      html += convertTableToHtml(el, ctx);
    }
  }

  // Close any remaining open lists
  html += closeAllLists();

  // ── Build DocxImage array from imageMap ──
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

  return { html, images, documentDefaults };
}

