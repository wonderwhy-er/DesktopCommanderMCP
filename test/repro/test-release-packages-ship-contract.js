// Repro: neither release package carries #794's telemetry contract, so the
// remote device can't load its transport telemetry from either.
//
// package.json depends on "@desktop-commander/telemetry-contract":
// "file:vendor/telemetry-contract", and dist/remote-device/transport-telemetry.js
// imports it. In a checkout npm links that folder into node_modules; the
// release packages are built without the checkout:
//   npm:  `npm pack` (package.json's "files"), then the tarball installed in an
//         empty folder, as a user's npm installs it. Without the contract in
//         the tarball, npm links the dependency to a vendor/ folder that isn't
//         there.
//   MCPB: scripts/build-mcpb.cjs (what `npm run build:mcpb` runs) builds
//         mcpb-bundle/: a copy list, then npm install there. Without the
//         contract copied, the bundle gets the same missing link. Its last
//         step, mcpb pack, is skipped: it reads every file of the bundle before
//         zipping it (over a minute on Windows). mcpb's own file rules
//         (shouldExclude) say instead whether the contract would be in the .mcpb.
// Each package then loads transport-telemetry.js in a new process, from a
// temporary folder outside the checkout (whose own node_modules would supply
// the contract), and says where the contract came from: it has to be real
// files, not a link.
//
// Needs `npm run build` first (the tarball takes dist/ as it is) and network
// (npm). No install scripts run (npm_config_ignore_scripts), npm's cache is a
// temporary folder, telemetry is off. mcpb-bundle/ (git-ignored) is removed at
// the end. If the script is stopped (Ctrl+C, SIGTERM), or is still running
// 15 s before run-repro.js's limit (REPRO_TIMEOUT_MS, default 180 s), it stops
// the processes it started and removes what they made.
//
// Run: node test/repro/run-repro.js test-release-packages-ship-contract.js
// Exit code: 0 if both packages load transport-telemetry.js with the contract
// inside them, 1 if either doesn't.
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createTempDir } from '../helpers/test-env.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRY = path.join('dist', 'remote-device', 'transport-telemetry.js');
const BUNDLE = path.join(PROJECT_ROOT, 'mcpb-bundle');
const CONTRACT = 'node_modules/@desktop-commander/telemetry-contract';
/** Stops itself this long before run-repro.js would kill it, so it can stop its own processes first */
const OWN_LIMIT_MS = (Number(process.env.REPRO_TIMEOUT_MS) || 180_000) - 15_000;
const deadline = Date.now() + OWN_LIMIT_MS;
const work = createTempDir('dc-release-packages-');
const env = {
  ...process.env,
  npm_config_cache: path.join(work, 'npm-cache'),
  npm_config_ignore_scripts: 'true',
  npm_config_audit: 'false',
  npm_config_fund: 'false',
  npm_config_update_notifier: 'false',
  DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1',
  PUPPETEER_SKIP_DOWNLOAD: '1',
};

// Loaded into build-mcpb.cjs (node --require): every command it runs runs as usual, except the zip
const SKIP_PACK = `
const childProcess = require('child_process');
const execSync = childProcess.execSync;
childProcess.execSync = (command, options) => {
  if (/@anthropic-ai\\/mcpb pack /.test(command)) {
    console.log('(repro) skipped: ' + command);
    return Buffer.alloc(0);
  }
  return execSync(command, options);
};
`;

// Runs in a new process: finds the contract the way Node does from the entry, then imports the entry
const LOAD = `
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
const [root, entry] = process.argv.slice(1);
let real = false;
for (let dir = path.dirname(path.join(root, entry)); ; dir = path.dirname(dir)) {
  const contract = path.join(dir, 'node_modules', '@desktop-commander', 'telemetry-contract');
  const stat = fs.lstatSync(contract, { throwIfNoEntry: false });
  if (stat) {
    real = !stat.isSymbolicLink();
    console.log('     contract: ' + path.relative(root, contract) + (real ? ' (real files)' : ' -> link to ' + fs.readlinkSync(contract)));
    break;
  }
  if (path.dirname(dir) === dir) { console.log('     contract: not in any node_modules above the entry'); break; }
}
try {
  await import(pathToFileURL(path.join(root, entry)).href);
  console.log('     import: ok');
} catch (error) {
  console.log('     import: ' + (error.code ?? '') + ' ' + String(error.message).split('\\n')[0]);
  real = false;
}
process.exitCode = real ? 0 : 1;
`;

let running = null;

/** Stops the running command and every process it started */
function stopRunning() {
  const child = running;
  if (!child || child.exitCode !== null || child.signalCode !== null || !(child.pid > 1)) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGKILL'); // its own process group: started detached
    }
  } catch {
    // Best effort: the tree can end on its own between the check and the kill
  }
}

/** Runs a command (a shell line, or a program with args); resolves with its exit code and output */
function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd, env, shell: args.length === 0, detached: process.platform !== 'win32', windowsHide: true,
    });
    running = child;
    let stdout = '';
    let output = '';
    let late = false;
    child.stdout.on('data', (data) => { stdout += data; output += data; });
    child.stderr.on('data', (data) => { output += data; });
    const timer = setTimeout(() => { late = true; stopRunning(); }, Math.max(0, deadline - Date.now()));
    child.on('close', (status) => {
      clearTimeout(timer);
      running = null;
      if (late) reject(new Error(`still running after ${OWN_LIMIT_MS / 1000} s (run-repro.js's limit minus 15 s)`));
      else resolve({ status, stdout, output });
    });
  });
}

/** The lines of a failed command that say why */
const why = (output) => output.split(/\r?\n/).filter((line) => /npm error|ERROR|❌/.test(line)).slice(0, 4).map((line) => `     ${line.trim()}`).join('\n');

/** True when transport-telemetry.js loads from the package at root, with the contract as real files */
async function loads(label, root) {
  const result = await run(process.execPath, ['--input-type=module', '-e', LOAD, root, ENTRY], root);
  process.stdout.write(result.output);
  console.log(`${result.status === 0 ? '✅' : '🔴'} ${label}: transport-telemetry.js ${result.status === 0 ? 'loads' : 'does not load'}`);
  return result.status === 0;
}

async function npmPackage() {
  const packDir = path.join(work, 'pack');
  fs.mkdirSync(packDir);
  const pack = await run(`npm pack --json --pack-destination "${packDir}"`, [], PROJECT_ROOT);
  if (pack.status !== 0) {
    console.log(`🔴 npm: npm pack failed (exit ${pack.status})\n${why(pack.output)}`);
    return false;
  }
  const [info] = JSON.parse(pack.stdout);
  const shipped = info.files.map((file) => file.path).filter((file) => file.includes('telemetry-contract'));
  console.log(`npm: ${info.filename}, ${info.entryCount} files; contract files in it: ${shipped.length ? shipped.join(', ') : 'none'}`);

  const installDir = path.join(work, 'install');
  fs.mkdirSync(installDir);
  fs.writeFileSync(path.join(installDir, 'package.json'), JSON.stringify({ name: 'release-check', version: '1.0.0', private: true }));
  const install = await run(`npm install "${path.join(packDir, info.filename)}"`, [], installDir);
  console.log(`npm: the tarball installed in an empty folder, exit ${install.status}`);
  if (install.status !== 0) console.log(why(install.output));
  return loads('npm', path.join(installDir, 'node_modules', '@wonderwhy-er', 'desktop-commander'));
}

async function mcpbBundle() {
  const script = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')).scripts?.['build:mcpb'];
  if (script !== 'node scripts/build-mcpb.cjs') {
    console.log(`🔴 MCPB: build:mcpb is "${script}", not the script this repro runs`);
    return false;
  }
  const preload = path.join(work, 'skip-mcpb-pack.cjs');
  fs.writeFileSync(preload, SKIP_PACK);
  const build = await run(process.execPath, ['--require', preload, path.join('scripts', 'build-mcpb.cjs')], PROJECT_ROOT);
  if (build.status !== 0) {
    console.log(`🔴 MCPB: build-mcpb.cjs failed (exit ${build.status})\n${why(build.output)}`);
    return false;
  }
  // Out of the checkout, as the .mcpb is installed: inside it, Node would also find the checkout's own node_modules
  const bundle = path.join(work, 'mcpb-bundle');
  try {
    fs.renameSync(BUNDLE, bundle);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    fs.cpSync(BUNDLE, bundle, { recursive: true, verbatimSymlinks: true }); // the temporary folder is on another volume
  }
  console.log('MCPB: mcpb-bundle/ built (its zip step skipped), moved out of the checkout');

  // What mcpb pack would put in the .mcpb: the contract's files, unless mcpb's own rules leave them out
  const { readMcpbIgnorePatterns, shouldExclude } = await import('@anthropic-ai/mcpb/node');
  const patterns = readMcpbIgnorePatterns(bundle);
  const isFolder = fs.lstatSync(path.join(bundle, CONTRACT), { throwIfNoEntry: false })?.isDirectory() ?? false;
  const files = isFolder ? fs.readdirSync(path.join(bundle, CONTRACT)).map((file) => `${CONTRACT}/${file}`) : [];
  const packed = files.filter((file) => !file.split('/').some((_, i, parts) => shouldExclude(parts.slice(0, i + 1).join('/'), patterns)));
  console.log(`     mcpb pack would include: ${packed.length ? packed.join(', ') : 'no contract files'}`);
  const loaded = await loads('MCPB', bundle);
  return loaded && packed.includes(`${CONTRACT}/transport.js`);
}

function cleanUp() {
  stopRunning();
  fs.rmSync(BUNDLE, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\nstopped (${signal}): stopping the processes it started`);
    cleanUp();
    process.exit(1);
  });
}

if (!fs.existsSync(path.join(PROJECT_ROOT, ENTRY))) {
  console.error(`${ENTRY} is missing: run npm run build first`);
  process.exit(1);
}
try {
  const npmOk = await npmPackage();
  const mcpbOk = await mcpbBundle();
  process.exitCode = npmOk && mcpbOk ? 0 : 1;
} catch (error) {
  console.log(`🔴 stopped: ${error.message}; the processes it started are stopped`);
  process.exitCode = 1;
} finally {
  cleanUp();
}
