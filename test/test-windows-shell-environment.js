import assert from 'assert';
import { getRepairedWindowsShellEnvironment } from '../dist/terminal-manager.js';

const brokenMsixEnvironment = {
  PATHEXT: '.CPL',
  WINDIR: '',
  SystemRoot: 'D:\\Windows',
  KEEP_ME: 'present',
};

const repaired = getRepairedWindowsShellEnvironment(brokenMsixEnvironment, true);

assert.match(repaired.PATHEXT, /\.EXE/i);
assert.match(repaired.PATHEXT, /\.CPL/i);
assert.equal(repaired.WINDIR, 'D:\\Windows');
assert.equal(repaired.SystemRoot, 'D:\\Windows');
assert.equal(repaired.KEEP_ME, 'present');
assert.equal(brokenMsixEnvironment.WINDIR, '');

const fallback = getRepairedWindowsShellEnvironment({ PATHEXT: '.EXE' }, true);
assert.equal(fallback.WINDIR, 'C:\\Windows');
assert.equal(fallback.SystemRoot, 'C:\\Windows');

const nonWindows = getRepairedWindowsShellEnvironment({ PATHEXT: '.CPL' }, false);
assert.equal(nonWindows.PATHEXT, '.CPL');
assert.equal(nonWindows.WINDIR, undefined);

console.log('Windows shell environment repair tests passed.');
