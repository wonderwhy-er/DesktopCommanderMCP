import assert from 'node:assert/strict';

import { getPathGuidance } from '../dist/utils/system-info.js';
import { runIfMain } from './helpers/run-if-main.js';

const verifiedWarning = 'Files outside verified mounts may not persist after the container stops.';
const candidateWarning = 'These paths are inferred from common container directories and may not persist.';

function mount(containerPath, verifiedMount) {
  return {
    containerPath,
    verifiedMount,
    hostPath: `/private-host${containerPath}`,
    description: `Private mount description for ${containerPath}`,
    type: 'bind',
    readOnly: false,
  };
}

function freezeFixture(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') freezeFixture(child);
  }
  return Object.freeze(value);
}

function guidanceFor(docker) {
  // Supply detection results directly; path advice must not need system probes.
  const fixture = { docker };
  const before = structuredClone(fixture);
  freezeFixture(fixture);
  const guidance = getPathGuidance(fixture);
  assert.deepStrictEqual(fixture, before, 'Guidance must leave its input unchanged');
  assert.ok(guidance.includes('Absolute paths are the most reliable'), 'Keep the general path advice');
  assert.ok(guidance.includes('Paths are automatically normalized regardless of slash direction.'));
  for (const entry of docker.mountPoints) {
    assert.ok(!guidance.includes(entry.hostPath), 'Do not disclose host filesystem paths');
    assert.ok(!guidance.includes(entry.description), 'Do not disclose mount metadata');
  }
  return guidance;
}

function assertSections(guidance, label, verifiedPaths, candidatePaths) {
  const verifiedLine = guidance.split('\n').filter(line => line.includes('Verified mounts for persistent file operations:'));
  const candidateLine = guidance.split('\n').filter(line => line.includes('Unverified mount candidates:'));
  assert.deepStrictEqual(verifiedLine, verifiedPaths.length ? [
    `🐳 ${label}: Verified mounts for persistent file operations: ${verifiedPaths.join(', ')}.`,
  ] : [], 'Only verified container paths belong in persistent mount advice');
  assert.deepStrictEqual(candidateLine, candidatePaths.length ? [
    `🐳 ${label}: Unverified mount candidates: ${candidatePaths.join(', ')}. ${candidateWarning}`,
  ] : [], 'Inferred paths must remain explicitly unverified');
  assert.equal(guidance.includes(verifiedWarning), verifiedPaths.length > 0, 'Verified mounts need their persistence caveat');
  assert.equal(guidance.includes(candidateWarning), candidatePaths.length > 0, 'Candidates need their uncertainty caveat');
}

export default async function runTests() {
  const checks = [
    ['noncontainer ignores supplied mount hints', () => {
      const guidance = guidanceFor({ isContainer: false, containerType: 'docker', mountPoints: [mount('/data', true), mount('/workspace', false)] });
      assertSections(guidance, 'DOCKER', [], []);
      assert.ok(!guidance.includes('/data') && !guidance.includes('/workspace'));
      assert.ok(!guidance.includes('🐳'), 'Do not present container advice outside a container');
    }],
    ['container without mounts keeps only general advice', () => {
      const guidance = guidanceFor({ isContainer: true, containerType: 'docker', mountPoints: [] });
      assertSections(guidance, 'DOCKER', [], []);
      assert.ok(!guidance.includes('🐳'), 'No mount section is needed when no mounts are known');
    }],
    ['verified mounts do not create a candidate section', () => {
      const guidance = guidanceFor({ isContainer: true, containerType: 'docker', mountPoints: [mount('/saved documents', true), mount('/data', true)] });
      assertSections(guidance, 'DOCKER', ['/saved documents', '/data'], []);
    }],
    ['candidate mounts never promise verified persistence', () => {
      const guidance = guidanceFor({ isContainer: true, containerType: 'docker', mountPoints: [mount('/workspace', false), mount('/app', false)] });
      assertSections(guidance, 'DOCKER', [], ['/workspace', '/app']);
    }],
  ];

  for (const [containerType, label] of [
    ['docker', 'DOCKER'],
    ['podman', 'PODMAN'],
    ['kubernetes', 'KUBERNETES'],
    ['lxc', 'CONTAINER'],
    [null, 'CONTAINER'],
  ]) {
    checks.push([`mixed mounts stay separate for ${containerType ?? 'an unspecified container'}`, () => {
      const guidance = guidanceFor({
        isContainer: true,
        containerType,
        mountPoints: [mount('/workspace', false), mount('/data', true), mount('/app', false), mount('/saved documents', true)],
      });
      assertSections(guidance, label, ['/data', '/saved documents'], ['/workspace', '/app']);
    }]);
  }

  for (const [name, check] of checks) {
    check();
    console.log(`✓ ${name}`);
  }
  console.log(`Path guidance: ${checks.length} behavior checks passed`);
  return true;
}

runIfMain(import.meta.url, runTests);
