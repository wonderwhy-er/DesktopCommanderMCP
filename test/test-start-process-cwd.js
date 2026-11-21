/**
 * Tests for optional `cwd` (working directory) parameter on `start_process` (#1070).
 *
 * Covers:
 *   1. Schema acceptance of optional string `cwd` and rejection of non-string `cwd`
 *   2. Valid `cwd` spawns the process in that exact directory (default shell + Git Bash/POSIX bash if available)
 *   3. Omitted `cwd` preserves backward-compatible default behavior
 *   4. Non-existent `cwd` fails clearly before spawn
 *   5. Regular file passed as `cwd` fails clearly before spawn
 *   6. Empty / whitespace-only `cwd` fails clearly before spawn
 *   7. Disallowed `cwd` outside `allowedDirectories` is rejected (security boundary)
 *   8. `node:local` honors `cwd` for `process.cwd()`
 */
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startProcess, interactWithProcess, forceTerminate } from '../dist/tools/improved-process-tools.js';
import { StartProcessArgsSchema } from '../dist/tools/schemas.js';
import { configManager } from '../dist/config-manager.js';
import { resolveShellPath } from '../dist/utils/shell.js';
import { runIfMain } from './helpers/run-if-main.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

function normalizeForCompare(p) {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export default async function runTests() {
  const originalConfig = await configManager.getConfig();
  const baseTemp = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-start-process-cwd-'));
  const allowedDir = path.join(baseTemp, 'allowed');
  const workDir = path.join(allowedDir, 'project-sub');
  const disallowedDir = path.join(baseTemp, 'outside');
  const regularFile = path.join(allowedDir, 'not-a-dir.txt');
  const missingDir = path.join(allowedDir, 'does-not-exist');

  await fs.mkdir(workDir, { recursive: true });
  await fs.mkdir(disallowedDir, { recursive: true });
  await fs.writeFile(regularFile, 'hello', 'utf8');

  const realWorkDir = await fs.realpath(workDir);
  const realAllowedDir = await fs.realpath(allowedDir);

  try {
    // 1. Schema checks
    const validParsed = StartProcessArgsSchema.safeParse({
      command: 'echo hi',
      timeout_ms: 5000,
      cwd: workDir,
    });
    assert.strictEqual(validParsed.success, true, 'Schema should accept optional string cwd');
    assert.strictEqual(validParsed.data.cwd, workDir);

    const invalidParsed = StartProcessArgsSchema.safeParse({
      command: 'echo hi',
      timeout_ms: 5000,
      cwd: 123,
    });
    assert.strictEqual(invalidParsed.success, false, 'Schema should reject non-string cwd');
    console.log('✓ schema accepts optional string cwd and rejects non-string cwd');

    // Restrict allowedDirectories to allowedDir so we test both allowed and disallowed paths
    await configManager.setValue('allowedDirectories', [realAllowedDir]);

    // 2. Valid cwd spawns process in that directory (default shell)
    const cwdMarker = 'CWD_OUT=';
    const nodeCmd = `node -e "console.log('${cwdMarker}' + process.cwd())"`;
    const resValid = await startProcess({
      command: nodeCmd,
      timeout_ms: 15000,
      cwd: workDir,
    });
    assert.ok(!resValid.isError, `Expected valid cwd to succeed, got: ${resValid.content?.[0]?.text}`);
    const outText = resValid.content?.[0]?.text ?? '';
    const match = outText.match(/CWD_OUT=(.+)/);
    assert.ok(match, `Expected CWD_OUT line in output, got: ${outText}`);
    const reportedCwd = await fs.realpath(match[1].trim());
    assert.strictEqual(
      normalizeForCompare(reportedCwd),
      normalizeForCompare(realWorkDir),
      `Expected process cwd ${realWorkDir}, got ${reportedCwd}`
    );
    console.log('✓ valid cwd starts process in the requested directory (default shell)');

    // 2b. Valid cwd with bash if installed (verifies login-shell -l + CHERE_INVOKING on Windows Git Bash / POSIX bash)
    const bashPath = resolveShellPath(process.platform === 'win32' ? 'bash.exe' : 'bash');
    if (bashPath) {
      const resBash = await startProcess({
        command: nodeCmd,
        timeout_ms: 15000,
        shell: bashPath,
        cwd: workDir,
      });
      assert.ok(!resBash.isError, `Expected valid cwd with bash to succeed, got: ${resBash.content?.[0]?.text}`);
      const bashOut = resBash.content?.[0]?.text ?? '';
      const bashMatch = bashOut.match(/CWD_OUT=(.+)/);
      assert.ok(bashMatch, `Expected CWD_OUT line in bash output, got: ${bashOut}`);
      const reportedBashCwd = await fs.realpath(bashMatch[1].trim());
      assert.strictEqual(
        normalizeForCompare(reportedBashCwd),
        normalizeForCompare(realWorkDir),
        `Expected bash process cwd ${realWorkDir}, got ${reportedBashCwd}`
      );
      console.log('✓ valid cwd starts process in the requested directory (bash)');
    }

    // 3. Omitted cwd preserves backward-compatible default behavior
    const resOmitted = await startProcess({
      command: 'echo cwd-omitted-ok',
      timeout_ms: 10000,
    });
    assert.ok(!resOmitted.isError, `Expected omitted cwd to succeed, got: ${resOmitted.content?.[0]?.text}`);
    assert.ok(
      (resOmitted.content?.[0]?.text ?? '').includes('cwd-omitted-ok'),
      `Expected command output when cwd is omitted, got: ${resOmitted.content?.[0]?.text}`
    );
    console.log('✓ omitted cwd preserves backward-compatible default behavior');

    // 4. Non-existent cwd returns clear error before spawn
    const resMissing = await startProcess({
      command: 'echo should-not-run',
      timeout_ms: 5000,
      cwd: missingDir,
    });
    assert.strictEqual(resMissing.isError, true, 'Expected non-existent cwd to return isError: true');
    assert.match(
      resMissing.content?.[0]?.text ?? '',
      /Working directory does not exist/i,
      `Expected clear non-existent cwd error, got: ${resMissing.content?.[0]?.text}`
    );
    console.log('✓ non-existent cwd returns a clear error before spawn');

    // 5. Regular file passed as cwd returns clear error before spawn
    const resFile = await startProcess({
      command: 'echo should-not-run',
      timeout_ms: 5000,
      cwd: regularFile,
    });
    assert.strictEqual(resFile.isError, true, 'Expected file path cwd to return isError: true');
    assert.match(
      resFile.content?.[0]?.text ?? '',
      /not a directory/i,
      `Expected clear not-a-directory error, got: ${resFile.content?.[0]?.text}`
    );
    console.log('✓ regular file passed as cwd returns a clear error before spawn');

    // 6. Empty / whitespace-only cwd returns clear error before spawn
    const resEmpty = await startProcess({
      command: 'echo should-not-run',
      timeout_ms: 5000,
      cwd: '   ',
    });
    assert.strictEqual(resEmpty.isError, true, 'Expected empty cwd to return isError: true');
    assert.match(
      resEmpty.content?.[0]?.text ?? '',
      /cannot be empty/i,
      `Expected clear empty cwd error, got: ${resEmpty.content?.[0]?.text}`
    );
    console.log('✓ empty/whitespace cwd returns a clear error before spawn');

    // 7. Security boundary: cwd outside allowedDirectories is rejected
    const resDisallowed = await startProcess({
      command: 'echo should-not-run',
      timeout_ms: 5000,
      cwd: disallowedDir,
    });
    assert.strictEqual(resDisallowed.isError, true, 'Expected disallowed cwd to return isError: true');
    assert.match(
      resDisallowed.content?.[0]?.text ?? '',
      /Path not allowed/i,
      `Expected Path not allowed error, got: ${resDisallowed.content?.[0]?.text}`
    );
    console.log('✓ cwd outside allowedDirectories is rejected');

    // 8. node:local honors cwd
    const resNodeLocal = await startProcess({
      command: 'node:local',
      timeout_ms: 10000,
      cwd: workDir,
    });
    assert.ok(!resNodeLocal.isError, `Expected node:local with valid cwd to succeed, got: ${resNodeLocal.content?.[0]?.text}`);
    const virtualPid = resNodeLocal.structuredContent?.pid;
    assert.ok(typeof virtualPid === 'number' && virtualPid < 0, `Expected negative virtual PID, got: ${virtualPid}`);
    try {
      const interactRes = await interactWithProcess({
        pid: virtualPid,
        input: "console.log('NODE_LOCAL_CWD=' + process.cwd());",
        timeout_ms: 10000,
      });
      assert.ok(!interactRes.isError, `Expected node:local interact to succeed, got: ${interactRes.content?.[0]?.text}`);
      const nlMatch = (interactRes.content?.[0]?.text ?? '').match(/NODE_LOCAL_CWD=(.+)/);
      assert.ok(nlMatch, `Expected NODE_LOCAL_CWD in output, got: ${interactRes.content?.[0]?.text}`);
      const nlCwd = await fs.realpath(nlMatch[1].trim());
      assert.strictEqual(
        normalizeForCompare(nlCwd),
        normalizeForCompare(realWorkDir),
        `Expected node:local cwd ${realWorkDir}, got ${nlCwd}`
      );
      console.log('✓ node:local honors cwd');
    } finally {
      await forceTerminate({ pid: virtualPid });
    }

    console.log('\nAll start_process cwd tests passed!');
    return true;
  } finally {
    await configManager.updateConfig(originalConfig);
    await fs.rm(baseTemp, { recursive: true, force: true });
  }
}

runIfMain(import.meta.url, runTests);
