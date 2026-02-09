/**
 * DOCX Section Parser
 *
 * Parses HTML into structured sections (headings, paragraphs, tables, lists, images).
 * Follows Single Responsibility Principle — only handles section parsing.
 *
 * @module docx/extractors/sections
 */

import { createRequire } from 'module';
import type { DocxSection } from '../types.js';

const require = createRequire(import.meta.url);
const { DOMParser } = require('@xmldom/xmldom');

/**
 * Parse HTML into structured sections.
 * Returns a single paragraph section if parsing fails.
 */
export function parseHtmlIntoSections(html: string): DocxSection[] {
  const sections: DocxSection[] = [];

  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const body = doc.getElementsByTagName('body')[0];

    if (!body) {
      sections.push({ type: 'paragraph', content: html });
      return sections;
    }

    for (let i = 0; i < body.childNodes.length; i++) {
      const child = body.childNodes[i];
      if (child.nodeType !== 1) continue;

      const element = child as Element;
      const tag = element.tagName.toLowerCase();
      const content = element.outerHTML || element.innerHTML;

      // Heading detection
      const headingMatch = tag.match(/^h([1-6])$/);
      if (headingMatch) {
        sections.push({ type: 'heading', level: parseInt(headingMatch[1], 10), content });
        continue;
      }

      // Other element types
      switch (tag) {
        case 'img':
          sections.push({ type: 'image', content });
          break;
        case 'table':
          sections.push({ type: 'table', content });
          break;
        case 'ul':
        case 'ol':
          sections.push({ type: 'list', content });
          break;
        case 'p':
        case 'div':
          sections.push({ type: 'paragraph', content });
          break;
      }
    }
  } catch {
    sections.push({ type: 'paragraph', content: html });
  }

  return sections;
}

