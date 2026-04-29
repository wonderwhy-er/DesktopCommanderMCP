import assert from 'assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { terminalManager } from '../dist/terminal-manager.js';

const TEST_DIR_PREFIX = path.join(os.tmpdir(), 'desktop-commander-process-output-close-');

function quoteForShell(value) {
  return `"${value.replace(/"/g, '\\"')}"`;
}

async function setup() {
  const testDir = await fs.mkdtemp(TEST_DIR_PREFIX);
  const scriptPath = path.join(testDir, 'fast-stderr.mjs');
  await fs.writeFile(
    scriptPath,
    [
      "import fs from 'fs';",
      "fs.writeSync(2, 'FAST_STDERR_START\\n');",
      "fs.writeSync(2, 'x'.repeat(256 * 1024));",
      "fs.writeSync(2, '\\nFAST_STDERR_END\\n');",
      'process.exit(1);',
    ].join('\n'),
  );
  return { testDir, scriptPath };
}

async function teardown(testDir) {
  await fs.rm(testDir, { recursive: true, force: true });
}

async function testFastExitStderrIsFlushed(scriptPath) {
  const command = `${quoteForShell(process.execPath)} ${quoteForShell(scriptPath)}`;
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
  let testDir;
  try {
    const fixture = await setup();
    testDir = fixture.testDir;
    await testFastExitStderrIsFlushed(fixture.scriptPath);
    console.log('\n✅ process output close tests passed!');
    return true;
  } catch (error) {
    console.error('❌ process output close test failed:', error instanceof Error ? error.message : String(error));
    return false;
  } finally {
    if (testDir) {
      await teardown(testDir);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().then((ok) => {
    process.exit(ok ? 0 : 1);
  });
}
