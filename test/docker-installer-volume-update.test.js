// The Docker installers copy a new image into the volume dc-system only when no
// container uses the volume.
//
// install-docker.sh and install-docker.ps1 keep /usr in the volume dc-system. To
// update it, they stop the containers that use it and then copy the new image's
// /usr into it, after deleting Desktop Commander's folder there. They ignored a
// failing `docker ps` or `docker stop` and copied anyway, so the copy could run
// while a container still used the volume.
//
// The test runs each installer's update step (update_system_volume,
// Update-SystemVolume) with a stand-in docker command first on PATH, so no real
// Docker command runs, in copies of the installers that name a volume and an image
// of the test's own. One stand-in container uses the volume. The step must:
// - stop it and copy, when Docker answers (the normal update);
// - exit 1 without copying when `docker ps` fails;
// - exit 1 without copying when `docker stop` fails and the container keeps
//   running.
// install-docker.sh runs on every system (Git Bash on Windows), install-docker.ps1
// on Windows.
//
// Run, on Windows, macOS or Linux: node test/docker-installer-volume-update.test.js
// Exit code: 1 if a check fails.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runInstallerPs1, runInstallerSh } from './helpers/docker-installers.js';
import { createTempDir, withEnv } from './helpers/test-env.js';

const windows = process.platform === 'win32';
let failed = false;

function check(name, ok, detail = '') {
  if (!ok) failed = true;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `: ${detail}` : ''}`);
}

// The stand-in docker. The container c0ffee uses dc-system while the file "running" exists, and
// every call is added to the file "calls". DOCKER_STANDIN_FAIL=ps makes `docker ps` fail;
// DOCKER_STANDIN_FAIL=stop makes `docker stop` fail, and the container keeps running.
const standInSource = `const fs = require('fs');
const path = require('path');
const [command, ...args] = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'calls'), [command, ...args].join(' ') + '\\n');
if (process.env.DOCKER_STANDIN_FAIL === command) {
  console.error('Error response from daemon: the stand-in docker ' + command + ' failed');
  process.exit(1);
}
const running = path.join(__dirname, 'running');
if (command === 'ps' && fs.existsSync(running)) console.log('c0ffee');
if (command === 'stop') fs.rmSync(running, { force: true });
`;

const temp = createTempDir('dc-installer-volume-update-test-');
const standIn = path.join(temp, 'docker-standin.cjs');
writeFileSync(standIn, standInSource);
// For bash a script named docker; for PowerShell a docker.cmd in another folder, so that
// PowerShell never meets a file named docker without an extension
const node = process.execPath.replaceAll('\\', '/');
mkdirSync(path.join(temp, 'sh'));
writeFileSync(path.join(temp, 'sh', 'docker'), `#!/bin/sh\nexec "${node}" "${standIn.replaceAll('\\', '/')}" "$@"\n`, { mode: 0o755 });
mkdirSync(path.join(temp, 'cmd'));
writeFileSync(path.join(temp, 'cmd', 'docker.cmd'), `@"${process.execPath}" "${standIn}" %*\r\n@exit /b %ERRORLEVEL%\r\n`);

const cases = [
  { name: 'Docker answers', fail: undefined, exitCode: 0, copies: true },
  { name: '`docker ps` fails', fail: 'ps', exitCode: 1, copies: false },
  { name: '`docker stop` fails and the container keeps running', fail: 'stop', exitCode: 1, copies: false },
];
// The installers' copies name a volume and an image of the test's own, so even a real docker
// command could not touch the real dc-system
const replace = { 'dc-system': 'dc-installer-volume-update-test', 'mcp/desktop-commander:latest': 'dc-installer-volume-update-test:none' };
const installers = [
  { name: 'install-docker.sh', folder: 'sh', run: () => runInstallerSh('update_system_volume', { replace }) },
  ...(windows ? [{ name: 'install-docker.ps1', folder: 'cmd', run: () => runInstallerPs1('Update-SystemVolume', { replace }) }] : []),
];

try {
  for (const installer of installers) {
    for (const { name, fail, exitCode, copies } of cases) {
      writeFileSync(path.join(temp, 'running'), '');
      rmSync(path.join(temp, 'calls'), { force: true });
      const result = await withEnv(
        { PATH: `${path.join(temp, installer.folder)}${path.delimiter}${process.env.PATH}`, DOCKER_STANDIN_FAIL: fail },
        installer.run,
      );
      const calls = existsSync(path.join(temp, 'calls')) ? readFileSync(path.join(temp, 'calls'), 'utf8').trim().split('\n') : [];
      const output = `${result.stdout}${result.stderr}`;
      if (calls.length === 0) {
        check(`${installer.name}, ${name}: runs the stand-in docker`, false, `exit code ${result.status}, ${output.trim().slice(-300)}`);
        continue;
      }
      const copied = calls.some((call) => call.startsWith('run '));
      check(`${installer.name}, ${name}: exits with ${exitCode}`, result.status === exitCode,
        result.status === exitCode ? '' : `exit code ${result.status}, docker calls: ${calls.join(' | ')}`);
      check(`${installer.name}, ${name}: ${copies ? 'copies into dc-system' : "doesn't copy into dc-system"}`, copied === copies);
      if (!copies) check(`${installer.name}, ${name}: says nothing was changed`, output.includes('Nothing was changed'));
    }
  }
} finally {
  rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
process.exitCode = failed ? 1 : 0;
