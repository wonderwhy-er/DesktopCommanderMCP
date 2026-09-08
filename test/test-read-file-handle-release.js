import assert from 'assert';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { readFile } from '../dist/tools/filesystem.js';
import { configManager } from '../dist/config-manager.js';

async function run() {
  const original = await configManager.getConfig();
  const originalAllowed = original.allowedDirectories;
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dc-read-handle-')));
  const target = path.join(tmpDir, 'large.txt');
  const replacement = path.join(tmpDir, 'replacement.txt');
  const endTarget = path.join(tmpDir, 'large-end.txt');
  const endReplacement = path.join(tmpDir, 'end-replacement.txt');
  const content = Array.from({ length: 2000 }, (_, index) => `line ${index + 1}`).join('\n');

  try {
    await fs.writeFile(target, content);
    await fs.writeFile(replacement, 'replacement content\n');
    await fs.writeFile(endTarget, content);
    await fs.writeFile(endReplacement, 'end replacement content\n');
    await configManager.setValue('allowedDirectories', [tmpDir]);

    const result = await readFile(target, { offset: 0, length: 1000 });
    assert.ok(result.content.includes('line 1000'), 'truncated prefix should be returned');

    await fs.rename(replacement, target);
    assert.strictEqual(await fs.readFile(target, 'utf8'), 'replacement content\n');

    const endResult = await readFile(endTarget, { offset: -1000 });
    assert.ok(endResult.content.includes('line 2000'), 'suffix read should include the final line');
    await fs.rename(endReplacement, endTarget);
    assert.strictEqual(await fs.readFile(endTarget, 'utf8'), 'end replacement content\n');

    console.log('PASS: bounded reads release files before atomic replacement');
  } finally {
    await configManager.setValue('allowedDirectories', originalAllowed);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(`FAIL: ${error.stack || error.message}`);
  process.exit(1);
});
