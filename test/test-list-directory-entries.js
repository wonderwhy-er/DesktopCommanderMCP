/**
 * list_directory marks each entry [FILE] or [DIR] and lists into directories
 * down to `depth`.
 * - A folder reached through a link (a junction on Windows, a symlink
 *   elsewhere) is a directory: it was listed as "[FILE] <link>" and never
 *   listed into, because the entry itself is a link, not a directory.
 *
 * Top-level script: every case runs and reports; nothing outside a temporary
 * folder is touched.
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { handleListDirectory } from '../dist/handlers/filesystem-handlers.js';
import { runIfMain } from './helpers/run-if-main.js';

async function runTests() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-list-entries-'));
  const failures = [];

  async function list(dirPath, depth) {
    const result = await handleListDirectory({ path: dirPath, depth });
    assert.notStrictEqual(result.isError, true, `list_directory failed: ${result.content[0].text}`);
    return result.content[0].text.split('\n');
  }

  async function check(name, test) {
    try {
      await test();
      console.log(`✓ ${name}`);
    } catch (error) {
      failures.push(name);
      console.error(`✗ ${name}: ${error.message}`);
    }
  }

  try {
    await check('a linked folder is a [DIR] and is listed into', async () => {
      const folder = path.join(root, 'linked');
      const target = path.join(root, 'target');
      fs.mkdirSync(folder);
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'inside.txt'), 'inside');
      // 'junction' needs no admin rights on Windows; the type is ignored elsewhere
      fs.symlinkSync(target, path.join(folder, 'link'), 'junction');

      const lines = await list(folder, 2);
      assert.ok(lines.includes('[DIR] link'),
        `a folder reached through a link should be listed as "[DIR] link", got: ${JSON.stringify(lines)}`);
      assert.ok(lines.includes(`[FILE] ${path.join('link', 'inside.txt')}`),
        `the linked folder should be listed into down to depth 2, got: ${JSON.stringify(lines)}`);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  assert.strictEqual(failures.length, 0, `${failures.length} list_directory check(s) failed: ${failures.join('; ')}`);
  console.log('✅ list_directory lists linked folders as folders');
}

runIfMain(import.meta.url, runTests);
