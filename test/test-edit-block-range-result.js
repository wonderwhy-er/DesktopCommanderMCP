/**
 * edit_block with `range` reports what the file's handler did. A range edit
 * on a DOCX (whose edits are find/replace) changed nothing, yet the answer was
 * "Successfully updated range ...": the handler's failed result was ignored.
 * Calls the tool handler (the answer text a client gets).
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { handleWriteFile } from '../dist/handlers/filesystem-handlers.js';
import { handleEditBlock } from '../dist/handlers/edit-search-handlers.js';
import { runIfMain } from './helpers/run-if-main.js';

const text = (result) => result.content.map((item) => item.text ?? '').join('\n');

async function testDocxRangeEditIsNotReportedAsDone(dir) {
  const file = path.join(dir, 'memo.docx');
  const written = await handleWriteFile({ path: file, content: '# Title\n\nHello' });
  assert.notStrictEqual(written.isError, true, `write_file failed: ${text(written)}`);
  const before = fs.readFileSync(file);

  const result = await handleEditBlock({ file_path: file, range: 'Sheet1!A1:A1', content: [['x']] });
  const unchanged = before.equals(fs.readFileSync(file));
  assert.ok(unchanged, 'a range edit on a DOCX changed the file');
  assert.strictEqual(result.isError, true,
    `a range edit on a DOCX changed nothing, so it should not answer success; got: ${text(result)}`);
}

export default async function runTests() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-range-result-'));
  try {
    await testDocxRangeEditIsNotReportedAsDone(dir);
    console.log('✓ A range edit that changed nothing is not reported as done');
    return true;
  } catch (error) {
    console.error(`❌ ${error.message}`);
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

runIfMain(import.meta.url, runTests);
