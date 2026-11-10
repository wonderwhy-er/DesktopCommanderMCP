// The Docker installers' restart step stops only the Claude Desktop app.
//
// install-docker.ps1 and install-docker.sh restart the AI app at their end, so
// it loads the new config. install-docker.ps1 stopped every process with
// "claude" in its name, path or command line (Find-ClaudeProcess), and
// install-docker.sh did the same on Linux (`pkill -f "claude"`), so Claude Code
// sessions were stopped too.
//
// The test starts stand-ins with "claude" in their command line: one where the
// Claude Desktop app runs from; two Claude Code stand-ins, one where Claude
// Code runs from (~/.local/bin/claude) and one started from a path under a
// claude-desktop folder; and an editor with a file open in a claude-desktop
// folder. On Linux a second desktop stand-in is an older community build:
// electron running the app.asar in its claude-desktop folder. It asks this
// system's installer which processes are the desktop app: on Windows
// install-docker.ps1's Find-ClaudeProcess, with the folders it looks in moved
// into a temporary folder; on macOS and Linux install-docker.sh's
// find_claude_desktop_pids. Only the test's own stand-ins count in the answer,
// so a Claude Desktop open on the machine changes nothing. Then it runs the
// stop step (Stop-ClaudeProcess, stop_claude_desktop) with the installer's find
// step limited to the stand-ins, so nothing else on the machine is ever
// stopped. The desktop stand-ins must have stopped, and the Claude Code
// stand-ins and the editor must still run.
//
// Before the stand-ins start, the stop step runs with no desktop app running,
// and the installer must go on after it. install-docker.sh runs with set -e,
// and its find step can exit 1 when it finds nothing, as pgrep does on macOS;
// there a stand-in find step finds nothing and exits 1, so nothing on the
// machine is looked at or stopped.
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
 * Starts a stand-in that runs as `file` until it is stopped, with `args` at the
 * end of its command line. On Windows it is a copy of this Node. On macOS and
 * Linux it is a link, so the process takes the link's name: to sleep, or to
 * this Node when there are `args`.
 */
async function startStandIn(file, args = []) {
  mkdirSync(path.dirname(file), { recursive: true });
  const node = windows || args.length > 0;
  if (windows) copyFileSync(process.execPath, file);
  else symlinkSync(node ? process.execPath : '/bin/sleep', file);
  const child = spawn(file, node ? ['-e', 'setInterval(() => {}, 1000)', ...args] : ['600'], { stdio: 'ignore' });
  await once(child, 'spawn');
  return child;
}

// Where each app runs from, inside the temporary folder
const desktopFile = {
  windows: path.join(temp, 'Program Files', 'WindowsApps', 'Claude_9.9.9.0_x64__standin', 'app', 'Claude.exe'),
  macos: path.join(temp, 'Applications', 'Claude.app', 'Contents', 'MacOS', 'Claude'),
  linux: path.join(temp, 'usr', 'lib', 'claude-desktop', 'claude-desktop'),
}[platform];
const codeFiles = [
  path.join(temp, 'home', '.local', 'bin', windows ? 'claude.exe' : 'claude'),
  path.join(temp, 'home', 'claude-desktop', 'tools', windows ? 'claude.exe' : 'claude'),
];
const editorFile = path.join(temp, 'bin', windows ? 'editor.exe' : 'editor');
const editorArgs = [path.join(temp, 'home', 'claude-desktop', 'notes.txt')];
// Older community builds for Linux: electron, given the app.asar in the build's claude-desktop folder
const electronDir = path.join(temp, 'usr', 'lib', 'claude-desktop', 'node_modules', 'electron', 'dist');

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

const nothingRuns = windows
  ? runInstallerPs1('Write-Output ("STOPPED " + (Stop-ClaudeProcess))', { env: movedEnv })
  : runInstallerSh(`OS=${platform}; find_claude_desktop_pids() { return 1; }; stop_claude_desktop; echo "AFTER THE STOP STEP"`);
check('with no desktop app running, the installer goes on after the stop step',
  (windows ? /^STOPPED True$/m : /^AFTER THE STOP STEP$/m).test(nothingRuns.stdout), `exit code ${nothingRuns.status}`);

const desktops = [await startStandIn(desktopFile)];
if (platform === 'linux') desktops.push(await startStandIn(path.join(electronDir, 'electron'), [path.join(electronDir, 'resources', 'app.asar')]));
const codes = [];
for (const file of codeFiles) codes.push(await startStandIn(file));
const editor = await startStandIn(editorFile, editorArgs);
const standIns = [...desktops, ...codes, editor];
const standInPids = standIns.map((child) => child.pid);
const desktopPids = desktops.map((child) => child.pid);
const codePids = codes.map((child) => child.pid);
const theDesktops = desktops.length > 1 ? 'the desktop stand-ins' : 'the desktop stand-in';
try {
  check('the stand-ins run', standInPids.every((pid) => isRunning(pid)),
    `desktop ${desktopPids.join(', ')}, Claude Code ${codePids.join(', ')}, editor ${editor.pid}`);

  const found = windows
    ? runInstallerPs1('Write-Output ("PIDS " + (ConvertTo-Json -Compress -InputObject @(Find-ClaudeProcess | ForEach-Object { $_.Id })))', { env: movedEnv })
    : runInstallerSh(`OS=${platform} && find_claude_desktop_pids`);
  if (!windows && found.status === 127) {
    check('install-docker.sh has find_claude_desktop_pids', false, 'it has no way to find only the desktop app');
  } else {
    const pids = windows
      ? JSON.parse(/^PIDS (.*)$/m.exec(found.stdout)?.[1] ?? 'null') ?? []
      : found.stdout.split('\n').filter(Boolean).map(Number);
    const installer = windows ? "install-docker.ps1's Find-ClaudeProcess" : "install-docker.sh's find_claude_desktop_pids";
    check(`${installer} finds ${theDesktops}`, desktopPids.every((pid) => pids.includes(pid)), `found the stand-ins ${JSON.stringify(pids.filter((pid) => standInPids.includes(pid)))}`);
    check(`${installer} doesn't find the Claude Code stand-ins`, !codePids.some((pid) => pids.includes(pid)));
    check(`${installer} doesn't find the editor with a file in a claude-desktop folder`, !pids.includes(editor.pid));

    // The stop step, with the installer's find step limited to the stand-ins: it can stop nothing
    // else on the machine, not even a Claude Desktop that is open there
    const limitFind = windows
      ? `$installerFind = \${function:Find-ClaudeProcess}\nfunction Find-ClaudeProcess { & $installerFind | Where-Object { $_.Id -in @(${standInPids.join(', ')}) } }`
      : `eval "installer_$(declare -f find_claude_desktop_pids)"; find_claude_desktop_pids() { installer_find_claude_desktop_pids | grep -x -e ${standInPids.join(' -e ')}; }`;
    const stopped = windows
      ? runInstallerPs1(`${limitFind}\n$null = Stop-ClaudeProcess`, { env: movedEnv })
      : runInstallerSh(`OS=${platform}; ${limitFind}; stop_claude_desktop`);
    check(`the stop step stops ${theDesktops}`, (await waitForExit(desktopPids)).length === 0, stopped.status === 0 ? '' : stopped.stderr.trim());
    check('the Claude Code stand-ins still run', codePids.every((pid) => isRunning(pid)));
    check('the editor still runs', isRunning(editor.pid));
  }
} finally {
  for (const child of standIns) if (isRunning(child.pid)) child.kill();
  await waitForExit(standInPids);
  rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
process.exitCode = failed ? 1 : 0;
