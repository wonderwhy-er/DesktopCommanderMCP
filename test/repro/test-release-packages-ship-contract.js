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
//   MCPB: `npm run build:mcpb` (a copy list plus npm install in mcpb-bundle/),
//         then the .mcpb unpacked with mcpb's own unpack. Without the contract
//         copied, the bundle gets the same missing link and mcpb pack stops.
// Each package then loads transport-telemetry.js in a new process, and says
// where the contract came from: it has to be real files, not a link.
//
// Needs `npm run build` first (the tarball takes dist/ as it is) and network
// (npm, and build:mcpb's ripgrep downloads). No install scripts run
// (npm_config_ignore_scripts), npm's cache is a temporary folder, telemetry is
// off. build:mcpb writes mcpb-bundle/ and a .mcpb file in the checkout (both
// git-ignored) and adds ripgrep binaries to node_modules/@vscode/ripgrep/bin;
// mcpb-bundle/ and the .mcpb file are removed at the end.
//
// Run: node test/repro/run-repro.js test-release-packages-ship-contract.js
// Exit code: 0 if both packages load transport-telemetry.js with the contract
// inside them, 1 if either doesn't.
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createTempDir } from '../helpers/test-env.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRY = path.join('dist', 'remote-device', 'transport-telemetry.js');
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

/** Runs a shell command; returns its exit code and output */
function sh(command, cwd) {
  const result = spawnSync(command, { cwd, env, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? '', output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/** The lines of a failed command that say why */
const why = (output) => output.split(/\r?\n/).filter((line) => /npm error|ERROR|❌/.test(line)).slice(0, 4).map((line) => `     ${line.trim()}`).join('\n');

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

/** True when transport-telemetry.js loads from the package at root, with the contract as real files */
function loads(label, root) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', LOAD, root, ENTRY], { cwd: root, env, encoding: 'utf8' });
  process.stdout.write(`${result.stdout}${result.stderr}`);
  console.log(`${result.status === 0 ? '✅' : '🔴'} ${label}: transport-telemetry.js ${result.status === 0 ? 'loads' : 'does not load'}`);
  return result.status === 0;
}

function npmPackage() {
  const packDir = path.join(work, 'pack');
  fs.mkdirSync(packDir);
  const pack = sh(`npm pack --json --pack-destination "${packDir}"`, PROJECT_ROOT);
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
  const install = sh(`npm install "${path.join(packDir, info.filename)}"`, installDir);
  console.log(`npm: the tarball installed in an empty folder, exit ${install.status}`);
  if (install.status !== 0) console.log(why(install.output));
  return loads('npm', path.join(installDir, 'node_modules', '@wonderwhy-er', 'desktop-commander'));
}

function mcpbBundle() {
  const started = Date.now();
  const build = sh('npm run build:mcpb', PROJECT_ROOT);
  const made = fs.readdirSync(PROJECT_ROOT)
    .filter((file) => file.endsWith('.mcpb') && fs.statSync(path.join(PROJECT_ROOT, file)).mtimeMs >= started - 2000);
  try {
    if (build.status !== 0 || made.length === 0) {
      console.log(`🔴 MCPB: npm run build:mcpb failed (exit ${build.status})\n${why(build.output)}`);
      return false;
    }
    console.log(`MCPB: ${made[0]} built`);
    const unpackDir = path.join(work, 'unpack');
    const unpack = sh(`npx --no @anthropic-ai/mcpb unpack "${path.join(PROJECT_ROOT, made[0])}" "${unpackDir}"`, PROJECT_ROOT);
    if (unpack.status !== 0) {
      console.log(`🔴 MCPB: mcpb unpack failed (exit ${unpack.status})\n${why(unpack.output)}`);
      return false;
    }
    return loads('MCPB', unpackDir);
  } finally {
    for (const file of made) fs.rmSync(path.join(PROJECT_ROOT, file), { force: true });
    fs.rmSync(path.join(PROJECT_ROOT, 'mcpb-bundle'), { recursive: true, force: true });
  }
}

if (!fs.existsSync(path.join(PROJECT_ROOT, ENTRY))) {
  console.error(`${ENTRY} is missing: run npm run build first`);
  process.exit(1);
}
try {
  const npmOk = npmPackage();
  const mcpbOk = mcpbBundle();
  process.exitCode = npmOk && mcpbOk ? 0 : 1;
} finally {
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
