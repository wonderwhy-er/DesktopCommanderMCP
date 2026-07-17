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

const mixedCaseEnvironment = {
  pathext: '.CPL',
  PATHEXT: '.EXE',
  windir: 'E:\\Windows',
  WINDIR: '',
  systemroot: 'F:\\Windows',
};

const normalized = getRepairedWindowsShellEnvironment(mixedCaseEnvironment, true);

assert.equal(normalized.PATHEXT, '.EXE');
assert.equal(normalized.WINDIR, 'E:\\Windows');
assert.equal(normalized.SystemRoot, 'F:\\Windows');
assert.equal(normalized.pathext, undefined);
assert.equal(normalized.windir, undefined);
assert.equal(normalized.systemroot, undefined);

const fallback = getRepairedWindowsShellEnvironment({ PATHEXT: '.EXE' }, true);
assert.equal(fallback.WINDIR, 'C:\\Windows');
assert.equal(fallback.SystemRoot, 'C:\\Windows');

const nonWindows = getRepairedWindowsShellEnvironment({ PATHEXT: '.CPL' }, false);
assert.equal(nonWindows.PATHEXT, '.CPL');
assert.equal(nonWindows.WINDIR, undefined);

console.log('Windows shell environment repair tests passed.');
