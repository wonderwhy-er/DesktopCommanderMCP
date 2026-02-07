/**
 * Markdown → HTML Converter
 *
 * Provides markdown-to-HTML conversion for DOCX content operations
 * (appendMarkdown, insertTable with markdown input, etc.).
 *
 * @module docx/converters/markdown-to-html
 */

import { escapeHtml } from '../utils.js';

// ─── Markdown → HTML ─────────────────────────────────────────────────────────

/** Convert basic markdown text to HTML. */
export function markdownToHtml(markdown: string): string {
  if (!markdown?.trim()) return '';

  let html = markdown.trim();

  // Headings (h6 → h1 to avoid partial matches)
  html = html.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>');
  html = html.replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>');
  html = html.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

  // Bold (before italic to avoid conflicts)
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');

  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/_(.+?)_/g, '<em>$1</em>');

  // Images & links
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" />');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Paragraphs (double-newline separated)
  return html
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      // Don't wrap blocks that are already complete HTML elements
      if (p.startsWith('<') && p.endsWith('>')) return p.replace(/\n/g, '<br>');
      return `<p>${p.replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n');
}

// ─── Markdown Table → HTML ───────────────────────────────────────────────────

/** Parse a single markdown table row into cell values. */
function parseTableRow(row: string): string[] {
  return row.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

/**
 * Convert a markdown table to an HTML `<table>` with inline CSS borders.
 * html-to-docx needs explicit border styles — without them, tables are invisible in Word.
 */
export function markdownTableToHtml(markdown: string): string {
  if (!markdown?.trim()) return '';

  const lines = markdown
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length < 2) return '';

  const headerCells = parseTableRow(lines[0]);
  if (headerCells.length === 0) return '';

  const dataRows = lines.slice(2).map(parseTableRow);

  const BORDER = 'border:1px solid #000;';
  const CELL = `${BORDER} padding:6px 10px;`;
  const HEADER = `${CELL} background-color:#f2f2f2; font-weight:bold;`;

  let html = `<table style="border-collapse:collapse; width:100%; ${BORDER}">\n`;
  html += '  <thead>\n    <tr>\n';
  for (const cell of headerCells) {
    html += `      <th style="${HEADER}">${escapeHtml(cell)}</th>\n`;
  }
  html += '    </tr>\n  </thead>\n';

  if (dataRows.length > 0) {
    html += '  <tbody>\n';
    for (const row of dataRows) {
      html += '    <tr>\n';
      for (const cell of row) {
        html += `      <td style="${CELL}">${escapeHtml(cell)}</td>\n`;
      }
      html += '    </tr>\n';
    }
    html += '  </tbody>\n';
  }

  return html + '</table>';
}

// ─── Rows Array → Markdown Table ─────────────────────────────────────────────

/** Build a markdown table string from a 2-D rows array (first row = header). */
export function buildMarkdownTableFromRows(rows: string[][]): string {
  if (!rows?.length) return '';

  const header = rows[0];
  if (!header?.length) return '';

  const lines: string[] = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
  ];

  for (const row of rows.slice(1)) {
    const padded = [...row];
    while (padded.length < header.length) padded.push('');
    lines.push(`| ${padded.slice(0, header.length).join(' | ')} |`);
  }

  return lines.join('\n');
}
