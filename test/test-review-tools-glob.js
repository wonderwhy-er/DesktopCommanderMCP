import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readTool } from './helpers/review-tools.js';

const TYPESCRIPT_FILES = [
  'pr/[draft].ts', 'pr/a+b.ts', 'pr/a.ts', 'pr/ab.ts', 'pr/long.ts', 'pr/nested/b.ts', 'pr/nested/deep/c.ts',
];

function fixture(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'review-glob-'));
  const names = ['a.ts', 'ab.ts', 'long.ts', 'a+b.ts', '[draft].ts', 'notes.md', 'upper.TS',
    'nested/b.ts', 'nested/notes.md', 'nested/deep/c.ts'];
  for (const name of names) {
    const file = path.join(folder, 'pr', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'fixture');
  }
  t.after(() => {
    assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()));
    fs.rmSync(folder, { recursive: true, force: true });
  });
  return folder;
}

const glob = async (folder, pattern) => {
  const text = await readTool({ folder, name: 'glob', args: { pattern } });
  return text ? text.split('\n').sort() : [];
};

test('globstar directory matches include root and nested frozen TypeScript files', async t => {
  const folder = fixture(t);
  assert.deepEqual(await glob(folder, 'pr/**/*.ts'), TYPESCRIPT_FILES);
  assert.deepEqual(await glob(folder, 'pr/**/nested/**/*.ts'), ['pr/nested/b.ts', 'pr/nested/deep/c.ts']);
});

test('single-star depth, literal metacharacters and other globstar forms retain their behavior', async t => {
  const folder = fixture(t);
  assert.deepEqual(await glob(folder, 'pr/*.ts'), [
    'pr/[draft].ts', 'pr/a+b.ts', 'pr/a.ts', 'pr/ab.ts', 'pr/long.ts',
  ]);
  assert.deepEqual(await glob(folder, 'pr/*/*.ts'), ['pr/nested/b.ts']);
  assert.deepEqual(await glob(folder, 'pr/?.ts'), ['pr/a.ts']);
  for (const name of ['a+b.ts', '[draft].ts'])
    assert.deepEqual(await glob(folder, `pr/${name}`), [`pr/${name}`]);
  assert.deepEqual(await glob(folder, 'pr/nested/**'), ['pr/nested/b.ts', 'pr/nested/deep/c.ts', 'pr/nested/notes.md']);
  assert.deepEqual(await glob(folder, 'pr/a**/b.ts'), []);
  assert.deepEqual(await glob(folder, 'pr/a****/b.ts'), []);
  assert.deepEqual(await glob(folder, 'pr/**.ts'), TYPESCRIPT_FILES);
  assert.deepEqual(await glob(folder, 'pr/upper.ts'), []);
});

test('glob discovery stays inside the frozen read roots', async t => {
  const folder = fixture(t);
  const denied = await readTool({ folder, name: 'glob', args: { path: '../outside', pattern: '**' } });
  assert.match(denied, /^Read denied:/);
});
