/**
 * A process in a bubblewrap PID namespace can see bwrap as PID 1 even
 * when the actual host is managed by systemd. Report the observed execution
 * namespace, never infer host service health or grant host-level access.
 */
import assert from 'node:assert/strict';
import { getSystemInfo, getOSSpecificGuidance, isBubblewrapInitProcess } from '../dist/utils/system-info.js';
import { runIfMain } from './helpers/run-if-main.js';

export default async function runTests() {
  assert.equal(isBubblewrapInitProcess('bwrap\n'), true);
  assert.equal(isBubblewrapInitProcess('  bwrap  '), true);
  for (const comm of ['systemd\n', 'bash\n', 'docker\n', 'not-bwrap\n', '']) {
    assert.equal(isBubblewrapInitProcess(comm), false, `must not misclassify ${JSON.stringify(comm)}`);
  }

  const info = getSystemInfo();
  const isolated = {
    ...info,
    isLinux: true,
    isMacOS: false,
    isWindows: false,
    docker: { ...info.docker, isContainer: true, isDocker: false, containerType: 'bubblewrap',
      orchestrator: null, mountPoints: [] }
  };
  const guidance = getOSSpecificGuidance(isolated);
  assert.match(guidance, /BUBBLEWRAP SANDBOX ENVIRONMENT DETECTED/);
  assert.match(guidance, /failed systemctl command here does not mean host systemd services are stopped/);
  assert.match(guidance, /separately authorized host-level interface/);
  assert.match(guidance, /Do not expose host D-Bus\/systemd sockets or disable sandbox restrictions/);
  assert.doesNotMatch(guidance, /Desktop Commander Docker installer/);
  assert.doesNotMatch(guidance, /No mounted directories detected/);

  const ordinary = { ...info, docker: { ...info.docker, isContainer: false,
    isDocker: false, containerType: null, mountPoints: [] } };
  assert.doesNotMatch(getOSSpecificGuidance(ordinary), /BUBBLEWRAP SANDBOX/);
  console.log('✓ bubblewrap environment guidance distinguishes child and host service state');
  return true;
}

runIfMain(import.meta.url, runTests);
