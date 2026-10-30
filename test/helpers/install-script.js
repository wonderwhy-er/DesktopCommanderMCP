/**
 * Runs one of the install scripts (setup-claude-server.js and
 * uninstall-claude-server.js as `npm run setup` and `npm run remove` do, from the
 * root; dist/track-installation.js as postinstall does) in a child process that
 * can't reach the network or another process: https and child_process are
 * stand-ins (helpers/install-stand-ins.js) that record each telemetry post and
 * each command and answer as told. It runs in a fresh temporary home, can take
 * another process.platform, and runs its timers 100 times faster (a restart
 * waits 3 s, a telemetry retry 1-2 s). The setup.log a run starts next to the
 * script is removed after it.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { HOOKS_URL } from './install-stand-ins.js';
import { hookArgs } from './module-hooks.js';
import { ROOT } from './node-test-runner.js';
import { createTempDir, createTestEnv } from './test-env.js';

// Before the script: another platform when asked, and timers scaled down
const PRELOAD = [
  'const { platform, timeScale } = JSON.parse(process.env.DC_STAND_INS);',
  'if (platform) Object.defineProperty(process, "platform", { value: platform });',
  'const realSetTimeout = globalThis.setTimeout;',
  'globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, Math.ceil((ms ?? 0) / timeScale), ...rest);',
].join('\n');

/**
 * Runs `script` (its path from the root) with `args`, and resolves with { code,
 * stdout, stderr, posts: [{ post, event, answer, body }], commands: [command],
 * home: { file: text } }. telemetry, commands and fs are the stand-ins' answers
 * (install-stand-ins.js; fs only when given); `env` adds to the test
 * environment; `prepare(home)` runs before the script
 */
export async function runInstallScript(script, {
  args = [], env = {}, platform, telemetry = {}, commands = { 'npm --version': { stdout: '10.9.0' } }, fs: fsPlan,
  prepare, timeScale = 100, timeoutMs = 60000,
} = {}) {
  const testEnv = createTestEnv();
  const logDir = createTempDir('dc-install-stand-ins-');
  const log = path.join(logDir, 'log.jsonl');
  fs.writeFileSync(log, '');
  const setupLog = path.join(ROOT, path.dirname(script), 'setup.log');
  const hadSetupLog = fs.existsSync(setupLog);
  try {
    await prepare?.(testEnv.home);
    const standIns = JSON.stringify({ log, telemetry, commands, fs: fsPlan, platform, timeScale });
    const preload = `data:text/javascript,${encodeURIComponent(PRELOAD)}`;
    const argv = [...hookArgs(HOOKS_URL), '--import', preload, path.join(ROOT, script), ...args];
    const appData = path.join(testEnv.home, 'AppData', 'Roaming');
    // A variable given as null is left out: the scripts read the terminal's (SHELL, TERM_PROGRAM, …). Windows'
    // names ignore case (COMSPEC is ComSpec): a given one replaces the inherited one, whatever its case
    const given = { APPDATA: appData, ...env, DC_STAND_INS: standIns };
    const sameName = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
    const isGiven = (name) => Object.keys(given).some((each) => sameName(each, name));
    const inherited = Object.entries(testEnv.env).filter(([name]) => !isGiven(name));
    const childEnv = Object.fromEntries([...inherited, ...Object.entries(given)].filter(([, value]) => value != null));
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, argv, { cwd: ROOT, env: childEnv });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
    const entries = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const posts = entries.filter((entry) => entry.post);
    const ran = entries.filter((entry) => entry.command).map((entry) => entry.command);
    return { ...result, posts, commands: ran, home: snapshot(testEnv.home) };
  } finally {
    // A test may have made part of the home read-only: writable again, so it can go
    writable(testEnv.home);
    if (!hadSetupLog) fs.rmSync(setupLog, { recursive: true, force: true });
    fs.rmSync(logDir, { recursive: true, force: true });
    testEnv.cleanup();
  }
}

/** Makes a folder and everything in it writable by its owner */
function writable(dir) {
  fs.chmodSync(dir, 0o755);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) writable(file);
    else fs.chmodSync(file, 0o644);
  }
}

/** The files a home holds after the run, by their path in it (forward slashes), with their text */
function snapshot(home) {
  const files = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else files[path.relative(home, file).split(path.sep).join('/')] = fs.readFileSync(file, 'utf8');
    }
  };
  walk(home);
  return files;
}
