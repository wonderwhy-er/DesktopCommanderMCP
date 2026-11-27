import assert from 'assert';
import os from 'os';
import path from 'path';
import { runIfMain } from '../helpers/run-if-main.js';
import { terminalManager } from '../../dist/terminal-manager.js';
import { startProcess } from '../../dist/tools/improved-process-tools.js';

const missingShell = path.join(
  os.tmpdir(),
  `desktop-commander-missing-shell-${process.pid}`,
  process.platform === 'win32' ? 'powershell.exe' : 'bash'
);

async function runTests() {
  console.log(`Using intentionally missing shell: ${missingShell}`);

  const direct = await terminalManager.executeCommand('echo unreachable', 1000, missingShell);
  assert.strictEqual(direct.pid, -1, 'spawn failure should use pid -1');
  assert.strictEqual(direct.spawnError?.name, 'Error', 'terminal result should retain the error name');
  assert.strictEqual(direct.spawnError?.code, 'ENOENT', 'terminal result should retain the spawn error code');
  assert.strictEqual(typeof direct.spawnError?.errno, 'number', 'terminal result should retain numeric errno when Node provides it');
  assert.match(direct.spawnError?.syscall ?? '', /^spawn\b/, 'terminal result should retain the spawn syscall');
  assert.strictEqual(direct.spawnError?.path, missingShell, 'terminal result should retain the failed executable path');
  assert(!('spawnargs' in direct.spawnError), 'terminal result must not expose spawnargs');
  assert(!('stack' in direct.spawnError), 'terminal result must not expose stack');
  assert.match(direct.output, /ENOENT/, 'human-readable output should include the spawn error');

  const tool = await startProcess({ command: 'echo unreachable', timeout_ms: 1000, shell: missingShell });
  assert.strictEqual(tool.isError, true, 'start_process should report the failed spawn as an error');
  assert.strictEqual(tool.structuredContent?.spawnError?.name, 'Error', 'tool result should expose the error name');
  assert.strictEqual(tool.structuredContent?.spawnError?.code, 'ENOENT', 'tool result should expose the spawn error code');
  assert.strictEqual(typeof tool.structuredContent?.spawnError?.errno, 'number', 'tool result should expose numeric errno when Node provides it');
  assert.match(tool.structuredContent?.spawnError?.syscall ?? '', /^spawn\b/, 'tool result should expose the spawn syscall');
  assert.strictEqual(tool.structuredContent?.spawnError?.path, missingShell, 'tool result should expose the failed executable path');
  assert(!('spawnargs' in tool.structuredContent.spawnError), 'tool result must not expose spawnargs');
  assert(!('stack' in tool.structuredContent.spawnError), 'tool result must not expose stack');
  assert(!JSON.stringify(tool.structuredContent.spawnError).includes('echo unreachable'), 'structured spawn error must not echo the command payload');
  assert.match(tool.content[0]?.text ?? '', /ENOENT/, 'tool text should include the spawn error');

  console.log('✅ spawn startup error details are preserved');
  return true;
}

runIfMain(import.meta.url, runTests);

export { runTests };
