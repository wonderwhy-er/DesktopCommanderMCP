/**
 * Desktop Commander starts the programs it names (shells, tasklist, python,
 * cmd) from PATH, never a file of the same name in its working folder.
 *
 * On Windows a bare program name was looked up in the working folder before
 * PATH, so a powershell.exe, cmd.exe, tasklist.exe or python.exe in the folder
 * the server was started in (a project folder, say) ran instead of the real
 * program: for every start_process command (the default shell is
 * "powershell.exe"), for list_processes, for the Python check that system info
 * runs at startup, and for opening the welcome page. The stand-ins here are
 * hard links to node, which fail on the program's arguments, and, for the
 * Python check, batch files that leave a marker file. The test clears
 * NoDefaultCurrentDirectoryInExePath while it runs: some machines set it, and
 * it makes cmd.exe (not the other lookups) skip the working folder.
 *
 * Top-level script, Windows only; nothing outside a temporary folder is touched.
 */
import assert from 'assert';
import childProcess from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import { syncBuiltinESMExports } from 'module';
import os from 'os';
import path from 'path';
import { startProcess } from '../dist/tools/improved-process-tools.js';
import { listProcesses } from '../dist/tools/process.js';
import { getSystemInfo } from '../dist/utils/system-info.js';
import { openBrowser } from '../dist/utils/open-browser.js';
import { runIfMain, skip } from './helpers/run-if-main.js';

const STAND_INS = ['powershell.exe', 'cmd.exe', 'tasklist.exe'];
const PYTHON_STAND_INS = ['python.bat', 'python3.bat', 'py.bat'];
const MARKER = 'stand-in-ran.txt';

function placeStandIn(dir, name) {
  const target = path.join(dir, name);
  try {
    fs.linkSync(process.execPath, target);
  } catch {
    // A hard link needs the same volume: copy instead
    fs.copyFileSync(process.execPath, target);
  }
}

async function runTests() {
  if (process.platform !== 'win32') {
    skip('program lookup in the working folder: Windows only (macOS/Linux never search it for a bare name)');
    return true;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-program-folder-'));
  STAND_INS.forEach((name) => placeStandIn(dir, name));
  PYTHON_STAND_INS.forEach((name) => fs.writeFileSync(path.join(dir, name), `@echo ran>"%~dp0${MARKER}"\r\n`));
  const originalCwd = process.cwd();
  const noCurrentDirectory = process.env.NoDefaultCurrentDirectoryInExePath;
  delete process.env.NoDefaultCurrentDirectoryInExePath;
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

  async function runsFromPath(shellArgs, what) {
    const text = (await startProcess({ command: 'echo shell-ran', timeout_ms: 15000, ...shellArgs })).content[0].text;
    assert.ok(text.includes('shell-ran') && !text.includes('bad option'),
      `a ${what} in the server's working folder ran instead of the real shell; the answer: ${JSON.stringify(text.slice(0, 300))}`);
  }

  process.chdir(dir);
  try {
    await check('start_process, default shell (powershell.exe), runs from PATH', () => runsFromPath({}, 'powershell.exe'));
    await check('start_process, shell "cmd", runs from PATH', () => runsFromPath({ shell: 'cmd' }, 'cmd.exe'));

    await check('list_processes runs tasklist from PATH', async () => {
      const text = (await listProcesses()).content[0].text;
      assert.ok(text.includes(`PID: ${process.pid},`),
        `a tasklist.exe in the server's working folder ran instead of tasklist; the answer: ${JSON.stringify(text.slice(0, 300))}`);
    });

    await check('the Python check in system info runs python from PATH', () => {
      getSystemInfo();
      assert.ok(!fs.existsSync(path.join(dir, MARKER)), "system info's Python check ran a python.bat from the server's working folder");
    });

    await check('opening the welcome page starts cmd.exe from PATH', async () => {
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
        await openBrowser('https://example.invalid/');
      } finally {
        childProcess.spawn = realSpawn;
        syncBuiltinESMExports();
      }
      assert.ok(path.isAbsolute(started ?? '') && path.dirname(started) !== dir && /^cmd(\.exe)?$/i.test(path.basename(started)),
        `the browser was opened through ${JSON.stringify(started)}, a bare name Windows looks up in the working folder first`);
    });
  } finally {
    process.chdir(originalCwd);
    if (noCurrentDirectory !== undefined) process.env.NoDefaultCurrentDirectoryInExePath = noCurrentDirectory;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  assert.strictEqual(failures.length, 0, `${failures.length} program lookup check(s) failed: ${failures.join('; ')}`);
  console.log('✅ programs start from PATH, not from the working folder');
}

runIfMain(import.meta.url, runTests);
