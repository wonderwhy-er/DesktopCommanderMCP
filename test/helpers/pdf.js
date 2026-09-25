import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { createTempDir } from './test-env.js';

const require = createRequire(import.meta.url);
const { PDFDocument } = require('pdf-lib');

const SAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'samples');
/** A 22-page PDF */
export const SAMPLE_PDF = path.join(SAMPLES, '03_sample_compex.pdf');
/** A 1-page A4 portrait PDF (596x842 points) */
export const SIMPLE_PDF = path.join(SAMPLES, '01_sample_simple.pdf');

/** Each page's size in points, rounded: ['596x842', ...] */
export async function pageSizes(file) {
  const doc = await PDFDocument.load(fs.readFileSync(file));
  return doc.getPages().map((page) => {
    const { width, height } = page.getSize();
    return `${Math.round(width)}x${Math.round(height)}`;
  });
}

/** The text of a tool result (what the AI reads) */
export function answerText(result) {
  return (result?.content ?? []).map((part) => part.text ?? '').join('\n');
}

/** True when a render failed only because this machine has no Chrome to launch */
export function isNoChrome(errorOrText) {
  return /requires Chrome or Chromium/.test(String(errorOrText?.message ?? errorOrText));
}

/**
 * A temporary folder with `allowed` and `outside` subfolders, as real paths
 * (macOS temp folders sit behind a /var -> /private/var link), removed by cleanup().
 */
export function pdfWorkspace(name) {
  const root = createTempDir(`dc-test-${name}-`);
  const allowed = path.join(root, 'allowed');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(allowed);
  fs.mkdirSync(outside);
  return { root, allowed, outside, cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}
