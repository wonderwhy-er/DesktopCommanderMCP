import assert from 'assert';
import { pathToFileURL } from 'url';

import { renderMarkdown } from '../dist/ui/file-preview/src/components/markdown-renderer.js';
import { resolveMarkdownLink, rewriteWikiLinks } from '../dist/ui/file-preview/src/markdown/linking.js';
import { extractMarkdownOutline } from '../dist/ui/file-preview/src/markdown/outline.js';
import { getRenderedMarkdownCopyText, renderMarkdownWorkspacePreview } from '../dist/ui/file-preview/src/markdown/preview.js';
import { renderMarkdownEditorShell } from '../dist/ui/file-preview/src/markdown/editor.js';
import { createMarkdownController } from '../dist/ui/file-preview/src/markdown/controller.js';
import { createSlugTracker, slugifyMarkdownHeading } from '../dist/ui/file-preview/src/markdown/slugify.js';
import { getDocumentEditAvailability, getDocumentFullscreenAvailability, shouldAutoLoadDocumentOnEnterFullscreen } from '../dist/ui/file-preview/src/document-workspace.js';

async function testSlugGeneration() {
  console.log('\n--- Test 1: heading slug generation ---');

  assert.strictEqual(slugifyMarkdownHeading('  Hello, World!  '), 'hello-world');

  const nextSlug = createSlugTracker();
  assert.strictEqual(nextSlug('Overview'), 'overview');
  assert.strictEqual(nextSlug('Overview'), 'overview-2');
  assert.strictEqual(nextSlug('Overview'), 'overview-3');

  const collisionTracker = createSlugTracker();
  assert.strictEqual(collisionTracker('Foo'), 'foo');
  assert.strictEqual(collisionTracker('Foo-2'), 'foo-2');
  assert.strictEqual(collisionTracker('Foo'), 'foo-3');

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

  assert.deepStrictEqual(resolveMarkdownLink(currentPath, './guide.md#100%'), {
    kind: 'file',
    href: './guide.md#100%',
    targetPath: '/Users/tester/docs/guide.md',
    anchor: '100%',
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

  assert.deepStrictEqual(resolveMarkdownLink('README.md', 'other.md'), {
    kind: 'file',
    href: 'other.md',
    targetPath: 'other.md',
  });

  assert.deepStrictEqual(resolveMarkdownLink('/start.md', 'guide.md'), {
    kind: 'file',
    href: 'guide.md',
    targetPath: '/guide.md',
  });

  assert.deepStrictEqual(resolveMarkdownLink('C:/start.md', 'guide.md'), {
    kind: 'file',
    href: 'guide.md',
    targetPath: 'C:/guide.md',
  });

  console.log('✓ anchors, file links, absolute paths, external URLs, and wiki links resolve correctly');
}

async function testWikiRewriteAndRendering() {
  console.log('\n--- Test 4: wiki link rewrite and rendering ---');

  const rewritten = rewriteWikiLinks('See [[Meeting Notes#Action Items|Actions]] and `[[Code]]`.');
  assert.ok(rewritten.includes('[Actions](./Meeting%20Notes.md#action-items "mcp-wiki:'), 'Wiki links should rewrite to markdown links with round-trip metadata');
  assert.ok(rewritten.includes('`[[Code]]`'), 'Inline code should remain untouched');
  const multiTickRewrite = rewriteWikiLinks('Use ``[[Code]]`` and `code [[still-not-link]]` samples.');
  assert.ok(multiTickRewrite.includes('``[[Code]]``'), 'Multi-backtick inline code should remain untouched');
  assert.ok(multiTickRewrite.includes('`code [[still-not-link]]`'), 'Wiki links inside inline code should stay literal');

  const fencedRewrite = rewriteWikiLinks([
    '````md',
    '```',
    '[[Inside Code]]',
    '````',
    '[[Outside Code]]',
  ].join('\n'));
  assert.ok(fencedRewrite.includes('[[Inside Code]]'), 'Long code fences should remain open until a matching-length close fence appears');
  assert.ok(fencedRewrite.includes('[Outside Code](./Outside%20Code.md "mcp-wiki:'), 'Wiki links outside closed fences should still rewrite');

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

  console.log('✓ markdown rendering uses preview heading ids and rewritten wiki links');
}

async function testFailedSaveResyncsEditBaseline() {
  console.log('\n--- Test 11: failed saves resync the edit baseline from disk ---');

  const payload = {
    fileName: 'notes.md',
    filePath: '/Users/tester/docs/notes.md',
    fileType: 'markdown',
    content: [
      'alpha',
      'line 1',
      'line 2',
      'line 3',
      'line 4',
      'line 5',
      'line 6',
      'line 7',
      'line 8',
      'beta',
      'omega',
      '',
    ].join('\n'),
  };

  let diskContent = payload.content;
  let editCallCount = 0;
  const storedPayloads = [];
  const previousWindow = globalThis.window;
  globalThis.window = { setTimeout: globalThis.setTimeout };

  try {
    const controller = createMarkdownController({
      callTool: async (name, args) => {
        if (name === 'edit_block') {
          editCallCount += 1;
          if (editCallCount === 2) {
            throw new Error('Simulated second edit_block failure');
          }
          const { old_string: oldString, new_string: newString } = args;
          if (typeof oldString !== 'string' || typeof newString !== 'string') {
            throw new Error('Unexpected edit_block arguments');
          }
          const nextContent = diskContent.replace(oldString, newString);
          assert.notStrictEqual(nextContent, diskContent, 'Each edit block should match the current disk content');
          diskContent = nextContent;
          return {
            content: [{ type: 'text', text: 'Successfully applied 1 edit to notes.md' }],
          };
        }

        if (name === 'read_file') {
          assert.deepStrictEqual(args, { path: payload.filePath });
          return {
            structuredContent: {
              fileName: payload.fileName,
              filePath: payload.filePath,
              fileType: payload.fileType,
            },
            content: [{ type: 'text', text: diskContent }],
          };
        }

        throw new Error(`Unexpected tool call: ${name}`);
      },
      getAvailableDisplayModes: () => ['inline', 'fullscreen'],
      getCurrentDisplayMode: () => 'fullscreen',
      getCurrentPayload: () => payload,
      setExpanded: () => {},
      storePayloadOverride: (nextPayload) => {
        storedPayloads.push(nextPayload);
      },
      rerender: () => {},
      updateSaveStatus: () => {},
    });

    const state = controller.getState(payload);
    state.draftContent = [
      'alpha updated',
      'line 1',
      'line 2',
      'line 3',
      'line 4',
      'line 5',
      'line 6',
      'line 7',
      'line 8',
      'beta updated',
      'omega',
      '',
    ].join('\n');
    state.dirty = true;

    await controller.saveDocument();

    assert.strictEqual(diskContent, [
      'alpha updated',
      'line 1',
      'line 2',
      'line 3',
      'line 4',
      'line 5',
      'line 6',
      'line 7',
      'line 8',
      'beta',
      'omega',
      '',
    ].join('\n'), 'The simulated disk should keep the partial save');
    assert.strictEqual(state.sourceContent, diskContent, 'Source content should match the latest disk contents');
    assert.strictEqual(state.fullDocumentContent, diskContent, 'The full document baseline should match the latest disk contents');
    assert.strictEqual(state.draftContent, [
      'alpha updated',
      'line 1',
      'line 2',
      'line 3',
      'line 4',
      'line 5',
      'line 6',
      'line 7',
      'line 8',
      'beta updated',
      'omega',
      '',
    ].join('\n'), 'Local unsaved edits should stay in the editor');
    assert.strictEqual(state.dirty, true, 'The editor should stay dirty against the new disk baseline');
    assert.strictEqual(state.pendingExternalPayload, null, 'The fresh disk state should be applied immediately instead of waiting behind undo');
    assert.ok(state.error?.includes('Reloaded the latest file from disk as the new baseline'), 'The error should explain that the editor resynced to disk');
    assert.deepStrictEqual(storedPayloads, [{
      fileName: payload.fileName,
      filePath: payload.filePath,
      fileType: payload.fileType,
      content: diskContent,
    }], 'The refreshed payload should be persisted for future renders');
  } finally {
    globalThis.window = previousWindow;
  }

  console.log('✓ failed saves resync the edit baseline without discarding local edits');
}

async function testSuccessfulSaveResetsUndoBaseline() {
  console.log('\n--- Test 12: successful saves reset the undo baseline ---');

  const payload = {
    fileName: 'notes.md',
    filePath: '/Users/tester/docs/notes.md',
    fileType: 'markdown',
    content: 'alpha\n',
  };

  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = { setTimeout: globalThis.setTimeout };
  globalThis.document = {
    getElementById: () => null,
    querySelector: () => null,
  };

  try {
    const controller = createMarkdownController({
      callTool: async (name) => {
        if (name !== 'edit_block') {
          throw new Error(`Unexpected tool call: ${name}`);
        }

        return {
          content: [{ type: 'text', text: 'Successfully applied 1 edit(s) to notes.md' }],
        };
      },
      getAvailableDisplayModes: () => ['inline', 'fullscreen'],
      getCurrentDisplayMode: () => 'inline',
      getCurrentPayload: () => payload,
      setExpanded: () => {},
      storePayloadOverride: () => {},
      rerender: () => {},
      updateSaveStatus: () => {},
    });

    const state = controller.getState(payload);
    state.draftContent = 'beta\n';
    state.dirty = true;

    await controller.saveDocument();

    assert.strictEqual(state.fullDocumentContent, 'beta\n', 'The saved document should become the new baseline');
    assert.strictEqual(state.draftContent, 'beta\n', 'Draft content should stay at the saved value');
    assert.strictEqual(state.dirty, false, 'The workspace should be clean after a successful save');
    assert.strictEqual(controller.isUndoAvailable(state), false, 'Undo should be disabled immediately after saving');
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }

  console.log('✓ successful saves clear undo state against the latest saved content');
}

async function testEditAvailability() {
  console.log('\n--- Test 5: fullscreen edit availability ---');

  assert.deepStrictEqual(
    getDocumentEditAvailability({
      content: '# Ready',
    }),
    { canEdit: true },
  );

  assert.deepStrictEqual(
    getDocumentEditAvailability({
      content: '[Reading 10 lines from start (total: 20 lines, 10 remaining)]\n# Partial',
    }),
    { canEdit: false, reason: 'Load the full document before editing.' },
  );

  assert.deepStrictEqual(
    getDocumentEditAvailability({
      content: '# Inline only',
    }),
    { canEdit: true },
  );

  console.log('✓ edit mode is gated by full-content availability');
}

async function testFullscreenWorkspaceHelpers() {
  console.log('\n--- Test 6: fullscreen document helpers ---');

  assert.deepStrictEqual(
    getDocumentFullscreenAvailability({
      availableDisplayModes: ['inline', 'fullscreen'],
    }),
    { canFullscreen: true },
  );

  assert.deepStrictEqual(
    getDocumentFullscreenAvailability({
      availableDisplayModes: ['inline'],
    }),
    { canFullscreen: false, reason: 'Fullscreen editing is unavailable in this host.' },
  );

  assert.strictEqual(
    shouldAutoLoadDocumentOnEnterFullscreen('[Reading 10 lines from start (total: 20 lines, 10 remaining)]\n# Partial'),
    true,
  );
  assert.strictEqual(shouldAutoLoadDocumentOnEnterFullscreen('# Full'), false);

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
    view: 'raw',
  });
  assert.ok(!rawShell.includes('agents.md'), 'Raw mode should not duplicate the file title');
  assert.ok(!rawShell.includes('markdown-editor-context-menu'), 'Raw mode should not include markdown formatting context controls');
  assert.ok(!rawShell.includes('data-format="bold"'), 'Raw mode should not include formatting buttons');

  console.log('✓ raw/rendered copy support and mode-specific editor shell are wired');
}

async function testPartialDocumentBecomesNewEditBaseline() {
  console.log('\n--- Test 9: partial documents reset baseline after full load ---');

  const partialPayload = {
    fileName: 'notes.md',
    filePath: '/Users/tester/docs/notes.md',
    fileType: 'markdown',
    content: '[Reading 1 lines from start (total: 3 lines, 2 remaining)]\n# Intro',
  };
  const fullContent = '# Intro\n\n## Details\n\nBody';
  let currentPayload = partialPayload;

  const controller = createMarkdownController({
    callTool: async (name, args) => {
      assert.strictEqual(name, 'read_file');
      assert.deepStrictEqual(args, { path: partialPayload.filePath, offset: 0, length: 3 });
      return {
        structuredContent: {
          fileName: partialPayload.fileName,
          filePath: partialPayload.filePath,
          fileType: partialPayload.fileType,
        },
        content: [{ type: 'text', text: fullContent }],
      };
    },
    getAvailableDisplayModes: () => ['inline', 'fullscreen'],
    getCurrentDisplayMode: () => 'fullscreen',
    getCurrentPayload: () => currentPayload,
    setExpanded: () => {},
    syncPayload: (payload) => {
      currentPayload = payload ?? currentPayload;
    },
    storePayloadOverride: () => {},
    rerender: () => {},
    updateSaveStatus: () => {},
  });

  controller.getState(partialPayload);
  await controller.requestEditMode(partialPayload);

  const nextState = controller.getState(currentPayload);
  assert.strictEqual(nextState.mode, 'edit');
  assert.strictEqual(nextState.fullDocumentContent, fullContent, 'The full document should replace the truncated edit baseline');
  assert.strictEqual(nextState.draftContent, fullContent, 'Draft content should start from the full document');
  assert.strictEqual(controller.isUndoAvailable(nextState), false, 'Undo should stay disabled until the user edits the full document');

  console.log('✓ fullscreen edit mode replaces the partial baseline with the full document');
}

async function testRefreshDoesNotMisclassifyMarkdownContentAsDeletion() {
  console.log('\n--- Test 10: refresh does not treat note text as a missing-file error ---');

  const markdownText = '# Debug log\n\nError: file not found\nENOENT happened here';
  const payload = {
    fileName: 'debug.md',
    filePath: '/Users/tester/docs/debug.md',
    fileType: 'markdown',
    content: markdownText,
  };

  const previousDocument = globalThis.document;
  globalThis.document = { getElementById: () => null };

  try {
    const controller = createMarkdownController({
      callTool: async () => ({
        structuredContent: {
          fileName: payload.fileName,
          filePath: payload.filePath,
          fileType: payload.fileType,
        },
        content: [{ type: 'text', text: markdownText }],
      }),
      getAvailableDisplayModes: () => ['inline', 'fullscreen'],
      getCurrentDisplayMode: () => 'inline',
      getCurrentPayload: () => payload,
      setExpanded: () => {},
      storePayloadOverride: () => {},
      rerender: () => {},
      updateSaveStatus: () => {},
    });

    const state = controller.getState(payload);
    await controller.refreshFromDisk(payload);

    assert.strictEqual(state.fileDeleted, false, 'Normal markdown contents should not mark the file as deleted');
  } finally {
    globalThis.document = previousDocument;
  }

  console.log('✓ refresh only treats actual tool errors as missing files');
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
    await testPartialDocumentBecomesNewEditBaseline();
    await testRefreshDoesNotMisclassifyMarkdownContentAsDeletion();
    await testFailedSaveResyncsEditBaseline();
    await testSuccessfulSaveResetsUndoBaseline();
    console.log('\n✅ Markdown preview tests passed!');
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTests().then((success) => {
    process.exit(success ? 0 : 1);
  }).catch((error) => {
    console.error('❌ Unhandled error:', error);
    process.exit(1);
  });
}
