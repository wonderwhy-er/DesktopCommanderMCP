import assert from 'assert';
import {
  STANDARD_PATHEXT,
  getRepairedPathExt,
  getSystemRegistryPathExt,
  _resetCachedSystemPathExt,
} from '../dist/terminal-manager.js';

console.log('Running test-pathext.js...');

const originalPathExt = process.env.PATHEXT;

try {
  // Test 1: STANDARD_PATHEXT has expected basic extensions
  assert.ok(STANDARD_PATHEXT.includes('.EXE'), 'STANDARD_PATHEXT must include .EXE');
  assert.ok(STANDARD_PATHEXT.includes('.BAT'), 'STANDARD_PATHEXT must include .BAT');
  assert.ok(STANDARD_PATHEXT.includes('.CMD'), 'STANDARD_PATHEXT must include .CMD');

  // Test 2: Unset PATHEXT returns base list
  _resetCachedSystemPathExt(null);
  delete process.env.PATHEXT;
  assert.strictEqual(getRepairedPathExt(), STANDARD_PATHEXT, 'Unset PATHEXT must fall back to STANDARD_PATHEXT');

  // Test 3: Unset PATHEXT uses system registry when available
  _resetCachedSystemPathExt('.COM;.EXE;.BAT;.CMD;.LNK');
  delete process.env.PATHEXT;
  assert.strictEqual(
    getRepairedPathExt(),
    '.COM;.EXE;.BAT;.CMD;.LNK',
    'Unset PATHEXT should pick up system registry PATHEXT including custom extensions like .LNK'
  );

  // Test 4: Corrupted PATHEXT without .EXE (e.g. ".CPL;.LNK") merges with base, preserving custom extensions
  _resetCachedSystemPathExt('.COM;.EXE;.BAT;.CMD;.MSC');
  process.env.PATHEXT = '.CPL;.LNK';
  const repaired = getRepairedPathExt();
  assert.ok(repaired.includes('.EXE'), 'Repaired PATHEXT must include .EXE');
  assert.ok(repaired.includes('.CPL'), 'Repaired PATHEXT must preserve .CPL');
  assert.ok(repaired.includes('.LNK'), 'Repaired PATHEXT must preserve .LNK');
  assert.ok(repaired.includes('.BAT'), 'Repaired PATHEXT must include .BAT');

  // Test 5: Valid PATHEXT with .EXE is left untouched
  _resetCachedSystemPathExt(null);
  process.env.PATHEXT = '.EXE;.BAT;.CUSTOM';
  assert.strictEqual(
    getRepairedPathExt(),
    '.EXE;.BAT;.CUSTOM',
    'Valid PATHEXT with .EXE must be returned untouched'
  );

  console.log('All PATHEXT tests passed successfully! ✓');
} finally {
  _resetCachedSystemPathExt(undefined);
  if (originalPathExt !== undefined) {
    process.env.PATHEXT = originalPathExt;
  } else {
    delete process.env.PATHEXT;
  }
}
