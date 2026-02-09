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
import { escapeHtml } from './utils/escaping.js';

const require = createRequire(import.meta.url);
const { DOMParser } = require('@xmldom/xmldom');

// ─── OOXML Namespace Constants ───────────────────────────────────────────────

const NS = {
  W: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  R: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  WP: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  A: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  PIC: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  MC: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  V: 'urn:schemas-microsoft-com:vml',
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

/** Map OOXML tab leader values to the character used for dot/dash leaders in TOC entries. */
const TAB_LEADER_CHARS: Record<string, string> = {
  dot: '.',
  hyphen: '-',
  underscore: '_',
  middleDot: '·',
  heavy: '━',
};

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
  marginLeft?: string;   // from w:ind left/start
  marginRight?: string;  // from w:ind right/end
  marginTop?: string;    // from w:spacing before
  marginBottom?: string; // from w:spacing after
  textIndent?: string;   // from w:ind firstLine / hanging
  backgroundColor?: string; // from w:shd
  borderTop?: string;    // from w:pBdr w:top
  borderBottom?: string; // from w:pBdr w:bottom
  borderLeft?: string;   // from w:pBdr w:left
  borderRight?: string;  // from w:pBdr w:right
  tabLeader?: string;    // from w:tabs (e.g. 'dot', 'hyphen', 'underscore')
}

interface StyleDef {
  tag?: string;
  runStyle?: RunStyle;
  basedOn?: string; // w:basedOn styleId — used to resolve inheritance chains
  paragraph?: {
    textAlign?: string;
  };
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

// ─── ZIP Helpers ─────────────────────────────────────────────────────────────

/**
 * Find a file in a JSZip instance, with case-insensitive fallback.
 * Some DOCX generators use inconsistent casing (e.g. `Word/Document.xml`
 * vs `word/document.xml`), so we fall back to a case-insensitive search.
 */
function findZipFile(zip: any, path: string): any | null {
  // Try exact path first (fast path)
  const file = zip.file(path);
  if (file) return file;

  // Case-insensitive fallback
  const lowerPath = path.toLowerCase();
  const allPaths: string[] = Object.keys(zip.files);
  const match = allPaths.find((p: string) => p.toLowerCase() === lowerPath);
  return match ? zip.file(match) : null;
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

/** Convert OOXML twips (1/20 pt) to a CSS pt string. */
function twipsToPt(twips: number): string {
  return `${(twips / 20).toFixed(1)}pt`;
}

/** Convert a paragraph border element (w:top/w:bottom/…) to a CSS border string. */
function extractBorder(borderEl: Element | null): string | undefined {
  if (!borderEl) return undefined;
  const val = borderEl.getAttribute('w:val');
  if (!val || val === 'nil' || val === 'none') return undefined;

  // sz is in eighths of a point; convert to pt
  const szAttr = borderEl.getAttribute('w:sz') || '0';
  const sz = parseInt(szAttr, 10);
  const widthPt = sz > 0 ? (sz / 8).toFixed(1) : '0';

  // Fallback to solid if unknown
  const style = val === 'single' ? 'solid' : 'solid';

  let color = borderEl.getAttribute('w:color') || '';
  if (color && color !== 'auto' && /^[0-9A-Fa-f]{6}$/.test(color)) {
    color = `#${color.toUpperCase()}`;
  } else {
    color = '#000000';
  }

  if (widthPt === '0') return undefined;
  return `${widthPt}pt ${style} ${color}`;
}

function extractParagraphStyle(pPr: Element | null, stylesMap: Map<string, StyleDef>): ParagraphStyle {
  const result: ParagraphStyle = { tag: 'p' };
  if (!pPr) return result;

  // ── Style → tag mapping ──
  const pStyleEl = getDirectChild(pPr, NS.W, 'pStyle');
  if (pStyleEl) {
    const styleId = pStyleEl.getAttribute('w:val') || '';

    for (const hp of HEADING_PATTERNS) {
      if (hp.pattern.test(styleId)) { result.tag = hp.tag; break; }
    }

    if (result.tag === 'p' && stylesMap.has(styleId)) {
      const mapped = stylesMap.get(styleId)!;
      if (mapped.tag) result.tag = mapped.tag;
      // Apply style-level paragraph alignment as a default (can be overridden by explicit pPr/jc below)
      if (mapped.paragraph?.textAlign) {
        result.textAlign = mapped.paragraph.textAlign;
      }
    }
  }

  // ── Alignment ──
  const jcEl = getDirectChild(pPr, NS.W, 'jc');
  if (jcEl) {
    const val = jcEl.getAttribute('w:val');
    // Map all common Word alignment values to CSS text-align
    if (val === 'center') {
      result.textAlign = 'center';
    } else if (val === 'right' || val === 'end') {
      result.textAlign = 'right';
    } else if (
      val === 'both' ||
      val === 'distribute' ||
      val === 'thaiDistribute' ||
      val === 'justify' ||
      val === 'mediumKashida' ||
      val === 'lowKashida' ||
      val === 'highKashida'
    ) {
      result.textAlign = 'justify';
    } else if (val === 'left' || val === 'start') {
      // Make left/start explicit so it survives through conversions
      result.textAlign = 'left';
    }
  }

  // ── Indentation (w:ind) ──
  const indEl = getDirectChild(pPr, NS.W, 'ind');
  if (indEl) {
    // w:left or w:start (start is newer, fallback to left)
    const leftTwips = parseInt(indEl.getAttribute('w:start') || indEl.getAttribute('w:left') || '0', 10);
    if (leftTwips > 0) result.marginLeft = twipsToPt(leftTwips);

    const rightTwips = parseInt(indEl.getAttribute('w:end') || indEl.getAttribute('w:right') || '0', 10);
    if (rightTwips > 0) result.marginRight = twipsToPt(rightTwips);

    // First-line indent / hanging indent
    const firstLineTwips = parseInt(indEl.getAttribute('w:firstLine') || '0', 10);
    const hangingTwips = parseInt(indEl.getAttribute('w:hanging') || '0', 10);
    if (firstLineTwips > 0) {
      result.textIndent = twipsToPt(firstLineTwips);
    } else if (hangingTwips > 0) {
      // Hanging indent: negative text-indent is a common approximation
      const indent = twipsToPt(hangingTwips);
      result.textIndent = `-${indent}`;
    }
  }

  // ── Spacing before/after (w:spacing) ──
  const spacingEl = getDirectChild(pPr, NS.W, 'spacing');
  if (spacingEl) {
    const beforeTwips = parseInt(spacingEl.getAttribute('w:before') || '0', 10);
    if (beforeTwips > 0) result.marginTop = twipsToPt(beforeTwips);

    const afterTwips = parseInt(spacingEl.getAttribute('w:after') || '0', 10);
    if (afterTwips > 0) result.marginBottom = twipsToPt(afterTwips);
    // We deliberately ignore line/lineRule for now to avoid over-constraining line-height.
  }

  // ── Shading (background colour) ──
  const shdEl = getDirectChild(pPr, NS.W, 'shd');
  if (shdEl) {
    const fill = shdEl.getAttribute('w:fill');
    if (fill && fill !== 'auto' && /^[0-9A-Fa-f]{6}$/.test(fill)) {
      result.backgroundColor = `#${fill.toUpperCase()}`;
    }
  }

  // ── Paragraph borders (w:pBdr) ──
  const pBdrEl = getDirectChild(pPr, NS.W, 'pBdr');
  if (pBdrEl) {
    const topEl = getDirectChild(pBdrEl, NS.W, 'top');
    const bottomEl = getDirectChild(pBdrEl, NS.W, 'bottom');
    const leftEl = getDirectChild(pBdrEl, NS.W, 'left');
    const rightEl = getDirectChild(pBdrEl, NS.W, 'right');

    const top = extractBorder(topEl);
    const bottom = extractBorder(bottomEl);
    const left = extractBorder(leftEl);
    const right = extractBorder(rightEl);

    if (top) result.borderTop = top;
    if (bottom) result.borderBottom = bottom;
    if (left) result.borderLeft = left;
    if (right) result.borderRight = right;
  }

  // ── Tab leader (w:tabs → w:tab[@w:leader]) ──
  const tabsEl = getDirectChild(pPr, NS.W, 'tabs');
  if (tabsEl) {
    const tabEls = getDirectChildren(tabsEl, NS.W, 'tab');
    for (const tab of tabEls) {
      const leader = tab.getAttribute('w:leader');
      if (leader && leader !== 'none') {
        result.tabLeader = leader; // 'dot', 'hyphen', 'underscore', 'middleDot', 'heavy'
        break;
      }
    }
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

    // First pass: collect all styles with their basedOn references
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

      // Paragraph-level properties (e.g. alignment) that apply to all paragraphs using this style
      const pPrEl = getDirectChild(styleEl, NS.W, 'pPr');
      if (pPrEl) {
        const jcEl = getDirectChild(pPrEl, NS.W, 'jc');
        if (jcEl) {
          const val = jcEl.getAttribute('w:val');
          if (val === 'center') {
            entry.paragraph = { ...(entry.paragraph || {}), textAlign: 'center' };
          } else if (val === 'right' || val === 'end') {
            entry.paragraph = { ...(entry.paragraph || {}), textAlign: 'right' };
          } else if (
            val === 'both' ||
            val === 'distribute' ||
            val === 'thaiDistribute' ||
            val === 'justify' ||
            val === 'mediumKashida' ||
            val === 'lowKashida' ||
            val === 'highKashida'
          ) {
            entry.paragraph = { ...(entry.paragraph || {}), textAlign: 'justify' };
          } else if (val === 'left' || val === 'start') {
            entry.paragraph = { ...(entry.paragraph || {}), textAlign: 'left' };
          }
        }
      }

      // Capture basedOn reference for inheritance resolution
      const basedOnEl = getDirectChild(styleEl, NS.W, 'basedOn');
      if (basedOnEl) {
        entry.basedOn = basedOnEl.getAttribute('w:val') || undefined;
      }

      const rPr = getDirectChild(styleEl, NS.W, 'rPr');
      if (rPr) entry.runStyle = extractRunStyles(rPr, themeFonts);

      map.set(styleId, entry);
    }

    // Second pass: resolve basedOn inheritance chains
    // Walk up each style's basedOn chain and merge inherited run styles
    resolveStyleInheritance(map);
  } catch {
    // Non-fatal — return whatever we have
  }
  return map;
}

/**
 * Resolve basedOn inheritance chains for all styles.
 * Each style's runStyle is merged with its parent's (fully-resolved) runStyle,
 * so that the final runStyle on each entry contains the complete set of inherited properties.
 */
function resolveStyleInheritance(map: Map<string, StyleDef>): void {
  const resolved = new Set<string>();

  function resolve(styleId: string, visited: Set<string>): void {
    if (resolved.has(styleId) || !map.has(styleId)) return;
    if (visited.has(styleId)) return; // Circular reference guard
    visited.add(styleId);

    const entry = map.get(styleId)!;
    if (entry.basedOn && map.has(entry.basedOn)) {
      // Ensure the parent is resolved first
      resolve(entry.basedOn, visited);

      const parent = map.get(entry.basedOn)!;
      if (parent.runStyle) {
        // Merge: parent's resolved style is the base, this style's own rPr overrides
        entry.runStyle = mergeRunStyles(parent.runStyle, entry.runStyle || {});
      }
      // Inherit paragraph properties (e.g. textAlign) if not explicitly set
      if (parent.paragraph) {
        entry.paragraph = {
          textAlign: entry.paragraph?.textAlign || parent.paragraph.textAlign,
        };
      }
      // Inherit tag from parent if not set
      if (!entry.tag && parent.tag) entry.tag = parent.tag;
    }

    resolved.add(styleId);
  }

  for (const styleId of map.keys()) {
    resolve(styleId, new Set());
  }
}

// ─── Element Converters ──────────────────────────────────────────────────────

/** EMU (English Metric Units) to pixels (96 DPI). 1 inch = 914400 EMU, 1 px = 9525 EMU. */
const EMU_PER_PX = 9525;

/** Convert CSS-like units to pixels (approximate). */
function unitToPx(value: number, unit: string): number {
  switch (unit) {
    case 'px': return value;
    case 'pt': return value * (96 / 72);      // 1pt = 96/72 px
    case 'in': return value * 96;              // 1in = 96px
    case 'cm': return value * (96 / 2.54);     // 1cm = 96/2.54 px
    case 'mm': return value * (96 / 25.4);     // 1mm = 96/25.4 px
    default: return value;
  }
}

function convertDrawingToHtml(drawingEl: Element, ctx: ConversionContext): string {
  try {
    // Search for blip (image reference) — first by namespace, then by localName as fallback
    let blip: Element | null = null;
    const blips = drawingEl.getElementsByTagNameNS(NS.A, 'blip');
    if (blips.length > 0) {
      blip = blips[0] as Element;
    } else {
      // Fallback: search by localName only (handles namespace prefix issues)
      const allEls = drawingEl.getElementsByTagName('*');
      for (let i = 0; i < allEls.length; i++) {
        if ((allEls[i] as Element).localName === 'blip') { blip = allEls[i] as Element; break; }
      }
    }
    if (!blip) return '';

    const rId = blip.getAttributeNS(NS.R, 'embed')
             || blip.getAttribute('r:embed')
             || blip.getAttributeNS(NS.R, 'link')
             || blip.getAttribute('r:link');
    if (!rId || !ctx.imageMap.has(rId)) return '';

    const dataUrl = ctx.imageMap.get(rId)!;

    // Extract alt text from wp:docPr
    let alt = '';
    const docPrs = drawingEl.getElementsByTagNameNS(NS.WP, 'docPr');
    if (docPrs.length > 0) {
      alt = (docPrs[0] as Element).getAttribute('descr')
         || (docPrs[0] as Element).getAttribute('name')
         || '';
    }

    // Extract image dimensions from wp:extent (cx/cy in EMUs)
    const attrs: string[] = [`src="${dataUrl}"`, `alt="${escapeHtml(alt)}"`];
    const extents = drawingEl.getElementsByTagNameNS(NS.WP, 'extent');
    if (extents.length > 0) {
      const ext = extents[0] as Element;
      const cx = parseInt(ext.getAttribute('cx') || '0', 10);
      const cy = parseInt(ext.getAttribute('cy') || '0', 10);
      if (cx > 0) attrs.push(`width="${Math.round(cx / EMU_PER_PX)}"`);
      if (cy > 0) attrs.push(`height="${Math.round(cy / EMU_PER_PX)}"`);
    }

    return `<img ${attrs.join(' ')} />`;
  } catch {
    return '';
  }
}

/**
 * Convert a VML `w:pict` element to an HTML `<img>` tag.
 * Older DOCX files and mc:Fallback blocks use VML instead of DrawingML.
 */
function convertPictToHtml(pictEl: Element, ctx: ConversionContext): string {
  try {
    // Search all descendants for imagedata elements (may use v: prefix or no prefix)
    const allEls = pictEl.getElementsByTagName('*');
    let rId = '';
    let shapeStyle = '';

    for (let i = 0; i < allEls.length; i++) {
      const el = allEls[i] as Element;
      const local = el.localName || '';

      if (local === 'imagedata') {
        rId = el.getAttributeNS(NS.R, 'id') || el.getAttribute('r:id') || '';
      }
      if (local === 'shape' && !shapeStyle) {
        shapeStyle = el.getAttribute('style') || '';
      }
    }

    if (!rId || !ctx.imageMap.has(rId)) return '';

    const dataUrl = ctx.imageMap.get(rId)!;
    const attrs: string[] = [`src="${dataUrl}"`];

    if (shapeStyle) {
      const wMatch = shapeStyle.match(/width:\s*([\d.]+)\s*(pt|px|in|cm|mm)/);
      const hMatch = shapeStyle.match(/height:\s*([\d.]+)\s*(pt|px|in|cm|mm)/);
      // Convert to pixels for html-to-docx (approx: 1pt ≈ 1.333px, 1in = 96px, 1cm ≈ 37.8px)
      if (wMatch) {
        const px = unitToPx(parseFloat(wMatch[1]), wMatch[2]);
        if (px > 0) attrs.push(`width="${Math.round(px)}"`);
      }
      if (hMatch) {
        const px = unitToPx(parseFloat(hMatch[1]), hMatch[2]);
        if (px > 0) attrs.push(`height="${Math.round(px)}"`);
      }
    }

    return `<img ${attrs.join(' ')} />`;
  } catch {
    return '';
  }
}

/**
 * Convert an `mc:AlternateContent` element within a run to HTML.
 * Modern Word wraps drawings in mc:AlternateContent/mc:Choice with an
 * mc:Fallback/w:pict for backward compatibility.
 */
function convertAlternateContentInRun(acEl: Element, ctx: ConversionContext): string {
  // Try mc:Choice first (preferred — DrawingML)
  for (let i = 0; i < acEl.childNodes.length; i++) {
    const child = acEl.childNodes[i];
    if (child.nodeType !== 1) continue;
    const el = child as Element;

    if (el.localName === 'Choice') {
      // Look for w:drawing descendants
      const drawings = el.getElementsByTagNameNS(NS.W, 'drawing');
      if (drawings.length > 0) return convertDrawingToHtml(drawings[0] as Element, ctx);
      // Also check by localName (some docs omit namespace on drawing)
      for (let j = 0; j < el.childNodes.length; j++) {
        const cc = el.childNodes[j];
        if (cc.nodeType === 1 && (cc as Element).localName === 'drawing') {
          return convertDrawingToHtml(cc as Element, ctx);
        }
      }
    }
  }

  // Fallback: try mc:Fallback → w:pict (VML)
  for (let i = 0; i < acEl.childNodes.length; i++) {
    const child = acEl.childNodes[i];
    if (child.nodeType !== 1) continue;
    const el = child as Element;

    if (el.localName === 'Fallback') {
      for (let j = 0; j < el.childNodes.length; j++) {
        const fc = el.childNodes[j];
        if (fc.nodeType === 1 && (fc as Element).localName === 'pict') {
          return convertPictToHtml(fc as Element, ctx);
        }
      }
    }
  }

  return '';
}

/**
 * Convert a `w:r` (run) element to HTML.
 *
 * CRITICAL: Images (`<img>`) must NOT be wrapped in `<span>` tags.
 * `html-to-docx` only detects `<img>` as **direct children** of `<p>` elements —
 * if images are nested inside `<span>`, they are silently dropped from the output DOCX.
 *
 * Therefore, this function separates text content (wrapped in styled `<span>`)
 * from image content (emitted as bare `<img>` elements).
 */
function convertRunToHtml(runEl: Element, ctx: ConversionContext, defaultRunStyle?: RunStyle): string {
  const rPr = getDirectChild(runEl, NS.W, 'rPr');
  const explicitStyle = rPr ? extractRunStyles(rPr, ctx.themeFonts) : {};
  const style = mergeRunStyles(defaultRunStyle, explicitStyle);

  const textParts: string[] = [];
  const imageParts: string[] = [];

  for (let i = 0; i < runEl.childNodes.length; i++) {
    const child = runEl.childNodes[i];
    if (child.nodeType !== 1) continue;
    const el = child as Element;

    if (el.localName === 't') textParts.push(escapeHtml(el.textContent || ''));
    else if (el.localName === 'br') textParts.push('<br>');
    else if (el.localName === 'tab') textParts.push('&#9;');
    else if (el.localName === 'drawing') imageParts.push(convertDrawingToHtml(el, ctx));
    else if (el.localName === 'pict') imageParts.push(convertPictToHtml(el, ctx));
    else if (el.localName === 'AlternateContent') imageParts.push(convertAlternateContentInRun(el, ctx));
    else if (el.localName === 'object') {
      // w:object can contain w:pict or w:drawing
      const objDrawing = getDirectChild(el, NS.W, 'drawing');
      if (objDrawing) imageParts.push(convertDrawingToHtml(objDrawing, ctx));
      else {
        const objPict = getDirectChild(el, NS.W, 'pict');
        if (objPict) imageParts.push(convertPictToHtml(objPict, ctx));
        else {
          // Try by localName without namespace
          for (let j = 0; j < el.childNodes.length; j++) {
            const oc = el.childNodes[j];
            if (oc.nodeType !== 1) continue;
            const ocEl = oc as Element;
            if (ocEl.localName === 'pict') { imageParts.push(convertPictToHtml(ocEl, ctx)); break; }
            if (ocEl.localName === 'drawing') { imageParts.push(convertDrawingToHtml(ocEl, ctx)); break; }
          }
        }
      }
    }
  }

  let result = '';

  // Wrap TEXT content in styled span/formatting tags — but NOT images
  const textContent = textParts.join('');
  if (textContent) {
    let html = textContent;

    const cssStyle = buildCssStyle(style);
    if (cssStyle) html = `<span style="${cssStyle}">${html}</span>`;

    if (style.underline) html = `<u>${html}</u>`;
    if (style.strikethrough) html = `<s>${html}</s>`;
    if (style.italic) html = `<em>${html}</em>`;
    if (style.bold) html = `<strong>${html}</strong>`;
    if (style.verticalAlign === 'superscript') html = `<sup>${html}</sup>`;
    else if (style.verticalAlign === 'subscript') html = `<sub>${html}</sub>`;

    result += html;
  }

  // Append images OUTSIDE styling wrappers — html-to-docx needs them as direct <p> children
  const imageContent = imageParts.filter(Boolean).join('');
  if (imageContent) result += imageContent;

  return result;
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

  /** Recursively gather inline content from the hyperlink. */
  function gather(container: Element): void {
    for (let i = 0; i < container.childNodes.length; i++) {
      const child = container.childNodes[i];
      if (child.nodeType !== 1) continue;
      const el = child as Element;
      if (el.localName === 'r') innerHtml += convertRunToHtml(el, ctx, defaultRunStyle);
      else if (el.localName === 'fldSimple') gather(el);
      else if (el.localName === 'sdt') {
        const sdtContent = getDirectChild(el, NS.W, 'sdtContent');
        if (sdtContent) gather(sdtContent);
      }
    }
  }
  gather(hyperlinkEl);

  return href ? `<a href="${escapeHtml(href)}">${innerHtml}</a>` : innerHtml;
}

/**
 * Convert paragraph-level inline elements to HTML.
 *
 * Handles: w:r, w:hyperlink, w:sdt, w:fldSimple, w:ins, w:del, w:smartTag,
 * and w:bookmarkStart / w:bookmarkEnd (for anchor links).
 *
 * `w:fldSimple` is CRITICAL for TOC entries — it wraps hyperlinks and runs
 * inside a field code (e.g. `TOC`, `PAGEREF`). Without this, the entire
 * TOC content would be silently dropped.
 */
function convertParagraphInner(paraEl: Element, ctx: ConversionContext): string {
  const pPr = getDirectChild(paraEl, NS.W, 'pPr');
  const defaultRunStyle = getDefaultRunStyle(pPr, ctx);

  let innerHtml = '';

  /** Recursively process inline child elements within a container (paragraph, fldSimple, sdt, etc.). */
  function processInlineChildren(container: Element): void {
    for (let i = 0; i < container.childNodes.length; i++) {
      const child = container.childNodes[i];
      if (child.nodeType !== 1) continue;
      const el = child as Element;

      switch (el.localName) {
        case 'r':
          innerHtml += convertRunToHtml(el, ctx, defaultRunStyle);
          break;

        case 'hyperlink':
          innerHtml += convertHyperlinkToHtml(el, ctx, defaultRunStyle);
          break;

        case 'fldSimple':
          // Field-simple wraps content like TOC entries, PAGEREF, etc.
          // Process its children as if they were direct paragraph children.
          processInlineChildren(el);
          break;

        case 'sdt': {
          // Inline structured document tags within a paragraph
          const sdtContent = getDirectChild(el, NS.W, 'sdtContent');
          if (sdtContent) processInlineChildren(sdtContent);
          break;
        }

        case 'smartTag':
          // Smart tags wrap runs — process inner content
          processInlineChildren(el);
          break;

        case 'ins':
        case 'moveTo':
          // Revision tracking — accept insertions by processing inner runs
          processInlineChildren(el);
          break;

        case 'del':
        case 'moveFrom':
          // Revision tracking — skip deleted content
          break;

        case 'bookmarkStart': {
          // Create an anchor for internal links (used by TOC hyperlinks)
          const name = el.getAttribute('w:name');
          if (name && name !== '_GoBack') {
            innerHtml += `<a id="${escapeHtml(name)}"></a>`;
          }
          break;
        }

        // bookmarkEnd, proofErr, permStart, permEnd → skip silently
        default:
          break;
      }
    }
  }

  processInlineChildren(paraEl);
  return innerHtml;
}

function convertParagraphToHtml(paraEl: Element, ctx: ConversionContext): string {
  const pPr = getDirectChild(paraEl, NS.W, 'pPr');
  const paraStyle = extractParagraphStyle(pPr, ctx.stylesMap);
  let innerHtml = convertParagraphInner(paraEl, ctx);

  // Replace tab characters with dot-leader spans when the paragraph has a tab leader
  if (paraStyle.tabLeader) {
    const leaderChar = TAB_LEADER_CHARS[paraStyle.tabLeader] || ' ';
    const leaderSpan = `<span style="letter-spacing:2px">${leaderChar.repeat(40)}</span>`;
    innerHtml = innerHtml.replace(/&#9;/g, leaderSpan);
  }

  const cssParts: string[] = [];
  if (paraStyle.textAlign) cssParts.push(`text-align:${paraStyle.textAlign}`);
  if (paraStyle.marginLeft) cssParts.push(`margin-left:${paraStyle.marginLeft}`);
  if (paraStyle.marginRight) cssParts.push(`margin-right:${paraStyle.marginRight}`);
   if (paraStyle.marginTop) cssParts.push(`margin-top:${paraStyle.marginTop}`);
   if (paraStyle.marginBottom) cssParts.push(`margin-bottom:${paraStyle.marginBottom}`);
   if (paraStyle.textIndent) cssParts.push(`text-indent:${paraStyle.textIndent}`);
   if (paraStyle.backgroundColor) cssParts.push(`background-color:${paraStyle.backgroundColor}`);
   if (paraStyle.borderTop) cssParts.push(`border-top:${paraStyle.borderTop}`);
   if (paraStyle.borderBottom) cssParts.push(`border-bottom:${paraStyle.borderBottom}`);
   if (paraStyle.borderLeft) cssParts.push(`border-left:${paraStyle.borderLeft}`);
   if (paraStyle.borderRight) cssParts.push(`border-right:${paraStyle.borderRight}`);
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
      // Table cells can contain paragraphs, nested tables, and sdt elements
      for (let i = 0; i < cell.childNodes.length; i++) {
        const child = cell.childNodes[i];
        if (child.nodeType !== 1) continue;
        const el = child as Element;
        if (el.localName === 'p') {
          html += convertParagraphToHtml(el, ctx);
        } else if (el.localName === 'tbl') {
          html += convertTableToHtml(el, ctx);
        } else if (el.localName === 'sdt') {
          const sdtContent = getDirectChild(el, NS.W, 'sdtContent');
          if (sdtContent) {
            for (let j = 0; j < sdtContent.childNodes.length; j++) {
              const sc = sdtContent.childNodes[j];
              if (sc.nodeType !== 1) continue;
              const sEl = sc as Element;
              if (sEl.localName === 'p') html += convertParagraphToHtml(sEl, ctx);
              else if (sEl.localName === 'tbl') html += convertTableToHtml(sEl, ctx);
            }
          }
        }
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

  const relsFile = findZipFile(zip, 'word/_rels/document.xml.rels');
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

    if ((type.includes('image') || type.includes('oleObject')) && includeImages) {
      // Resolve the image path — 'target' might be relative (e.g. "media/image1.png")
      const imgPath = target.startsWith('/') ? target.slice(1) : `word/${target}`;
      const imgFile = findZipFile(zip, imgPath);
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
    const numFile = findZipFile(zip, 'word/numbering.xml');
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
    const themeFile = findZipFile(zip, 'word/theme/theme1.xml');
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

/**
 * Extract section-level defaults (page margins, orientation) from `w:sectPr`.
 * We only read the first section's settings and treat them as document defaults.
 */
function parseSectionDefaults(doc: Document): Pick<DocxDocumentDefaults, 'margins' | 'orientation'> {
  try {
    const sectPrEls = doc.getElementsByTagNameNS(NS.W, 'sectPr');
    if (sectPrEls.length === 0) return {};

    const sectPr = sectPrEls[0] as Element;
    const result: Pick<DocxDocumentDefaults, 'margins' | 'orientation'> = {};

    const pgMar = getDirectChild(sectPr, NS.W, 'pgMar');
    if (pgMar) {
      const toNum = (attr: string | null): number | undefined => {
        if (!attr) return undefined;
        const n = parseInt(attr, 10);
        return Number.isNaN(n) ? undefined : n;
      };

      const top = toNum(pgMar.getAttribute('w:top'));
      const right = toNum(pgMar.getAttribute('w:right'));
      const bottom = toNum(pgMar.getAttribute('w:bottom'));
      const left = toNum(pgMar.getAttribute('w:left'));
      const header = toNum(pgMar.getAttribute('w:header'));
      const footer = toNum(pgMar.getAttribute('w:footer'));
      const gutter = toNum(pgMar.getAttribute('w:gutter'));

      if (top != null && right != null && bottom != null && left != null) {
        result.margins = { top, right, bottom, left };
        if (header != null) result.margins.header = header;
        if (footer != null) result.margins.footer = footer;
        if (gutter != null) result.margins.gutter = gutter;
      }
    }

    const pgSz = getDirectChild(sectPr, NS.W, 'pgSz');
    if (pgSz) {
      const orient = pgSz.getAttribute('w:orient');
      if (orient === 'landscape' || orient === 'portrait') {
        result.orientation = orient;
      }
    }

    return result;
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

  const stylesXmlFile = findZipFile(zip, 'word/styles.xml');
  let stylesMap = new Map<string, StyleDef>();
  let docDefaultsStyle: RunStyle = {};
  if (stylesXmlFile) {
    const stylesXml = await stylesXmlFile.async('string');
    stylesMap = parseStylesXml(stylesXml, themeFonts);
    docDefaultsStyle = parseDocDefaults(stylesXml, themeFonts);
  }

  const normalStyle = stylesMap.get('Normal');
  const docDefaultRunStyle = mergeRunStyles(docDefaultsStyle, normalStyle?.runStyle || {});

  // Ensure the default run style ALWAYS has fontFamily and fontSize —
  // this prevents runs that inherit from defaults from losing their font
  if (!docDefaultRunStyle.fontFamily) {
    docDefaultRunStyle.fontFamily = themeFonts.minor || 'Calibri';
  }
  if (!docDefaultRunStyle.fontSize) {
    docDefaultRunStyle.fontSize = '11pt';
  }

  const documentDefaults: DocxDocumentDefaults = {
    font: docDefaultRunStyle.fontFamily,
    fontSize: parseFloat(docDefaultRunStyle.fontSize),
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

  /** Process a single body-level element (paragraph, table, sdt, AlternateContent). */
  function processBodyChild(el: Element): void {
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
    } else if (el.localName === 'sdt') {
      // Structured document tag — unwrap and process inner content
      const sdtContent = getDirectChild(el, NS.W, 'sdtContent');
      if (sdtContent) {
        for (let j = 0; j < sdtContent.childNodes.length; j++) {
          const sc = sdtContent.childNodes[j];
          if (sc.nodeType === 1) processBodyChild(sc as Element);
        }
      }
    } else if (el.localName === 'AlternateContent') {
      // Body-level mc:AlternateContent — try Choice first, then Fallback
      for (let j = 0; j < el.childNodes.length; j++) {
        const ac = el.childNodes[j];
        if (ac.nodeType !== 1) continue;
        if ((ac as Element).localName === 'Choice') {
          for (let k = 0; k < ac.childNodes.length; k++) {
            const cc = ac.childNodes[k];
            if (cc.nodeType === 1) processBodyChild(cc as Element);
          }
          return; // Don't process Fallback if Choice succeeded
        }
      }
      for (let j = 0; j < el.childNodes.length; j++) {
        const ac = el.childNodes[j];
        if (ac.nodeType !== 1) continue;
        if ((ac as Element).localName === 'Fallback') {
          for (let k = 0; k < ac.childNodes.length; k++) {
            const fc = ac.childNodes[k];
            if (fc.nodeType === 1) processBodyChild(fc as Element);
          }
          return;
        }
      }
    }
  }

  for (let i = 0; i < bodyEl.childNodes.length; i++) {
    const child = bodyEl.childNodes[i];
    if (child.nodeType !== 1) continue;
    processBodyChild(child as Element);
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

  // Preserve paragraph-level styling on list items
  if (paraStyle.textAlign) liCss.push(`text-align:${paraStyle.textAlign}`);
  if (paraStyle.marginLeft) liCss.push(`margin-left:${paraStyle.marginLeft}`);
  else if (level > 0) liCss.push(`margin-left:${level * 36}pt`);
  if (paraStyle.marginRight) liCss.push(`margin-right:${paraStyle.marginRight}`);
  if (paraStyle.marginTop) liCss.push(`margin-top:${paraStyle.marginTop}`);
  if (paraStyle.marginBottom) liCss.push(`margin-bottom:${paraStyle.marginBottom}`);
  if (paraStyle.textIndent) liCss.push(`text-indent:${paraStyle.textIndent}`);
  if (paraStyle.backgroundColor) liCss.push(`background-color:${paraStyle.backgroundColor}`);
  if (paraStyle.borderTop) liCss.push(`border-top:${paraStyle.borderTop}`);
  if (paraStyle.borderBottom) liCss.push(`border-bottom:${paraStyle.borderBottom}`);
  if (paraStyle.borderLeft) liCss.push(`border-left:${paraStyle.borderLeft}`);
  if (paraStyle.borderRight) liCss.push(`border-right:${paraStyle.borderRight}`);

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

  const docXmlFile = findZipFile(zip, 'word/document.xml');
  if (!docXmlFile) throw new Error('Invalid DOCX: missing word/document.xml');
  const docXml = await docXmlFile.async('string');
  const doc = new DOMParser().parseFromString(docXml, 'application/xml');

  const { ctx, documentDefaults } = await buildConversionContext(zip, includeImages);

  const bodyEl = doc.getElementsByTagNameNS(NS.W, 'body')[0];
  if (!bodyEl) return { html: '', images: [], documentDefaults };

  const html = convertBodyChildrenToHtml(bodyEl, ctx);
  const images = buildImageArray(ctx.imageMap);

  // Enrich document defaults with section-level settings (margins, orientation)
  const sectionDefaults = parseSectionDefaults(doc);
  const mergedDefaults: DocxDocumentDefaults = {
    ...documentDefaults,
    ...sectionDefaults,
  };

  return { html, images, documentDefaults: mergedDefaults };
}
