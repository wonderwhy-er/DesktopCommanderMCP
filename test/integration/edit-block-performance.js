/**
 * Integration/performance test for MCP-style large-file edit workflows.
 *
 * The test starts the real MCP server over stdio through the MCP SDK and simulates
 * concurrent AI/client workflows issuing entangled write_file/read_file/edit_block
 * tool calls. It is intentionally long-running and is gated behind
 * `npm run test:integration` rather than default `npm test`.
 */

import assert from 'assert';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { performance } from 'perf_hooks';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.dirname(path.dirname(__dirname));
const README_TEXT = await fs.readFile(path.join(PROJECT_ROOT, 'README.md'), 'utf8');
const README_LINES = README_TEXT
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('!['));
assert.ok(README_LINES.length > 0, 'README fixture source should contain usable text lines');

const TEST_DIR = path.join(__dirname, 'test_edit_block_performance');
const LARGE_FILE_LINES = 1500;
const READ_LINE_LIMIT = 200;
const PERFORMANCE_LIMITS_MS = {
  1: 10000,
  10: 30000,
  100: 120000,
  150: 120000,
  python150: 120000,
  pythonFuzzy25: 60000,
  docx40: 120000,
};
const RESPONSIVENESS_INTERVAL_MS = 1000;
const RESPONSIVENESS_MAX_LATENCY_MS = 5000;

// Fuzzy-scan event-loop regression: a deliberately slow fuzzy fallback (large
// file, large absent old_string) must not block concurrent pings. The general
// responsiveness probe above is too loose for this (5s limit); a synchronous
// scan blocks for ~3-4s and would slip under it, so this scenario pings on a
// tight interval with a strict latency ceiling.
const FUZZY_SCAN_FILE_MB = 2;
const FUZZY_SCAN_QUERY_KB = 8;
const FUZZY_SCAN_PING_INTERVAL_MS = 200;
const FUZZY_SCAN_MIN_PING_COUNT = 5;
const FUZZY_SCAN_MAX_PING_LATENCY_MS = 500;

function assertToolSuccess(result, message) {
  assert.strictEqual(result.content?.[0]?.type, 'text', `${message}: expected text response`);
  assert.ok(!result.isError, `${message}: should not be marked as an error`);
}

async function callTool(client, name, args) {
  return client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createLargeFileContent(workflowId, editCount) {
  const lines = [
    '# Desktop Commander MCP Large Edit Fixture',
    '',
    'This generated file mirrors README-style sections so edit_block has realistic markdown content.',
    `Workflow: ${workflowId}`,
    `Planned edits: ${editCount}`,
    '',
  ];

  for (let index = 1; index <= LARGE_FILE_LINES; index++) {
    const section = Math.ceil(index / 40);
    const readmeLine = getReadmeLine(index, workflowId);
    if (index % 40 === 1) {
      lines.push(`## Feature Section ${section}: ${readmeLine.replace(/^#+\s*/, '').slice(0, 90)}`);
    }

    if (index <= editCount) {
      lines.push(marker(workflowId, index, 'original'));
    } else {
      lines.push(`- README sample ${String(index).padStart(4, '0')}: ${readmeLine}`);
      if (index % 7 === 0) {
        lines.push(`  Context: ${getReadmeLine(index + 17, workflowId)}`);
      }
      if (index % 19 === 0) {
        lines.push(`  Note: ${getReadmeLine(index + 41, workflowId)}`);
      }
    }
  }

  lines.push('', '## End Of Fixture', 'All generated tool calls should complete without data loss.');
  return lines.join('\n');
}

function createLargePythonFileContent(workflowId, editCount) {
  const lines = [
    '# Generated Python fixture for Desktop Commander MCP edit_block performance tests',
    `WORKFLOW_ID = ${JSON.stringify(workflowId)}`,
    `PLANNED_EDITS = ${editCount}`,
    '',
    'def summarize_feature(name: str, enabled: bool) -> str:',
    '    status = "enabled" if enabled else "disabled"',
    '    return f"{name}: {status}"',
    '',
  ];

  for (let index = 1; index <= LARGE_FILE_LINES; index++) {
    if (index <= editCount) {
      lines.push(pythonMarker(workflowId, index, 'original'));
    } else {
      const summary = sanitizePythonString(getReadmeLine(index, workflowId));
      const detail = sanitizePythonString(getReadmeLine(index + 23, workflowId));
      lines.push(`def generated_function_${String(index).padStart(4, '0')}():`);
      lines.push(`    summary = "${summary}"`);
      lines.push(`    detail = "${detail}"`);
      lines.push(`    return summarize_feature(summary[:48] or "feature_${index}", ${index % 2 === 0 ? 'True' : 'False'}) + " | " + detail[:80]`);
      lines.push('');
    }
  }

  lines.push('if __name__ == "__main__":', '    print(summarize_feature("desktop_commander", True))');
  return lines.join('\n');
}

function createDocxFileContent(workflowId, editCount) {
  // Plain text; DocxFileHandler turns each line into a paragraph and lines
  // starting with # into headings. Marker text is kept alphanumeric so it is
  // not altered by XML escaping and maps to a single <w:t> element per line.
  const lines = ['# Desktop Commander MCP DOCX Edit Fixture'];
  for (let index = 1; index <= editCount; index++) {
    if (index % 10 === 1) {
      lines.push(`## Section ${Math.ceil(index / 10)}`);
    }
    lines.push(docxMarkerText(workflowId, index, 'original'));
  }
  return lines.join('\n');
}

function createFuzzyPythonFileContent(workflowId, exactTarget) {
  const lines = [
    '# Generated Python fuzzy fixture using varied README-derived text',
    exactTarget,
    '',
    'README_NOTES = [',
  ];

  for (let index = 1; index <= 500; index++) {
    lines.push(`    "${sanitizePythonString(getReadmeLine(index * 11, workflowId))}",`);
  }

  lines.push(']', '', 'def collect_notes():', '    return "\\n".join(README_NOTES)');
  return lines.join('\n');
}

function getText(result) {
  return result.content?.map((item) => item.text ?? '').join('\n') ?? '';
}

function marker(workflowId, editNumber, state) {
  return [
    `PERF_TARGET_${workflowId}_${editNumber}: ${state} edit block text ${editNumber} for workflow ${workflowId}`,
    `Context before: ${getReadmeLine(editNumber * 3, workflowId)}`,
    `Context after: ${getReadmeLine(editNumber * 3 + 1, workflowId)}`,
  ].join('\n');
}

function pythonMarker(workflowId, editNumber, state) {
  return [
    `PY_TARGET_${workflowId}_${editNumber} = {`,
    `    "state": "${state}",`,
    `    "workflow": "${workflowId}",`,
    `    "edit_number": ${editNumber},`,
    `    "readme_context": "${sanitizePythonString(getReadmeLine(editNumber * 5, workflowId))}",`,
    `    "next_context": "${sanitizePythonString(getReadmeLine(editNumber * 5 + 1, workflowId))}",`,
    `}`,
  ].join('\n');
}

function docxMarkerText(workflowId, editNumber, state) {
  return `DOCX_TARGET_${workflowId}_${editNumber}: ${state} edit block paragraph ${editNumber} for workflow ${workflowId}`;
}

// DocxFileHandler writes body paragraphs as <w:t xml:space="preserve">...</w:t>,
// and edit_block does find/replace on the pretty-printed document XML, so the
// edit targets that exact element wrapper rather than raw text.
function docxBodyElement(text) {
  return `<w:t xml:space="preserve">${text}</w:t>`;
}

function fuzzyPythonReportLine(workflowId, state) {
  return `unique_report_anchor_${workflowId.replace(/[^a-zA-Z0-9_]/g, '_')} = "${state}: Desktop Commander MCP handles files, commands, and edit blocks"`;
}

function getReadmeLine(index, salt) {
  const saltValue = Array.from(String(salt)).reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const mixedIndex = (index * 37 + saltValue * 13 + Math.floor(index / 11) * 17) % README_LINES.length;
  return README_LINES[mixedIndex];
}

function sanitizePythonString(value) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, 180);
}

function extractActualTextFromFuzzyDiff(resultText) {
  const diffMatch = resultText.match(/Differences:\n([\s\S]*?)\n\nTo replace this text/);
  assert.ok(diffMatch, 'fuzzy response should include a Differences block');

  return diffMatch[1].replace(/\{-[\s\S]*?-\}\{\+([\s\S]*?)\+\}/g, '$1');
}

function markdownTargetOffset(editNumber) {
  const headerLines = 6;
  const headingsThroughTarget = Math.floor((editNumber - 1) / 40) + 1;
  const markerLinesBeforeTarget = (editNumber - 1) * 3;
  return headerLines + headingsThroughTarget + markerLinesBeforeTarget;
}

function pythonTargetOffset(editNumber) {
  const headerLines = 8;
  const markerLinesBeforeTarget = (editNumber - 1) * 7;
  return headerLines + markerLinesBeforeTarget;
}

async function runSameFileEditWorkflow(client, editCount) {
  const workflowId = `${editCount}-edits`;
  const filePath = path.join(TEST_DIR, `large-workflow-${workflowId}.md`);
  const checkpointPath = path.join(TEST_DIR, `large-workflow-${workflowId}.checkpoint.txt`);
  const startedAt = performance.now();
  let verifiedReads = 0;
  let verifiedWrites = 0;

  const writeResult = await callTool(client, 'write_file', {
    path: filePath,
    content: createLargeFileContent(workflowId, editCount),
    mode: 'rewrite',
  });
  assertToolSuccess(writeResult, `write_file workflow ${workflowId}`);
  verifiedWrites++;

  const initialRead = await callTool(client, 'read_file', {
    path: filePath,
    offset: 0,
    length: READ_LINE_LIMIT,
  });
  assertToolSuccess(initialRead, `initial read_file workflow ${workflowId}`);
  verifiedReads++;
  assert.ok(
    getText(initialRead).includes('[Reading 200 lines from start'),
    `initial read_file workflow ${workflowId}: should return paged large-file output`
  );

  for (let editNumber = 1; editNumber <= editCount; editNumber++) {
    const oldString = marker(workflowId, editNumber, 'original');
    const newString = marker(workflowId, editNumber, 'edited');
    const readOffset = markdownTargetOffset(editNumber);

    const beforeEditRead = await callTool(client, 'read_file', {
      path: filePath,
      offset: readOffset,
      length: 6,
    });
    assertToolSuccess(beforeEditRead, `before-edit read_file workflow ${workflowId} edit ${editNumber}`);
    assert.ok(
      getText(beforeEditRead).includes(oldString),
      `before-edit read_file workflow ${workflowId} edit ${editNumber}: should include original text`
    );
    verifiedReads++;

    const editResult = await callTool(client, 'edit_block', {
      file_path: filePath,
      old_string: oldString,
      new_string: newString,
      expected_replacements: 1,
    });
    assertToolSuccess(editResult, `edit_block workflow ${workflowId} edit ${editNumber}`);

    if (editNumber === 1 || editNumber === editCount) {
      assert.ok(
        getText(editResult).includes(newString),
        `edit_block workflow ${workflowId} edit ${editNumber}: preview should include edited text`
      );
    }

    const afterEditRead = await callTool(client, 'read_file', {
      path: filePath,
      offset: readOffset,
      length: 6,
    });
    assertToolSuccess(afterEditRead, `after-edit read_file workflow ${workflowId} edit ${editNumber}`);
    const afterEditText = getText(afterEditRead);
    assert.ok(
      afterEditText.includes(newString),
      `after-edit read_file workflow ${workflowId} edit ${editNumber}: should include edited text`
    );
    assert.ok(
      !afterEditText.includes(oldString),
      `after-edit read_file workflow ${workflowId} edit ${editNumber}: should not include original text`
    );
    verifiedReads++;

    if (editNumber % 25 === 0 || editNumber === editCount) {
      const checkpointResult = await callTool(client, 'write_file', {
        path: checkpointPath,
        content: `checkpoint workflow=${workflowId} edits_completed=${editNumber}\n`,
        mode: editNumber <= 25 ? 'rewrite' : 'append',
      });
      assertToolSuccess(checkpointResult, `checkpoint write_file workflow ${workflowId} edit ${editNumber}`);
      verifiedWrites++;
    }
  }

  const verificationRead = await callTool(client, 'read_file', {
    path: filePath,
    offset: 0,
    length: Math.min(editCount + 20, READ_LINE_LIMIT),
  });
  assertToolSuccess(verificationRead, `verification read_file workflow ${workflowId}`);
  verifiedReads++;
  const verificationText = getText(verificationRead);
  assert.ok(
    verificationText.includes(marker(workflowId, 1, 'edited')),
    `verification read_file workflow ${workflowId}: first edited text should be present`
  );
  assert.ok(
    !verificationText.includes(marker(workflowId, 1, 'original')),
    `verification read_file workflow ${workflowId}: first old text should be gone`
  );

  const finalContent = await fs.readFile(filePath, 'utf8');
  let verifiedEdits = 0;
  let unmodifiedOriginals = 0;
  for (let editNumber = 1; editNumber <= editCount; editNumber++) {
    const hasEditedMarker = finalContent.includes(marker(workflowId, editNumber, 'edited'));
    const hasOriginalMarker = finalContent.includes(marker(workflowId, editNumber, 'original'));
    if (hasEditedMarker) {
      verifiedEdits++;
    }
    if (hasOriginalMarker) {
      unmodifiedOriginals++;
    }

    assert.ok(
      hasEditedMarker,
      `workflow ${workflowId}: edited marker ${editNumber} should be present`
    );
    assert.ok(
      !hasOriginalMarker,
      `workflow ${workflowId}: original marker ${editNumber} should be gone`
    );
  }

  const durationMs = performance.now() - startedAt;
  console.log(`PASS workflow ${workflowId} completed ${editCount} same-file edits in ${durationMs.toFixed(0)}ms`);
  assert.ok(
    durationMs < PERFORMANCE_LIMITS_MS[editCount],
    `${workflowId} took ${durationMs.toFixed(0)}ms, expected under ${PERFORMANCE_LIMITS_MS[editCount]}ms`
  );

  return {
    label: `${editCount} markdown same-file edits`,
    plannedEdits: editCount,
    verifiedEdits,
    unmodifiedOriginals,
    plannedReads: 2 + (editCount * 2),
    verifiedReads,
    plannedWrites: 1 + Math.ceil(editCount / 25),
    verifiedWrites,
    durationMs,
  };
}

async function runPythonExactEditWorkflow(client, editCount) {
  const workflowId = `python-${editCount}-edits`;
  const filePath = path.join(TEST_DIR, `large-workflow-${workflowId}.py`);
  const checkpointPath = path.join(TEST_DIR, `large-workflow-${workflowId}.checkpoint.txt`);
  const startedAt = performance.now();
  let verifiedReads = 0;
  let verifiedWrites = 0;

  const writeResult = await callTool(client, 'write_file', {
    path: filePath,
    content: createLargePythonFileContent(workflowId, editCount),
    mode: 'rewrite',
  });
  assertToolSuccess(writeResult, `write_file workflow ${workflowId}`);
  verifiedWrites++;

  const initialRead = await callTool(client, 'read_file', {
    path: filePath,
    offset: 0,
    length: READ_LINE_LIMIT,
  });
  assertToolSuccess(initialRead, `initial read_file workflow ${workflowId}`);
  verifiedReads++;

  for (let editNumber = 1; editNumber <= editCount; editNumber++) {
    const readOffset = pythonTargetOffset(editNumber);

    const beforeEditRead = await callTool(client, 'read_file', {
      path: filePath,
      offset: readOffset,
      length: 9,
    });
    assertToolSuccess(beforeEditRead, `before-edit read_file workflow ${workflowId} edit ${editNumber}`);
    assert.ok(
      getText(beforeEditRead).includes(pythonMarker(workflowId, editNumber, 'original')),
      `before-edit read_file workflow ${workflowId} edit ${editNumber}: should include original Python text`
    );
    verifiedReads++;

    const editResult = await callTool(client, 'edit_block', {
      file_path: filePath,
      old_string: pythonMarker(workflowId, editNumber, 'original'),
      new_string: pythonMarker(workflowId, editNumber, 'edited'),
      expected_replacements: 1,
    });
    assertToolSuccess(editResult, `edit_block workflow ${workflowId} edit ${editNumber}`);

    const afterEditRead = await callTool(client, 'read_file', {
      path: filePath,
      offset: readOffset,
      length: 9,
    });
    assertToolSuccess(afterEditRead, `after-edit read_file workflow ${workflowId} edit ${editNumber}`);
    const afterEditText = getText(afterEditRead);
    assert.ok(
      afterEditText.includes(pythonMarker(workflowId, editNumber, 'edited')),
      `after-edit read_file workflow ${workflowId} edit ${editNumber}: should include edited Python text`
    );
    assert.ok(
      !afterEditText.includes(pythonMarker(workflowId, editNumber, 'original')),
      `after-edit read_file workflow ${workflowId} edit ${editNumber}: should not include original Python text`
    );
    verifiedReads++;

    if (editNumber % 25 === 0 || editNumber === editCount) {
      const checkpointResult = await callTool(client, 'write_file', {
        path: checkpointPath,
        content: `checkpoint workflow=${workflowId} edits_completed=${editNumber}\n`,
        mode: editNumber <= 25 ? 'rewrite' : 'append',
      });
      assertToolSuccess(checkpointResult, `checkpoint write_file workflow ${workflowId} edit ${editNumber}`);
      verifiedWrites++;
    }
  }

  const finalContent = await fs.readFile(filePath, 'utf8');
  let verifiedEdits = 0;
  let unmodifiedOriginals = 0;
  for (let editNumber = 1; editNumber <= editCount; editNumber++) {
    const hasEditedMarker = finalContent.includes(pythonMarker(workflowId, editNumber, 'edited'));
    const hasOriginalMarker = finalContent.includes(pythonMarker(workflowId, editNumber, 'original'));
    if (hasEditedMarker) {
      verifiedEdits++;
    }
    if (hasOriginalMarker) {
      unmodifiedOriginals++;
    }

    assert.ok(
      hasEditedMarker,
      `workflow ${workflowId}: edited Python marker ${editNumber} should be present`
    );
    assert.ok(
      !hasOriginalMarker,
      `workflow ${workflowId}: original Python marker ${editNumber} should be gone`
    );
  }

  const durationMs = performance.now() - startedAt;
  console.log(`PASS workflow ${workflowId} completed ${editCount} Python same-file edits in ${durationMs.toFixed(0)}ms`);
  assert.ok(
    durationMs < PERFORMANCE_LIMITS_MS.python150,
    `${workflowId} took ${durationMs.toFixed(0)}ms, expected under ${PERFORMANCE_LIMITS_MS.python150}ms`
  );

  return {
    label: `${editCount} Python same-file edits`,
    plannedEdits: editCount,
    verifiedEdits,
    unmodifiedOriginals,
    plannedReads: 1 + (editCount * 2),
    verifiedReads,
    plannedWrites: 1 + Math.ceil(editCount / 25),
    verifiedWrites,
    durationMs,
  };
}

async function runDocxExactEditWorkflow(client, editCount) {
  const workflowId = `docx-${editCount}-edits`;
  const filePath = path.join(TEST_DIR, `large-workflow-${workflowId}.docx`);
  const startedAt = performance.now();
  let verifiedReads = 0;
  let verifiedWrites = 0;

  const writeResult = await callTool(client, 'write_file', {
    path: filePath,
    content: createDocxFileContent(workflowId, editCount),
    mode: 'rewrite',
  });
  assertToolSuccess(writeResult, `write_file workflow ${workflowId}`);
  verifiedWrites++;

  // No offset -> DOCX outline (text-bearing), which we string-match against.
  const initialRead = await callTool(client, 'read_file', { path: filePath });
  assertToolSuccess(initialRead, `initial read_file workflow ${workflowId}`);
  assert.ok(
    getText(initialRead).includes(docxMarkerText(workflowId, 1, 'original')),
    `initial read_file workflow ${workflowId}: should include original DOCX text`
  );
  verifiedReads++;

  for (let editNumber = 1; editNumber <= editCount; editNumber++) {
    const editResult = await callTool(client, 'edit_block', {
      file_path: filePath,
      old_string: docxBodyElement(docxMarkerText(workflowId, editNumber, 'original')),
      new_string: docxBodyElement(docxMarkerText(workflowId, editNumber, 'edited')),
      expected_replacements: 1,
    });
    assertToolSuccess(editResult, `edit_block workflow ${workflowId} edit ${editNumber}`);
  }

  const verificationRead = await callTool(client, 'read_file', { path: filePath });
  assertToolSuccess(verificationRead, `verification read_file workflow ${workflowId}`);
  verifiedReads++;
  const verificationText = getText(verificationRead);

  let verifiedEdits = 0;
  let unmodifiedOriginals = 0;
  for (let editNumber = 1; editNumber <= editCount; editNumber++) {
    const hasEditedMarker = verificationText.includes(docxMarkerText(workflowId, editNumber, 'edited'));
    const hasOriginalMarker = verificationText.includes(docxMarkerText(workflowId, editNumber, 'original'));
    if (hasEditedMarker) {
      verifiedEdits++;
    }
    if (hasOriginalMarker) {
      unmodifiedOriginals++;
    }

    assert.ok(
      hasEditedMarker,
      `workflow ${workflowId}: edited DOCX marker ${editNumber} should be present`
    );
    assert.ok(
      !hasOriginalMarker,
      `workflow ${workflowId}: original DOCX marker ${editNumber} should be gone`
    );
  }

  const durationMs = performance.now() - startedAt;
  console.log(`PASS workflow ${workflowId} completed ${editCount} DOCX same-file edits in ${durationMs.toFixed(0)}ms`);
  assert.ok(
    durationMs < PERFORMANCE_LIMITS_MS.docx40,
    `${workflowId} took ${durationMs.toFixed(0)}ms, expected under ${PERFORMANCE_LIMITS_MS.docx40}ms`
  );

  return {
    label: `${editCount} DOCX same-file edits`,
    plannedEdits: editCount,
    verifiedEdits,
    unmodifiedOriginals,
    plannedReads: 2,
    verifiedReads,
    plannedWrites: 1,
    verifiedWrites,
    durationMs,
  };
}

async function runPythonFuzzyFallbackWorkflow(client, attemptCount) {
  const workflowId = `python-fuzzy-${attemptCount}`;
  const filePath = path.join(TEST_DIR, `large-workflow-${workflowId}.py`);
  const exactTarget = fuzzyPythonReportLine(workflowId, 'original');
  const editedTarget = fuzzyPythonReportLine(workflowId, 'edited');
  const fuzzyOldString = exactTarget.replace('Commander', 'Comander');
  const startedAt = performance.now();

  const writeResult = await callTool(client, 'write_file', {
    path: filePath,
    content: createFuzzyPythonFileContent(workflowId, exactTarget),
    mode: 'rewrite',
  });
  assertToolSuccess(writeResult, `write_file workflow ${workflowId}`);

  let extractedExactText = null;
  for (let attempt = 1; attempt <= attemptCount; attempt++) {
    const editResult = await callTool(client, 'edit_block', {
      file_path: filePath,
      old_string: fuzzyOldString,
      new_string: editedTarget,
      expected_replacements: 1,
    });
    assertToolSuccess(editResult, `fuzzy edit_block workflow ${workflowId} attempt ${attempt}`);
    assert.ok(
      getText(editResult).includes('Exact match not found, but found a similar text'),
      `fuzzy edit_block workflow ${workflowId} attempt ${attempt}: should use fuzzy fallback. Response: ${getText(editResult).slice(0, 1000)}`
    );
    extractedExactText = extractActualTextFromFuzzyDiff(getText(editResult));
    assert.strictEqual(
      extractedExactText,
      exactTarget,
      `fuzzy edit_block workflow ${workflowId} attempt ${attempt}: extracted exact text should match file content`
    );
  }

  const retryResult = await callTool(client, 'edit_block', {
    file_path: filePath,
    old_string: extractedExactText,
    new_string: editedTarget,
    expected_replacements: 1,
  });
  assertToolSuccess(retryResult, `fuzzy retry edit_block workflow ${workflowId}`);

  const finalContent = await fs.readFile(filePath, 'utf8');
  assert.ok(!finalContent.includes(exactTarget), `workflow ${workflowId}: fuzzy retry should replace original marker`);
  assert.ok(
    finalContent.includes(editedTarget),
    `workflow ${workflowId}: fuzzy retry should write edited marker`
  );

  const durationMs = performance.now() - startedAt;
  console.log(`PASS workflow ${workflowId} completed ${attemptCount} Python fuzzy fallback attempts in ${durationMs.toFixed(0)}ms`);
  assert.ok(
    durationMs < PERFORMANCE_LIMITS_MS.pythonFuzzy25,
    `${workflowId} took ${durationMs.toFixed(0)}ms, expected under ${PERFORMANCE_LIMITS_MS.pythonFuzzy25}ms`
  );

  return {
    label: `${attemptCount} Python fuzzy fallback attempts`,
    plannedEdits: 1,
    verifiedEdits: finalContent.includes(editedTarget) ? 1 : 0,
    unmodifiedOriginals: finalContent.includes(exactTarget) ? 1 : 0,
    fuzzyFallbackAttempts: attemptCount,
    durationMs,
  };
}

// Regression test for the edit_block fuzzy-fallback hang: performSearchReplace()
// used to run recursiveFuzzyIndexOf() synchronously on the main thread, freezing
// every concurrent tool call and ping for the duration of the scan (seconds).
// The scan now runs in a worker thread (runFuzzySearchInWorker); this asserts
// the event loop stays responsive while a slow scan is in progress.
async function runFuzzyEventLoopResponsivenessWorkflow(client) {
  const filePath = path.join(TEST_DIR, 'fuzzy-event-loop-regression.txt');
  const line = 'the quick brown fox jumps over the lazy dog and then keeps on running\n';
  const startedAt = performance.now();

  // Written directly (not via write_file) — the fixture exceeds fileWriteLineLimit.
  await fs.writeFile(filePath, line.repeat(Math.ceil((FUZZY_SCAN_FILE_MB * 1024 * 1024) / line.length)), 'utf8');

  // old_string deliberately absent from the file -> forces a full fuzzy scan.
  const oldString = 'NO_SUCH_MARKER_' + 'z'.repeat(FUZZY_SCAN_QUERY_KB * 1024);

  let editDone = false;
  const editPromise = callTool(client, 'edit_block', {
    file_path: filePath,
    old_string: oldString,
    new_string: 'replacement',
    expected_replacements: 1,
  });
  editPromise.finally(() => { editDone = true; });

  // Ping on a tight interval while the fuzzy scan is running.
  const pingLatencies = [];
  while (!editDone) {
    const pingStartedAt = performance.now();
    await client.ping({ timeout: 30000 });
    pingLatencies.push(performance.now() - pingStartedAt);
    if (!editDone) await sleep(FUZZY_SCAN_PING_INTERVAL_MS);
  }

  const editResult = await editPromise;
  assertToolSuccess(editResult, 'fuzzy event-loop regression edit_block');

  const durationMs = performance.now() - startedAt;
  const maxPingLatencyMs = pingLatencies.length > 0 ? Math.max(...pingLatencies) : Infinity;
  console.log(
    `PASS fuzzy event-loop regression: ${pingLatencies.length} pings during scan, max latency ${maxPingLatencyMs.toFixed(0)}ms (scan ${durationMs.toFixed(0)}ms)`
  );

  assert.ok(
    pingLatencies.length >= FUZZY_SCAN_MIN_PING_COUNT,
    `event loop blocked during fuzzy scan: only ${pingLatencies.length} ping(s) completed, expected >= ${FUZZY_SCAN_MIN_PING_COUNT}`
  );
  assert.ok(
    maxPingLatencyMs < FUZZY_SCAN_MAX_PING_LATENCY_MS,
    `event loop blocked during fuzzy scan: max ping latency ${maxPingLatencyMs.toFixed(0)}ms, expected under ${FUZZY_SCAN_MAX_PING_LATENCY_MS}ms`
  );

  return { pingCount: pingLatencies.length, maxPingLatencyMs, durationMs };
}

async function runParallelWorkflows(client, editCounts) {
  const startedAt = performance.now();
  const stopProbe = { value: false };
  const responsivenessProbe = runResponsivenessProbe(client, stopProbe);

  let workflowResults;
  let responsiveness;
  try {
    workflowResults = await Promise.all([
      ...editCounts.map((editCount) => runSameFileEditWorkflow(client, editCount)),
      runPythonExactEditWorkflow(client, 150),
      runDocxExactEditWorkflow(client, 40),
      runPythonFuzzyFallbackWorkflow(client, 25),
    ]);
  } finally {
    stopProbe.value = true;
    responsiveness = await responsivenessProbe;
  }
  const durationMs = performance.now() - startedAt;

  console.log(`PASS all same-file edit workflows completed in parallel in ${durationMs.toFixed(0)}ms`);
  console.log(
    `PASS responsiveness probe completed ${responsiveness.count} pings, max latency ${responsiveness.maxLatencyMs.toFixed(0)}ms`
  );

  assert.ok(responsiveness.count > 0, 'responsiveness probe should complete at least one ping');
  assert.ok(
    responsiveness.maxLatencyMs < RESPONSIVENESS_MAX_LATENCY_MS,
    `MCP server became unresponsive: max ping latency ${responsiveness.maxLatencyMs.toFixed(0)}ms, expected under ${RESPONSIVENESS_MAX_LATENCY_MS}ms`
  );

  return { durationMs, workflowResults, responsiveness };
}

async function runResponsivenessProbe(client, stopProbe) {
  const latencies = [];

  while (!stopProbe.value) {
    const startedAt = performance.now();
    await client.ping({ timeout: 30000 });
    latencies.push(performance.now() - startedAt);
    await sleep(RESPONSIVENESS_INTERVAL_MS);
  }

  const totalLatencyMs = latencies.reduce((sum, latency) => sum + latency, 0);
  return {
    count: latencies.length,
    maxLatencyMs: latencies.length > 0 ? Math.max(...latencies) : 0,
    averageLatencyMs: latencies.length > 0 ? totalLatencyMs / latencies.length : 0,
  };
}

async function createMcpClient() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(PROJECT_ROOT, 'dist/index.js'), '--no-onboarding'],
    cwd: PROJECT_ROOT,
    stderr: 'pipe',
    env: {
      ...process.env,
      DESKTOP_COMMANDER_DISABLE_TELEMETRY: 'true',
    },
  });

  const stderrChunks = [];
  transport.stderr?.on('data', (chunk) => {
    stderrChunks.push(Buffer.from(chunk).toString('utf8'));
  });

  const client = new Client(
    { name: 'desktop-commander-edit-performance-test', version: '1.0.0' },
    { capabilities: {} }
  );

  await client.connect(transport, { timeout: 30000 });

  return {
    client,
    async close() {
      await client.close();
    },
    getStderr() {
      return stderrChunks.join('');
    },
  };
}

async function setup(client) {
  await fs.rm(TEST_DIR, { recursive: true, force: true });
  await fs.mkdir(TEST_DIR, { recursive: true });

  const tools = await client.listTools(undefined, { timeout: 30000 });
  for (const toolName of ['get_config', 'set_config_value', 'write_file', 'read_file', 'edit_block']) {
    assert.ok(
      tools.tools.some((tool) => tool.name === toolName),
      `MCP server should expose ${toolName}`
    );
  }

  const originalConfigResult = await callTool(client, 'get_config', {});
  assertToolSuccess(originalConfigResult, 'get_config');
  const originalConfigEntries = originalConfigResult.structuredContent?.entries;
  assert.ok(Array.isArray(originalConfigEntries), 'get_config should return structured config entries');
  const originalConfig = Object.fromEntries(
    originalConfigEntries
      .filter((entry) => entry && entry.editable === true)
      .map((entry) => [entry.key, entry.value])
  );

  for (const [key, value] of [
    ['allowedDirectories', [TEST_DIR]],
    ['fileReadLineLimit', READ_LINE_LIMIT],
    ['fileWriteLineLimit', 10000],
  ]) {
    const result = await callTool(client, 'set_config_value', { key, value, origin: 'llm' });
    assertToolSuccess(result, `set_config_value ${key}`);
  }

  return originalConfig;
}

async function teardown(client, originalConfig) {
  for (const [key, value] of Object.entries(originalConfig)) {
    const result = await callTool(client, 'set_config_value', { key, value, origin: 'llm' });
    assertToolSuccess(result, `restore config ${key}`);
  }
  await fs.rm(TEST_DIR, { recursive: true, force: true });
}

async function main() {
  console.log('===== Edit Block Large-File Performance Integration Test =====');
  const mcp = await createMcpClient();
  const originalConfig = await setup(mcp.client);

  try {
    const results = await runParallelWorkflows(mcp.client, [1, 10, 100, 150]);

    // Run sequentially: its strict ping-latency ceiling would be flaky under
    // the parallel workflows' load.
    const fuzzyResponsiveness = await runFuzzyEventLoopResponsivenessWorkflow(mcp.client);

    console.log('\nPerformance summary:');
    for (const result of results.workflowResults) {
      console.log(`  ${result.label}: ${result.durationMs.toFixed(0)}ms`);
    }
    console.log(`  parallel total: ${results.durationMs.toFixed(0)}ms`);
    console.log(
      `  responsiveness pings: ${results.responsiveness.count}, max ${results.responsiveness.maxLatencyMs.toFixed(0)}ms, avg ${results.responsiveness.averageLatencyMs.toFixed(0)}ms`
    );
    console.log(
      `  fuzzy-scan responsiveness: ${fuzzyResponsiveness.pingCount} pings, max ${fuzzyResponsiveness.maxPingLatencyMs.toFixed(0)}ms over a ${fuzzyResponsiveness.durationMs.toFixed(0)}ms scan`
    );

    console.log('\nEdit verification summary:');
    for (const result of results.workflowResults) {
      if (result.fuzzyFallbackAttempts) {
        console.log(
          `  ${result.label}: ${result.fuzzyFallbackAttempts} fallback responses, retry verified ${result.verifiedEdits}/${result.plannedEdits}, remaining originals ${result.unmodifiedOriginals}`
        );
        assert.strictEqual(result.verifiedEdits, result.plannedEdits, `${result.label}: retry edit should be verified`);
        assert.strictEqual(result.unmodifiedOriginals, 0, `${result.label}: retry should remove original marker`);
        continue;
      }

      console.log(
        `  ${result.label}: edits ${result.verifiedEdits}/${result.plannedEdits}, reads ${result.verifiedReads}/${result.plannedReads}, writes ${result.verifiedWrites}/${result.plannedWrites}, remaining originals ${result.unmodifiedOriginals}`
      );
      assert.strictEqual(result.verifiedEdits, result.plannedEdits, `${result.label}: all planned edits should be verified`);
      assert.strictEqual(result.verifiedReads, result.plannedReads, `${result.label}: all reads should be verified`);
      assert.strictEqual(result.verifiedWrites, result.plannedWrites, `${result.label}: all writes should be verified`);
      assert.strictEqual(result.unmodifiedOriginals, 0, `${result.label}: no original markers should remain`);
    }

    console.log('\nPASS Edit block large-file performance integration test passed');
  } finally {
    try {
      await teardown(mcp.client, originalConfig);
    } finally {
      const stderr = mcp.getStderr().trim();
      if (stderr) {
        console.log(`\nMCP server stderr:\n${stderr}`);
      }
      await mcp.close();
    }
  }
}

main().catch((error) => {
  console.error('FAIL Edit block large-file performance integration test failed:', error);
  process.exit(1);
});
