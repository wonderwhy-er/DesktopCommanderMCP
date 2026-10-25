/**
 * A program Desktop Commander starts by name that isn't on PATH must not be
 * started by its bare name: Windows looks a bare name up in the working folder
 * first, so a cmd.exe, powershell.exe or tasklist.exe there would run instead.
 * The call answers "<name> was not found on PATH" instead (start_process with
 * that shell, list_processes, opening the welcome page). The Python check in
 * system info already skips a python that isn't on PATH.
 *
 * PATH is set in this process: Windows gives a child process its own values of
 * some variables, so the test doesn't rely on one. The stand-ins are hard links
 * to node that leave a marker file as they start (NODE_OPTIONS --require), and,
 * for the Python check, batch files that do the same. Windows only; nothing
 * outside a temporary folder is touched.
 */
import assert from 'assert';
import childProcess from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import { syncBuiltinESMExports } from 'module';
import path from 'path';
import { startProcess } from '../dist/tools/improved-process-tools.js';
import { listProcesses } from '../dist/tools/process.js';
import { getSystemInfo } from '../dist/utils/system-info.js';
import { openBrowser } from '../dist/utils/open-browser.js';
import { runIfMain, skip } from './helpers/run-if-main.js';
import { createTempDir } from './helpers/test-env.js';

const STAND_INS = ['powershell.exe', 'cmd.exe', 'tasklist.exe'];
const PYTHON_STAND_INS = ['python.bat', 'python3.bat', 'py.bat'];

function placeStandIn(dir, name) {
  const target = path.join(dir, name);
  try {
    fs.linkSync(process.execPath, target);
  } catch {
    // A hard link needs the same volume: copy instead
    fs.copyFileSync(process.execPath, target);
  }
}

/** The stand-ins that ran, by the markers they left */
const ranIn = (dir) => fs.readdirSync(dir).filter((file) => file.startsWith('ran-')).map((file) => file.slice(4, -4));

async function runTests() {
  if (process.platform !== 'win32') {
    return skip('a program not on PATH: Windows only (macOS/Linux never search the working folder for a bare name)');
  }

  const dir = createTempDir('dc-program-not-on-path-');
  const emptyPath = path.join(dir, 'empty-path');
  fs.mkdirSync(emptyPath);
  STAND_INS.forEach((name) => placeStandIn(dir, name));
  // Each stand-in (node) runs this first, so a start leaves ran-<name>.txt
  fs.writeFileSync(path.join(dir, 'mark.cjs'),
    "require('fs').writeFileSync(require('path').join(__dirname, 'ran-' + require('path').basename(process.execPath).toLowerCase() + '.txt'), '')\n");
  PYTHON_STAND_INS.forEach((name) => fs.writeFileSync(path.join(dir, name), `@echo ran>"%~dp0ran-${name}.txt"\r\n`));

  const saved = { cwd: process.cwd(), PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS,
    noCurrentDirectory: process.env.NoDefaultCurrentDirectoryInExePath };
  const failures = [];

  async function check(name, test) {
    try {
      await test();
      console.log(`✓ ${name}`);
    } catch (error) {
      failures.push(name);
      console.error(`✗ ${name}: ${error.message}`);
    }
  }

  /**
   * The stand-in `file` didn't run: no marker, and no answer of node's own (a
   * stand-in stops at an option node doesn't know, "bad option", before the marker)
   */
  function notRun(file, answer = '') {
    assert.ok(!ranIn(dir).includes(file) && !/bad option|node:internal/.test(answer),
      `the ${file} in the server's working folder ran${answer ? `; the answer: ${JSON.stringify(answer.slice(0, 200))}` : ''}`);
  }

  process.chdir(dir);
  process.env.PATH = emptyPath;
  // Forward slashes: NODE_OPTIONS reads a backslash in quotes as an escape
  process.env.NODE_OPTIONS = `--require "${path.join(dir, 'mark.cjs').replace(/\\/g, '/')}"`;
  delete process.env.NoDefaultCurrentDirectoryInExePath;
  try {
    for (const shell of ['cmd', 'powershell.exe']) {
      await check(`start_process with shell "${shell}", not on PATH: an error, the stand-in not run`, async () => {
        const outcome = await startProcess({ command: 'echo shell-ran', shell, timeout_ms: 15000 })
          .then((result) => `answered: ${result.content[0].text}`, (error) => String(error));
        notRun(shell.endsWith('.exe') ? shell : `${shell}.exe`, outcome);
        assert.strictEqual(outcome, `Error: ${shell} was not found on PATH`, `start_process should fail with "${shell} was not found on PATH"`);
      });
    }

    await check('list_processes with tasklist not on PATH: an error, the stand-in not run', async () => {
      const result = await listProcesses();
      notRun('tasklist.exe', result.content[0].text);
      assert.ok(result.isError && result.content[0].text === 'Error: Failed to list processes: tasklist was not found on PATH',
        `list_processes should answer that tasklist was not found on PATH, got: ${JSON.stringify(result.content[0].text.slice(0, 300))}`);
    });

    await check('opening the welcome page with cmd not on PATH: an error, nothing started', async () => {
      const realSpawn = childProcess.spawn;
      let started;
      childProcess.spawn = (file) => {
        started = file;
        const fake = new EventEmitter();
        setImmediate(() => fake.emit('close', 0));
        return fake;
      };
      syncBuiltinESMExports();
      try {
        await assert.rejects(openBrowser('https://example.invalid/'), /^Error: cmd was not found on PATH$/,
          'opening the browser should fail with "cmd was not found on PATH"');
      } finally {
        childProcess.spawn = realSpawn;
        syncBuiltinESMExports();
      }
      assert.strictEqual(started, undefined, `the browser was opened through ${JSON.stringify(started)}, a bare name Windows looks up in the working folder first`);
    });

    await check('the Python check in system info, python not on PATH: no stand-in run', () => {
      getSystemInfo();
      PYTHON_STAND_INS.forEach((name) => notRun(name));
    });
  } finally {
    process.chdir(saved.cwd);
    process.env.PATH = saved.PATH;
    if (saved.NODE_OPTIONS === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = saved.NODE_OPTIONS;
    if (saved.noCurrentDirectory !== undefined) process.env.NoDefaultCurrentDirectoryInExePath = saved.noCurrentDirectory;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  assert.strictEqual(failures.length, 0, `${failures.length} check(s) failed: ${failures.join('; ')}`);
  console.log('✅ a program not on PATH is an error, never a file of that name in the working folder');
  return true;
}

runIfMain(import.meta.url, runTests);
