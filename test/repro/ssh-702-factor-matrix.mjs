// #702 factor matrix: 8 spawn configurations under 3 parent shapes, run on
// Windows with the system OpenSSH client, separating the ssh -t rewrite, the
// stdio shape and whether the parent has a console. Reports, does not assert.
//   node test/repro/ssh-702-factor-matrix.mjs
import { execSync, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SELF), '..', '..');
const SYSTEM_ROOT = process.env.SystemRoot || process.env.windir || '';
const SSH = path.join(SYSTEM_ROOT, 'System32', 'OpenSSH', 'ssh.exe');
const COMSPEC = process.env.COMSPEC || path.join(SYSTEM_ROOT, 'System32', 'cmd.exe');
const POWERSHELL = path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const PIPES = ['pipe', 'pipe', 'pipe'];
const SPAWN_TIMEOUT_MS = 8_000;

/** Does this process have a console? CONOUT$ opens only when it does. */
function hasConsole() {
  try {
    const fd = openSync('\\\\.\\CONOUT$', 'r+');
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

/** The 8 spawn configurations. Factor A varies in 4 and 6, B in 2 and 3. */
function configurations() {
  return [
    ['ssh.exe -V, all three streams piped', SSH, ['-V'], { stdio: PIPES, windowsHide: true }],
    ['ssh.exe -V, stdin ignored, output piped', SSH, ['-V'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }],
    ['ssh.exe -V, stdin inherited, output piped', SSH, ['-V'], { stdio: ['inherit', 'pipe', 'pipe'], windowsHide: true }],
    ['ssh.exe -t -V, all three streams piped', SSH, ['-t', '-V'], { stdio: PIPES, windowsHide: true }],
    ['cmd.exe /c ssh.exe -V (the Desktop Commander shape)', COMSPEC, ['/c', `${SSH} -V`], { stdio: PIPES, windowsHide: true, windowsVerbatimArguments: true }],
    ['cmd.exe /c ssh.exe -t -V (rewrite included)', COMSPEC, ['/c', `${SSH} -t -V`], { stdio: PIPES, windowsHide: true, windowsVerbatimArguments: true }],
    ["powershell -Command & 'ssh.exe' -V (reporter's defaultShell)", POWERSHELL, ['-Command', `& '${SSH}' -V`], { stdio: PIPES, windowsHide: true }],
    ['powershell -Command ssh -t -V (bare name, rewrite included)', POWERSHELL, ['-Command', 'ssh -t -V'], { stdio: PIPES, windowsHide: true }]
  ];
}

/** Kills the wrapper and everything it started; a lone kill() misses those. */
function killTree(child) {
  if (process.platform === 'win32' && child.pid) {
    try {
      execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' });
      return;
    } catch {
      // already gone
    }
  }
  if (!child.killed) child.kill();
}

function runOne(label, file, args, options) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let spawnError = null;
    let done = false;
    let timer;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(file, args, options);
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => { spawnError = err.message; });
    child.on('close', (exitCode, signal) => finish({
      label,
      exitCode,
      signal,
      spawnError,
      bytes: stdout.length + stderr.length,
      sample: (stdout + stderr).trim().split('\n')[0]?.slice(0, 48) ?? ''
    }));
    timer = setTimeout(() => {
      // Configurations 5-8 spawn a shell, so the binary under test is a
      // grandchild; killing the wrapper leaves it running with the pipes in
      // hand. Measured: after child.kill() the grandchild is still alive, after
      // taskkill /T it is not.
      killTree(child);
      finish({ label, exitCode: null, timedOut: true, bytes: stdout.length + stderr.length, sample: '' });
    }, SPAWN_TIMEOUT_MS);
  });
}

async function runConfigurations() {
  const results = [];
  for (const [label, file, args, options] of configurations()) {
    results.push(await runOne(label, file, args, options));
  }
  return { console: hasConsole(), results };
}

/** Section B passes 2 and 3: the same 8 under a parent with no console. */
function runDetachedPass(stdio) {
  return new Promise((resolve, reject) => {
    const out = path.join(os.tmpdir(), `ssh-702-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    const child = spawn(process.execPath, [SELF], {
      detached: true,           // Windows DETACHED_PROCESS: no console
      stdio,
      windowsHide: true,
      env: { ...process.env, SSH_702_OUT: out }
    });
    if (stdio !== 'ignore') {
      child.stdout?.on('data', () => {});   // drained, as a client drains an MCP server
      child.stderr?.on('data', () => {});
    }
    child.unref();
    const deadline = Date.now() + 90_000;
    const poll = setInterval(() => {
      if (existsSync(out)) {
        clearInterval(poll);
        setTimeout(() => {
          const report = JSON.parse(readFileSync(out, 'utf8'));
          unlinkSync(out);
          resolve(report);
        }, 300);
      } else if (Date.now() > deadline) {
        clearInterval(poll);
        reject(new Error('the detached pass produced no report within 90s'));
      }
    }, 200);
  });
}

/** Section A: the reported command through start_process on this build. */
async function sectionA() {
  const dist = path.join(REPO, 'dist', 'tools', 'improved-process-tools.js');
  if (!existsSync(dist)) {
    console.log('  (skipped: run `npm run build` first)');
    return;
  }
  const home = mkdtempSync(path.join(os.tmpdir(), 'ssh-702-home-'));
  mkdirSync(path.join(home, '.claude-server-commander'), { recursive: true });
  writeFileSync(path.join(home, '.claude-server-commander', 'config.json'), JSON.stringify({
    telemetryEnabled: false, welcomeOnboardingEligible: false, pendingWelcomeOnboarding: false
  }));
  const child = spawn(process.execPath, [SELF], {
    stdio: 'inherit',
    env: { ...process.env, HOME: home, USERPROFILE: home, SSH_702_SECTION_A: '1' }
  });
  await new Promise((resolve) => child.on('exit', resolve));
  rmSync(home, { recursive: true, force: true });
}

async function sectionAWorker() {
  const dist = path.join(REPO, 'dist', 'tools', 'improved-process-tools.js');
  const { startProcess } = await import(pathToFileURL(dist).href);
  const commands = [
    ['the command from the report', 'ssh -V'],
    ['absolute path, rewrite not triggered', `${SSH} -V`],
    ['absolute path, rewrite applied by hand', `${SSH} -t -V`]
  ];
  for (const [label, command] of commands) {
    const reply = (await startProcess({ command, timeout_ms: SPAWN_TIMEOUT_MS }))?.content?.[0]?.text ?? '';
    console.log(`  ${label}`);
    console.log(`    sent: ${command}`);
    console.log(`    reply: ${reply.replace(/\n/g, ' | ')}`);
  }
}

// --- entry points -----------------------------------------------------------

if (process.env.SSH_702_SECTION_A === '1') {
  await sectionAWorker();
  process.exit(0);
}

if (process.env.SSH_702_OUT) {
  // A detached pass: report and leave.
  const report = await runConfigurations();
  writeFileSync(process.env.SSH_702_OUT, JSON.stringify(report));
  process.exit(0);
}

if (process.platform !== 'win32') {
  console.log('This repro is Windows-only: the factors it separates are Windows console behaviour.');
  process.exit(0);
}
if (!existsSync(SSH)) {
  console.log(`No OpenSSH client at ${SSH}; install the Windows OpenSSH client to run this.`);
  process.exit(0);
}

console.log(`#702 factor matrix on ${os.version?.() ?? process.platform}, node ${process.version}`);
console.log(`ssh: ${SSH}`);
console.log('\nSection A — the reported command through start_process:');
await sectionA();

console.log('\nSection B — 8 spawn configurations under 3 parent shapes:');
const passes = [
  ['parent with a console', await runConfigurations()],
  ['parent with no console, NUL handles', await runDetachedPass('ignore')],
  ['parent with no console, its own stdio piped', await runDetachedPass(PIPES)]
];

let total = 0;
let silent255 = 0;
for (const [name, pass] of passes) {
  console.log(`\n  ${name} — \\\\.\\CONOUT$ ${pass.console ? 'opens (has a console)' : 'fails (no console)'}`);
  for (const r of pass.results) {
    total += 1;
    if (r.exitCode === 255 && r.bytes === 0) silent255 += 1;
    const code = r.timedOut ? 'timeout' : (r.signal ? `${r.exitCode} (${r.signal})` : String(r.exitCode));
    console.log(`    exit=${code.padEnd(7)} bytes=${String(r.bytes).padEnd(5)} ${r.label}`);
    if (r.spawnError) console.log(`      spawn error: ${r.spawnError}`);
  }
}

console.log(`\n${total} spawns; ${silent255} of them reproduced the report (exit 255 with zero bytes).`);
