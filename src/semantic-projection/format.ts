import type { SelectedChunk } from './select.js';

type LineRange = {
  startLine: number;
  endLine: number;
};

function mergeLineRanges(ranges: LineRange[]): LineRange[] {
  const sorted = ranges
    .filter((range) => range.endLine >= range.startLine)
    .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);

  const merged: LineRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || range.startLine > previous.endLine + 1) {
      merged.push({ ...range });
      continue;
    }
    previous.endLine = Math.max(previous.endLine, range.endLine);
  }
  return merged;
}

function formatRange(range: LineRange): string {
  return range.startLine === range.endLine
    ? String(range.startLine)
    : `${range.startLine}-${range.endLine}`;
}

export function formatSelectedLineChunks(chunks: SelectedChunk[]): string {
  return [...chunks]
    .sort((a, b) => a.startLine - b.startLine || b.score - a.score)
    .map((chunk) => {
      const width = String(chunk.endLine).length;
      const numberedText = chunk.text
        .split(/\r?\n/)
        .map((line, index) => `${String(chunk.startLine + index).padStart(width, ' ')}: ${line}`)
        .join('\n');

      return `[lines ${chunk.startLine}-${chunk.endLine}, relevance ${chunk.score.toFixed(3)}]\n${numberedText}`;
    })
    .join('\n\n');
}

export function formatProjectionCoverage(
  chunks: SelectedChunk[],
  sourceStartLine: number,
  sourceLineCount: number,
): string {
  if (sourceLineCount <= 0) {
    return 'Coverage map:\n- Selected source ranges: none\n- Withheld source ranges: none';
  }

  const sourceEndLine = sourceStartLine + sourceLineCount - 1;
  const selectedRanges = mergeLineRanges(chunks.map((chunk) => ({
    startLine: Math.max(sourceStartLine, chunk.startLine),
    endLine: Math.min(sourceEndLine, chunk.endLine),
  })));

  const withheldRanges: LineRange[] = [];
  let cursor = sourceStartLine;
  for (const range of selectedRanges) {
    if (range.startLine > cursor) {
      withheldRanges.push({ startLine: cursor, endLine: range.startLine - 1 });
    }
    cursor = Math.max(cursor, range.endLine + 1);
  }
  if (cursor <= sourceEndLine) {
    withheldRanges.push({ startLine: cursor, endLine: sourceEndLine });
  }

  return [
    'Coverage map (exact source line ranges):',
    `- Selected source ranges: ${selectedRanges.length > 0 ? selectedRanges.map(formatRange).join(', ') : 'none'}`,
    `- Withheld source ranges: ${withheldRanges.length > 0 ? withheldRanges.map(formatRange).join(', ') : 'none'}`,
  ].join('\n');
}
