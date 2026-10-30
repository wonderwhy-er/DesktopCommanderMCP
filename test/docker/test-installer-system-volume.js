// The Docker installers' dc-system volume when a user installs a newer image.
//
// install-docker.sh and install-docker.ps1 keep the container's /usr in the
// volume dc-system, so the tools the AI installs survive restarts. That
// volume also hid a newer image's /usr: its Desktop Commander and its
// Chromium. After pulling a new image, the installers copy its /usr into the
// volume (update_system_volume, Update-SystemVolume).
//
// The test builds two images from this checkout. The older one stands for an
// image from before Chromium was added: the Dockerfile without its Chromium
// line, and a file only it has in Desktop Commander's folder. The new one is
// the checkout's own, with a file only it has. Like an existing user, the
// older image runs with the installers' four volumes, installs jq with apk and
// a small tool with npm install -g, and writes a file in the home, and a
// container of it keeps running. Then the installers' update step runs twice,
// from copies of the installers with the new image and the test's volume in
// place of their own: install-docker.sh's, then install-docker.ps1's (on
// Windows; elsewhere install-docker.sh's again). Then the new image starts with
// the four volumes.
//
// Checks: both installers mount the same volumes; the update step works and
// stops the running container; a second update leaves the volume as the first
// did; write_pdf works; jq, the npm tool and the home file are kept; the volume
// has the new image's Desktop Commander and not the older one's.
//
// It needs Docker and network (apk), so it sits outside the folders the test runners read.
// On Windows install-docker.sh runs in Git Bash.
// Run, with Docker running and npm ci done: node test/docker/test-installer-system-volume.js
// Exit code: 1 if any check fails.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildImage, checkWritePdf, docker, dockerQuietly } from '../helpers/docker-image.js';
import { runInstallerPs1, runInstallerSh } from '../helpers/docker-installers.js';
import { createTempDir } from '../helpers/test-env.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Images, containers and volumes are named after this test and its process, so they can be removed by name
const NAME = `dc-test-installer-volume-${process.pid}`;
const OLD_IMAGE = `${NAME}-old`;
const NEW_IMAGE = `${NAME}-new`;
const RUNNING = `${NAME}-running`;
const OLD_MARKER = 'dc-test-old-image.txt';
const NEW_MARKER = 'dc-test-new-image.txt';

const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `: ${detail}` : ''}`);
}

const readInstaller = (file) => fs.readFileSync(path.join(PROJECT_ROOT, file), 'utf8');

/** The installers' volumes, as "name:/folder", in the order an installer lists them */
const volumesOf = (script) => [...new Set([...script.matchAll(/"(dc-[a-z]+:\/[a-z]*)"/g)].map((match) => match[1]))];

/** Runs a shell script in a container of `image` with the four volumes and returns what it prints */
const runWithVolumes = (image, volumeArgs, script) => docker(['run', '--rm', ...volumeArgs, image, 'sh', '-c', script]);

// What the user installed, as key=value lines
const LOOK = [
  'echo "jq=$(jq --version 2>/dev/null || echo missing)"',
  'echo "npm-tool=$(dc-test-tool 2>/dev/null || echo missing)"',
  'echo "home-file=$(cat /root/dc-test-note 2>/dev/null || echo missing)"',
  `echo "new-dc=$(test -f /usr/src/app/${NEW_MARKER} && echo yes || echo no)"`,
  `echo "old-dc=$(test -f /usr/src/app/${OLD_MARKER} && echo yes || echo no)"`,
].join('; ');
const lookAt = (output) => Object.fromEntries(output.trim().split('\n').map((line) => line.split('=')));

// Every name in the volume and every file's content, as two checksums
const FINGERPRINT = 'cd /target && find . | LC_ALL=C sort | md5sum && find . -type f -exec md5sum {} + | LC_ALL=C sort | md5sum';

/** Runs an installer's update step with the new image and `systemVolume` in place of dc-system; true when it works */
function update(installer, systemVolume) {
  const updated = installer === 'install-docker.sh'
    ? runInstallerSh(`DOCKER_IMAGE=${NEW_IMAGE} && update_system_volume`, { replace: { 'dc-system': systemVolume } })
    : runInstallerPs1('Update-SystemVolume', { replace: { 'dc-system': systemVolume, 'mcp/desktop-commander:latest': NEW_IMAGE } });
  check(`${installer}'s update step works`, updated.status === 0,
    updated.status === 0 ? '' : `exit ${updated.status}: ${`${updated.stdout}${updated.stderr}`.trim().slice(-1000)}`);
  return updated.status === 0;
}

const dockerfiles = createTempDir('dc-test-installer-volume-');
let volumes = [];
try {
  const shVolumes = volumesOf(readInstaller('install-docker.sh'));
  const ps1Volumes = volumesOf(readInstaller('install-docker.ps1'));
  check('both installers mount the same volumes', shVolumes.join(' ') === ps1Volumes.join(' '),
    `install-docker.sh ${shVolumes.join(' ')}; install-docker.ps1 ${ps1Volumes.join(' ')}`);

  // The test's own volumes in place of the installers' dc-* names
  volumes = shVolumes.map((volume) => {
    const [name, folder] = volume.split(':');
    return { name: `${NAME}-${name.replace(/^dc-/, '')}`, folder };
  });
  const volumeArgs = volumes.flatMap(({ name, folder }) => ['--volume', `${name}:${folder}`]);
  const systemVolume = volumes.find(({ folder }) => folder === '/usr')?.name;
  if (!systemVolume) throw new Error('install-docker.sh mounts no volume on /usr');

  // Each image gets a file only it has in Desktop Commander's folder (the Dockerfile's WORKDIR)
  const dockerfile = readInstaller('Dockerfile');
  const withoutChromium = dockerfile.replace(/^RUN apk add .*chromium.*\r?\n/m, '');
  if (withoutChromium === dockerfile) throw new Error('the Dockerfile has no "RUN apk add … chromium" line to leave out');
  const oldDockerfile = path.join(dockerfiles, 'Dockerfile.old');
  const newDockerfile = path.join(dockerfiles, 'Dockerfile.new');
  fs.writeFileSync(oldDockerfile, `${withoutChromium}\nRUN echo the older image > ${OLD_MARKER}\n`);
  fs.writeFileSync(newDockerfile, `${dockerfile}\nRUN echo the new image > ${NEW_MARKER}\n`);
  buildImage(OLD_IMAGE, oldDockerfile);
  buildImage(NEW_IMAGE, newDockerfile);

  console.log('\nThe older image with the four volumes: apk add jq, npm install -g a small tool, a file in the home');
  const seeded = lookAt(runWithVolumes(OLD_IMAGE, volumeArgs, [
    'apk add -q jq >/dev/null',
    'mkdir -p /tmp/dc-test-tool && cd /tmp/dc-test-tool',
    `printf '{"name":"dc-test-tool","version":"1.0.0","bin":{"dc-test-tool":"tool.js"}}' > package.json`,
    `printf '#!/usr/bin/env node\\nconsole.log("works")\\n' > tool.js`,
    'npm pack -s >/dev/null && npm install -g -s ./dc-test-tool-1.0.0.tgz >/dev/null',
    'echo kept > /root/dc-test-note',
    LOOK,
  ].join(' && ')));
  check('the older image has them', seeded.jq.startsWith('jq-') && seeded['npm-tool'] === 'works' && seeded['home-file'] === 'kept' && seeded['old-dc'] === 'yes',
    JSON.stringify(seeded));
  // Still running when the update starts, as the AI app's Desktop Commander can be
  docker(['run', '--detach', '--rm', '--init', '--name', RUNNING, ...volumeArgs, '--entrypoint', 'sleep', OLD_IMAGE, '600']);

  const second = process.platform === 'win32' ? 'install-docker.ps1' : 'install-docker.sh';
  console.log(`\nThe installers' update step with the new image: install-docker.sh's, then ${second}'s`);
  const fingerprint = () => docker(['run', '--rm', '--volume', `${systemVolume}:/target`, NEW_IMAGE, 'sh', '-c', FINGERPRINT]);
  if (update('install-docker.sh', systemVolume)) {
    check('it stops the container that uses the volume', docker(['ps', '--quiet', '--filter', `name=${RUNNING}`]).trim() === '');
    const first = fingerprint();
    update(second, systemVolume);
    const again = fingerprint();
    check('a second update leaves the volume as the first did', first === again, first === again ? '' : `${first} / ${again}`);
  }

  console.log('\nThe new image with the four volumes');
  const kept = lookAt(runWithVolumes(NEW_IMAGE, volumeArgs, LOOK));
  check('jq is kept', kept.jq.startsWith('jq-'), kept.jq);
  check('the npm tool is kept', kept['npm-tool'] === 'works', kept['npm-tool']);
  check('the home file is kept', kept['home-file'] === 'kept', kept['home-file']);
  check("the volume has the new image's Desktop Commander", kept['new-dc'] === 'yes' && kept['old-dc'] === 'no',
    `new image's file ${kept['new-dc']}, older image's file ${kept['old-dc']}`);
  results.push(await checkWritePdf(NEW_IMAGE, `${NAME}-write-pdf`, volumeArgs));
  if (results.includes(false)) process.exitCode = 1;
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exitCode = 1;
} finally {
  dockerQuietly(['rm', '--force', RUNNING]);
  for (const { name } of volumes) dockerQuietly(['volume', 'rm', name]);
  dockerQuietly(['rmi', OLD_IMAGE]);
  dockerQuietly(['rmi', NEW_IMAGE]);
  fs.rmSync(dockerfiles, { recursive: true, force: true });
}
