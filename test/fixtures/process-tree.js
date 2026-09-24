/**
 * A process tree for the termination tests. Each process writes its PID to
 * <dir>/<level>.pid (level 1 is the process the command starts), starts the
 * next level until <levels> levels run, and then runs until it is killed.
 *
 * Each level starts the next through a shell, the way npm runs a package
 * script, and shares its stdio, so a survivor keeps its parent's output pipes
 * open. The shell matters on Windows: Node ends the processes it spawns
 * directly when it exits (libuv puts them in a kill-on-close job object), but
 * not the processes those start, so only a tree with a shell in between shows
 * whether a termination reaches the whole tree.
 *
 * Usage: node process-tree.js <dir> <levels> [ignore-sigterm] [spawn-on-sigterm]
 *   ignore-sigterm: every level ignores SIGTERM, so only SIGKILL can end it
 *   (Windows has no SIGTERM to ignore: every kill there is forced).
 *   spawn-on-sigterm: on SIGTERM every level starts one more child, named
 *   late-<level>: a process born after the tree was first walked, while the
 *   termination waits for the tree to exit. The parent records the PID it
 *   started in late-<level>.started.pid (known before the child runs) and
 *   the child writes its own to late-<level>.pid.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const [dir, levels, ...flags] = process.argv.slice(2);
const name = process.env.PROCESS_TREE_LEVEL ?? '1';
const level = Number(name); // NaN for a late child

if (flags.includes('ignore-sigterm')) {
  process.on('SIGTERM', () => {});
}

/** Starts a copy of this script under the given name, through a shell */
function startChild(childName) {
  const args = [process.execPath, fileURLToPath(import.meta.url), dir].map((arg) => `"${arg}"`);
  return spawn([...args, levels, ...flags].join(' '), {
    shell: true,
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, PROCESS_TREE_LEVEL: childName },
  });
}

if (level < Number(levels)) {
  startChild(String(level + 1));
}

if (flags.includes('spawn-on-sigterm') && Number.isInteger(level)) {
  process.once('SIGTERM', () => {
    const late = startChild(`late-${level}`);
    fs.writeFileSync(path.join(dir, `late-${level}.started.pid`), String(late.pid));
  });
}

// Written under a temporary name first, so a reader never sees a partial PID
const pidFile = path.join(dir, `${name}.pid`);
fs.writeFileSync(`${pidFile}.tmp`, String(process.pid));
fs.renameSync(`${pidFile}.tmp`, pidFile);

setInterval(() => {}, 1000);
