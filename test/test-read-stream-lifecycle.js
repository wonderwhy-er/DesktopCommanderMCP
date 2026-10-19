import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';

// Observe actual OS streams, including their asynchronous close event. A rename
// alone cannot detect this leak on Unix, where open files remain renameable.
const streams = [];
const createReadStream = fs.createReadStream;
fs.createReadStream = (...args) => {
  const input = createReadStream(...args);
  streams.push(input);
  return input;
};
syncBuiltinESMExports();
const { TextFileHandler } = await import('../dist/utils/files/text.js');
const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'dc-reader-lifecycle-'));
const file = path.join(directory, 'input.txt');
const handler = new TextFileHandler();
const assertClosed = () => {
  assert.ok(streams.length > 0, 'exercise the streaming path');
  for (const input of streams) {
    assert.equal(input.destroyed, true, 'read must destroy its stream');
    assert.equal(input.closed, true, 'read must await OS descriptor closure');
    assert.equal(input.fd, null, 'no descriptor may outlive the read');
  }
  streams.length = 0;
};
try {
  await fsp.writeFile(file, 'first\n' + 'middle\n'.repeat(100000) + 'last\n');
  for (const [offset, expected] of [[0, 'first'], [3, 'middle'], [-1, 'last']]) {
    const result = await handler.read(file, { offset, length: 1, includeStatusMessage: false });
    assert.equal(result.content, expected);
    assertClosed();
    // Exercise the operation the leaked Windows handle prevented.
    await fsp.rename(file, `${file}.moved`);
    await fsp.rename(`${file}.moved`, file);
  }
  await fsp.writeFile(file, '\ufefffirst\r\n' + 'middle\r\n'.repeat(100000), 'utf16le');
  assert.equal((await handler.read(file, { length: 1, includeStatusMessage: false })).content, 'first');
  assertClosed();

  // Exercise an actual stream cancellation after its first chunk, rather than
  // aborting the earlier stat/encoding probes before a stream is constructed.
  const controller = new AbortController();
  const originalCreate = fs.createReadStream;
  fs.createReadStream = (...args) => {
    const input = originalCreate(...args);
    input.once('data', () => controller.abort());
    return input;
  };
  syncBuiltinESMExports();
  await assert.rejects(handler.read(file, { offset: -1, signal: controller.signal }), { name: 'AbortError' });
  assertClosed();
  console.log('PASS: early pagination, middle, tail, UTF-16 and abort close descriptors before returning');
} finally {
  fs.createReadStream = createReadStream;
  syncBuiltinESMExports();
  // Also make a failing regression self-cleaning on Windows.
  for (const input of streams) {
    const closed = new Promise(resolve => input.closed ? resolve() : input.once('close', resolve));
    input.destroy();
    await closed;
  }
  await fsp.rm(directory, { recursive: true });
}
