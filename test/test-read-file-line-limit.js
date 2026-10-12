/**
 * read_file without `length` reads as many lines as the fileReadLineLimit
 * setting says ("default: configurable via 'fileReadLineLimit' setting").
 *
 * The user's symptom: after set_config_value fileReadLineLimit 10, read_file
 * on a 50-line file still returned all 50 lines, because the argument schema
 * filled in its own default (1000) before the setting was consulted.
 * An explicit `length` still wins, including an explicit 1000.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { configManager } from '../dist/config-manager.js';
import { setConfigValue } from '../dist/tools/config.js';
import { handleReadFile } from '../dist/handlers/filesystem-handlers.js';
import { runIfMain, skip } from './helpers/run-if-main.js';
import { isTestHome } from './helpers/test-env.js';

/** The "[Reading N lines ...]" status line and the lines after it */
function readLines(result) {
  const text = result.content[0].text;
  const [status, ...rest] = text.split('\n\n');
  return { status, lines: rest.join('\n\n').split('\n') };
}

export default async function runTests() {
  if (!isTestHome()) {
    skip('test-read-file-line-limit changes fileReadLineLimit: run it through node test/run-all-tests.js');
    return true;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-read-limit-'));
  const file = path.join(dir, 'fifty.txt');
  fs.writeFileSync(file, Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n'));
  const originalConfig = await configManager.getConfig();
  const failures = [];
  const check = (condition, message) => {
    console.log(`${condition ? '✅' : '❌'} ${message}`);
    if (!condition) failures.push(message);
  };

  try {
    const set = await setConfigValue({ key: 'fileReadLineLimit', value: 10 });
    check(!set.isError, `set_config_value fileReadLineLimit 10 succeeds (${set.content[0].text.split('\n')[0]})`);

    const byDefault = readLines(await handleReadFile({ path: file }));
    check(
      byDefault.lines.length === 10 && byDefault.lines[9] === 'line 10',
      `with fileReadLineLimit 10, read_file without length returns 10 lines, got ${byDefault.lines.length} (${byDefault.status})`
    );

    const explicit = readLines(await handleReadFile({ path: file, length: 20 }));
    check(explicit.lines.length === 20, `an explicit length 20 still returns 20 lines, got ${explicit.lines.length} (${explicit.status})`);

    const explicit1000 = readLines(await handleReadFile({ path: file, length: 1000 }));
    check(explicit1000.lines.length === 50, `an explicit length 1000 still returns all 50 lines, got ${explicit1000.lines.length} (${explicit1000.status})`);
  } catch (error) {
    check(false, `unexpected error: ${error.stack ?? error}`);
  } finally {
    await configManager.updateConfig(originalConfig);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return failures.length === 0;
}

runIfMain(import.meta.url, runTests);
