/**
 * Realistic edit-diff regression test for the markdown editor (#437/#440).
 *
 * The strict round-trip suite in test-markdown-editor-roundtrip.js asserts
 * that an UNTOUCHED document survives mount->getMarkdown() byte-for-byte.
 * That's the worst case for Tiptap, because it punishes any whitespace /
 * escape normalization the parser applies, even normalization a real user
 * would never notice.
 *
 * What actually matters in production is what the autosave loop in
 * controller.ts:scheduleAutosave does: it diffs `getMarkdown()` against
 * `state.fullDocumentContent` and emits `edit_block` calls for the diff.
 * If the diff is just the user's actual edit, the file is safe. If Tiptap
 * also normalizes 47 unrelated lines, those edit_blocks corrupt the file.
 *
 * This suite measures the *collateral damage* an edit produces:
 *   1. A whole-file rewrite (>=70% lines changed) is catastrophic — that's
 *      the path computeEditBlocks takes when too much of the document
 *      drifts. We assert this NEVER fires for a small user edit.
 *   2. The number of edit-block hunks should be small — ideally 1 (just
 *      the user's edit). Tolerated up to 3 to account for trivial Tiptap
 *      normalization at the boundaries.
 *   3. The user's actual change must appear in exactly one hunk and the
 *      surrounding text must be unmangled.
 */

import assert from 'assert';
import { JSDOM } from 'jsdom';

// jsdom for Tiptap to mount into.
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.DOMParser = dom.window.DOMParser;
globalThis.getComputedStyle = dom.window.getComputedStyle;
// Tiptap's focus() calls requestAnimationFrame which jsdom doesn't ship
// by default. Stub with a synchronous no-op — we don't need real focus
// behaviour for these tests.
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const { Editor } = await import('@tiptap/core');
const editorMod = await import('../dist/ui/file-preview/src/markdown/editor.js');
const controllerMod = await import('../dist/ui/file-preview/src/markdown/controller.js');
const { preprocessForEditor, applyPostProcess, buildTiptapExtensions } = editorMod;
const { computeEditBlocks } = controllerMod;

/**
 * Mount the editor exactly as production does, return a handle that lets
 * the test:
 *   - apply a synthetic edit (insert text at a position, simulating typing)
 *   - read getMarkdown() through the production post-process pipeline
 *   - tear down cleanly
 */
function mountForEdit(input) {
  const target = document.getElementById('root');
  target.innerHTML = '';
  const { editorInput, context } = preprocessForEditor(input);
  const editor = new Editor({
    element: target,
    extensions: buildTiptapExtensions(),
    content: editorInput,
  });
  return {
    editor,
    /** Insert plain text at a ProseMirror doc position (simulates typing). */
    insertAt(pos, text) {
      editor.chain().focus().insertContentAt(pos, text).run();
    },
    /** Replace a text fragment in the document. Searches by visible text
     *  content; if the search string isn't found verbatim (e.g. it spans
     *  inline-code boundaries), falls back to the longest matching prefix. */
    replaceText(find, replace) {
      // Build the full visible text by concatenating all text nodes.
      // Track each text node's visible-text offset so we can map back.
      const segments = [];
      let visibleText = '';
      editor.state.doc.descendants((node, nodePos) => {
        if (node.isText) {
          segments.push({ pos: nodePos, text: node.text, start: visibleText.length });
          visibleText += node.text;
        }
        return true;
      });
      let idx = visibleText.indexOf(find);
      let matchLen = find.length;
      if (idx === -1) {
        // Try a relaxed match: drop punctuation characters that would
        // render via separate ProseMirror inline marks (backticks, etc.)
        const stripped = find.replace(/`/g, '');
        idx = visibleText.indexOf(stripped);
        if (idx === -1) {
          throw new Error(`replaceText: didn't find ${JSON.stringify(find)} (also tried ${JSON.stringify(stripped)})`);
        }
        matchLen = stripped.length;
      }
      // Map visible-text offset back to a ProseMirror position by
      // walking the segments.
      let from = -1;
      for (const seg of segments) {
        if (seg.start + seg.text.length > idx) {
          from = seg.pos + (idx - seg.start);
          break;
        }
      }
      if (from === -1) throw new Error('replaceText: position not found');
      editor.chain().focus().insertContentAt({ from, to: from + matchLen }, replace).run();
    },
    getMarkdown() {
      const storage = editor.storage;
      return applyPostProcess(storage.markdown?.getMarkdown() ?? '', context);
    },
    destroy() {
      editor.destroy();
    },
  };
}

let passed = 0;
let failed = 0;
function pass(name) { console.log('OK  ', name); passed++; }
function fail(name, detail) { console.log('FAIL', name); if (detail) console.log('     ', detail); failed++; }

/**
 * Core invariants we want every edit to obey.
 *
 * @param name human-readable test name
 * @param input the original markdown
 * @param edit (handle) => void — perform the synthetic edit on the editor
 * @param expectedSubstring — text we expect to find in the post-edit doc
 */
function assertEditDiffIsClean(name, input, edit, expectedSubstring) {
  const handle = mountForEdit(input);
  edit(handle);
  const after = handle.getMarkdown();
  handle.destroy();

  // 1. The user's edit must actually be in the output.
  if (!after.includes(expectedSubstring)) {
    return fail(name, `expected substring not in output: ${JSON.stringify(expectedSubstring)}`);
  }

  // 2. computeEditBlocks should not emit a whole-document rewrite.
  const oldLines = input.split('\n');
  const newLines = after.split('\n');
  const hunks = computeEditBlocks(input, after);

  if (hunks.length === 1) {
    const hunk = hunks[0];
    // Whole-file rewrite signature: old_string covers the entire input.
    if (hunk.old_string === input && hunk.new_string === after) {
      return fail(name, `WHOLE-FILE REWRITE — autosave would replace the entire document`);
    }
  }

  // 3. The number of hunks should be small. >3 means Tiptap is normalising
  //    multiple regions the user didn't touch.
  if (hunks.length > 3) {
    diagnoseDiff(input, after, hunks);
    return fail(name, `${hunks.length} hunks (>3); Tiptap is normalising unrelated regions`);
  }

  // 4. Total lines changed should be small relative to file size. Bound
  //    at 20% — anything bigger is collateral damage, not a real edit.
  const linesChanged = Math.abs(newLines.length - oldLines.length)
    + countDifferingLines(oldLines, newLines);
  if (oldLines.length > 0 && linesChanged / oldLines.length > 0.2) {
    diagnoseDiff(input, after, hunks);
    return fail(name,
      `${linesChanged} of ${oldLines.length} lines differ (>20%) for what should be a small edit`);
  }

  pass(`${name} (${hunks.length} hunk${hunks.length === 1 ? '' : 's'}, ${linesChanged} lines changed)`);
}

/** Print a compact summary of the diff so we can see what Tiptap is changing. */
function diagnoseDiff(before, after, hunks) {
  console.log('     hunks:', hunks.length);
  for (const [i, h] of hunks.entries()) {
    console.log(`     [${i}] OLD:`);
    for (const line of h.old_string.split('\n').slice(0, 8)) {
      console.log(`         ${JSON.stringify(line)}`);
    }
    console.log(`         NEW:`);
    for (const line of h.new_string.split('\n').slice(0, 8)) {
      console.log(`         ${JSON.stringify(line)}`);
    }
  }
}

function countDifferingLines(a, b) {
  // Cheap upper-bound on different lines: count positions where lines
  // disagree, allowing for length differences.
  let diff = 0;
  const min = Math.min(a.length, b.length);
  for (let i = 0; i < min; i += 1) {
    if (a[i] !== b[i]) diff += 1;
  }
  return diff;
}

const README = `# My Project

A short intro paragraph explaining what the project does.

## Installation

Install with the package manager:

\`\`\`bash
npm install my-project
\`\`\`

Then verify it works:

\`\`\`bash
my-project --version
\`\`\`

## Usage

The CLI accepts a few flags:

| Flag | Description | Default |
|---|---|---|
| \`--input\` | Input file | stdin |
| \`--output\` | Output file | stdout |
| \`--verbose\` | Verbose logs | false |

Run it like this:

\`\`\`bash
my-project --input data.json --output result.json
\`\`\`

## Development

To set up locally:

- Clone the repo
- Run \`npm install\`
- Run \`npm test\`

PRs welcome — please \`fork\` and submit against \`main\`.

## License

MIT.
`;

// --- Test 1: append a sentence to an existing paragraph ---
assertEditDiffIsClean(
  'append text to an existing paragraph',
  README,
  (h) => h.replaceText('A short intro paragraph explaining what the project does.',
    'A short intro paragraph explaining what the project does. New sentence added.'),
  'New sentence added.',
);

// --- Test 2: edit a heading (search by visible text — the rendered
//     heading is just "Usage", without the leading `## `) ---
assertEditDiffIsClean(
  'rename a heading',
  README,
  (h) => h.replaceText('Usage', 'How to use'),
  '## How to use',
);

// --- Test 3: append a new bullet at the end of an existing list. The
//     visible text for ``Run `npm test`'' is "Run npm test" — backticks
//     are inline-code mark boundaries, not part of the text. ---
assertEditDiffIsClean(
  'append a bullet to a list',
  README,
  (h) => h.replaceText('Run npm test', 'Run npm test\nRun npm run lint'),
  'npm run lint',
);

// --- Test 4: edit a single word in a paragraph ---
assertEditDiffIsClean(
  'fix a typo',
  README,
  (h) => h.replaceText('PRs welcome', 'PRs are welcome'),
  'PRs are welcome',
);

// --- Test 5: leave the file completely unchanged (no edit) ---
{
  const handle = mountForEdit(README);
  const after = handle.getMarkdown();
  handle.destroy();
  const hunks = computeEditBlocks(README, after);
  if (hunks.length === 0) {
    pass('no edit -> no hunks');
  } else if (hunks.length === 1 && hunks[0].old_string === README && hunks[0].new_string === after) {
    fail('no edit -> no hunks',
      `WHOLE-FILE REWRITE on an untouched file — Tiptap normalised the whole document`);
  } else {
    diagnoseDiff(README, after, hunks);
    fail('no edit -> no hunks',
      `expected 0 hunks for an untouched file, got ${hunks.length}`);
  }
}

// --- Test 6: edits to a document with frontmatter + wikilinks + tasks ---
const COMPLEX = `---
title: Notes
tags: [project, journal]
---

# Daily Log

See [[Project Roadmap]] for context.

## Tasks

- [x] Land the round-trip fix
- [ ] Write up the design doc
- [ ] Get review

## Progress

| Day | Focus | Notes |
|---|---|---|
| Mon | research | found root cause |
| Tue | implementation | wrappers + extensions |
| Wed | testing | 12/14 passing |

That's the week.
`;

assertEditDiffIsClean(
  'edit a paragraph in a doc with frontmatter + wikilinks + tasks + table',
  COMPLEX,
  (h) => h.replaceText("That's the week.", "That's the week. More to come."),
  'More to come.',
);

// Check that the no-edit case for the complex doc is also clean.
{
  const handle = mountForEdit(COMPLEX);
  const after = handle.getMarkdown();
  handle.destroy();
  const hunks = computeEditBlocks(COMPLEX, after);
  if (hunks.length === 0) {
    pass('no edit on complex doc -> no hunks');
  } else {
    diagnoseDiff(COMPLEX, after, hunks);
    fail('no edit on complex doc -> no hunks',
      `expected 0 hunks for an untouched complex doc, got ${hunks.length}`);
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
