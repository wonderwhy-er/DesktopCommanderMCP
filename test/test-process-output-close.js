import assert from 'assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { terminalManager } from '../dist/terminal-manager.js';

const TEST_DIR = path.join(os.tmpdir(), 'desktop-commander-process-output-close');
const SCRIPT_PATH = path.join(TEST_DIR, 'fast-stderr.js');

function quoteForShell(value) {
  return `"${value.replace(/"/g, '\\"')}"`;
}

async function setup() {
  await fs.mkdir(TEST_DIR, { recursive: true });
  await fs.writeFile(
    SCRIPT_PATH,
    [
      "import fs from 'fs';",
      "fs.writeSync(2, 'FAST_STDERR_START\\n');",
      "fs.writeSync(2, 'x'.repeat(256 * 1024));",
      "fs.writeSync(2, '\\nFAST_STDERR_END\\n');",
      'process.exit(1);',
    ].join('\n'),
  );
}

async function teardown() {
  await fs.rm(TEST_DIR, { recursive: true, force: true });
}

async function testFastExitStderrIsFlushed() {
  const command = `${quoteForShell(process.execPath)} ${quoteForShell(SCRIPT_PATH)}`;
  const result = await terminalManager.executeCommand(command, 2000);

  assert.strictEqual(result.isBlocked, false, 'Fast-failing process should be marked complete');

  const output = terminalManager.readOutputPaginated(result.pid, 0, 100);
  assert(output, 'Completed process output should remain readable');

  const text = output.lines.join('\n');
  assert.strictEqual(output.exitCode, 1, 'Process exit code should be preserved');
  assert(text.includes('FAST_STDERR_START'), 'stderr start marker should be captured');
  assert(text.includes('FAST_STDERR_END'), 'stderr end marker should be captured after process exit');

  console.log('✓ fast-exiting process stderr is flushed before completion');
}

export default async function runTests() {
  try {
    await setup();
    await testFastExitStderrIsFlushed();
    console.log('\n✅ process output close tests passed!');
    return true;
  } catch (error) {
    console.error('❌ process output close test failed:', error instanceof Error ? error.message : String(error));
    return false;
  } finally {
    await teardown();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().then((ok) => {
    process.exit(ok ? 0 : 1);
  });
}
