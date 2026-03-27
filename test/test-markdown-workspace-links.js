import assert from 'assert';

import { renderMarkdown } from '../dist/ui/file-preview/src/components/markdown-renderer.js';
import { resolveMarkdownLink, rewriteWikiLinks } from '../dist/ui/file-preview/src/markdown-workspace/linking.js';
import { extractMarkdownOutline } from '../dist/ui/file-preview/src/markdown-workspace/outline.js';
import { getRenderedMarkdownCopyText, renderMarkdownWorkspacePreview } from '../dist/ui/file-preview/src/markdown-workspace/preview.js';
import { renderMarkdownEditorShell } from '../dist/ui/file-preview/src/markdown-workspace/editor.js';
import { createSlugTracker, slugifyMarkdownHeading } from '../dist/ui/file-preview/src/markdown-workspace/slugify.js';
import { getMarkdownEditAvailability, getMarkdownFullscreenAvailability, shouldAutoLoadMarkdownOnEnterFullscreen } from '../dist/ui/file-preview/src/markdown-workspace/workspace-controller.js';

async function testSlugGeneration() {
  console.log('\n--- Test 1: heading slug generation ---');

  assert.strictEqual(slugifyMarkdownHeading('  Hello, World!  '), 'hello-world');

  const nextSlug = createSlugTracker();
  assert.strictEqual(nextSlug('Overview'), 'overview');
  assert.strictEqual(nextSlug('Overview'), 'overview-2');
  assert.strictEqual(nextSlug('Overview'), 'overview-3');

  console.log('✓ heading slugs are stable and unique');
}

async function testOutlineExtraction() {
  console.log('\n--- Test 2: markdown outline extraction ---');

  const source = [
    '# Title',
    '',
    '## Details',
    '',
    '```md',
    '# Not a heading',
    '```',
    '',
    '## Details',
    '',
    '### Linked [Section](#details)',
  ].join('\n');

  const outline = extractMarkdownOutline(source);
  assert.deepStrictEqual(
    outline.map((item) => ({ id: item.id, text: item.text, level: item.level })),
    [
      { id: 'title', text: 'Title', level: 1 },
      { id: 'details', text: 'Details', level: 2 },
      { id: 'details-2', text: 'Details', level: 2 },
      { id: 'linked-section', text: 'Linked Section', level: 3 },
    ],
  );

  console.log('✓ outline extraction ignores fenced code and de-duplicates headings');
}

async function testLinkResolution() {
  console.log('\n--- Test 3: markdown link resolution ---');

  const currentPath = '/Users/tester/docs/start.md';

  assert.deepStrictEqual(resolveMarkdownLink(currentPath, '#details'), {
    kind: 'anchor',
    href: '#details',
    anchor: 'details',
  });

  assert.deepStrictEqual(resolveMarkdownLink(currentPath, './guide.md#Install%20Now'), {
    kind: 'file',
    href: './guide.md#Install%20Now',
    targetPath: '/Users/tester/docs/guide.md',
    anchor: 'Install Now',
  });

  assert.deepStrictEqual(resolveMarkdownLink(currentPath, '/tmp/reference.md#Intro'), {
    kind: 'file',
    href: '/tmp/reference.md#Intro',
    targetPath: '/tmp/reference.md',
    anchor: 'Intro',
  });

  assert.deepStrictEqual(resolveMarkdownLink(currentPath, 'https://example.com/docs'), {
    kind: 'external',
    href: 'https://example.com/docs',
    url: 'https://example.com/docs',
  });

  assert.deepStrictEqual(resolveMarkdownLink(currentPath, '[[Meeting Notes#Action Items|Actions]]'), {
    kind: 'file',
    href: '[[Meeting Notes#Action Items|Actions]]',
    targetPath: '/Users/tester/docs/Meeting Notes.md',
    anchor: 'action-items',
  });

  console.log('✓ anchors, file links, absolute paths, external URLs, and wiki links resolve correctly');
}

async function testWikiRewriteAndRendering() {
  console.log('\n--- Test 4: wiki link rewrite and rendering ---');

  const rewritten = rewriteWikiLinks('See [[Meeting Notes#Action Items|Actions]] and `[[Code]]`.');
  assert.ok(rewritten.includes('[Actions](./Meeting%20Notes.md#action-items "mcp-wiki:'), 'Wiki links should rewrite to markdown links with round-trip metadata');
  assert.ok(rewritten.includes('`[[Code]]`'), 'Inline code should remain untouched');

  const html = renderMarkdown([
    '# Title',
    '## Details',
    '## Details',
    '',
    'Go to [[Meeting Notes#Action Items|Actions]].',
  ].join('\n'));

  assert.ok(html.includes('id="title"'), 'Rendered markdown should include slugged heading ids');
  assert.ok(html.includes('id="details-2"'), 'Duplicate headings should receive unique ids');
  assert.ok(html.includes('href="./Meeting%20Notes.md#action-items"'), 'Rendered markdown should keep rewritten wiki links');
  assert.ok(html.includes('data-wiki-link="[[Meeting Notes#Action Items|Actions]]"'), 'Rendered markdown should preserve original wiki-link syntax for editing');

  console.log('✓ markdown rendering uses workspace heading ids and rewritten wiki links');
}

async function testEditAvailability() {
  console.log('\n--- Test 5: fullscreen edit availability ---');

  assert.deepStrictEqual(
    getMarkdownEditAvailability({
      content: '# Ready',
    }),
    { canEdit: true },
  );

  assert.deepStrictEqual(
    getMarkdownEditAvailability({
      content: '[Reading 10 lines from start (total: 20 lines, 10 remaining)]\n# Partial',
    }),
    { canEdit: false, reason: 'Load the full document before editing.' },
  );

  assert.deepStrictEqual(
    getMarkdownEditAvailability({
      content: '# Inline only',
    }),
    { canEdit: true },
  );

  console.log('✓ edit mode is gated by full-content availability');
}

async function testFullscreenWorkspaceHelpers() {
  console.log('\n--- Test 6: fullscreen workspace helpers ---');

  assert.deepStrictEqual(
    getMarkdownFullscreenAvailability({
      availableDisplayModes: ['inline', 'fullscreen'],
    }),
    { canFullscreen: true },
  );

  assert.deepStrictEqual(
    getMarkdownFullscreenAvailability({
      availableDisplayModes: ['inline'],
    }),
    { canFullscreen: false, reason: 'Fullscreen editing is unavailable in this host.' },
  );

  assert.strictEqual(
    shouldAutoLoadMarkdownOnEnterFullscreen('[Reading 10 lines from start (total: 20 lines, 10 remaining)]\n# Partial'),
    true,
  );
  assert.strictEqual(shouldAutoLoadMarkdownOnEnterFullscreen('# Full'), false);

  console.log('✓ fullscreen entry support and partial-read auto-load are detected correctly');
}

async function testPreviewTocRendering() {
  console.log('\n--- Test 7: TOC only renders when requested ---');

  const outline = extractMarkdownOutline(['# Title', '## Section'].join('\n'));
  const inlineHtml = renderMarkdownWorkspacePreview({
    content: '# Title\n\n## Section',
    outline,
    activeHeadingId: 'title',
    showToc: false,
  });
  const fullscreenHtml = renderMarkdownWorkspacePreview({
    content: '# Title\n\n## Section',
    outline,
    activeHeadingId: 'title',
    showToc: true,
  });

  assert.ok(!inlineHtml.includes('markdown-toc-shell'), 'Inline preview should not render a TOC shell');
  assert.ok(fullscreenHtml.includes('markdown-toc-shell'), 'Fullscreen preview should render a TOC shell');

  console.log('✓ preview TOC stays hidden inline and appears when fullscreen layout requests it');
}

async function testCopyFormatsAndEditorShell() {
  console.log('\n--- Test 8: copy formats and editor shell ---');

  const renderedCopy = getRenderedMarkdownCopyText('# Title\n\n- First\n- Second\n\n**Bold** text');
  assert.ok(renderedCopy.includes('Title'), 'Rendered copy should preserve heading text');
  assert.ok(renderedCopy.includes('- First'), 'Rendered copy should preserve list text');
  assert.ok(renderedCopy.includes('Bold text'), 'Rendered copy should flatten formatted inline text');

  const markdownShell = renderMarkdownEditorShell({
    content: '# Title\n\nBody',
    view: 'markdown',
  });
  assert.ok(!markdownShell.includes('markdown-editor-mode-toggle'), 'Editor shell should not duplicate top-bar mode toggle');
  assert.ok(!markdownShell.includes('agents.md'), 'Editor shell should not duplicate file title header');
  assert.ok(!markdownShell.includes('copy-active-markdown'), 'Editor shell should not duplicate top-bar copy action');
  assert.ok(markdownShell.includes('markdown-editor-context-menu'), 'Markdown mode should include formatting context controls');
  assert.ok(markdownShell.includes('data-format="strike"'), 'Context menu should include strikethrough');
  assert.ok(markdownShell.includes('markdown-block-style'), 'Context menu should include semantic block-style dropdown');
  assert.ok(!markdownShell.includes('data-format="color-blue"'), 'Context menu should not include non-native color styling');
  assert.ok(!markdownShell.includes('data-format="highlight"'), 'Context menu should not include non-native highlight styling');
  assert.ok(markdownShell.includes('markdown-link-modal'), 'Markdown mode should include a link-entry modal');

  const rawShell = renderMarkdownEditorShell({
    content: '# Title\n\nBody',
    view: 'raw',
  });
  assert.ok(!rawShell.includes('agents.md'), 'Raw mode should not duplicate the file title');
  assert.ok(!rawShell.includes('markdown-editor-context-menu'), 'Raw mode should not include markdown formatting context controls');
  assert.ok(!rawShell.includes('data-format="bold"'), 'Raw mode should not include formatting buttons');

  console.log('✓ raw/rendered copy support and mode-specific editor shell are wired');
}

export default async function runTests() {
  try {
    await testSlugGeneration();
    await testOutlineExtraction();
    await testLinkResolution();
    await testWikiRewriteAndRendering();
    await testEditAvailability();
    await testFullscreenWorkspaceHelpers();
    await testPreviewTocRendering();
    await testCopyFormatsAndEditorShell();
    console.log('\n✅ Markdown workspace link tests passed!');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('❌ Test failed:', message);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    return false;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().then((success) => {
    process.exit(success ? 0 : 1);
  }).catch((error) => {
    console.error('❌ Unhandled error:', error);
    process.exit(1);
  });
}
