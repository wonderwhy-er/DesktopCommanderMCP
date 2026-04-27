/**
 * Regression test for #437: markdown preview auto-save corrupts table/wikilink/tilde
 * content because the Tiptap+tiptap-markdown round-trip is lossy.
 *
 * The auto-save loop in src/ui/file-preview/src/markdown/controller.ts (line ~922,
 * onChange -> scheduleAutosave) reads `getTiptapMarkdown()` from the editor and
 * diffs it against `state.fullDocumentContent`. Any drift introduced by the
 * parse-and-reserialize round trip becomes an `edit_block` call that silently
 * overwrites the user's file.
 *
 * This test mounts the *exact* editor configuration used in
 * src/ui/file-preview/src/markdown/editor.ts (mountMarkdownEditor) and verifies
 * that round-tripping common markdown features through it is stable. It fails on
 * the current implementation because:
 *   - GFM pipe tables collapse (no Table node in StarterKit) -> "AB12"
 *   - `~` is escaped to `\~` (prosemirror-markdown strikethrough escaping)
 *   - Adjacent block-level elements gain blank-line separators
 *   - Trailing newline is stripped
 *
 * Requires `jsdom` as a devDependency (added to package.json by this PR).
 */

import assert from 'assert';
import { JSDOM } from 'jsdom';

// Bootstrap a DOM that Tiptap can mount into. Must run before importing tiptap.
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.DOMParser = dom.window.DOMParser;
globalThis.getComputedStyle = dom.window.getComputedStyle;

const { Editor } = await import('@tiptap/core');
const StarterKit = (await import('@tiptap/starter-kit')).default;
const Image = (await import('@tiptap/extension-image')).default;
const { Markdown } = await import('tiptap-markdown');
const editorMod = await import('../dist/ui/file-preview/src/markdown/editor.js');
const { rewriteWikiLinks, restoreWikiLinks } = await import(
  '../dist/ui/file-preview/src/markdown/linking.js'
);

/**
 * Use the production round-trip path. Any wrapper / extension / serializer
 * change in editor.ts is automatically exercised here, so this test stays
 * a faithful regression suite as the implementation evolves.
 */
function roundTrip(input) {
  return editorMod.roundTripMarkdown(input);
}

async function testPipeTableSurvivesRoundTrip() {
  console.log('\n--- Test: GFM pipe table survives editor round-trip ---');
  const input = '# Test\n\n| A | B |\n|---|---|\n| 1 | 2 |\n';
  const output = roundTrip(input);
  assert.strictEqual(
    output,
    input,
    'pipe table should not collapse into "AB12" — auto-save would write that to disk'
  );
  console.log('OK pipe table preserved');
}

async function testTildeIsNotEscaped() {
  console.log('\n--- Test: literal "~" is not escaped to "\\~" ---');
  const input = 'Use ~ to negate.\n';
  const output = roundTrip(input);
  assert.strictEqual(
    output,
    input,
    'tilde should not gain a backslash escape on round-trip'
  );
  console.log('OK tilde preserved');
}

async function testAdjacentHeadingsKeepOriginalSpacing() {
  console.log('\n--- Test: adjacent block-level elements keep original spacing ---');
  const input = '### Heading One\nBody.\n### Heading Two\nMore.\n';
  const output = roundTrip(input);
  assert.strictEqual(
    output,
    input,
    'serializer should not insert blank lines between blocks the user did not author'
  );
  console.log('OK block spacing preserved');
}

async function testWikilinkSurvivesRoundTrip() {
  console.log('\n--- Test: wikilink round-trips through editor ---');
  const input = '# Test\nSee [[Other Note]].\n';
  const output = roundTrip(input);
  assert.strictEqual(
    output,
    input,
    'wikilink + heading + body should round-trip identically'
  );
  console.log('OK wikilink preserved');
}

async function testTrailingNewlineSurvives() {
  console.log('\n--- Test: trailing newline is preserved ---');
  const input = 'A single paragraph.\n';
  const output = roundTrip(input);
  assert.strictEqual(
    output,
    input,
    'trailing newline must not be stripped — POSIX text files are expected to end with one'
  );
  console.log('OK trailing newline preserved');
}

async function testCombinedBugReportFile() {
  console.log('\n--- Test: bug-report combined fixture ---');
  const input = '# Test\nSee [[Other Note]].\n\n| A | B |\n|---|---|\n| 1 | 2 |\n';
  const output = roundTrip(input);
  assert.strictEqual(
    output,
    input,
    'the exact fixture from issue #437 should not drift on round-trip'
  );
  console.log('OK combined fixture preserved');
}


async function testYamlFrontmatterSurvives() {
  console.log('\n--- Test: YAML frontmatter survives round-trip (#437 LevionLaurion, #440) ---');
  const input = '---\ntitle: My Note\ntags: [a, b]\ndescription: A test file\n---\n\n# Body\n\nContent here.\n';
  const output = roundTrip(input);
  assert.strictEqual(
    output,
    input,
    'YAML frontmatter delimited by --- must not be parsed as a Setext heading'
  );
  console.log('OK frontmatter preserved');
}

async function testSquareBracketsNotEscaped() {
  console.log('\n--- Test: square brackets not escaped (#440) ---');
  const input = '- [x] task done\n- [ ] task todo\n';
  const output = roundTrip(input);
  assert.strictEqual(
    output,
    input,
    'GFM task list brackets [x] [ ] should not be escaped to \\[x\\]'
  );
  console.log('OK brackets preserved');
}

async function testUnderscoresNotEscaped() {
  console.log('\n--- Test: underscores in identifiers not escaped (#440) ---');
  const input = 'Use the my_variable_name in code, plus snake_case_func().\n';
  const output = roundTrip(input);
  assert.strictEqual(
    output,
    input,
    'Bare underscores in identifiers must not be escaped to \\_'
  );
  console.log('OK underscores preserved');
}

async function testTildePathNotEscaped() {
  console.log('\n--- Test: tilde paths (~/foo) not escaped (#440) ---');
  const input = 'Open ~/Documents/notes.md to continue.\n';
  const output = roundTrip(input);
  assert.strictEqual(
    output,
    input,
    'Path-style ~/path must not be escaped to \\~/path'
  );
  console.log('OK tilde-path preserved');
}

async function testFrontmatterListItem() {
  console.log('\n--- Test: list with blank lines between items (#440) ---');
  const input = '- first item\n\n- second item\n\n- third item\n';
  const output = roundTrip(input);
  assert.strictEqual(
    output,
    input,
    'Blank lines between list items (loose list) must not be stripped'
  );
  console.log('OK loose list preserved');
}


async function testCrlfPreserved() {
  console.log('\n--- Test: CRLF line endings preserved (related to #97/#438) ---');
  // The Tiptap pipeline operates on strings; the file-preview UI seeds itself
  // with content from read_file's text response, which is already LF-normalized
  // by TextFileHandler (PR #438 fixes that upstream). But if a CRLF file
  // somehow reaches this layer with CRLF intact, the round-trip should not
  // silently downgrade to LF.
  const input = '# Heading\r\nFirst line.\r\nSecond line.\r\n';
  const output = roundTrip(input);
  assert.strictEqual(
    output,
    input,
    'CRLF line endings must not be silently converted to LF on round-trip'
  );
  console.log('OK CRLF preserved');
}


async function testReadmeStyleFileNotCollapsed() {
  console.log('\n--- Test: README-style file not collapsed by Tiptap (issue #437 in-the-wild reproduction) ---');
  // This mirrors a real corruption captured by another Claude session: a 200+ line
  // README with mixed markdown (headings, tables, code blocks, lists) was reduced
  // to ~22 lines after a single edit_block call. The file-preview UI mounts on
  // edit_block (server.ts:788), the editor parses the file via tiptap-markdown,
  // and the lossy reserialization combined with computeEditBlocks' >70% threshold
  // (controller.ts:155-158) emits a single edit_block that replaces the entire
  // file with the structurally-degraded version.
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
  // We are asserting two things: structure-preservation AND non-collapse.
  // If output is dramatically shorter than input, the >70% threshold in
  // computeEditBlocks would write a single full-file replacement.
  const inputLines = input.split('\n').length;
  const outputLines = output.split('\n').length;
  const ratio = outputLines / inputLines;
  if (ratio < 0.5) {
    throw new Error(
      'output collapsed from ' + inputLines + ' to ' + outputLines +
      ' lines (ratio ' + ratio.toFixed(2) + '). The >70% threshold in ' +
      'computeEditBlocks would emit a single edit_block that replaces the entire file ' +
      'with this degraded version.'
    );
  }
  assert.strictEqual(
    output,
    input,
    'README-style file with table+code+lists must round-trip unchanged'
  );
  console.log('OK README-style file preserved');
}

async function testTableInsideRealisticDoc() {
  console.log('\n--- Test: pipe table embedded in realistic doc does not erase neighbors ---');
  // Captures the specific failure mode: a table in the middle of a document
  // collapses, and the collapse takes adjacent prose with it because the >70%
  // line-change threshold trips on a single bad block.
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
  // Specific assertion: text outside the table must survive
  if (!output.includes('Section A') || !output.includes('Section B') ||
      !output.includes('Final line of the document') ||
      !output.includes('Prose paragraph one')) {
    throw new Error(
      'lost prose around the table. Output was:\n' + output
    );
  }
  assert.strictEqual(
    output,
    input,
    'realistic doc with table+prose must round-trip unchanged'
  );
  console.log('OK realistic doc preserved');
}

async function testBareUrlNotAutoLinked() {
  console.log('\n--- Test: bare URL not wrapped in autolink brackets (best-value-ai #1) ---');
  // Captured from /Users/eduardsruzga/work/best-value-ai/README.md.
  // Tiptap with `linkify: true` autolinks bare URLs and the serializer
  // emits them as `<https://...>` even when the source had no brackets.
  const input = '🔗 **Live tool:** https://desktopcommander.app/best-value-ai/\n';
  const output = roundTrip(input);
  assert.strictEqual(
    output,
    input,
    'a bare URL in prose should NOT be wrapped in <…> autolink brackets on round-trip'
  );
  console.log('OK bare URL preserved');
}

async function testEmojiPrefixedSoftBreaksRestored() {
  console.log('\n--- Test: 3 consecutive emoji-prefixed lines stay separate (best-value-ai #2) ---');
  // Captured from the same README. Three lines, each ending with a soft
  // break, each starting with an emoji. Tiptap-with-`breaks:false` parses
  // them as one paragraph and serializes them concatenated. restoreSoftBreaks
  // currently only repairs pairs; this is a triple.
  const input =
    '🔗 **Live tool:** desktopcommander.app/best-value-ai/\n' +
    '📖 **Article:** [Local LLMs Beat Cloud](https://example.com/x)\n' +
    '🏠 **Supported by:** [Desktop Commander](https://desktopcommander.app)\n';
  const output = roundTrip(input);
  assert.strictEqual(
    output,
    input,
    'three consecutive prose lines must stay on three lines, not collapse into one'
  );
  console.log('OK emoji-prefixed soft breaks preserved');
}

async function testLinkInTableCellSurvivesRoundTrip() {
  console.log('\n--- Test: backtick-text link inside a table cell (best-value-ai #3) ---');
  // From the same README's "data files" table. tiptap-markdown drops the
  // surrounding `[…](url)` wrapping when the link text is inline code
  // (backticks) and the link sits inside a table cell — leaving just the
  // backticked text and erasing the URL.
  const input =
    '| File | URL |\n' +
    '|------|-----|\n' +
    '| Models | [`models.json`](https://example.com/models.json) |\n';
  const output = roundTrip(input);
  assert.strictEqual(
    output,
    input,
    'a [\\`code\\`](url) link inside a table cell must NOT lose its URL on round-trip'
  );
  console.log('OK link-in-cell preserved');
}

async function testStarBulletMarkerPreserved() {
  console.log('\n--- Test: `*` bullet marker preserved (best-value-ai #4) ---');
  // tiptap-markdown's `bulletListMarker: '-'` config rewrites every
  // bullet to `- ` regardless of what the source used. `*` is equally
  // valid CommonMark and should be preserved.
  const input =
    '* First item\n' +
    '* Second item\n' +
    '* Third item\n';
  const output = roundTrip(input);
  assert.strictEqual(
    output,
    input,
    '`*` bullet markers should be preserved when the source used them'
  );
  console.log('OK star bullet marker preserved');
}

async function testRelativePathLinksSurvive() {
  console.log('\n--- Test: links to relative paths survive (skill-files batch) ---');
  // From SKILL.md files in ~/.desktop-commander/skills/. Tiptap's link
  // extension validates URLs against a scheme/relative-prefix list and
  // SILENTLY DROPS links whose URL is a bare relative path with `/`
  // (`scripts/foo.mjs`). Single-segment paths (`foo.md`) survive, but
  // anything in a subdirectory does not.
  //
  // This is the most common corruption mode in real skill files because
  // they routinely link to scripts/ and references/ from SKILL.md.
  const input =
    '- [init-skill.mjs](scripts/init-skill.mjs) — Scaffold new skills\n' +
    '- [validate-skill.mjs](scripts/validate-skill.mjs) — Validate structure\n' +
    '- [Output Format](references/output-format.md) — Final structure\n' +
    '- [Section](references/output-format.md#anchor) — With fragment\n';
  const output = roundTrip(input);
  assert.strictEqual(
    output,
    input,
    'links to relative paths in subdirectories must keep their URL on round-trip'
  );
  console.log('OK relative-path links preserved');
}

async function testLessThanInProseNotEscaped() {
  console.log('\n--- Test: literal `<` in prose not converted to &lt; (skill-files batch) ---');
  // From bigquery-cli.md and skill-creator.md. Tiptap's HTML output path
  // HTML-escapes bare `<` in prose because the character could in theory
  // open a tag. tiptap-markdown then serialises the entity literally so
  // `< $0.01` round-trips as `&lt; $0.01`.
  //
  // CommonMark's rule is that `<` only opens a tag when followed by an
  // ASCII letter, slash, `?` or `!`. Followed by space / digit / dollar
  // it's just a less-than sign. We can safely undo the escape in those
  // positions on output.
  const input =
    '| Cost | Verdict |\n' +
    '|---|---|\n' +
    '| < $0.01 (< 2 GB) | Safe |\n' +
    '\n' +
    'Use this when <2k tokens are expected.\n';
  const output = roundTrip(input);
  assert.strictEqual(
    output,
    input,
    '`<` followed by space / digit / `$` in prose must NOT become `&lt;` on round-trip'
  );
  console.log('OK literal `<` preserved');
}

async function testTrailingHardBreakWhitespacePreserved() {
  console.log('\n--- Test: trailing two-space hard break preserved (skill-files batch) ---');
  // From replicate-api.md. Two trailing spaces at the end of a line is
  // CommonMark hard-break syntax. Tiptap's serializer drops the trailing
  // whitespace entirely.
  //
  // Round-trip wants the source bytes back unchanged regardless of
  // whether the user intended a hard break or just had stray spaces.
  const input =
    '- `right` - Original on right, expand left  \n' +
    '- `left` - Original on left, expand right\n';
  const output = roundTrip(input);
  assert.strictEqual(
    output,
    input,
    'trailing two-space hard-break syntax must survive round-trip'
  );
  console.log('OK trailing hard-break whitespace preserved');
}

async function testBoldAroundInlineCodePreserved() {
  console.log('\n--- Test: **bold around `code`** preserved (skill-files batch) ---');
  // From sentry-posthog-replay-triage.md. ProseMirror's flat-mark schema
  // can't represent a single bold span that wraps inline code; Tiptap
  // re-shapes the construct in non-obvious ways:
  //
  //   `**`x`**`                  → `\`x\``  (bold dropped)
  //   `**\`x\` + \`y\`**`        → `\`x\` **+** \`y\``  (bold around `+`)
  //   `**Key in \`x\`:**`        → `**Key in** \`x\`**:**`  (bold split)
  //
  // The cleanest fix is the placeholder trick: detect bold-around-code
  // patterns at preprocess and substitute an opaque placeholder.
  const input =
    '- **`tags.app_version`** — DC app version\n' +
    '- **`contexts.os.name` + `contexts.os.version`** — OS\n' +
    '- **Key columns in `chat_message`:** `role`, `parts`\n';
  const output = roundTrip(input);
  assert.strictEqual(
    output,
    input,
    '`**…`code`…**` constructs must round-trip without bold being shifted'
  );
  console.log('OK bold-around-code preserved');
}

async function testEscapedPipeInTableCellPreserved() {
  console.log('\n--- Test: \\| inside a table cell is preserved (skill-files batch) ---');
  // From skill-creator.md. Users manually escape `|` as `\|` inside
  // table cells when the cell content (e.g. a Mermaid edge label or a
  // shell pipeline in inline code) needs literal pipes — the bare `|`
  // would otherwise split the cell.
  //
  // Tiptap's serializer unescapes them, so the source `\|` round-trips
  // as `|`, which then changes the table structure on the next parse.
  const input =
    '| Issue | Example |\n' +
    '|---|---|\n' +
    '| Quotes in labels | `A -->\\|Click "Sign in"\\| B` |\n' +
    '| Literal newline | `A -->\\|Line1\\nLine2\\| B` |\n';
  const output = roundTrip(input);
  assert.strictEqual(
    output,
    input,
    '`\\|` inside a table cell must NOT become a bare `|` on round-trip'
  );
  console.log('OK escaped pipe preserved');
}

async function testListItemWithContinuationLine() {
  console.log('\n--- Test: list item with two-space indented continuation line preserved ---');
  // From sentry-posthog-replay-triage.md. List items with continuation
  // prose on the next line (2-space indent) get the continuation
  // absorbed into the bullet on round-trip. The continuation line is
  // CommonMark "lazy continuation" — same paragraph as the list item,
  // but the source convention is to keep them on separate lines.
  const input =
    '- First item with explanation\n' +
    '  continuation line.\n' +
    '- Second item with explanation\n' +
    '  another continuation.\n';
  const output = roundTrip(input);
  assert.strictEqual(
    output,
    input,
    'list items with 2-space indented continuation lines must keep the line break'
  );
  console.log('OK list item continuation preserved');
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
    testFrontmatterListItem,
    testCrlfPreserved,
    testReadmeStyleFileNotCollapsed,
    testTableInsideRealisticDoc,
    testBareUrlNotAutoLinked,
    testEmojiPrefixedSoftBreaksRestored,
    testLinkInTableCellSurvivesRoundTrip,
    testStarBulletMarkerPreserved,
    testRelativePathLinksSurvive,
    testLessThanInProseNotEscaped,
    testTrailingHardBreakWhitespacePreserved,
    testBoldAroundInlineCodePreserved,
    testEscapedPipeInTableCellPreserved,
    testListItemWithContinuationLine,
  ];
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t();
      passed++;
    } catch (err) {
      failed++;
      console.error('FAIL ' + t.name);
      console.error('  ' + err.message);
    }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) {
    process.exit(1);
  }
}

runAllTests();
