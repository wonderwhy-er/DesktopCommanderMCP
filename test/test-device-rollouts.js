#!/usr/bin/env node

/**
 * The device's rollouts: the server writes the user's rollouts into each call
 * row (`metadata.rollouts`), and the device keeps the map from the latest call.
 * Anything that isn't a map of booleans (an older server sends none) means all off.
 */

import assert from 'node:assert/strict';
import { rolloutManager } from '../dist/remote-device/rollouts.js';
import { runIfMain } from './helpers/run-if-main.js';

async function runTests() {
  assert.deepEqual(rolloutManager.getAll(), {}, 'all off before the first call');
  assert.equal(rolloutManager.get('check'), false, 'a rollout is off before the first call');

  // update() replaces the map with the latest one; it doesn't merge.
  assert.equal(rolloutManager.update({ check: true, other: false }), true, 'a new map is a change');
  assert.equal(rolloutManager.get('check'), true);
  assert.equal(rolloutManager.get('other'), false);
  assert.deepEqual(rolloutManager.getAll(), { check: true, other: false });

  assert.equal(rolloutManager.update({ other: true }), true);
  assert.equal(rolloutManager.get('check'), false, 'a name missing from the latest map is off');
  assert.deepEqual(rolloutManager.getAll(), { other: true }, 'the latest map replaces the previous one');

  assert.equal(rolloutManager.update({ other: true }), false, 'the same map again is no change');

  const all = rolloutManager.getAll();
  all.other = false;
  assert.equal(rolloutManager.get('other'), true, 'getAll() returns a copy');

  // A missing or bad map means all off.
  for (const bad of [undefined, null, 'check', 1, true, [true], ['check'], { check: 'true' }, { check: 1 }, { check: true, other: null }]) {
    rolloutManager.update({ check: true });
    assert.equal(rolloutManager.update(bad), true, `${JSON.stringify(bad)} turns the rollouts off`);
    assert.deepEqual(rolloutManager.getAll(), {}, `${JSON.stringify(bad)} means all off`);
    assert.equal(rolloutManager.get('check'), false, `${JSON.stringify(bad)} turns check off`);
  }
  assert.equal(rolloutManager.update(undefined), false, 'all off again is no change');

  // get() returns the default for names it doesn't know.
  rolloutManager.update({ check: true, other: false });
  assert.equal(rolloutManager.get('unknown'), false, 'the default default is false');
  assert.equal(rolloutManager.get('unknown', true), true, 'an unknown name returns the given default');
  assert.equal(rolloutManager.get('check', false), true, 'a known name ignores the default');
  assert.equal(rolloutManager.get('other', true), false, 'a known name ignores the default');

  console.log('✅ Device rollouts tests passed');
}

runIfMain(import.meta.url, runTests);
