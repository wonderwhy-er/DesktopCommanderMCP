import assert from 'assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { handleWriteFile } from '../dist/handlers/filesystem-handlers.js';
import { writeFile, writeFileWithMetrics } from '../dist/tools/filesystem.js';
import { TextFileHandler } from '../dist/utils/files/text.js';
import { runIfMain } from './helpers/run-if-main.js';

async function runTests() {
  const lineCases = [
    ['', 0], ['alpha', 1], ['alpha\n', 1], ['alpha\nbeta', 2],
    ['alpha\r\nbeta\r\n', 2], ['alpha\rbeta', 2], ['\n\n', 2], ['\r\n', 1],
  ];
  for (const [content, expected] of lineCases) {
    assert.strictEqual(TextFileHandler.countLines(content), expected,
      `countLines mismatch for ${JSON.stringify(content)}`);
  }

  const target = path.join(os.tmpdir(), `dc-write-metrics-${process.pid}-${Date.now()}.txt`);
  const originalCountLines = TextFileHandler.countLines;
  let countCalls = 0;

  TextFileHandler.countLines = function(content) {
    countCalls += 1;
    return originalCountLines.call(TextFileHandler, content);
  };

  try {
    const result = await handleWriteFile({
      path: target,
      content: 'alpha\nbeta\ngamma\n',
      mode: 'rewrite',
    });
    assert.strictEqual(result.isError, undefined, `write_file should succeed: ${JSON.stringify(result)}`);
    assert.strictEqual(countCalls, 1,
      `write_file should scan content for line count once, scanned ${countCalls} times`);
    assert.match(result.content?.[0]?.text ?? '', /\(3 lines\)/,
      'handler response should reuse the line count returned by writeFile');
    console.log('✓ write_file calculates and reuses content metrics once');

    TextFileHandler.countLines = originalCountLines;
    const unicode = '\u65e5\u672c\u8a9e\ud83d\ude42\r\nalpha\rbeta\n';
    const metrics = await writeFileWithMetrics(target, unicode, 'rewrite');
    assert.deepStrictEqual(metrics, {
      contentBytes: Buffer.byteLength(unicode),
      lineCount: 3,
    }, 'writeFile should return UTF-8 byte and line metrics for the written payload');

    const appended = '\u8ffd\u52a0\ud83d\ude42\n';
    const appendMetrics = await writeFileWithMetrics(target, appended, 'append');
    assert.deepStrictEqual(appendMetrics, {
      contentBytes: Buffer.byteLength(appended),
      lineCount: 1,
    }, 'append metrics should describe the appended payload');
    assert.strictEqual(await fs.readFile(target, 'utf8'), unicode + appended,
      'returning metrics must not change rewrite/append semantics');

    const legacyResult = await writeFile(target, 'legacy API contract', 'rewrite');
    assert.strictEqual(legacyResult, undefined,
      'the existing writeFile helper should keep its Promise<void> contract');
    console.log('✓ write_file preserves UTF-8 metrics, rewrite/append semantics, and writeFile return compatibility');
    return true;
  } finally {
    TextFileHandler.countLines = originalCountLines;
    try { await fs.unlink(target); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
}

runIfMain(import.meta.url, runTests);
