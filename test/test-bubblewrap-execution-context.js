/**
 * A process in a bubblewrap PID namespace can see bwrap as PID 1 even
 * when the actual host is managed by systemd. Report the observed execution
 * namespace, never infer host service health or grant host-level access.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { mock } from 'node:test';
import { getSystemInfo, getOSSpecificGuidance, getPathGuidance, isBubblewrapInitProcess } from '../dist/utils/system-info.js';
import { runIfMain } from './helpers/run-if-main.js';

export default async function runTests() {
  assert.equal(isBubblewrapInitProcess('bwrap\n'), true);
  assert.equal(isBubblewrapInitProcess('  bwrap  '), true);
  for (const comm of ['systemd\n', 'bash\n', 'docker\n', 'not-bwrap\n', '']) {
    assert.equal(isBubblewrapInitProcess(comm), false, `must not misclassify ${JSON.stringify(comm)}`);
  }

  // Exercise the actual getSystemInfo() detector with controlled /proc reads.
  // All mocks and environment changes are scoped to this test process.
  const envKeys = [
    'MCP_CLIENT_DOCKER', 'KUBERNETES_SERVICE_HOST', 'KUBERNETES_PORT',
    'PODMAN_CONTAINER', 'CONTAINER_HOST', 'COMPOSE_PROJECT_NAME',
    'COMPOSE_SERVICE', 'DOCKER_SWARM_MODE', 'DOCKER_NODE_ID'
  ];
  const savedEnv = envKeys.map(key => [key, process.env[key]]);
  const readFileSync = fs.readFileSync;
  const existsSync = fs.existsSync;
  let pid1Comm = 'bwrap\n';
  let dockerMarker = true;

  try {
    for (const key of envKeys) delete process.env[key];
    mock.method(os, 'platform', () => 'linux');
    mock.method(os, 'hostname', () => 'localhost');
    mock.method(fs, 'readFileSync', (file, ...args) => {
      if (file === '/proc/1/comm') return pid1Comm;
      if (file === '/proc/1/cgroup' || file === '/proc/1/environ') return '';
      if (file === '/proc/mounts') return '/dev/mock /workspace fuse.sshfs ro,relatime 0 0\n';
      return readFileSync.call(fs, file, ...args);
    });
    mock.method(fs, 'existsSync', (file, ...args) => {
      if (file === '/.dockerenv') return dockerMarker;
      if (['/mnt', '/home', '/var/run/secrets/kubernetes.io'].includes(file)) return false;
      return existsSync.call(fs, file, ...args);
    });

    // PID 1 takes precedence even when Docker's strongest indicator is set.
    process.env.MCP_CLIENT_DOCKER = 'true';
    const isolated = getSystemInfo();
    assert.equal(isolated.docker.isContainer, true);
    assert.equal(isolated.docker.containerType, 'bubblewrap');
    assert.equal(isolated.docker.isDocker, false);
    assert.equal(isolated.docker.mountPoints.find(m => m.containerPath === '/workspace')?.readOnly, true);
    const guidance = getOSSpecificGuidance(isolated);
    assert.match(guidance, /BUBBLEWRAP SANDBOX ENVIRONMENT DETECTED/);
    assert.match(guidance, /failed systemctl command here does not mean host systemd services are stopped/);
    assert.match(guidance, /separately authorized host-level interface/);
    assert.match(guidance, /Do not expose host D-Bus\/systemd sockets or disable sandbox restrictions/);
    assert.doesNotMatch(guidance, /Desktop Commander Docker installer/);
    assert.doesNotMatch(guidance, /No mounted directories detected/);
    const paths = getPathGuidance(isolated);
    assert.match(paths, /BUBBLEWRAP SANDBOX/);
    assert.doesNotMatch(paths, /Verified mounts for persistent file operations/);
    assert.doesNotMatch(paths, /Unverified mount candidates/);

    // Ordinary Linux host: systemd PID 1, no container indicators.
    delete process.env.MCP_CLIENT_DOCKER;
    pid1Comm = 'systemd\n';
    dockerMarker = false;
    const ordinary = getSystemInfo();
    assert.equal(ordinary.docker.isContainer, false);
    assert.equal(ordinary.docker.containerType, null);
    assert.doesNotMatch(getOSSpecificGuidance(ordinary), /BUBBLEWRAP SANDBOX/);
    assert.doesNotMatch(getPathGuidance(ordinary), /BUBBLEWRAP SANDBOX/);
  } finally {
    mock.restoreAll();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  console.log('✓ bubblewrap environment guidance distinguishes child and host service state');
  return true;
}

runIfMain(import.meta.url, runTests);
