/**
 * Markdown to HTML Converter
 * Converts markdown syntax to HTML for backward compatibility
 */

/**
 * Convert markdown text to HTML
 * @param markdown - Markdown text to convert
 * @returns HTML string
 */
export function markdownToHtml(markdown: string): string {
  if (!markdown || !markdown.trim()) {
    return '';
  }

  let html = markdown.trim();

  // Headings (process from h6 to h1 to avoid conflicts)
  html = html.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>');
  html = html.replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>');
  html = html.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

  // Bold (must come before italic to avoid conflicts)
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');

  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/_(.+?)_/g, '<em>$1</em>');

  // Images
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" />');

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Code blocks (inline)
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Line breaks and paragraphs
  const paragraphs = html
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  html = paragraphs
    .map((p) => {
      // Don't wrap if already an HTML tag
      if (p.startsWith('<') && p.endsWith('>')) {
        return p.replace(/\n/g, '<br>');
      }
      return `<p>${p.replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n');

  return html;
}

/**
 * Convert markdown table to HTML table
 * @param markdown - Markdown table string
 * @returns HTML table string
 */
export function markdownTableToHtml(markdown: string): string {
  if (!markdown || !markdown.trim()) {
    return '';
  }

  const lines = markdown
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length < 2) {
    return '';
  }

  // Parse header row
  const headerLine = lines[0];
  const headerCells = parseTableRow(headerLine);

  if (headerCells.length === 0) {
    return '';
  }

  // Skip separator row (index 1)
  const dataRows = lines.slice(2).map(parseTableRow);

  // Build HTML table
  let html = '<table>\n';
  html += '  <thead>\n';
  html += '    <tr>\n';
  for (const cell of headerCells) {
    html += `      <th>${escapeHtml(cell)}</th>\n`;
  }
  html += '    </tr>\n';
  html += '  </thead>\n';

  if (dataRows.length > 0) {
    html += '  <tbody>\n';
    for (const row of dataRows) {
      html += '    <tr>\n';
      for (const cell of row) {
        html += `      <td>${escapeHtml(cell)}</td>\n`;
      }
      html += '    </tr>\n';
    }
    html += '  </tbody>\n';
  }

  html += '</table>';

  return html;
}

/**
 * Parse a markdown table row into cells
 */
function parseTableRow(row: string): string[] {
  return row
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0);
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };

  return text.replace(/[&<>"']/g, (char) => map[char] || char);
}

/**
 * Build markdown table from rows array
 * @param rows - 2D array of table rows
 * @returns Markdown table string
 */
export function buildMarkdownTableFromRows(rows: string[][]): string {
  if (!rows || rows.length === 0) {
    return '';
  }

  const header = rows[0];
  if (!header || header.length === 0) {
    return '';
  }

  const dataRows = rows.slice(1);
  const lines: string[] = [];

  // Header row
  lines.push(`| ${header.join(' | ')} |`);

  // Separator row
  lines.push(`| ${header.map(() => '---').join(' | ')} |`);

  // Data rows
  for (const row of dataRows) {
    // Pad row to match header length
    const paddedRow = [...row];
    while (paddedRow.length < header.length) {
      paddedRow.push('');
    }
    lines.push(`| ${paddedRow.slice(0, header.length).join(' | ')} |`);
  }

  return lines.join('\n');
}

