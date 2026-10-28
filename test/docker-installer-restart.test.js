// The Docker installers' restart step stops only the Claude Desktop app.
//
// install-docker.ps1 and install-docker.sh restart the AI app at their end, so
// it loads the new config. install-docker.ps1 stopped every process with
// "claude" in its name, path or command line (Find-ClaudeProcess), and
// install-docker.sh did the same on Linux (`pkill -f "claude"`), so Claude Code
// sessions were stopped too.
//
// The test starts two stand-ins, both with "claude" in their command line: one
// where the Claude Desktop app runs from, and one where Claude Code runs from
// (~/.local/bin/claude). It asks this system's installer which processes are
// the desktop app: on Windows install-docker.ps1's Find-ClaudeProcess, with the
// folders it looks in moved into a temporary folder; on macOS and Linux
// install-docker.sh's find_claude_desktop_pids. Only when the answer is the
// desktop stand-in alone does it run the stop step for real (Stop-ClaudeProcess,
// stop_claude_desktop), so nothing else on the machine is ever stopped. Then
// the desktop stand-in must have stopped, and the Claude Code stand-in must
// still run.
//
// Run, on Windows, macOS or Linux: node test/docker-installer-restart.test.js
// Exit code: 1 if a check fails.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { runInstallerPs1, runInstallerSh } from './helpers/docker-installers.js';
import { isRunning, waitForExit } from './helpers/process-tree.js';
import { createTempDir } from './helpers/test-env.js';

const temp = createTempDir('dc-installer-restart-test-');
const windows = process.platform === 'win32';
const platform = windows ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
let failed = false;

function check(name, ok, detail = '') {
  if (!ok) failed = true;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `: ${detail}` : ''}`);
}

/**
 * Starts a stand-in that runs as `file` until it is stopped. On Windows it is a
 * copy of this Node; on macOS and Linux a link to sleep, so the process takes
 * the link's name.
 */
async function startStandIn(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  if (windows) copyFileSync(process.execPath, file);
  else symlinkSync('/bin/sleep', file);
  const args = windows ? ['-e', 'setInterval(() => {}, 1000)'] : ['600'];
  const child = spawn(file, args, { stdio: 'ignore' });
  await once(child, 'spawn');
  return child;
}

// Where each app runs from, inside the temporary folder
const desktopFile = {
  windows: path.join(temp, 'Program Files', 'WindowsApps', 'Claude_9.9.9.0_x64__standin', 'app', 'Claude.exe'),
  macos: path.join(temp, 'Applications', 'Claude.app', 'Contents', 'MacOS', 'Claude'),
  linux: path.join(temp, 'usr', 'lib', 'claude-desktop', 'claude-desktop'),
}[platform];
const codeFile = path.join(temp, 'home', '.local', 'bin', windows ? 'claude.exe' : 'claude');

// Windows: the folders install-docker.ps1 looks in, moved into the temporary folder. Windows names
// are case-insensitive, so every spelling is dropped first; a 64-bit process gets ProgramFiles from
// ProgramW6432 when it starts, so both are moved.
const moved = {
  ProgramFiles: path.join(temp, 'Program Files'),
  ProgramW6432: path.join(temp, 'Program Files'),
  'ProgramFiles(x86)': path.join(temp, 'Program Files (x86)'),
  LOCALAPPDATA: path.join(temp, 'AppData', 'Local'),
  APPDATA: path.join(temp, 'AppData', 'Roaming'),
  USERPROFILE: path.join(temp, 'home'),
};
const movedEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !Object.keys(moved).some((key) => key.toLowerCase() === name.toLowerCase()))),
  ...moved,
};

const desktop = await startStandIn(desktopFile);
const code = await startStandIn(codeFile);
try {
  check('the two stand-ins run', isRunning(desktop.pid) && isRunning(code.pid), `desktop ${desktop.pid}, Claude Code ${code.pid}`);

  const found = windows
    ? runInstallerPs1('Write-Output ("PIDS " + (ConvertTo-Json -Compress -InputObject @(Find-ClaudeProcess | ForEach-Object { $_.Id })))', { env: movedEnv })
    : runInstallerSh(`OS=${platform} && find_claude_desktop_pids`);
  if (!windows && found.status === 127) {
    check('install-docker.sh has find_claude_desktop_pids', false, 'it has no way to find only the desktop app');
  } else {
    const pids = windows
      ? JSON.parse(/^PIDS (.*)$/m.exec(found.stdout)?.[1] ?? 'null') ?? []
      : found.stdout.split('\n').filter(Boolean).map(Number);
    const others = pids.filter((pid) => pid !== desktop.pid);
    const installer = windows ? "install-docker.ps1's Find-ClaudeProcess" : "install-docker.sh's find_claude_desktop_pids";
    check(`${installer} finds the desktop stand-in`, pids.includes(desktop.pid), `found ${JSON.stringify(pids)}`);
    check(`${installer} finds nothing else`, others.length === 0,
      others.length ? `${others.includes(code.pid) ? 'the Claude Code stand-in and ' : ''}${others.filter((pid) => pid !== code.pid).length} other process(es)` : '');

    // The stop step runs for real only when it can stop nothing but the desktop stand-in
    if (pids.length === 1 && pids[0] === desktop.pid) {
      const stopped = windows
        ? runInstallerPs1('$null = Stop-ClaudeProcess', { env: movedEnv })
        : runInstallerSh(`OS=${platform} && stop_claude_desktop`);
      check('the stop step stops the desktop stand-in', (await waitForExit([desktop.pid])).length === 0, stopped.status === 0 ? '' : stopped.stderr.trim());
      check('the Claude Code stand-in still runs', isRunning(code.pid));
    }
  }
} finally {
  for (const child of [desktop, code]) if (isRunning(child.pid)) child.kill();
  await waitForExit([desktop.pid, code.pid]);
  rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
process.exitCode = failed ? 1 : 0;
