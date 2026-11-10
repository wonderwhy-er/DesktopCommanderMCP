import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { verifyDiagnostic, assertKnownObservations } from '../verify.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const definitions = JSON.parse(await fs.readFile(path.join(root, 'fixtures.json'), 'utf8'));
const expected = () => definitions.fixtures.map(fixture => ({
  id: fixture.id,
  commands: [...fixture.observedBaselineCommands],
  denied: fixture.observedBaselineDenied
}));

async function withCopy(callback) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'commander-diagnostic-'));
  const copy = path.join(temporary, 'restored-kit');
  try {
    await fs.cp(root, copy, { recursive: true });
    return await callback(copy);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

// These tests fail if the launcher omits its bounded report or allows changed
// source/fixtures or an unrecognized observation to count as reproduction.
test('unchanged public parser reproduces the bug separately from harness success', async () => {
  const report = await verifyDiagnostic();
  assert.equal(report.diagnosticStatus, 'BUG_REPRODUCED');
  assert.equal(report.harnessStatus, 'EXPECTED_OBSERVATIONS_CONFIRMED');
  assert.deepEqual(report.counts, {
    total: 16,
    literalFalsePositivesReproduced: 6,
    blockedControlsDenied: 6,
    ordinaryLiteralMatches: 2,
    legacyFalseAcceptsRecorded: 2
  });
  assert.equal(report.fixtureExecution, 'NONE');
  assert.equal(report.nativePowerShell, 'UNRUN');
  assert.equal(report.fullPackageBuild, 'UNRUN');
  assert.equal(report.securityCertification, false);
  assert.deepEqual(report.isolation, {
    processAvailable: false, requireAvailable: false, fetchAvailable: false,
    stringCodeGenerationBlocked: true, wasmCodeGenerationBlocked: true,
    telemetryEvents: 0
  });
});

test('a fresh restored copy requires no sibling source directory', async () => {
  await withCopy(async copy => {
    const report = await verifyDiagnostic({ root: copy });
    assert.equal(report.diagnosticStatus, 'BUG_REPRODUCED');
    assert.equal(report.counts.total, 16);
  });
});

test('altered pinned source is refused before parser evaluation', async () => {
  await withCopy(async copy => {
    await fs.appendFile(path.join(copy, 'upstream/command-manager.ts'), '\n// altered\n');
    await assert.rejects(verifyDiagnostic({ root: copy }), /SOURCE_HASH_MISMATCH/);
  });
});

test('changing the manifest source hash cannot authorize changed source', async () => {
  await withCopy(async copy => {
    const sourceFile = path.join(copy, 'upstream/command-manager.ts');
    await fs.appendFile(sourceFile, '\n// altered\n');
    const hash = createHash('sha256').update(await fs.readFile(sourceFile)).digest('hex');
    const manifestFile = path.join(copy, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    manifest.files['upstream/command-manager.ts'] = hash;
    await fs.writeFile(manifestFile, JSON.stringify(manifest));
    await assert.rejects(verifyDiagnostic({ root: copy }), /MANIFEST_PIN_MISMATCH/);
  });
});

test('unknown fixture input is refused before parser evaluation', async () => {
  await withCopy(async copy => {
    const file = path.join(copy, 'fixtures.json');
    const modified = structuredClone(definitions);
    modified.fixtures.push({ ...modified.fixtures[0], id: 'UNKNOWN' });
    await fs.writeFile(file, JSON.stringify(modified));
    await assert.rejects(verifyDiagnostic({ root: copy }), /FIXTURE_HASH_MISMATCH/);
  });
});

test('unknown observed command is refused instead of counted as reproduction', () => {
  const observed = expected();
  observed[0].commands.push('unexpected-command');
  assert.throws(() => assertKnownObservations(observed, definitions), /UNEXPECTED_OBSERVATION:L1/);
});

test('unknown observed fixture identifier is refused', () => {
  const observed = expected();
  observed[0].id = 'UNKNOWN';
  assert.throws(() => assertKnownObservations(observed, definitions), /UNKNOWN_OBSERVATION_ID:UNKNOWN/);
});

test('duplicate observed fixture identifier is refused', () => {
  const duplicated = expected();
  duplicated[1].id = duplicated[0].id;
  assert.throws(() => assertKnownObservations(duplicated, definitions), /DUPLICATE_OBSERVATION_ID:L1/);
});

test('missing fixture output is refused', () => {
  assert.throws(() => assertKnownObservations(expected().slice(1), definitions), /OBSERVATION_COUNT_MISMATCH/);
});

test('changed control decision is refused', () => {
  const observed = expected();
  observed.find(row => row.id === 'C1').denied = false;
  assert.throws(() => assertKnownObservations(observed, definitions), /UNEXPECTED_OBSERVATION:C1/);
});
