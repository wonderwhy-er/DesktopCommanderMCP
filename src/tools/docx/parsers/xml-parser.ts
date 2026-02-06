/**
 * XML Parser Utilities
 * Helper functions for parsing DOCX XML content
 */

import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { DOMParser } = require('@xmldom/xmldom');

import type { DocxRelationship } from '../types.js';

/**
 * Get all element children of a node
 */
export function getElementChildren(node: Node): Element[] {
  const children: Element[] = [];
  for (let i = 0; i < node.childNodes.length; i++) {
    const child = node.childNodes[i];
    if (child.nodeType === 1) { // ELEMENT_NODE
      children.push(child as Element);
    }
  }
  return children;
}

/**
 * Get attribute value, checking both direct and namespaced attributes
 */
export function getAttributeValue(node: Element, name: string): string | null {
  return node.getAttribute(name) || node.getAttribute(`w:${name}`) || null;
}

/**
 * Parse XML string to Document
 */
export function parseXml(xml: string): Document {
  const parser = new DOMParser();
  return parser.parseFromString(xml, 'application/xml');
}

/**
 * Extract relationship map from relationships XML
 */
export function extractRelationshipMap(relsXml: string | null): Map<string, DocxRelationship> {
  const relMap = new Map<string, DocxRelationship>();
  if (!relsXml) return relMap;
  
  const relDoc = parseXml(relsXml);
  const rels = relDoc.getElementsByTagName('Relationship');
  
  for (let i = 0; i < rels.length; i++) {
    const rel = rels[i];
    const id = rel.getAttribute('Id');
    const type = rel.getAttribute('Type') || '';
    const target = rel.getAttribute('Target') || '';
    
    if (id && target) {
      relMap.set(id, { target, type });
    }
  }
  
  return relMap;
}

/**
 * Get heading level from paragraph element
 */
export function getHeadingLevelFromParagraph(paragraph: Element): number | null {
  const pPr = paragraph.getElementsByTagName('w:pPr')[0];
  if (!pPr) return null;
  
  const pStyle = pPr.getElementsByTagName('w:pStyle')[0];
  if (!pStyle) return null;
  
  const styleVal = getAttributeValue(pStyle, 'val');
  if (!styleVal) return null;
  
  const match = styleVal.match(/heading\s*([1-6])/i);
  if (!match) return null;
  
  return Number(match[1]);
}

