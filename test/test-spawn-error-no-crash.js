/**
 * Regression test: a failing spawn must not kill the MCP server.
 *
 * spawn() reports failure asynchronously via an 'error' event rather than by
 * throwing. terminal-manager used to return early on `!childProcess.pid` without
 * ever attaching an 'error' listener, so Node rethrew the event as an uncaught
 * exception one tick later and src/index.ts's uncaughtException handler called
 * process.exit(1). The tool call had already returned "Failed to get process ID",
 * so the crash looked unrelated to the command that caused it — and under
 * `desktop-commander remote` the parent then answered every later call with
 * "Not connected" over a dead stdio pipe.
 *
 * Cases:
 *   - a bogus shell path (the /usr/bin/bash-on-Windows shape) returns an error
 *     result AND the process is still alive several ticks later
 *   - a bogus executable behaves the same way
 *   - a normal command still works afterwards (the handler didn't break the path)
 *
 * Runs as part of `npm test` (needs `npm run build` first, which `npm test` does),
 * or standalone: `node test/test-spawn-error-no-crash.js`.
 */
import assert from 'node:assert';
import { terminalManager } from '../dist/terminal-manager.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

// A path that cannot resolve on any platform we support.
const BOGUS_SHELL = process.platform === 'win32'
  ? '/usr/bin/definitely-not-a-shell'
  : '/definitely/not/a/shell';

let uncaught = null;
process.on('uncaughtException', (err) => { uncaught = err; });

/** Let the spawn 'error' event (next tick) and anything it triggers land. */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 50));
}

async function testBogusShellDoesNotCrash() {
  const result = await terminalManager.executeCommand('echo hi', 3000, BOGUS_SHELL);
  await settle();

  assert.strictEqual(uncaught, null,
    `spawn failure escaped as an uncaught exception: ${uncaught && uncaught.message}`);
  assert.ok(result, 'executeCommand must return a result, not hang');
  assert.ok(
    result.pid === -1 || /error/i.test(result.output),
    `expected an error result, got ${JSON.stringify(result)}`
  );
  console.log('✓ bogus shell returns an error without crashing the process');
}

async function testMissingCommandThroughShellDoesNotCrash() {
  // NOTE: a falsy `shell` argument is coerced to the configured default shell
  // (executeCommand: `shellToUse = config.defaultShell || true`), so this runs
  // THROUGH a shell and exercises the exit-127 "command not found" path — it
  // cannot produce a spawn 'error' event. The spawn-error path is covered by
  // the bogus-shell case above.
  const result = await terminalManager.executeCommand(
    'this-command-does-not-exist-4f2a', 3000, false
  );
  await settle();

  assert.strictEqual(uncaught, null,
    `missing command escaped as an uncaught exception: ${uncaught && uncaught.message}`);
  assert.ok(result, 'executeCommand must return a result, not hang');
  assert.ok(result.pid > 0,
    `command runs via the default shell, so a real pid is expected; got ${result.pid}`);
  assert.ok(/not found|not recognized/i.test(result.output),
    `expected the shell's command-not-found error, got ${JSON.stringify(result.output)}`);
  console.log('✓ missing command via default shell returns exit-127 output without crashing');
}

async function testHealthyCommandStillWorks() {
  const result = await terminalManager.executeCommand('echo roundtrip-ok', 8000);
  await settle();

  assert.strictEqual(uncaught, null, 'healthy command must not raise');
  assert.ok(result.pid > 0, `expected a real pid, got ${result.pid}`);
  assert.ok(/roundtrip-ok/.test(result.output),
    `expected command output, got ${JSON.stringify(result.output)}`);
  console.log('✓ a normal command still runs after the error handler was added');
}

async function main() {
  console.log('=== spawn error handling ===\n');
  await testBogusShellDoesNotCrash();
  await testMissingCommandThroughShellDoesNotCrash();
  await testHealthyCommandStillWorks();
  console.log('\nAll spawn-error tests passed.');
}

main().catch((err) => {
  console.error('✗ FAILED:', err.message);
  process.exit(1);
});
