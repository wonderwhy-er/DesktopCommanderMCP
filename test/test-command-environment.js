/**
 * getCommandEnvironment() (dist/utils/shell.js): the environment for what the
 * AI runs (start_process commands, node:local code). On Windows it puts back
 * what an app's launch left out or broke:
 * - ProgramData when it is missing (#702), on the system drive: SystemDrive,
 *   else SystemRoot's drive; with neither it stays unset (no fixed C:)
 * - ProgramData that is set is kept
 * - PATHEXT: unset or without .EXE is repaired, a healthy one is kept (#481)
 * Elsewhere it is the server's environment, unchanged.
 *
 * Each case sets the variables in this process, as the server would have them.
 */
import assert from 'assert';
import { getCommandEnvironment } from '../dist/utils/shell.js';
import { runIfMain } from './helpers/run-if-main.js';
import { withEnv } from './helpers/test-env.js';

const STANDARD_PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC';

/** A variable of the returned environment, whatever the spelling of its name (Windows names ignore case) */
function valueOf(env, name) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

export default async function runTests() {
  if (process.platform !== 'win32') {
    assert.deepStrictEqual(getCommandEnvironment(), { ...process.env },
      'outside Windows, commands should get the server\'s environment unchanged');
    console.log('✓ outside Windows: the server\'s environment, unchanged');
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
    const programData = await withEnv(values, () => {
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
    const pathExt = await withEnv({ PATHEXT: value }, () => valueOf(getCommandEnvironment(), 'PATHEXT'));
    assert.strictEqual(pathExt, expected, `${name}: PATHEXT`);
    console.log(`✓ ${name}`);
  }
  return true;
}

runIfMain(import.meta.url, runTests);
