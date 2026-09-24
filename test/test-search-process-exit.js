/**
 * A process that ran a search must be able to exit on its own (#3).
 * The search manager's cleanup interval used to be started by the first
 * search and never unref'd, so it kept any process that loaded the search
 * manager alive: a test, a script, a server on its way out.
 */

import assert from 'assert';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { runIfMain } from './helpers/run-if-main.js';

const EXIT_WITHIN_MS = 10_000;
const searchManagerUrl = new URL('../dist/search-manager.js', import.meta.url).href;

export default async function runTests() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-search-exit-'));
  await fs.writeFile(path.join(dir, 'a.txt'), 'needle\n');

  // Runs one search to completion, then has nothing left to do
  const script = `
    const { searchManager } = await import(${JSON.stringify(searchManagerUrl)});
    const { sessionId } = await searchManager.startSearch({ rootPath: ${JSON.stringify(dir)}, pattern: 'needle', searchType: 'content' });
    while (!(await searchManager.readSearchResults(sessionId, 0, 10)).isComplete) await new Promise((r) => setTimeout(r, 50));
    console.log('search complete');
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });

  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), EXIT_WITHIN_MS);
    child.on('exit', () => { clearTimeout(timer); resolve(true); });
  });
  if (!exited) child.kill();
  await fs.rm(dir, { recursive: true, force: true });

  assert.ok(output.includes('search complete'), `the search should complete, got: ${output.trim() || 'no output'}`);
  assert.ok(exited, `a process that ran a search should exit on its own; still running after ${EXIT_WITHIN_MS}ms`);
  console.log('✓ a process that ran a search exits on its own');
  return true;
}

runIfMain(import.meta.url, runTests);
