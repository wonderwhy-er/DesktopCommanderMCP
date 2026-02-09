/**
 * Markdown Conversion Utilities
 *
 * Lightweight markdown-to-HTML conversion for backward compatibility.
 * Used by filesystem.ts and DOCX file-handler.
 *
 * @module docx/utils/markdown
 */

/**
 * Convert simple markdown to HTML if the content appears to be markdown.
 * If it already contains HTML tags it is returned unchanged.
 */
export function convertToHtmlIfNeeded(content: string): string {
  const hasMarkdown = /^#{1,6}\s|^\*\*|^\[.*\]\(|^\|.*\|/.test(content);
  const hasHtmlTags = /<[a-z][\s\S]*>/i.test(content);

  if (!hasMarkdown || hasHtmlTags) return content;

  let html = content;
  html = html.replace(/^### (.*)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.*)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.*)$/gm, '<h1>$1</h1>');
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" />');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  return html
    .split('\n\n')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

