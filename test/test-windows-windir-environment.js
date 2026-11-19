/**
 * #623: older filtered Windows launch environments can omit or empty WINDIR
 * while retaining SystemRoot. Repair only the child command environment,
 * preserve a healthy inherited value, and never emit duplicate case variants.
 */
import assert from 'assert';
import { spawnSync } from 'child_process';
import path from 'path';
import { getCommandEnvironment } from '../dist/utils/shell.js';
import { runIfMain, skip } from './helpers/run-if-main.js';

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

function windirKeys(env) {
  return Object.keys(env).filter((key) => key.toUpperCase() === 'WINDIR');
}

function windirValue(env) {
  const key = windirKeys(env)[0];
  return key === undefined ? undefined : env[key];
}

export default async function runTests() {
  if (process.platform !== 'win32') return skip('#623: WINDIR repair is Windows-only');

  const cases = [
    ['WINDIR missing: restored from SystemRoot',
      { WINDIR: undefined, SystemRoot: 'R:\\Windows' }, 'R:\\Windows', 1],
    ['WINDIR empty: restored from SystemRoot',
      { WINDIR: '', SystemRoot: 'R:\\Windows' }, 'R:\\Windows', 1],
    ['WINDIR set: kept',
      { WINDIR: 'D:\\CustomWindows', SystemRoot: 'R:\\Windows' }, 'D:\\CustomWindows', 1],
    ['WINDIR and SystemRoot missing: stays unset',
      { WINDIR: undefined, SystemRoot: undefined }, undefined, 0],
  ];

  for (const [name, values, expected, expectedKeys] of cases) {
    withEnv(values, () => {
      const env = getCommandEnvironment();
      assert.strictEqual(process.env.WINDIR, values.WINDIR, `${name}: server environment should not change`);
      assert.strictEqual(windirValue(env), expected, `${name}: WINDIR`);
      assert.strictEqual(windirKeys(env).length, expectedKeys,
        `${name}: child environment should contain at most one case-insensitive WINDIR key`);
      if (!values.WINDIR && values.SystemRoot) {
        assert.deepStrictEqual(windirKeys(env), ['WINDIR'], `${name}: repaired key should use canonical casing`);
      }
    });
    console.log(`✓ ${name}`);
  }

  const systemRoot = process.env.SystemRoot;
  assert(systemRoot, 'Windows test runner should provide SystemRoot');
  const cmd = path.join(systemRoot, 'System32', 'cmd.exe');
  withEnv({ WINDIR: '', SystemRoot: systemRoot }, () => {
    const env = getCommandEnvironment();
    const child = spawnSync(cmd, ['/d', '/c', 'echo [%WINDIR%]'], { env, encoding: 'utf8' });
    assert.strictEqual(child.status, 0, `cmd.exe should start with repaired WINDIR: ${child.stderr}`);
    assert.strictEqual(child.stdout.trim(), `[${systemRoot}]`, 'cmd.exe should expand repaired WINDIR');
  });
  console.log('✓ repaired WINDIR reaches a real Windows child process');

  return true;
}

runIfMain(import.meta.url, runTests);