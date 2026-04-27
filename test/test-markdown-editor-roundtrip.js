/**
 * Regression test for #437/#440: markdown editor round-trip stability.
 *
 * Originally written against the Tiptap+tiptap-markdown editor (0.2.39) which
 * round-tripped raw markdown through a ProseMirror document model and lost
 * structure on save. PR #442 replaces that editor with a source-backed
 * CodeMirror editor where getValue() === setValue input.
 *
 * This test mounts the actual mountMarkdownEditor exported by
 * src/ui/file-preview/src/markdown/editor.ts (built in dist/) and asserts that
 * for every fixture from #437 / #440 / #97 / a live in-the-wild corruption,
 * editor.getValue() === input.
 *
 * Pre-#442: every case fails (Tiptap drift writes corruptions back via
 * autosave).
 * Post-#442: every case must pass (raw markdown is canonical, no
 * parse-and-reserialize step exists).
 */

import assert from 'assert';
import { JSDOM } from 'jsdom';

// Bootstrap a DOM that CodeMirror can mount into. Must run before importing.
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.HTMLButtonElement = dom.window.HTMLButtonElement;
globalThis.HTMLSelectElement = dom.window.HTMLSelectElement;
globalThis.Node = dom.window.Node;
globalThis.Range = dom.window.Range;
globalThis.DOMParser = dom.window.DOMParser;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const { mountMarkdownEditor, renderMarkdownEditorShell } = await import(
  '../dist/ui/file-preview/src/markdown/editor.js'
);

function mountFor(value, view = 'markdown') {
  const root = document.getElementById('root');
  root.innerHTML = renderMarkdownEditorShell({ view });
  const target = root.querySelector('#markdown-editor-root');
  return mountMarkdownEditor({
    target,
    value,
    view,
    currentFilePath: '/tmp/test.md',
    onChange: () => {},
  });
}

function roundTrip(input, view = 'markdown') {
  const editor = mountFor(input, view);
  const out = editor.getValue();
  editor.destroy();
  return out;
}

// ---------------------------------------------------------------------------
// Fixtures: every case that was failing on the Tiptap implementation.
// ---------------------------------------------------------------------------

async function testPipeTableSurvivesRoundTrip() {
  const input = '# Test\n\n| A | B |\n|---|---|\n| 1 | 2 |\n';
  const output = roundTrip(input);
  assert.strictEqual(output, input, 'pipe table must not collapse to "AB12"');
}

async function testTildeIsNotEscaped() {
  const input = 'Use ~ to negate.\n';
  const output = roundTrip(input);
  assert.strictEqual(output, input, 'tilde must not gain a backslash escape');
}

async function testAdjacentHeadingsKeepOriginalSpacing() {
  const input = '### Heading One\nBody.\n### Heading Two\nMore.\n';
  const output = roundTrip(input);
  assert.strictEqual(output, input, 'block spacing must be preserved');
}

async function testWikilinkSurvivesRoundTrip() {
  const input = '# Test\nSee [[Other Note]].\n';
  const output = roundTrip(input);
  assert.strictEqual(output, input, 'wikilink + heading must round-trip identically');
}

async function testTrailingNewlineSurvives() {
  const input = 'A single paragraph.\n';
  const output = roundTrip(input);
  assert.strictEqual(output, input, 'trailing newline must not be stripped');
}

async function testCombinedBugReportFile() {
  const input = '# Test\nSee [[Other Note]].\n\n| A | B |\n|---|---|\n| 1 | 2 |\n';
  const output = roundTrip(input);
  assert.strictEqual(output, input, '#437 combined fixture must not drift');
}

async function testYamlFrontmatterSurvives() {
  const input = '---\ntitle: My Note\ntags: [a, b]\ndescription: A test file\n---\n\n# Body\n\nContent here.\n';
  const output = roundTrip(input);
  assert.strictEqual(output, input, 'YAML frontmatter must not be parsed as Setext heading');
}

async function testSquareBracketsNotEscaped() {
  const input = '- [x] task done\n- [ ] task todo\n';
  const output = roundTrip(input);
  assert.strictEqual(output, input, 'GFM task list brackets must not be escaped');
}

async function testUnderscoresNotEscaped() {
  const input = 'Use the my_variable_name in code, plus snake_case_func().\n';
  const output = roundTrip(input);
  assert.strictEqual(output, input, 'underscores in identifiers must not be escaped');
}

async function testTildePathNotEscaped() {
  const input = 'Open ~/Documents/notes.md to continue.\n';
  const output = roundTrip(input);
  assert.strictEqual(output, input, '~/path must not be escaped');
}

async function testLooseListPreserved() {
  const input = '- first item\n\n- second item\n\n- third item\n';
  const output = roundTrip(input);
  assert.strictEqual(output, input, 'loose-list blank lines must not be stripped');
}

async function testCrlfDocumentedBehaviour() {
  // CodeMirror's EditorState normalizes line endings to LF internally by
  // default — getValue() returns LF only. In practice the file-preview UI
  // is seeded from read_file's text response, which is already LF-normalized
  // upstream by TextFileHandler (PR #438 fixes that path), so this case
  // never fires through the normal flow.
  //
  // We document the behaviour here so that, if anyone wires up direct CRLF
  // input later (e.g. raw-mode preview of a Windows file), they know to
  // configure EditorState with an explicit lineSeparator and write-side
  // CRLF preservation.
  const input = '# Heading\r\nFirst line.\r\nSecond line.\r\n';
  const output = roundTrip(input);
  if (output === input) {
    return; // Future-proof: passes if CRLF support is added.
  }
  // Tolerate the LF-normalization but assert it is ONLY that — not the
  // structural drift the Tiptap pipeline used to introduce.
  const normalizedExpected = input.replace(/\r\n/g, '\n');
  assert.strictEqual(
    output,
    normalizedExpected,
    'CRLF normalization is permitted; structural drift is not'
  );
}

async function testReadmeStyleFileNotCollapsed() {
  // Mirrors a real corruption captured live: a 200+ line README with mixed
  // markdown was reduced to ~22 lines after a single edit_block call.
  const input = [
    '# My Project',
    '',
    'A short intro paragraph explaining what the project does.',
    '',
    '## Installation',
    '',
    '```bash',
    'npm install my-project',
    '```',
    '',
    '## Configuration',
    '',
    '| Variable | Default | Description |',
    '|---|---|---|',
    '| FOO | `bar` | The foo setting |',
    '| BAZ | `qux` | The baz setting |',
    '',
    '## Usage',
    '',
    '- First, run `npm start`',
    '- Then, open `http://localhost:3000`',
    '- Finally, press `Ctrl+C` to stop',
    '',
    'See [the docs](https://example.com) for more.',
    '',
  ].join('\n');
  const output = roundTrip(input);
  const inputLines = input.split('\n').length;
  const outputLines = output.split('\n').length;
  if (outputLines / inputLines < 0.5) {
    throw new Error(
      `output collapsed from ${inputLines} to ${outputLines} lines. The >70% threshold ` +
      `in computeEditBlocks would emit a single edit_block replacing the entire file.`
    );
  }
  assert.strictEqual(output, input, 'README-style file must round-trip unchanged');
}

async function testTableInsideRealisticDoc() {
  const input = [
    '# Section A',
    '',
    'Prose paragraph one with content.',
    'A second line of prose.',
    '',
    '## Comparison',
    '',
    '| Feature | A | B |',
    '|---|---|---|',
    '| Speed | fast | slow |',
    '| Cost | low | high |',
    '| Quality | good | bad |',
    '',
    '## Section B',
    '',
    'More prose after the table that must not be deleted.',
    'Final line of the document.',
    '',
  ].join('\n');
  const output = roundTrip(input);
  if (!output.includes('Section A') || !output.includes('Section B') ||
      !output.includes('Final line of the document') ||
      !output.includes('Prose paragraph one')) {
    throw new Error('lost prose around the table:\n' + output);
  }
  assert.strictEqual(output, input, 'realistic doc with embedded table must round-trip unchanged');
}

async function runAllTests() {
  const tests = [
    testPipeTableSurvivesRoundTrip,
    testTildeIsNotEscaped,
    testAdjacentHeadingsKeepOriginalSpacing,
    testWikilinkSurvivesRoundTrip,
    testTrailingNewlineSurvives,
    testCombinedBugReportFile,
    testYamlFrontmatterSurvives,
    testSquareBracketsNotEscaped,
    testUnderscoresNotEscaped,
    testTildePathNotEscaped,
    testLooseListPreserved,
    testCrlfDocumentedBehaviour,
    testReadmeStyleFileNotCollapsed,
    testTableInsideRealisticDoc,
  ];
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t();
      passed++;
      console.log(`OK   ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`FAIL ${t.name}`);
      console.error(`     ${err.message}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed (of ${tests.length})`);
  if (failed > 0) {
    process.exit(1);
  }
}

runAllTests();
