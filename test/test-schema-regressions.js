import assert from 'node:assert/strict';
import {
  ForceTerminateArgsSchema,
  KillProcessArgsSchema,
  ReadFileArgsSchema,
  ReadProcessOutputArgsSchema,
  StartProcessArgsSchema,
} from '../dist/tools/schemas.js';
import { listProcesses } from '../dist/tools/process.js';

const startProcess = StartProcessArgsSchema.parse({ command: 'echo ok' });
assert.equal(startProcess.timeout_ms, 1000, 'start_process should use the runtime timeout default');

const readFile = ReadFileArgsSchema.parse({ path: 'example.txt' });
assert.equal(readFile.length, undefined, 'read_file should let the handler apply its configured line limit');

for (const schema of [ReadProcessOutputArgsSchema, ForceTerminateArgsSchema, KillProcessArgsSchema]) {
  for (const pid of [0, -1, 1.5]) {
    assert.equal(schema.safeParse({ pid }).success, false, `PID ${pid} must be rejected`);
  }
}

if (process.platform === 'win32') {
  const result = await listProcesses();
  assert.equal(result.isError, undefined);
  const text = result.content[0]?.text ?? '';
  assert.doesNotMatch(text, /PID: NaN/);
  assert.match(text, /PID: \d+/);
}

console.log('Schema and process-list regression tests passed');
