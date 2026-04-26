import assert from 'assert';
import { pathToFileURL } from 'url';

import { resolveMarkdownLink } from '../dist/ui/file-preview/src/markdown/linking.js';
import { extractMarkdownOutline } from '../dist/ui/file-preview/src/markdown/outline.js';
import { renderMarkdownEditorShell } from '../dist/ui/file-preview/src/markdown/editor.js';
import { createMarkdownController } from '../dist/ui/file-preview/src/markdown/controller.js';
import { createSlugTracker, slugifyMarkdownHeading } from '../dist/ui/file-preview/src/markdown/slugify.js';
import { getDocumentFullscreenAvailability, shouldAutoLoadDocumentOnEnterFullscreen } from '../dist/ui/file-preview/src/document-workspace.js';

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

async function testOutlineFromMarkdownSource() {
  console.log('\n--- Test 4: source-backed outline text ---');

  const outline = extractMarkdownOutline([
    '# Title',
    '## Details',
    '## Details',
    '',
    '### Linked [Section](#details)',
  ].join('\n'));

  assert.deepStrictEqual(
    outline.map((item) => ({ id: item.id, text: item.text, level: item.level })),
    [
      { id: 'title', text: 'Title', level: 1 },
      { id: 'details', text: 'Details', level: 2 },
      { id: 'details-2', text: 'Details', level: 2 },
      { id: 'linked-section', text: 'Linked Section', level: 3 },
    ],
  );

  console.log('✓ outline text strips inline markdown and dedupes heading slugs');
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
          // See Test 12 for why structuredContent is required in the mock.
          return {
            content: [{ type: 'text', text: 'Successfully applied 1 edit to notes.md' }],
            structuredContent: {
              fileName: payload.fileName,
              filePath: payload.filePath,
              fileType: payload.fileType,
            },
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
    assert.ok(state.error?.includes('changed on disk'), 'The error should explain that the file changed on disk');
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

        // Successful edit_block returns carry structuredContent with
        // fileName/filePath/fileType (per commit 8fd8f94). The client's
        // assertSuccessfulEditBlockResult now uses its presence as the
        // success signal, so the mock has to match that contract.
        return {
          content: [{ type: 'text', text: 'Successfully applied 1 edit(s) to notes.md' }],
          structuredContent: {
            fileName: payload.fileName,
            filePath: payload.filePath,
            fileType: payload.fileType,
          },
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

async function testInFlightSaveKeepsNewerDraftDirty() {
  console.log('\n--- Test 13: in-flight saves keep newer drafts dirty ---');

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

  let resolveEditBlock;
  let savedString = null;

  const controller = createMarkdownController({
    callTool: async (name, args) => {
      if (name !== 'edit_block') {
        throw new Error(`Unexpected tool call: ${name}`);
      }
      savedString = args.new_string;
      await new Promise((resolve) => {
        resolveEditBlock = resolve;
      });
      return {
        content: [{ type: 'text', text: 'Successfully applied 1 edit(s) to notes.md' }],
        structuredContent: {
          fileName: payload.fileName,
          filePath: payload.filePath,
          fileType: payload.fileType,
        },
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

  try {
    const state = controller.getState(payload);
    state.draftContent = 'beta\n';
    state.dirty = true;

    const savePromise = controller.saveDocument();
    await new Promise((resolve) => setTimeout(resolve, 0));

    state.draftContent = 'gamma\n';
    state.dirty = true;
    resolveEditBlock();
    await savePromise;

    assert.strictEqual(savedString, 'beta\n', 'The in-flight save should write the original save snapshot');
    assert.strictEqual(state.fullDocumentContent, 'beta\n', 'The saved snapshot should become the disk baseline');
    assert.strictEqual(state.draftContent, 'gamma\n', 'Newer local edits should remain in the draft');
    assert.strictEqual(state.dirty, true, 'Newer local edits should stay dirty after the older save completes');
  } finally {
    controller.disposeHandles();
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }

  console.log('✓ in-flight saves keep newer local edits dirty');
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

async function testCopyFormatsAndEditorShell() {
  console.log('\n--- Test 8: copy formats and editor shell ---');

  const copySource = '# Title\n\n- First\n- Second\n\n**Bold** text';
  const controller = createMarkdownController({
    getAvailableDisplayModes: () => ['inline', 'fullscreen'],
    getCurrentDisplayMode: () => 'inline',
    getCurrentPayload: () => undefined,
    setExpanded: () => {},
    storePayloadOverride: () => {},
    rerender: () => {},
    updateSaveStatus: () => {},
  });
  assert.strictEqual(controller.getCopyText({
    fileName: 'notes.md',
    filePath: '/Users/tester/docs/notes.md',
    fileType: 'markdown',
    content: copySource,
  }), copySource, 'Copy should preserve markdown source exactly');

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

  console.log('✓ source copy support and mode-specific editor shell are wired');
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
    await testOutlineFromMarkdownSource();
    await testFullscreenWorkspaceHelpers();
    await testCopyFormatsAndEditorShell();
    await testPartialDocumentBecomesNewEditBaseline();
    await testRefreshDoesNotMisclassifyMarkdownContentAsDeletion();
    await testFailedSaveResyncsEditBaseline();
    await testSuccessfulSaveResetsUndoBaseline();
    await testInFlightSaveKeepsNewerDraftDirty();
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
