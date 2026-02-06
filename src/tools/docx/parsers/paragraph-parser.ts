import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// @ts-ignore
import * as docx from 'docx';

const { Paragraph, TextRun, ImageRun, HeadingLevel } = docx as any;

import type { DocxElement, DocxParagraph } from '../types.js';
import { getElementChildren } from './xml-parser.js';
import { resolveImageRelId } from './image-extractor.js';

export function parseParagraphElement(
  paragraph: Element,
  images: Map<string, Buffer>,
  headingLevel: number | null
): DocxParagraph | null {
  const runs = extractRunsFromParagraph(paragraph, images);
  
  if (runs.length === 0) {
    return null;
  }

  return new Paragraph({
    children: runs,
    heading: headingLevel ? getDocxHeadingLevel(headingLevel) : undefined,
  });
}

function extractRunsFromParagraph(
  paragraph: Element,
  images: Map<string, Buffer>
): Array<InstanceType<typeof TextRun> | InstanceType<typeof ImageRun>> {
  const runs: any[] = [];
  const children = getElementChildren(paragraph);

  for (const child of children) {
    const nodeName = child.nodeName;
    
    if (nodeName === 'w:r') {
      const textRuns = extractTextRun(child, images);
      runs.push(...textRuns);
    } else if (nodeName === 'w:hyperlink') {
      const linkRuns = child.getElementsByTagName('w:r');
      for (let i = 0; i < linkRuns.length; i++) {
        const textRuns = extractTextRun(linkRuns[i], images);
        runs.push(...textRuns);
      }
    }
  }

  return runs;
}

function extractTextRun(
  run: Element,
  images: Map<string, Buffer>
): Array<InstanceType<typeof TextRun> | InstanceType<typeof ImageRun>> {
  const runs: any[] = [];
  
  const rPr = run.getElementsByTagName('w:rPr')[0];
  const isBold = rPr?.getElementsByTagName('w:b').length > 0;
  const isItalic = rPr?.getElementsByTagName('w:i').length > 0;

  const children = getElementChildren(run);
  
  for (const child of children) {
    const nodeName = child.nodeName;
    
    if (nodeName === 'w:t') {
      const text = child.textContent || '';
      if (text) {
        runs.push(new TextRun({
          text,
          bold: isBold,
          italics: isItalic,
        }));
      }
    } else if (nodeName === 'w:tab') {
      runs.push(new TextRun({ text: '\t' }));
    } else if (nodeName === 'w:br') {
      runs.push(new TextRun({ text: '\n', break: 1 }));
    } else if (nodeName === 'w:drawing' || nodeName === 'w:pict') {
      const relId = resolveImageRelId(child);
      if (relId && images.has(relId)) {
        try {
          runs.push(new ImageRun({
            data: images.get(relId)!,
            transformation: { width: 600, height: 400 },
          }));
        } catch (err) {
          // Skip invalid images
        }
      }
    }
  }

  return runs;
}

function getDocxHeadingLevel(level: number): any {
  const levelMap: Record<number, any> = {
    1: HeadingLevel.HEADING_1,
    2: HeadingLevel.HEADING_2,
    3: HeadingLevel.HEADING_3,
    4: HeadingLevel.HEADING_4,
    5: HeadingLevel.HEADING_5,
    6: HeadingLevel.HEADING_6,
  };
  return levelMap[level] ?? HeadingLevel.HEADING_1;
}

