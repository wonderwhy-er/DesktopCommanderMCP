/**
 * move_file must honor the allowedDirectories boundary on BOTH of its paths.
 *
 * move_file is the only file tool that takes two paths, so it is the one that
 * could carry a file OUT of the allowed directories (exfiltration) or pull one
 * IN from outside them. moveFile() guards this by validating the source and the
 * destination with validatePath() (src/tools/filesystem.ts): the source with
 * { entry: true } first, then the destination. This test pins that boundary so
 * a later change that drops either check is caught.
 *
 * It covers the gap left by the existing suite:
 *  - test-move-file.js exercises move/rename mechanics (links, case-only
 *    renames, cross-volume copy+delete), never the authorization of the paths;
 *  - test-allowed-directories.js exercises validatePath() on a SINGLE path.
 * Neither asserts the compound two-path authorization of the move handler, i.e.
 * that a move cannot cross the allowedDirectories boundary in either direction.
 */
import fs from 'fs/promises';
import path from 'path';
import assert from 'assert';
import { configManager } from '../dist/config-manager.js';
import { handleMoveFile } from '../dist/handlers/filesystem-handlers.js';
import { runIfMain } from './helpers/run-if-main.js';
import { createTempDir } from './helpers/test-env.js';

const text = (result) => result.content.map((c) => c.text).join('\n');
const exists = (p) => fs.lstat(p).then(() => true, () => false);

async function run() {
  // Two sibling trees, each by its real path (as validatePath compares them):
  // one is the single allowed directory, the other is outside it.
  const allowedDir = createTempDir('dc-move-authz-allowed-');
  const outsideDir = createTempDir('dc-move-authz-outside-');
  const originalConfig = await configManager.getConfig();
  try {
    await configManager.setValue('allowedDirectories', [allowedDir]);

    // Positive control: a move entirely within the allowed directory succeeds.
    // Without it, the negative cases below could pass simply because every move
    // is refused for some unrelated reason.
    const insideSrc = path.join(allowedDir, 'inside.txt');
    const insideDst = path.join(allowedDir, 'inside-moved.txt');
    await fs.writeFile(insideSrc, 'inside');
    let answer = text(await handleMoveFile({ source: insideSrc, destination: insideDst }));
    assert.ok(answer.startsWith('Successfully moved'),
      `a move within the allowed directory should succeed, got: ${answer}`);
    assert.ok(await exists(insideDst), 'the moved file should be at its destination');
    assert.ok(!(await exists(insideSrc)), 'the source should be gone after a successful move');

    // Negative control A - exfiltration: an allowed source may not be moved to a
    // destination outside the allowed directories.
    const secret = path.join(allowedDir, 'secret.txt');
    const leaked = path.join(outsideDir, 'leaked.txt');
    await fs.writeFile(secret, 'secret');
    const outResult = await handleMoveFile({ source: secret, destination: leaked });
    answer = text(outResult);
    assert.ok(!answer.startsWith('Successfully moved') && /not allowed/i.test(answer),
      `a move to a destination outside allowedDirectories should be refused, got: ${answer}`);
    assert.strictEqual(outResult.isError, true, 'a refused move should be reported as an error');
    assert.ok(await exists(secret), 'the source file must stay put when the move is refused');
    assert.ok(!(await exists(leaked)), 'nothing should be created outside the allowed directories');

    // Negative control B - import: a source outside the allowed directories may
    // not be moved in, even to an allowed destination.
    const external = path.join(outsideDir, 'external.txt');
    const pulledIn = path.join(allowedDir, 'pulled-in.txt');
    await fs.writeFile(external, 'external');
    const inResult = await handleMoveFile({ source: external, destination: pulledIn });
    answer = text(inResult);
    assert.ok(!answer.startsWith('Successfully moved') && /not allowed/i.test(answer),
      `a move from a source outside allowedDirectories should be refused, got: ${answer}`);
    assert.strictEqual(inResult.isError, true, 'a refused move should be reported as an error');
    assert.ok(await exists(external), 'the outside source must stay put when the move is refused');
    assert.ok(!(await exists(pulledIn)), 'nothing should be created inside the allowed directory from an outside source');

    console.log('✅ move_file allowedDirectories authorization tests passed');
    return true;
  } catch (error) {
    console.error('❌ move_file authorization test failed:', error.message);
    return false;
  } finally {
    // Each test file already runs in its own temporary home, but restore the
    // config and remove the temp trees anyway so the file is safe to run directly.
    await configManager.updateConfig(originalConfig);
    await fs.rm(allowedDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(outsideDir, { recursive: true, force: true }).catch(() => {});
  }
}

runIfMain(import.meta.url, run);
export default run;
