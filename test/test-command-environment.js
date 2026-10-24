/**
 * getCommandEnvironment() (dist/utils/shell.js): the environment for what the
 * AI runs (start_process commands, node:local code). On Windows it puts back
 * what an app's launch left out or broke:
 * - ProgramData when it is missing (#702), on the system drive: SystemDrive,
 *   else SystemRoot's drive; with neither it stays unset (no fixed C:)
 * - ProgramData that is set is kept
 * - PATHEXT: unset or without .EXE is repaired, a healthy one is kept (#481)
 * On Linux it can restore the standard systemd user-session environment when
 * the current user's runtime directory and D-Bus socket prove they are safe (#809).
 *
 * Each Windows case sets the variables in this process, as the server would have them.
 */
import assert from 'assert';
import { getCommandEnvironment, repairLinuxUserSessionEnvironment } from '../dist/utils/shell.js';
import { runIfMain } from './helpers/run-if-main.js';

const STANDARD_PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC';

/** Runs fn with these variables in process.env (undefined: unset), then puts the old values back */
function withEnv(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  const apply = (entries) => {
    for (const [name, value] of Object.entries(entries)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  try {
    apply(values);
    return fn();
  } finally {
    apply(saved);
  }
}

/** A variable of the returned environment, whatever the spelling of its name (Windows names ignore case) */
function valueOf(env, name) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

function stat({ uid = 1000, mode = 0o700, directory = false, socket = false } = {}) {
  return { uid, mode, isDirectory: () => directory, isSocket: () => socket };
}

function fakeLstat(entries) {
  return (filePath) => {
    if (!Object.prototype.hasOwnProperty.call(entries, filePath)) throw new Error(`ENOENT: ${filePath}`);
    return entries[filePath];
  };
}

function testLinuxUserSessionRepair() {
  const runtime = '/run/user/1000';
  const bus = `${runtime}/bus`;
  const safeStat = fakeLstat({
    [runtime]: stat({ directory: true }),
    [bus]: stat({ socket: true }),
  });

  const env = { KEEP: 'yes' };
  assert.strictEqual(repairLinuxUserSessionEnvironment(env, 'linux', 1000, safeStat), env);
  assert.deepStrictEqual(env, {
    KEEP: 'yes',
    XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${bus}`,
  });

  const inherited = { XDG_RUNTIME_DIR: '/custom/runtime', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/custom/bus' };
  repairLinuxUserSessionEnvironment(inherited, 'linux', 1000, () => { throw new Error('must not stat'); });
  assert.deepStrictEqual(inherited, { XDG_RUNTIME_DIR: '/custom/runtime', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/custom/bus' });

  for (const unsafeRuntime of [
    stat({ uid: 2000, directory: true }),
    stat({ mode: 0o755, directory: true }),
    stat({ mode: 0o000, directory: true }),
    stat(), // lstat of a symlink/regular file is not the required directory
  ]) {
    const unsafe = {};
    repairLinuxUserSessionEnvironment(unsafe, 'linux', 1000, fakeLstat({ [runtime]: unsafeRuntime }));
    assert.deepStrictEqual(unsafe, {}, 'unsafe runtime directory must not be trusted');
  }

  for (const unsafeBus of [stat({ uid: 2000, socket: true }), stat()]) {
    const badBus = {};
    repairLinuxUserSessionEnvironment(badBus, 'linux', 1000, fakeLstat({
      [runtime]: stat({ directory: true }),
      [bus]: unsafeBus,
    }));
    assert.deepStrictEqual(badBus, { XDG_RUNTIME_DIR: runtime }, 'non-socket or wrong-owner bus must not be used');
  }

  const customRuntime = { XDG_RUNTIME_DIR: '/custom/runtime' };
  repairLinuxUserSessionEnvironment(customRuntime, 'linux', 1000, () => { throw new Error('must not stat custom runtime'); });
  assert.deepStrictEqual(customRuntime, { XDG_RUNTIME_DIR: '/custom/runtime' }, 'do not invent a bus address for a custom runtime');

  const customBus = { DBUS_SESSION_BUS_ADDRESS: 'unix:abstract=/custom-bus' };
  repairLinuxUserSessionEnvironment(customBus, 'linux', 1000, safeStat);
  assert.deepStrictEqual(customBus, {
    DBUS_SESSION_BUS_ADDRESS: 'unix:abstract=/custom-bus',
    XDG_RUNTIME_DIR: runtime,
  }, 'preserve a custom D-Bus transport while restoring an independently safe runtime directory');

  const otherPlatform = {};
  repairLinuxUserSessionEnvironment(otherPlatform, 'darwin', 1000, () => { throw new Error('must not stat outside Linux'); });
  assert.deepStrictEqual(otherPlatform, {});
  console.log('✓ Linux user-session repair is guarded, ownership-checked, and preserves inherited values');
}

export default async function runTests() {
  testLinuxUserSessionRepair();

  if (process.platform !== 'win32') {
    const before = { ...process.env };
    const commandEnv = getCommandEnvironment();
    assert.deepStrictEqual({ ...process.env }, before, 'building a command environment must not mutate the server environment');
    for (const [key, value] of Object.entries(before)) {
      assert.strictEqual(commandEnv[key], value, `inherited ${key} should be kept`);
    }
    console.log(`✓ ${process.platform}: inherited environment kept${process.platform === 'linux' ? '; safe session values may be added' : ''}`);
    return true;
  }

  const programDataCases = [
    ['ProgramData missing: on SystemDrive',
      { ProgramData: undefined, SystemDrive: 'Q:', SystemRoot: 'R:\\Windows' }, 'Q:\\ProgramData'],
    ['ProgramData and SystemDrive missing: on SystemRoot\'s drive',
      { ProgramData: undefined, SystemDrive: undefined, SystemRoot: 'R:\\Windows' }, 'R:\\ProgramData'],
    ['no drive known: ProgramData stays unset',
      { ProgramData: undefined, SystemDrive: undefined, SystemRoot: undefined }, undefined],
    ['ProgramData set: kept',
      { ProgramData: 'D:\\Data', SystemDrive: 'Q:' }, 'D:\\Data'],
  ];
  for (const [name, values, expected] of programDataCases) {
    const programData = withEnv(values, () => {
      const env = getCommandEnvironment();
      assert.strictEqual(process.env.ProgramData, values.ProgramData, `${name}: the server's own environment should not change`);
      return valueOf(env, 'ProgramData');
    });
    assert.strictEqual(programData, expected, `${name}: ProgramData`);
    console.log(`✓ ${name}`);
  }

  const pathExtCases = [
    ['PATHEXT unset: the standard list', undefined, STANDARD_PATHEXT],
    ['PATHEXT without .EXE: the standard list plus what was there', '.CPL', `${STANDARD_PATHEXT};.CPL`],
    ['PATHEXT with .EXE: kept', '.EXE;.PY', '.EXE;.PY'],
  ];
  for (const [name, value, expected] of pathExtCases) {
    const pathExt = withEnv({ PATHEXT: value }, () => valueOf(getCommandEnvironment(), 'PATHEXT'));
    assert.strictEqual(pathExt, expected, `${name}: PATHEXT`);
    console.log(`✓ ${name}`);
  }
  return true;
}

runIfMain(import.meta.url, runTests);
