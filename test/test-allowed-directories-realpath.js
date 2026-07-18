import assert from 'assert';
import os from 'os';
import path from 'path';
import fsp from 'fs/promises';
import { validatePath } from '../dist/tools/filesystem.js';
import { configManager } from '../dist/config-manager.js';

/**
 * Regression test for #590: a configured allowlist entry that points at a
 * symlink was rejected for its own children.
 *
 * validatePath() canonicalizes the requested path with fs.realpath (so on macOS
 * "/tmp/x" becomes "/private/tmp/x"), but isPathAllowed() used to compare that
 * against the raw, unresolved allowlist entry. The two never matched and every
 * access to the allowed directory failed.
 *
 * This reproduces the mismatch portably with an explicit symlink instead of the
 * macOS /tmp alias: the allowlist entry is the symlink, the requested paths
 * resolve to its target. If directory symlinks cannot be created (Windows
 * without the privilege), the test skips rather than failing.
 */

let passed = 0;
const ok = (msg) => { passed++; console.log(`✓ ${msg}`); };

async function run() {
  const base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'dc-allow-realpath-')));
  const target = path.join(base, 'real-target');
  const link = path.join(base, 'link');
  const outside = path.join(base, 'outside');
  await fsp.mkdir(target);
  await fsp.mkdir(outside);

  try {
    await fsp.symlink(target, link, 'dir');
  } catch (e) {
    console.log(`SKIP: cannot create directory symlink on this platform (${e.code})`);
    await fsp.rm(base, { recursive: true, force: true });
    return 'skipped';
  }

  const original = await configManager.getConfig();
  const originalAllowed = original.allowedDirectories;
  try {
    // Allowlist the symlink itself, not its resolved target.
    await configManager.setValue('allowedDirectories', [link]);

    const resolvedTarget = await fsp.realpath(target);

    // 1) The allowed directory itself validates and resolves to the target.
    {
      const validated = await validatePath(link);
      assert.strictEqual(await fsp.realpath(validated), resolvedTarget,
        'allowed symlink directory should validate and resolve to its target');
      ok('allowlisted symlink directory is accepted');
    }

    // 2) An existing child under the symlink validates (read/list/search path).
    {
      const childFile = path.join(link, 'child.txt');
      await fsp.writeFile(path.join(target, 'child.txt'), 'hello');
      const validated = await validatePath(childFile);
      assert.strictEqual(await fsp.realpath(validated), path.join(resolvedTarget, 'child.txt'),
        'existing child under the allowed symlink should validate');
      ok('existing child under the allowlisted symlink is accepted');
    }

    // 3) A not-yet-created child under the symlink validates (write path).
    {
      const newChild = path.join(link, 'new-file.txt');
      const validated = await validatePath(newChild);
      assert.strictEqual(path.dirname(await fsp.realpath(path.dirname(validated))), path.dirname(resolvedTarget),
        'new child under the allowed symlink should validate against the target');
      ok('not-yet-created child under the allowlisted symlink is accepted');
    }

    // 4) A path outside the allowed directory is still rejected — the fix must
    //    not widen access beyond the configured entry.
    {
      await assert.rejects(
        () => validatePath(path.join(outside, 'secret.txt')),
        /Path not allowed/,
        'paths outside the allowed directory must still be rejected');
      ok('path outside the allowlisted directory is still rejected');
    }
  } finally {
    await configManager.setValue('allowedDirectories', originalAllowed);
    await fsp.rm(base, { recursive: true, force: true });
  }
}

run()
  .then((result) => {
    if (result === 'skipped') { console.log('\nSKIPPED'); process.exit(0); }
    console.log(`\nPASS (${passed}/4)`);
    process.exit(0);
  })
  .catch((e) => { console.error(`\nFAIL: ${e.message}`); process.exit(1); });
